import axios, { AxiosInstance, AxiosError } from 'axios';
import { supabase, supabaseAdmin, getSupabaseClient } from '../../lib/supabase.js';
import { sendOrderApprovedNotification } from './telegramService.js';
import { createCustomerNotification, runScheduledExpiryEmailCheck } from './notificationService.js';
import { sendPaymentApprovedEmail, sendOrderCompletedEmail, sendTrialApprovedEmail, sendVpnExpiredEmail } from './emailService.js';

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

// Global in-memory cache and state for 3X-UI inbounds metadata
export let cachedInbounds: XuiInbound[] = [];
export let lastInboundsCacheTime = 0;
export let isCacheRefreshing = false;

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

let cachedXuiConfig: { config: XuiConfig; expiresAt: number } | null = null;
const XUI_CONFIG_TTL_MS = 60 * 1000;

let cachedXuiAuth: { panelUrl: string; headers: Record<string, string>; expiresAt: number } | null = null;
const XUI_AUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes (3X-UI session cookie lasts 6 hours)

export const invalidateXuiConfigCache = (): void => {
  cachedXuiConfig = null;
  cachedXuiAuth = null;
};

/**
 * Validates that a 3X-UI panel URL uses http/https and does not target
 * cloud metadata services or loopback interfaces (SSRF protection).
 */
