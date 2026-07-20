import axios, { AxiosInstance, AxiosError } from 'axios';
import { adminDb } from '../../config/firebaseAdmin.js';
import https from 'https';

export interface XuiConfig {
  panelUrl: string;
  username: string;
  password: string;
  panelName?: string;
}

interface XuiResponse<T> {
  success: boolean;
  msg: string;
  obj: T;
}

export interface XuiClientStat {
  id: number;
  inboundId: number;
  enable: boolean;
  email: string;
  up: number;
  down: number;
  expiryTime: number;
  total: number;
  reset: number;
}

export interface XuiClient {
  id: string;
  email: string;
  limitIp: number;
  totalGB: number;
  expiryTime: number;
  enable: boolean;
  tgId: string;
  subId: string;
  reset: number;
}

export interface XuiInbound {
  id: number;
  up: number;
  down: number;
  total: number;
  remark: string;
  enable: boolean;
  expiryTime: number;
  clientStats: XuiClientStat[] | null;
  port: number;
  protocol: string;
  settings: string;
  streamSettings: string;
  tag: string;
  sniffing: string;
}

let sessionCookie: string | null = null;
let currentConfigHash: string = '';

const getXuiConfig = async (): Promise<XuiConfig> => {
  const doc = await adminDb.collection('settings').doc('xui').get();
  if (!doc.exists) {
    throw new Error('3X-UI settings not configured in Firestore');
  }
  return doc.data() as XuiConfig;
};

const parseUrl = (urlStr: string) => {
  try {
    const parsed = new URL(urlStr);
    const baseUrl = `${parsed.protocol}//${parsed.host}`;
    const basePath = parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;
    return { baseUrl, basePath };
  } catch (e) {
    throw new Error(`Invalid Panel URL: ${urlStr}`);
  }
};

const createAxiosInstance = (baseUrl: string) => {
  return axios.create({
    baseURL: baseUrl,
    timeout: 15000,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }), // In case of self-signed certs
    validateStatus: (status) => status < 500
  });
};

export const authenticate = async (config: XuiConfig): Promise<string> => {
  console.log(`[XUI Auth] Attempting login to panel: ${config.panelUrl}`);
  const { baseUrl, basePath } = parseUrl(config.panelUrl);
  const client = createAxiosInstance(baseUrl);

  const endpointsToTry = [
    '/login',
    '/panel/login',
    '/panel/api/login',
    '/IC2MamSLiBbf1a6qEQ/login',
    '/IC2MamSLiBbf1a6qEQ/panel/login',
    `${basePath}/login`,
    `${basePath}/panel/login`
  ];

  const uniqueEndpoints = [...new Set(endpointsToTry)];

  for (const endpoint of uniqueEndpoints) {
    console.log(`\n[XUI Auth] Trying endpoint: POST ${baseUrl}${endpoint}`);
    try {
      const response = await client.post(endpoint, {
        username: config.username,
        password: config.password
      });

      console.log(`[XUI Auth] HTTP status: ${response.status}`);
      console.log(`[XUI Auth] Response headers:`, JSON.stringify(response.headers, null, 2));
      console.log(`[XUI Auth] Response body:`, JSON.stringify(response.data, null, 2));
      
      let isSuccess = false;
      if (response.data) {
        console.log(`[XUI Auth] response.data.success: ${response.data.success}`);
        console.log(`[XUI Auth] response.data.msg: ${response.data.msg}`);
        console.log(`[XUI Auth] response.data.obj:`, response.data.obj);
        isSuccess = response.data.success === true;
      }
      
      const cookies = response.headers['set-cookie'];
      console.log(`[XUI Auth] Set-Cookie exists:`, !!cookies && cookies.length > 0);

      if (isSuccess || (response.status >= 200 && response.status < 300 && (cookies && cookies.length > 0 || (response.data && response.data.success !== false)))) {
        console.log(`[XUI Auth] SUCCESS at endpoint: ${endpoint}`);
        if (cookies && cookies.length > 0) {
          const cookie = cookies[0].split(';')[0];
          console.log(`[XUI Auth] Login successful, session cookie obtained`);
          return cookie;
        } else {
          console.warn(`[XUI Auth] No session cookie returned. Checking response body for tokens...`);
          if (response.data && response.data.obj && typeof response.data.obj === 'string') {
            console.log(`[XUI Auth] Token found in response body`);
            return `Bearer ${response.data.obj}`; 
          }
          if (response.data && response.data.success === true) {
            console.warn(`[XUI Auth] Authentication marked successful but no cookie/token found. Proceeding with empty session.`);
            return '';
          }
        }
      } else {
         console.log(`[XUI Auth] Endpoint ${endpoint} did not return success criteria.`);
      }
    } catch (error: any) {
      console.error(`[XUI Auth] Request failed for ${endpoint}:`, error.message);
      if (error.response) {
        console.error(`[XUI Auth] HTTP status: ${error.response.status}`);
        console.error(`[XUI Auth] Response headers:`, JSON.stringify(error.response.headers, null, 2));
        console.error(`[XUI Auth] Response body:`, JSON.stringify(error.response.data, null, 2));
      }
    }
  }

  throw new Error('Authentication failed: Exhausted all login endpoints without success.');
};

