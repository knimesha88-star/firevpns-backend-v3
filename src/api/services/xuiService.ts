import axios, { AxiosInstance, AxiosError } from 'axios';
import { supabase, supabaseAdmin, getSupabaseClient } from '../../lib/supabase.js';
import { sendOrderApprovedNotification } from './telegramService.js';
import { createCustomerNotification } from './notificationService.js';

import crypto from 'crypto';

import https from 'https';

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

const createAxiosInstance = (baseUrl: string) => {
  return axios.create({
    baseURL: baseUrl,
    timeout: 15000,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }), // In case of self-signed certs
    validateStatus: (status) => status < 500
  });
};

const requestApi = async <T>(endpoint: string, method: 'GET' | 'POST' = 'GET', data?: any): Promise<T> => {
  const config = await getXuiConfig();
  
  // The frontend stores the token in the password field, or fallback to apiToken if provided
  const token = config.apiToken || config.password;
  if (!token) {
    throw new Error('API token is missing in 3X-UI settings');
  }

  const { baseUrl, fullPath, fullUrl } = getApiEndpointUrl(config.panelUrl, endpoint);
  const client = createAxiosInstance(baseUrl);

  console.log(`[XUI API] ${method} ${fullUrl}`);
  
  try {
    const response = await client.request({
      url: fullPath,
      method,
      data,
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    console.log(`[XUI API] Response status for ${endpoint}: ${response.status}`);

    if (response.status !== 200) {
      throw new Error(`3X-UI API Error: ${response.status} ${response.statusText}`);
    }

    if (response.data && response.data.success === false) {
      throw new Error(`3X-UI API Error: ${response.data.msg}`);
    }

    return response.data.obj;
  } catch (error: any) {
    console.error("=== 3X-UI ERROR ===");
    console.error(error.response?.status);
    console.error(error.response?.data);
    console.error(error.message);
    throw error;
  }
};

export const testApiConnection = async (config: XuiConfig): Promise<boolean> => {
  const token = config.apiToken || config.password;
  if (!token) {
    throw new Error('API token is missing');
  }

  const { baseUrl, fullPath, fullUrl } = getApiEndpointUrl(config.panelUrl, '/panel/api/inbounds/list');
  const client = createAxiosInstance(baseUrl);

  console.log(`[XUI API] Testing connection with GET ${fullUrl}`);
  
  const response = await client.request({
    url: fullPath,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  console.log(`[XUI API] Test connection response status: ${response.status}`);

  if (response.status !== 200) {
    throw new Error(`Connection test failed: ${response.status} ${response.statusText}`);
  }

  if (response.data && response.data.success === false) {
    throw new Error(`Connection test failed: ${response.data.msg}`);
  }

  return true;
};

export const getInbounds = async (): Promise<XuiInbound[]> => {
  try {
    const inboundsData = await requestApi<XuiInbound[]>('/panel/api/inbounds/list');
    const response = { data: { obj: inboundsData } };

    console.log("Total inbounds:", response.data.obj.length);

    response.data.obj.forEach((inbound: any) => {
        console.log("Inbound:", inbound.id, inbound.remark);

        const settings =
            typeof inbound.settings === "string"
                ? JSON.parse(inbound.settings)
                : inbound.settings;

        console.log("Clients in this inbound:", settings.clients.length);

        settings.clients.forEach((c: any) => {
            console.log("Client:", c.email);
        });
    });

    return inboundsData;
  } catch (error: any) {
    console.error('[XUI Service] Failed to retrieve inbounds:', error.message);
    return [];
  }
};

export const getClientByEmail = async (email: string): Promise<any | null> => {
  try {
    const inbounds = await getInbounds();
    
    console.log("Searching for email:", email);
    
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
        console.log("Comparing:", c.email, "==", email);
        if (String(c.email).trim().toLowerCase() === String(email).trim().toLowerCase()) {
          console.log("MATCH FOUND");
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
    console.log("NO MATCH FOUND AFTER CHECKING ALL CLIENTS");
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
        
        await requestApi<any>(`/panel/api/clients/update/${c.email}`, 'POST', {
          ...c,
          id: String(c.id),
          email: c.email,
          expiryTime: new_expiryTime
        });
        
        return new_expiryTime;
      }
    }
  }
  
  throw new Error(`Client with email ${email} not found in 3X-UI inbounds`);
};

export const findProvisioningTemplate = async (packageName: string): Promise<any | null> => {
  const targetName = (packageName || '').trim().toLowerCase();

  try {
    const { data: snapshot } = await supabase.from('provision_templates').select('*');
    if (snapshot && snapshot.length > 0) {
      const enabledTemplates = snapshot.filter(item => item.enabled !== false);
      if (enabledTemplates.length === 0) return null;

      if (targetName) {
        // 1. Exact match on package_name
        const exact = enabledTemplates.find(item => {
          const docName = String(item.package_name || item.name || item.id).trim().toLowerCase();
          return docName === targetName || docName === targetName.replace(/_/g, ' ') || docName.replace(/_/g, ' ') === targetName;
        });
        if (exact) return { id: exact.id, ...exact };

        // 2. Substring / Partial match
        const partial = enabledTemplates.find(item => {
          const docName = String(item.package_name || item.name || item.id).trim().toLowerCase();
          return targetName.includes(docName) || docName.includes(targetName);
        });
        if (partial) return { id: partial.id, ...partial };
      }

      // 3. Fallback to first enabled template
      return { id: enabledTemplates[0].id, ...enabledTemplates[0] };
    }
  } catch (e) {
    console.warn(`[3X-UI Service] Error checking provision_templates:`, e);
  }

  return null;
};

export const formatClientRemark = (templateFormat: string, customerName: string, orderId?: string): string => {
  const name = (customerName || '').trim() || 'Customer';
  const format = templateFormat || '{{customerName}}';
  let formatted = format.replace(/\{\{\s*customerName\s*\}\}/g, name);
  
  if (orderId) {
    const cleanOrderId = orderId.trim();
    if (cleanOrderId && !formatted.includes(cleanOrderId)) {
      formatted = `${formatted}-${cleanOrderId}`;
    }
  } else {
    const randomSuffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    formatted = `${formatted}-${randomSuffix}`;
  }
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
  const config = await getXuiConfig();
  const token = config.apiToken || config.password;
  if (!token) {
    throw new Error('API token is missing in 3X-UI settings');
  }

  const endpoint = '/panel/api/clients/add';
  const { baseUrl, fullPath, fullUrl } = getApiEndpointUrl(config.panelUrl, endpoint);
  const client = createAxiosInstance(baseUrl);

  const clientFlow = clientData.flow !== undefined ? clientData.flow : '';

  console.log("==================================================");
  console.log("[3X-UI add3XUiClient] Sending client payload with generated values:");
  console.log(`1. client.id (UUID v4): ${clientData.uuid}`);
  console.log(`2. client.subId: ${clientData.subId}`);
  console.log(`3. client.email (remark): ${clientData.email}`);
  console.log(`4. client.flow: ${clientFlow}`);

  const payload = {
    client: {
      id: clientData.uuid,
      email: clientData.email,
      flow: clientFlow,
      limitIp: 0,
      totalGB: clientData.totalBytes,
      expiryTime: clientData.expiryMs,
      enable: true,
      subId: clientData.subId
    },
    inboundIds: [inboundId]
  };

  console.log("Request URL:", fullUrl);
  console.log("=== 3X-UI REQUEST ===");
  console.log(JSON.stringify(payload, null, 2));

  try {
    const response = await client.request({
      url: fullPath,
      method: 'POST',
      data: payload,
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    console.log("=== 3X-UI RESPONSE ===");
    console.log(JSON.stringify(response.data, null, 2));

    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`3X-UI API Error: HTTP status ${response.status}`);
    }

    if (!response.data || response.data.success === false) {
      const errorMsg = response.data?.msg || 'API returned success=false';
      throw new Error(`3X-UI API Error: ${errorMsg}`);
    }

    console.log("Client Created Successfully");
    return response.data;
  } catch (error: any) {
    console.error("=== 3X-UI ERROR ===");
    console.error(error.response?.status);
    console.error(error.response?.data);
    console.error(error.message);
    throw error;
  }
};

export const provisionOrderClient = async (orderId: string, token?: string): Promise<any> => {
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

  console.log(`[3X-UI Provisioning] Starting approval transaction for Order ID: ${order.id} (${order.order_id || 'N/A'}) - Customer: ${order.email}`);

  // Idempotency Check: If order is already completed/active with existing VPN link, return existing details
  const isAlreadyCompleted = (order.status === 'completed' || order.status === 'active') && order.vless_url;
  if (isAlreadyCompleted) {
    console.log(`[3X-UI Provisioning] Order ${order.id} is already completed/active. Returning existing VPN.`);
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

  const packageName = extra.package_name || extra.plan || extra.package || order.package_name || '';
  const customerName = extra.configurationName || extra.customerName || extra.name || extra.full_name || (order.email ? order.email.split('@')[0] : 'Customer');
  const customerId = order.customer_id || extra.customer_id || '';

  // Step 1: Find the provisioning template
  const template = await findProvisioningTemplate(packageName);
  if (!template) {
    console.error(`[3X-UI Provisioning] Provisioning template not found for package '${packageName}'.`);
    throw new Error(`Provisioning template not found for package '${packageName}'.`);
  }

  const inboundId = Number(template.inbound_id) || 1;
  const address = template.address || '';
  const sni = template.sni || '';
  const remarkFormat = template.remark_template || template.remarkFormat || '{{customerName}}';

  const orderDisplayId = (order.order_id || order.id || '').trim();
  const remark = formatClientRemark(remarkFormat, customerName, orderDisplayId);

  // Duration & Traffic calculations
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
  const expiryMs = Date.now() + (days * 24 * 60 * 60 * 1000);

  let totalBytes = 0;
  const combinedPlanStr = `${extra.packageType || ''} ${packageName || ''} ${extra.plan || ''} ${extra.traffic || ''}`.toLowerCase();
  if (combinedPlanStr.includes('100gb') || combinedPlanStr.includes('100 gb') || combinedPlanStr.includes('100')) {
    totalBytes = 100 * 1024 * 1024 * 1024;
  }

  let uuid = crypto.randomUUID();
  let subId = crypto.randomBytes(12).toString('hex');

  // Fetch inbound info from 3X-UI
  const inbounds = await getInbounds();
  const inbound = inbounds.find((i: any) => Number(i.id) === inboundId) || {
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

  const security = streamObj.security || 'none';
  let flow = '';
  if (security === 'reality') {
    const reality = streamObj.realitySettings || streamObj.realitySettings?.settings || {};
    const settings = reality.settings || reality;
    flow = template.flow || settings.flow || reality.flow || 'xtls-rprx-vision';
  } else {
    flow = template.flow || '';
  }

  // Step 2: Create or reuse the 3X-UI client (Do NOT stop if client already exists)
  try {
    await add3XUiClient(inboundId, {
      uuid,
      email: remark,
      totalBytes,
      expiryMs,
      subId,
      flow
    });
    console.log(`[3X-UI Provisioning] Client '${remark}' created successfully on 3X-UI server.`);
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
      console.log(`[3X-UI Provisioning] Client '${remark}' already exists on 3X-UI. Reusing existing client...`);
      const existingClient = await getClientByEmail(remark);
      if (existingClient) {
        console.log(`[3X-UI Provisioning] Found existing 3X-UI client: email=${existingClient.email}, uuid=${existingClient.uuid}`);
        if (existingClient.uuid) uuid = existingClient.uuid;
        if (existingClient.subId) subId = existingClient.subId;
      } else {
        console.warn(`[3X-UI Provisioning] 3X-UI returned duplicate but search returned null. Continuing with generated UUID '${uuid}'.`);
      }
    } else {
      console.error('[3X-UI Provisioning] Failed to create 3X-UI client:', addErr);
      throw addErr;
    }
  }

  // Step 3: Generate the VLESS URL and subscription URL
  const vlessUrl = buildVlessLink(inbound, address, sni, uuid, remark);
  const subscriptionUrl = vlessUrl;

  const isValidUuid = (val: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val || '');
  const validUserId = isValidUuid(customerId) ? customerId : (isValidUuid(order.customer_id) ? order.customer_id : null);

  // Step 4: Upsert vpn_accounts
  console.log(`[3X-UI Provisioning DB] Step 4: Upserting vpn_accounts for order ${order.id}...`);
  let vpnAccountId = '';
  let existingAcc: any = null;
  if (order.id) {
    const { data: d1, error: e1 } = await dbClient.from('vpn_accounts').select('id').eq('order_id', order.id).maybeSingle();
    if (e1) console.warn('[3X-UI Provisioning DB] vpn_accounts select by order_id notice:', e1);
    existingAcc = d1;
  }
  if (!existingAcc && uuid) {
    const { data: d2, error: e2 } = await dbClient.from('vpn_accounts').select('id').eq('uuid', uuid).maybeSingle();
    if (e2) console.warn('[3X-UI Provisioning DB] vpn_accounts select by uuid notice:', e2);
    existingAcc = d2;
  }

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
    updated_at: new Date().toISOString()
  };

  let accErr: any = null;
  if (existingAcc && existingAcc.id) {
    vpnAccountId = existingAcc.id;
    let { error } = await dbClient.from('vpn_accounts').update(accPayload).eq('id', existingAcc.id);
    if (error && (error.code === 'PGRST204' || error.message?.includes('column'))) {
      console.warn('[3X-UI Provisioning DB] Retrying vpn_accounts update without subscription_url');
      delete accPayload.subscription_url;
      const { error: retryErr } = await dbClient.from('vpn_accounts').update(accPayload).eq('id', existingAcc.id);
      error = retryErr;
    }
    accErr = error;
  } else {
    let { data: newAcc, error } = await dbClient.from('vpn_accounts').insert({
      ...accPayload,
      created_at: new Date().toISOString()
    }).select('id').maybeSingle();

    if (error && (error.code === 'PGRST204' || error.message?.includes('column'))) {
      console.warn('[3X-UI Provisioning DB] Retrying vpn_accounts insert without subscription_url');
      delete accPayload.subscription_url;
      const { data: newAcc2, error: retryErr } = await dbClient.from('vpn_accounts').insert({
        ...accPayload,
        created_at: new Date().toISOString()
      }).select('id').maybeSingle();
      newAcc = newAcc2;
      error = retryErr;
    }
    accErr = error;
    vpnAccountId = newAcc?.id || vpnAccountId;
  }

  if (accErr) {
    console.error("[3X-UI Provisioning DB] Error updating table 'vpn_accounts':", accErr);
    throw new Error(`Database update failed for table 'vpn_accounts': ${accErr.message || JSON.stringify(accErr)}`);
  } else {
    console.log(`[3X-UI Provisioning DB] vpn_accounts updated successfully for order ${order.id}.`);
  }

  // Step 5: Upsert vpn_configs
  console.log(`[3X-UI Provisioning DB] Step 5: Upserting vpn_configs for order ${order.id}...`);
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
    traffic_limit: totalBytes > 0 ? `${totalBytes / (1024 * 1024 * 1024)}GB` : 'Unlimited',
    expiry_time: new Date(expiryMs).toISOString(),
    enabled: true,
    status: 'active'
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
  } else {
    console.log(`[3X-UI Provisioning DB] vpn_configs updated successfully for order ${order.id}.`);
  }

  // Step 6: Update orders (payment_status='Paid', status='completed', provisioning_status='completed')
  console.log(`[3X-UI Provisioning DB] Step 6: Updating orders table for order ${order.id}...`);
  const ordersPayload: any = {
    payment_status: 'Paid',
    status: 'completed',
    provisioning_status: 'completed',
    client_uuid: uuid,
    vless_url: vlessUrl,
    subscription_url: subscriptionUrl,
    expiry_date: new Date(expiryMs).toISOString(),
    updated_at: new Date().toISOString()
  };

  let { error: orderUpdateErr } = await dbClient.from('orders').update(ordersPayload).eq('id', order.id);

  if (orderUpdateErr && (orderUpdateErr.code === 'PGRST204' || orderUpdateErr.message?.includes('column'))) {
    console.warn("[3X-UI Provisioning DB] Column missing on 'orders', retrying update without provisioning_status / subscription_url");
    delete ordersPayload.provisioning_status;
    delete ordersPayload.subscription_url;
    const { error: retryErr } = await dbClient.from('orders').update(ordersPayload).eq('id', order.id);
    orderUpdateErr = retryErr;
  }

  if (orderUpdateErr) {
    console.error("[3X-UI Provisioning DB] Error updating table 'orders':", orderUpdateErr);
    throw new Error(`Database update failed for table 'orders': ${orderUpdateErr.message || JSON.stringify(orderUpdateErr)}`);
  } else {
    console.log(`[3X-UI Provisioning DB] orders table updated successfully for order ${order.id} (status='completed', payment_status='Paid').`);
  }

  // Step 7: Create customer notification in notifications table
  console.log(`[3X-UI Provisioning DB] Step 7: Creating notification for user ${order.email}...`);
  try {
    const notif = await createCustomerNotification({
      userId: validUserId,
      userEmail: order.email,
      title: 'VPN Activated',
      message: 'Your VPN has been created successfully and is ready to use.',
      type: 'activation',
      orderId: order.id
    });
    console.log(`[3X-UI Provisioning DB] Customer notification result:`, notif ? 'Created' : 'Logged warning');
  } catch (notifErr) {
    console.warn('[3X-UI Provisioning DB] Customer notification warning:', notifErr);
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
    message: 'VPN client provisioned and order completed successfully',
    orderId: order.order_id || order.id,
    uuid,
    vlessUrl,
    subscriptionUrl,
    vpnAccountId
  };
};