export const validateXuiPanelUrl = (urlStr: string): string => {
  const trimmed = String(urlStr || '').trim();
  if (!trimmed) {
    throw new Error('3X-UI Panel URL is required.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid 3X-UI Panel URL format.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('3X-UI Panel URL must use http:// or https://.');
  }

  const host = parsed.hostname.toLowerCase();
  const isMetadataOrLoopback =
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    host.startsWith('127.') ||
    host.startsWith('169.254.') ||
    host === 'metadata.google.internal' ||
    host.endsWith('.internal');

  if (isMetadataOrLoopback && process.env.XUI_ALLOW_PRIVATE_URLS !== 'true') {
    throw new Error('3X-UI Panel URL cannot target localhost or cloud metadata addresses.');
  }

  return trimmed;
};

/**
 * Computes a deterministic, opaque 3X-UI panel identity fingerprint from the
 * configured 3X-UI panel URL (normalized scheme + host + explicit/default port + base path).
 * Never derives panel identity from VLESS hostnames, CDN domains, SNI, or server display names.
 */
export const computePanelIdentity = (panelUrl: string): string => {
  const trimmed = String(panelUrl || '').trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  const protocol = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port || (protocol === 'https:' ? '443' : '80');
  let basePath = parsed.pathname.replace(/\/+$/, '');
  if (basePath.endsWith('/panel')) {
    basePath = basePath.slice(0, -6);
  }
  const canonical = `${protocol}//${hostname}:${port}${basePath}`;
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  return `panel:${hash}`;
};

export const getCurrentPanelIdentity = async (forceRefresh = false): Promise<string> => {
  const cfg = await getXuiConfig(forceRefresh);
  return computePanelIdentity(cfg.panelUrl);
};

export const getXuiConfig = async (forceRefresh = false): Promise<XuiConfig> => {
  const now = Date.now();
  if (!forceRefresh && cachedXuiConfig && cachedXuiConfig.expiresAt > now) {
    return cachedXuiConfig.config;
  }

  const db = supabaseAdmin || supabase;
  const { data: doc } = await db.from('settings').select('*').eq('id', 'xui').maybeSingle();
  const data = (doc && typeof doc.data === 'object' ? doc.data : {}) as Record<string, any>;

  const panelUrl = String(data.panelUrl || process.env.XUI_PANEL_URL || '').trim();
  const username = String(data.username || process.env.XUI_USERNAME || 'admin').trim();
  const password = String(
    data.password ||
      data.apiToken ||
      process.env.XUI_PASSWORD ||
      process.env.XUI_API_TOKEN ||
      ''
  ).trim();
  const apiToken = String(data.apiToken || process.env.XUI_API_TOKEN || password).trim();

  if (!panelUrl) {
    throw new Error('3X-UI settings not configured');
  }

  const config: XuiConfig = {
    panelUrl,
    username,
    password,
    apiToken,
    panelName: String(data.panelName || 'Primary Node'),
  };

  cachedXuiConfig = { config, expiresAt: now + XUI_CONFIG_TTL_MS };
  return config;
};

export const getMaskedXuiSettings = async (): Promise<{
  panelUrl: string;
  username: string;
  panelName: string;
  hasPassword: boolean;
  status: 'connected' | 'disconnected';
  lastSync: string | null;
}> => {
  const db = supabaseAdmin || supabase;
  const { data: doc } = await db.from('settings').select('*').eq('id', 'xui').maybeSingle();
  const data = (doc && typeof doc.data === 'object' ? doc.data : {}) as Record<string, any>;

  const panelUrl = String(data.panelUrl || process.env.XUI_PANEL_URL || '').trim();
  const username = String(data.username || process.env.XUI_USERNAME || '').trim();
  const hasPassword = Boolean(
    data.password || data.apiToken || process.env.XUI_PASSWORD || process.env.XUI_API_TOKEN
  );

  return {
    panelUrl,
    username,
    panelName: String(data.panelName || 'Primary Node'),
    hasPassword,
    status: data.status === 'connected' ? 'connected' : 'disconnected',
    lastSync: data.lastSync || null,
  };
};

const parseUrl = (urlStr: string) => {
  try {
    const validated = validateXuiPanelUrl(urlStr);
    const parsed = new URL(validated);
    const baseUrl = `${parsed.protocol}//${parsed.host}`;
    const basePath = parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;
    return { baseUrl, basePath };
  } catch (e: any) {
    throw new Error(e?.message || `Invalid Panel URL`);
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
  } else {
    console.error("No HTTP response received from 3X-UI");
  }
};

// Enforce TLS certificate verification by default.
// Only allow self-signed certificates when explicitly opted in via XUI_ALLOW_INSECURE_TLS=true.
const allowInsecureTls = process.env.XUI_ALLOW_INSECURE_TLS === 'true';
if (allowInsecureTls) {
  console.warn('[xuiService] WARNING: XUI_ALLOW_INSECURE_TLS=true is enabled. Use a valid TLS certificate in production.');
}
const sharedHttpsAgent = new https.Agent({
  rejectUnauthorized: !allowInsecureTls,
  keepAlive: true,
});

const createAxiosInstance = (baseUrl: string, timeoutMs: number = 10000) => {
  return axios.create({
    baseURL: baseUrl,
    timeout: timeoutMs,
    httpsAgent: sharedHttpsAgent,
    validateStatus: (status) => status < 500
  });
};

const getXuiAuthHeaders = async (config: XuiConfig, forceRefresh = false): Promise<Record<string, string>> => {
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedXuiAuth &&
    cachedXuiAuth.panelUrl === config.panelUrl &&
    cachedXuiAuth.expiresAt > now
  ) {
    return { ...cachedXuiAuth.headers };
  }

  const username = config.username || 'admin';
  const password = config.password || config.apiToken;
  
  if (!password) {
    throw new Error('API token or password is missing in 3X-UI settings');
  }

  const { baseUrl } = parseUrl(config.panelUrl);
  const client = createAxiosInstance(baseUrl, 6000);

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'X-Requested-With': 'XMLHttpRequest'
  };

  const loginEndpoints = ['/login', '/panel/login'];
  let cookieHeader = '';

  for (const loginEp of loginEndpoints) {
    try {
      const { fullPath } = getApiEndpointUrl(config.panelUrl, loginEp);
      const res = await client.post(
        fullPath,
        `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
        {
          headers: {
            ...headers,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );
      const setCookie = res.headers['set-cookie'];
      if (setCookie && Array.isArray(setCookie)) {
        cookieHeader = setCookie.map(c => c.split(';')[0]).join('; ');
        console.log(`[xuiService] Successfully authenticated via ${fullPath} session login`);
        break;
      }
    } catch (e: any) {
      // Continue to next login endpoint or fallback
    }
  }

  if (cookieHeader) {
    headers['Cookie'] = cookieHeader;
  }
  headers['Authorization'] = `Bearer ${password}`;

  // Fetch CSRF token if available (short 4s timeout)
  try {
    const { fullPath: csrfPath } = getApiEndpointUrl(config.panelUrl, '/csrf-token');
    const csrfRes = await client.get(csrfPath, { headers, timeout: 4000 });
    if (csrfRes.data?.obj) {
      headers['X-CSRF-Token'] = csrfRes.data.obj;
    }
    if (csrfRes.headers['set-cookie']) {
      const csrfCookie = csrfRes.headers['set-cookie'].map((c: string) => c.split(';')[0]).join('; ');
      headers['Cookie'] = headers['Cookie'] ? `${headers['Cookie']}; ${csrfCookie}` : csrfCookie;
    }
  } catch (e: any) {
    // Non-fatal if csrf endpoint fails
  }

  if (cookieHeader) {
    cachedXuiAuth = {
      panelUrl: config.panelUrl,
      headers: { ...headers },
      expiresAt: now + XUI_AUTH_TTL_MS
    };
  }

  return headers;
};

export const requestApi = async <T>(endpoint: string, method: 'GET' | 'POST' = 'GET', data?: any): Promise<T> => {
  const config = await getXuiConfig();
  let headers = await getXuiAuthHeaders(config);

  const { baseUrl, fullPath, fullUrl } = getApiEndpointUrl(config.panelUrl, endpoint);
  const client = createAxiosInstance(baseUrl, 10000);

  try {
    let response = await client.request({
      url: fullPath,
      method,
      data,
      headers
    });

    // If session cookie expired or returned 401/403/redirect, refresh auth once
    if (response.status === 401 || response.status === 403 || response.status === 302 || response.status === 307) {
      cachedXuiAuth = null;
      headers = await getXuiAuthHeaders(config, true);
      response = await client.request({
        url: fullPath,
        method,
        data,
        headers
      });
    }

    if (response.status !== 200) {
      throw new Error(`3X-UI API Error: ${response.status} ${response.statusText}`);
    }

    if (response.data && response.data.success === false) {
      throw new Error(`3X-UI API Error: ${response.data.msg}`);
    }

    return response.data.obj;
  } catch (error: any) {
    console.error(`[xuiService] [API TRANSPORT ERROR] Axios error on ${fullUrl}: ${error.message}`);
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

export const getInbounds = async (forceRefresh: boolean = false): Promise<XuiInbound[]> => {
  const now = Date.now();
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache TTL

  if (!forceRefresh && cachedInbounds.length > 0 && (now - lastInboundsCacheTime < CACHE_TTL_MS)) {
    return cachedInbounds;
  }

  // Use only the supported endpoint
  const endpoint = '/panel/api/inbounds/list';
  try {
    const inboundsData = await requestApi<XuiInbound[]>(endpoint);
    if (Array.isArray(inboundsData)) {
      setCachedInbounds(inboundsData);
      return inboundsData;
    }
    return cachedInbounds;
  } catch (error: any) {
    console.error(`[XUI Service] Failed to retrieve inbounds from ${endpoint}:`, error.message);
    return cachedInbounds;
  }
};

const LIVE_INBOUND_CACHE_TTL_MS = 10 * 1000; // 10 seconds short TTL for near-real-time status without excessive 3X-UI load
const liveInboundCache = new Map<number, { inbound: XuiInbound; fetchedAt: number }>();
const liveInboundInFlight = new Map<number, { generation: number; promise: Promise<XuiInbound | null> }>();
let liveInboundCacheGeneration = 0;

/**
 * Invalidate cached 3X-UI inbound snapshots immediately after provisioning, revocation,
 * renewal, disable, or traffic reset operations so stale Active status is never returned.
 */
export const invalidateInboundCache = (inboundId?: number | null): void => {
  liveInboundCacheGeneration += 1;
  const numericId = inboundId !== undefined && inboundId !== null ? Number(inboundId) : NaN;
  if (!Number.isNaN(numericId) && numericId > 0) {
    liveInboundCache.delete(numericId);
    liveInboundInFlight.delete(numericId);
  } else {
    liveInboundCache.clear();
    liveInboundInFlight.clear();
  }
  // Force next getInbounds() call to refresh from 3X-UI rather than serving pre-mutation metadata
  lastInboundsCacheTime = 0;
};

export const getLiveInbound = async (
  inboundId: number,
  options?: boolean | { forceRefresh?: boolean; fetcher?: (id: number) => Promise<XuiInbound | null> }
): Promise<XuiInbound | null> => {
  const normalizedId = Number(inboundId);
  if (Number.isNaN(normalizedId) || normalizedId <= 0) {
    return null;
  }

  const forceRefresh = typeof options === 'boolean' ? options : Boolean(options?.forceRefresh);
  const customFetcher = typeof options === 'object' ? options?.fetcher : undefined;
  const now = Date.now();

  if (!forceRefresh) {
    const cachedEntry = liveInboundCache.get(normalizedId);
    if (cachedEntry && now - cachedEntry.fetchedAt < LIVE_INBOUND_CACHE_TTL_MS) {
      return cachedEntry.inbound;
    }

    const inFlight = liveInboundInFlight.get(normalizedId);
    if (inFlight && inFlight.generation === liveInboundCacheGeneration) {
      return inFlight.promise;
    }
  }

  const requestGeneration = liveInboundCacheGeneration;

  const fetchPromise = (async (): Promise<XuiInbound | null> => {
    try {
      let inbound: any = null;
      if (customFetcher) {
        inbound = await customFetcher(normalizedId);
      } else {
        console.log(`[XUI Service] Fetching live inbound ${normalizedId} directly for dashboard query...`);
        const res = await requestApi<any>(`/panel/api/inbounds/get/${normalizedId}`, 'GET');
        inbound = res?.obj || res;
      }

      if (inbound && typeof inbound === 'object' && inbound.id !== undefined) {
        // Only populate cache if no invalidation occurred while this request was in-flight
        if (requestGeneration === liveInboundCacheGeneration) {
          liveInboundCache.set(normalizedId, {
            inbound: inbound as XuiInbound,
            fetchedAt: Date.now(),
          });
        }
        return inbound as XuiInbound;
      }
    } catch (err: any) {
      console.warn(`[XUI Service] Failed to fetch live inbound ${normalizedId} directly:`, err?.message || err);
    }

    // Do not retain stale cached inbound when live panel check fails
    if (requestGeneration === liveInboundCacheGeneration) {
      liveInboundCache.delete(normalizedId);
    }
    return null;
  })();

  liveInboundInFlight.set(normalizedId, {
    generation: requestGeneration,
    promise: fetchPromise,
  });

  try {
    return await fetchPromise;
  } finally {
    const currentInFlight = liveInboundInFlight.get(normalizedId);
    if (currentInFlight && currentInFlight.promise === fetchPromise) {
      liveInboundInFlight.delete(normalizedId);
    }
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
          const stat = (inbound.clientStats || []).find((s: any) => 
            (s.id && c.id && String(s.id).toLowerCase() === String(c.id).toLowerCase()) ||
            (s.email && c.email && String(s.email).toLowerCase() === String(c.email).toLowerCase())
          );
          
          let total = c.totalGB || (c as any).total || (c as any).totalBytes || 0;
          
          const extractTraffic = (obj: any, type: 'up' | 'down') => {
            if (!obj) return 0;
            const val = obj[type] || obj[`${type}load`] || 0;
            return typeof val === 'number' ? val : (parseFloat(val) || 0);
          };

          const statUp = extractTraffic(stat, 'up');
          const statDown = extractTraffic(stat, 'down');
          const clientUp = extractTraffic(c, 'up');
          const clientDown = extractTraffic(c, 'down');

          let up = Math.max(statUp, clientUp);
          let down = Math.max(statDown, clientDown);

          let remaining = 0;
          if (total > 0) {
            remaining = Math.max(total - (up + down), 0);
          }
          
          let streamSettings: any = {};
          try {
             if (inbound.streamSettings) {
                 streamSettings = typeof inbound.streamSettings === "string" ? JSON.parse(inbound.streamSettings) : inbound.streamSettings;
             }
          } catch(e) {}
          
          const config = await getXuiConfig();
          const { baseUrl } = parseUrl(config.panelUrl);
          
          let expTimeMs = c.expiryTime || 0;
          if (expTimeMs > 0 && expTimeMs < 10000000000) expTimeMs = expTimeMs * 1000;
          const isExpired = c.enable === false || (expTimeMs > 0 && expTimeMs <= Date.now()) || expTimeMs < 0;
          const isClientEnabled = c.enable !== false && !isExpired;

          return {
            email: c.email,
            uuid: c.id,
            inboundId: inbound.id,
            remark: inbound.remark,
            upload: up,
            download: down,
            upBytes: up,
            downBytes: down,
            totalTraffic: total,
            remainingTraffic: remaining,
            trafficLimit: total > 0 ? `${total / (1024 * 1024 * 1024)}GB` : 'Unlimited',
            remainingGB: total > 0 ? `${(remaining / (1024 * 1024 * 1024)).toFixed(2)}GB` : 'Unlimited',
            usedGB: parseFloat(((up + down) / (1024 * 1024 * 1024)).toFixed(2)),
            expiryTime: c.expiryTime || 0,
            enableStatus: isClientEnabled,
            onlineStatus: isClientEnabled,
            status: isClientEnabled ? 'Active' : 'Expired',
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

export const getClientExpiry = async (identifier: string): Promise<number | null> => {
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
      if (
        (c.id && String(c.id).trim().toLowerCase() === String(identifier).trim().toLowerCase()) ||
        (c.email && String(c.email).trim().toLowerCase() === String(identifier).trim().toLowerCase())
      ) {
        return c.expiryTime || null;
      }
    }
  }
  return null;
};

export const addCalendarMonths = (baseTimeMs: number, durationMonths: number): number => {
  const safeMonths = Math.max(1, Math.round(Number(durationMonths) || 1));
  const base = new Date(baseTimeMs);
  const targetYear = base.getUTCFullYear();
  const targetMonth = base.getUTCMonth() + safeMonths;
  const originalDay = base.getUTCDate();

  const result = new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      1,
      base.getUTCHours(),
      base.getUTCMinutes(),
      base.getUTCSeconds(),
      base.getUTCMilliseconds()
    )
  );
  const daysInTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, daysInTargetMonth));
  return result.getTime();
};

export interface UpdateClientExpiryDeps {
  getInboundsFn?: (forceRefresh?: boolean) => Promise<XuiInbound[]>;
  requestApiFn?: <T>(endpoint: string, method?: 'GET' | 'POST', data?: any) => Promise<T>;
  dbClient?: any;
  nowMs?: number;
}

export const updateClientExpiry = async (
  uuid: string,
  durationMonths: number,
  planName?: string,
  fallbackCurrentExpiryMs?: number | null,
  deps?: UpdateClientExpiryDeps
): Promise<{ new_expiryMs: number; newTotalBytes: number; verifiedEnable: boolean; inboundId: number }> => {
  const getInboundsFn = deps?.getInboundsFn || getInbounds;
  const requestApiFn = deps?.requestApiFn || requestApi;
  const lockDbClient = deps?.dbClient || supabaseAdmin;

  let inbounds = await getInboundsFn(true);
  if (!inbounds || inbounds.length === 0) {
    inbounds = await getInboundsFn(false);
  }

  const normalizedTargetUuid = String(uuid || '').trim().toLowerCase();

  // Locate target inbound ID first, then serialize the entire read-modify-write + read-back under inbound lock
  let locatedInboundId: number | null = null;
  for (const ib of inbounds) {
    let sObj: any = {};
    try {
      const rawSettings: any = ib.settings;
      if (rawSettings) {
        sObj = typeof rawSettings === 'string' ? JSON.parse(rawSettings) : { ...rawSettings };
      }
    } catch {
      continue;
    }
    const clientsArr = Array.isArray(sObj.clients) ? sObj.clients : [];
    if (clientsArr.some((c: any) => c.id && String(c.id).trim().toLowerCase() === normalizedTargetUuid)) {
      locatedInboundId = Number(ib.id);
      break;
    }
  }

  if (!locatedInboundId) {
    throw new Error(`Client with UUID ${uuid} not found in 3X-UI inbounds`);
  }

  return withInboundWriteLock(
    {
      dbClient: lockDbClient,
      inboundId: locatedInboundId,
      targetId: `renew:${normalizedTargetUuid}`,
      clientUuid: uuid,
      requireDurableLock: isAutoActivateNewOrdersFlagEnabled(),
    },
    async (assertInboundLockStillHeld) => {
      // Re-read fresh inbounds INSIDE the per-inbound lock so we never operate on a stale snapshot
      let freshInboundsList = await getInboundsFn(true);
      if (!freshInboundsList || freshInboundsList.length === 0) {
        freshInboundsList = inbounds;
      }

      for (const inbound of freshInboundsList) {
        if (Number(inbound.id) !== Number(locatedInboundId)) continue;
        let settingsObj: { clients?: XuiClient[]; [key: string]: any } = {};
        try {
          const rawSettings: any = inbound.settings;
          if (rawSettings) {
            settingsObj = typeof rawSettings === 'string' ? JSON.parse(rawSettings) : { ...rawSettings };
          }
        } catch (parseError) {
          continue;
        }

        const clients = Array.isArray(settingsObj.clients) ? [...settingsObj.clients] : [];
        const clientIndex = clients.findIndex(
          (c) => c.id && String(c.id).trim().toLowerCase() === normalizedTargetUuid
        );

        if (clientIndex >= 0) {
      const c = clients[clientIndex];
      const panelExpiry = Number(c.expiryTime || 0);
      const dbExpiry = Number(fallbackCurrentExpiryMs || 0);
      const currentExpiry = Math.max(
        Number.isFinite(panelExpiry) ? panelExpiry : 0,
        Number.isFinite(dbExpiry) ? dbExpiry : 0
      );

      const now = deps?.nowMs ?? Date.now();
      const baseTime = currentExpiry > now ? currentExpiry : now;
      const new_expiryTime = addCalendarMonths(baseTime, durationMonths);

      // Parse traffic / limit GB based on planName
      let isLimitedPlan = false;
      let packageDataLimitBytes = 0;
      const safeMonths = Math.max(1, Math.round(Number(durationMonths) || 1));

      if (planName) {
        const lowerPlan = planName.toLowerCase();
        if (lowerPlan.includes('unlimited') || lowerPlan.includes('unlimit')) {
          isLimitedPlan = false;
        } else if (lowerPlan.includes('100gb') || lowerPlan.includes('100 gb') || lowerPlan.includes('100')) {
          isLimitedPlan = true;
          packageDataLimitBytes = 100 * 1024 * 1024 * 1024 * safeMonths;
        } else {
          const gbMatch = lowerPlan.match(/(\d+)\s*gb/);
          if (gbMatch) {
            isLimitedPlan = true;
            packageDataLimitBytes = parseInt(gbMatch[1], 10) * 1024 * 1024 * 1024 * safeMonths;
          }
        }
      }

      const currentTotalBytes = Number(c.totalGB || 0);
      let newTotalBytes = currentTotalBytes; // default fallback if no plan specified

      if (planName) {
        if (isLimitedPlan) {
          newTotalBytes = currentTotalBytes + packageDataLimitBytes;
        } else {
          newTotalBytes = 0; // Unlimited
        }
      }

      const clientAny = c as any;

      // Ensure all numeric fields match 3X-UI Go Client struct types (int64 / int):
      let parsedTgId = 0;
      if (clientAny.tgId !== undefined && clientAny.tgId !== null && clientAny.tgId !== '') {
        const num = Number(clientAny.tgId);
        if (!isNaN(num)) {
          parsedTgId = Math.floor(num);
        }
      }

      let parsedLimitIp = 0;
      if (clientAny.limitIp !== undefined && clientAny.limitIp !== null && clientAny.limitIp !== '') {
        const num = Number(clientAny.limitIp);
        if (!isNaN(num)) {
          parsedLimitIp = Math.floor(num);
        }
      }

      let parsedTotalGB = 0;
      if (newTotalBytes !== undefined && newTotalBytes !== null) {
        parsedTotalGB = Math.floor(newTotalBytes);
      } else if (clientAny.totalGB !== undefined && clientAny.totalGB !== null && clientAny.totalGB !== '') {
        const num = Number(clientAny.totalGB);
        if (!isNaN(num)) {
          parsedTotalGB = Math.floor(num);
        }
      }

      let parsedReset = 0;
      if (clientAny.reset !== undefined && clientAny.reset !== null && clientAny.reset !== '') {
        const num = Number(clientAny.reset);
        if (!isNaN(num)) {
          parsedReset = Math.floor(num);
        }
      }

      const expectedExpiryTime = Math.floor(new_expiryTime);

      // IMPORTANT: Always set enable: true on renewal approval so expired/disabled 3X-UI clients are reactivated,
      // while preserving all other existing client properties (UUID, email, password, flow, security, subId, etc.).
      const clientPayload = {
        ...c,
        id: String(c.id),
        email: String(c.email || ''),
        flow: String(clientAny.flow || ''),
        subId: String(c.subId || ''),
        limitIp: parsedLimitIp,
        totalGB: parsedTotalGB,
        expiryTime: expectedExpiryTime,
        enable: true,
        tgId: parsedTgId,
        reset: parsedReset
      };

      // Remove subId only for direct client struct endpoints to avoid duplicate subId errors on 3X-UI panel
      const { subId, ...finalPayload } = clientPayload;

      const rawFinal = finalPayload as Record<string, any>;
      const maskedPayload = {
        ...finalPayload,
        id: finalPayload.id ? `${finalPayload.id.substring(0, 8)}...` : undefined,
        email: finalPayload.email ? `${finalPayload.email.substring(0, 4)}...` : undefined,
        ...(rawFinal.password !== undefined ? { password: '[REDACTED]' } : {}),
        ...(rawFinal.privateKey !== undefined ? { privateKey: '[REDACTED]' } : {}),
        ...(rawFinal.secret !== undefined ? { secret: '[REDACTED]' } : {}),
      };

      console.log(
        `[updateClientExpiry] Updating client on inbound ${inbound.id} (previous enable=${c.enable}, new enable=${finalPayload.enable}, new expiryTime=${expectedExpiryTime}):`
      );
      console.log(JSON.stringify(maskedPayload, null, 2));

      const updateClientSettingsPayload = {
        id: Number(inbound.id),
        settings: JSON.stringify({
          clients: [clientPayload]
        })
      };

      const updateEndpoints: Array<{ ep: string; body: any }> = [
        { ep: `/panel/api/inbounds/updateClient/${c.id}`, body: updateClientSettingsPayload },
        { ep: `/panel/api/inbounds/updateClient/${c.id}`, body: finalPayload },
        { ep: `/panel/api/inbounds/updateClient/${c.email}`, body: finalPayload },
        { ep: `/panel/api/clients/update/${c.email}`, body: finalPayload }
      ];

      let updated = false;
      let lastErr: any = null;

      for (const { ep, body } of updateEndpoints) {
        await assertInboundLockStillHeld();
        try {
          await requestApiFn<any>(ep, 'POST', body);
          updated = true;
          break;
        } catch (e: any) {
          console.warn(`[updateClientExpiry] Update endpoint ${ep} failed:`, e?.message || e);
          lastErr = e;
        }
      }

      let usedInboundUpdateFallback = false;
      const applyInboundUpdateFallback = async () => {
        usedInboundUpdateFallback = true;
        const updatedClients = [...clients];
        updatedClients[clientIndex] = {
          ...clients[clientIndex],
          ...clientPayload,
          enable: true,
          expiryTime: expectedExpiryTime
        };
        const updatedSettingsObj = {
          ...settingsObj,
          clients: updatedClients
        };
        const updateInboundPayload: any = {
          ...inbound,
          id: Number(inbound.id),
          settings: JSON.stringify(updatedSettingsObj)
        };
        delete updateInboundPayload.up;
        delete updateInboundPayload.down;
        delete updateInboundPayload.clientStats;
        delete updateInboundPayload.trafficReset;
        delete updateInboundPayload.lastTrafficResetTime;

        await assertInboundLockStillHeld();
        await requestApiFn<any>(`/panel/api/inbounds/update/${inbound.id}`, 'POST', updateInboundPayload);
      };

      if (!updated) {
        try {
          await applyInboundUpdateFallback();
          updated = true;
        } catch (fallbackErr: any) {
          console.error(`[updateClientExpiry] Inbound update fallback failed for inbound ${inbound.id}:`, fallbackErr?.message || fallbackErr);
          throw lastErr || fallbackErr;
        }
      }

      // Fetch the client again from 3X-UI and verify that enable === true and expiryTime is in the future
      const verifyClientState = async (): Promise<{ verified: boolean; client: XuiClient | null }> => {
        const freshInbounds = await getInboundsFn(true);
        const targetInbound =
          freshInbounds.find((ib) => Number(ib.id) === Number(inbound.id)) ||
          freshInbounds.find((ib) => {
            try {
              const rawS: any = ib.settings;
              const s = typeof rawS === 'string' ? JSON.parse(rawS) : rawS;
              return (s?.clients || []).some(
                (cl: any) => cl.id && String(cl.id).trim().toLowerCase() === normalizedTargetUuid
              );
            } catch {
              return false;
            }
          });

        if (!targetInbound) {
          return { verified: false, client: null };
        }

        let freshSettings: { clients?: XuiClient[] } = {};
        try {
          const rawFreshS: any = targetInbound.settings;
          freshSettings =
            typeof rawFreshS === 'string'
              ? JSON.parse(rawFreshS)
              : rawFreshS || {};
        } catch {
          return { verified: false, client: null };
        }

        const freshClient =
          (freshSettings.clients || []).find(
            (cl) => cl.id && String(cl.id).trim().toLowerCase() === normalizedTargetUuid
          ) || null;

        if (!freshClient) {
          return { verified: false, client: null };
        }

        const freshExpiry = Number(freshClient.expiryTime || 0);
        const isEnabled = freshClient.enable === true;
        const isFutureExpiry = freshExpiry > now && Math.abs(freshExpiry - expectedExpiryTime) <= 1000;

        return {
          verified: isEnabled && isFutureExpiry,
          client: freshClient
        };
      };

      let verification = await verifyClientState();

      // If the initial endpoint returned 200 but did not persist enable: true or the new expiryTime,
      // apply the full inbound update fallback and re-verify once.
      if (!verification.verified && !usedInboundUpdateFallback) {
        console.warn(
          `[updateClientExpiry] Initial update did not confirm enable=true & expiryTime=${expectedExpiryTime} (got enable=${verification.client?.enable}, expiryTime=${verification.client?.expiryTime}). Applying inbound update fallback...`
        );
        await applyInboundUpdateFallback();
        verification = await verifyClientState();
      }

      if (!verification.verified) {
        const errMsg = `Failed to verify 3X-UI client reactivation for UUID ${uuid} on inbound ${inbound.id}: enable=${verification.client?.enable}, expiryTime=${verification.client?.expiryTime}, expectedExpiryTime=${expectedExpiryTime}`;
        console.error(`[updateClientExpiry] ${errMsg}`);
        throw new Error(errMsg);
      }

      console.log(
        `[updateClientExpiry] Verified 3X-UI client ${uuid} on inbound ${inbound.id}: enable=${verification.client?.enable}, expiryTime=${verification.client?.expiryTime}`
      );

      invalidateInboundCache(Number(inbound.id));

      return {
        new_expiryMs: expectedExpiryTime,
        newTotalBytes,
        verifiedEnable: true,
        inboundId: Number(inbound.id)
      };
        }
      }

      throw new Error(`Client with UUID ${uuid} not found in 3X-UI inbound ${locatedInboundId}`);
    }
  );
};

export const findProvisioningTemplate = async (
  query: string | { templateId?: string; packageName?: string; server?: string }
): Promise<any | null> => {
  let templateId = '';
  let packageName = '';
  let requestedServer = '';

  if (typeof query === 'string') {
    packageName = query;
  } else if (query && typeof query === 'object') {
    templateId = query.templateId || '';
    packageName = query.packageName || '';
    requestedServer = query.server || '';
  }

  const normalizedServerNode = (() => {
    const raw = String(requestedServer || '').trim().toLowerCase();
    if (!raw || raw.includes('singapore') || raw === 'sg' || raw.includes('(sg)')) {
      return 'singapore';
    }
    return raw;
  })();

  console.log(`[Provisioning Template Lookup] Searching for template - ID: '${templateId}', Package Name: '${packageName}', Server Node: '${normalizedServerNode}'`);

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

      const matchesServerNode = (item: any) => {
        const tplServer = String(item.server || 'Singapore').trim().toLowerCase();
        if (normalizedServerNode === 'singapore') {
          return !tplServer || tplServer.includes('singapore') || tplServer === 'sg';
        }
        return tplServer === normalizedServerNode;
      };

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

        // 2. Exact match on package_name or name (preferring matching server node)
        const exactWithServer = enabledTemplates.find(item => {
          const docName = String(item.package_name || item.name || '').trim().toLowerCase();
          return (docName === targetLower || docName.replace(/_/g, ' ') === targetLower.replace(/_/g, ' ')) && matchesServerNode(item);
        });
        const exact = exactWithServer || enabledTemplates.find(item => {
          const docName = String(item.package_name || item.name || '').trim().toLowerCase();
          return docName === targetLower || docName.replace(/_/g, ' ') === targetLower.replace(/_/g, ' ');
        });
        if (exact) {
          console.log(`[Provisioning Template Lookup] Found exact match by package name '${packageName}': '${exact.package_name || exact.name}' (ID: ${exact.id})`);
          return { id: exact.id, ...exact };
        }

        // 3. Normalized match (handles typos or formatting differences)
        const alphaMatch =
          enabledTemplates.find(item => {
            const docName = String(item.package_name || item.name || '').trim().toLowerCase();
            const docNormalized = docName.replace(/[^a-z0-9]/g, '');
            const isNameMatch =
              docNormalized === targetNormalized ||
              (docNormalized.length > 5 && targetNormalized.length > 5 && (docNormalized.includes(targetNormalized) || targetNormalized.includes(docNormalized)));
            return isNameMatch && matchesServerNode(item);
          }) ||
          enabledTemplates.find(item => {
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
        const partial =
          enabledTemplates.find(item => {
            const docName = String(item.package_name || item.name || '').trim().toLowerCase();
            return (targetLower.includes(docName) || docName.includes(targetLower)) && matchesServerNode(item);
          }) ||
          enabledTemplates.find(item => {
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



export function calculateOrderDurationAndExpiry(params: {
  duration?: string | number | null;
  durationMonths?: number | null;
  durationProfiles?: Record<string, number> | null;
  existingExpiryMs?: number | null;
  isExtendingExistingAccount?: boolean;
  isTrialOrder?: boolean;
  nowMs?: number;
}): { days: number; durationMonths: number; expiryMs: number } {
  const now = params.nowMs ?? Date.now();
  if (params.isTrialOrder) {
    return {
      days: 1,
      durationMonths: 0,
      expiryMs: now + 1 * 24 * 60 * 60 * 1000,
    };
  }

  const rawDurationStr = String(params.duration || '1 Month').trim();
  let durationMonths = Number(params.durationMonths) || 0;
  if (!durationMonths) {
    const numMatch = rawDurationStr.match(/(\d+)/);
    if (numMatch) {
      const n = parseInt(numMatch[1], 10);
      if (rawDurationStr.toLowerCase().includes('month') || [1, 3, 6, 12].includes(n)) {
        durationMonths = n;
      }
    }
    if (!durationMonths) durationMonths = 1;
  }

  const canonicalDurationKey =
    durationMonths === 1 ? '1 Month' : `${durationMonths} Months`;

  let days = durationMonths * 30;
  if (durationMonths === 12) days = 365;

  if (params.durationProfiles) {
    if (params.durationProfiles[rawDurationStr]) {
      days = Number(params.durationProfiles[rawDurationStr]);
    } else if (params.durationProfiles[canonicalDurationKey]) {
      days = Number(params.durationProfiles[canonicalDurationKey]);
    }
  }

  const validExistingExpiry =
    params.isExtendingExistingAccount &&
    params.existingExpiryMs &&
    Number.isFinite(Number(params.existingExpiryMs)) &&
    Number(params.existingExpiryMs) > now
      ? Number(params.existingExpiryMs)
      : now;

  const expiryMs = params.isExtendingExistingAccount
    ? addCalendarMonths(validExistingExpiry, durationMonths)
    : validExistingExpiry + days * 24 * 60 * 60 * 1000;
  return { days, durationMonths, expiryMs };
}

const activeProvisionings = new Set<string>();
const inboundProcessQueues = new Map<number, Promise<void>>();
const DEFAULT_LOCK_LEASE_SECONDS = 120;
const INBOUND_LOCK_LEASE_SECONDS = 45;

export const isAutoActivateNewOrdersFlagEnabled = (): boolean =>
  String(process.env.AUTO_ACTIVATE_NEW_ORDERS_ENABLED || 'false').trim().toLowerCase() === 'true';

export const isAutoActivateRenewalsFlagEnabled = (): boolean =>
  String(process.env.AUTO_ACTIVATE_RENEWALS_ENABLED || 'false').trim().toLowerCase() === 'true';

const isMissingSchemaOrRpcError = (err: any): boolean => {
  const code = String(err?.code || '');
  const msg = String(err?.message || '').toLowerCase();
  return (
    code === 'PGRST202' ||
    code === 'PGRST205' ||
    code === '42883' ||
    code === '42P01' ||
    msg.includes('could not find the function') ||
    msg.includes('does not exist')
  );
};

export interface ProvisionOrderClientOptions {
  provisional?: boolean;
  adminLabel?: string;
  dbClient?: any;
  requestApiFn?: typeof requestApi;
  getInboundsFn?: typeof getInbounds;
  getClientByEmailFn?: typeof getClientByEmail;
  findProvisioningTemplateFn?: typeof findProvisioningTemplate;
  heldOrderLockOwnerId?: string;
  skipSideEffects?: boolean;
}

export type DurableOperationType =
  | 'auto_order'
  | 'auto_renew'
  | 'approve_order'
  | 'reject_order'
  | 'verify_payment'
  | 'approve_renew'
  | 'reject_renew'
  | 'inbound_write'
  | 'client_lock'
  | 'traffic_reset';

export interface DurableLockAcquireResult {
  acquired: boolean;
  lockOwnerId: string;
  tableAvailable: boolean;
  staleRecovery: boolean;
  previousStatus?: string | null;
  previousOperationType?: string | null;
  previousClientUuid?: string | null;
  holderOwnerId?: string | null;
  leaseExpiresAt?: string | null;
  error?: string;
}

/**
 * Atomically acquires a durable, lease-based PostgreSQL lock via public.acquire_provisioning_lock().
 * Fails CLOSED whenever requireDurableLock is true (always true for auto_order, auto_renew,
 * reject_order, reject_renew, verify_payment, inbound_write, client_lock, traffic_reset,
 * or whenever AUTO_ACTIVATE_NEW_ORDERS_ENABLED=true or AUTO_ACTIVATE_RENEWALS_ENABLED=true).
 */
export async function acquireDurableProvisioningOperationLock(params: {
  dbClient: any;
  operationKey: string;
  operationType: DurableOperationType;
  targetId: string;
  clientUuid?: string | null;
  leaseSeconds?: number;
  metadata?: Record<string, any>;
  requireDurableLock?: boolean;
  lockOwnerId?: string;
  allowUncertainRecovery?: boolean;
  staleGraceSeconds?: number;
}): Promise<DurableLockAcquireResult> {
  const {
    dbClient,
    operationKey,
    operationType,
    targetId,
    clientUuid,
    metadata,
  } = params;
  const lockOwnerId = params.lockOwnerId || crypto.randomUUID();
  const leaseSeconds = params.leaseSeconds || DEFAULT_LOCK_LEASE_SECONDS;
  const staleGraceSeconds = params.staleGraceSeconds ?? 35;
  // Never blindly take over uncertain operations during automated auto_order or auto_renew;
  // only explicit admin reconciliation (approve_order / reject_order / approve_renew / reject_renew) or post-grace inbound_write may recover.
  const allowUncertainRecovery =
    params.allowUncertainRecovery !== undefined
      ? params.allowUncertainRecovery
      : operationType === 'approve_order' ||
        operationType === 'reject_order' ||
        operationType === 'approve_renew' ||
        operationType === 'reject_renew' ||
        operationType === 'inbound_write';
  const mustFailClosed =
    params.requireDurableLock !== undefined
      ? params.requireDurableLock
      : isAutoActivateNewOrdersFlagEnabled() ||
        isAutoActivateRenewalsFlagEnabled() ||
        operationType === 'auto_order' ||
        operationType === 'auto_renew' ||
        operationType === 'reject_order' ||
        operationType === 'reject_renew' ||
        operationType === 'verify_payment' ||
        operationType === 'inbound_write' ||
        operationType === 'client_lock' ||
        operationType === 'traffic_reset';

  if (!dbClient || typeof dbClient.rpc !== 'function') {
    if (!mustFailClosed) {
      return { acquired: true, lockOwnerId, tableAvailable: false, staleRecovery: false };
    }
    return {
      acquired: false,
      lockOwnerId,
      tableAvailable: false,
      staleRecovery: false,
      error: 'Durable lock RPC client is unavailable.',
    };
  }

  try {
    const { data, error } = await dbClient.rpc('acquire_provisioning_lock', {
      p_operation_key: operationKey,
      p_operation_type: operationType,
      p_target_id: targetId,
      p_lock_owner_id: lockOwnerId,
      p_lease_seconds: leaseSeconds,
      p_client_uuid: clientUuid || null,
      p_metadata: metadata || {},
      p_allow_uncertain_recovery: allowUncertainRecovery,
      p_stale_grace_seconds: staleGraceSeconds,
    });

    if (error) {
      if (isMissingSchemaOrRpcError(error) && !mustFailClosed) {
        console.warn(
          `[xuiService] Durable lock RPC acquire_provisioning_lock is not installed yet (legacy manual mode, flag=false). Proceeding with in-process guard only for ${operationKey}.`
        );
        return { acquired: true, lockOwnerId, tableAvailable: false, staleRecovery: false };
      }
      console.error(`[xuiService] Durable lock acquisition failed CLOSED for ${operationKey}:`, error.message || error);
      return {
        acquired: false,
        lockOwnerId,
        tableAvailable: !isMissingSchemaOrRpcError(error),
        staleRecovery: false,
        error: error.message || 'Failed to acquire durable operation lock.',
      };
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.acquired !== 'boolean') {
      return {
        acquired: false,
        lockOwnerId,
        tableAvailable: true,
        staleRecovery: false,
        error: 'Unexpected response from acquire_provisioning_lock RPC.',
      };
    }

    return {
      acquired: Boolean(row.acquired),
      lockOwnerId,
      tableAvailable: true,
      staleRecovery: Boolean(row.stale_recovery),
      previousStatus: row.previous_status ?? null,
      previousOperationType: row.previous_operation_type ?? null,
      previousClientUuid: row.previous_client_uuid ?? null,
      holderOwnerId: row.holder_owner_id ?? null,
      leaseExpiresAt: row.lease_expires_at ?? null,
    };
  } catch (err: any) {
    if (isMissingSchemaOrRpcError(err) && !mustFailClosed) {
      return { acquired: true, lockOwnerId, tableAvailable: false, staleRecovery: false };
    }
    console.error(`[xuiService] Durable lock acquisition exception (fail CLOSED) for ${operationKey}:`, err?.message || err);
    return {
      acquired: false,
      lockOwnerId,
      tableAvailable: false,
      staleRecovery: false,
      error: err?.message || 'Durable lock acquisition exception.',
    };
  }
}

export async function renewDurableProvisioningOperationLock(params: {
  dbClient: any;
  operationKey: string;
  lockOwnerId: string;
  leaseSeconds?: number;
}): Promise<boolean> {
  if (!params.dbClient || typeof params.dbClient.rpc !== 'function') return false;
  try {
    const { data, error } = await params.dbClient.rpc('renew_provisioning_lock', {
      p_operation_key: params.operationKey,
      p_lock_owner_id: params.lockOwnerId,
      p_lease_seconds: params.leaseSeconds || DEFAULT_LOCK_LEASE_SECONDS,
    });
    if (error) return false;
    return Boolean(data);
  } catch {
    return false;
  }
}

export async function finalizeDurableProvisioningOperationLock(params: {
  dbClient: any;
  operationKey: string;
  lockOwnerId: string;
  status: 'completed' | 'failed' | 'uncertain';
  clientUuid?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, any>;
}): Promise<void> {
  const { dbClient, operationKey, lockOwnerId, status, clientUuid, errorMessage, metadata } = params;
  if (!dbClient || typeof dbClient.rpc !== 'function') return;
  try {
    await dbClient.rpc('release_provisioning_lock', {
      p_operation_key: operationKey,
      p_lock_owner_id: lockOwnerId,
      p_status: status,
      p_client_uuid: clientUuid || null,
      p_error_message: errorMessage || null,
      p_metadata: metadata || null,
    });
  } catch (_err) {
    // Best-effort release; lease expiration guarantees eventual recoverability
  }
}

/**
 * Serializes all 3X-UI writes targeting the same inbound across both same-process
 * concurrency (FIFO promise queue) and multi-instance concurrency (durable DB lock
 * `inbound:<inboundId>` with bounded retry/backoff).
 */
export async function withInboundWriteLock<T>(
  params: {
    dbClient: any;
    inboundId: number;
    targetId: string;
    clientUuid?: string | null;
    requireDurableLock?: boolean;
    allowUncertainRecovery?: boolean;
    maxWaitMs?: number;
  },
  fn: (assertInboundLockStillHeld: () => Promise<void>) => Promise<T>
): Promise<T> {
  const inboundId = Number(params.inboundId);
  const maxWaitMs = params.maxWaitMs ?? 12000;
  const inboundKey = `inbound:${inboundId}`;

  // Layer 1: Same-process FIFO serialization for this inbound
  const previousTail = inboundProcessQueues.get(inboundId) || Promise.resolve();
  let releaseLocalQueue!: () => void;
  const localGate = new Promise<void>((resolve) => {
    releaseLocalQueue = resolve;
  });
  const nextTail = previousTail.then(() => localGate);
  inboundProcessQueues.set(inboundId, nextTail);

  await previousTail;

  let acquiredLock: DurableLockAcquireResult | null = null;
  try {
    // Layer 2: Cross-process durable DB lock with bounded wait
    const deadline = Date.now() + maxWaitMs;
    let attempt = 0;

    while (true) {
      attempt++;
      const res = await acquireDurableProvisioningOperationLock({
        dbClient: params.dbClient,
        operationKey: inboundKey,
        operationType: 'inbound_write',
        targetId: params.targetId,
        clientUuid: params.clientUuid || null,
        leaseSeconds: INBOUND_LOCK_LEASE_SECONDS,
        metadata: { inboundId, targetId: params.targetId },
        requireDurableLock: params.requireDurableLock ?? isAutoActivateNewOrdersFlagEnabled(),
        allowUncertainRecovery: params.allowUncertainRecovery,
      });

      if (res.acquired) {
        acquiredLock = res;
        break;
      }

      // If table/RPC is missing or hard DB error occurred under fail-closed mode, fail immediately instead of spinning
      if (!res.tableAvailable) {
        throw new Error(res.error || `Unable to acquire durable inbound lock for inbound ${inboundId}.`);
      }

      // Never spin or steal an uncertain inbound lock when allowUncertainRecovery is explicitly false
      if (params.allowUncertainRecovery === false && res.previousStatus === 'uncertain') {
        const uncertainErr: any = new Error(
          `Inbound ${inboundId} has an uncertain prior provisioning lock; skipping without forcing recovery.`
        );
        uncertainErr.statusCode = 409;
        uncertainErr.code = 'INBOUND_LOCK_UNCERTAIN';
        throw uncertainErr;
      }

      if (Date.now() >= deadline) {
        const busyErr: any = new Error(`Timed out waiting for durable inbound write lock on inbound ${inboundId}.`);
        busyErr.statusCode = 409;
        busyErr.code = 'INBOUND_LOCK_BUSY';
        throw busyErr;
      }

      const backoffMs = Math.min(40 * attempt + Math.floor(Math.random() * 25), 250);
      await new Promise((r) => setTimeout(r, backoffMs));
    }

    // Pre-mutation fencing helper: verifies this worker STILL owns the inbound lock
    // and refreshes its lease right before dispatching an external 3X-UI mutation.
    const assertInboundLockStillHeld = async (): Promise<void> => {
      if (!acquiredLock?.tableAvailable) return;
      const renewed = await renewDurableProvisioningOperationLock({
        dbClient: params.dbClient,
        operationKey: inboundKey,
        lockOwnerId: acquiredLock.lockOwnerId,
        leaseSeconds: INBOUND_LOCK_LEASE_SECONDS,
      });
      if (!renewed) {
        const fenceErr: any = new Error(
          `Lost durable inbound write lock '${inboundKey}' before 3X-UI mutation; aborting to prevent overlapping writes.`
        );
        fenceErr.statusCode = 409;
        throw fenceErr;
      }
    };

    let opOutcome: 'completed' | 'failed' | 'uncertain' = 'completed';
    let opErr: string | null = null;
    try {
      return await fn(assertInboundLockStillHeld);
    } catch (err: any) {
      const msgLower = String(err?.message || '').toLowerCase();
      const isUncertainTransportErr =
        msgLower.includes('timeout') ||
        msgLower.includes('etimedout') ||
        msgLower.includes('econnreset') ||
        msgLower.includes('econnrefused') ||
        msgLower.includes('socket hang up') ||
        msgLower.includes('network error');
      opOutcome = isUncertainTransportErr ? 'uncertain' : 'failed';
      opErr = err?.message || String(err);
      throw err;
    } finally {
      if (acquiredLock?.tableAvailable) {
        await finalizeDurableProvisioningOperationLock({
          dbClient: params.dbClient,
          operationKey: inboundKey,
          lockOwnerId: acquiredLock.lockOwnerId,
          status: opOutcome,
          clientUuid: params.clientUuid || null,
          errorMessage: opErr,
        });
      }
    }
  } finally {
    releaseLocalQueue();
    if (inboundProcessQueues.get(inboundId) === nextTail) {
      inboundProcessQueues.delete(inboundId);
    }
  }
}

export const provisionOrderClient = async (
  orderId: string,
  token?: string,
  options?: ProvisionOrderClientOptions
): Promise<any> => {
  const isProvisionalActivation = Boolean(options?.provisional);
  const requestApiCall = options?.requestApiFn || requestApi;
  const getInboundsCall = options?.getInboundsFn || getInbounds;
  const getClientByEmailCall = options?.getClientByEmailFn || getClientByEmail;
  const findTemplateCall = options?.findProvisioningTemplateFn || findProvisioningTemplate;

  console.log(`[xuiService] [FUNCTION ENTERED] provisionOrderClient - orderId: ${orderId} | provisional: ${isProvisionalActivation}`);
  if (!options?.heldOrderLockOwnerId && activeProvisionings.has(orderId)) {
    console.warn(`[xuiService] [DUPLICATE EXECUTION DETECTED] provisionOrderClient is already running for orderId: ${orderId}`);
    return {
      success: true,
      deduplicated: true,
      message: 'Provisioning is already in progress for this order. Skipping duplicate execution.'
    };
  }
  activeProvisionings.add(orderId);
  let canonicalOrderLockKey = '';
  let durableOperationKey = '';
  let acquiredLockOwnerId = options?.heldOrderLockOwnerId || '';
  let ownsDurableLock = false;
  let xuiWriteAttempted = false;
  let xuiWriteConfirmed = false;
  const dbClient = options?.dbClient || supabaseAdmin;

  try {
    let { data: order, error: fetchErr } = await dbClient.from('orders').select('*').eq('id', orderId).maybeSingle();

    if (!order) {
      const { data: queryOrder } = await dbClient.from('orders').select('*').eq('order_id', orderId).maybeSingle();
      if (!queryOrder) {
        console.error(`[3X-UI Provisioning] Order '${orderId}' not found in database. Fetch error:`, fetchErr);
        throw new Error(`Order '${orderId}' not found in database.`);
      }
      order = queryOrder;
    }

    // Acquire canonical in-process guard on order.id to prevent concurrent approval via order_id vs UUID
    if (!options?.heldOrderLockOwnerId && order.id && String(order.id) !== String(orderId)) {
      canonicalOrderLockKey = String(order.id);
      if (activeProvisionings.has(canonicalOrderLockKey)) {
        console.warn(`[xuiService] [DUPLICATE EXECUTION DETECTED] Canonical order ${canonicalOrderLockKey} is already provisioning.`);
        return {
          success: true,
          deduplicated: true,
          message: 'Provisioning is already in progress for this order. Skipping duplicate assignment.'
        };
      }
      activeProvisionings.add(canonicalOrderLockKey);
    }

    durableOperationKey = `order:${order.id}`;
    let staleLockRecovered = false;
    if (!options?.heldOrderLockOwnerId) {
      const lockRes = await acquireDurableProvisioningOperationLock({
        dbClient,
        operationKey: durableOperationKey,
        operationType: isProvisionalActivation ? 'auto_order' : 'approve_order',
        targetId: String(order.id),
        clientUuid: order.client_uuid || null,
        metadata: {
          orderId: order.order_id || order.id,
          provisional: isProvisionalActivation,
        },
        requireDurableLock: isProvisionalActivation || isAutoActivateNewOrdersFlagEnabled(),
      });

      if (!lockRes.acquired) {
        if (!lockRes.tableAvailable && (isProvisionalActivation || isAutoActivateNewOrdersFlagEnabled())) {
          throw new Error(lockRes.error || 'Durable order coordination lock is unavailable; refusing to provision.');
        }
        if (lockRes.previousStatus === 'uncertain') {
          const uncErr: any = new Error(
            `Order '${order.order_id || order.id}' has an uncertain prior external provisioning state; automatic takeover blocked until explicit reconciliation.`
          );
          uncErr.statusCode = 409;
          throw uncErr;
        }
        console.warn(`[xuiService] Durable operation lock '${durableOperationKey}' is currently held by another active operation (${lockRes.previousOperationType || 'unknown'}).`);
        if (lockRes.previousOperationType === 'reject_order') {
          const conflictErr: any = new Error('Order rejection is currently in progress for this order.');
          conflictErr.statusCode = 409;
          throw conflictErr;
        }
        return {
          success: true,
          deduplicated: true,
          message: 'Provisioning operation is already in progress for this order.',
        };
      }

      acquiredLockOwnerId = lockRes.lockOwnerId;
      ownsDurableLock = lockRes.tableAvailable;
      staleLockRecovered = lockRes.staleRecovery;

      // Re-read fresh order state INSIDE the durable lock so decisions never use a pre-lock snapshot
      const { data: freshOrder } = await dbClient.from('orders').select('*').eq('id', order.id).maybeSingle();
      if (freshOrder) {
        order = freshOrder;
      }

      if (staleLockRecovered) {
        console.warn(
          `[xuiService] Recovered stale/uncertain lock '${durableOperationKey}' (prevOp=${lockRes.previousOperationType}, prevStatus=${lockRes.previousStatus}). Reconciling DB & live 3X-UI state before proceeding...`
        );
      }
    }

    // Parse read-only order metadata from payment_method (NEVER mutate payment_method for internal entitlement state)
    let extra: any = {};
    if (order.payment_method && typeof order.payment_method === 'string' && order.payment_method.startsWith('{')) {
      try {
        extra = JSON.parse(order.payment_method);
      } catch (e) {
        console.error('[3X-UI Provisioning] Error parsing payment_method JSON:', e);
      }
    }

    // Load authoritative entitlement grant ledger row (if any) inside the lock
    let existingGrantRow: any = null;
    try {
      const { data: grantRow, error: grantSelErr } = await dbClient
        .from('vpn_entitlement_grants')
        .select('*')
        .eq('grant_type', 'new_order')
        .eq('source_id', String(order.id))
        .maybeSingle();
      if (!grantSelErr && grantRow) {
        existingGrantRow = grantRow;
      } else if (!grantSelErr && !grantRow) {
        const { data: byOrderGrant } = await dbClient
          .from('vpn_entitlement_grants')
          .select('*')
          .eq('order_id', order.id)
          .maybeSingle();
        if (byOrderGrant) existingGrantRow = byOrderGrant;
      } else if (grantSelErr && !isMissingSchemaOrRpcError(grantSelErr)) {
        throw new Error(`Failed to read vpn_entitlement_grants: ${grantSelErr.message}`);
      }
    } catch (grantLookupErr: any) {
      if (isProvisionalActivation || isAutoActivateNewOrdersFlagEnabled()) {
        throw new Error(`Authoritative entitlement ledger lookup failed: ${grantLookupErr?.message || grantLookupErr}`);
      }
    }

    const rawStatusLower = String(order.status || '').toLowerCase().trim();
    const rawPayLower = String(order.payment_status || '').toLowerCase().trim();
    const rawProvLower = String(order.provisioning_status || '').toLowerCase().trim();

    if (
      rawStatusLower === 'rejected' ||
      rawStatusLower === 'cancelled' ||
      rawPayLower === 'cancelled' ||
      rawPayLower === 'rejected' ||
      rawProvLower === 'revoked' ||
      existingGrantRow?.status === 'revoked'
    ) {
      if (ownsDurableLock) {
        await finalizeDurableProvisioningOperationLock({
          dbClient,
          operationKey: durableOperationKey,
          lockOwnerId: acquiredLockOwnerId,
          status: 'failed',
          errorMessage: `Order ${order.order_id || order.id} has already been rejected.`,
        });
        ownsDurableLock = false;
      }
      const rejErr: any = new Error(`Order '${order.order_id || order.id}' has already been rejected and cannot be provisioned or approved.`);
      rejErr.statusCode = 409;
      throw rejErr;
    }

    // Idempotency Check 1: If order is already completed/paid with existing VPN link, return existing details immediately
    const isAlreadyCompleted =
      (rawStatusLower === 'completed' || rawStatusLower === 'active' || rawStatusLower === 'approved') &&
      Boolean(order.vless_url);
    if (isAlreadyCompleted) {
      const { data: existingVpnAcc } = await dbClient.from('vpn_accounts').select('*').eq('order_id', order.id).maybeSingle();
      if (ownsDurableLock) {
        await finalizeDurableProvisioningOperationLock({
          dbClient,
          operationKey: durableOperationKey,
          lockOwnerId: acquiredLockOwnerId,
          status: 'completed',
          clientUuid: order.client_uuid || existingVpnAcc?.uuid,
        });
        ownsDurableLock = false;
      }
      return {
        success: true,
        alreadyProvisioned: true,
        message: 'Order already provisioned and completed',
        orderId: order.order_id || order.id,
        uuid: order.client_uuid || existingVpnAcc?.uuid,
        vlessUrl: order.vless_url || existingVpnAcc?.vless_url,
        subscriptionUrl: order.subscription_url || order.vless_url || existingVpnAcc?.vless_url,
        vpnAccountId: existingVpnAcc?.id
      };
    }

    // Idempotency Check 2: Authoritative provisional activation detection (orders.provisioning_status OR vpn_entitlement_grants; ZERO payment_method fallback)
    const isAlreadyProvisionallyActive =
      (rawProvLower === 'provisional' || existingGrantRow?.status === 'provisional') &&
      Boolean(order.vless_url) &&
      Boolean(order.client_uuid);

    if (isAlreadyProvisionallyActive) {
      const { data: existingVpnAcc } = await dbClient.from('vpn_accounts').select('*').eq('order_id', order.id).maybeSingle();
      const { data: existingVpnCfg } = await dbClient.from('vpn_configs').select('*').eq('order_id', order.id).maybeSingle();

      // If caller requested provisional activation again, return the existing provisional credentials without re-running 3X-UI
      if (isProvisionalActivation) {
        if (ownsDurableLock) {
          await finalizeDurableProvisioningOperationLock({
            dbClient,
            operationKey: durableOperationKey,
            lockOwnerId: acquiredLockOwnerId,
            status: 'completed',
            clientUuid: order.client_uuid,
          });
          ownsDurableLock = false;
        }
        return {
          success: true,
          provisional: true,
          alreadyProvisioned: true,
          message: 'Order VPN client is already provisionally active.',
          orderId: order.order_id || order.id,
          uuid: order.client_uuid,
          vlessUrl: order.vless_url,
          subscriptionUrl: order.subscription_url || order.vless_url,
          expiryDate: order.expiry_date || existingVpnAcc?.expiry_date || existingVpnCfg?.expiry_date,
          vpnAccountId: existingVpnAcc?.id,
        };
      }

      // Admin / Telegram Approval confirming payment of an already provisionally active order!
      // Confirms payment WITHOUT creating another VPN client, resetting traffic, extending twice, or mutating payment_method.
      console.log(`[3X-UI Provisioning] Order ${order.order_id || order.id} already has an active provisional VPN client (${order.client_uuid}). Confirming payment without re-provisioning or resetting traffic...`);
      const nowIso = new Date().toISOString();

      // If stale recovery occurred, reconcile 3X-UI live state to confirm the client wasn't disabled by an interrupted rejection
      if (staleLockRecovered) {
        const liveInbounds = await getInboundsCall(true);
        const liveMatch = liveInbounds.some((ib: any) => {
          try {
            const s = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings;
            return (s?.clients || []).some(
              (c: any) => String(c.id || '').trim().toLowerCase() === String(order.client_uuid).trim().toLowerCase() && c.enable !== false
            );
          } catch {
            return false;
          }
        });
        if (!liveMatch) {
          throw new Error(`Stale lock reconciliation detected provisional client ${order.client_uuid} is missing or disabled on 3X-UI. Manual review required.`);
        }
      }

      // Mark authoritative entitlement grant as verified FIRST (fail closed if ledger update fails)
      if (existingGrantRow?.id) {
        const { error: verifyGrantErr } = await dbClient
          .from('vpn_entitlement_grants')
          .update({
            status: 'verified',
            verified_at: nowIso,
            verified_by: options?.adminLabel || 'Admin',
            updated_at: nowIso,
          })
          .eq('id', existingGrantRow.id);
        if (verifyGrantErr) {
          throw new Error(`Failed to mark vpn_entitlement_grants verified: ${verifyGrantErr.message}`);
        }
      }

      const { error: confirmOrderErr } = await dbClient
        .from('orders')
        .update({
          payment_status: 'Paid',
          status: 'completed',
          provisioning_status: 'completed',
          updated_at: nowIso,
        })
        .eq('id', order.id);

      if (confirmOrderErr) {
        throw new Error(`Failed to confirm payment on provisionally active order: ${confirmOrderErr.message}`);
      }

      const packageNameForNotif = extra.package_name || extra.packageName || extra.plan || extra.package || order.package_name || 'FIREVPN Package';
      const durationForNotif = extra.duration || (extra.duration_months ? `${extra.duration_months} Months` : '1 Month');
      const isValidUuidCheck = (val: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val || '');
      const validUid = isValidUuidCheck(order.customer_id) ? order.customer_id : null;

      if (!options?.skipSideEffects) {
        try {
          await createCustomerNotification({
            userId: validUid,
            userEmail: order.email,
            title: 'Order Approved',
            message: `Your order for "${packageNameForNotif}" has been approved!`,
            type: 'order_approved',
            orderId: order.id,
            vpnName: packageNameForNotif,
          });
          await createCustomerNotification({
            userId: validUid,
            userEmail: order.email,
            title: 'Payment Approved',
            message: `Your payment for "${packageNameForNotif}" has been verified and approved! Your VPN connection remains active.`,
            type: 'payment_approved',
            orderId: order.id,
            vpnName: packageNameForNotif,
          });

          if (order.email) {
            sendPaymentApprovedEmail({
              userEmail: order.email,
              customerName: extra.customerName || extra.configurationName || undefined,
              orderId: order.order_id || order.id,
              packageName: packageNameForNotif,
              vlessUrl: order.vless_url,
              expiryDate: order.expiry_date || existingVpnAcc?.expiry_date || undefined,
              userId: validUid || undefined,
            }).catch(e => console.warn('[3X-UI Provisioning DB] Payment approved email warning:', e));
          }
        } catch (notifErr: any) {
          console.warn('[3X-UI Provisioning DB] Notification warning on provisional approval confirmation:', notifErr?.message || notifErr);
        }

        try {
          await sendOrderApprovedNotification({
            customerEmail: order.email || 'N/A',
            packageName: packageNameForNotif,
            packageType: extra.packageType || 'SIM Unlimited',
            server: extra.server || 'Singapore',
            duration: durationForNotif,
            price: order.amount || 0,
            uuid: order.client_uuid,
            orderId: order.order_id || order.id,
            status: '🟢 COMPLETED',
          });
        } catch (tgErr) {
          console.warn('[3X-UI Provisioning DB] Telegram notification warning on provisional confirmation:', tgErr);
        }
      }

      if (ownsDurableLock) {
        await finalizeDurableProvisioningOperationLock({
          dbClient,
          operationKey: durableOperationKey,
          lockOwnerId: acquiredLockOwnerId,
          status: 'completed',
          clientUuid: order.client_uuid,
        });
        ownsDurableLock = false;
      }

      return {
        success: true,
        confirmedProvisional: true,
        message: 'Payment verified and provisionally active VPN order marked completed without duplicate provisioning.',
        orderId: order.order_id || order.id,
        uuid: order.client_uuid,
        vlessUrl: order.vless_url,
        subscriptionUrl: order.subscription_url || order.vless_url,
        vpnAccountId: existingVpnAcc?.id,
      };
    }

  const templateId = extra.template_id || extra.templateId || order.template_id || order.templateId || '';
  const packageName = extra.package_name || extra.packageName || extra.plan || extra.package || order.package_name || '';
  const customerName = extra.configurationName || extra.customerName || extra.name || extra.full_name || (order.email ? order.email.split('@')[0] : 'Customer');
  const customerId = order.customer_id || extra.customer_id || '';
  const extendUuid = String(extra.extend_uuid || extra.existing_uuid || extra.extendUuid || '').trim();

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
  const selectedServerNode = extra.server_node || extra.server || order.server || 'Singapore';
  const template = await findTemplateCall({ templateId, packageName, server: selectedServerNode });
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
  
  const address = template.address || '';
  const sni = template.sni || '';
  const remarkFormat = template.remark_template || template.remarkFormat || '{{customerName}}';

  const orderDisplayId = (order.order_id || order.id || '').trim();
  let remark = formatClientRemark(remarkFormat, customerName, orderDisplayId);

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

  // Check if an existing VPN account exists for this order/user or is being extended
  let existingAcc: any = null;
  let isExtendingExistingAccount = false;

  if (extendUuid) {
    const { data: extAcc } = await dbClient
      .from('vpn_accounts')
      .select('*')
      .eq('uuid', extendUuid)
      .maybeSingle();
    if (extAcc) {
      existingAcc = extAcc;
      isExtendingExistingAccount = true;
      if (extAcc.remark) {
        remark = String(extAcc.remark).trim();
      }
      console.log(`[3X-UI Provisioning DB] Extending existing VPN account UUID: ${extendUuid}`);
    }
  }

  if (!existingAcc && order.id) {
    const { data: d1, error: e1 } = await dbClient
      .from('vpn_accounts')
      .select('*')
      .eq('order_id', order.id)
      .maybeSingle();
    if (e1) console.warn('[3X-UI Provisioning DB] vpn_accounts select by order_id notice:', e1);
    existingAcc = d1;
    console.log('Lookup by order_id:', d1);
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
    console.log('Lookup by trial:', d1);
  }

  // Check if a prior interrupted attempt already persisted an intended client UUID in vpn_entitlement_grants or orders.client_uuid
  const priorIntendedUuid = String(existingGrantRow?.client_uuid || order.client_uuid || '').trim();
  const priorIntendedSubId = String(existingGrantRow?.sub_id || '').trim();

  // Fetch all inbounds to search for an existing client in 3X-UI panel
  const allInbounds = await getInboundsCall();
  let existingClient: any = null;
  let targetInboundId = inboundId;

  // Search by known UUIDs from database (including priorIntendedUuid or by remark if it is a trial order)
  for (const ib of allInbounds) {
    let settingsObj: any = {};
    try {
      settingsObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings;
    } catch (e) { continue; }
    const clients = settingsObj.clients || [];
    const found = clients.find((c: any) => 
      (extendUuid && String(c.id).trim().toLowerCase() === extendUuid.toLowerCase()) ||
      (priorIntendedUuid && String(c.id).trim().toLowerCase() === priorIntendedUuid.toLowerCase()) ||
      (existingAcc && String(c.id).trim().toLowerCase() === String(existingAcc.uuid).trim().toLowerCase()) ||
      (existingTrialConfig && String(c.id).trim().toLowerCase() === String(existingTrialConfig.uuid).trim().toLowerCase()) ||
      (isTrialOrder && String(c.email).trim().toLowerCase() === remark.trim().toLowerCase())
    );
    if (found) {
      existingClient = found;
      targetInboundId = Number(ib.id);
      if (isExtendingExistingAccount && found.email) {
        remark = String(found.email).trim();
      }
      break;
    }
  }

  // Duration & Traffic calculations based on loaded template profiles (supports 1 Month, 3 Months, 6 Months, 12 Months)
  const duration = extra.duration || (extra.duration_months ? `${extra.duration_months} Months` : '1 Month');
  const existingExpiryCandidateMs =
    Number(existingClient?.expiryTime || 0) ||
    (existingAcc?.expiry_date ? new Date(existingAcc.expiry_date).getTime() : 0);

  const durationCalc = calculateOrderDurationAndExpiry({
    duration,
    durationMonths: extra.duration_months ? Number(extra.duration_months) : null,
    durationProfiles: template.duration_profiles || null,
    existingExpiryMs: existingExpiryCandidateMs,
    isExtendingExistingAccount,
    isTrialOrder,
  });

  let days = durationCalc.days;
  let expiryMs = durationCalc.expiryMs;

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

  // Scale limited traffic allowance by multi-month duration (e.g. 3 Months or 6 Months) and preserve existing traffic when extending
  if (totalBytes > 0 && durationCalc.durationMonths > 1) {
    totalBytes = totalBytes * durationCalc.durationMonths;
  }
  if (isExtendingExistingAccount && totalBytes > 0 && existingClient?.totalGB) {
    totalBytes = Number(existingClient.totalGB) + totalBytes;
  }

  // Trial Override: Apply 1 Day (24h) and 1 GB Limit strictly for Free Trials
  if (isTrialOrder) {
    days = 1;
    totalBytes = 1 * 1024 * 1024 * 1024; // 1 GB
    expiryMs = Date.now() + (1 * 24 * 60 * 60 * 1000);
  }

  // Determine UUID and subId:
  // For extending an existing account, re-provisioning an existing order (or recovering a lost 3X-UI response via priorIntendedUuid), or updating a trial: preserve existing UUID & subId
  // For new paid orders: generate a brand new UUID
  let uuid: string;
  let subId: string;

  if (existingAcc && existingAcc.uuid) {
    uuid = existingAcc.uuid;
    subId = (existingClient && existingClient.subId) || existingAcc.sub_id || priorIntendedSubId || crypto.randomBytes(12).toString('hex');
  } else if (extendUuid) {
    uuid = extendUuid;
    subId = (existingClient && existingClient.subId) || priorIntendedSubId || crypto.randomBytes(12).toString('hex');
  } else if (priorIntendedUuid) {
    uuid = priorIntendedUuid;
    subId = (existingClient && existingClient.subId) || priorIntendedSubId || crypto.randomBytes(12).toString('hex');
    console.log(`[3X-UI Provisioning] Recovering pre-persisted intended client UUID for order ${order.id}: ${uuid}`);
  } else if (isTrialOrder && (existingTrialConfig?.uuid || existingAcc?.uuid)) {
    uuid = existingTrialConfig?.uuid || existingAcc?.uuid;
    subId = (existingClient && existingClient.subId) || existingTrialConfig?.sub_id || crypto.randomBytes(12).toString('hex');
  } else {
    uuid = crypto.randomUUID();
    subId = crypto.randomBytes(12).toString('hex');
  }

  // Resolve accountEmail early so pre-persisted entitlement ledger record is complete
  let accountEmail = (order.email || extra.email || extra.user_email || extra.customerEmail || '').trim();
  if (!accountEmail && order.customer_id) {
    const { data: prof } = await dbClient.from('profiles').select('email').eq('id', order.customer_id).maybeSingle();
    if (prof?.email) {
      accountEmail = prof.email.trim();
    }
  }

  // Authoritative Pre-Persistence BEFORE calling 3X-UI:
  // Insert/update vpn_entitlement_grants with status='provisioning' (and NEVER mutate orders.payment_method).
  // Fail CLOSED for provisional activations so an untracked unpaid 3X-UI client can never be created.
  const prePersistNowIso = new Date().toISOString();
  const preGrantPayload = {
    grant_type: 'new_order',
    source_id: String(order.id),
    order_id: order.id,
    user_id: validUserId,
    user_email: accountEmail || order.email || '',
    vpn_account_id: existingAcc?.id || null,
    client_uuid: uuid,
    sub_id: subId,
    inbound_id: inboundId,
    remark,
    package_name: packageName,
    duration_months: durationCalc.durationMonths,
    previous_expiry_ms: existingExpiryCandidateMs > 0 ? existingExpiryCandidateMs : 0,
    previous_total_bytes: isExtendingExistingAccount && existingClient?.totalGB ? Number(existingClient.totalGB) : 0,
    previous_was_unlimited: isExtendingExistingAccount ? Number(existingClient?.totalGB || 0) === 0 : false,
    previous_enable: existingClient ? existingClient.enable !== false : true,
    previous_status: existingAcc?.status || 'active',
    added_duration_months: durationCalc.durationMonths,
    granted_expiry_ms: expiryMs,
    added_quota_bytes: totalBytes,
    granted_unlimited: totalBytes === 0,
    provisional: isProvisionalActivation,
    status: 'provisioning',
    updated_at: prePersistNowIso,
  };

  let authoritativeGrantId: string | null = existingGrantRow?.id || null;
  let grantTableAvailable = true;
  {
    let grantWriteErr: any = null;
    if (authoritativeGrantId) {
      const { error } = await dbClient
        .from('vpn_entitlement_grants')
        .update(preGrantPayload)
        .eq('id', authoritativeGrantId);
      grantWriteErr = error;
    } else {
      const { data: insertedGrant, error } = await dbClient
        .from('vpn_entitlement_grants')
        .insert({ ...preGrantPayload, created_at: prePersistNowIso })
        .select('id')
        .maybeSingle();
      grantWriteErr = error;
      if (insertedGrant?.id) authoritativeGrantId = insertedGrant.id;
    }

    if (grantWriteErr) {
      if (isMissingSchemaOrRpcError(grantWriteErr) && !isProvisionalActivation && !isAutoActivateNewOrdersFlagEnabled()) {
        grantTableAvailable = false;
        console.warn('[3X-UI Provisioning] vpn_entitlement_grants table not migrated yet (legacy manual approval mode, flag=false).');
      } else {
        throw new Error(`Failed to pre-persist authoritative vpn_entitlement_grants record before 3X-UI call: ${grantWriteErr.message || JSON.stringify(grantWriteErr)}`);
      }
    }
  }

  // Persist client_uuid on orders before 3X-UI call (without modifying payment_method)
  const { error: preOrderUuidErr } = await dbClient
    .from('orders')
    .update({
      client_uuid: uuid,
      updated_at: prePersistNowIso,
    })
    .eq('id', order.id);
  if (preOrderUuidErr && isProvisionalActivation) {
    throw new Error(`Failed to pre-persist client_uuid on orders before 3X-UI call: ${preOrderUuidErr.message}`);
  }

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
    console.log('Lookup by uuid:', accByUuid);
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
  console.log(`- Existing client lookup result: ${existingClient ? 'Found' : 'None'}`);
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

  let skipMsg = '';

  // Step 2: Provision client INSIDE per-inbound durable write lock (serializes GET -> modify clients[] -> POST -> read-back)
  console.log(`[3X-UI Provisioning] Provisioning client for inbound ${inboundId} under per-inbound write lock...`);

  await withInboundWriteLock(
    {
      dbClient,
      inboundId,
      targetId: String(order.id),
      clientUuid: uuid,
      requireDurableLock: isProvisionalActivation || isAutoActivateNewOrdersFlagEnabled(),
    },
    async (assertInboundLockStillHeld) => {
      // Fetch fresh target inbound INSIDE the inbound lock
      let targetInboundObj: any = null;
      try {
        const getRes = await requestApiCall<any>(`/panel/api/inbounds/get/${inboundId}`, 'GET');
        targetInboundObj = getRes?.obj || getRes;
      } catch (getErr: any) {
        console.warn(`[3X-UI Provisioning] GET /panel/api/inbounds/get/${inboundId} notice:`, getErr?.message || getErr);
      }

      if (!targetInboundObj || typeof targetInboundObj !== 'object' || !targetInboundObj.id) {
        console.log(`[3X-UI Provisioning] Falling back to getInbounds(true) list to find inbound ${inboundId}`);
        const allInboundsList = await getInboundsCall(true);
        targetInboundObj = allInboundsList.find((ib: any) => Number(ib.id) === Number(inboundId));
      }

      if (!targetInboundObj) {
        throw new Error(`Target inbound with ID ${inboundId} not found on 3X-UI panel.`);
      }

      // Parse inbound.settings.clients
      let settingsObj: any = {};
      if (typeof targetInboundObj.settings === 'string') {
        try {
          settingsObj = JSON.parse(targetInboundObj.settings);
        } catch (e) {
          settingsObj = { clients: [] };
        }
      } else if (targetInboundObj.settings && typeof targetInboundObj.settings === 'object') {
        settingsObj = { ...targetInboundObj.settings };
      } else {
        settingsObj = { clients: [] };
      }

      if (!Array.isArray(settingsObj.clients)) {
        settingsObj.clients = [];
      }

      const existingClients: any[] = [...settingsObj.clients];
      const clientCountBefore = existingClients.length;

      // Check whether the UUID already exists on this inbound (or by email for trial orders)
      const existingIndex = existingClients.findIndex((c: any) =>
        (c.id && String(c.id).trim().toLowerCase() === String(uuid).trim().toLowerCase()) ||
        (isTrialOrder && c.email && String(c.email).trim().toLowerCase() === String(remark).trim().toLowerCase())
      );

      const matchedExistingClient = existingIndex >= 0 ? existingClients[existingIndex] : existingClient;
      const isExistingClientRecord = existingIndex >= 0 || Boolean(existingClient);

      // Stale / interrupted provisioning reconciliation:
      // If a pre-persisted client UUID for this new order ALREADY exists and is enabled on 3X-UI,
      // adopt the live 3X-UI client directly without issuing a duplicate update write.
      if (
        existingIndex >= 0 &&
        Boolean(priorIntendedUuid) &&
        !isExtendingExistingAccount &&
        !isTrialOrder &&
        matchedExistingClient?.enable !== false
      ) {
        console.log(
          `[3X-UI Provisioning] Reconciled existing live 3X-UI client ${uuid} on inbound ${inboundId} (staleLockRecovered=${staleLockRecovered}). Adopting without duplicate 3X-UI write.`
        );
        if (matchedExistingClient?.subId) subId = String(matchedExistingClient.subId);
        if (matchedExistingClient?.email) remark = String(matchedExistingClient.email);
        if (Number(matchedExistingClient?.expiryTime || 0) > 0) expiryMs = Number(matchedExistingClient.expiryTime);
        if (matchedExistingClient?.totalGB !== undefined) totalBytes = Number(matchedExistingClient.totalGB);
        xuiWriteConfirmed = true;
        return;
      }

      const generateRandom16CharCredential = (): string => {
        const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let out = '';
        for (let i = 0; i < 16; i++) {
          out += alphabet[crypto.randomInt(0, alphabet.length)];
        }
        return out;
      };

      const clientCredentialFields: Record<string, string> = {};
      if (isExistingClientRecord) {
        if (matchedExistingClient?.password !== undefined) {
          clientCredentialFields.password = String(matchedExistingClient.password);
        }
        if (matchedExistingClient?.auth !== undefined) {
          clientCredentialFields.auth = String(matchedExistingClient.auth);
        }
      } else {
        clientCredentialFields.password = generateRandom16CharCredential();
        clientCredentialFields.auth = generateRandom16CharCredential();
      }

      const newClientRecord: any = {
        id: uuid,
        email: remark,
        flow: flow || '',
        limitIp: 0,
        totalGB: totalBytes,
        expiryTime: expiryMs,
        enable: true,
        tgId: 0,
        subId: subId,
        reset: 0,
        comment: '',
        group: '',
        ...clientCredentialFields
      };

      // Add protocol-specific fields if defined on target inbound
      if (targetInboundObj.protocol === 'vless' || targetInboundObj.protocol === 'trojan' || targetInboundObj.protocol === 'vmess') {
        if (security) {
          newClientRecord.security = security;
        }
      }

      const redactClientSecrets = (record: any) => ({
        ...record,
        ...(record?.password ? { password: '[REDACTED]' } : {}),
        ...(record?.auth ? { auth: '[REDACTED]' } : {}),
      });

      console.log('=== [3X-UI ADD CLIENT REQUEST BODY LOGGING] ===');
      console.log('Target Inbound ID:', inboundId);
      console.log('Client Record (Matches Manual Client Structure):');
      console.log(JSON.stringify(redactClientSecrets(newClientRecord), null, 2));
      console.log('==============================================');

      if (existingIndex >= 0) {
        skipMsg = 'Client already exists on this inbound. Updated existing client settings.';
        console.log(`[3X-UI Provisioning] Client found at index ${existingIndex}. Updating existing client record.`);
        existingClients[existingIndex] = {
          ...existingClients[existingIndex],
          ...newClientRecord
        };
      } else {
        console.log(`[3X-UI Provisioning] Client not found on inbound. Appending new client record.`);
        existingClients.push(newClientRecord);
      }

      const clientCountAfter = existingClients.length;

      // Preserve every existing client & preserve every inbound property
      settingsObj.clients = existingClients;

      const updateInboundPayload: any = {
        ...targetInboundObj,
        id: Number(inboundId),
        settings: JSON.stringify(settingsObj)
      };

      // Remove runtime / statistics fields
      delete updateInboundPayload.up;
      delete updateInboundPayload.down;
      delete updateInboundPayload.clientStats;
      delete updateInboundPayload.trafficReset;
      delete updateInboundPayload.lastTrafficResetTime;

      console.log(`[3X-UI Provisioning] Sending POST /panel/api/inbounds/update/${inboundId}`);
      console.log(`[3X-UI Provisioning] Detailed Logs:`);
      console.log(`  - Client count before update: ${clientCountBefore}`);
      console.log(`  - Client count after update: ${clientCountAfter}`);
      console.log(`  - UUID added/updated: ${uuid}`);
      console.log(`  - Email added/updated: ${remark}`);

      // Fencing verification immediately before external 3X-UI mutation:
      // ensure BOTH the inbound write lock and the order lock are still actively owned by this worker.
      await assertInboundLockStillHeld();
      if (ownsDurableLock && durableOperationKey && acquiredLockOwnerId) {
        const orderLockValid = await renewDurableProvisioningOperationLock({
          dbClient,
          operationKey: durableOperationKey,
          lockOwnerId: acquiredLockOwnerId,
        });
        if (!orderLockValid) {
          const fenceErr: any = new Error(
            `Lost durable order lock '${durableOperationKey}' before 3X-UI update; aborting to prevent overlapping mutation.`
          );
          fenceErr.statusCode = 409;
          throw fenceErr;
        }
      }

      xuiWriteAttempted = true;
      const updateRes = await requestApiCall<any>(`/panel/api/inbounds/update/${inboundId}`, 'POST', updateInboundPayload);

      if (updateRes && updateRes.success === false) {
        const panelMsg = updateRes.msg || updateRes.message || '3X-UI panel rejected inbound update';
        console.error(`[3X-UI Provisioning] Inbound update failed on panel: ${panelMsg}`);
        throw new Error(`3X-UI provisioning failed: ${panelMsg}`);
      }

      let afterInboundObj: any = null;
      try {
        const getRes = await requestApiCall<any>(`/panel/api/inbounds/get/${inboundId}`, 'GET');
        afterInboundObj = getRes?.obj || getRes;
      } catch (getErr: any) {
        console.warn(`[3X-UI Provisioning] GET /panel/api/inbounds/get/${inboundId} notice:`, getErr?.message || getErr);
      }

      if (!afterInboundObj || typeof afterInboundObj !== 'object' || !afterInboundObj.id) {
        const allInboundsList = await getInboundsCall(true);
        afterInboundObj = allInboundsList.find((ib: any) => Number(ib.id) === Number(inboundId));
      }

      let afterSettingsObj: any = {};
      if (afterInboundObj) {
        if (typeof afterInboundObj.settings === 'string') {
          try {
            afterSettingsObj = JSON.parse(afterInboundObj.settings);
          } catch (_e) {
            afterSettingsObj = { clients: [] };
          }
        } else if (afterInboundObj.settings && typeof afterInboundObj.settings === 'object') {
          afterSettingsObj = afterInboundObj.settings;
        }
      }

      const afterClients: any[] = Array.isArray(afterSettingsObj.clients) ? afterSettingsObj.clients : [];

      const foundClient = afterClients.find((c: any) =>
        (c.id && String(c.id).trim().toLowerCase() === String(uuid).trim().toLowerCase()) ||
        (c.email && String(c.email).trim().toLowerCase() === String(remark).trim().toLowerCase())
      );

      // Immediately read back the created client from 3X-UI to verify persistence and exact UUID
      const readBackClient = await getClientByEmailCall(remark);
      if (readBackClient && readBackClient.uuid && String(readBackClient.uuid).trim().toLowerCase() === String(uuid).trim().toLowerCase()) {
        uuid = readBackClient.uuid;
        if (readBackClient.subId) subId = readBackClient.subId;
      } else if (!foundClient) {
        console.error(`[3X-UI Provisioning] Verification failed: client '${remark}' (UUID: ${uuid}) was not persisted in inbound ${inboundId}. Aborting order completion.`);
        throw new Error(`3X-UI panel update did not persist client configuration on inbound ${inboundId}. Order was not marked completed.`);
      }

      xuiWriteConfirmed = true;
      invalidateInboundCache(Number(inboundId));
    }
  );

  // Step 3: Generate the VLESS URL and subscription URL
  const vlessUrl = buildVlessLink(inbound, address, sni, uuid, remark);
  const subscriptionUrl = vlessUrl;

  // Step 4: Upsert vpn_accounts
  let vpnAccountId = '';

  const accPayload: any = {
    user_id: validUserId,
    order_id: order.id,
    email: accountEmail,
    remark: remark,
    uuid: uuid,
    vless_url: vlessUrl,
    expiry_date: new Date(expiryMs).toISOString(),
    status: 'active',
    data_limit: isTrialOrder ? '1GB' : (totalBytes > 0 ? `${totalBytes / (1024 * 1024 * 1024)}GB` : 'Unlimited'),
    updated_at: new Date().toISOString()
  };

  console.log('========== VPN ACCOUNT DECISION ==========');
  console.log('Order ID:', order.id);
  console.log('UUID:', uuid);
  console.log('isTrialOrder:', isTrialOrder);
  console.log('existingAcc:', JSON.stringify(existingAcc, null, 2));
  console.log('Will perform:', existingAcc ? 'UPDATE' : 'INSERT');
  console.log('==========================================');

  let accErr: any = null;
  if (existingAcc && existingAcc.id) {
    vpnAccountId = existingAcc.id;
    console.log('[vpn_accounts.update payload]:', JSON.stringify(accPayload, null, 2));
    const { error } = await dbClient.from('vpn_accounts').update(accPayload).eq('id', existingAcc.id);
    accErr = error;
  } else {
    const insertPayload = {
      ...accPayload,
      created_at: new Date().toISOString()
    };
    console.log('[3X-UI Provisioning DB] Inserting into vpn_accounts payload:', JSON.stringify(insertPayload, null, 2));
    const { data: newAcc, error } = await dbClient.from('vpn_accounts').insert(insertPayload).select('id').maybeSingle();
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
  if (!existingConfig && uuid) {
    const { data: cByUuid } = await dbClient.from('vpn_configs').select('id').eq('uuid', uuid).maybeSingle();
    if (cByUuid) existingConfig = cByUuid;
  }

  const configPayload: any = {
    customer_uid: validUserId,
    order_id: order.id,
    package_name: packageName,
    uuid: uuid,
    subscription_url: subscriptionUrl,
    vless_url: vlessUrl,
    inbound_id: inboundId,
    expiry_date: new Date(expiryMs).toISOString(),
    enabled: true,
    status: 'active',
    is_trial: isTrialOrder,
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

  // Step 5.5: Promote authoritative Entitlement Grant from 'provisioning' -> 'provisional' | 'verified'
  // Never mutate orders.payment_method with internal entitlement metadata.
  const nowIso = new Date().toISOString();
  const grantUpdatePayload = {
    vpn_account_id: vpnAccountId || null,
    client_uuid: uuid,
    sub_id: subId,
    inbound_id: inboundId,
    remark,
    provisional: isProvisionalActivation,
    status: isProvisionalActivation ? 'provisional' : 'verified',
    verified_at: isProvisionalActivation ? null : nowIso,
    verified_by: isProvisionalActivation ? null : (options?.adminLabel || 'Admin'),
    updated_at: nowIso,
  };

  if (grantTableAvailable) {
    let promoteErr: any = null;
    if (authoritativeGrantId) {
      const { error } = await dbClient
        .from('vpn_entitlement_grants')
        .update(grantUpdatePayload)
        .eq('id', authoritativeGrantId);
      promoteErr = error;
    } else {
      const { error } = await dbClient
        .from('vpn_entitlement_grants')
        .update(grantUpdatePayload)
        .eq('grant_type', 'new_order')
        .eq('source_id', String(order.id));
      promoteErr = error;
    }

    if (promoteErr) {
      throw new Error(`Failed to finalize authoritative vpn_entitlement_grants record: ${promoteErr.message || JSON.stringify(promoteErr)}`);
    }
  }

  // Step 6: Update orders (keeping orders.payment_method completely untouched)
  // For provisional activation, keep payment_status='Pending Verification' and status='pending'
  const ordersPayload: any = {
    payment_status: isProvisionalActivation ? (order.payment_status || 'Pending Verification') : 'Paid',
    status: isProvisionalActivation ? (order.status || 'pending') : 'completed',
    provisioning_status: isProvisionalActivation ? 'provisional' : 'completed',
    client_uuid: uuid,
    vless_url: vlessUrl,
    subscription_url: subscriptionUrl,
    expiry_date: new Date(expiryMs).toISOString(),
    is_trial: isTrialOrder,
    activated_at: nowIso,
    updated_at: nowIso
  };

  let { error: orderUpdateErr } = await dbClient.from('orders').update(ordersPayload).eq('id', order.id);
  if (orderUpdateErr && String(orderUpdateErr.message || '').includes('provisioning_status') && !isProvisionalActivation) {
    const { provisioning_status: _omitted, ...fallbackOrdersPayload } = ordersPayload;
    const retryRes = await dbClient.from('orders').update(fallbackOrdersPayload).eq('id', order.id);
    orderUpdateErr = retryRes.error;
  }

  if (orderUpdateErr) {
    console.error("[3X-UI Provisioning DB] Error updating table 'orders':", orderUpdateErr);
    throw new Error(`Database update failed for table 'orders': ${orderUpdateErr.message || JSON.stringify(orderUpdateErr)}`);
  }

  if (isProvisionalActivation) {
    if (!options?.skipSideEffects) {
      try {
        await createCustomerNotification({
          userId: validUserId,
          userEmail: order.email,
          title: 'VPN Activated (Payment Pending Verification)',
          message: `Your VPN configuration "${packageName}" is now active! Payment verification is pending admin review.`,
          type: 'vpn_created',
          orderId: order.id,
          vpnName: packageName,
        });
      } catch (provNotifErr: any) {
        console.warn('[3X-UI Provisioning DB] Provisional notification warning:', provNotifErr?.message || provNotifErr);
      }
      triggerBackgroundSyncIfNeeded('VPN Provisionally Activated', true);
    }

    if (ownsDurableLock) {
      await finalizeDurableProvisioningOperationLock({
        dbClient,
        operationKey: durableOperationKey,
        lockOwnerId: acquiredLockOwnerId,
        status: 'completed',
        clientUuid: uuid,
        metadata: {
          provisional: true,
          inboundId,
          expiryDate: new Date(expiryMs).toISOString(),
        },
      });
      ownsDurableLock = false;
    }

    return {
      success: true,
      provisional: true,
      message: skipMsg || 'VPN client provisionally activated pending payment verification',
      orderId: order.order_id || order.id,
      uuid,
      vlessUrl,
      subscriptionUrl,
      expiryDate: new Date(expiryMs).toISOString(),
      vpnAccountId,
    };
  }

  // Step 7: Create customer notification in notifications table (for final approved/completed orders)
  if (!options?.skipSideEffects) {
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
        console.log('[3X-UI Provisioning DB] Triggering Order Approved, Payment Approved, and VPN Created notifications');
        await createCustomerNotification({
          userId: validUserId,
          userEmail: order.email,
          title: 'Order Approved',
          message: `Your order for "${packageName}" has been approved!`,
          type: 'order_approved',
          orderId: order.id,
          vpnName: packageName
        });
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

      // Trigger Email Notification (non-blocking)
      if (order.email) {
        const canonicalOrderId = order.order_id || order.id;
        if (isTrialOrder) {
          sendTrialApprovedEmail({
            userEmail: order.email,
            customerName: extra.customerName || undefined,
            trialId: canonicalOrderId,
            orderId: canonicalOrderId,
            packageName,
            vlessUrl,
            expiryDate: new Date(expiryMs).toISOString(),
            userId: validUserId
          }).catch(e => console.warn('[3X-UI Provisioning DB] Trial approved email notification warning:', e));
        } else {
          sendPaymentApprovedEmail({
            userEmail: order.email,
            orderId: order.order_id || order.id,
            packageName,
            vlessUrl,
            expiryDate: new Date(expiryMs).toISOString(),
            userId: validUserId
          }).catch(e => console.warn('[3X-UI Provisioning DB] Payment approved email notification warning:', e));

          sendOrderCompletedEmail({
            userEmail: order.email,
            customerName: extra.customerName || undefined,
            orderId: order.order_id || order.id,
            packageName,
            vlessUrl,
            expiryDate: new Date(expiryMs).toISOString(),
            userId: validUserId
          }).catch(e => console.warn('[3X-UI Provisioning DB] Order completed email notification warning:', e));
        }
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

    // Trigger background synchronization asynchronously and non-blockingly
    triggerBackgroundSyncIfNeeded('VPN Created', true);
  }

  if (ownsDurableLock) {
    await finalizeDurableProvisioningOperationLock({
      dbClient,
      operationKey: durableOperationKey,
      lockOwnerId: acquiredLockOwnerId,
      status: 'completed',
      clientUuid: uuid,
    });
    ownsDurableLock = false;
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
  } catch (err: any) {
    if (ownsDurableLock && durableOperationKey && acquiredLockOwnerId) {
      await finalizeDurableProvisioningOperationLock({
        dbClient,
        operationKey: durableOperationKey,
        lockOwnerId: acquiredLockOwnerId,
        status: xuiWriteAttempted && !xuiWriteConfirmed ? 'uncertain' : 'failed',
        errorMessage: err?.message || String(err),
      });
      ownsDurableLock = false;
    }
    throw err;
  } finally {
    activeProvisionings.delete(orderId);
    if (canonicalOrderLockKey) {
      activeProvisionings.delete(canonicalOrderLockKey);
    }
  }
};

export interface RevokeProvisionalOrderClientOptions {
  adminLabel?: string;
  dbClient?: any;
  requestApiFn?: typeof requestApi;
  getInboundsFn?: typeof getInbounds;
  heldOrderLockOwnerId?: string;
}

/**
 * Mandatory Rejection Safety:
 * Revokes ONLY an unpaid provisional VPN entitlement specifically tracked in public.vpn_entitlement_grants.
 * - ZERO payment_method fallback: public.vpn_entitlement_grants is the sole authoritative ledger.
 * - Handles partial/interrupted provisional states (`status IN ('provisioning', 'provisional', 'revoke_failed')`)
 *   by reconciling live 3X-UI state and disabling any unpaid client that already exists on 3X-UI.
 * - Serializes 3X-UI writes under per-inbound durable lock (`inbound:<id>`).
 * - Performs mandatory read-back verification from 3X-UI after setting `enable: false` before marking 'revoked'.
 * - On failure, marks 'revoke_failed' in vpn_entitlement_grants & orders.provisioning_status and throws.
 */
export const revokeProvisionalOrderClient = async (
  orderId: string,
  reason: string,
  options?: RevokeProvisionalOrderClientOptions
): Promise<{
  revoked: boolean;
  skippedSafety?: boolean;
  reason?: string;
  uuid?: string;
  inboundId?: number | null;
}> => {
  const dbClient = options?.dbClient || supabaseAdmin;
  const requestApiCall = options?.requestApiFn || requestApi;
  const getInboundsCall = options?.getInboundsFn || getInbounds;

  let { data: order } = await dbClient.from('orders').select('*').eq('id', orderId).maybeSingle();
  if (!order) {
    const { data: queryOrder } = await dbClient.from('orders').select('*').eq('order_id', orderId).maybeSingle();
    order = queryOrder;
  }
  if (!order) {
    throw new Error(`Order '${orderId}' not found.`);
  }

  const durableOperationKey = `order:${order.id}`;
  let acquiredLockOwnerId = options?.heldOrderLockOwnerId || '';
  let ownsDurableLock = false;

  if (!options?.heldOrderLockOwnerId) {
    const lockRes = await acquireDurableProvisioningOperationLock({
      dbClient,
      operationKey: durableOperationKey,
      operationType: 'reject_order',
      targetId: String(order.id),
      clientUuid: order.client_uuid || null,
      metadata: { reason, adminLabel: options?.adminLabel || 'Admin' },
      requireDurableLock: isAutoActivateNewOrdersFlagEnabled(),
    });

    if (!lockRes.acquired) {
      const conflictErr: any = new Error(
        lockRes.error || 'Another provisioning, approval, or rejection operation is currently in progress for this order.'
      );
      conflictErr.statusCode = 409;
      throw conflictErr;
    }

    acquiredLockOwnerId = lockRes.lockOwnerId;
    ownsDurableLock = lockRes.tableAvailable;
  }

  let dbGrant: any = null;
  let clientUuid = '';

  const releaseOwnedLock = async (status: 'completed' | 'failed' | 'uncertain', errMsg?: string | null, metadata?: Record<string, any>) => {
    if (ownsDurableLock && acquiredLockOwnerId) {
      await finalizeDurableProvisioningOperationLock({
        dbClient,
        operationKey: durableOperationKey,
        lockOwnerId: acquiredLockOwnerId,
        status,
        clientUuid: clientUuid || null,
        errorMessage: errMsg || null,
        metadata,
      });
      ownsDurableLock = false;
    }
  };

  try {
    // Re-read fresh order INSIDE the lock
    const { data: freshOrder } = await dbClient.from('orders').select('*').eq('id', order.id).maybeSingle();
    if (freshOrder) {
      order = freshOrder;
    }

    let extra: any = {};
    if (order.payment_method && typeof order.payment_method === 'string' && order.payment_method.startsWith('{')) {
      try {
        extra = JSON.parse(order.payment_method);
      } catch (_e) {}
    }

    // Safety Check 1: Never revoke or reject if the order is already marked Paid or completed
    const payStatusLower = String(order.payment_status || '').toLowerCase().trim();
    const orderStatusLower = String(order.status || '').toLowerCase().trim();
    if (payStatusLower === 'paid' || orderStatusLower === 'completed' || orderStatusLower === 'approved') {
      await releaseOwnedLock('failed', 'Cannot revoke a paid or completed order.');
      const conflictErr: any = new Error('Order is already marked Paid/Completed. Refusing to revoke active paid VPN client.');
      conflictErr.statusCode = 409;
      throw conflictErr;
    }

    // Safety Check 2: Never disable an entire VPN client if the order was extending an existing UUID
    const extendUuid = String(extra.extend_uuid || extra.existing_uuid || extra.extendUuid || '').trim();
    if (extendUuid) {
      await releaseOwnedLock('completed');
      return {
        revoked: false,
        skippedSafety: true,
        reason: 'Order references an existing extended account (extend_uuid). Refusing to disable existing customer VPN account.',
      };
    }

    // Safety Check 3: Authoritative lookup in public.vpn_entitlement_grants ONLY (ZERO payment_method fallback!)
    const { data: grantRow, error: grantSelErr } = await dbClient
      .from('vpn_entitlement_grants')
      .select('*')
      .eq('grant_type', 'new_order')
      .eq('source_id', String(order.id))
      .maybeSingle();

    if (grantSelErr) {
      if (isMissingSchemaOrRpcError(grantSelErr) && !isAutoActivateNewOrdersFlagEnabled()) {
        // Legacy pre-migration manual rejection when auto-activation has never been enabled
        await releaseOwnedLock('completed');
        return {
          revoked: false,
          reason: 'Order was not provisionally provisioned (entitlement ledger not installed and auto-activation disabled).',
        };
      }
      throw new Error(`Authoritative vpn_entitlement_grants lookup failed: ${grantSelErr.message}`);
    }

    dbGrant = grantRow;

    if (!dbGrant) {
      await releaseOwnedLock('completed');
      return {
        revoked: false,
        skippedSafety: Boolean(order.client_uuid),
        reason: order.client_uuid
          ? 'No authoritative provisional entitlement grant exists in vpn_entitlement_grants for this order. Refusing to revoke client.'
          : 'Order was not provisionally provisioned.',
      };
    }

    if (dbGrant.status === 'revoked') {
      await releaseOwnedLock('completed');
      return {
        revoked: true,
        uuid: dbGrant.client_uuid,
        inboundId: dbGrant.inbound_id || null,
        reason: 'Provisional entitlement grant was already revoked.',
      };
    }

    const orderClientUuid = String(order.client_uuid || '').trim();
    const grantClientUuid = String(dbGrant.client_uuid || '').trim();
    clientUuid = grantClientUuid || orderClientUuid;

    const isRevocableGrantStatus =
      dbGrant.status === 'provisional' ||
      dbGrant.status === 'provisioning' ||
      dbGrant.status === 'revoke_failed';

    const uuidMatchesOrderIfSet =
      !orderClientUuid || orderClientUuid.toLowerCase() === grantClientUuid.toLowerCase();

    if (
      dbGrant.grant_type !== 'new_order' ||
      String(dbGrant.source_id) !== String(order.id) ||
      dbGrant.provisional !== true ||
      !clientUuid ||
      !uuidMatchesOrderIfSet ||
      !isRevocableGrantStatus
    ) {
      console.warn(`[Rejection Safety] Order ${order.id} grant (status=${dbGrant.status}, provisional=${dbGrant.provisional}) is not eligible for automatic revocation. Refusing to revoke client.`);
      await releaseOwnedLock('completed');
      return {
        revoked: false,
        skippedSafety: true,
        reason: 'Entitlement grant does not represent an unpaid provisional new-order client for this order. Protected client from revocation.',
      };
    }

    // Safety Check 4: Confirm no other paid/completed order is linked to this client_uuid
    const { data: otherOrders } = await dbClient
      .from('orders')
      .select('id, status, payment_status')
      .eq('client_uuid', clientUuid);

    const hasOtherPaidOrder = (otherOrders || []).some((o: any) => {
      if (String(o.id) === String(order.id)) return false;
      const st = String(o.status || '').toLowerCase().trim();
      const ps = String(o.payment_status || '').toLowerCase().trim();
      return st === 'completed' || st === 'active' || st === 'approved' || ps === 'paid';
    });

    if (hasOtherPaidOrder) {
      console.warn(`[Rejection Safety] Client UUID ${clientUuid} belongs to another paid/completed order! Refusing to revoke.`);
      await releaseOwnedLock('completed');
      return {
        revoked: false,
        skippedSafety: true,
        reason: 'Client UUID is associated with another paid/completed order. Protected existing client from revocation.',
      };
    }

    // Safety Check 5: Confirm vpn_accounts record (if present) belongs to this order
    const { data: vpnAcc } = await dbClient
      .from('vpn_accounts')
      .select('*')
      .eq('uuid', clientUuid)
      .maybeSingle();

    if (vpnAcc && vpnAcc.order_id && String(vpnAcc.order_id) !== String(order.id)) {
      console.warn(`[Rejection Safety] vpn_accounts record for ${clientUuid} has order_id=${vpnAcc.order_id} (expected ${order.id}). Refusing to revoke.`);
      await releaseOwnedLock('completed');
      return {
        revoked: false,
        skippedSafety: true,
        reason: 'VPN account belongs to a different order. Protected existing client from revocation.',
      };
    }

    // Locate target inbound ID first
    let targetInboundId = Number(dbGrant.inbound_id || 0) || null;
    if (!targetInboundId) {
      const initialInbounds = await getInboundsCall(true);
      for (const ib of initialInbounds) {
        let sObj: any = {};
        try {
          sObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings;
        } catch {
          continue;
        }
        if ((sObj?.clients || []).some((c: any) => String(c.id || '').trim().toLowerCase() === clientUuid.toLowerCase())) {
          targetInboundId = Number(ib.id);
          break;
        }
      }
    }

    if (!targetInboundId) {
      if (dbGrant.status === 'provisioning') {
        // Interrupted before client was written to 3X-UI; verify absence across all fresh inbounds
        const freshCheck = await getInboundsCall(true);
        const existsAnywhere = freshCheck.some((ib: any) => {
          try {
            const s = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings;
            return (s?.clients || []).some((c: any) => String(c.id || '').trim().toLowerCase() === clientUuid.toLowerCase());
          } catch {
            return false;
          }
        });
        if (existsAnywhere) {
          throw new Error(`Provisional client ${clientUuid} exists on 3X-UI but target inbound ID could not be determined.`);
        }
      } else {
        throw new Error(`Unable to locate inbound on 3X-UI panel for provisional client ${clientUuid}.`);
      }
    }

    const inboundId = targetInboundId;

    // Disable on 3X-UI INSIDE durable per-inbound write lock AND perform mandatory read-back verification
    if (inboundId) {
      await withInboundWriteLock(
        {
          dbClient,
          inboundId,
          targetId: String(order.id),
          clientUuid,
          requireDurableLock: true,
        },
        async (assertInboundLockStillHeld) => {
          const fetchFreshInbound = async (): Promise<any | null> => {
            try {
              const res = await requestApiCall<any>(`/panel/api/inbounds/get/${inboundId}`, 'GET');
              const obj = res?.obj || res;
              if (obj && typeof obj === 'object' && obj.id !== undefined) return obj;
            } catch (_e) {}
            const list = await getInboundsCall(true);
            return list.find((ib: any) => Number(ib.id) === Number(inboundId)) || null;
          };

          const matchedInboundObj = await fetchFreshInbound();
          if (!matchedInboundObj) {
            throw new Error(`Unable to fetch live inbound ${inboundId} from 3X-UI panel.`);
          }

          let settingsObj: any = {};
          if (typeof matchedInboundObj.settings === 'string') {
            try {
              settingsObj = JSON.parse(matchedInboundObj.settings);
            } catch (_e) {
              settingsObj = { clients: [] };
            }
          } else if (matchedInboundObj.settings && typeof matchedInboundObj.settings === 'object') {
            settingsObj = { ...matchedInboundObj.settings };
          }

          const clientsList: any[] = Array.isArray(settingsObj.clients) ? [...settingsObj.clients] : [];
          const clientIdx = clientsList.findIndex((c: any) => String(c.id || '').trim().toLowerCase() === clientUuid.toLowerCase());

          if (clientIdx >= 0) {
            // Disable the client on 3X-UI while preserving its record and credentials
            clientsList[clientIdx] = {
              ...clientsList[clientIdx],
              enable: false,
            };
            settingsObj.clients = clientsList;

            const updateInboundPayload: any = {
              ...matchedInboundObj,
              id: inboundId,
              settings: JSON.stringify(settingsObj),
            };
            delete updateInboundPayload.up;
            delete updateInboundPayload.down;
            delete updateInboundPayload.clientStats;
            delete updateInboundPayload.trafficReset;
            delete updateInboundPayload.lastTrafficResetTime;

            await assertInboundLockStillHeld();
            const updateRes = await requestApiCall<any>(`/panel/api/inbounds/update/${inboundId}`, 'POST', updateInboundPayload);
            if (updateRes && updateRes.success === false) {
              throw new Error(updateRes.msg || updateRes.message || `3X-UI rejected disabling provisional client ${clientUuid}`);
            }

            // MANDATORY READ-BACK VERIFICATION: confirm enable === false persisted on 3X-UI
            const verifiedInbound = await fetchFreshInbound();
            if (!verifiedInbound) {
              throw new Error(`Read-back verification failed: unable to re-fetch inbound ${inboundId} after disabling client ${clientUuid}.`);
            }
            let verifiedSettings: any = {};
            try {
              verifiedSettings = typeof verifiedInbound.settings === 'string'
                ? JSON.parse(verifiedInbound.settings)
                : verifiedInbound.settings || {};
            } catch {
              verifiedSettings = {};
            }
            const verifiedClient = (Array.isArray(verifiedSettings.clients) ? verifiedSettings.clients : []).find(
              (c: any) => String(c.id || '').trim().toLowerCase() === clientUuid.toLowerCase()
            );

            if (!verifiedClient || verifiedClient.enable !== false) {
              throw new Error(
                `Read-back verification failed for provisional client ${clientUuid} on inbound ${inboundId}: expected enable=false, got ${String(verifiedClient?.enable)}.`
              );
            }
            invalidateInboundCache(inboundId);
          } else if (dbGrant.status !== 'provisioning') {
            // Client missing on expected inbound; double-check across all inbounds so we don't miss a moved client
            const allFresh = await getInboundsCall(true);
            const stillEnabledElsewhere = allFresh.some((ib: any) => {
              try {
                const s = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings;
                return (s?.clients || []).some(
                  (c: any) => String(c.id || '').trim().toLowerCase() === clientUuid.toLowerCase() && c.enable !== false
                );
              } catch {
                return false;
              }
            });
            if (stillEnabledElsewhere) {
              throw new Error(`Provisional client ${clientUuid} is still enabled on another inbound; refusing to mark revoked.`);
            }
          }
        }
      );
    }

    const nowIso = new Date().toISOString();

    // Update vpn_accounts and vpn_configs to disabled
    if (vpnAcc?.id) {
      await dbClient
        .from('vpn_accounts')
        .update({
          status: 'disabled',
          updated_at: nowIso,
        })
        .eq('id', vpnAcc.id);
    }

    await dbClient
      .from('vpn_configs')
      .update({
        enabled: false,
        status: 'disabled',
      })
      .eq('order_id', order.id)
      .eq('uuid', clientUuid);

    // Update authoritative vpn_entitlement_grants to revoked
    const { error: revokeGrantErr } = await dbClient
      .from('vpn_entitlement_grants')
      .update({
        status: 'revoked',
        revoked_at: nowIso,
        revoked_by: options?.adminLabel || 'Admin',
        revoke_reason: reason,
        last_error: null,
        updated_at: nowIso,
      })
      .eq('id', dbGrant.id);

    if (revokeGrantErr) {
      throw new Error(`Failed to mark vpn_entitlement_grants revoked: ${revokeGrantErr.message}`);
    }

    // Update orders.provisioning_status without touching orders.payment_method
    await dbClient
      .from('orders')
      .update({
        provisioning_status: 'revoked',
        updated_at: nowIso,
      })
      .eq('id', order.id);

    await releaseOwnedLock('completed', null, { revoked: true, inboundId, reason });
    invalidateInboundCache(inboundId);

    return {
      revoked: true,
      uuid: clientUuid,
      inboundId,
    };
  } catch (err: any) {
    // Do NOT overwrite 409 conflict (e.g., already paid order) with revoke_failed
    if (err?.statusCode === 409) {
      await releaseOwnedLock('failed', err?.message || String(err));
      throw err;
    }

    // Retain recoverable 'revoke_failed' state in vpn_entitlement_grants & orders.provisioning_status (NEVER mutate payment_method)
    const nowIso = new Date().toISOString();
    const errText = err?.message || String(err);

    if (dbGrant?.id) {
      try {
        await dbClient
          .from('vpn_entitlement_grants')
          .update({
            status: 'revoke_failed',
            last_error: errText,
            updated_at: nowIso,
          })
          .eq('id', dbGrant.id);
      } catch (_e) {}
    }

    try {
      await dbClient
        .from('orders')
        .update({
          provisioning_status: 'revoke_failed',
          updated_at: nowIso,
        })
        .eq('id', order.id);
    } catch (_e) {}

    await releaseOwnedLock('failed', errText);

    throw new Error(`Failed to disable provisional VPN client on 3X-UI (order retained in recoverable 'revoke_failed' state): ${errText}`);
  }
};

export const disable3XUiClient = async (inboundId: number | null, uuid: string, email?: string): Promise<boolean> => {
  const executeDisable = async (): Promise<boolean> => {
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
            invalidateInboundCache(inboundId);
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
            if (res.data && (res.data.success || res.status === 200)) {
              invalidateInboundCache(inboundId);
              return true;
            }
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

  let resolvedInboundId = inboundId && Number(inboundId) > 0 ? Number(inboundId) : null;
  if (!resolvedInboundId && (uuid || email)) {
    try {
      const inbounds = await getCachedInbounds();
      for (const ib of inbounds) {
        const settingsObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : (ib.settings || {});
        const clients: any[] = Array.isArray(settingsObj?.clients) ? settingsObj.clients : [];
        const match = clients.find(
          (c: any) =>
            (uuid && String(c.id || '').trim().toLowerCase() === uuid.trim().toLowerCase()) ||
            (email && String(c.email || '').trim().toLowerCase() === email.trim().toLowerCase())
        );
        if (match && Number(ib.id) > 0) {
          resolvedInboundId = Number(ib.id);
          break;
        }
      }
    } catch {
      // Non-blocking resolution
    }
  }

  if (resolvedInboundId && resolvedInboundId > 0) {
    try {
      return await withInboundWriteLock(
        {
          dbClient: supabaseAdmin,
          inboundId: resolvedInboundId,
          targetId: `disable:${uuid}`,
          clientUuid: uuid,
          requireDurableLock: isAutoActivateNewOrdersFlagEnabled(),
        },
        async (assertInboundLockStillHeld) => {
          await assertInboundLockStillHeld();
          return executeDisable();
        }
      );
    } catch (lockErr: any) {
      console.warn(`[3X-UI] Inbound lock warning in disable3XUiClient(${uuid}):`, lockErr?.message || lockErr);
      return false;
    }
  }

  return executeDisable();
};

let lastCleanupTime = 0;

export const cleanupExpiredTrials = async (inboundsList?: XuiInbound[]): Promise<{ count: number }> => {
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

    // 3. Get inbounds
    const inbounds = inboundsList || await getCachedInbounds();

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
        const currentStatus = String(cfg.status || '').toLowerCase();
        const isAlreadyExpired = currentStatus === 'expired' || cfg.enabled === false;

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
        const currentStatus = String(acc.status || '').toLowerCase();
        const isAlreadyExpired = currentStatus === 'expired' || acc.enable === false;

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

    const cfgIdsToExpire: string[] = [];
    const accOrderIdsToExpire: string[] = [];
    const ordIdsToExpire: string[] = [];

    for (const trial of candidateTrials) {
      let isExpiredByTime = false;
      let isExpiredByData = false;

      // Trial expires only when current_time >= expires_at + grace_period
      if (trial.expiryMs) {
        if (now >= trial.expiryMs + TRIAL_GRACE_PERIOD_MS) {
          isExpiredByTime = true;
        }
      }

      // Or when user reaches the 1 GB data limit
      const ONE_GB_BYTES = 1073741824;
      let usedBytes = 0;

      if (inbounds && inbounds.length > 0 && trial.uuid) {
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
        let removedSuccessfully = true;
        if (trial.uuid) {
          try {
            removedSuccessfully = await disable3XUiClient(trial.inboundId, trial.uuid, trial.email);
          } catch (err: any) {
            removedSuccessfully = false;
            console.error(`[Trial Expiry Scheduler] Error removing client ${trial.uuid} from 3X-UI:`, err.message || err);
          }
        }

        if (!removedSuccessfully) {
          console.warn(`[Trial Expiry Scheduler] 3X-UI removal failed for UUID: ${trial.uuid}. Skipping DB update.`);
          continue;
        }

        if (trial.type === 'config' || trial.id) {
          cfgIdsToExpire.push(trial.id);
        }
        if (trial.orderId) {
          accOrderIdsToExpire.push(trial.orderId);
          ordIdsToExpire.push(trial.orderId);
        }

        // Create customer notification
        const targetUserId = trial.customerUid;
        const targetEmail = trial.email;

        if (targetUserId) {
          const { data: existingNotifs } = await dbClient
            .from('notifications')
            .select('id')
            .eq('type', 'trial_expired')
            .eq('user_id', targetUserId)
            .maybeSingle();

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
            } catch (notifCreateErr: any) {
              console.error(`[Trial Expiry Scheduler] Error creating notification:`, notifCreateErr.message || notifCreateErr);
            }

            // Also send expiration email non-blockingly
            (async () => {
              let resolvedEmail = targetEmail;
              if (!resolvedEmail && targetUserId) {
                const { data: prof } = await dbClient.from('profiles').select('email').eq('id', targetUserId).maybeSingle();
                resolvedEmail = prof?.email || '';
              }
              if (resolvedEmail && resolvedEmail.includes('@')) {
                await sendVpnExpiredEmail({
                  userEmail: resolvedEmail,
                  vpnAccountId: trial.uuid || trial.id,
                  packageName: trial.packageName,
                  expiryDate: trial.expiryMs ? new Date(trial.expiryMs).toISOString() : undefined,
                  userId: targetUserId
                });
              }
            })().catch(emailErr => {
              console.warn('[Trial Expiry Scheduler] Trial expired email warning:', emailErr?.message || emailErr);
            });
          }
        }

        expiredCount++;
      }
    }

    // Perform bulk database updates
    const expirationTimeIso = new Date().toISOString();

    if (cfgIdsToExpire.length > 0) {
      console.log(`[Trial Expiry Scheduler] Bulk updating ${cfgIdsToExpire.length} vpn_configs to 'expired'...`);
      const { error: cfgErr } = await dbClient
        .from('vpn_configs')
        .update({ status: 'expired', enabled: false, updated_at: expirationTimeIso })
        .in('id', cfgIdsToExpire);
      if (cfgErr) console.error('[Trial Expiry Scheduler] Bulk update error for vpn_configs:', cfgErr.message || cfgErr);
    }

    if (accOrderIdsToExpire.length > 0) {
      console.log(`[Trial Expiry Scheduler] Bulk updating ${accOrderIdsToExpire.length} vpn_accounts to 'expired'...`);
      const { error: accErr } = await dbClient
        .from('vpn_accounts')
        .update({ status: 'expired', enable: false, updated_at: expirationTimeIso })
        .in('order_id', accOrderIdsToExpire);
      if (accErr) console.error('[Trial Expiry Scheduler] Bulk update error for vpn_accounts:', accErr.message || accErr);
    }

    if (ordIdsToExpire.length > 0) {
      console.log(`[Trial Expiry Scheduler] Bulk updating ${ordIdsToExpire.length} orders to 'expired'...`);
      const { error: ordErr } = await dbClient
        .from('orders')
        .update({ status: 'expired', payment_status: 'Expired', updated_at: expirationTimeIso })
        .in('id', ordIdsToExpire);
      if (ordErr) console.error('[Trial Expiry Scheduler] Bulk update error for orders by id:', ordErr.message || ordErr);

      const { error: ordErr2 } = await dbClient
        .from('orders')
        .update({ status: 'expired', payment_status: 'Expired', updated_at: expirationTimeIso })
        .in('order_id', ordIdsToExpire);
      if (ordErr2) console.error('[Trial Expiry Scheduler] Bulk update error for orders by order_id:', ordErr2.message || ordErr2);
    }

  } catch (err) {
    console.error('[Cleanup Expired Trials] Error during trial cleanup execution:', err);
  }

  return { count: expiredCount };
};

// In-memory cache for 3X-UI inbounds metadata to avoid 3X-UI network calls on user HTTP requests

export const setCachedInbounds = (inbounds: XuiInbound[]): void => {
  if (Array.isArray(inbounds)) {
    cachedInbounds = inbounds;
    lastInboundsCacheTime = Date.now();
  }
};

export const getCachedInbounds = async (): Promise<XuiInbound[]> => {
  return cachedInbounds;
};

let isSyncInProgress = false;
let lastSyncAt = 0;

export const triggerBackgroundSyncIfNeeded = (reason: string = 'Scheduled', force: boolean = false): void => {
  const now = Date.now();
  const TEN_MINUTES_MS = 10 * 60 * 1000; // 10 minutes cooldown

  if (!force && (now - lastSyncAt < TEN_MINUTES_MS)) {
    console.log(`[Background Sync] Skipped (recent sync ${Math.round((now - lastSyncAt)/1000)}s ago)`);
    return;
  }

  if (isSyncInProgress) {
    console.log('[Background Sync] Skipped (sync already in progress)');
    return;
  }

  // Trigger asynchronously without awaiting
  runBackgroundSync(reason, force).catch((err) => {
    console.error(`[Background Sync] Failed for reason "${reason}":`, err.message || err);
  });
};

export const runBackgroundSync = async (reason: string = 'Scheduled', force: boolean = false): Promise<void> => {
  if (isSyncInProgress) {
    console.log('[Background Sync] Skipped (sync already in progress)');
    return;
  }
  isSyncInProgress = true;
  console.log(`[Background Sync] Synchronization started (Reason: ${reason})`);
  const syncStartTime = Date.now();

  try {
    // 1. Fetch live 3X-UI inbounds once and cache them in memory for metadata/stats.
    const inbounds = await getInbounds(force);

    // 2. Run trial cleanup & authoritative uncached deleted-client sync
    // NEVER pass cached inbounds into syncDeleted3XUiClients — it always performs fresh uncached panel reads.
    const trialCleanupResult = await cleanupExpiredTrials();

    let deletedCount = 0;
    const syncResult = await syncDeleted3XUiClients();
    deletedCount = syncResult.deletedCount;

    // 3. Run scheduled VPN expiry reminder & expiration email check (non-blocking)
    runScheduledExpiryEmailCheck().catch(expErr => {
      console.warn('[Background Sync] Scheduled expiry email check warning:', expErr?.message || expErr);
    });

    lastSyncAt = Date.now();
    const durationSec = ((Date.now() - syncStartTime) / 1000).toFixed(1);
    
    // Fetch total active orders count from orders for the summary
    let ordersCount = 0;
    try {
      const { count } = await supabaseAdmin
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .in('status', ['active', 'trial', 'pending']);
      ordersCount = count || 0;
    } catch (e) {}

    // Count client stats in inbounds
    let clientsCount = 0;
    if (inbounds && inbounds.length > 0) {
      for (const ib of inbounds) {
        let settingsObj: any = {};
        try {
          if (ib.settings) settingsObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings;
        } catch (e) {}
        const clients = settingsObj.clients || [];
        clientsCount += clients.length;
      }
    }

    console.log(`Synchronization completed`);
    console.log(`Reason: ${reason}`);
    console.log(`Orders scanned: ${ordersCount}`);
    console.log(`Clients found: ${clientsCount}`);
    console.log(`Expired clients: ${trialCleanupResult.count}`);
    console.log(`Database updates: ${trialCleanupResult.count + deletedCount}`);
    console.log(`Completed in: ${durationSec} seconds`);

  } catch (error: any) {
    console.error('[Background Sync] Failed:', error.message || error);
  } finally {
    isSyncInProgress = false;
  }
};

export interface StrictParsedInbound {
  inbound: XuiInbound;
  inboundId: number;
  clients: XuiClient[];
  clientUuidSet: Set<string>;
}

export type UncachedInboundReadResult =
  | { status: 'found'; inbound: XuiInbound; clients: XuiClient[]; clientUuidSet: Set<string> }
  | { status: 'not_found' }
  | { status: 'error'; reason: string };

export interface UncachedInboundsListReadResult {
  ok: boolean;
  reason?: string;
  inbounds: XuiInbound[];
  parsedByInboundId: Map<number, StrictParsedInbound>;
  unparsedInboundIds: number[];
  allInboundsCleanlyParsed: boolean;
  liveClientByUuid: Map<string, { inbound: XuiInbound; client: XuiClient; stat: XuiClientStat | null }>;
}

export interface PanelIdentityVerificationInput {
  currentPanelIdentity: string;
  recordPanelIdentity?: string | null;
  recordServerId?: string | null;
  recordInboundId?: number | null;
  recordOwnerUid?: string | null;
  recordOwnerEmail?: string | null;
  configuredServers?: Array<{ id: string; panel_url?: string | null; is_active?: boolean | null }>;
}

export interface PanelIdentityVerificationResult {
  ok: boolean;
  code:
    | 'matched_explicit_panel_identity'
    | 'matched_server_id'
    | 'matched_single_panel_legacy'
    | 'missing_current_panel_identity'
    | 'missing_customer_ownership'
    | 'missing_inbound_id'
    | 'wrong_panel_identity'
    | 'ambiguous_panel_identity';
  reason: string;
}

export interface VerifyAndMarkDeletedParams {
  clientUuid: string;
  inboundId: number | null;
  userId?: string | null;
  userEmail?: string | null;
  recordPanelIdentity?: string | null;
  recordServerId?: string | null;
  createdAt?: string | null;
  existingStatus?: string | null;
  deletedFromPanelAt?: string | null;
  source?: 'background_sync' | 'customer_read' | 'admin_sync';
  dbClient?: any;
  currentPanelIdentity?: string;
  configuredServers?: Array<{ id: string; panel_url?: string | null; is_active?: boolean | null }>;
  fetchUncachedInbound?: (inboundId: number) => Promise<UncachedInboundReadResult>;
  fetchUncachedInboundsList?: () => Promise<UncachedInboundsListReadResult>;
  reReadDelayMs?: number;
  nowMs?: number;
}

export interface VerifyAndMarkDeletedResult {
  confirmedDeleted: boolean;
  alreadyDeleted?: boolean;
  applied?: boolean;
  reconciliationRequired?: boolean;
  unresolvedGrantCount?: number;
  auditLogged?: boolean;
  manualReviewFlagged?: boolean;
  dbWrites: number;
  reason: string;
}

export interface SyncDeletedClientsOptions {
  dbClient?: any;
  currentPanelIdentity?: string;
  configuredServers?: Array<{ id: string; panel_url?: string | null; is_active?: boolean | null }>;
  fetchUncachedInbound?: (inboundId: number) => Promise<UncachedInboundReadResult>;
  fetchUncachedInboundsList?: () => Promise<UncachedInboundsListReadResult>;
  reReadDelayMs?: number;
  nowMs?: number;
}

export interface SyncDeletedClientsResult {
  synced: boolean;
  deletedCount: number;
  restoredCount: number;
  skippedCount: number;
  manualReviewCount: number;
  reconciliationFlaggedCount: number;
  details?: Array<{ clientUuid: string; outcome: string; reason: string }>;
}

/**
 * Strictly parses inbound.settings.clients[].
 * Never uses clientStats as proof of client existence and rejects malformed JSON or missing arrays.
 */
export const parseInboundSettingsClientsStrict = (
  inbound: any
): { ok: true; inboundId: number; clients: XuiClient[]; clientUuidSet: Set<string> } | { ok: false; reason: string } => {
  if (!inbound || typeof inbound !== 'object') {
    return { ok: false, reason: 'inbound_not_object' };
  }
  const inboundId = Number(inbound.id);
  if (!Number.isInteger(inboundId) || inboundId <= 0) {
    return { ok: false, reason: 'invalid_inbound_id' };
  }
  if (inbound.settings === null || inbound.settings === undefined) {
    return { ok: false, reason: 'missing_settings' };
  }

  let parsedSettings: any = null;
  if (typeof inbound.settings === 'string') {
    const trimmed = inbound.settings.trim();
    if (!trimmed) {
      return { ok: false, reason: 'empty_settings_string' };
    }
    try {
      parsedSettings = JSON.parse(trimmed);
    } catch {
      return { ok: false, reason: 'malformed_settings_json' };
    }
  } else if (typeof inbound.settings === 'object') {
    parsedSettings = inbound.settings;
  } else {
    return { ok: false, reason: 'invalid_settings_type' };
  }

  if (!parsedSettings || typeof parsedSettings !== 'object' || !Array.isArray(parsedSettings.clients)) {
    return { ok: false, reason: 'missing_clients_array' };
  }

  const clients: XuiClient[] = parsedSettings.clients;
  const clientUuidSet = new Set<string>();
  for (const c of clients) {
    if (c && typeof c === 'object' && typeof c.id === 'string' && c.id.trim()) {
      clientUuidSet.add(c.id.trim().toLowerCase());
    }
  }

  return { ok: true, inboundId, clients, clientUuidSet };
};

/**
 * Performs a fresh, uncached live read of a single 3X-UI inbound via /panel/api/inbounds/get/{id}.
 * Never reads liveInboundCache or cachedInbounds.
 */
export const fetchUncachedLiveInboundById = async (
  inboundId: number
): Promise<UncachedInboundReadResult> => {
  const normalizedId = Number(inboundId);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
    return { status: 'error', reason: 'invalid_inbound_id' };
  }

  try {
    const res = await requestApi<any>(`/panel/api/inbounds/get/${normalizedId}`, 'GET');
    const inbound = res && typeof res === 'object' && 'obj' in res ? res.obj : res;

    if (inbound === null || inbound === undefined) {
      return { status: 'not_found' };
    }

    if (typeof inbound !== 'object') {
      return { status: 'error', reason: 'malformed_inbound_payload' };
    }

    if (Number(inbound.id) !== normalizedId) {
      return { status: 'error', reason: 'inbound_id_mismatch' };
    }

    const parsed = parseInboundSettingsClientsStrict(inbound);
    if ('reason' in parsed) {
      return { status: 'error', reason: parsed.reason };
    }

    return {
      status: 'found',
      inbound: inbound as XuiInbound,
      clients: parsed.clients,
      clientUuidSet: parsed.clientUuidSet,
    };
  } catch (err: any) {
    return {
      status: 'error',
      reason: err?.message || 'network_or_panel_error',
    };
  }
};

/**
 * Performs a fresh, uncached live read of all 3X-UI inbounds via /panel/api/inbounds/list.
 * Never reads or returns cachedInbounds on error.
 */
export const fetchUncachedLiveInboundsList = async (): Promise<UncachedInboundsListReadResult> => {
  try {
    const rawList = await requestApi<XuiInbound[]>('/panel/api/inbounds/list', 'GET');
    if (!Array.isArray(rawList)) {
      return {
        ok: false,
        reason: 'non_array_inbounds_response',
        inbounds: [],
        parsedByInboundId: new Map(),
        unparsedInboundIds: [],
        allInboundsCleanlyParsed: false,
        liveClientByUuid: new Map(),
      };
    }

    const parsedByInboundId = new Map<number, StrictParsedInbound>();
    const unparsedInboundIds: number[] = [];
    const liveClientByUuid = new Map<string, { inbound: XuiInbound; client: XuiClient; stat: XuiClientStat | null }>();

    for (const ib of rawList) {
      const parsed = parseInboundSettingsClientsStrict(ib);
      if (!parsed.ok) {
        const rawId = Number(ib?.id);
        unparsedInboundIds.push(Number.isInteger(rawId) && rawId > 0 ? rawId : -1);
        continue;
      }

      parsedByInboundId.set(parsed.inboundId, {
        inbound: ib,
        inboundId: parsed.inboundId,
        clients: parsed.clients,
        clientUuidSet: parsed.clientUuidSet,
      });

      const stats = Array.isArray(ib.clientStats) ? ib.clientStats : [];
      for (const c of parsed.clients) {
        const normUuid = String(c?.id || '').trim().toLowerCase();
        if (!normUuid) continue;
        const cEmail = String(c?.email || '').trim().toLowerCase();
        const stat =
          stats.find((s: any) => s && s.email && String(s.email).trim().toLowerCase() === cEmail) ||
          null;
        liveClientByUuid.set(normUuid, { inbound: ib, client: c, stat });
      }
    }

    return {
      ok: true,
      inbounds: rawList,
      parsedByInboundId,
      unparsedInboundIds,
      allInboundsCleanlyParsed: unparsedInboundIds.length === 0,
      liveClientByUuid,
    };
  } catch (err: any) {
    return {
      ok: false,
      reason: err?.message || 'panel_unreachable',
      inbounds: [],
      parsedByInboundId: new Map(),
      unparsedInboundIds: [],
      allInboundsCleanlyParsed: false,
      liveClientByUuid: new Map(),
    };
  }
};

/**
 * Verifies panel identity, customer ownership, and inbound association strictly.
 * Never uses VLESS hostnames, CDN domains, SNI, or server display names.
 */
export const verifyRecordPanelIdentity = (
  input: PanelIdentityVerificationInput
): PanelIdentityVerificationResult => {
  const currentPanelId = String(input.currentPanelIdentity || '').trim();
  if (!currentPanelId) {
    return {
      ok: false,
      code: 'missing_current_panel_identity',
      reason: 'Active 3X-UI panel identity could not be resolved.',
    };
  }

  const ownerUid = String(input.recordOwnerUid || '').trim();
  if (!ownerUid) {
    return {
      ok: false,
      code: 'missing_customer_ownership',
      reason: 'VPN record is missing verified customer user_id ownership.',
    };
  }

  const inboundId = Number(input.recordInboundId);
  if (!Number.isInteger(inboundId) || inboundId <= 0) {
    return {
      ok: false,
      code: 'missing_inbound_id',
      reason: 'VPN record is missing an authoritative inbound_id.',
    };
  }

  const recordPanelId = String(input.recordPanelIdentity || '').trim();
  if (recordPanelId) {
    if (recordPanelId !== currentPanelId) {
      return {
        ok: false,
        code: 'wrong_panel_identity',
        reason: `Record panel_identity (${recordPanelId}) does not match active panel (${currentPanelId}).`,
      };
    }
    return {
      ok: true,
      code: 'matched_explicit_panel_identity',
      reason: 'Exact panel_identity match verified.',
    };
  }

  const configuredServers = Array.isArray(input.configuredServers) ? input.configuredServers : [];
  const recordServerId = String(input.recordServerId || '').trim();
  if (recordServerId) {
    const matchedServer = configuredServers.find((s) => String(s?.id || '').trim() === recordServerId);
    if (!matchedServer || !matchedServer.panel_url) {
      return {
        ok: false,
        code: 'ambiguous_panel_identity',
        reason: `Record references server_id '${recordServerId}' whose panel URL cannot be resolved.`,
      };
    }
    const serverPanelId = computePanelIdentity(matchedServer.panel_url);
    if (!serverPanelId || serverPanelId !== currentPanelId) {
      return {
        ok: false,
        code: 'wrong_panel_identity',
        reason: `Record server_id '${recordServerId}' belongs to a different panel (${serverPanelId || 'unknown'}) than active panel (${currentPanelId}).`,
      };
    }
    return {
      ok: true,
      code: 'matched_server_id',
      reason: 'Server ID resolved unambiguously to active panel identity.',
    };
  }

  // Legacy row without panel_identity or server_id: ONLY allow if no configured active server points to a different panel.
  const distinctExternalPanel = configuredServers.find((s) => {
    if (s?.is_active === false) return false;
    if (!s?.panel_url) return false;
    const pid = computePanelIdentity(s.panel_url);
    return Boolean(pid && pid !== currentPanelId);
  });

  if (distinctExternalPanel) {
    return {
      ok: false,
      code: 'ambiguous_panel_identity',
      reason: 'Multiple 3X-UI panels are configured and legacy record has no explicit panel_identity or server_id.',
    };
  }

  return {
    ok: true,
    code: 'matched_single_panel_legacy',
    reason: 'Single-panel deployment with verified customer ownership and authoritative inbound_id.',
  };
};

const loadConfiguredXuiServers = async (
  dbClient: any
): Promise<Array<{ id: string; panel_url?: string | null; is_active?: boolean | null }>> => {
  if (!dbClient || typeof dbClient.from !== 'function') return [];
  try {
    const { data, error } = await dbClient
      .from('xui_servers')
      .select('id, panel_url, is_active');
    if (error || !Array.isArray(data)) return [];
    return data;
  } catch {
    return [];
  }
};

const recordDeduplicatedSyncAuditLog = async (params: {
  dbClient: any;
  userId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, any>;
  dedupeWindowHours?: number;
}): Promise<boolean> => {
  const { dbClient, userId, action, targetType, targetId, details } = params;
  const dedupeWindowHours = params.dedupeWindowHours ?? 24;
  if (!dbClient || typeof dbClient.from !== 'function') return false;

  try {
    const cutoffIso = new Date(Date.now() - dedupeWindowHours * 60 * 60 * 1000).toISOString();
    const { data: existing } = await dbClient
      .from('audit_logs')
      .select('id')
      .eq('action', action)
      .eq('target_type', targetType)
      .eq('target_id', targetId)
      .gte('created_at', cutoffIso)
      .limit(1);

    if (Array.isArray(existing) && existing.length > 0) {
      return false;
    }

    const { error: insertErr } = await dbClient.from('audit_logs').insert({
      user_id: userId || null,
      action,
      target_type: targetType,
      target_id: targetId,
      details,
    });
    return !insertErr;
  } catch {
    return false;
  }
};

/**
 * Authoritative, lock-coordinated, fresh uncached two-read deletion verifier and marker.
 *
 * Guarantees:
 * - Never treats stale caches, clientStats IDs, network errors, timeouts, malformed JSON,
 *   or incomplete inbound payloads as evidence of deletion.
 * - Requires reliable panel identity, customer ownership, and authoritative inbound association.
 * - Acquires durable client (`client:<uuid>`) then inbound (`inbound:<inboundId>`) locks
 *   in the established lock order with `allowUncertainRecovery: false` (never steals/forces locks).
 * - Performs TWO independent fresh, uncached reads inside the locks before marking deleted.
 * - Updates DB ONLY atomically and idempotently via `mark_vpn_client_panel_deleted` RPC.
 *   If the atomic RPC is missing, unavailable, returns an error, or returns a skip_reason,
 *   deletion synchronization fails CLOSED with ZERO independent database updates.
 * - Never mutates historical financial records (`orders`, `renew_requests`, `payment_receipt_claims`, `vpn_entitlement_grants`).
 */
export const verifyAndMarkClientDeletedIfConfirmed = async (
  params: VerifyAndMarkDeletedParams
): Promise<VerifyAndMarkDeletedResult> => {
  const normUuid = String(params.clientUuid || '').trim().toLowerCase();
  if (!normUuid) {
    return { confirmedDeleted: false, dbWrites: 0, reason: 'missing_client_uuid' };
  }

  // Never resurrect or re-write an already confirmed deleted configuration
  const existingStatus = String(params.existingStatus || '').trim().toLowerCase();
  if (existingStatus === 'deleted' || Boolean(params.deletedFromPanelAt)) {
    return {
      confirmedDeleted: true,
      alreadyDeleted: true,
      applied: false,
      dbWrites: 0,
      reason: 'already_deleted',
    };
  }

  const nowMs = params.nowMs ?? Date.now();
  const RECENT_PROVISION_GRACE_MS = 60 * 1000;
  if (params.createdAt) {
    const createdAtMs = new Date(params.createdAt).getTime();
    if (!Number.isNaN(createdAtMs) && nowMs - createdAtMs < RECENT_PROVISION_GRACE_MS) {
      return {
        confirmedDeleted: false,
        dbWrites: 0,
        reason: 'recent_provision_grace_period',
      };
    }
  }

  const dbClient = params.dbClient || supabaseAdmin;
  let currentPanelIdentity = String(params.currentPanelIdentity || '').trim();
  if (!currentPanelIdentity) {
    try {
      currentPanelIdentity = await getCurrentPanelIdentity();
    } catch {
      return {
        confirmedDeleted: false,
        dbWrites: 0,
        reason: 'panel_identity_unavailable',
      };
    }
  }

  const configuredServers =
    params.configuredServers !== undefined
      ? params.configuredServers
      : await loadConfiguredXuiServers(dbClient);

  const identityCheck = verifyRecordPanelIdentity({
    currentPanelIdentity,
    recordPanelIdentity: params.recordPanelIdentity,
    recordServerId: params.recordServerId,
    recordInboundId: params.inboundId,
    recordOwnerUid: params.userId,
    recordOwnerEmail: params.userEmail,
    configuredServers,
  });

  if (!identityCheck.ok) {
    const auditAction =
      identityCheck.code === 'wrong_panel_identity'
        ? 'panel_deletion_wrong_panel_identity'
        : 'panel_deletion_ambiguous_identity';

    await recordDeduplicatedSyncAuditLog({
      dbClient,
      userId: params.userId || null,
      action: auditAction,
      targetType: 'vpn_client',
      targetId: normUuid,
      details: {
        client_uuid: normUuid,
        inbound_id: params.inboundId ?? null,
        current_panel_identity: currentPanelIdentity || null,
        record_panel_identity: params.recordPanelIdentity || null,
        record_server_id: params.recordServerId || null,
        code: identityCheck.code,
        reason: identityCheck.reason,
        source: params.source || 'background_sync',
      },
    });

    return {
      confirmedDeleted: false,
      manualReviewFlagged: true,
      dbWrites: 0,
      reason: identityCheck.code,
    };
  }

  const inboundId = Number(params.inboundId);
  const readInbound = params.fetchUncachedInbound || fetchUncachedLiveInboundById;
  const readList = params.fetchUncachedInboundsList || fetchUncachedLiveInboundsList;
  const reReadDelayMs = params.reReadDelayMs ?? 150;

  // Verify fresh uncached absence for a single read pass
  const performSingleAuthoritativeAbsenceRead = async (
    readLabel: 'read1' | 'read2'
  ): Promise<{ absent: boolean; reason: string; inboundMissing?: boolean }> => {
    const directRes = await readInbound(inboundId);
    if (directRes.status === 'error') {
      return { absent: false, reason: `${readLabel}_error:${directRes.reason}` };
    }

    if (directRes.status === 'found') {
      if (directRes.clientUuidSet.has(normUuid)) {
        return { absent: false, reason: `${readLabel}_client_present` };
      }
      return { absent: true, reason: `${readLabel}_confirmed_absent_from_inbound` };
    }

    // directRes.status === 'not_found': NEVER assume deletion from an empty get/{id} alone!
    // Require a fresh, uncached, 100%-cleanly-parsed non-empty /inbounds/list confirming that
    // the inbound truly does not exist AND the client UUID does not exist on any other inbound.
    const listRes = await readList();
    if (!listRes.ok || !listRes.allInboundsCleanlyParsed || listRes.inbounds.length === 0) {
      return {
        absent: false,
        reason: `${readLabel}_inbound_missing_unverified_list:${listRes.reason || 'incomplete_or_empty_list'}`,
      };
    }

    if (listRes.parsedByInboundId.has(inboundId)) {
      const ibEntry = listRes.parsedByInboundId.get(inboundId)!;
      if (ibEntry.clientUuidSet.has(normUuid)) {
        return { absent: false, reason: `${readLabel}_client_present_in_list` };
      }
      return { absent: true, reason: `${readLabel}_confirmed_absent_from_list_inbound` };
    }

    if (listRes.liveClientByUuid.has(normUuid)) {
      return { absent: false, reason: `${readLabel}_client_moved_to_another_inbound` };
    }

    return { absent: true, inboundMissing: true, reason: `${readLabel}_inbound_and_client_confirmed_absent` };
  };

  // Acquire durable locks in the established order: client:<uuid> -> inbound:<inboundId>
  // NEVER force-release or steal existing/uncertain locks (allowUncertainRecovery: false).
  try {
    return await withClientMutationLock(
      {
        dbClient,
        clientUuid: normUuid,
        operationType: 'client_lock',
        targetId: `panel-delete-sync:${normUuid}`,
        requireDurableLock: true,
        allowUncertainRecovery: false,
        metadata: {
          syncSource: params.source || 'background_sync',
          inboundId,
          panelIdentity: currentPanelIdentity,
        },
      },
      async (assertClientLockStillHeld) => {
        return await withInboundWriteLock(
          {
            dbClient,
            inboundId,
            targetId: `panel-delete-sync:${normUuid}`,
            clientUuid: normUuid,
            requireDurableLock: true,
            allowUncertainRecovery: false,
            maxWaitMs: 2000,
          },
          async (assertInboundLockStillHeld) => {
            await assertClientLockStillHeld();
            await assertInboundLockStillHeld();

            // Fresh uncached Read 1
            const read1 = await performSingleAuthoritativeAbsenceRead('read1');
            if (!read1.absent) {
              return {
                confirmedDeleted: false,
                dbWrites: 0,
                reason: read1.reason,
              };
            }

            if (reReadDelayMs > 0) {
              await new Promise((r) => setTimeout(r, reReadDelayMs));
            }

            // Re-fence both locks right before Read 2 and DB commit
            await assertClientLockStillHeld();
            await assertInboundLockStillHeld();

            // Fresh uncached Read 2
            const read2 = await performSingleAuthoritativeAbsenceRead('read2');
            if (!read2.absent) {
              return {
                confirmedDeleted: false,
                dbWrites: 0,
                reason: read2.reason,
              };
            }

            const reason = 'confirmed_absent_two_fresh_uncached_reads';
            const details = {
              source: params.source || 'background_sync',
              identity_match: identityCheck.code,
              read1_reason: read1.reason,
              read2_reason: read2.reason,
              inbound_missing: Boolean(read1.inboundMissing && read2.inboundMissing),
            };

            // Atomic & idempotent database deletion marking via service-role RPC ONLY.
            // FAIL CLOSED: Never fall back to independent non-atomic table updates if the RPC
            // is missing, unavailable, returns an error, or rejects the record with a skip_reason.
            if (!dbClient || typeof dbClient.rpc !== 'function') {
              console.error(
                `[3X-UI Sync] Fail closed for ${normUuid}: atomic deletion RPC client is unavailable.`
              );
              return {
                confirmedDeleted: false,
                applied: false,
                dbWrites: 0,
                reason: 'rpc_unavailable',
              };
            }

            let rpcData: any = null;
            let rpcErr: any = null;
            try {
              const rpcRes = await dbClient.rpc('mark_vpn_client_panel_deleted', {
                p_client_uuid: normUuid,
                p_inbound_id: inboundId,
                p_panel_identity: currentPanelIdentity,
                p_user_id: params.userId || null,
                p_reason: reason,
                p_details: details,
              });
              rpcData = rpcRes?.data;
              rpcErr = rpcRes?.error;
            } catch (rpcException: any) {
              rpcErr = rpcException;
            }

            if (rpcErr) {
              console.error(
                `[3X-UI Sync] Fail closed: mark_vpn_client_panel_deleted RPC unavailable or failed for ${normUuid}:`,
                rpcErr?.message || rpcErr
              );
              return {
                confirmedDeleted: false,
                applied: false,
                dbWrites: 0,
                reason: isMissingSchemaOrRpcError(rpcErr)
                  ? `rpc_missing:${rpcErr?.message || 'not_installed'}`
                  : `rpc_error:${rpcErr?.message || 'unknown'}`,
              };
            }

            const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
            if (!row || typeof row !== 'object') {
              console.error(
                `[3X-UI Sync] Fail closed: mark_vpn_client_panel_deleted returned empty response for ${normUuid}.`
              );
              return {
                confirmedDeleted: false,
                applied: false,
                dbWrites: 0,
                reason: 'rpc_empty_response',
              };
            }

            if (row.skip_reason && !row.already_deleted) {
              console.warn(
                `[3X-UI Sync] Fail closed: mark_vpn_client_panel_deleted skipped ${normUuid} (skip_reason=${row.skip_reason}).`
              );
              return {
                confirmedDeleted: false,
                applied: false,
                dbWrites: 0,
                reason: `rpc_skipped:${row.skip_reason}`,
              };
            }

            const applied = Boolean(row.applied);
            const alreadyDeleted = Boolean(row.already_deleted);
            if (!applied && !alreadyDeleted) {
              console.warn(
                `[3X-UI Sync] Fail closed: mark_vpn_client_panel_deleted neither applied nor confirmed already_deleted for ${normUuid}.`
              );
              return {
                confirmedDeleted: false,
                applied: false,
                dbWrites: 0,
                reason: 'rpc_not_applied',
              };
            }

            const reconciliationRequired = Boolean(row.reconciliation_required);
            const unresolvedGrantCount = Number(row.unresolved_grant_count || 0);
            const auditLogged = Boolean(row.audit_log_inserted ?? row.audit_logged);
            const dbWrites = applied ? 1 : 0;

            // Invalidate in-memory inbound cache so subsequent reads reflect the confirmed deletion immediately
            invalidateInboundCache(inboundId);

            return {
              confirmedDeleted: true,
              applied,
              reconciliationRequired,
              unresolvedGrantCount,
              auditLogged,
              dbWrites,
              reason,
            };
          }
        );
      }
    );
  } catch (lockErr: any) {
    // Lock contention, uncertain lock, or lost fence -> NEVER force-release and perform ZERO writes
    const code = String(lockErr?.code || '').trim();
    console.log(
      `[3X-UI Sync] Skipping deletion verification for UUID ${normUuid} due to active/uncertain lock (${code || lockErr?.message || 'busy'}).`
    );
    return {
      confirmedDeleted: false,
      dbWrites: 0,
      reason: code ? `lock_skipped:${code}` : `lock_skipped:${lockErr?.message || 'busy'}`,
    };
  }
};

/**
 * Checks whether a non-deleted VPN record that is observed live & Active in 3X-UI
 * is eligible to have its DB status restored from 'disabled'/'expired' back to 'active'.
 * Never auto-resurrects deleted configs, rejected/revoked orders/grants, or unresolved provisioning ops.
 */
export const isSafeToRestoreActiveStatus = async (params: {
  dbClient: any;
  clientUuid: string;
  orderId?: string | null;
  currentDbStatus?: string | null;
  deletedFromPanelAt?: string | null;
  liveInbound: XuiInbound;
  liveClient: XuiClient;
  liveStat?: XuiClientStat | null;
  nowMs?: number;
}): Promise<boolean> => {
  const normStatus = String(params.currentDbStatus || '').trim().toLowerCase();
  if (normStatus === 'deleted' || Boolean(params.deletedFromPanelAt)) {
    return false;
  }
  if (normStatus !== 'disabled' && normStatus !== 'expired') {
    return false;
  }

  // Require live 3X-UI state to be unambiguously Active (enabled, unexpired, under quota)
  if (params.liveInbound?.enable !== true || params.liveClient?.enable !== true) {
    return false;
  }
  if (params.liveStat && params.liveStat.enable === false) {
    return false;
  }

  const nowMs = params.nowMs ?? Date.now();
  let expMs = Number(params.liveClient.expiryTime || 0);
  if (expMs > 0 && expMs < 10000000000) expMs *= 1000;
  if ((expMs > 0 && expMs <= nowMs) || expMs < 0) {
    return false;
  }

  const totalLimit = Number(params.liveClient.totalGB || (params.liveStat?.total ?? 0) || 0);
  const usedBytes = Number(params.liveStat?.up || 0) + Number(params.liveStat?.down || 0);
  if (totalLimit > 0 && usedBytes >= totalLimit) {
    return false;
  }

  const dbClient = params.dbClient || supabaseAdmin;
  const normUuid = String(params.clientUuid || '').trim().toLowerCase();
  const orderId = String(params.orderId || '').trim();

  // Check order status is NOT rejected/revoked/cancelled/deleted/pending
  if (orderId && dbClient && typeof dbClient.from === 'function') {
    try {
      const { data: ord } = await dbClient
        .from('orders')
        .select('id, status, payment_status, provisioning_status, reject_reason')
        .eq('id', orderId)
        .maybeSingle();

      if (ord) {
        const os = String(ord.status || '').toLowerCase().trim();
        const ps = String(ord.payment_status || '').toLowerCase().trim();
        const prs = String(ord.provisioning_status || '').toLowerCase().trim();
        if (
          os === 'rejected' ||
          os === 'cancelled' ||
          os === 'canceled' ||
          os === 'deleted' ||
          os === 'revoked' ||
          os === 'pending' ||
          ps === 'rejected' ||
          ps === 'cancelled' ||
          prs === 'revoked' ||
          prs === 'revoke_failed' ||
          prs === 'rejected' ||
          Boolean(ord.reject_reason)
        ) {
          return false;
        }
      }
    } catch {
      return false;
    }
  }

  // Check new_order entitlement grants are NOT revoked/rejected/provisioning/uncertain
  if (dbClient && typeof dbClient.from === 'function') {
    try {
      const { data: grants, error: grantErr } = await dbClient
        .from('vpn_entitlement_grants')
        .select('grant_type, status')
        .ilike('client_uuid', normUuid);

      if (grantErr && !isMissingSchemaOrRpcError(grantErr)) {
        return false;
      }
      if (Array.isArray(grants)) {
        for (const g of grants) {
          const gType = String(g.grant_type || 'new_order').toLowerCase().trim();
          const gStatus = String(g.status || '').toLowerCase().trim();
          if (
            gStatus === 'provisioning' ||
            gStatus === 'uncertain' ||
            gStatus === 'revoke_failed'
          ) {
            return false;
          }
          if (
            gType === 'new_order' &&
            (gStatus === 'revoked' || gStatus === 'rejected' || gStatus === 'cancelled' || gStatus === 'deleted')
          ) {
            return false;
          }
        }
      }
    } catch {
      return false;
    }

    // Check no active or uncertain provisioning_operations exist for this client or order
    try {
      const keysToCheck = [`client:${normUuid}`];
      if (orderId) keysToCheck.push(`order:${orderId}`);
      const { data: ops, error: opsErr } = await dbClient
        .from('provisioning_operations')
        .select('operation_key, status')
        .in('operation_key', keysToCheck)
        .in('status', ['in_progress', 'uncertain']);

      if (opsErr && !isMissingSchemaOrRpcError(opsErr)) {
        return false;
      }
      if (Array.isArray(ops) && ops.length > 0) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
};

/**
 * Authoritatively synchronizes 3X-UI panel clients with local database (`vpn_accounts`, `vpn_configs`).
 *
 * Critical guarantees:
 * - Always uses fresh, uncached live panel reads (ignores stale caches; never uses clientStats for existence).
 * - Scans ALL non-deleted clients (including active, disabled, and expired) so permanently deleted
 *   clients in any state are detected and removed from customer-facing VPN views.
 * - Requires reliable panel identity, customer ownership, inbound association, durable client+inbound locks,
 *   and two independent fresh uncached reads before marking any client as `deleted`.
 * - NEVER mutates `orders.status` or `orders.payment_status` and NEVER writes `updated_at` to `vpn_configs`.
 * - Safely backfills `panel_identity` for observed live clients and restores `disabled`/`expired` -> `active`
 *   only when live state is unambiguously Active and no rejection/revocation/unresolved lock exists.
 */
export const syncDeleted3XUiClients = async (
  options?: SyncDeletedClientsOptions
): Promise<SyncDeletedClientsResult> => {
  console.log('[3X-UI Sync] Starting authoritative VPN client synchronization with 3X-UI panel...');

  const dbClient = options?.dbClient || supabaseAdmin;
  const readList = options?.fetchUncachedInboundsList || fetchUncachedLiveInboundsList;
  const readInbound = options?.fetchUncachedInbound || fetchUncachedLiveInboundById;
  const nowMs = options?.nowMs ?? Date.now();

  let currentPanelIdentity = String(options?.currentPanelIdentity || '').trim();
  if (!currentPanelIdentity) {
    try {
      currentPanelIdentity = await getCurrentPanelIdentity();
    } catch (err: any) {
      console.warn('[3X-UI Sync] Cannot resolve active 3X-UI panel identity. Skipping cycle safely.', err?.message || err);
      return {
        synced: false,
        deletedCount: 0,
        restoredCount: 0,
        skippedCount: 0,
        manualReviewCount: 0,
        reconciliationFlaggedCount: 0,
      };
    }
  }

  // Step 1: Fresh, uncached live panel list read (NEVER uses cachedInbounds)
  const listRes = await readList();
  if (!listRes.ok) {
    console.warn(`[3X-UI Sync] Live 3X-UI panel list failed (${listRes.reason}). Skipping cycle with zero writes.`);
    return {
      synced: false,
      deletedCount: 0,
      restoredCount: 0,
      skippedCount: 0,
      manualReviewCount: 0,
      reconciliationFlaggedCount: 0,
    };
  }

  if (listRes.allInboundsCleanlyParsed && listRes.inbounds.length > 0 && !options?.fetchUncachedInboundsList) {
    setCachedInbounds(listRes.inbounds);
  }

  const configuredServers =
    options?.configuredServers !== undefined
      ? options.configuredServers
      : await loadConfiguredXuiServers(dbClient);

  console.log(
    `[3X-UI Sync] Live panel reachable (identity=${currentPanelIdentity}). Found ${listRes.liveClientByUuid.size} live client UUIDs across ${listRes.inbounds.length} inbounds (unparsed=${listRes.unparsedInboundIds.length}).`
  );

  let deletedCount = 0;
  let restoredCount = 0;
  let skippedCount = 0;
  let manualReviewCount = 0;
  let reconciliationFlaggedCount = 0;
  const details: Array<{ clientUuid: string; outcome: string; reason: string }> = [];

  try {
    // Load all non-deleted vpn_accounts and vpn_configs (including active, disabled, expired)
    const [accRes, cfgRes] = await Promise.all([
      dbClient.from('vpn_accounts').select('*'),
      dbClient.from('vpn_configs').select('*'),
    ]);

    const accounts: any[] = Array.isArray(accRes?.data) ? accRes.data : [];
    const configs: any[] = Array.isArray(cfgRes?.data) ? cfgRes.data : [];

    // Also load grant inbound_ids as authoritative inbound fallback when vpn_configs.inbound_id is missing
    const grantInboundByUuid = new Map<string, number>();
    try {
      const { data: grants } = await dbClient
        .from('vpn_entitlement_grants')
        .select('client_uuid, inbound_id')
        .not('inbound_id', 'is', null);
      if (Array.isArray(grants)) {
        for (const g of grants) {
          const gu = String(g?.client_uuid || '').trim().toLowerCase();
          const gib = Number(g?.inbound_id);
          if (gu && Number.isInteger(gib) && gib > 0 && !grantInboundByUuid.has(gu)) {
            grantInboundByUuid.set(gu, gib);
          }
        }
      }
    } catch {
      // Optional table
    }

    // Group accounts and configs by normalized client UUID
    interface ClientRecordGroup {
      clientUuid: string;
      accounts: any[];
      configs: any[];
      inboundId: number | null;
      userId: string | null;
      distinctOwners: Set<string>;
      hasConflictingOwnership: boolean;
      hasMissingOwnership: boolean;
      userEmail: string | null;
      orderId: string | null;
      panelIdentity: string | null;
      serverId: string | null;
      createdAt: string | null;
      anyNonDeleted: boolean;
      allDeleted: boolean;
    }

    const groups = new Map<string, ClientRecordGroup>();
    const ensureGroup = (rawUuid: string): ClientRecordGroup | null => {
      const norm = String(rawUuid || '').trim().toLowerCase();
      if (!norm) return null;
      let g = groups.get(norm);
      if (!g) {
        g = {
          clientUuid: norm,
          accounts: [],
          configs: [],
          inboundId: grantInboundByUuid.get(norm) ?? null,
          userId: null,
          distinctOwners: new Set<string>(),
          hasConflictingOwnership: false,
          hasMissingOwnership: false,
          userEmail: null,
          orderId: null,
          panelIdentity: null,
          serverId: null,
          createdAt: null,
          anyNonDeleted: false,
          allDeleted: true,
        };
        groups.set(norm, g);
      }
      return g;
    };

    for (const acc of accounts) {
      const g = ensureGroup(acc.uuid);
      if (!g) continue;
      g.accounts.push(acc);
      const accOwner = String(acc.user_id || '').trim();
      if (accOwner) {
        g.distinctOwners.add(accOwner.toLowerCase());
        if (!g.userId) g.userId = accOwner;
      } else {
        g.hasMissingOwnership = true;
      }
      if (!g.userEmail && acc.email) g.userEmail = String(acc.email).trim().toLowerCase();
      if (!g.orderId && acc.order_id) g.orderId = String(acc.order_id).trim();
      if (!g.panelIdentity && acc.panel_identity) g.panelIdentity = String(acc.panel_identity).trim();
      if (!g.serverId && acc.server_id) g.serverId = String(acc.server_id).trim();
      if (acc.created_at && (!g.createdAt || new Date(acc.created_at).getTime() > new Date(g.createdAt).getTime())) {
        g.createdAt = acc.created_at;
      }
      const st = String(acc.status || '').trim().toLowerCase();
      if (st !== 'deleted' && !acc.deleted_from_panel_at) {
        g.anyNonDeleted = true;
        g.allDeleted = false;
      }
    }

    for (const cfg of configs) {
      const g = ensureGroup(cfg.uuid);
      if (!g) continue;
      g.configs.push(cfg);
      const ibId = Number(cfg.inbound_id);
      if (Number.isInteger(ibId) && ibId > 0) g.inboundId = ibId;
      const cfgCustUid = String(cfg.customer_uid || '').trim();
      const cfgUserId = String(cfg.user_id || '').trim();
      if (cfgCustUid && cfgUserId && cfgCustUid.toLowerCase() !== cfgUserId.toLowerCase()) {
        g.hasConflictingOwnership = true;
      }
      if (cfgCustUid) {
        g.distinctOwners.add(cfgCustUid.toLowerCase());
        if (!g.userId) g.userId = cfgCustUid;
      }
      if (cfgUserId) {
        g.distinctOwners.add(cfgUserId.toLowerCase());
        if (!g.userId) g.userId = cfgUserId;
      }
      if (!cfgCustUid && !cfgUserId) {
        g.hasMissingOwnership = true;
      }
      if (!g.userEmail && (cfg.customer_email || cfg.email)) {
        g.userEmail = String(cfg.customer_email || cfg.email).trim().toLowerCase();
      }
      if (!g.orderId && cfg.order_id) g.orderId = String(cfg.order_id).trim();
      if (!g.panelIdentity && cfg.panel_identity) g.panelIdentity = String(cfg.panel_identity).trim();
      if (!g.serverId && cfg.server_id) g.serverId = String(cfg.server_id).trim();
      if (cfg.created_at && (!g.createdAt || new Date(cfg.created_at).getTime() > new Date(g.createdAt).getTime())) {
        g.createdAt = cfg.created_at;
      }
      const st = String(cfg.status || '').trim().toLowerCase();
      if (st !== 'deleted' && !cfg.deleted_from_panel_at) {
        g.anyNonDeleted = true;
        g.allDeleted = false;
      }
    }

    const nowIso = new Date(nowMs).toISOString();

    for (const group of groups.values()) {
      // Never auto-resurrect a configuration that is already confirmed deleted
      if (!group.anyNonDeleted || group.allDeleted) {
        continue;
      }

      const liveMatch = listRes.liveClientByUuid.get(group.clientUuid);
      if (liveMatch) {
        // Client positively observed in live 3X-UI settings.clients[]!
        // 1. Safely backfill panel_identity (and missing inbound_id on vpn_configs) for non-deleted rows
        for (const acc of group.accounts) {
          const st = String(acc.status || '').trim().toLowerCase();
          if (st === 'deleted' || acc.deleted_from_panel_at) continue;
          const updates: Record<string, any> = {};
          if (!acc.panel_identity && currentPanelIdentity) {
            updates.panel_identity = currentPanelIdentity;
          }
          if (
            (st === 'disabled' || st === 'expired') &&
            (await isSafeToRestoreActiveStatus({
              dbClient,
              clientUuid: group.clientUuid,
              orderId: acc.order_id || group.orderId,
              currentDbStatus: st,
              deletedFromPanelAt: acc.deleted_from_panel_at,
              liveInbound: liveMatch.inbound,
              liveClient: liveMatch.client,
              liveStat: liveMatch.stat,
              nowMs,
            }))
          ) {
            updates.status = 'active';
            updates.enable = true;
            updates.updated_at = nowIso;
            restoredCount += 1;
          }
          if (Object.keys(updates).length > 0) {
            try {
              const { error } = await dbClient.from('vpn_accounts').update(updates).eq('id', acc.id);
              if (error && isMissingSchemaOrRpcError(error) && 'panel_identity' in updates) {
                delete updates.panel_identity;
                if (Object.keys(updates).length > 0) {
                  await dbClient.from('vpn_accounts').update(updates).eq('id', acc.id);
                }
              }
            } catch {}
          }
        }

        for (const cfg of group.configs) {
          const st = String(cfg.status || '').trim().toLowerCase();
          if (st === 'deleted' || cfg.deleted_from_panel_at) continue;
          const updates: Record<string, any> = {};
          if (!cfg.panel_identity && currentPanelIdentity) {
            updates.panel_identity = currentPanelIdentity;
          }
          if ((!cfg.inbound_id || Number(cfg.inbound_id) <= 0) && liveMatch.inbound?.id) {
            updates.inbound_id = Number(liveMatch.inbound.id);
          }
          if (
            (st === 'disabled' || st === 'expired') &&
            (await isSafeToRestoreActiveStatus({
              dbClient,
              clientUuid: group.clientUuid,
              orderId: cfg.order_id || group.orderId,
              currentDbStatus: st,
              deletedFromPanelAt: cfg.deleted_from_panel_at,
              liveInbound: liveMatch.inbound,
              liveClient: liveMatch.client,
              liveStat: liveMatch.stat,
              nowMs,
            }))
          ) {
            updates.status = 'active';
            updates.enabled = true;
            // NEVER write updated_at to vpn_configs
          }
          if (Object.keys(updates).length > 0) {
            try {
              const { error } = await dbClient.from('vpn_configs').update(updates).eq('id', cfg.id);
              if (error && isMissingSchemaOrRpcError(error) && 'panel_identity' in updates) {
                delete updates.panel_identity;
                if (Object.keys(updates).length > 0) {
                  await dbClient.from('vpn_configs').update(updates).eq('id', cfg.id);
                }
              }
            } catch {}
          }
        }

        continue;
      }

      // Client was NOT present in live list read 1.
      // If any inbound in the list failed strict JSON parsing AND matches (or we don't know) this record's inbound, skip safely.
      if (
        !listRes.allInboundsCleanlyParsed &&
        (!group.inboundId || listRes.unparsedInboundIds.includes(group.inboundId) || listRes.unparsedInboundIds.includes(-1))
      ) {
        skippedCount += 1;
        details.push({
          clientUuid: group.clientUuid,
          outcome: 'skipped',
          reason: 'malformed_inbound_settings_in_list',
        });
        continue;
      }

      if (group.hasConflictingOwnership || group.distinctOwners.size > 1 || group.hasMissingOwnership || !group.userId) {
        const ownershipCode =
          group.hasConflictingOwnership || group.distinctOwners.size > 1
            ? 'conflicting_or_duplicate_ownership'
            : 'missing_customer_ownership';
        await recordDeduplicatedSyncAuditLog({
          dbClient,
          userId: group.distinctOwners.size === 1 ? group.userId : null,
          action: 'panel_deletion_ambiguous_identity',
          targetType: 'vpn_client',
          targetId: group.clientUuid,
          details: {
            client_uuid: group.clientUuid,
            inbound_id: group.inboundId ?? null,
            distinct_owners: Array.from(group.distinctOwners),
            has_conflicting_ownership: group.hasConflictingOwnership,
            has_missing_ownership: group.hasMissingOwnership,
            code: ownershipCode,
            source: 'background_sync',
          },
        });
        manualReviewCount += 1;
        skippedCount += 1;
        details.push({
          clientUuid: group.clientUuid,
          outcome: 'manual_review',
          reason: ownershipCode,
        });
        continue;
      }

      // Run full authoritative verification (panel identity + ownership + durable client+inbound locks + 2 fresh uncached reads + atomic RPC)
      const verifyRes = await verifyAndMarkClientDeletedIfConfirmed({
        clientUuid: group.clientUuid,
        inboundId: group.inboundId,
        userId: group.userId,
        userEmail: group.userEmail,
        recordPanelIdentity: group.panelIdentity,
        recordServerId: group.serverId,
        createdAt: group.createdAt,
        existingStatus: null,
        deletedFromPanelAt: null,
        source: 'background_sync',
        dbClient,
        currentPanelIdentity,
        configuredServers,
        fetchUncachedInbound: readInbound,
        fetchUncachedInboundsList: readList,
        reReadDelayMs: options?.reReadDelayMs,
        nowMs,
      });

      if (verifyRes.confirmedDeleted) {
        if (verifyRes.applied) deletedCount += 1;
        if (verifyRes.reconciliationRequired) reconciliationFlaggedCount += 1;
        details.push({
          clientUuid: group.clientUuid,
          outcome: 'deleted',
          reason: verifyRes.reason,
        });
      } else if (verifyRes.manualReviewFlagged) {
        manualReviewCount += 1;
        skippedCount += 1;
        details.push({
          clientUuid: group.clientUuid,
          outcome: 'manual_review',
          reason: verifyRes.reason,
        });
      } else {
        skippedCount += 1;
        details.push({
          clientUuid: group.clientUuid,
          outcome: 'skipped',
          reason: verifyRes.reason,
        });
      }
    }

    console.log(
      `[3X-UI Sync] Completed. confirmedDeleted=${deletedCount}, restoredActive=${restoredCount}, skipped=${skippedCount}, manualReview=${manualReviewCount}, reconciliationFlagged=${reconciliationFlaggedCount}.`
    );

    return {
      synced: true,
      deletedCount,
      restoredCount,
      skippedCount,
      manualReviewCount,
      reconciliationFlaggedCount,
      details,
    };
  } catch (err: any) {
    console.error('[3X-UI Sync] Unexpected error during synchronization cycle:', err?.message || err);
    return {
      synced: false,
      deletedCount: 0,
      restoredCount: 0,
      skippedCount: 0,
      manualReviewCount: 0,
      reconciliationFlaggedCount: 0,
    };
  }
};

/**
 * Verifies that no unresolved ('provisioning', 'provisional', 'uncertain', 'revoke_failed')
 * renewal grant exists in public.vpn_entitlement_grants for the specified client UUID.
 * Throws a 409 Conflict error if an unresolved renewal grant is active on that client.
 */
export async function assertNoUnresolvedClientRenewalGrant(params: {
  dbClient: any;
  clientUuid: string;
  excludeRenewRequestId?: string | null;
  operationDescription?: string;
}): Promise<void> {
  const { dbClient, clientUuid, excludeRenewRequestId, operationDescription } = params;
  const cleanUuid = String(clientUuid || '').trim();
  if (!cleanUuid || !dbClient || typeof dbClient.from !== 'function') return;

  try {
    const { data: grants, error } = await dbClient
      .from('vpn_entitlement_grants')
      .select('id, grant_type, source_id, status, provisional')
      .eq('client_uuid', cleanUuid)
      .eq('grant_type', 'renewal')
      .in('status', ['provisioning', 'provisional', 'uncertain', 'revoke_failed']);

    if (error) {
      if (isMissingSchemaOrRpcError(error) && !isAutoActivateRenewalsFlagEnabled()) {
        return;
      }
      throw new Error(`Failed to check unresolved renewal entitlement grants for client ${cleanUuid}: ${error.message}`);
    }

    const conflicting = (grants || []).find((g: any) => {
      if (excludeRenewRequestId && String(g.source_id || '').trim() === String(excludeRenewRequestId).trim()) {
        return false;
      }
      return true;
    });

    if (conflicting) {
      const conflictErr: any = new Error(
        `Cannot proceed with ${operationDescription || 'client modification'}: VPN client '${cleanUuid}' currently has an unresolved renewal entitlement grant (request=${conflicting.source_id}, status=${conflicting.status}). Please complete or reconcile payment verification first.`
      );
      conflictErr.statusCode = 409;
      conflictErr.code = 'UNRESOLVED_CLIENT_RENEWAL_GRANT';
      conflictErr.conflictingGrant = conflicting;
      throw conflictErr;
    }
  } catch (err: any) {
    if (err?.statusCode === 409) throw err;
    if (isMissingSchemaOrRpcError(err) && !isAutoActivateRenewalsFlagEnabled()) {
      return;
    }
    throw err;
  }
}

/**
 * Serializes mutations targeting a specific VPN client UUID (`client:<uuid>`) using a durable
 * PostgreSQL provisioning lock with lease verification.
 */
export async function withClientMutationLock<T>(
  params: {
    dbClient: any;
    clientUuid: string;
    operationType?: 'client_lock' | 'traffic_reset';
    targetId: string;
    requireDurableLock?: boolean;
    allowUncertainRecovery?: boolean;
    metadata?: Record<string, any>;
  },
  fn: (assertClientLockStillHeld: () => Promise<void>) => Promise<T>
): Promise<T> {
  const cleanUuid = String(params.clientUuid || '').trim().toLowerCase();
  if (!cleanUuid) {
    throw new Error('Client UUID is required to acquire client mutation lock.');
  }

  const operationKey = `client:${cleanUuid}`;
  const operationType = params.operationType || 'client_lock';
  const requireDurable =
    params.requireDurableLock !== undefined
      ? params.requireDurableLock
      : isAutoActivateRenewalsFlagEnabled() || isAutoActivateNewOrdersFlagEnabled();

  const lockRes = await acquireDurableProvisioningOperationLock({
    dbClient: params.dbClient,
    operationKey,
    operationType,
    targetId: params.targetId,
    clientUuid: cleanUuid,
    leaseSeconds: DEFAULT_LOCK_LEASE_SECONDS,
    metadata: params.metadata || { targetId: params.targetId, clientUuid: cleanUuid },
    requireDurableLock: requireDurable,
    allowUncertainRecovery: params.allowUncertainRecovery ?? false,
  });

  if (!lockRes.acquired) {
    const conflictErr: any = new Error(
      lockRes.previousStatus === 'uncertain'
        ? `VPN client '${cleanUuid}' has an uncertain prior external provisioning state; automatic modification is blocked until admin reconciliation.`
        : lockRes.error || `Another operation (${lockRes.previousOperationType || 'active'}) is currently modifying VPN client '${cleanUuid}'.`
    );
    conflictErr.statusCode = 409;
    conflictErr.code = lockRes.previousStatus === 'uncertain' ? 'CLIENT_LOCK_UNCERTAIN' : 'CLIENT_LOCK_BUSY';
    throw conflictErr;
  }

  const assertClientLockStillHeld = async (): Promise<void> => {
    if (!lockRes.tableAvailable) return;
    const renewed = await renewDurableProvisioningOperationLock({
      dbClient: params.dbClient,
      operationKey,
      lockOwnerId: lockRes.lockOwnerId,
      leaseSeconds: DEFAULT_LOCK_LEASE_SECONDS,
    });
    if (!renewed) {
      const fenceErr: any = new Error(
        `Lost durable client mutation lock '${operationKey}' before 3X-UI mutation; aborting to prevent concurrent client corruption.`
      );
      fenceErr.statusCode = 409;
      throw fenceErr;
    }
  };

  let outcome: 'completed' | 'failed' | 'uncertain' = 'completed';
  let errMsg: string | null = null;
  try {
    return await fn(assertClientLockStillHeld);
  } catch (err: any) {
    outcome = err?.xuiUncertain === true ? 'uncertain' : 'failed';
    errMsg = err?.message || String(err);
    throw err;
  } finally {
    if (lockRes.tableAvailable) {
      await finalizeDurableProvisioningOperationLock({
        dbClient: params.dbClient,
        operationKey,
        lockOwnerId: lockRes.lockOwnerId,
        status: outcome,
        clientUuid: cleanUuid,
        errorMessage: errMsg,
      });
    }
  }
}

/**
 * Reset client traffic in 3X-UI for an active client
 * Tries the primary 3X-UI client reset endpoint and inbounds reset endpoint.
 * Coordinated under `client:<uuid>` durable lock and blocked if an unresolved
 * provisional/uncertain renewal grant exists for the client.
 */
export const resetClientTraffic = async (
  email: string,
  inboundId?: number,
  clientUuid?: string,
  options?: { dbClient?: any }
): Promise<{ success: boolean; message: string }> => {
  console.log(`[xuiService] Resetting traffic in 3X-UI for client - Email: '${email}', Inbound: ${inboundId}, UUID: '${clientUuid}'`);

  if (!email && !clientUuid) {
    throw new Error('Client email or UUID is required to reset 3X-UI traffic');
  }

  const dbClient = options?.dbClient || supabaseAdmin;
  let resolvedInboundId = inboundId && Number(inboundId) > 0 ? Number(inboundId) : null;
  let resolvedUuid = String(clientUuid || '').trim();

  if ((!resolvedInboundId || !resolvedUuid) && (clientUuid || email)) {
    try {
      const inbounds = await getCachedInbounds();
      for (const ib of inbounds) {
        const settingsObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : (ib.settings || {});
        const clients: any[] = Array.isArray(settingsObj?.clients) ? settingsObj.clients : [];
        const match = clients.find(
          (c: any) =>
            (clientUuid && String(c.id || '').trim().toLowerCase() === clientUuid.trim().toLowerCase()) ||
            (email && String(c.email || '').trim().toLowerCase() === email.trim().toLowerCase())
        );
        if (match) {
          if (!resolvedInboundId && Number(ib.id) > 0) {
            resolvedInboundId = Number(ib.id);
          }
          if (!resolvedUuid && match.id) {
            resolvedUuid = String(match.id).trim();
          }
          break;
        }
      }
    } catch {
      // Non-blocking resolution
    }
  }

  const endpointsToTry: string[] = [];
  if (email) {
    endpointsToTry.push(`/panel/api/clients/resetTraffic/${encodeURIComponent(email)}`);
    if (resolvedInboundId && resolvedInboundId > 0) {
      endpointsToTry.push(`/panel/api/inbounds/${resolvedInboundId}/resetClientTraffic/${encodeURIComponent(email)}`);
      endpointsToTry.push(`/panel/api/inbounds/resetClientTraffic/${resolvedInboundId}/${encodeURIComponent(email)}`);
    }
    endpointsToTry.push(`/panel/api/inbounds/resetClientTraffic/${encodeURIComponent(email)}`);
  }

  if (resolvedUuid) {
    if (resolvedInboundId && resolvedInboundId > 0) {
      endpointsToTry.push(`/panel/api/inbounds/${resolvedInboundId}/resetClientTraffic/${encodeURIComponent(resolvedUuid)}`);
      endpointsToTry.push(`/panel/api/inbounds/resetClientTraffic/${resolvedInboundId}/${encodeURIComponent(resolvedUuid)}`);
    }
    endpointsToTry.push(`/panel/api/clients/resetTraffic/${encodeURIComponent(resolvedUuid)}`);
  }

  const executeReset = async (): Promise<{ success: boolean; message: string }> => {
    let resetSuccess = false;
    let lastError: any = null;
    let responseMsg = '';

    for (const ep of endpointsToTry) {
      try {
        console.log(`[xuiService] Invoking 3X-UI reset endpoint: ${ep}`);
        const res: any = await requestApi(ep, 'POST');
        resetSuccess = true;
        responseMsg = res?.msg || 'Traffic has been reset.';
        console.log(`[xuiService] Successfully reset traffic via ${ep}:`, res);
        break;
      } catch (err: any) {
        console.warn(`[xuiService] Reset endpoint ${ep} failed:`, err?.response?.data || err.message);
        lastError = err;
      }
    }

    if (!resetSuccess) {
      throw new Error(`Failed to reset traffic in 3X-UI: ${lastError?.message || 'Server returned an error'}`);
    }

    invalidateInboundCache(resolvedInboundId || inboundId || null);
    try {
      await getInbounds(true);
    } catch (refreshErr: any) {
      console.warn('[xuiService] Inbounds cache refresh warning after reset:', refreshErr?.message || refreshErr);
    }

    return { success: true, message: responseMsg || 'Traffic counter successfully reset in 3X-UI' };
  };

  const runUnderInboundLock = async (): Promise<{ success: boolean; message: string }> => {
    if (resolvedUuid) {
      await assertNoUnresolvedClientRenewalGrant({
        dbClient,
        clientUuid: resolvedUuid,
        operationDescription: 'resetting client traffic',
      });
    }
    if (resolvedInboundId && resolvedInboundId > 0) {
      return await withInboundWriteLock(
        {
          dbClient,
          inboundId: resolvedInboundId,
          targetId: `reset_traffic:${resolvedUuid || email}`,
          clientUuid: resolvedUuid || null,
          requireDurableLock: isAutoActivateNewOrdersFlagEnabled() || isAutoActivateRenewalsFlagEnabled(),
        },
        async (assertInboundLockStillHeld) => {
          await assertInboundLockStillHeld();
          return executeReset();
        }
      );
    }
    return executeReset();
  };

  if (resolvedUuid) {
    return await withClientMutationLock(
      {
        dbClient,
        clientUuid: resolvedUuid,
        operationType: 'traffic_reset',
        targetId: `reset_traffic:${resolvedUuid}`,
        requireDurableLock: isAutoActivateRenewalsFlagEnabled(),
      },
      async (assertClientLockStillHeld) => {
        await assertClientLockStillHeld();
        return runUnderInboundLock();
      }
    );
  }

  return runUnderInboundLock();
};

// ============================================================================
// PHASE 2: AUTOMATIC PROVISIONAL RENEWALS, APPROVAL CONFIRMATION & ROLLBACK
// ============================================================================

export type RenewalCalculationMode =
  | 'active_finite'
  | 'expired_finite_option_4b'
  | 'exhausted_finite'
  | 'unlimited_to_unlimited';

export interface RenewalEntitlementCalculationResult {
  eligible: boolean;
  mode?: RenewalCalculationMode;
  code?:
    | 'ACCOUNT_DISABLED_OR_REVOKED'
    | 'INTENTIONALLY_DISABLED'
    | 'CLIENT_DISABLED_OR_AMBIGUOUS'
    | 'INBOUND_DISABLED_OR_AMBIGUOUS'
    | 'PACKAGE_MODE_CHANGE_MANUAL_REQUIRED'
    | 'INVALID_PARAMETERS';
  reason?: string;
  previousExpiryMs: number;
  previousTotalBytes: number;
  previousWasUnlimited: boolean;
  liveUpBytes: number;
  liveDownBytes: number;
  liveUsedBytes: number;
  addedDurationMonths: number;
  addedQuotaBytes: number;
  grantedExpiryMs: number;
  grantedTotalBytes: number;
  grantedUnlimited: boolean;
  grantedDataLimitStr: string;
}

/**
 * Pure, deterministic renewal entitlement calculator implementing all approved Phase 2 rules:
 * - Active finite: grantedTotalBytes = prevTotalBytes + addedQuotaBytes; grantedExpiryMs = addCalendarMonths(prevExpiryMs, durationMonths)
 * - Expired finite (Option 4B): grantedTotalBytes = (liveUp + liveDown) + addedQuotaBytes; grantedExpiryMs = addCalendarMonths(nowMs, durationMonths)
 * - Exhausted finite (unexpired): grantedTotalBytes = Math.max(prevTotalBytes, liveUp + liveDown) + addedQuotaBytes; grantedExpiryMs = addCalendarMonths(Math.max(prevExpiryMs, nowMs), durationMonths)
 * - Unlimited to Unlimited: grantedTotalBytes = 0; grantedExpiryMs = addCalendarMonths(Math.max(prevExpiryMs, nowMs), durationMonths)
 * - Package mode changes (Finite <-> Unlimited): not eligible for auto-renewal (falls back to manual queue)
 * - Mandatory re-enable safety guard: strictly requires verified client.enable === true AND inbound.enable === true.
 *   Even if expired or quota-exhausted, a client or inbound with enable=false or ambiguous enable state MUST fall back
 *   to manual admin approval and must NEVER be auto-re-enabled.
 * - Never resets live traffic counters (up / down).
 */
export function calculateApprovedRenewalEntitlement(params: {
  previousExpiryMs: number;
  previousTotalBytes: number;
  liveUpBytes: number;
  liveDownBytes: number;
  liveEnable: unknown;
  inboundEnable: unknown;
  dbAccountStatus?: string | null;
  addedDurationMonths: number;
  addedQuotaBytes: number;
  nowMs?: number;
}): RenewalEntitlementCalculationResult {
  const nowMs = params.nowMs ?? Date.now();
  const prevExpiryMs = Math.max(0, Math.trunc(Number(params.previousExpiryMs) || 0));
  const prevTotalBytes = Math.max(0, Math.trunc(Number(params.previousTotalBytes) || 0));
  const liveUpBytes = Math.max(0, Math.trunc(Number(params.liveUpBytes) || 0));
  const liveDownBytes = Math.max(0, Math.trunc(Number(params.liveDownBytes) || 0));
  const liveUsedBytes = liveUpBytes + liveDownBytes;
  const addedDurationMonths = Math.max(1, Math.trunc(Number(params.addedDurationMonths) || 1));
  const addedQuotaBytes = Math.max(0, Math.trunc(Number(params.addedQuotaBytes) || 0));
  const prevWasUnlimited = prevTotalBytes === 0;
  const renewalIsUnlimited = addedQuotaBytes === 0;

  const dbStatusLower = String(params.dbAccountStatus || 'active').trim().toLowerCase();
  if (
    dbStatusLower === 'disabled' ||
    dbStatusLower === 'rejected' ||
    dbStatusLower === 'revoked' ||
    dbStatusLower === 'cancelled' ||
    dbStatusLower === 'deleted'
  ) {
    return {
      eligible: false,
      code: 'ACCOUNT_DISABLED_OR_REVOKED',
      reason: `VPN account status '${dbStatusLower}' is not eligible for automatic renewal.`,
      previousExpiryMs: prevExpiryMs,
      previousTotalBytes: prevTotalBytes,
      previousWasUnlimited: prevWasUnlimited,
      liveUpBytes,
      liveDownBytes,
      liveUsedBytes,
      addedDurationMonths,
      addedQuotaBytes,
      grantedExpiryMs: prevExpiryMs,
      grantedTotalBytes: prevTotalBytes,
      grantedUnlimited: prevWasUnlimited,
      grantedDataLimitStr: prevTotalBytes > 0 ? `${Math.round(prevTotalBytes / (1024 * 1024 * 1024))}GB` : 'Unlimited',
    };
  }

  // Strictly require verified inbound.enable === true before automatic renewal
  if (params.inboundEnable !== true) {
    return {
      eligible: false,
      code: 'INBOUND_DISABLED_OR_AMBIGUOUS',
      reason: '3X-UI inbound is disabled or its enable state is ambiguous. Manual admin approval is required.',
      previousExpiryMs: prevExpiryMs,
      previousTotalBytes: prevTotalBytes,
      previousWasUnlimited: prevWasUnlimited,
      liveUpBytes,
      liveDownBytes,
      liveUsedBytes,
      addedDurationMonths,
      addedQuotaBytes,
      grantedExpiryMs: prevExpiryMs,
      grantedTotalBytes: prevTotalBytes,
      grantedUnlimited: prevWasUnlimited,
      grantedDataLimitStr: prevTotalBytes > 0 ? `${Math.round(prevTotalBytes / (1024 * 1024 * 1024))}GB` : 'Unlimited',
    };
  }

  // Strictly require verified client.enable === true before automatic renewal.
  // Never auto-re-enable a disabled/ambiguous client even if expired or quota-exhausted,
  // so intentional administrator disable actions are never overridden.
  if (params.liveEnable !== true) {
    return {
      eligible: false,
      code: 'CLIENT_DISABLED_OR_AMBIGUOUS',
      reason: 'VPN client is disabled or its enable state is ambiguous on 3X-UI. Automatic re-enabling is prohibited; manual admin approval is required.',
      previousExpiryMs: prevExpiryMs,
      previousTotalBytes: prevTotalBytes,
      previousWasUnlimited: prevWasUnlimited,
      liveUpBytes,
      liveDownBytes,
      liveUsedBytes,
      addedDurationMonths,
      addedQuotaBytes,
      grantedExpiryMs: prevExpiryMs,
      grantedTotalBytes: prevTotalBytes,
      grantedUnlimited: prevWasUnlimited,
      grantedDataLimitStr: prevTotalBytes > 0 ? `${Math.round(prevTotalBytes / (1024 * 1024 * 1024))}GB` : 'Unlimited',
    };
  }

  const isExpiredByTime = prevExpiryMs > 0 && prevExpiryMs <= nowMs;
  const isExhaustedByQuota = !prevWasUnlimited && liveUsedBytes >= prevTotalBytes;

  // Package mode changes (Finite <-> Unlimited) must fall back to manual admin approval
  if (prevWasUnlimited !== renewalIsUnlimited) {
    return {
      eligible: false,
      code: 'PACKAGE_MODE_CHANGE_MANUAL_REQUIRED',
      reason: 'Switching between Finite (100GB) and Unlimited package modes requires manual admin approval.',
      previousExpiryMs: prevExpiryMs,
      previousTotalBytes: prevTotalBytes,
      previousWasUnlimited: prevWasUnlimited,
      liveUpBytes,
      liveDownBytes,
      liveUsedBytes,
      addedDurationMonths,
      addedQuotaBytes,
      grantedExpiryMs: prevExpiryMs,
      grantedTotalBytes: prevTotalBytes,
      grantedUnlimited: renewalIsUnlimited,
      grantedDataLimitStr: renewalIsUnlimited ? 'Unlimited' : `${Math.round(addedQuotaBytes / (1024 * 1024 * 1024))}GB`,
    };
  }

  let grantedExpiryMs = 0;
  let grantedTotalBytes = 0;
  let mode: RenewalCalculationMode = 'unlimited_to_unlimited';

  if (prevWasUnlimited && renewalIsUnlimited) {
    mode = 'unlimited_to_unlimited';
    grantedTotalBytes = 0;
    const baseExpiryMs = prevExpiryMs > nowMs ? prevExpiryMs : nowMs;
    grantedExpiryMs = addCalendarMonths(baseExpiryMs, addedDurationMonths);
  } else if (isExpiredByTime) {
    // Option 4B: Expired finite-to-finite renewal without resetting 3X-UI traffic counters
    mode = 'expired_finite_option_4b';
    grantedTotalBytes = liveUsedBytes + addedQuotaBytes;
    grantedExpiryMs = addCalendarMonths(nowMs, addedDurationMonths);
  } else if (isExhaustedByQuota) {
    // Exhausted finite-to-finite renewal (unexpired)
    mode = 'exhausted_finite';
    grantedTotalBytes = Math.max(prevTotalBytes, liveUsedBytes) + addedQuotaBytes;
    const baseExpiryMs = prevExpiryMs > nowMs ? prevExpiryMs : nowMs;
    grantedExpiryMs = addCalendarMonths(baseExpiryMs, addedDurationMonths);
  } else {
    // Active finite-to-finite renewal
    mode = 'active_finite';
    grantedTotalBytes = prevTotalBytes + addedQuotaBytes;
    grantedExpiryMs = addCalendarMonths(prevExpiryMs, addedDurationMonths);
  }

  // Post-condition safety assertion for finite renewals: remaining usable quota must be >= addedQuotaBytes
  if (!renewalIsUnlimited && grantedTotalBytes - liveUsedBytes < addedQuotaBytes) {
    grantedTotalBytes = liveUsedBytes + addedQuotaBytes;
  }

  const grantedDataLimitStr =
    grantedTotalBytes === 0
      ? 'Unlimited'
      : `${Math.max(1, Math.round(addedQuotaBytes / (1024 * 1024 * 1024)))}GB`;

  return {
    eligible: true,
    mode,
    previousExpiryMs: prevExpiryMs,
    previousTotalBytes: prevTotalBytes,
    previousWasUnlimited: prevWasUnlimited,
    liveUpBytes,
    liveDownBytes,
    liveUsedBytes,
    addedDurationMonths,
    addedQuotaBytes,
    grantedExpiryMs,
    grantedTotalBytes,
    grantedUnlimited: grantedTotalBytes === 0,
    grantedDataLimitStr,
  };
}

/**
 * Builds a complete `pre_renewal_db_snapshot` JSONB object conforming strictly to
 * `public.is_valid_pre_renewal_db_snapshot` in PostgreSQL (with exact millisecond
 * timestamp consistency and integer byte counters).
 */
export function buildVerifiedPreRenewalDbSnapshot(params: {
  capturedAtMs?: number;
  clientUuid: string;
  inboundId: number;
  previousExpiryMs: number;
  previousTotalBytes: number;
  previousUpBytes: number;
  previousDownBytes: number;
  previousEnable: boolean;
  grantedExpiryMs: number;
  grantedTotalBytes: number;
  grantedDataLimit: string;
  vpnAccount: any;
  parentOrder: any;
  vpnConfig?: any | null;
  liveClient: any;
}): Record<string, any> {
  const capturedAtMs = Math.trunc(params.capturedAtMs ?? Date.now());
  const prevExpiryMs = Math.trunc(Number(params.previousExpiryMs));
  const prevTotalBytes = Math.trunc(Number(params.previousTotalBytes));
  const prevUpBytes = Math.trunc(Number(params.previousUpBytes));
  const prevDownBytes = Math.trunc(Number(params.previousDownBytes));
  const prevEnable = Boolean(params.previousEnable);
  const grantedExpiryMs = Math.trunc(Number(params.grantedExpiryMs));
  const grantedTotalBytes = Math.trunc(Number(params.grantedTotalBytes));
  const inboundId = Math.trunc(Number(params.inboundId));
  const clientUuid = String(params.clientUuid).trim();

  // Exact ISO representation of prevExpiryMs and grantedExpiryMs so PostgreSQL
  // (extract(epoch from ts) * 1000)::bigint matches p_prev_expiry_ms and p_granted_expiry_ms to the exact ms.
  const exactPrevExpiryIso = new Date(prevExpiryMs).toISOString();
  const exactGrantedExpiryIso = new Date(grantedExpiryMs).toISOString();
  const prevStatus = String(params.vpnAccount?.status || 'active').trim() || 'active';
  const prevDataLimit =
    String(
      params.vpnAccount?.data_limit ||
        params.vpnConfig?.data_limit ||
        (prevTotalBytes > 0 ? `${Math.max(1, Math.round(prevTotalBytes / (1024 * 1024 * 1024)))}GB` : 'Unlimited')
    ).trim() || 'Unlimited';

  const vlessUrl = String(
    params.parentOrder?.vless_url ||
      params.vpnAccount?.vless_url ||
      params.vpnConfig?.vless_url ||
      `vless://${clientUuid}@127.0.0.1:443`
  ).trim();

  const hasVpnConfig = Boolean(params.vpnConfig && params.vpnConfig.id && String(params.vpnConfig.id).trim().length > 0);
  const rawTrafficLimit =
    hasVpnConfig && params.vpnConfig?.traffic_limit !== undefined && params.vpnConfig?.traffic_limit !== null
      ? String(params.vpnConfig.traffic_limit).trim()
      : '';

  // Exact JSONB structure validated by public.is_valid_pre_renewal_db_snapshot() and chk_vpn_entitlement_grants_renewal_snapshot
  return {
    schema_version: 1,
    captured_at: new Date(capturedAtMs).toISOString(),
    vpn_account: {
      id: String(params.vpnAccount.id).trim(),
      uuid: clientUuid,
      order_id: String(params.parentOrder.id).trim(),
      enable: prevEnable,
      status: prevStatus,
      expiry_time: prevExpiryMs,
      expiry_date: exactPrevExpiryIso,
      total_bytes: prevTotalBytes,
      data_limit: prevDataLimit,
      up_bytes: prevUpBytes,
      down_bytes: prevDownBytes,
      original_db_expiry_time:
        params.vpnAccount?.expiry_time !== undefined && params.vpnAccount?.expiry_time !== null
          ? Number(params.vpnAccount.expiry_time)
          : null,
      original_db_expiry_date: params.vpnAccount?.expiry_date ? String(params.vpnAccount.expiry_date) : null,
    },
    parent_order: {
      id: String(params.parentOrder.id).trim(),
      client_uuid: clientUuid,
      status: String(params.parentOrder.status || 'completed').trim() || 'completed',
      payment_status: String(params.parentOrder.payment_status || 'Paid').trim() || 'Paid',
      provisioning_status: String(params.parentOrder.provisioning_status || 'completed').trim() || 'completed',
      expiry_date: params.parentOrder?.expiry_date ? exactPrevExpiryIso : null,
      original_db_expiry_date: params.parentOrder?.expiry_date ? String(params.parentOrder.expiry_date) : null,
      vless_url: vlessUrl,
    },
    vpn_config: hasVpnConfig
      ? {
          exists: true,
          id: String(params.vpnConfig.id).trim(),
          uuid: clientUuid,
          inbound_id: inboundId,
          enabled: typeof params.vpnConfig.enabled === 'boolean' ? params.vpnConfig.enabled : prevEnable,
          status: String(params.vpnConfig.status || prevStatus).trim() || prevStatus,
          expiry_date: exactPrevExpiryIso,
          original_db_expiry_date: params.vpnConfig?.expiry_date ? String(params.vpnConfig.expiry_date) : null,
          data_limit: String(params.vpnConfig.data_limit || prevDataLimit).trim() || prevDataLimit,
          traffic_limit: rawTrafficLimit.length > 0 ? rawTrafficLimit : null,
        }
      : {
          exists: false,
        },
    xui_client: {
      inbound_id: inboundId,
      client_uuid: clientUuid,
      enable: prevEnable,
      expiry_time_ms: prevExpiryMs,
      total_bytes: prevTotalBytes,
      up_bytes_at_renewal: prevUpBytes,
      down_bytes_at_renewal: prevDownBytes,
      email: String(params.liveClient?.email || params.vpnAccount?.remark || params.vpnAccount?.email || clientUuid).trim(),
      sub_id: params.liveClient?.subId ? String(params.liveClient.subId) : null,
    },
    granted_db_state: {
      granted_expiry_ms: grantedExpiryMs,
      granted_expiry_date: exactGrantedExpiryIso,
      granted_total_bytes: grantedTotalBytes,
      granted_data_limit: String(params.grantedDataLimit || 'Unlimited').trim() || 'Unlimited',
      granted_enable: true,
      granted_status: 'active',
    },
  };
}

export interface ProvisionProvisionalRenewalOptions {
  dbClient?: any;
  requestApiFn?: typeof requestApi;
  getInboundsFn?: typeof getInbounds;
  nowMs?: number;
  skipSideEffects?: boolean;
}

export interface ProvisionProvisionalRenewalResult {
  success: boolean;
  autoRenewed: boolean;
  provisional: boolean;
  provisioningStatus: 'provisional' | 'pending' | 'uncertain' | 'failed';
  fallbackToManual?: boolean;
  blockedReason?: string;
  mode?: RenewalCalculationMode;
  uuid?: string;
  inboundId?: number;
  oldExpiryIso?: string;
  newExpiryIso?: string;
  grantedExpiryMs?: number;
  grantedTotalBytes?: number;
  addedQuotaBytes?: number;
  dataAllowanceLabel?: string;
  packageName?: string;
  message?: string;
}

export type ProvisionalRenewalProvisionResult = ProvisionProvisionalRenewalResult;

/**
 * Executes automatic provisional renewal for an existing paid VPN client:
 * 1. Acquires durable locks in deterministic order: `renew:<requestId>` -> `client:<uuid>` -> `inbound:<inboundId>`.
 * 2. Verifies target VPN account & parent order eligibility (must be paid/completed, not trial, not disabled/rejected,
 *    no unresolved renewal grant on this client, DB vs live 3X-UI expiry discrepancy <= 5 minutes).
 * 3. Reads live 3X-UI client state and live traffic counters (`up`, `down`), calculates new entitlement (including Option 4B).
 * 4. Pre-persists `vpn_entitlement_grants` (`grant_type='renewal'`, `status='provisioning'`, complete `pre_renewal_db_snapshot`)
 *    BEFORE calling 3X-UI.
 * 5. Updates only `expiryTime`, `totalGB`, and `enable: true` on the existing 3X-UI client (preserving UUID, password,
 *    Hysteria auth, subId, flow, inbound, VLESS URL, and cumulative traffic counters) and performs mandatory read-back verification.
 * 6. Updates `vpn_accounts`, `vpn_configs`, `orders.expiry_date` (keeping `orders.payment_status='Paid'`),
 *    `vpn_entitlement_grants.status='provisional'`, and `renew_requests.provisioning_status='provisional'` (keeping `renew_requests.status='pending'`).
 */
export async function provisionProvisionalRenewal(
  renewRequestId: string,
  options?: ProvisionProvisionalRenewalOptions
): Promise<ProvisionProvisionalRenewalResult> {
  const dbClient = options?.dbClient || supabaseAdmin;
  const requestApiCall = options?.requestApiFn || requestApi;
  const getInboundsCall = options?.getInboundsFn || getInbounds;
  const nowMs = options?.nowMs ?? Date.now();
  const cleanRequestId = String(renewRequestId || '').trim();

  if (!cleanRequestId) {
    throw new Error('Renewal request ID is required for provisional renewal.');
  }

  const renewLockKey = `renew:${cleanRequestId}`;
  const renewLockRes = await acquireDurableProvisioningOperationLock({
    dbClient,
    operationKey: renewLockKey,
    operationType: 'auto_renew',
    targetId: cleanRequestId,
    leaseSeconds: DEFAULT_LOCK_LEASE_SECONDS,
    metadata: { renewRequestId: cleanRequestId },
    requireDurableLock: true,
    allowUncertainRecovery: false,
  });

  if (!renewLockRes.acquired) {
    return {
      success: false,
      autoRenewed: false,
      provisional: false,
      provisioningStatus: renewLockRes.previousStatus === 'uncertain' ? 'uncertain' : 'pending',
      fallbackToManual: true,
      blockedReason:
        renewLockRes.previousStatus === 'uncertain'
          ? 'prior_renewal_uncertain'
          : 'renewal_lock_busy',
      message:
        renewLockRes.error ||
        'Another renewal operation is already in progress for this request. Held for manual admin verification.',
    };
  }

  let renewLockOutcome: 'completed' | 'failed' | 'uncertain' = 'completed';
  let renewLockError: string | null = null;
  let targetClientUuid: string | null = null;

  try {
    const { data: renewReq, error: reqErr } = await dbClient
      .from('renew_requests')
      .select('*')
      .eq('id', cleanRequestId)
      .maybeSingle();

    if (reqErr || !renewReq) {
      renewLockOutcome = 'failed';
      renewLockError = reqErr?.message || 'Renewal request not found';
      return {
        success: false,
        autoRenewed: false,
        provisional: false,
        provisioningStatus: 'pending',
        fallbackToManual: true,
        blockedReason: 'renew_request_not_found',
        message: 'Renewal request not found.',
      };
    }

    let extra: any = {};
    if (renewReq.notes && typeof renewReq.notes === 'string' && renewReq.notes.startsWith('{')) {
      try {
        extra = JSON.parse(renewReq.notes);
      } catch {
        extra = {};
      }
    }

    // Check if already provisionally applied (idempotent retry)
    const { data: existingGrant } = await dbClient
      .from('vpn_entitlement_grants')
      .select('*')
      .eq('grant_type', 'renewal')
      .eq('source_id', cleanRequestId)
      .maybeSingle();

    if (existingGrant && (existingGrant.status === 'provisional' || existingGrant.status === 'verified')) {
      targetClientUuid = existingGrant.client_uuid;
      return {
        success: true,
        autoRenewed: true,
        provisional: existingGrant.status === 'provisional',
        provisioningStatus: 'provisional',
        uuid: existingGrant.client_uuid,
        inboundId: existingGrant.inbound_id,
        oldExpiryIso: new Date(Number(existingGrant.previous_expiry_ms)).toISOString(),
        newExpiryIso: new Date(Number(existingGrant.granted_expiry_ms)).toISOString(),
        grantedExpiryMs: Number(existingGrant.granted_expiry_ms),
        grantedTotalBytes: Number(existingGrant.granted_total_bytes),
        addedQuotaBytes: Number(existingGrant.added_quota_bytes),
        dataAllowanceLabel:
          Number(existingGrant.added_quota_bytes) > 0
            ? `${Math.round(Number(existingGrant.added_quota_bytes) / (1024 * 1024 * 1024))} GB`
            : 'Unlimited',
        packageName: existingGrant.package_name || renewReq.plan_name,
        message: 'Renewal is already provisionally active.',
      };
    }

    if (existingGrant && existingGrant.status === 'uncertain') {
      renewLockOutcome = 'uncertain';
      return {
        success: false,
        autoRenewed: false,
        provisional: false,
        provisioningStatus: 'uncertain',
        fallbackToManual: true,
        blockedReason: 'prior_renewal_uncertain',
        message: 'Previous renewal attempt ended in an uncertain state. Held for manual admin reconciliation.',
      };
    }

    const requestUserId = String(renewReq.user_id || '').trim();
    const requestEmail = String(renewReq.user_email || renewReq.email || '').trim().toLowerCase();
    const targetAccountId = String(extra.vpn_account_id || '').trim();
    const targetUuidFromReq = String(extra.uuid || '').trim();

    // Locate target vpn_accounts row
    let vpnAccount: any = null;
    if (targetAccountId) {
      const { data } = await dbClient.from('vpn_accounts').select('*').eq('id', targetAccountId).maybeSingle();
      if (data) vpnAccount = data;
    }
    if (!vpnAccount && targetUuidFromReq) {
      const { data } = await dbClient.from('vpn_accounts').select('*').eq('uuid', targetUuidFromReq).maybeSingle();
      if (data) vpnAccount = data;
    }

    if (!vpnAccount || !vpnAccount.uuid) {
      return {
        success: false,
        autoRenewed: false,
        provisional: false,
        provisioningStatus: 'pending',
        fallbackToManual: true,
        blockedReason: 'vpn_account_not_found',
        message: 'Target VPN account not found for automatic renewal. Held for manual admin review.',
      };
    }

    // Verify customer ownership of the VPN account
    const accOwnerId = String(vpnAccount.user_id || '').trim();
    const accOwnerEmail = String(vpnAccount.email || '').trim().toLowerCase();
    const ownsAccount =
      (requestUserId && accOwnerId && requestUserId === accOwnerId) ||
      (!accOwnerId && requestEmail && accOwnerEmail === requestEmail);

    if (!ownsAccount) {
      return {
        success: false,
        autoRenewed: false,
        provisional: false,
        provisioningStatus: 'pending',
        fallbackToManual: true,
        blockedReason: 'account_ownership_mismatch',
        message: 'VPN account ownership could not be verified. Held for manual admin review.',
      };
    }

    // Verify not a free trial
    const isTrialAccount = Boolean(
      vpnAccount.is_trial ||
        String(vpnAccount.order_id || '').startsWith('TRIAL-') ||
        String(vpnAccount.data_limit || '').toLowerCase().trim() === '1gb'
    );
    if (isTrialAccount) {
      return {
        success: false,
        autoRenewed: false,
        provisional: false,
        provisioningStatus: 'pending',
        fallbackToManual: true,
        blockedReason: 'trial_not_renewable',
        message: 'Free trial accounts cannot be automatically renewed.',
      };
    }

    const clientUuid = String(vpnAccount.uuid).trim();
    targetClientUuid = clientUuid;

    // Locate parent order and verify it is an approved/paid order (never allow auto-renew on an unpaid provisional or rejected order!)
    let parentOrder: any = null;
    if (vpnAccount.order_id) {
      const { data } = await dbClient.from('orders').select('*').eq('id', vpnAccount.order_id).maybeSingle();
      if (data) parentOrder = data;
    }
    if (!parentOrder) {
      const { data } = await dbClient
        .from('orders')
        .select('*')
        .eq('client_uuid', clientUuid)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) parentOrder = data;
    }

    if (!parentOrder || !parentOrder.id) {
      return {
        success: false,
        autoRenewed: false,
        provisional: false,
        provisioningStatus: 'pending',
        fallbackToManual: true,
        blockedReason: 'parent_order_not_found',
        message: 'Parent order record not found for target VPN account. Held for manual admin review.',
      };
    }

    const parentOrderStatus = String(parentOrder.status || '').trim().toLowerCase();
    const parentPayStatus = String(parentOrder.payment_status || '').trim().toLowerCase();
    const parentProvStatus = String(parentOrder.provisioning_status || '').trim().toLowerCase();

    const isParentPaidAndCompleted =
      (parentOrderStatus === 'completed' || parentOrderStatus === 'active' || parentOrderStatus === 'approved') &&
      (parentPayStatus === 'paid' || parentPayStatus === 'approved' || parentPayStatus === 'verified') &&
      parentProvStatus !== 'provisional' &&
      parentProvStatus !== 'revoked' &&
      parentProvStatus !== 'revoke_failed';

    if (!isParentPaidAndCompleted) {
      return {
        success: false,
        autoRenewed: false,
        provisional: false,
        provisioningStatus: 'pending',
        fallbackToManual: true,
        blockedReason: 'parent_order_not_paid_verified',
        message: 'Parent VPN order is not yet payment-verified. Automatic renewal held for manual admin review.',
      };
    }

    // Acquire durable client-level lock `client:<uuid>` (Lock #2 in deterministic hierarchy)
    return await withClientMutationLock(
      {
        dbClient,
        clientUuid,
        operationType: 'client_lock',
        targetId: cleanRequestId,
        requireDurableLock: true,
        allowUncertainRecovery: false,
        metadata: { renewRequestId: cleanRequestId, parentOrderId: parentOrder.id },
      },
      async (assertClientLockStillHeld) => {
        // Check for any other unresolved renewal grant on this client UUID
        await assertNoUnresolvedClientRenewalGrant({
          dbClient,
          clientUuid,
          excludeRenewRequestId: cleanRequestId,
          operationDescription: 'automatic renewal provisioning',
        });

        // Re-read fresh vpn_accounts, vpn_configs, and parent order INSIDE client:<uuid> lock
        const { data: freshAcc } = await dbClient.from('vpn_accounts').select('*').eq('id', vpnAccount.id).maybeSingle();
        if (freshAcc) vpnAccount = freshAcc;

        const { data: freshParent } = await dbClient.from('orders').select('*').eq('id', parentOrder.id).maybeSingle();
        if (freshParent) parentOrder = freshParent;

        let { data: vpnConfig } = await dbClient.from('vpn_configs').select('*').eq('uuid', clientUuid).maybeSingle();
        if (!vpnConfig && parentOrder.id) {
          const { data: byOrdCfg } = await dbClient.from('vpn_configs').select('*').eq('order_id', parentOrder.id).maybeSingle();
          if (byOrdCfg) vpnConfig = byOrdCfg;
        }

        // Resolve live 3X-UI inbound and client
        const allInbounds = await getInboundsCall(true);
        let matchedInbound: any = null;
        let matchedClient: any = null;

        for (const ib of allInbounds) {
          let sObj: any = {};
          try {
            sObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings || {};
          } catch {
            continue;
          }
          const cList: any[] = Array.isArray(sObj.clients) ? sObj.clients : [];
          const found = cList.find(
            (c: any) => String(c.id || '').trim().toLowerCase() === clientUuid.toLowerCase()
          );
          if (found) {
            matchedInbound = ib;
            matchedClient = found;
            break;
          }
        }

        if (!matchedInbound || !matchedClient || !matchedInbound.id) {
          return {
            success: false,
            autoRenewed: false,
            provisional: false,
            provisioningStatus: 'pending',
            fallbackToManual: true,
            blockedReason: 'xui_client_not_found',
            message: 'Target VPN client was not found on live 3X-UI panel. Held for manual admin review.',
          };
        }

        const inboundId = Number(matchedInbound.id);

        // Extract live 3X-UI expiry, totalGB, and live traffic counters (up, down)
        const liveExpiryRaw = Number(matchedClient.expiryTime || 0);
        const liveExpiryMs =
          liveExpiryRaw > 0 && liveExpiryRaw < 10_000_000_000 ? liveExpiryRaw * 1000 : Math.max(0, Math.trunc(liveExpiryRaw));

        let dbExpiryMs = 0;
        if (vpnAccount.expiry_time && Number(vpnAccount.expiry_time) > 0) {
          const rawAccExp = Number(vpnAccount.expiry_time);
          dbExpiryMs = rawAccExp < 10_000_000_000 ? rawAccExp * 1000 : Math.trunc(rawAccExp);
        } else if (vpnAccount.expiry_date) {
          const parsed = new Date(vpnAccount.expiry_date).getTime();
          if (!Number.isNaN(parsed) && parsed > 0) dbExpiryMs = parsed;
        } else if (parentOrder.expiry_date) {
          const parsed = new Date(parentOrder.expiry_date).getTime();
          if (!Number.isNaN(parsed) && parsed > 0) dbExpiryMs = parsed;
        }

        // Check DB vs live 3X-UI expiry discrepancy (> 5 minutes falls back to manual verification).
        // Within <= 5 minutes (legitimate minor sync drift), live 3X-UI expiry is authoritative.
        const MAX_EXPIRY_DISCREPANCY_MS = 5 * 60 * 1000;
        const dbExpiryCandidates: Array<{ label: string; ms: number }> = [];
        if (dbExpiryMs > 0) dbExpiryCandidates.push({ label: 'vpn_accounts', ms: dbExpiryMs });
        if (vpnConfig?.expiry_date) {
          const cfgMs = new Date(vpnConfig.expiry_date).getTime();
          if (!Number.isNaN(cfgMs) && cfgMs > 0) dbExpiryCandidates.push({ label: 'vpn_configs', ms: cfgMs });
        }
        if (parentOrder?.expiry_date) {
          const ordMs = new Date(parentOrder.expiry_date).getTime();
          if (!Number.isNaN(ordMs) && ordMs > 0) dbExpiryCandidates.push({ label: 'orders', ms: ordMs });
        }

        if (liveExpiryMs > 0) {
          const excessiveDrift = dbExpiryCandidates.find(
            (cand) => Math.abs(liveExpiryMs - cand.ms) > MAX_EXPIRY_DISCREPANCY_MS
          );
          if (excessiveDrift) {
            console.warn(
              `[AutoRenew] Expiry discrepancy > 5m for client ${clientUuid} (${excessiveDrift.label}): live=${liveExpiryMs}, db=${excessiveDrift.ms}. Falling back to manual review.`
            );
            return {
              success: false,
              autoRenewed: false,
              provisional: false,
              provisioningStatus: 'pending',
              fallbackToManual: true,
              blockedReason: 'expiry_discrepancy_exceeds_threshold',
              message: 'Database and 3X-UI expiry timestamps differ by more than 5 minutes. Held for manual admin verification.',
            };
          }
        }

        const authoritativePrevExpiryMs = liveExpiryMs > 0 ? liveExpiryMs : dbExpiryMs;
        if (authoritativePrevExpiryMs <= 0) {
          return {
            success: false,
            autoRenewed: false,
            provisional: false,
            provisioningStatus: 'pending',
            fallbackToManual: true,
            blockedReason: 'missing_previous_expiry',
            message: 'Previous VPN expiry timestamp could not be determined. Held for manual admin review.',
          };
        }

        const authoritativePrevTotalBytes = Math.max(0, Math.trunc(Number(matchedClient.totalGB ?? vpnAccount.total_bytes ?? 0) || 0));
        const clientStats: any[] = Array.isArray(matchedInbound.clientStats) ? matchedInbound.clientStats : [];
        const statRow =
          clientStats.find((s: any) => String(s.id || '').trim().toLowerCase() === clientUuid.toLowerCase()) ||
          clientStats.find(
            (s: any) =>
              matchedClient.email &&
              String(s.email || '').trim().toLowerCase() === String(matchedClient.email).trim().toLowerCase()
          );

        const liveUpBytes = Math.max(
          0,
          Math.trunc(Number(statRow?.up ?? matchedClient.up ?? vpnAccount.up_bytes ?? 0) || 0)
        );
        const liveDownBytes = Math.max(
          0,
          Math.trunc(Number(statRow?.down ?? matchedClient.down ?? vpnAccount.down_bytes ?? 0) || 0)
        );

        // STRICT enable verification: pass raw values without coercing undefined/null to true!
        const rawLiveClientEnable: unknown = matchedClient.enable;
        const rawLiveInboundEnable: unknown = matchedInbound.enable;

        // Determine requested renewal duration and quota from verified renew_requests record
        const durationMonths = Math.max(
          1,
          Math.trunc(Number(extra.durationMonths || renewReq.duration_months || 1) || 1)
        );
        const combinedPlanStr = `${renewReq.plan_id || ''} ${renewReq.plan_name || ''} ${extra.package_type || ''} ${extra.data_limit || ''}`.toLowerCase();
        const isFinite100GbPackage =
          combinedPlanStr.includes('100gb') ||
          combinedPlanStr.includes('100 gb') ||
          combinedPlanStr.includes('sim_100') ||
          String(extra.data_limit || '').toLowerCase().includes('100');
        const ONE_HUNDRED_GB_BYTES = 100 * 1024 * 1024 * 1024;
        const addedQuotaBytes = isFinite100GbPackage ? ONE_HUNDRED_GB_BYTES * durationMonths : 0;

        const calc = calculateApprovedRenewalEntitlement({
          previousExpiryMs: authoritativePrevExpiryMs,
          previousTotalBytes: authoritativePrevTotalBytes,
          liveUpBytes,
          liveDownBytes,
          liveEnable: rawLiveClientEnable,
          inboundEnable: rawLiveInboundEnable,
          dbAccountStatus: vpnAccount.status,
          addedDurationMonths: durationMonths,
          addedQuotaBytes,
          nowMs,
        });

        if (!calc.eligible) {
          return {
            success: false,
            autoRenewed: false,
            provisional: false,
            provisioningStatus: 'pending',
            fallbackToManual: true,
            blockedReason: calc.code || 'ineligible_for_auto_renewal',
            message: calc.reason || 'Account is not eligible for automatic renewal. Held for manual admin review.',
          };
        }

        if (calc.grantedExpiryMs <= calc.previousExpiryMs) {
          return {
            success: false,
            autoRenewed: false,
            provisional: false,
            provisioningStatus: 'pending',
            fallbackToManual: true,
            blockedReason: 'non_increasing_granted_expiry',
            message: 'Calculated renewal expiry is not strictly greater than previous expiry. Held for manual admin review.',
          };
        }

        // Verified boolean enable (guaranteed === true by calculateApprovedRenewalEntitlement)
        const verifiedPrevEnable = rawLiveClientEnable === true;
        const normalizedPrevStatus = String(vpnAccount.status || 'active').trim() || 'active';

        // Build complete pre-renewal snapshot conforming to public.is_valid_pre_renewal_db_snapshot
        const preRenewalSnapshot = buildVerifiedPreRenewalDbSnapshot({
          capturedAtMs: nowMs,
          clientUuid,
          inboundId,
          previousExpiryMs: calc.previousExpiryMs,
          previousTotalBytes: calc.previousTotalBytes,
          previousUpBytes: calc.liveUpBytes,
          previousDownBytes: calc.liveDownBytes,
          previousEnable: verifiedPrevEnable,
          grantedExpiryMs: calc.grantedExpiryMs,
          grantedTotalBytes: calc.grantedTotalBytes,
          grantedDataLimit: calc.grantedDataLimitStr,
          vpnAccount: { ...vpnAccount, status: normalizedPrevStatus },
          parentOrder,
          vpnConfig,
          liveClient: matchedClient,
        });

        const prePersistIso = new Date(nowMs).toISOString();
        const packageName = String(
          extra.package_name || renewReq.plan_name || vpnConfig?.package_name || parentOrder.package_name || 'FIREVPN Package'
        ).trim();

        const preGrantPayload = {
          grant_type: 'renewal',
          source_id: cleanRequestId,
          renew_request_id: cleanRequestId,
          order_id: parentOrder.id,
          user_id: requestUserId || vpnAccount.user_id || parentOrder.customer_id,
          user_email: requestEmail || vpnAccount.email || parentOrder.email || '',
          vpn_account_id: vpnAccount.id,
          client_uuid: clientUuid,
          sub_id: matchedClient.subId ? String(matchedClient.subId) : null,
          inbound_id: inboundId,
          remark: matchedClient.email || vpnAccount.remark || '',
          package_name: packageName,
          duration_months: durationMonths,
          previous_expiry_ms: calc.previousExpiryMs,
          previous_total_bytes: calc.previousTotalBytes,
          previous_was_unlimited: calc.previousWasUnlimited,
          previous_enable: verifiedPrevEnable,
          previous_status: normalizedPrevStatus,
          previous_up_bytes: calc.liveUpBytes,
          previous_down_bytes: calc.liveDownBytes,
          pre_renewal_db_snapshot: preRenewalSnapshot,
          added_duration_months: durationMonths,
          granted_expiry_ms: calc.grantedExpiryMs,
          added_quota_bytes: calc.addedQuotaBytes,
          granted_total_bytes: calc.grantedTotalBytes,
          granted_unlimited: calc.grantedUnlimited,
          provisional: true,
          status: 'provisioning',
          updated_at: prePersistIso,
        };

        // Pre-persist entitlement grant row BEFORE modifying 3X-UI (fail closed if DB rejects snapshot)
        let grantRowId = existingGrant?.id || null;
        if (grantRowId) {
          const { error: updGrantErr } = await dbClient
            .from('vpn_entitlement_grants')
            .update(preGrantPayload)
            .eq('id', grantRowId);
          if (updGrantErr) {
            throw new Error(`Failed to pre-persist renewal entitlement grant before 3X-UI update: ${updGrantErr.message}`);
          }
        } else {
          const { data: insGrant, error: insGrantErr } = await dbClient
            .from('vpn_entitlement_grants')
            .insert({ ...preGrantPayload, created_at: prePersistIso })
            .select('id')
            .maybeSingle();
          if (insGrantErr || !insGrant?.id) {
            throw new Error(
              `Failed to pre-persist renewal entitlement grant before 3X-UI update: ${insGrantErr?.message || 'No grant ID returned'}`
            );
          }
          grantRowId = insGrant.id;
        }

        const preExtraNotes = {
          ...extra,
          old_expiry: new Date(calc.previousExpiryMs).toISOString(),
          new_expiry: new Date(calc.grantedExpiryMs).toISOString(),
        };

        const { error: preReqErr } = await dbClient
          .from('renew_requests')
          .update({
            provisioning_status: 'provisioning',
            notes: JSON.stringify(preExtraNotes),
            updated_at: prePersistIso,
          })
          .eq('id', cleanRequestId);

        if (preReqErr) {
          throw new Error(`Failed to update renew_requests status to provisioning before 3X-UI write: ${preReqErr.message}`);
        }

        let xuiWriteAttempted = false;
        let xuiWriteConfirmed = false;

        try {
          // Acquire inbound write lock `inbound:<inboundId>` (Lock #3 in deterministic hierarchy)
          await withInboundWriteLock(
            {
              dbClient,
              inboundId,
              targetId: `renew:${cleanRequestId}`,
              clientUuid,
              requireDurableLock: true,
            },
            async (assertInboundLockStillHeld) => {
              const fetchFreshInbound = async (): Promise<any | null> => {
                try {
                  const res = await requestApiCall<any>(`/panel/api/inbounds/get/${inboundId}`, 'GET');
                  const obj = res?.obj || res;
                  if (obj && typeof obj === 'object' && obj.id !== undefined) return obj;
                } catch (_e) {}
                const list = await getInboundsCall(true);
                return list.find((ib: any) => Number(ib.id) === Number(inboundId)) || null;
              };

              const liveInboundObj = await fetchFreshInbound();
              if (!liveInboundObj) {
                throw new Error(`Unable to fetch live inbound ${inboundId} from 3X-UI panel for renewal.`);
              }

              // Re-verify inbound.enable === true inside the inbound write lock before any 3X-UI mutation
              if (liveInboundObj.enable !== true) {
                const disabledIbErr: any = new Error(
                  `Inbound ${inboundId} is disabled or ambiguous (enable=${String(liveInboundObj.enable)}) inside write lock. Aborting automatic renewal.`
                );
                disabledIbErr.blockedReason = 'INBOUND_DISABLED_OR_AMBIGUOUS';
                throw disabledIbErr;
              }

              let settingsObj: any = {};
              if (typeof liveInboundObj.settings === 'string') {
                try {
                  settingsObj = JSON.parse(liveInboundObj.settings);
                } catch {
                  settingsObj = { clients: [] };
                }
              } else if (liveInboundObj.settings && typeof liveInboundObj.settings === 'object') {
                settingsObj = { ...liveInboundObj.settings };
              }

              const clientsList: any[] = Array.isArray(settingsObj.clients) ? [...settingsObj.clients] : [];
              const cIdx = clientsList.findIndex(
                (c: any) => String(c.id || '').trim().toLowerCase() === clientUuid.toLowerCase()
              );
              if (cIdx < 0) {
                throw new Error(`Client ${clientUuid} no longer found on inbound ${inboundId} inside write lock.`);
              }

              // Re-verify client.enable === true inside the inbound write lock before any 3X-UI mutation
              if (clientsList[cIdx].enable !== true) {
                const disabledClientErr: any = new Error(
                  `Client ${clientUuid} is disabled or ambiguous (enable=${String(clientsList[cIdx].enable)}) inside write lock. Refusing unauthorized re-enable.`
                );
                disabledClientErr.blockedReason = 'CLIENT_DISABLED_OR_AMBIGUOUS';
                throw disabledClientErr;
              }

              // Update ONLY expiryTime, totalGB, and enable: true while preserving all credentials (id, email, password, auth, subId, flow, etc.)
              clientsList[cIdx] = {
                ...clientsList[cIdx],
                id: clientUuid,
                expiryTime: calc.grantedExpiryMs,
                totalGB: calc.grantedTotalBytes,
                enable: true,
              };
              settingsObj.clients = clientsList;

              const updatePayload: any = {
                ...liveInboundObj,
                id: inboundId,
                settings: JSON.stringify(settingsObj),
              };
              delete updatePayload.up;
              delete updatePayload.down;
              delete updatePayload.clientStats;
              delete updatePayload.trafficReset;
              delete updatePayload.lastTrafficResetTime;

              // Verify all 3 locks are still held right before dispatching external 3X-UI mutation
              await assertInboundLockStillHeld();
              await assertClientLockStillHeld();
              const renewStillHeld = await renewDurableProvisioningOperationLock({
                dbClient,
                operationKey: renewLockKey,
                lockOwnerId: renewLockRes.lockOwnerId,
              });
              if (!renewStillHeld) {
                const fenceErr: any = new Error(`Lost durable renewal lock '${renewLockKey}' before 3X-UI write.`);
                fenceErr.statusCode = 409;
                throw fenceErr;
              }

              xuiWriteAttempted = true;
              const updateRes = await requestApiCall<any>(
                `/panel/api/inbounds/update/${inboundId}`,
                'POST',
                updatePayload
              );
              if (updateRes && updateRes.success === false) {
                throw new Error(updateRes.msg || updateRes.message || '3X-UI panel rejected renewal inbound update.');
              }

              // MANDATORY READ-BACK VERIFICATION from live 3X-UI panel
              const afterInbound = await fetchFreshInbound();
              if (!afterInbound) {
                throw new Error(`Read-back verification failed: unable to re-fetch inbound ${inboundId} after renewal write.`);
              }
              if (afterInbound.enable !== true) {
                throw new Error(
                  `Read-back verification failed: inbound ${inboundId} is not enabled (enable=${String(afterInbound.enable)}) after renewal write.`
                );
              }
              let afterSettings: any = {};
              try {
                afterSettings =
                  typeof afterInbound.settings === 'string'
                    ? JSON.parse(afterInbound.settings)
                    : afterInbound.settings || {};
              } catch {
                afterSettings = {};
              }
              const verifiedClient = (Array.isArray(afterSettings.clients) ? afterSettings.clients : []).find(
                (c: any) => String(c.id || '').trim().toLowerCase() === clientUuid.toLowerCase()
              );

              if (
                !verifiedClient ||
                verifiedClient.enable !== true ||
                Number(verifiedClient.expiryTime) !== calc.grantedExpiryMs ||
                Number(verifiedClient.totalGB) !== calc.grantedTotalBytes
              ) {
                throw new Error(
                  `Read-back verification failed for renewed client ${clientUuid} on inbound ${inboundId}: expected enable=true, expiryTime=${calc.grantedExpiryMs}, totalGB=${calc.grantedTotalBytes}; got enable=${String(verifiedClient?.enable)}, expiryTime=${String(verifiedClient?.expiryTime)}, totalGB=${String(verifiedClient?.totalGB)}.`
                );
              }

              xuiWriteConfirmed = true;
              invalidateInboundCache(inboundId);
            }
          );
        } catch (xuiErr: any) {
          const errText = xuiErr?.message || String(xuiErr);
          const isUncertain = xuiWriteAttempted && !xuiWriteConfirmed;
          renewLockOutcome = isUncertain ? 'uncertain' : 'failed';
          renewLockError = errText;

          try {
            if (isUncertain) {
              await dbClient
                .from('vpn_entitlement_grants')
                .update({
                  status: 'uncertain',
                  last_error: errText,
                  updated_at: new Date().toISOString(),
                })
                .eq('id', grantRowId);
            } else if (grantRowId) {
              // 3X-UI write was never dispatched; delete the temporary 'provisioning' row
              // so vpn_entitlement_grants_status_check is satisfied and manual admin approval remains unblocked.
              await dbClient
                .from('vpn_entitlement_grants')
                .delete()
                .eq('id', grantRowId);
            }
          } catch (_e) {}

          try {
            await dbClient
              .from('renew_requests')
              .update({
                provisioning_status: isUncertain ? 'uncertain' : 'pending',
                updated_at: new Date().toISOString(),
              })
              .eq('id', cleanRequestId);
          } catch (_e) {}

          return {
            success: false,
            autoRenewed: false,
            provisional: false,
            provisioningStatus: isUncertain ? 'uncertain' : 'pending',
            fallbackToManual: true,
            blockedReason: xuiErr?.blockedReason || (isUncertain ? 'xui_write_uncertain' : 'xui_update_failed'),
            uuid: clientUuid,
            inboundId,
            message: errText,
          };
        }

        // Step 6: Update Supabase records after confirmed 3X-UI read-back verification.
        // CRITICAL SAFETY: If ANY database write fails AFTER 3X-UI has been mutated, we MUST NOT
        // release the lock as 'completed' and MUST NOT return autoRenewed=true; we mark the durable
        // lock, grant, and renewal request as 'uncertain' so duplicate retries are blocked until reconciliation.
        const finalNowIso = new Date().toISOString();
        const grantedExpiryIso = new Date(calc.grantedExpiryMs).toISOString();
        const dataAllowanceLabel =
          calc.addedQuotaBytes > 0
            ? `${Math.round(calc.addedQuotaBytes / (1024 * 1024 * 1024))} GB`
            : 'Unlimited';

        try {
          const { error: accUpdErr } = await dbClient
            .from('vpn_accounts')
            .update({
              expiry_time: calc.grantedExpiryMs,
              expiry_date: grantedExpiryIso,
              total_bytes: calc.grantedTotalBytes,
              data_limit: calc.grantedDataLimitStr,
              status: 'active',
              enable: true,
              updated_at: finalNowIso,
            })
            .eq('id', vpnAccount.id);

          if (accUpdErr) {
            throw new Error(`Failed to update vpn_accounts after 3X-UI renewal: ${accUpdErr.message}`);
          }

          if (vpnConfig?.id) {
            const { error: cfgUpdErr } = await dbClient
              .from('vpn_configs')
              .update({
                expiry_date: grantedExpiryIso,
                data_limit: calc.grantedDataLimitStr,
                enabled: true,
                status: 'active',
              })
              .eq('id', vpnConfig.id);

            if (cfgUpdErr) {
              throw new Error(`Failed to update vpn_configs after 3X-UI renewal: ${cfgUpdErr.message}`);
            }
          }

          // Update orders.expiry_date while keeping orders.payment_status='Paid' and orders.status='completed'
          const { error: ordUpdErr } = await dbClient
            .from('orders')
            .update({
              expiry_date: grantedExpiryIso,
              updated_at: finalNowIso,
            })
            .eq('id', parentOrder.id);

          if (ordUpdErr) {
            throw new Error(`Failed to update orders.expiry_date after 3X-UI renewal: ${ordUpdErr.message}`);
          }

          // Promote vpn_entitlement_grants to 'provisional'
          const { error: grantPromErr } = await dbClient
            .from('vpn_entitlement_grants')
            .update({
              status: 'provisional',
              provisional: true,
              last_error: null,
              updated_at: finalNowIso,
            })
            .eq('id', grantRowId);

          if (grantPromErr) {
            throw new Error(`Failed to promote renewal vpn_entitlement_grants to provisional: ${grantPromErr.message}`);
          }

          // Keep renew_requests.status = 'pending' and set renew_requests.provisioning_status = 'provisional'
          const updatedExtra = {
            ...extra,
            old_expiry: new Date(calc.previousExpiryMs).toISOString(),
            new_expiry: grantedExpiryIso,
            data_allowance: dataAllowanceLabel,
            provisional_renewal: true,
            calculation_mode: calc.mode,
          };

          const { error: reqUpdErr } = await dbClient
            .from('renew_requests')
            .update({
              status: 'pending',
              provisioning_status: 'provisional',
              notes: JSON.stringify(updatedExtra),
              updated_at: finalNowIso,
            })
            .eq('id', cleanRequestId);

          if (reqUpdErr) {
            throw new Error(`Failed to update renew_requests provisioning_status to provisional: ${reqUpdErr.message}`);
          }
        } catch (postXuiDbErr: any) {
          const dbErrText = postXuiDbErr?.message || String(postXuiDbErr);
          console.error(
            `[AutoRenew] CRITICAL: Database sync failed AFTER confirmed 3X-UI renewal write for request ${cleanRequestId} (client ${clientUuid}):`,
            dbErrText
          );
          renewLockOutcome = 'uncertain';
          renewLockError = dbErrText;

          try {
            await dbClient
              .from('vpn_entitlement_grants')
              .update({
                status: 'uncertain',
                last_error: dbErrText,
                updated_at: new Date().toISOString(),
              })
              .eq('id', grantRowId);
          } catch (_e) {}

          try {
            await dbClient
              .from('renew_requests')
              .update({
                provisioning_status: 'uncertain',
                updated_at: new Date().toISOString(),
              })
              .eq('id', cleanRequestId);
          } catch (_e) {}

          return {
            success: false,
            autoRenewed: false,
            provisional: false,
            provisioningStatus: 'uncertain',
            fallbackToManual: true,
            blockedReason: 'post_xui_db_sync_failed',
            uuid: clientUuid,
            inboundId,
            message: `3X-UI renewal succeeded but database sync failed (${dbErrText}). Marked 'uncertain' for safe admin reconciliation.`,
          };
        }

        if (!options?.skipSideEffects) {
          try {
            await createCustomerNotification({
              userId: requestUserId || vpnAccount.user_id || null,
              userEmail: requestEmail || vpnAccount.email,
              title: 'VPN Renewed (Payment Pending Verification)',
              message: `Your VPN subscription "${packageName}" has been renewed until ${new Date(calc.grantedExpiryMs).toLocaleDateString()}! Payment verification is pending admin review.`,
              type: 'renewal_approved',
              vpnName: packageName,
            });
          } catch (notifErr: any) {
            console.warn('[AutoRenew] Customer notification warning:', notifErr?.message || notifErr);
          }
          triggerBackgroundSyncIfNeeded('VPN Provisionally Renewed', true);
        }

        return {
          success: true,
          autoRenewed: true,
          provisional: true,
          provisioningStatus: 'provisional',
          mode: calc.mode,
          uuid: clientUuid,
          inboundId,
          oldExpiryIso: new Date(calc.previousExpiryMs).toISOString(),
          newExpiryIso: grantedExpiryIso,
          grantedExpiryMs: calc.grantedExpiryMs,
          grantedTotalBytes: calc.grantedTotalBytes,
          addedQuotaBytes: calc.addedQuotaBytes,
          dataAllowanceLabel,
          packageName,
          message: 'VPN subscription renewed and provisionally activated pending payment verification.',
        };
      }
    );
  } finally {
    if (renewLockRes.tableAvailable) {
      await finalizeDurableProvisioningOperationLock({
        dbClient,
        operationKey: renewLockKey,
        lockOwnerId: renewLockRes.lockOwnerId,
        status: renewLockOutcome,
        clientUuid: targetClientUuid,
        errorMessage: renewLockError,
      });
    }
  }
}

