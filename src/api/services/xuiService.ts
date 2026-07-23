import axios, { AxiosInstance, AxiosError } from 'axios';
import { adminDb } from '../../config/firebaseAdmin.js';
import { FieldValue } from 'firebase-admin/firestore';
import { sendOrderApprovedNotification } from './telegramService.js';
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
        const newExpiryTime = date.getTime();
        
        await requestApi<any>(`/panel/api/clients/update/${c.email}`, 'POST', {
          ...c,
          id: String(c.id),
          email: c.email,
          expiryTime: newExpiryTime
        });
        
        return newExpiryTime;
      }
    }
  }
  
  throw new Error(`Client with email ${email} not found in 3X-UI inbounds`);
};

export const findProvisioningTemplate = async (packageName: string): Promise<any | null> => {
  if (!packageName) return null;
  const targetName = packageName.trim().toLowerCase();

  const collectionsToCheck = ['provisionTemplates', 'provisioningTemplates'];

  for (const colName of collectionsToCheck) {
    try {
      const snapshot = await adminDb.collection(colName).get();
      for (const docSnap of snapshot.docs) {
        const data = docSnap.data();
        const enabled = data.enabled !== false;
        const docPackageName = String(data.packageName || data.name || docSnap.id).trim().toLowerCase();

        if (enabled && (docPackageName === targetName || docPackageName === targetName.replace(/_/g, ' '))) {
          return { id: docSnap.id, ...data };
        }
      }
    } catch (e) {
      console.warn(`[3X-UI Service] Error checking ${colName}:`, e);
    }
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

export const provisionOrderClient = async (orderId: string): Promise<any> => {
  // 1. Fetch order document from Firestore
  let orderRef = adminDb.collection('orders').doc(orderId);
  let orderSnap = await orderRef.get();

  if (!orderSnap.exists) {
    const querySnap = await adminDb.collection('orders').where('orderId', '==', orderId).limit(1).get();
    if (querySnap.empty) {
      throw new Error('Provisioning template not found.');
    }
    orderSnap = querySnap.docs[0];
    orderRef = orderSnap.ref;
  }

  const order = orderSnap.data() || {};
  const packageName = order.packageName || order.plan || order.package || '';
  const customerName = order.configurationName || order.customerName || order.name || order.fullName || (order.email ? order.email.split('@')[0] : 'Customer');
  const customerId = order.customerId || order.uid || order.userId || '';

  console.log("==================================================");
  console.log("TEMPLATE LOOKUP START");
  console.log("==================================================");
  console.log("Order ID:", order.orderId || orderSnap.id);
  console.log("Customer Email:", order.email);
  console.log("Customer Name:", customerName);
  console.log("order.package:", order.package);
  console.log("order.packageName:", order.packageName);
  console.log("order.plan:", order.plan);
  console.log("order.category:", order.category);
  console.log("order.server:", order.server);
  console.log("");
  console.log("Searching collection: provisionTemplates");

  let matchingDocs: any[] = [];
  try {
    const provSnap = await adminDb.collection('provisionTemplates').get();
    const targetName = packageName.trim().toLowerCase();

    for (const docSnap of provSnap.docs) {
      const data = docSnap.data();
      const enabled = data.enabled !== false;
      const docPackageName = String(data.packageName || data.name || docSnap.id).trim().toLowerCase();

      if (enabled && (docPackageName === targetName || docPackageName === targetName.replace(/_/g, ' '))) {
        matchingDocs.push({ id: docSnap.id, ...data });
      }
    }

    console.log("Number of matching templates:", matchingDocs.length);

    if (matchingDocs.length > 0) {
      matchingDocs.forEach(t => {
        console.log("Document ID:", t.id);
        console.log("packageName:", t.packageName || t.name);
        console.log("enabled:", t.enabled !== false);
        console.log("category:", t.category);
        console.log("server:", t.server);
        console.log("inboundId:", t.inboundId);
        console.log("address:", t.address);
        console.log("sni:", t.sni);
        console.log("remarkTemplate:", t.remarkTemplate || t.remarkFormat);
      });
    } else {
      console.log("No matching template found. Fetching ALL documents from provisionTemplates collection:");
      for (const docSnap of provSnap.docs) {
        const data = docSnap.data();
        console.log("Document ID:", docSnap.id);
        console.log("packageName:", data.packageName || data.name);
        console.log("enabled:", data.enabled !== false);
        console.log("category:", data.category);
        console.log("server:", data.server);
      }
    }
  } catch (err) {
    console.error("Error debugging provisionTemplates collection:", err);
  }

  if (!packageName) {
    throw new Error('Provisioning template not found.');
  }

  // 2. Query Firestore for template
  const template = await findProvisioningTemplate(packageName);
  if (!template) {
    throw new Error('Provisioning template not found.');
  }

  console.log("========== TEMPLATE ==========");
  console.log(template);
  console.log("Package:", order.packageName);
  console.log("Inbound:", template.inboundId);
  console.log("Address:", template.address);
  console.log("SNI:", template.sni);
  console.log("Remark Template:", template.remarkTemplate);
  console.log("==============================");

  // 3. Extract template values & format unique remark
  const inboundId = Number(template.inboundId) || 1;
  const address = template.address || '';
  const sni = template.sni || '';
  const remarkFormat = template.remarkTemplate || template.remarkFormat || '{{customerName}}';

  const orderDisplayId = (order.orderId || orderSnap.id || '').trim();
  const remark = formatClientRemark(remarkFormat, customerName, orderDisplayId);

  // 4. Calculate duration & traffic
  const duration = order.duration || '1 Month';
  let days = 30;
  if (template.durationProfiles && template.durationProfiles[duration]) {
    days = Number(template.durationProfiles[duration]);
  } else {
    const numMatch = String(duration).match(/(\d+)/);
    if (numMatch) {
      const num = parseInt(numMatch[1], 10);
      if (String(duration).toLowerCase().includes('month')) {
        days = num * 30;
      } else {
        days = num;
      }
    }
  }
  const expiryMs = Date.now() + (days * 24 * 60 * 60 * 1000);

  // Traffic plan (Only two plans: 100 GB = 100 * 1024 * 1024 * 1024 bytes, Unlimited = 0 bytes)
  let totalBytes = 0; // Default Unlimited (0)
  const combinedPlanStr = `${order.packageType || ''} ${packageName || ''} ${order.plan || ''} ${order.packageOption || ''} ${order.traffic || ''}`.toLowerCase();

  const is100GB = combinedPlanStr.includes('100gb') || combinedPlanStr.includes('100 gb') || combinedPlanStr.includes('100');

  if (is100GB) {
    totalBytes = 100 * 1024 * 1024 * 1024;
  } else {
    totalBytes = 0;
  }

  const trafficLimitStr = totalBytes > 0 ? `${totalBytes / (1024 * 1024 * 1024)}GB` : 'Unlimited';

  // 1. client.id: Fresh UUID v4 for every request
  const uuid = crypto.randomUUID();

  // 2. client.subId: Fresh random subId for every request
  const subId = crypto.randomBytes(12).toString('hex');

  // Fetch inbound info from 3X-UI to determine 4. client.flow and build VLESS link
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

  const network = streamObj.network || 'tcp';
  const security = streamObj.security || 'none';

  // 4. client.flow: Determined flow for client
  let flow = '';
  if (security === 'reality') {
    const reality = streamObj.realitySettings || streamObj.realitySettings?.settings || {};
    const settings = reality.settings || reality;
    flow = template.flow || settings.flow || reality.flow || 'xtls-rprx-vision';
  } else {
    flow = template.flow || '';
  }

  console.log("==================================================");
  console.log("[3X-UI Provisioning] GENERATED VALUES FOR NEW CLIENT:");
  console.log(`1. client.id (UUID v4): ${uuid}`);
  console.log(`2. client.subId: ${subId}`);
  console.log(`3. client.email (remark): ${remark}`);
  console.log(`4. client.flow: ${flow}`);
  console.log("==================================================");

  const trafficPlan = is100GB ? "100GB" : "Unlimited";
  const totalGB = totalBytes;
  const client = {
    id: uuid,
    email: remark,
    totalGB: totalGB,
    expiryTime: expiryMs,
    enable: true,
    subId: subId,
    flow: flow
  };

  console.log("Package:", packageName);
  console.log("Traffic Plan:", trafficPlan);
  console.log("Calculated totalGB:", totalGB);
  console.log("Client Payload:", client);

  // 5. Create client on 3X-UI panel
  await add3XUiClient(inboundId, {
    uuid,
    email: remark,
    totalBytes,
    expiryMs,
    subId,
    flow
  });

  // 6. Generate VLESS link using template address & SNI, plus inbound settings
  const vlessUrl = buildVlessLink(inbound, address, sni, uuid, remark);

  console.log("");
  console.log("Client Created Successfully");
  console.log("");
  console.log(`UUID: ${uuid}`);
  console.log("");
  console.log(`Subscription URL: ${vlessUrl}`);

  // 8. Save VPN configuration in Firestore under users/{customerUid}/vpnConfigs/{vpnId}
  let configDocId = '';
  const customerUid = customerId || order.customerId || order.uid || order.userId || '';

  if (!customerUid) {
    const errorMsg = 'Customer UID is missing for this order. Cannot save VPN configuration.';
    console.error('[3X-UI Provisioning]', errorMsg);
    throw new Error(errorMsg);
  }

  try {
    const vpnConfigRef = await adminDb.collection('users').doc(customerUid).collection('vpnConfigs').add({
      orderId: order.orderId || orderSnap.id,
      packageName: packageName,
      package: packageName,
      packageType: order.packageType || 'SIM Unlimited',
      configName: order.configurationName || customerName,
      uuid: uuid,
      subscriptionUrl: vlessUrl,
      vlessUrl: vlessUrl,
      serverAddress: address,
      server: template.server || order.server || 'Singapore',
      sni: sni,
      inboundId: inboundId,
      trafficLimit: trafficLimitStr,
      expiryTime: new Date(expiryMs).toISOString(),
      expiryDate: new Date(expiryMs).toISOString(),
      enabled: true,
      status: 'Active',
      createdAt: FieldValue.serverTimestamp()
    });
    configDocId = vpnConfigRef.id;
  } catch (docErr: any) {
    const errorDetails = docErr?.message || String(docErr);
    console.error('[3X-UI Provisioning] Failed to save VPN configuration in Firestore:', docErr);
    throw new Error(`Failed to save VPN configuration in Firestore: ${errorDetails}`);
  }

  await orderRef.update({
    paymentStatus: 'Approved',
    provisioningStatus: 'Completed',
    configId: configDocId || undefined,
    vpnCredentials: {
      username: remark,
      password: uuid,
      configLink: vlessUrl,
      qrcodeData: vlessUrl,
      subId: subId,
      inboundId: inboundId
    },
    approvedAt: FieldValue.serverTimestamp()
  });

  // 9. Send Telegram notification
  try {
    await sendOrderApprovedNotification({
      customerEmail: order.email || 'N/A',
      packageName: packageName,
      packageType: order.packageType || 'SIM Unlimited',
      server: template.server || order.server || 'Singapore',
      duration: duration,
      price: order.amount || 0,
      uuid: uuid,
      orderId: order.orderId || orderSnap.id,
      status: '🟢 COMPLETED'
    });
  } catch (tgErr) {
    console.warn('[3X-UI Provisioning] Telegram notification error:', tgErr);
  }

  return {
    success: true,
    orderId: order.orderId || orderSnap.id,
    uuid,
    vlessUrl,
    remark,
    inboundId
  };
};

