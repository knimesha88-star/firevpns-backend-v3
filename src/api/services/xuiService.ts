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

const requestApi = async <T>(endpoint: string, method: 'GET' | 'POST' = 'GET', data?: any): Promise<T> => {
  const config = await getXuiConfig();
  
  // The frontend stores the token in the password field, or fallback to apiToken if provided
  const token = config.apiToken || config.password;
  if (!token) {
    throw new Error('API token is missing in 3X-UI settings');
  }

  const { baseUrl, basePath } = parseUrl(config.panelUrl);
  const client = createAxiosInstance(baseUrl);

  console.log(`[XUI API] ${method} ${baseUrl}${basePath}${endpoint}`);
  
  const response = await client.request({
    url: `${basePath}${endpoint}`,
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
};

export const testApiConnection = async (config: XuiConfig): Promise<boolean> => {
  const token = config.apiToken || config.password;
  if (!token) {
    throw new Error('API token is missing');
  }

  const { baseUrl, basePath } = parseUrl(config.panelUrl);
  const client = createAxiosInstance(baseUrl);

  console.log(`[XUI API] Testing connection with GET ${baseUrl}${basePath}/panel/api/inbounds/list`);
  
  const response = await client.request({
    url: `${basePath}/panel/api/inbounds/list`,
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

export const formatClientRemark = (templateFormat: string, customerName: string): string => {
  const name = (customerName || '').trim() || 'Customer';
  const format = templateFormat || '{{customerName}}';
  return format.replace(/\{\{\s*customerName\s*\}\}/g, name);
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

  if (network === 'ws') {
    const ws = streamObj.wsSettings || {};
    if (ws.path) params.set('path', ws.path);
    if (ws.headers && ws.headers.Host) params.set('host', ws.headers.Host);
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
  }
): Promise<any> => {
  const clientPayload = {
    id: clientData.uuid,
    alterId: 0,
    email: clientData.email,
    limitIp: 1,
    totalGB: clientData.totalBytes,
    expiryTime: clientData.expiryMs,
    enable: true,
    tgId: '',
    subId: clientData.subId
  };

  const body = {
    id: inboundId,
    settings: JSON.stringify({
      clients: [clientPayload]
    })
  };

  console.log(JSON.stringify(body, null, 2));

  const res = await requestApi<any>('/panel/api/inbounds/addClient', 'POST', body);
  console.log("");
  console.log("3X-UI Response:", typeof res === 'object' ? JSON.stringify(res, null, 2) : res);
  return res;
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

  console.log("==============================");
  console.log("FIREVPNs Provisioning Started");
  console.log("==============================");
  console.log("");
  console.log(`Order ID: ${order.orderId || orderSnap.id}`);
  console.log(`Package: ${packageName}`);
  console.log(`Customer Name: ${customerName}`);
  console.log(`Customer UID: ${customerId || 'N/A'}`);
  console.log("");
  console.log("Searching Firestore template...");

  if (!packageName) {
    throw new Error('Provisioning template not found.');
  }

  // 2. Query Firestore for template
  const template = await findProvisioningTemplate(packageName);
  if (!template) {
    throw new Error('Provisioning template not found.');
  }

  // 3. Extract template values
  const inboundId = Number(template.inboundId) || 1;
  const address = template.address || '';
  const sni = template.sni || '';
  const remarkFormat = template.remarkTemplate || template.remarkFormat || '{{customerName}}';

  console.log("");
  console.log("Template Found");
  console.log("");
  console.log(`Package: ${template.packageName || packageName}`);
  console.log(`Inbound ID: ${inboundId}`);
  console.log(`Address: ${address}`);
  console.log(`SNI: ${sni}`);
  console.log(`Remark Template: ${remarkFormat}`);

  const remark = formatClientRemark(remarkFormat, customerName);

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

  // Traffic
  let totalBytes = 0; // Default unlimited
  if (template.trafficProfiles) {
    const planKey = Object.keys(template.trafficProfiles).find(
      k => k.toLowerCase() === String(order.plan || '').toLowerCase() || k.toLowerCase() === String(order.packageType || '').toLowerCase()
    );
    if (planKey && template.trafficProfiles[planKey] > 0) {
      totalBytes = template.trafficProfiles[planKey] * 1024 * 1024 * 1024;
    }
  }

  const trafficLimitStr = totalBytes > 0 ? `${totalBytes / (1024 * 1024 * 1024)}GB` : 'Unlimited';

  console.log("");
  console.log(`Generated Client Remark: ${remark}`);
  console.log("");
  console.log(`Generated Traffic Limit: ${trafficLimitStr}`);
  console.log("");
  console.log(`Generated Expiry: ${new Date(expiryMs).toISOString()}`);
  console.log("");
  console.log("Creating client in 3X-UI...");

  // Generate UUID & subId
  const uuid = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 10) + '-' + Math.random().toString(36).substring(2, 6) + '-' + Math.random().toString(36).substring(2, 6);
  const subId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 10);

  // 5. Create client on 3X-UI panel
  try {
    await add3XUiClient(inboundId, {
      uuid,
      email: remark,
      totalBytes,
      expiryMs,
      subId
    });
  } catch (xuiErr: any) {
    console.log("");
    console.log("3X-UI Error:", xuiErr?.response?.data || xuiErr?.message || xuiErr);
    console.warn(`[3X-UI Provisioning] Panel client add warning/error: ${xuiErr.message}. Proceeding with VLESS link generation.`);
  }

  // 6. Fetch inbound info from 3X-UI to construct VLESS link
  const inbounds = await getInbounds();
  const inbound = inbounds.find((i: any) => Number(i.id) === inboundId) || {
    id: inboundId,
    port: 443,
    protocol: 'vless',
    streamSettings: JSON.stringify({ network: 'tcp', security: 'reality' })
  };

  // 7. Generate VLESS link using template address & SNI, plus inbound settings
  const vlessUrl = buildVlessLink(inbound, address, sni, uuid, remark);

  console.log("");
  console.log("Client Created Successfully");
  console.log("");
  console.log(`UUID: ${uuid}`);
  console.log("");
  console.log(`Subscription URL: ${vlessUrl}`);

  // 8. Update Firestore subcollection & order document
  let configDocId = '';

  if (customerId) {
    try {
      const vpnConfigRef = await adminDb.collection('users').doc(customerId).collection('vpnConfigs').add({
        orderId: order.orderId || orderSnap.id,
        uuid,
        email: order.email || '',
        uid: customerId,
        package: packageName,
        packageType: order.packageType || 'SIM Unlimited',
        server: template.server || order.server || 'Singapore',
        duration: duration,
        subscriptionUrl: vlessUrl,
        vlessUrl: vlessUrl,
        inboundId: inboundId,
        trafficLimit: totalBytes > 0 ? `${totalBytes / (1024 * 1024 * 1024)}GB` : 'Unlimited',
        expiryDate: new Date(expiryMs).toISOString(),
        status: 'Active',
        createdAt: FieldValue.serverTimestamp()
      });
      configDocId = vpnConfigRef.id;
    } catch (docErr) {
      console.error('[3X-UI Provisioning] Failed to create vpnConfigs subcollection doc:', docErr);
    }
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

