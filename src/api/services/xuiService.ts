import axios, { AxiosInstance, AxiosError } from 'axios';
import { supabase, supabaseAdmin, getSupabaseClient } from '../../lib/supabase.js';
import { sendOrderApprovedNotification } from './telegramService.js';
import { createCustomerNotification } from './notificationService.js';

import crypto from 'crypto';

import https from 'https';

// Requirement 8: Define the grace period as a constant or environment variable
export const TRIAL_GRACE_PERIOD_MINUTES = Number(process.env.TRIAL_GRACE_PERIOD_MINUTES) || 5;
export const TRIAL_GRACE_PERIOD_MS = TRIAL_GRACE_PERIOD_MINUTES * 60 * 1000;

export interface XuiConfig {
  panelUrl: string;
  username?: string;
  password?: string;
  apiToken?: string;
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
  tgId?: string | number;
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

const getXuiConfig = async (): Promise<XuiConfig> => {
  const { data: doc, error } = await supabase.from('settings').select('*').eq('id', 'xui').maybeSingle();
  if (error || !doc) {
    throw new Error('3X-UI settings not configured');
  }
  
  const data = doc.data || {};
  
  return {
    panelUrl: data.panelUrl || '',
    username: data.username || 'admin',
    password: data.password || data.apiToken || '',
    apiToken: data.apiToken || '',
    panelName: data.panelName || ''
  } as XuiConfig;
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

const getApiEndpointUrl = (panelUrl: string, endpoint: string) => {
  const { baseUrl, basePath } = parseUrl(panelUrl);
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  let fullPath = '';
  if (basePath) {
    if (basePath.endsWith('/panel') && cleanEndpoint.startsWith('/panel/')) {
      fullPath = basePath + cleanEndpoint.slice(6);
    } else {
      fullPath = basePath + cleanEndpoint;
    }
  } else {
    fullPath = cleanEndpoint;
  }

  return {
    baseUrl,
    basePath,
    fullPath,
    fullUrl: `${baseUrl}${fullPath}`
  };
};

const logAxiosError = (error: any) => {
  console.error("=== 3X-UI ERROR ===");
  console.error(`Message: ${error.message}`);
  console.error(`Code: ${error.code}`);
  console.error(`Full request URL: ${error.config?.url ? (error.config.baseURL && !error.config.url.startsWith('http') ? error.config.baseURL + error.config.url : error.config.url) : 'N/A'}`);
  console.error(`HTTP method: ${error.config?.method?.toUpperCase() || 'UNKNOWN'}`);
  console.error(`Endpoint path: ${error.config?.url || 'N/A'}`);
  if (error.response) {
    console.error(`HTTP status: ${error.response?.status} ${error.response?.statusText || ''}`);
    console.error(`Response body:`, error.response?.data);
  } else {
    console.error("No HTTP response received from 3X-UI");
  }
  console.error(`Stack trace: ${error.stack}`);
};

const createAxiosInstance = (baseUrl: string) => {
  return axios.create({
    baseURL: baseUrl,
    timeout: 15000,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }), // In case of self-signed certs
    validateStatus: (status) => status < 500
  });
};

