const fs = require('fs');

const code = `import axios, { AxiosRequestConfig, AxiosError, AxiosResponse } from 'axios';
import { adminDb } from '../../config/firebaseAdmin.js';
import { VPNClient } from '../../types/models.js';

let sessionCookie = '';
let currentPanelUrl = '';

const getXuiConfig = async () => {
  const doc = await adminDb.collection('settings').doc('xui').get();
  if (!doc.exists) {
    throw new Error('3X-UI settings not configured in Firestore');
  }
  return doc.data();
};

const getBasePath = (url) => {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return path.endsWith('/') ? path.slice(0, -1) : path;
  } catch (e) {
    return '';
  }
};

const getBaseUrl = (url) => {
  try {
    const parsed = new URL(url);
    return \`\${parsed.protocol}//\${parsed.host}\`;
  } catch (e) {
    return url;
  }
};

export const login = async (force = false) => {
  try {
    const config = await getXuiConfig();
    const baseUrl = getBaseUrl(config.panelUrl);
    const basePath = getBasePath(config.panelUrl);
    
    if (!force && sessionCookie && currentPanelUrl === baseUrl) {
      return sessionCookie;
    }

    const response = await axios.post(\`\${baseUrl}\${basePath}/login\`, {
      username: config.username,
      password: config.password
    }, {
      timeout: 15000
    });
        
    if (response.data && response.data.success === false) {
       console.warn(\`[XUI Service] Login returned false success: \${response.data.msg}\`);
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
  } catch (error) {
    console.error('[XUI Service] Login failed:', error.message || error);
    throw new Error('3X-UI Login failed');
  }
};

const requestWithAuth = async (configOptions) => {
  const settings = await getXuiConfig();
  const baseUrl = getBaseUrl(settings.panelUrl);
  
  if (!sessionCookie || currentPanelUrl !== baseUrl) await login();
  
  try {
    const res = await axios.request({
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
       return axios.request({
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
  } catch (error) {
    if (error instanceof AxiosError) {
      if (error.response?.status === 401 || error.response?.status === 403) {
        console.log('[XUI Service] Session invalid (401/403), re-authenticating...');
        await login(true);
        return axios.request({
          ...configOptions,
          baseURL: baseUrl,
          headers: {
            ...configOptions.headers,
            Cookie: sessionCookie
          },
          timeout: 15000
        });
      }
      console.error(\`[XUI Service] Request to \${configOptions.url} failed: \${error.message}\`);
    }
    throw error;
  }
};

export const getInbounds = async () => {
  try {
    const config = await getXuiConfig();
    const basePath = getBasePath(config.panelUrl);
    const response = await requestWithAuth({
       url: \`\${basePath}/panel/api/inbounds/list\`,
       method: 'GET'
     });
    return response.data.obj || [];
  } catch (error) {
    console.error('[XUI Service] Failed to retrieve inbounds:', error.message);
    return [];
  }
};

export const getClientByEmail = async (email) => {
  try {
    const inbounds = await getInbounds();
        
    for (const inbound of inbounds) {
      let settingsObj = {};
      try {
        if (inbound.settings) {
          settingsObj = JSON.parse(inbound.settings);
        }
      } catch (parseError) {
        console.warn(\`[XUI Service] Failed to parse settings for inbound ID: \${inbound.id}\`);
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
            subId: c.subId || ''
          };
        }
      }
    }
    return null;
  } catch (error) {
    console.error(\`[XUI Service] Error looking up client by email (\${email}):\`, error);
    return null;
  }
};

export const getSystemStatus = async () => {
  try {
    const config = await getXuiConfig();
    const basePath = getBasePath(config.panelUrl);
    const response = await requestWithAuth({
       url: \`\${basePath}/server/status\`,
       method: 'GET'
     });
    return response.data.obj || {};
  } catch (error) {
    console.error('[XUI Service] Failed to retrieve system status:', error.message);
    return {};
  }
};

export const getTrafficUsage = async (email) => {
  const client = await getClientByEmail(email);
  if (!client) return null;
  return {
    up: client.upload,
    down: client.download,
    total: client.totalTraffic
  };
};

export const getSubscriptionUriHelper = async (email) => {
  const client = await getClientByEmail(email);
  if (!client || !client.subId) return null;
  const config = await getXuiConfig();
  const baseUrl = getBaseUrl(config.panelUrl);
  const basePath = getBasePath(config.panelUrl);
  return \`\${baseUrl}\${basePath}/sub/\${client.subId}\`;
};

export const getClientExpiry = async (email) => {
  const client = await getClientByEmail(email);
  if (!client) return null;
  return client.expiryTime;
};
`;

fs.writeFileSync('backend/src/api/services/xuiService.ts', code);
console.log('Rewrote backend/src/api/services/xuiService.ts');