export interface ConfirmProvisionalRenewalOptions {
  adminLabel?: string;
  dbClient?: any;
  getInboundsFn?: typeof getInbounds;
  heldRenewLockOwnerId?: string;
}

/**
 * Confirms an already provisionally applied renewal upon Admin or Telegram approval
 * WITHOUT extending expiry or adding quota a second time.
 * Works regardless of whether AUTO_ACTIVATE_RENEWALS_ENABLED is currently true or false.
 */
export async function confirmProvisionalRenewal(
  renewRequestId: string,
  options?: ConfirmProvisionalRenewalOptions
): Promise<{
  handledAsProvisional: boolean;
  confirmed?: boolean;
  uuid?: string;
  newExpiryIso?: string;
  oldExpiryIso?: string;
  durationMonths?: number;
  packageName?: string;
}> {
  const dbClient = options?.dbClient || supabaseAdmin;
  const getInboundsCall = options?.getInboundsFn || getInbounds;
  const cleanRequestId = String(renewRequestId || '').trim();

  const { data: grantRow, error: grantErr } = await dbClient
    .from('vpn_entitlement_grants')
    .select('*')
    .eq('grant_type', 'renewal')
    .eq('source_id', cleanRequestId)
    .maybeSingle();

  if (grantErr) {
    if (isMissingSchemaOrRpcError(grantErr) && !isAutoActivateRenewalsFlagEnabled()) {
      return { handledAsProvisional: false };
    }
    throw new Error(`Failed to lookup renewal entitlement grant: ${grantErr.message}`);
  }

  if (!grantRow) {
    return { handledAsProvisional: false };
  }

  if (grantRow.status === 'revoked' || grantRow.status === 'revoke_failed') {
    const conflictErr: any = new Error(
      `Renewal request '${cleanRequestId}' has already been rejected/revoked (grant status=${grantRow.status}) and cannot be approved.`
    );
    conflictErr.statusCode = 409;
    throw conflictErr;
  }

  if (grantRow.status === 'provisioning') {
    const conflictErr: any = new Error(
      `Renewal request '${cleanRequestId}' currently has an in-flight provisioning grant (status=provisioning). Please wait or verify live 3X-UI client state before approving.`
    );
    conflictErr.statusCode = 409;
    throw conflictErr;
  }

  const isUncertainReconciliation = grantRow.status === 'uncertain';
  const clientUuid = String(grantRow.client_uuid || '').trim();
  const grantedExpiryMs = Number(grantRow.granted_expiry_ms || 0);
  const grantedTotalBytes = Number(grantRow.granted_total_bytes || 0);
  const previousExpiryMs = Number(grantRow.previous_expiry_ms || 0);
  const snapshot =
    grantRow.pre_renewal_db_snapshot && typeof grantRow.pre_renewal_db_snapshot === 'object'
      ? grantRow.pre_renewal_db_snapshot
      : null;

  return await withClientMutationLock(
    {
      dbClient,
      clientUuid,
      operationType: 'client_lock',
      targetId: `approve_renew:${cleanRequestId}`,
      requireDurableLock: true,
      allowUncertainRecovery: true,
      metadata: { renewRequestId: cleanRequestId, action: 'confirm_provisional_renewal' },
    },
    async () => {
      // Verify live 3X-UI inbound and client reflect the provisionally granted entitlement
      const liveInbounds = await getInboundsCall(true);
      let liveInbound: any = null;
      let liveClient: any = null;
      for (const ib of liveInbounds) {
        let sObj: any = {};
        try {
          sObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings || {};
        } catch {
          continue;
        }
        const found = (Array.isArray(sObj.clients) ? sObj.clients : []).find(
          (c: any) => String(c.id || '').trim().toLowerCase() === clientUuid.toLowerCase()
        );
        if (found) {
          liveInbound = ib;
          liveClient = found;
          break;
        }
      }

      if (isUncertainReconciliation) {
        // Durable uncertain-state reconciliation:
        // Only confirm & sync DB without modifying 3X-UI if live 3X-UI EXACTLY matches the granted entitlement.
        const exactMatch =
          Boolean(liveInbound && liveInbound.enable === true) &&
          Boolean(liveClient && liveClient.enable === true) &&
          Number(liveClient?.expiryTime || 0) === grantedExpiryMs &&
          Number(liveClient?.totalGB ?? -1) === grantedTotalBytes;

        if (!exactMatch) {
          const conflictErr: any = new Error(
            `Uncertain renewal '${cleanRequestId}' cannot be confirmed automatically because live 3X-UI state (inboundEnable=${String(liveInbound?.enable)}, clientEnable=${String(liveClient?.enable)}, expiryTime=${String(liveClient?.expiryTime)}, totalGB=${String(liveClient?.totalGB)}) does not exactly match granted entitlement (expiryTime=${grantedExpiryMs}, totalGB=${grantedTotalBytes}).`
          );
          conflictErr.statusCode = 409;
          conflictErr.markLockUncertain = true;
          throw conflictErr;
        }
      } else {
        if (
          !liveInbound ||
          liveInbound.enable !== true ||
          !liveClient ||
          liveClient.enable !== true ||
          Number(liveClient.expiryTime || 0) < grantedExpiryMs
        ) {
          const conflictErr: any = new Error(
            `Live 3X-UI client '${clientUuid}' does not match the provisional renewal grant (inboundEnable=${String(liveInbound?.enable)}, liveEnable=${String(liveClient?.enable)}, live expiryTime=${String(liveClient?.expiryTime)}, expected expiryTime>=${grantedExpiryMs}). Refusing to mark verified without reconciliation.`
          );
          conflictErr.statusCode = 409;
          throw conflictErr;
        }
      }

      const nowIso = new Date().toISOString();
      const newExpiryIso = new Date(grantedExpiryMs).toISOString();
      const oldExpiryIso = previousExpiryMs > 0 ? new Date(previousExpiryMs).toISOString() : undefined;

      // If reconciling an 'uncertain' grant (e.g., after post-3X-UI DB sync failure or timeout),
      // synchronize Supabase records to the verified live 3X-UI entitlement WITHOUT touching 3X-UI again.
      if (isUncertainReconciliation) {
        const grantedDataLimit =
          String(
            snapshot?.granted_db_state?.granted_data_limit ||
              (grantedTotalBytes === 0
                ? 'Unlimited'
                : `${Math.max(1, Math.round(Number(grantRow.added_quota_bytes || grantedTotalBytes) / (1024 * 1024 * 1024)))}GB`)
          ).trim() || 'Unlimited';

        if (grantRow.vpn_account_id) {
          const { error: accSyncErr } = await dbClient
            .from('vpn_accounts')
            .update({
              expiry_time: grantedExpiryMs,
              expiry_date: newExpiryIso,
              total_bytes: grantedTotalBytes,
              data_limit: grantedDataLimit,
              status: 'active',
              enable: true,
              updated_at: nowIso,
            })
            .eq('id', grantRow.vpn_account_id);
          if (accSyncErr) {
            throw new Error(`Failed to reconcile vpn_accounts for uncertain grant: ${accSyncErr.message}`);
          }
        }

        const snapCfg = snapshot?.vpn_config;
        if (snapCfg && snapCfg.exists === true && snapCfg.id) {
          const { error: cfgSyncErr } = await dbClient
            .from('vpn_configs')
            .update({
              expiry_date: newExpiryIso,
              data_limit: grantedDataLimit,
              enabled: true,
              status: 'active',
            })
            .eq('id', snapCfg.id);
          if (cfgSyncErr) {
            throw new Error(`Failed to reconcile vpn_configs for uncertain grant: ${cfgSyncErr.message}`);
          }
        }

        if (grantRow.order_id) {
          const { error: ordSyncErr } = await dbClient
            .from('orders')
            .update({
              expiry_date: newExpiryIso,
              updated_at: nowIso,
            })
            .eq('id', grantRow.order_id);
          if (ordSyncErr) {
            throw new Error(`Failed to reconcile orders.expiry_date for uncertain grant: ${ordSyncErr.message}`);
          }
        }
      }

      // 1. Mark vpn_entitlement_grants as 'verified'
      const { error: verifyErr } = await dbClient
        .from('vpn_entitlement_grants')
        .update({
          status: 'verified',
          verified_at: nowIso,
          verified_by: options?.adminLabel || 'Admin',
          last_error: null,
          updated_at: nowIso,
        })
        .eq('id', grantRow.id);

      if (verifyErr) {
        throw new Error(`Failed to mark renewal entitlement grant verified: ${verifyErr.message}`);
      }

      // 2. Merge audit fields into renew_requests.notes and mark status='approved', provisioning_status='completed'
      const { data: currentReqRow } = await dbClient
        .from('renew_requests')
        .select('notes')
        .eq('id', cleanRequestId)
        .maybeSingle();

      let mergedNotes: Record<string, any> = {};
      if (currentReqRow?.notes && typeof currentReqRow.notes === 'string' && currentReqRow.notes.startsWith('{')) {
        try {
          mergedNotes = JSON.parse(currentReqRow.notes);
        } catch {
          mergedNotes = {};
        }
      }
      mergedNotes = {
        ...mergedNotes,
        ...(oldExpiryIso ? { old_expiry: oldExpiryIso } : {}),
        new_expiry: newExpiryIso,
        approved_at: nowIso,
        approved_by: options?.adminLabel || 'Admin',
        provisional_confirmed: true,
        ...(isUncertainReconciliation ? { reconciled_from_uncertain: true } : {}),
      };

      const { error: reqUpdErr } = await dbClient
        .from('renew_requests')
        .update({
          status: 'approved',
          provisioning_status: 'completed',
          notes: JSON.stringify(mergedNotes),
          updated_at: nowIso,
        })
        .eq('id', cleanRequestId);

      if (reqUpdErr) {
        throw new Error(`Failed to mark provisionally renewed request approved: ${reqUpdErr.message}`);
      }

      return {
        handledAsProvisional: true,
        confirmed: true,
        uuid: clientUuid,
        newExpiryIso,
        oldExpiryIso,
        durationMonths: Number(grantRow.added_duration_months || grantRow.duration_months || 1),
        packageName: grantRow.package_name || 'VPN Subscription',
      };
    }
  );
}