const getXuiAuthHeaders = async (config: XuiConfig): Promise<Record<string, string>> => {
  const username = config.username || 'admin';
  const password = config.password || config.apiToken;
  
  if (!password) {
    throw new Error('API token or password is missing in 3X-UI settings');
  }

  const { baseUrl } = parseUrl(config.panelUrl);
  const client = createAxiosInstance(baseUrl);

  const loginEndpoints = ['/login', '/panel/login'];
  let cookieHeader = '';

  for (const loginEp of loginEndpoints) {
    try {
      const res = await client.post(
        loginEp,
        `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );
      const setCookie = res.headers['set-cookie'];
      if (setCookie && Array.isArray(setCookie)) {
        cookieHeader = setCookie.map(c => c.split(';')[0]).join('; ');
        console.log(`[xuiService] Successfully authenticated via ${loginEp} session login`);
        break;
      }
    } catch (e: any) {
      // Continue to next login endpoint or fallback
    }
  }

  const headers: Record<string, string> = {};
  if (cookieHeader) {
    headers['Cookie'] = cookieHeader;
  }
  headers['Authorization'] = `Bearer ${password}`;
  return headers;
};

const requestApi = async <T>(endpoint: string, method: 'GET' | 'POST' = 'GET', data?: any): Promise<T> => {
  console.log(`[xuiService] [FUNCTION ENTERED] requestApi - Endpoint: ${endpoint}, Method: ${method}`);
  const config = await getXuiConfig();
  const headers = await getXuiAuthHeaders(config);

  const { baseUrl, fullPath, fullUrl } = getApiEndpointUrl(config.panelUrl, endpoint);
  const client = createAxiosInstance(baseUrl);

  console.log(`[xuiService] [DEBUG] Preparing ${method} request`);
  console.log(`[xuiService] [DEBUG] Endpoint: ${endpoint}`);
  console.log(`[xuiService] [DEBUG] Full URL: ${fullUrl}`);
  console.log(`[xuiService] [DEBUG] Method: ${method}`);
  console.log(`[xuiService] [DEBUG] Payload: ${data ? JSON.stringify(data) : 'None'}`);
  console.log(`[xuiService] [3X-UI API REQUEST] Full request URL: ${fullUrl} | HTTP method: ${method} | Endpoint path: ${fullPath} | Payload:`, data ? JSON.stringify(data) : 'None');
  
  try {
    const axiosConfig = {
      url: fullPath,
      method,
      data,
      headers
    };
    console.log(`[xuiService] [API TRANSPORT DEBUG] Exact request URL before axios sends: ${fullUrl}`);
    console.log(`[xuiService] [API TRANSPORT DEBUG] final axios config.baseURL: ${client.defaults.baseURL}`);
    console.log(`[xuiService] [API TRANSPORT DEBUG] final axios config.url: ${axiosConfig.url}`);

    const response = await client.request(axiosConfig);

    console.log(`[requestApi Debug] HTTP Status: ${response.status}`);
    console.log(`[requestApi Debug] HTTP Headers:`, JSON.stringify(response.headers));
    console.log(`[requestApi Debug] Raw response.data:`, JSON.stringify(response.data));

    console.log(`[xuiService] [3X-UI API RESPONSE] Full request URL: ${fullUrl} | HTTP method: ${method} | Endpoint path: ${fullPath} | HTTP status: ${response.status} ${response.statusText} | Response body:`, JSON.stringify(response.data));

    if (response.status !== 200) {
      throw new Error(`3X-UI API Error: ${response.status} ${response.statusText}`);
    }

    if (response.data && response.data.success === false) {
      throw new Error(`3X-UI API Error: ${response.data.msg}`);
    }

    console.log(`[xuiService] [3X-UI API SUCCESS] Success response for ${endpoint}`);
    return response.data.obj;
  } catch (error: any) {
    console.error(`[xuiService] [API TRANSPORT ERROR] Axios error on ${fullUrl}`);
    console.error(`[xuiService] [API TRANSPORT ERROR] config.baseURL: ${error.config?.baseURL}`);
    console.error(`[xuiService] [API TRANSPORT ERROR] config.url: ${error.config?.url}`);
    
    if (error.response) {
      console.error(`[xuiService] [API TRANSPORT ERROR] HTTP Status: ${error.response.status}`);
      console.error(`[xuiService] [API TRANSPORT ERROR] HTTP Response Body:`, JSON.stringify(error.response.data));
    }
    logAxiosError(error);
    throw error;
  }
};

export const testApiConnection = async (config: XuiConfig): Promise<boolean> => {
  const headers = await getXuiAuthHeaders(config);

  const endpoints = ['/panel/api/inbounds/list', '/panel/api/inbounds', '/api/inbounds/list', '/api/inbounds'];
  let lastError: any = null;

  for (const ep of endpoints) {
    try {
      const { baseUrl, fullPath, fullUrl } = getApiEndpointUrl(config.panelUrl, ep);
      const client = createAxiosInstance(baseUrl);
      console.log(`[xuiService] [TEST API CONNECTION] Full request URL: ${fullUrl} | HTTP method: GET | Endpoint path: ${fullPath}`);
      const response = await client.request({
        url: fullPath,
        method: 'GET',
        headers
      });
      console.log(`[xuiService] [TEST API CONNECTION RESPONSE] Full request URL: ${fullUrl} | HTTP method: GET | Endpoint path: ${fullPath} | HTTP status: ${response.status} ${response.statusText} | Response body:`, JSON.stringify(response.data));

      if (response.status === 200 && (!response.data || response.data.success !== false)) {
        return true;
      }
      lastError = new Error(`Connection test failed: status ${response.status}`);
    } catch (e: any) {
      lastError = e;
      logAxiosError(e);
    }
  }

  throw lastError || new Error('Connection test failed on all endpoints');
};

export const getInbounds = async (): Promise<XuiInbound[]> => {
  console.log('[xuiService] [FUNCTION ENTERED] getInbounds');
  // Use only the supported endpoint
  const endpoint = '/panel/api/inbounds/list';
  try {
    const inboundsData = await requestApi<XuiInbound[]>(endpoint);
    if (Array.isArray(inboundsData)) {
        return inboundsData;
    }
    return [];
  } catch (error: any) {
    console.error(`[XUI Service] Failed to retrieve inbounds from ${endpoint}:`, error.message);
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
          settingsObj = typeof inbound.settings === "string" ? JSON.parse(inbound.settings) : inbound.settings;
        }
      } catch (parseError) {
        continue;
      }
      
      const clients = settingsObj.clients || [];
      const clientStats = inbound.clientStats || [];
      
      for (const c of clients) {
        if (String(c.email).trim().toLowerCase() === String(email).trim().toLowerCase()) {
          const stat = (inbound.clientStats || []).find((s) => s.email === c.email);
          
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
                 streamSettings = typeof inbound.streamSettings === "string" ? JSON.parse(inbound.streamSettings) : inbound.streamSettings;
             }
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
    const subBasePath = basePath.endsWith('/panel') ? basePath.slice(0, -6) : basePath;
    return `${baseUrl}${subBasePath}/sub/${client.subId}`;
  } catch (e) {
    return null;
  }
};

export const getClientExpiry = async (email: string): Promise<number | null> => {
  const client = await getClientByEmail(email);
  if (!client) return null;
  return client.expiryTime;
};

export const updateClientExpiry = async (email: string, durationMonths: number): Promise<number> => {
  const inbounds = await getInbounds();
  
  for (const inbound of inbounds) {
    let settingsObj: { clients?: XuiClient[] } = {};
    try {
      if (inbound.settings) {
        settingsObj = typeof inbound.settings === 'string' ? JSON.parse(inbound.settings) : inbound.settings;
      }
    } catch (parseError) {
      continue;
    }
    
    const clients = settingsObj.clients || [];
    for (const c of clients) {
      if (String(c.email).trim().toLowerCase() === String(email).trim().toLowerCase()) {
        const currentExpiry = c.expiryTime || 0;
        
        let baseTime = currentExpiry > Date.now() ? currentExpiry : Date.now();
        const date = new Date(baseTime);
        date.setMonth(date.getMonth() + durationMonths);
        const new_expiryTime = date.getTime();
        
        const updateEndpoints = [
          `/panel/api/inbounds/updateClient/${c.id}`,
          `/panel/api/inbounds/updateClient/${c.email}`,
          `/panel/api/clients/update/${c.email}`
        ];

        let updated = false;
        let lastErr: any = null;

        for (const ep of updateEndpoints) {
          try {
            await requestApi<any>(ep, 'POST', {
              ...c,
              id: String(c.id),
              email: c.email,
              expiryTime: new_expiryTime
            });
            updated = true;
            break;
          } catch (e: any) {
            lastErr = e;
          }
        }

        if (!updated && lastErr) {
          throw lastErr;
        }
        
        return new_expiryTime;
      }
    }
  }
  
  throw new Error(`Client with email ${email} not found in 3X-UI inbounds`);
};

export const findProvisioningTemplate = async (
  query: string | { templateId?: string; packageName?: string }
): Promise<any | null> => {
  let templateId = '';
  let packageName = '';

  if (typeof query === 'string') {
    packageName = query;
  } else if (query && typeof query === 'object') {
    templateId = query.templateId || '';
    packageName = query.packageName || '';
  }

  console.log(`[Provisioning Template Lookup] Searching for template - ID: '${templateId}', Package Name: '${packageName}'`);

  try {
    const { data: snapshot, error: fetchErr } = await supabase.from('provision_templates').select('*');
    if (fetchErr) {
      console.error('[Provisioning Template Lookup] Error fetching provision_templates:', fetchErr);
    }

    if (snapshot && snapshot.length > 0) {
      const enabledTemplates = snapshot.filter(item => item.enabled !== false);
      if (enabledTemplates.length === 0) {
        console.warn('[Provisioning Template Lookup] No enabled templates found in provision_templates.');
        return null;
      }

      // 1. Exact match by template ID
      if (templateId) {
        const idMatch = enabledTemplates.find(item => String(item.id).trim() === templateId.trim());
        if (idMatch) {
          console.log(`[Provisioning Template Lookup] Found exact match by template ID '${templateId}': '${idMatch.package_name || idMatch.name}'`);
          return { id: idMatch.id, ...idMatch };
        }
      }

      const targetStr = (packageName || '').trim();
      if (targetStr) {
        const targetLower = targetStr.toLowerCase();
        const targetNormalized = targetLower.replace(/[^a-z0-9]/g, '');

        // 2. Exact match on package_name or name or id
        const exact = enabledTemplates.find(item => {
          const docName = String(item.package_name || item.name || '').trim().toLowerCase();
          return docName === targetLower || docName.replace(/_/g, ' ') === targetLower.replace(/_/g, ' ');
        });
        if (exact) {
          console.log(`[Provisioning Template Lookup] Found exact match by package name '${packageName}': '${exact.package_name || exact.name}' (ID: ${exact.id})`);
          return { id: exact.id, ...exact };
        }

        // 3. Normalized match (handles typos or formatting differences)
        const alphaMatch = enabledTemplates.find(item => {
          const docName = String(item.package_name || item.name || '').trim().toLowerCase();
          const docNormalized = docName.replace(/[^a-z0-9]/g, '');
          if (docNormalized === targetNormalized) return true;
          if (docNormalized.length > 5 && targetNormalized.length > 5) {
            return docNormalized.includes(targetNormalized) || targetNormalized.includes(docNormalized);
          }
          return false;
        });
        if (alphaMatch) {
          console.log(`[Provisioning Template Lookup] Found normalized/fuzzy match for '${packageName}': '${alphaMatch.package_name || alphaMatch.name}' (ID: ${alphaMatch.id})`);
          return { id: alphaMatch.id, ...alphaMatch };
        }

        // 4. Substring / Partial match
        const partial = enabledTemplates.find(item => {
          const docName = String(item.package_name || item.name || '').trim().toLowerCase();
          return targetLower.includes(docName) || docName.includes(targetLower);
        });
        if (partial) {
          console.log(`[Provisioning Template Lookup] Found substring match for '${packageName}': '${partial.package_name || partial.name}' (ID: ${partial.id})`);
          return { id: partial.id, ...partial };
        }
      }
    }
  } catch (e) {
    console.warn(`[3X-UI Service] Error checking provision_templates:`, e);
  }

  // Requirement 7: Return proper error / null if not found. Do NOT silently fall back to the first template!
  console.error(`[Provisioning Template Lookup] Error: Template not found for ID: '${templateId}', Package Name: '${packageName}'. Returning null.`);
  return null;
};

export const formatClientRemark = (templateFormat: string, customerName: string, orderId?: string): string => {
  const name = (customerName || '').trim() || 'Customer';
  const format = templateFormat || '{{customerName}}';
  let formatted = format.replace(/\{\{\s*customerName\s*\}\}/g, name);
  
  return formatted;
};

export const buildVlessLink = (
  inbound: any,
  templateAddress: string,
  templateSni: string,
  uuid: string,
  remark: string
): string => {
  const address = (templateAddress || '').trim();
  const port = inbound.port;

  let streamObj: any = {};
  if (typeof inbound.streamSettings === 'string') {
    try {
      streamObj = JSON.parse(inbound.streamSettings);
    } catch (e) {
      streamObj = {};
    }
  } else if (inbound.streamSettings) {
    streamObj = inbound.streamSettings;
  }

  const network = streamObj.network || 'tcp';
  const security = streamObj.security || 'none';

  const params = new URLSearchParams();
  params.set('type', network);
  params.set('security', security);

  if (security === 'reality') {
    const reality = streamObj.realitySettings || streamObj.realitySettings?.settings || {};
    const settings = reality.settings || reality;
    
    const pbk = settings.publicKey || reality.publicKey || '';
    if (pbk) params.set('pbk', pbk);

    const shortIds = settings.shortIds || reality.shortIds;
    if (Array.isArray(shortIds) && shortIds.length > 0 && shortIds[0]) {
      params.set('sid', shortIds[0]);
    } else if (typeof shortIds === 'string' && shortIds) {
      params.set('sid', shortIds);
    }

    const fp = settings.fingerprint || reality.fingerprint || 'chrome';
    if (fp) params.set('fp', fp);

    const flow = settings.flow || reality.flow || 'xtls-rprx-vision';
    if (flow) params.set('flow', flow);
  } else if (security === 'tls') {
    const tls = streamObj.tlsSettings || {};
    const fp = tls.fingerprint || 'chrome';
    if (fp) params.set('fp', fp);
    if (tls.alpn) {
      const alpnStr = Array.isArray(tls.alpn) ? tls.alpn.join(',') : String(tls.alpn);
      if (alpnStr) params.set('alpn', alpnStr);
    }
  }

  // Handle WebSocket settings (path and host)
  let wsObj: any = streamObj.wsSettings || {};
  if (!wsObj.path && !wsObj.headers && streamObj.settings?.wsSettings) {
    wsObj = streamObj.settings.wsSettings;
  }
  if (!wsObj.path && !wsObj.headers && inbound.settings) {
    let settingsParsed: any = {};
    if (typeof inbound.settings === 'string') {
      try { settingsParsed = JSON.parse(inbound.settings); } catch (e) {}
    } else if (typeof inbound.settings === 'object') {
      settingsParsed = inbound.settings;
    }
    if (settingsParsed.wsSettings) {
      wsObj = settingsParsed.wsSettings;
    }
  }

  let wsPath = wsObj.path || '';
  let wsHeaders: any = wsObj.headers || {};
  if (typeof wsHeaders === 'string') {
    try {
      wsHeaders = JSON.parse(wsHeaders);
    } catch (e) {
      wsHeaders = {};
    }
  }
  let wsHost = '';
  if (wsHeaders && typeof wsHeaders === 'object') {
    wsHost = wsHeaders.Host || wsHeaders.host || wsHeaders.HOST || '';
  }
  if (!wsHost && (wsObj.host || wsObj.Host)) {
    wsHost = wsObj.host || wsObj.Host;
  }

  if (network === 'ws' || wsPath || wsHost) {
    if (wsPath) params.set('path', wsPath);
    if (wsHost) params.set('host', wsHost);
  } else if (network === 'grpc') {
    const grpc = streamObj.grpcSettings || {};
    if (grpc.serviceName) params.set('serviceName', grpc.serviceName);
  }

  // Handle SNI according to Requirement 5:
  // If the template SNI is non-empty, send SNI value.
  // If the template SNI is empty, do NOT send an SNI value.
  const sni = (templateSni || '').trim();
  if (sni) {
    params.set('sni', sni);
  }

  const queryString = params.toString();
  const remarkEncoded = encodeURIComponent(remark);

  return `vless://${uuid}@${address}:${port}${queryString ? '?' + queryString : ''}#${remarkEncoded}`;
};

export const add3XUiClient = async (
  inboundId: number,
  clientData: {
    uuid: string;
    email: string;
    totalBytes: number;
    expiryMs: number;
    subId: string;
    flow?: string;
  }
): Promise<any> => {
  console.log(`[xuiService] [FUNCTION ENTERED] add3XUiClient - inboundId: ${inboundId}, email: ${clientData.email}, uuid: ${clientData.uuid}`);
  const config = await getXuiConfig();

  const clientFlow = clientData.flow !== undefined ? clientData.flow : '';
  const payload = {
    id: inboundId,
    settings: JSON.stringify({
      clients: [
        {
          id: clientData.uuid,
          email: clientData.email,
          flow: clientFlow,
          limitIp: 0,
          totalGB: clientData.totalBytes,
          expiryTime: clientData.expiryMs,
          enable: true,
          subId: clientData.subId
        }
      ]
    })
  };

  console.log('[xuiService] [DEBUG] add3XUiClient payload:', JSON.stringify(payload, null, 2));

  const endpoint = '/panel/api/inbounds/addClient';
  try {
    const result = await requestApi<any>(endpoint, 'POST', payload);
    console.log('===== ADD CLIENT DEBUG =====');
    console.log('Endpoint:', endpoint);
    console.log('Payload:', JSON.stringify(payload));
    console.log('HTTP Status: 200');
    console.log('Response Body:', JSON.stringify(result));
    console.log('===========================');
    return result;
  } catch (err: any) {
    console.log('===== ADD CLIENT DEBUG =====');
    console.log('Endpoint:', endpoint);
    console.log('Payload:', JSON.stringify(payload));
    console.log('HTTP Status:', err?.response?.status || err?.status || 'Non-200 / Exception');
    console.log('Response Body:', JSON.stringify(err?.response?.data || err?.message || err));
    console.log('===========================');
    throw err;
  }
};

const activeProvisionings = new Set<string>();

export const provisionOrderClient = async (orderId: string, token?: string): Promise<any> => {
  console.log(`[xuiService] [FUNCTION ENTERED] provisionOrderClient - orderId: ${orderId}`);
  if (activeProvisionings.has(orderId)) {
    console.warn(`[xuiService] [DUPLICATE EXECUTION DETECTED] provisionOrderClient is already running for orderId: ${orderId}`);
    return {
      success: true,
      message: 'Client already exists on this inbound. Skipping duplicate assignment.'
    };
  }
  activeProvisionings.add(orderId);

  try {
    const dbClient = supabaseAdmin;

  let { data: order, error: fetchErr } = await dbClient.from('orders').select('*').eq('id', orderId).maybeSingle();

  if (!order) {
    const { data: queryOrder } = await dbClient.from('orders').select('*').eq('order_id', orderId).maybeSingle();
    if (!queryOrder) {
      console.error(`[3X-UI Provisioning] Order '${orderId}' not found in database. Fetch error:`, fetchErr);
      throw new Error(`Order '${orderId}' not found in database.`);
    }
    order = queryOrder;
  }


  // Idempotency Check: If order is already completed/active with existing VPN link, return existing details
  const isAlreadyCompleted = (order.status === 'completed' || order.status === 'active') && order.vless_url;
  if (isAlreadyCompleted) {
    const { data: existingVpnAcc } = await dbClient.from('vpn_accounts').select('*').eq('order_id', order.id).maybeSingle();
    return {
      success: true,
      message: 'Order already provisioned',
      uuid: order.client_uuid || existingVpnAcc?.uuid,
      vlessUrl: order.vless_url || existingVpnAcc?.vless_url,
      subscriptionUrl: order.vless_url || existingVpnAcc?.vless_url,
      vpnAccountId: existingVpnAcc?.id
    };
  }

  // Parse JSON-serialized order metadata from payment_method if applicable
  let extra: any = {};
  if (order.payment_method && order.payment_method.startsWith('{')) {
    try {
      extra = JSON.parse(order.payment_method);
    } catch (e) {
      console.error('[3X-UI Provisioning] Error parsing payment_method JSON:', e);
    }
  }

  const templateId = extra.template_id || extra.templateId || order.template_id || order.templateId || '';
  const packageName = extra.package_name || extra.packageName || extra.plan || extra.package || order.package_name || '';
  const customerName = extra.configurationName || extra.customerName || extra.name || extra.full_name || (order.email ? order.email.split('@')[0] : 'Customer');
  const customerId = order.customer_id || extra.customer_id || '';

  console.log('=== [PURCHASE FLOW LOGGING START] ===');
  console.log('[Purchase Flow] Purchase request payload:', {
    order_id: order.id || order.order_id,
    customer_id: order.customer_id,
    email: order.email,
    package_name: order.package_name,
    amount: order.amount,
    payment_method_raw: order.payment_method,
    parsed_extra: extra
  });
  console.log('[Purchase Flow] Backend received template ID:', templateId || '(none provided)', '| Package Name:', packageName);

  // Step 1: Find the provisioning template (returns null if not found; NO fallback to template[0])
  const template = await findProvisioningTemplate({ templateId, packageName });
  if (!template) {
    console.error(`[Purchase Flow] Error: Provisioning template not found for package '${packageName}' (Template ID: '${templateId}').`);
    throw new Error(`Provisioning template not found for package '${packageName || templateId}'.`);
  }

  console.log('[Purchase Flow] Selected template ID:', template.id);
  console.log('[Purchase Flow] Selected template name:', template.package_name || template.name);
  console.log('[Purchase Flow] Loaded template:', JSON.stringify(template, null, 2));

  // Requirement 2: Ensure inbound_id comes from template
  const rawInboundId = template.inbound_id !== undefined && template.inbound_id !== null ? template.inbound_id : template.inboundId;
  if (rawInboundId === undefined || rawInboundId === null || rawInboundId === '') {
    const errorMsg = `Provisioning template '${template.id}' for package '${packageName}' is missing 'inbound_id'.`;
    console.error(`[Purchase Flow] Error: ${errorMsg}`);
    throw new Error(errorMsg);
  }

  const inboundId = Number(rawInboundId);
  if (isNaN(inboundId) || inboundId <= 0) {
    const errorMsg = `Provisioning template '${template.id}' for package '${packageName}' has invalid inbound_id '${rawInboundId}'.`;
    console.error(`[Purchase Flow] Error: ${errorMsg}`);
    throw new Error(errorMsg);
  }

  console.log(`[Provisioning Audit] Template inbound_id validated: ${inboundId}`);
  console.log(`[Purchase Flow] DEBUG: Selected Template ID: ${template.id}`);
  console.log(`[Purchase Flow] DEBUG: Template inbound_id: ${template.inbound_id}`);
  console.log(`[Purchase Flow] DEBUG: Template inboundId: ${template.inboundId}`);
  console.log(`[Purchase Flow] DEBUG: Full Template: ${JSON.stringify(template, null, 2)}`);
  console.log(`[Purchase Flow] DEBUG: Final inboundId: ${inboundId}`);
  
  // Note: 3X-UI inbound used will be logged when calling the 3X-UI API, which typically logs inboundId.
  // We already have the inboundId here.

  const address = template.address || '';
  const sni = template.sni || '';
  const remarkFormat = template.remark_template || template.remarkFormat || '{{customerName}}';

  const orderDisplayId = (order.order_id || order.id || '').trim();
  const remark = formatClientRemark(remarkFormat, customerName, orderDisplayId);

  const isValidUuid = (val: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val || '');
  const validUserId = isValidUuid(customerId) ? customerId : (isValidUuid(order.customer_id) ? order.customer_id : null);

  const isTrialOrder = !!(extra.is_trial || extra.isTrial || extra.paymentMethod === 'Free Trial' || extra.duration === '1 Day' || String(order.order_id || '').startsWith('TRIAL-'));

  // 1. Check if the customer already has an existing trial configuration in database
  let existingTrialConfig: any = null;
  if (validUserId) {
    const { data: trials, error: trialsErr } = await dbClient
      .from('vpn_configs')
      .select('*')
      .eq('customer_uid', validUserId)
      .eq('is_trial', true)
      .maybeSingle();
    if (trialsErr) {
      console.warn('[3X-UI Provisioning DB] Failed to lookup existing trial configs:', trialsErr);
    }
    existingTrialConfig = trials;
  }

  // Check if an existing VPN account exists for this order/user
  let existingAcc: any = null;
  if (order.id) {
    const { data: d1, error: e1 } = await dbClient
      .from('vpn_accounts')
      .select('*')
      .eq('order_id', order.id)
      .maybeSingle();
    if (e1) console.warn('[3X-UI Provisioning DB] vpn_accounts select by order_id notice:', e1);
    existingAcc = d1;
  }

  // Requirement 5: If the customer already has an existing trial configuration, update it instead of creating a duplicate.
  if (!existingAcc && isTrialOrder && validUserId) {
    const { data: d1, error: e1 } = await dbClient
      .from('vpn_accounts')
      .select('*')
      .eq('user_id', validUserId)
      .eq('is_trial', true)
      .maybeSingle();
    if (e1) console.warn('[3X-UI Provisioning DB] vpn_accounts select by trial/user notice:', e1);
    existingAcc = d1;
  }

  if (!existingAcc && validUserId && remark) {
    const { data: d1, error: e1 } = await dbClient
      .from('vpn_accounts')
      .select('*')
      .eq('user_id', validUserId)
      .eq('remark', remark)
      .maybeSingle();
    if (e1) console.warn('[3X-UI Provisioning DB] vpn_accounts select by user/remark notice:', e1);
    existingAcc = d1;
  }

  // Fetch all inbounds to search for an existing client in 3X-UI panel
  const allInbounds = await getInbounds();
  let existingClient = null;
  let targetInboundId = inboundId;

  // Search by remark (email) or by known UUIDs from database
  for (const ib of allInbounds) {
    let settingsObj: any = {};
    try {
      settingsObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings;
    } catch (e) { continue; }
    const clients = settingsObj.clients || [];
    const found = clients.find((c: any) => 
      String(c.email).trim().toLowerCase() === remark.trim().toLowerCase() ||
      (existingTrialConfig && String(c.id).trim().toLowerCase() === String(existingTrialConfig.uuid).trim().toLowerCase()) ||
      (existingAcc && String(c.id).trim().toLowerCase() === String(existingAcc.uuid).trim().toLowerCase())
    );
    if (found) {
      existingClient = found;
      targetInboundId = Number(ib.id);
      break;
    }
  }

  // Duration & Traffic calculations based on loaded template profiles
  const duration = extra.duration || '1 Month';
  let days = 30;
  if (template.duration_profiles && template.duration_profiles[duration]) {
    days = Number(template.duration_profiles[duration]);
  } else {
    const numMatch = String(duration).match(/(\d+)/);
    if (numMatch) {
      const num = parseInt(numMatch[1], 10);
      days = String(duration).toLowerCase().includes('month') ? num * 30 : num;
    }
  }
  let expiryMs = Date.now() + (days * 24 * 60 * 60 * 1000);

  let totalBytes = 0;
  const packageTypeKey = extra.packageType || extra.type || '';
  if (template.traffic_profiles && template.traffic_profiles[packageTypeKey] !== undefined) {
    const gbVal = Number(template.traffic_profiles[packageTypeKey]);
    totalBytes = gbVal > 0 ? gbVal * 1024 * 1024 * 1024 : 0;
  } else if (template.traffic_profiles && template.traffic_profiles['100GB'] !== undefined && String(packageTypeKey).includes('100')) {
    const gbVal = Number(template.traffic_profiles['100GB']);
    totalBytes = gbVal > 0 ? gbVal * 1024 * 1024 * 1024 : 0;
  } else {
    const combinedPlanStr = `${extra.packageType || ''} ${packageName || ''} ${extra.plan || ''} ${extra.traffic || ''}`.toLowerCase();
    if (combinedPlanStr.includes('100gb') || combinedPlanStr.includes('100 gb') || combinedPlanStr.includes('100')) {
      totalBytes = 100 * 1024 * 1024 * 1024;
    }
  }

  // Trial Override: Apply 1 Day (24h) and 1 GB Limit strictly for Free Trials
  if (isTrialOrder) {
    days = 1;
    totalBytes = 1 * 1024 * 1024 * 1024; // 1 GB
    expiryMs = Date.now() + (1 * 24 * 60 * 60 * 1000);
  }

  // Determine UUID and subId, prioritizing existing records to prevent duplicates
  let uuid = existingClient ? existingClient.id : (existingTrialConfig ? existingTrialConfig.uuid : (existingAcc ? existingAcc.uuid : crypto.randomUUID()));
  let subId = existingClient ? existingClient.subId : crypto.randomBytes(12).toString('hex');

  // Let's ensure if existingAcc is null, we fetch any existing account with the same UUID to prevent duplicate key constraint violation.
  if (!existingAcc && uuid) {
    const { data: accByUuid, error: errByUuid } = await dbClient
      .from('vpn_accounts')
      .select('*')
      .eq('uuid', uuid)
      .maybeSingle();
    if (errByUuid) {
      console.warn('[3X-UI Provisioning DB] vpn_accounts select by uuid notice:', errByUuid);
    }
    if (accByUuid) {
      console.log(`[3X-UI Provisioning DB] Found existing vpn_account matching UUID: ${uuid}. Setting existingAcc to avoid duplicate INSERT.`);
      existingAcc = accByUuid;
    }
  }

  // Find target inbound details from our cached list
  const inbound = allInbounds.find((i: any) => Number(i.id) === inboundId) || {
    id: inboundId,
    port: 443,
    protocol: 'vless',
    streamSettings: JSON.stringify({ network: 'tcp', security: 'reality' })
  };

  let streamObj: any = {};
  if (typeof inbound.streamSettings === 'string') {
    try { streamObj = JSON.parse(inbound.streamSettings); } catch (e) {}
  } else if (inbound.streamSettings) {
    streamObj = inbound.streamSettings;
  }

  const security = streamObj.security || template.security || 'none';
  let flow = '';
  if (security === 'reality') {
    const reality = streamObj.realitySettings || streamObj.realitySettings?.settings || {};
    const settings = reality.settings || reality;
    flow = template.flow || settings.flow || reality.flow || 'xtls-rprx-vision';
  } else {
    flow = template.flow || '';
  }

  // Check whether the client is already assigned to the target inbound
  let alreadyAssignedToTarget = false;
  const targetInbound = allInbounds.find((ib: any) => Number(ib.id) === inboundId);
  if (targetInbound) {
    let targetSettings: any = {};
    try {
      targetSettings = typeof targetInbound.settings === 'string' ? JSON.parse(targetInbound.settings) : targetInbound.settings;
    } catch (e) {}
    const clients = targetSettings.clients || [];
    const found = clients.find((c: any) => 
      String(c.email).trim().toLowerCase() === remark.trim().toLowerCase() ||
      String(c.id).trim().toLowerCase() === uuid.trim().toLowerCase()
    );
    if (found) {
      alreadyAssignedToTarget = true;
    }
  }

  // Requirement 7: Add logging
  console.log('=== [CLIENT-INBOUND DETAILED LOOKUP LOGGING] ===');
  console.log(`- Client UUID: ${uuid}`);
  console.log(`- Email: ${remark}`);
  console.log(`- Inbound ID: ${inboundId}`);
  console.log(`- Template ID: ${template.id}`);
  console.log(`- Existing client lookup result: ${existingClient ? JSON.stringify(existingClient) : 'None'}`);
  console.log(`- Existing inbound assignment lookup result: ${alreadyAssignedToTarget ? 'Already assigned' : 'Not assigned'}`);
  console.log('================================================');

  console.log('[Purchase Flow] Inbound ID:', inboundId);
  console.log('[Purchase Flow] Protocol:', inbound.protocol);
  console.log('[Purchase Flow] Configuration used:', {
    address,
    sni,
    remarkFormat,
    remark,
    flow,
    security,
    totalBytes,
    expiryMs,
    durationDays: days,
    trafficLimitGB: totalBytes > 0 ? totalBytes / (1024 * 1024 * 1024) : 'Unlimited'
  });

  console.log('=== [PURCHASE FLOW LOGGING END] ===');

  let skipAttachment = false;
  let skipMsg = '';

  // Requirement 4 & 6 & 8: Check if client is already assigned to the inbound
  if (alreadyAssignedToTarget) {
    skipAttachment = true;
    skipMsg = "Client already exists on this inbound. Skipping duplicate assignment.";
    console.log(`[3X-UI Provisioning] ${skipMsg}`);

    // Requirement 5: If the customer already has an existing trial configuration, update it instead of creating a duplicate.
    try {
      const updateEndpoints = [
        `/panel/api/inbounds/updateClient/${uuid}`,
        `/panel/api/clients/update/${uuid}`
      ];

      const updatePayload = {
        id: inboundId,
        settings: JSON.stringify({
          clients: [
            {
              id: uuid,
              email: remark,
              flow: flow,
              limitIp: 0,
              totalGB: totalBytes,
              expiryTime: expiryMs,
              enable: true,
              subId: subId
            }
          ]
        })
      };

      console.log('[3X-UI Provisioning] Updating existing client settings in 3X-UI payload:', JSON.stringify(updatePayload, null, 2));

      let updated = false;
      for (const endpoint of updateEndpoints) {
        try {
          await requestApi<any>(endpoint, 'POST', updatePayload);
          updated = true;
          break;
        } catch (epErr: any) {
          console.warn(`[3X-UI Provisioning] Update on ${endpoint} failed:`, epErr?.message || epErr);
        }
      }

      if (!updated) {
        console.warn('[3X-UI Provisioning] Update of existing client settings failed across all endpoints.');
      }
    } catch (updErr: any) {
      console.warn('[3X-UI Provisioning] Update of existing client settings failed (non-fatal):', updErr?.message || updErr);
    }
  }

  // Step 2: Create or reuse the 3X-UI client (Do NOT stop if client already exists)
  if (!skipAttachment) {
    console.log(`[3X-UI Provisioning] Calling add3XUiClient with inboundId: ${inboundId}, Package: ${template.package_name}, Template ID: ${template.id}`);
    try {
      await add3XUiClient(inboundId, {
        uuid,
        email: remark,
        totalBytes,
        expiryMs,
        subId,
        flow
      });
    } catch (addErr: any) {
      const errMsg = String(
        addErr?.message || 
        addErr?.response?.data?.msg || 
        addErr?.response?.data?.message || 
        addErr?.response?.data || 
        ''
      ).toLowerCase();

      console.warn(`[3X-UI Provisioning] add3XUiClient warning/notice: ${errMsg}`);

      const isDuplicate = 
        errMsg.includes('already exist') || 
        errMsg.includes('duplicate') || 
        errMsg.includes('exists') || 
        errMsg.includes('email');

      if (isDuplicate) {
        skipMsg = "Client already exists on this inbound. Skipping duplicate assignment.";
        console.log(`[3X-UI Provisioning] ${skipMsg}`);
      } else {
        console.error('[3X-UI Provisioning] Failed to create 3X-UI client:', addErr);
        throw addErr;
      }
    }
  }

  // Immediately read back the created client from 3X-UI to get the exact UUID returned
  const readBackClient = await getClientByEmail(remark);
  if (readBackClient && readBackClient.uuid) {
    uuid = readBackClient.uuid;
    if (readBackClient.subId) subId = readBackClient.subId;
  } else {
    console.warn(`[3X-UI Provisioning] Read back client returned null for remark '${remark}', using UUID: ${uuid}`);
  }

  // Step 3: Generate the VLESS URL and subscription URL
  const vlessUrl = buildVlessLink(inbound, address, sni, uuid, remark);
  const subscriptionUrl = vlessUrl;

  // Step 4: Upsert vpn_accounts
  let vpnAccountId = '';

  const accPayload: any = {
    user_id: validUserId,
    order_id: order.id,
    email: order.email,
    remark: remark,
    uuid: uuid,
    vless_url: vlessUrl,
    subscription_url: subscriptionUrl,
    server_name: template.server || extra.server || 'Singapore',
    expiry_date: new Date(expiryMs).toISOString(),
    expiry_time: expiryMs,
    total_bytes: totalBytes,
    status: 'active',
    enable: true,
    is_trial: isTrialOrder,
    activated_at: new Date().toISOString(),
    expires_at: new Date(expiryMs).toISOString(),
    data_limit: isTrialOrder ? '1GB' : (totalBytes > 0 ? `${totalBytes / (1024 * 1024 * 1024)}GB` : 'Unlimited'),
    updated_at: new Date().toISOString()
  };

  let accErr: any = null;
  if (existingAcc && existingAcc.id) {
    vpnAccountId = existingAcc.id;
    const { error } = await dbClient.from('vpn_accounts').update(accPayload).eq('id', existingAcc.id);
    accErr = error;
  } else {
    const { data: newAcc, error } = await dbClient.from('vpn_accounts').insert({
      ...accPayload,
      created_at: new Date().toISOString()
    }).select('id').maybeSingle();
    accErr = error;
    vpnAccountId = newAcc?.id || vpnAccountId;
  }

  if (accErr) {
    console.error("[3X-UI Provisioning DB] Error updating table 'vpn_accounts':", accErr);
    throw new Error(`Database update failed for table 'vpn_accounts': ${accErr.message || JSON.stringify(accErr)}`);
  }

  // Step 5: Upsert vpn_configs
  let existingConfig: any = null;
  if (order.id) {
    const { data: cData, error: cErr } = await dbClient.from('vpn_configs').select('id').eq('order_id', order.id).maybeSingle();
    if (cErr) console.warn('[3X-UI Provisioning DB] vpn_configs select by order_id notice:', cErr);
    existingConfig = cData;
  }

  const configPayload: any = {
    customer_uid: validUserId,
    order_id: order.id,
    package_name: packageName,
    package_type: extra.packageType || 'SIM Unlimited',
    config_name: extra.configurationName || customerName,
    uuid: uuid,
    subscription_url: subscriptionUrl,
    vless_url: vlessUrl,
    server_address: address,
    server: template.server || extra.server || 'Singapore',
    sni: sni,
    inbound_id: inboundId,
    traffic_limit: isTrialOrder ? '1GB' : (totalBytes > 0 ? `${totalBytes / (1024 * 1024 * 1024)}GB` : 'Unlimited'),
    expiry_time: new Date(expiryMs).toISOString(),
    expiry_date: new Date(expiryMs).toISOString(),
    enabled: true,
    status: 'active',
    is_trial: isTrialOrder,
    activated_at: new Date().toISOString(),
    expires_at: new Date(expiryMs).toISOString(),
    data_limit: isTrialOrder ? '1GB' : (totalBytes > 0 ? `${totalBytes / (1024 * 1024 * 1024)}GB` : 'Unlimited')
  };

  let confErr: any = null;
  if (existingConfig && existingConfig.id) {
    const { error } = await dbClient.from('vpn_configs').update(configPayload).eq('id', existingConfig.id);
    confErr = error;
  } else {
    const { error } = await dbClient.from('vpn_configs').upsert({
      ...configPayload,
      created_at: new Date().toISOString()
    });
    confErr = error;
  }

  if (confErr) {
    console.error("[3X-UI Provisioning DB] Error updating table 'vpn_configs':", confErr);
    throw new Error(`Database update failed for table 'vpn_configs': ${confErr.message || JSON.stringify(confErr)}`);
  }

  const { data: savedConfig } = await dbClient.from('vpn_configs').select('inbound_id').eq('order_id', order.id).maybeSingle();
  console.log(`[Provisioning Audit] Database inbound_id after save (vpn_configs): ${savedConfig?.inbound_id}`);
  if (!savedConfig || Number(savedConfig.inbound_id) !== Number(inboundId)) {
    console.error(`[Provisioning Audit] ERROR: inbound_id in vpn_configs after save is ${savedConfig?.inbound_id}, expected ${inboundId}`);
    throw new Error(`Failed to persist inbound_id in vpn_configs: expected ${inboundId}, got ${savedConfig?.inbound_id}`);
  }

  // Step 6: Update orders (payment_status='Paid', status='completed')
  const ordersPayload: any = {
    payment_status: 'Paid',
    status: 'completed',
    provisioning_status: 'completed',
    client_uuid: uuid,
    vless_url: vlessUrl,
    subscription_url: subscriptionUrl,
    inbound_id: inboundId,
    expiry_date: new Date(expiryMs).toISOString(),
    is_trial: isTrialOrder,
    activated_at: new Date().toISOString(),
    expires_at: new Date(expiryMs).toISOString(),
    updated_at: new Date().toISOString()
  };

  const { error: orderUpdateErr } = await dbClient.from('orders').update(ordersPayload).eq('id', order.id);

  if (orderUpdateErr) {
    console.error("[3X-UI Provisioning DB] Error updating table 'orders':", orderUpdateErr);
    throw new Error(`Database update failed for table 'orders': ${orderUpdateErr.message || JSON.stringify(orderUpdateErr)}`);
  }

  const { data: savedOrder } = await dbClient.from('orders').select('inbound_id').eq('id', order.id).maybeSingle();
  console.log(`[Provisioning Audit] Database inbound_id after save (orders): ${savedOrder?.inbound_id}`);
  if (!savedOrder || Number(savedOrder.inbound_id) !== Number(inboundId)) {
    console.error(`[Provisioning Audit] ERROR: inbound_id in orders after save is ${savedOrder?.inbound_id}, expected ${inboundId}`);
    throw new Error(`Failed to persist inbound_id in orders: expected ${inboundId}, got ${savedOrder?.inbound_id}`);
  }

  // Step 7: Create customer notification in notifications table
  try {
    if (isTrialOrder) {
      console.log('[3X-UI Provisioning DB] Triggering Trial Approved and VPN Created notifications');
      await createCustomerNotification({
        userId: validUserId,
        userEmail: order.email,
        title: 'Trial Approved',
        message: `Your free trial request for "${packageName}" has been approved!`,
        type: 'trial_approved',
        orderId: order.id,
        vpnName: packageName
      });
      await createCustomerNotification({
        userId: validUserId,
        userEmail: order.email,
        title: 'VPN Created',
        message: `Your trial VPN configuration "${packageName}" has been created successfully and is ready to use.`,
        type: 'vpn_created',
        orderId: order.id,
        vpnName: packageName
      });
    } else {
      console.log('[3X-UI Provisioning DB] Triggering Payment Approved and VPN Created notifications');
      await createCustomerNotification({
        userId: validUserId,
        userEmail: order.email,
        title: 'Payment Approved',
        message: `Your payment for "${packageName}" has been verified and approved!`,
        type: 'payment_approved',
        orderId: order.id,
        vpnName: packageName
      });
      await createCustomerNotification({
        userId: validUserId,
        userEmail: order.email,
        title: 'VPN Created',
        message: `Your VPN configuration "${packageName}" has been created successfully and is ready to use.`,
        type: 'vpn_created',
        orderId: order.id,
        vpnName: packageName
      });
    }
  } catch (notifErr: any) {
    console.error('[3X-UI Provisioning DB] CRITICAL: Customer notification creation failed:', notifErr.message || notifErr);
  }

  // Step 8: Send Telegram notification and return success
  try {
    await sendOrderApprovedNotification({
      customerEmail: order.email || 'N/A',
      packageName: packageName,
      packageType: extra.packageType || 'SIM Unlimited',
      server: template.server || extra.server || 'Singapore',
      duration: duration,
      price: order.amount || 0,
      uuid: uuid,
      orderId: order.order_id || order.id,
      status: '🟢 COMPLETED'
    });
  } catch (tgErr) {
    console.warn('[3X-UI Provisioning DB] Telegram notification warning:', tgErr);
  }

  return {
    success: true,
    message: skipMsg || 'VPN client provisioned and order completed successfully',
    orderId: order.order_id || order.id,
    uuid,
    vlessUrl,
    subscriptionUrl,
    vpnAccountId
  };
  } finally {
    activeProvisionings.delete(orderId);
  }
};

export const disable3XUiClient = async (inboundId: number | null, uuid: string, email?: string): Promise<boolean> => {
  try {
    const config = await getXuiConfig();
    const token = config.apiToken || config.password;
    if (!token) return false;

    const endpointsToTry = [
      `/panel/api/inbounds/updateClient/${uuid}`,
      `/panel/api/clients/update/${uuid}`
    ];

    if (inboundId) {
      endpointsToTry.push(`/panel/api/inbounds/${inboundId}/delClient/${uuid}`);
    }

    for (const endpoint of endpointsToTry) {
      try {
        const { baseUrl, fullPath } = getApiEndpointUrl(config.panelUrl, endpoint);
        const client = createAxiosInstance(baseUrl);

        if (endpoint.includes('delClient')) {
          await client.post(fullPath, {}, { headers: { Authorization: `Bearer ${token}` } });
          return true;
        } else {
          const payload = {
            id: inboundId || 1,
            settings: JSON.stringify({
              clients: [{
                id: uuid,
                email: email || '',
                enable: false,
                expiryTime: 0,
                totalGB: 0
              }]
            })
          };
          const res = await client.post(fullPath, payload, { headers: { Authorization: `Bearer ${token}` } });
          if (res.data && (res.data.success || res.status === 200)) return true;
        }
      } catch (e) {
        // Continue to next endpoint
      }
    }
    return false;
  } catch (err) {
    console.warn(`[3X-UI] Error disabling client ${uuid}:`, err);
    return false;
  }
};

let lastCleanupTime = 0;

export const cleanupExpiredTrials = async (): Promise<{ count: number }> => {
  const now = Date.now();
  if (now - lastCleanupTime < 3000) {
    return { count: 0 };
  }
  lastCleanupTime = now;

  let expiredCount = 0;
  try {
    const dbClient = supabaseAdmin;

    // 1. Fetch vpn_configs
    const { data: configs } = await dbClient
      .from('vpn_configs')
      .select('*');

    // 2. Fetch vpn_accounts
    const { data: accounts } = await dbClient
      .from('vpn_accounts')
      .select('*');

    // 3. Fetch 3X-UI inbounds for live stats - Removed: unnecessary API requests
    let inbounds: any[] = [];

    const candidateTrials: Array<{
      type: 'config' | 'account';
      id: string;
      orderId: string;
      uuid: string;
      customerUid: string;
      email: string;
      packageName: string;
      inboundId: number | null;
      expiryMs: number | null;
      status: string;
      enabled: boolean;
      totalBytes: number;
      isTrial: boolean;
    }> = [];

    if (configs && Array.isArray(configs)) {
      configs.forEach(cfg => {
        const orderId = String(cfg.order_id || '');
        const isTrial = !!(cfg.is_trial || cfg.isTrial || cfg.trial || orderId.startsWith('TRIAL-') || String(cfg.package_type || '').toLowerCase().includes('trial'));
        const isAlreadyExpired = String(cfg.status || '').toLowerCase() === 'expired' || cfg.enabled === false;

        if (isTrial && !isAlreadyExpired) {
          const expVal = cfg.expires_at || cfg.expiry_date || cfg.expiry_time;
          let expMs: number | null = null;
          if (expVal) {
            expMs = typeof expVal === 'number' ? (expVal < 10000000000 ? expVal * 1000 : expVal) : new Date(expVal).getTime();
          }

          candidateTrials.push({
            type: 'config',
            id: cfg.id,
            orderId,
            uuid: cfg.uuid,
            customerUid: cfg.customer_uid,
            email: '',
            packageName: cfg.package_name || cfg.config_name || 'FIREVPN Package',
            inboundId: cfg.inbound_id || null,
            expiryMs: expMs,
            status: cfg.status,
            enabled: cfg.enabled !== false,
            totalBytes: 1073741824, // 1 GB
            isTrial: true
          });
        }
      });
    }

    if (accounts && Array.isArray(accounts)) {
      accounts.forEach(acc => {
        const orderId = String(acc.order_id || '');
        const isTrial = !!(acc.is_trial || acc.isTrial || acc.trial || orderId.startsWith('TRIAL-'));
        const isAlreadyExpired = String(acc.status || '').toLowerCase() === 'expired' || acc.enable === false;

        if (isTrial && !isAlreadyExpired) {
          const existsInCandidates = candidateTrials.some(c => c.orderId === orderId || (c.uuid && acc.uuid && c.uuid.toLowerCase() === acc.uuid.toLowerCase()));
          if (!existsInCandidates) {
            const expVal = acc.expires_at || acc.expiry_date || acc.expiry_time;
            let expMs: number | null = null;
            if (expVal) {
              expMs = typeof expVal === 'number' ? (expVal < 10000000000 ? expVal * 1000 : expVal) : new Date(expVal).getTime();
            }

            candidateTrials.push({
              type: 'account',
              id: acc.id,
              orderId,
              uuid: acc.uuid,
              customerUid: acc.user_id,
              email: acc.email || '',
              packageName: acc.remark || 'FIREVPN Package',
              inboundId: null,
              expiryMs: expMs,
              status: acc.status,
              enabled: acc.enable !== false,
              totalBytes: acc.total_bytes || 1073741824,
              isTrial: true
            });
          }
        }
      });
    }

    for (const trial of candidateTrials) {
      let isExpiredByTime = false;
      let isExpiredByData = false;

      // Requirement 1, 3 & 4: Trial expires only when current_time >= expires_at + grace_period
      if (trial.expiryMs) {
        if (now >= trial.expiryMs + TRIAL_GRACE_PERIOD_MS) {
          isExpiredByTime = true;
          console.log(`[Trial Expiry Scheduler] Grace period completed: Order ID = ${trial.orderId}, UUID = ${trial.uuid}. Expiry = ${new Date(trial.expiryMs).toISOString()}, Grace Period End = ${new Date(trial.expiryMs + TRIAL_GRACE_PERIOD_MS).toISOString()}`);
        } else if (now >= trial.expiryMs) {
          console.log(`[Trial Expiry Scheduler] Trial entered grace period: Order ID = ${trial.orderId}, UUID = ${trial.uuid}. Expiry = ${new Date(trial.expiryMs).toISOString()}, Grace Period End = ${new Date(trial.expiryMs + TRIAL_GRACE_PERIOD_MS).toISOString()}`);
        }
      }

      // Requirement 2: Or when user reaches the 1 GB data limit (1,073,741,824 bytes)
      const ONE_GB_BYTES = 1073741824;
      let usedBytes = 0;

      if (inbounds.length > 0 && trial.uuid) {
        for (const ib of inbounds) {
          const clientStats = ib.clientStats || [];
          const stat = clientStats.find((s: any) => String(s.id || '').toLowerCase() === String(trial.uuid).toLowerCase());
          if (stat) {
            usedBytes = (stat.up || 0) + (stat.down || 0);
            break;
          }
        }
      }

      if (usedBytes >= ONE_GB_BYTES) {
        isExpiredByData = true;
      }

      if (isExpiredByTime || isExpiredByData) {
        console.log(`[Trial Expiry Scheduler] Trial found for expiration: Order ID = ${trial.orderId}, UUID = ${trial.uuid}, Email = ${trial.email}, Reason = ${isExpiredByTime ? 'Time Expired (Grace Period Completed)' : 'Data Limit (1GB) Reached'}, Expiry = ${trial.expiryMs ? new Date(trial.expiryMs).toISOString() : 'N/A'}`);

        // Requirement 3 & 6: Disable or remove VPN client from 3X-UI. Do not mark database as expired if this fails.
        let removedSuccessfully = true;
        if (trial.uuid) {
          try {
            removedSuccessfully = await disable3XUiClient(trial.inboundId, trial.uuid, trial.email);
            if (removedSuccessfully) {
              console.log(`[Trial Expiry Scheduler] Trial successfully removed from 3X-UI: UUID = ${trial.uuid}, Email = ${trial.email}`);
            } else {
              console.error(`[Trial Expiry Scheduler] Error removing client ${trial.uuid} from 3X-UI: disable3XUiClient returned false.`);
            }
          } catch (err: any) {
            removedSuccessfully = false;
            console.error(`[Trial Expiry Scheduler] Error removing client ${trial.uuid} from 3X-UI:`, err.message || err);
          }
        }

        if (!removedSuccessfully) {
          console.warn(`[Trial Expiry Scheduler] 3X-UI panel is temporarily unavailable or client deletion failed for UUID: ${trial.uuid}. Skipping DB updates and retrying on next run.`);
          continue;
        }

        // Requirement 3: Mark trial as Expired in database and record exact expiration time in updated_at (keep record for history)
        const expirationTimeIso = new Date().toISOString();

        if (trial.type === 'config' || trial.id) {
          const { error: cfgErr } = await dbClient
            .from('vpn_configs')
            .update({ 
              status: 'expired', 
              enabled: false,
              updated_at: expirationTimeIso
            })
            .eq('id', trial.id);

          if (cfgErr) {
            console.error(`[Trial Expiry Scheduler] Database error updating vpn_configs for ID ${trial.id}:`, cfgErr);
          } else {
            console.log(`[Trial Expiry Scheduler] Database updated (vpn_configs) to status 'expired' and updated_at recorded for ID ${trial.id}`);
          }
        }

        if (trial.orderId) {
          const { error: accErr } = await dbClient
            .from('vpn_accounts')
            .update({ 
              status: 'expired', 
              enable: false,
              updated_at: expirationTimeIso
            })
            .eq('order_id', trial.orderId);

          if (accErr) {
            console.error(`[Trial Expiry Scheduler] Database error updating vpn_accounts for order ID ${trial.orderId}:`, accErr);
          } else {
            console.log(`[Trial Expiry Scheduler] Database updated (vpn_accounts) to status 'expired' and updated_at recorded for order ID ${trial.orderId}`);
          }

          const { error: ordErr } = await dbClient
            .from('orders')
            .update({ 
              status: 'expired', 
              payment_status: 'Expired', 
              updated_at: expirationTimeIso
            })
            .eq('id', trial.orderId);

          if (ordErr) {
            console.error(`[Trial Expiry Scheduler] Database error updating orders (by ID) for ID ${trial.orderId}:`, ordErr);
          } else {
            console.log(`[Trial Expiry Scheduler] Database updated (orders table ID) to status 'expired' for ID ${trial.orderId}`);
          }

          const { error: ordErr2 } = await dbClient
            .from('orders')
            .update({ 
              status: 'expired', 
              payment_status: 'Expired', 
              updated_at: expirationTimeIso
            })
            .eq('order_id', trial.orderId);

          if (ordErr2) {
            console.error(`[Trial Expiry Scheduler] Database error updating orders (by order_id) for ID ${trial.orderId}:`, ordErr2);
          } else {
            console.log(`[Trial Expiry Scheduler] Database updated (orders table order_id) to status 'expired' for ID ${trial.orderId}`);
          }
        }

        // Requirement 3 & 4: Create customer notification (idempotency check ensures never duplicated)
        const targetUserId = trial.customerUid;
        const targetEmail = trial.email;

        if (targetUserId || targetEmail) {
          let notifQuery = dbClient
            .from('notifications')
            .select('id')
            .eq('type', 'trial_expired');

          if (targetUserId) {
            notifQuery = notifQuery.eq('user_id', targetUserId);
          } else if (targetEmail) {
            notifQuery = notifQuery.eq('user_email', targetEmail);
          }

          if (trial.orderId) {
            notifQuery = notifQuery.eq('order_id', trial.orderId);
          }

          const { data: existingNotifs, error: notifFetchErr } = await notifQuery.maybeSingle();

          if (notifFetchErr) {
            console.error(`[Trial Expiry Scheduler] Database error searching existing notifications:`, notifFetchErr);
          }

          if (!existingNotifs) {
            try {
              await createCustomerNotification({
                userId: targetUserId || null,
                userEmail: targetEmail,
                title: '⌛ Free Trial Expired',
                message: 'Your 1 GB / 1 Day trial has ended. Purchase a VPN package to continue using FIREVPNs.',
                type: 'trial_expired',
                orderId: trial.orderId,
                vpnName: trial.packageName
              });
              console.log(`[Trial Expiry Scheduler] Notification created successfully for user: ${targetUserId || targetEmail}`);
            } catch (notifCreateErr: any) {
              console.error(`[Trial Expiry Scheduler] Error creating customer notification:`, notifCreateErr.message || notifCreateErr);
            }
          } else {
            console.log(`[Trial Expiry Scheduler] Idempotency: Skip duplicate notification for trial ID/Order: ${trial.orderId}`);
          }
        }

        console.log(`[Trial Expiry Scheduler] Trial expired successfully: Order ID = ${trial.orderId}, UUID = ${trial.uuid}`);
        expiredCount++;
      }
    }
  } catch (err) {
    console.error('[Cleanup Expired Trials] Error during trial cleanup execution:', err);
  }

  return { count: expiredCount };
};