const requestApi = async <T>(endpoint: string, method: 'GET' | 'POST' = 'GET', data?: any): Promise<T> => {
  const config = await getXuiConfig();
  const configHash = `${config.panelUrl}:${config.username}`;
  
  if (!sessionCookie || currentConfigHash !== configHash) {
    sessionCookie = await authenticate(config);
    currentConfigHash = configHash;
  }

  const { baseUrl, basePath } = parseUrl(config.panelUrl);
  const client = createAxiosInstance(baseUrl);

  console.log(`[XUI API] ${method} ${baseUrl}${basePath}${endpoint}`);
  console.log(`[XUI API] Request headers:`, { Cookie: sessionCookie });
  
  let response = await client.request({
    url: `${basePath}${endpoint}`,
    method,
    data,
    headers: {
      Cookie: sessionCookie
    }
  });

  console.log(`[XUI API] Response status for ${endpoint}: ${response.status}`);

  // Re-authenticate if session expired
  if (response.status === 401 || (response.data && response.data.success === false && typeof response.data.msg === 'string' && response.data.msg.includes('login'))) {
    console.log(`[XUI API] Session invalid, re-authenticating...`);
    sessionCookie = await authenticate(config);
    currentConfigHash = configHash;
    
    response = await client.request({
      url: `${basePath}${endpoint}`,
      method,
      data,
      headers: {
        Cookie: sessionCookie
      }
    });
  }

  if (response.status !== 200) {
    throw new Error(`3X-UI API Error: ${response.status} ${response.statusText}`);
  }

  if (response.data && response.data.success === false) {
    throw new Error(`3X-UI API Error: ${response.data.msg}`);
  }

  return response.data.obj;
};

export const getInbounds = async (): Promise<XuiInbound[]> => {
  try {
    return await requestApi<XuiInbound[]>('/panel/api/inbounds/list');
  } catch (error: any) {
    console.error('[XUI Service] Failed to retrieve inbounds:', error.message);
    return [];
  }
};

export const getClientByEmail = async (email: string): Promise<any | null> => {
  try {
    const inbounds = await getInbounds();
    
    for (const inbound of inbounds) {
      let settingsObj: { clients?: XuiClient[] } = {};
      try {
        if (inbound.settings) {
          settingsObj = JSON.parse(inbound.settings);
        }
      } catch (parseError) {
        continue;
      }
      
      const clients = settingsObj.clients || [];
      const clientStats = inbound.clientStats || [];
      
      for (const c of clients) {
        if (c.email === email) {
          const stat = clientStats.find((s) => s.email === email);
          
          let total = c.totalGB || 0;
          let up = stat?.up || 0;
          let down = stat?.down || 0;
          let remaining = 0;
          
          if (total > 0) {
            remaining = total - (up + down);
            if (remaining < 0) remaining = 0;
          }
          
          let streamSettings: any = {};
          try {
             if (inbound.streamSettings) streamSettings = JSON.parse(inbound.streamSettings);
          } catch(e) {}
          
          const config = await getXuiConfig();
          const { baseUrl } = parseUrl(config.panelUrl);
          
          return {
            email: c.email,
            uuid: c.id,
            inboundId: inbound.id,
            remark: inbound.remark,
            upload: up,
            download: down,
            totalTraffic: total,
            remainingTraffic: remaining,
            expiryTime: c.expiryTime || 0,
            enableStatus: c.enable,
            onlineStatus: c.enable && (total === 0 || remaining > 0),
            subId: c.subId || '',
            port: inbound.port,
            protocol: inbound.protocol,
            network: streamSettings.network || 'tcp',
            security: streamSettings.security || 'none',
            serverAddress: baseUrl.replace(/^https?:\/\//, '').split(':')[0],
            serverName: inbound.remark
          };
        }
      }
    }
    return null;
  } catch (error: any) {
    console.error(`[XUI Service] Error looking up client by email (${email}):`, error.message);
    return null;
  }
};

export const getSystemStatus = async (): Promise<Record<string, unknown>> => {
  try {
    return await requestApi<Record<string, unknown>>('/server/status');
  } catch (error: any) {
    console.error('[XUI Service] Failed to retrieve system status:', error.message);
    return {};
  }
};

export const getTrafficUsage = async (email: string): Promise<{ up: number; down: number; total: number } | null> => {
  const client = await getClientByEmail(email);
  if (!client) return null;
  return {
    up: client.upload,
    down: client.download,
    total: client.totalTraffic
  };
};

export const getSubscriptionUriHelper = async (email: string): Promise<string | null> => {
  const client = await getClientByEmail(email);
  if (!client || !client.subId) return null;
  
  try {
    const config = await getXuiConfig();
    const { baseUrl, basePath } = parseUrl(config.panelUrl);
    return `${baseUrl}${basePath}/sub/${client.subId}`;
  } catch (e) {
    return null;
  }
};

export const getClientExpiry = async (email: string): Promise<number | null> => {
  const client = await getClientByEmail(email);
  if (!client) return null;
  return client.expiryTime;
};