export interface RevokeProvisionalRenewalOptions {
  adminLabel?: string;
  dbClient?: any;
  requestApiFn?: typeof requestApi;
  getInboundsFn?: typeof getInbounds;
  nowMs?: number;
}

/**
 * Safely rolls back an unpaid provisional renewal upon Admin or Telegram rejection:
 * - Works even when AUTO_ACTIVATE_RENEWALS_ENABLED=false.
 * - Acquires `client:<uuid>` and `inbound:<inboundId>` locks.
 * - Verifies no newer renewal or unrelated admin change occurred on the client (`liveExpiryMs === grant.granted_expiry_ms`
 *   and `liveTotalBytes === grant.granted_total_bytes`; if mismatched, marks 'uncertain' and refuses blind overwrite).
 * - Restores `expiryTime = grant.previous_expiry_ms` and `totalGB = grant.previous_total_bytes` on 3X-UI
 *   WITHOUT restoring stale `up`/`down` traffic counters.
 * - Sets `enable = Boolean(grant.previous_enable) && !restoredIsExpired && !restoredIsExhausted` so that:
 *   - If the customer's pre-renewal entitlement is still unexpired and unexhausted, their valid paid VPN access remains active!
 *   - If the customer's pre-renewal entitlement was already expired or exhausted, the client is disabled and read-back verified
 *     so unpaid VPN access is no longer possible!
 * - Restores `vpn_accounts`, `vpn_configs`, and `orders.expiry_date` from `pre_renewal_db_snapshot` while preserving `orders.payment_status = 'Paid'`.
 * - Marks `vpn_entitlement_grants.status = 'revoked'` and `renew_requests.provisioning_status = 'revoked'`.
 */
