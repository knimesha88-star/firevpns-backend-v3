import axios, { AxiosRequestConfig, AxiosError, AxiosResponse } from 'axios';
import { adminDb } from '../../config/firebaseAdmin.js';
import { VPNClient } from '../../types/models.js';

let sessionCookie = '';
let currentPanelUrl = '';

const getXuiConfig = async (): Promise<any> => {
  const doc = await adminDb.collection('settings').doc('xui').get();
  if (!doc.exists) {
    throw new Error('3X-UI settings not configured in Firestore');
  }
  return doc.data();
};

const getBasePath = (url: string): string => {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return path.endsWith('/') ? path.slice(0, -1) : path;
  } catch (e) {
    return '';
  }
};

const getBaseUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (e) {
    return url;
  }
};

export interface XuiResponse<T> {
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

export const login = async (force = false): Promise<string> => {
  try {
    const config = await getXuiConfig();
    const baseUrl = getBaseUrl(config.panelUrl);
    const basePath = getBasePath(config.panelUrl);
    
    if (!force && sessionCookie && currentPanelUrl === baseUrl) {
      return sessionCookie;
    }

    const response = await axios.post<XuiResponse<unknown>>(`${baseUrl}${basePath}/login`, {
      username: config.username,
      password: config.password
    }, {
      timeout: 15000
    });
        
    if (response.data && response.data.success === false) {
       console.warn(`[XUI Service] Login returned false success: ${response.data.msg}`);
    }

    const cookies = response.headers['set-cookie'];
    if (cookies && cookies.length > 0) {
      sessionCookie = cookies[0].split(';')[0];
      currentPanelUrl = baseUrl;
      console.log('[XUI Service] Session authenticated successfully.');
      return sessionCookie;
    } else {
      console.warn('[XUI Service] Login succeeded but no cookie was returned.');
      throw new Error('No cookie returned from 3X-UI login');
    }
  } catch (error: any) {
    console.error('[XUI Service] Login failed:', error.message || error);
    throw new Error('3X-UI Login failed');
  }
};

const requestWithAuth = async <T>(configOptions: AxiosRequestConfig): Promise<AxiosResponse<XuiResponse<T>>> => {
  const settings = await getXuiConfig();
  const baseUrl = getBaseUrl(settings.panelUrl);
  
  if (!sessionCookie || currentPanelUrl !== baseUrl) await login();
  
  try {
    const res = await axios.request<XuiResponse<T>>({
      ...configOptions,
      baseURL: baseUrl,
      headers: {
        ...configOptions.headers,
        Cookie: sessionCookie
      },
      timeout: 15000
    });

    if (res.data && res.data.success === false && typeof res.data.msg === 'string' && res.data.msg.includes('login')) {
       console.log('[XUI Service] Session expired, re-authenticating...');
       await login(true);
       return axios.request<XuiResponse<T>>({
         ...configOptions,
         baseURL: baseUrl,
         headers: {
           ...configOptions.headers,
           Cookie: sessionCookie
         },
         timeout: 15000
       });
    }
    return res;
  } catch (error: any) {
    if (error instanceof AxiosError) {
      if (error.response?.status === 401 || error.response?.status === 403) {
        console.log('[XUI Service] Session invalid (401/403), re-authenticating...');
        await login(true);
        return axios.request<XuiResponse<T>>({
          ...configOptions,
          baseURL: baseUrl,
          headers: {
            ...configOptions.headers,
            Cookie: sessionCookie
          },
          timeout: 15000
        });
      }
      console.error(`[XUI Service] Request to ${configOptions.url} failed: ${error.message}`);
    }
    throw error;
  }
};

export const getInbounds = async (): Promise<XuiInbound[]> => {
  try {
    const config = await getXuiConfig();
    const basePath = getBasePath(config.panelUrl);
    const response = await requestWithAuth<XuiInbound[]>({
       url: `${basePath}/panel/api/inbounds/list`,
       method: 'GET'
     });
    return response.data.obj || [];
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
        console.warn(`[XUI Service] Failed to parse settings for inbound ID: ${inbound.id}`);
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
             if (inbound.streamSettings) {
                streamSettings = JSON.parse(inbound.streamSettings);
             }
          } catch(e) {}

          const config = await getXuiConfig();
          const baseUrl = getBaseUrl(config.panelUrl);

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
            onlineStatus: c.enable && remaining >= 0, // simple heuristic
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
  } catch (error) {
    console.error(`[XUI Service] Error looking up client by email (${email}):`, error);
    return null;
  }
};

export const getSystemStatus = async (): Promise<Record<string, unknown>> => {
  try {
    const config = await getXuiConfig();
    const basePath = getBasePath(config.panelUrl);
    const response = await requestWithAuth<Record<string, unknown>>({
       url: `${basePath}/server/status`,
       method: 'GET'
     });
    return response.data.obj || {};
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
  const config = await getXuiConfig();
  const baseUrl = getBaseUrl(config.panelUrl);
  const basePath = getBasePath(config.panelUrl);
  return `${baseUrl}${basePath}/sub/${client.subId}`;
};

export const getClientExpiry = async (email: string): Promise<number | null> => {
  const client = await getClientByEmail(email);
  if (!client) return null;
  return client.expiryTime;
};