export async function revokeProvisionalRenewal(
  renewRequestId: string,
  reason: string,
  options?: RevokeProvisionalRenewalOptions
): Promise<{
  handledAsProvisional: boolean;
  revoked: boolean;
  uuid?: string;
  inboundId?: number | null;
  restoredExpiryMs?: number;
  restoredTotalBytes?: number;
  restoredEnable?: boolean;
  restoredStatus?: 'active' | 'expired' | 'disabled';
  reason?: string;
}> {
  const dbClient = options?.dbClient || supabaseAdmin;
  const requestApiCall = options?.requestApiFn || requestApi;
  const getInboundsCall = options?.getInboundsFn || getInbounds;
  const nowMs = options?.nowMs ?? Date.now();
  const cleanRequestId = String(renewRequestId || '').trim();

  const { data: grantRow, error: grantErr } = await dbClient
    .from('vpn_entitlement_grants')
    .select('*')
    .eq('grant_type', 'renewal')
    .eq('source_id', cleanRequestId)
    .maybeSingle();

  if (grantErr) {
    if (isMissingSchemaOrRpcError(grantErr) && !isAutoActivateRenewalsFlagEnabled()) {
      return { handledAsProvisional: false, revoked: false };
    }
    throw new Error(`Failed to lookup renewal entitlement grant for rejection: ${grantErr.message}`);
  }

  // If no renewal grant exists, this is a standard manual pending renewal request (no 3X-UI rollback needed)
  if (!grantRow) {
    return { handledAsProvisional: false, revoked: false };
  }

  if (grantRow.status === 'revoked') {
    return {
      handledAsProvisional: true,
      revoked: true,
      uuid: grantRow.client_uuid,
      inboundId: grantRow.inbound_id,
      restoredExpiryMs: Number(grantRow.previous_expiry_ms || 0),
      restoredTotalBytes: Number(grantRow.previous_total_bytes || 0),
      reason: 'Provisional renewal grant was already revoked.',
    };
  }

  if (grantRow.status === 'verified') {
    const conflictErr: any = new Error(
      `Renewal request '${cleanRequestId}' has already been payment-verified and approved; refusing to revoke confirmed paid renewal.`
    );
    conflictErr.statusCode = 409;
    throw conflictErr;
  }

  const clientUuid = String(grantRow.client_uuid || '').trim();
  const inboundId = Number(grantRow.inbound_id || 0);
  const prevExpiryMs = Math.max(0, Math.trunc(Number(grantRow.previous_expiry_ms || 0)));
  const prevTotalBytes = Math.max(0, Math.trunc(Number(grantRow.previous_total_bytes || 0)));
  const prevEnable = grantRow.previous_enable !== false;
  const grantedExpiryMs = Math.max(0, Math.trunc(Number(grantRow.granted_expiry_ms || 0)));
  const grantedTotalBytes = Math.max(0, Math.trunc(Number(grantRow.granted_total_bytes || 0)));
  const snapshot = (grantRow.pre_renewal_db_snapshot && typeof grantRow.pre_renewal_db_snapshot === 'object')
    ? grantRow.pre_renewal_db_snapshot
    : null;

  if (!clientUuid || !inboundId || !snapshot) {
    const conflictErr: any = new Error(
      `Renewal grant '${grantRow.id}' is missing required pre-renewal snapshot or inbound metadata; manual reconciliation required.`
    );
    conflictErr.statusCode = 409;
    throw conflictErr;
  }

  return await withClientMutationLock(
    {
      dbClient,
      clientUuid,
      operationType: 'client_lock',
      targetId: `reject_renew:${cleanRequestId}`,
      requireDurableLock: true,
      allowUncertainRecovery: true,
      metadata: { renewRequestId: cleanRequestId, action: 'revoke_provisional_renewal', reason },
    },
    async (assertClientLockStillHeld) => {
      // Check if any OTHER newer renewal grant was created for this client after this grant
      const { data: otherClientGrants } = await dbClient
        .from('vpn_entitlement_grants')
        .select('id, source_id, status, created_at')
        .eq('client_uuid', clientUuid)
        .eq('grant_type', 'renewal')
        .neq('id', grantRow.id);

      const hasNewerActiveGrant = (otherClientGrants || []).some((g: any) => {
        const st = String(g.status || '').toLowerCase();
        if (st === 'revoked' || st === 'failed') return false;
        const gCreated = g.created_at ? new Date(g.created_at).getTime() : 0;
        const curCreated = grantRow.created_at ? new Date(grantRow.created_at).getTime() : 0;
        return gCreated >= curCreated;
      });

      if (hasNewerActiveGrant) {
        const nowIso = new Date().toISOString();
        await dbClient
          .from('vpn_entitlement_grants')
          .update({
            status: 'uncertain',
            last_error: 'Newer renewal grant exists on client; automatic rollback blocked to prevent overwriting newer state.',
            updated_at: nowIso,
          })
          .eq('id', grantRow.id);
        await dbClient
          .from('renew_requests')
          .update({
            provisioning_status: 'uncertain',
            updated_at: nowIso,
          })
          .eq('id', cleanRequestId);

        const conflictErr: any = new Error(
          `Cannot automatically roll back renewal '${cleanRequestId}' because another active/newer renewal grant exists for client '${clientUuid}'. Marked 'uncertain' for manual reconciliation.`
        );
        conflictErr.statusCode = 409;
        conflictErr.markLockUncertain = true;
        throw conflictErr;
      }

      let restoredEnable = false;
      let restoredStatus = 'active' as 'active' | 'expired' | 'disabled';

      try {
        await withInboundWriteLock(
          {
            dbClient,
            inboundId,
            targetId: `reject_renew:${cleanRequestId}`,
            clientUuid,
            requireDurableLock: true,
          },
          async (assertInboundLockStillHeld) => {
            const fetchFreshInbound = async (): Promise<any | null> => {
              try {
                const res = await requestApiCall<any>(`/panel/api/inbounds/get/${inboundId}`, 'GET');
                const obj = res?.obj || res;
                if (obj && typeof obj === 'object' && obj.id !== undefined) return obj;
              } catch (_e) {}
              const list = await getInboundsCall(true);
              return list.find((ib: any) => Number(ib.id) === Number(inboundId)) || null;
            };

            const liveInbound = await fetchFreshInbound();
            if (!liveInbound) {
              throw new Error(`Unable to fetch live inbound ${inboundId} from 3X-UI for renewal rollback.`);
            }

            let settingsObj: any = {};
            if (typeof liveInbound.settings === 'string') {
              try {
                settingsObj = JSON.parse(liveInbound.settings);
              } catch {
                settingsObj = { clients: [] };
              }
            } else if (liveInbound.settings && typeof liveInbound.settings === 'object') {
              settingsObj = { ...liveInbound.settings };
            }

            const clientsList: any[] = Array.isArray(settingsObj.clients) ? [...settingsObj.clients] : [];
            const cIdx = clientsList.findIndex(
              (c: any) => String(c.id || '').trim().toLowerCase() === clientUuid.toLowerCase()
            );

            if (cIdx < 0) {
              throw new Error(`Client '${clientUuid}' not found on inbound ${inboundId} during renewal rollback.`);
            }

            const liveClient = clientsList[cIdx];
            const liveClientExpiryMs = Math.max(0, Math.trunc(Number(liveClient.expiryTime || 0)));
            const liveClientTotalBytes = Math.max(0, Math.trunc(Number(liveClient.totalGB || 0)));

            // Verify no unrelated admin modification occurred on 3X-UI since the provisional renewal was applied.
            // (Allow idempotent retry if 3X-UI already matches prevExpiryMs & prevTotalBytes from an interrupted rollback.)
            const matchesGrantedState =
              liveClientExpiryMs === grantedExpiryMs && liveClientTotalBytes === grantedTotalBytes;
            const matchesAlreadyRestoredState =
              liveClientExpiryMs === prevExpiryMs && liveClientTotalBytes === prevTotalBytes;

            if (!matchesGrantedState && !matchesAlreadyRestoredState) {
              const nowIso = new Date().toISOString();
              await dbClient
                .from('vpn_entitlement_grants')
                .update({
                  status: 'uncertain',
                  last_error: `Live 3X-UI state (expiryTime=${liveClientExpiryMs}, totalGB=${liveClientTotalBytes}) differs from expected provisional grant (expiryTime=${grantedExpiryMs}, totalGB=${grantedTotalBytes}).`,
                  updated_at: nowIso,
                })
                .eq('id', grantRow.id);
              await dbClient
                .from('renew_requests')
                .update({
                  provisioning_status: 'uncertain',
                  updated_at: nowIso,
                })
                .eq('id', cleanRequestId);

              const conflictErr: any = new Error(
                `Live 3X-UI client '${clientUuid}' was modified after provisional renewal (live expiryTime=${liveClientExpiryMs}, totalGB=${liveClientTotalBytes}; expected expiryTime=${grantedExpiryMs}, totalGB=${grantedTotalBytes}). Refusing blind overwrite; marked 'uncertain' for reconciliation.`
              );
              conflictErr.statusCode = 409;
              conflictErr.markLockUncertain = true;
              throw conflictErr;
            }

            // Read live cumulative traffic counters (NEVER restore stale up/down counters!)
            const clientStats: any[] = Array.isArray(liveInbound.clientStats) ? liveInbound.clientStats : [];
            const statRow =
              clientStats.find((s: any) => String(s.id || '').trim().toLowerCase() === clientUuid.toLowerCase()) ||
              clientStats.find(
                (s: any) =>
                  liveClient.email &&
                  String(s.email || '').trim().toLowerCase() === String(liveClient.email).trim().toLowerCase()
              );
            const currentLiveUpBytes = Math.max(0, Math.trunc(Number(statRow?.up ?? liveClient.up ?? 0) || 0));
            const currentLiveDownBytes = Math.max(0, Math.trunc(Number(statRow?.down ?? liveClient.down ?? 0) || 0));
            const currentLiveUsedBytes = currentLiveUpBytes + currentLiveDownBytes;

            const restoredIsExpired = prevExpiryMs > 0 && prevExpiryMs <= nowMs;
            const restoredIsExhausted = prevTotalBytes > 0 && currentLiveUsedBytes >= prevTotalBytes;
            restoredEnable = Boolean(prevEnable) && !restoredIsExpired && !restoredIsExhausted;
            restoredStatus = restoredEnable
              ? 'active'
              : restoredIsExpired || restoredIsExhausted
              ? 'expired'
              : 'disabled';

            clientsList[cIdx] = {
              ...liveClient,
              id: clientUuid,
              expiryTime: prevExpiryMs,
              totalGB: prevTotalBytes,
              enable: restoredEnable,
            };
            settingsObj.clients = clientsList;

            const updatePayload: any = {
              ...liveInbound,
              id: inboundId,
              settings: JSON.stringify(settingsObj),
            };
            delete updatePayload.up;
            delete updatePayload.down;
            delete updatePayload.clientStats;
            delete updatePayload.trafficReset;
            delete updatePayload.lastTrafficResetTime;

            await assertInboundLockStillHeld();
            await assertClientLockStillHeld();

            const updateRes = await requestApiCall<any>(
              `/panel/api/inbounds/update/${inboundId}`,
              'POST',
              updatePayload
            );
            if (updateRes && updateRes.success === false) {
              throw new Error(updateRes.msg || updateRes.message || '3X-UI rejected renewal rollback update.');
            }

            // MANDATORY READ-BACK VERIFICATION from live 3X-UI
            const verifiedInbound = await fetchFreshInbound();
            if (!verifiedInbound) {
              throw new Error(`Read-back verification failed: unable to re-fetch inbound ${inboundId} after renewal rollback.`);
            }
            let verifiedSettings: any = {};
            try {
              verifiedSettings =
                typeof verifiedInbound.settings === 'string'
                  ? JSON.parse(verifiedInbound.settings)
                  : verifiedInbound.settings || {};
            } catch {
              verifiedSettings = {};
            }
            const verifiedClient = (Array.isArray(verifiedSettings.clients) ? verifiedSettings.clients : []).find(
              (c: any) => String(c.id || '').trim().toLowerCase() === clientUuid.toLowerCase()
            );

            if (
              !verifiedClient ||
              Boolean(verifiedClient.enable) !== restoredEnable ||
              Number(verifiedClient.expiryTime) !== prevExpiryMs ||
              Number(verifiedClient.totalGB) !== prevTotalBytes
            ) {
              throw new Error(
                `Read-back verification failed after renewal rollback for client ${clientUuid}: expected enable=${restoredEnable}, expiryTime=${prevExpiryMs}, totalGB=${prevTotalBytes}; got enable=${String(verifiedClient?.enable)}, expiryTime=${String(verifiedClient?.expiryTime)}, totalGB=${String(verifiedClient?.totalGB)}.`
              );
            }

            invalidateInboundCache(inboundId);
          }
        );
      } catch (err: any) {
        if (err?.statusCode === 409) {
          throw err;
        }
        const nowIso = new Date().toISOString();
        const errText = err?.message || String(err);
        await dbClient
          .from('vpn_entitlement_grants')
          .update({
            status: 'revoke_failed',
            last_error: errText,
            updated_at: nowIso,
          })
          .eq('id', grantRow.id);
        await dbClient
          .from('renew_requests')
          .update({
            provisioning_status: 'revoke_failed',
            updated_at: nowIso,
          })
          .eq('id', cleanRequestId);

        throw new Error(
          `Failed to roll back provisional renewal on 3X-UI (retained in recoverable 'revoke_failed' state): ${errText}`
        );
      }

      // Restore vpn_accounts, vpn_configs, and parent orders.expiry_date from pre_renewal_db_snapshot
      const nowIso = new Date().toISOString();
      const restoredExpiryIso = new Date(prevExpiryMs).toISOString();
      const snapAcc = snapshot.vpn_account || {};
      const snapOrd = snapshot.parent_order || {};
      const snapCfg = snapshot.vpn_config || {};
      const restoredDataLimit =
        String(
          snapAcc.data_limit ||
            (prevTotalBytes > 0 ? `${Math.max(1, Math.round(prevTotalBytes / (1024 * 1024 * 1024)))}GB` : 'Unlimited')
        ).trim() || 'Unlimited';

      if (snapAcc.id || grantRow.vpn_account_id) {
        const { error: accRestoreErr } = await dbClient
          .from('vpn_accounts')
          .update({
            expiry_time: prevExpiryMs,
            expiry_date: restoredExpiryIso,
            total_bytes: prevTotalBytes,
            data_limit: restoredDataLimit,
            status: restoredStatus,
            enable: restoredEnable,
            updated_at: nowIso,
          })
          .eq('id', snapAcc.id || grantRow.vpn_account_id);
        if (accRestoreErr) {
          throw new Error(`Failed to restore vpn_accounts from pre_renewal_db_snapshot: ${accRestoreErr.message}`);
        }
      }

      if (snapCfg.exists === true && snapCfg.id) {
        await dbClient
          .from('vpn_configs')
          .update({
            expiry_date: restoredExpiryIso,
            data_limit: String(snapCfg.data_limit || restoredDataLimit),
            enabled: restoredEnable,
            status: restoredStatus,
          })
          .eq('id', snapCfg.id);
      } else if (snapCfg.exists !== false) {
        await dbClient
          .from('vpn_configs')
          .update({
            expiry_date: restoredExpiryIso,
            data_limit: restoredDataLimit,
            enabled: restoredEnable,
            status: restoredStatus,
          })
          .eq('uuid', clientUuid);
      }

      // Restore parent order expiry_date while strictly preserving its paid/completed status!
      if (snapOrd.id || grantRow.order_id) {
        await dbClient
          .from('orders')
          .update({
            expiry_date: snapOrd.expiry_date === null ? null : restoredExpiryIso,
            status: restoredStatus === 'expired' ? 'expired' : (snapOrd.status || 'completed'),
            payment_status: snapOrd.payment_status || 'Paid',
            provisioning_status: snapOrd.provisioning_status || 'completed',
            updated_at: nowIso,
          })
          .eq('id', snapOrd.id || grantRow.order_id);
      }

      // Mark renewal grant as 'revoked'
      const { error: grantRevokeErr } = await dbClient
        .from('vpn_entitlement_grants')
        .update({
          status: 'revoked',
          revoked_at: nowIso,
          revoked_by: options?.adminLabel || 'Admin',
          revoke_reason: reason,
          last_error: null,
          updated_at: nowIso,
        })
        .eq('id', grantRow.id);

      if (grantRevokeErr) {
        throw new Error(`Failed to mark renewal grant revoked: ${grantRevokeErr.message}`);
      }

      // Mark renew_requests as 'rejected' and provisioning_status = 'revoked'
      const { error: reqRevokeErr } = await dbClient
        .from('renew_requests')
        .update({
          status: 'rejected',
          provisioning_status: 'revoked',
          updated_at: nowIso,
        })
        .eq('id', cleanRequestId);

      if (reqRevokeErr) {
        throw new Error(`Failed to mark provisionally renewed request rejected/revoked: ${reqRevokeErr.message}`);
      }

      return {
        handledAsProvisional: true,
        revoked: true,
        uuid: clientUuid,
        inboundId,
        restoredExpiryMs: prevExpiryMs,
        restoredTotalBytes: prevTotalBytes,
        restoredEnable,
        restoredStatus,
      };
    }
  );
}




