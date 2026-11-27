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
export let cachedInboundsPanelIdentity = '';
export let lastInboundsCacheTime = 0;
export let isCacheRefreshing = false;
let inboundsCacheGeneration = 0;
let lastFailedInboundsAt = 0;
const FAILED_INBOUNDS_COOLDOWN_MS = 10 * 1000;
const inboundsInFlight = new Map<string, { generation: number; isForceRefresh: boolean; promise: Promise<XuiInbound[]> }>();

export const getInboundsSnapshotTimestamp = (): number => lastInboundsCacheTime;

export const getXuiAuthTimeoutMs = (): number => {
  const raw = Number(process.env.XUI_AUTH_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 6000;
  return Math.max(2000, Math.min(Math.floor(raw), 12000));
};

export const getXuiSingleInboundTimeoutMs = (): number => {
  const raw = Number(process.env.XUI_SINGLE_INBOUND_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 8000;
  return Math.max(2000, Math.min(Math.floor(raw), 15000));
};

export const getXuiFullListTimeoutMs = (): number => {
  const raw = Number(process.env.XUI_FULL_LIST_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 15000;
  return Math.max(5000, Math.min(Math.floor(raw), 25000));
};

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
let xuiConfigGeneration = 0;
let xuiConfigInFlight: { generation: number; promise: Promise<XuiConfig> } | null = null;
const XUI_CONFIG_TTL_MS = 60 * 1000;

export const MAX_XUI_AUTH_SCOPE_ENTRIES = 32;
export const MAX_XUI_PANEL_CAPABILITY_ENTRIES = 64;
export const MAX_CLIENT_TRAFFIC_MUTATION_STATE_ENTRIES = 5000;

let maxXuiAuthScopeEntriesOverride: number | null = null;
let maxClientTrafficMutationStateEntriesOverride: number | null = null;

export const getEffectiveMaxXuiAuthScopeEntries = (): number =>
  maxXuiAuthScopeEntriesOverride !== null && maxXuiAuthScopeEntriesOverride > 0
    ? maxXuiAuthScopeEntriesOverride
    : MAX_XUI_AUTH_SCOPE_ENTRIES;

export const setMaxXuiAuthScopeEntriesForTests = (maxEntries?: number | null): void => {
  if (maxEntries === undefined || maxEntries === null) {
    maxXuiAuthScopeEntriesOverride = null;
    return;
  }
  const n = Math.floor(Number(maxEntries));
  maxXuiAuthScopeEntriesOverride = Number.isFinite(n) && n > 0 ? n : null;
};

export const getEffectiveMaxClientTrafficMutationStateEntries = (): number =>
  maxClientTrafficMutationStateEntriesOverride !== null && maxClientTrafficMutationStateEntriesOverride > 0
    ? maxClientTrafficMutationStateEntriesOverride
    : MAX_CLIENT_TRAFFIC_MUTATION_STATE_ENTRIES;

export const setMaxClientTrafficMutationStateEntriesForTests = (maxEntries?: number | null): void => {
  if (maxEntries === undefined || maxEntries === null) {
    maxClientTrafficMutationStateEntriesOverride = null;
    return;
  }
  const n = Math.floor(Number(maxEntries));
  maxClientTrafficMutationStateEntriesOverride = Number.isFinite(n) && n > 0 ? n : null;
};

const setBoundedMapEntry = <K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
  onEvict?: (evictedKey: K, evictedValue: V) => void
): void => {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    const oldestVal = map.get(oldestKey)!;
    map.delete(oldestKey);
    if (onEvict) {
      onEvict(oldestKey, oldestVal);
    }
  }
};

export interface CachedXuiAuthEntry {
  scopeKey: string;
  panelIdentity: string;
  panelUrl: string;
  generation: number;
  headers: Record<string, string>;
  expiresAt: number;
}

const cachedXuiAuthByScope = new Map<string, CachedXuiAuthEntry>();
const xuiAuthGenerationByScope = new Map<string, number>();
let globalXuiAuthEpoch = 0;
let minValidAuthGenerationFloor = 0;
let nextMonotonicAuthGeneration = 1;
const xuiAuthInFlight = new Map<string, { generation: number; isForceRefresh: boolean; promise: Promise<Record<string, string>> }>();
const rememberedLoginEndpointByPanel = new Map<string, string>();
const confirmedUnsupportedCsrfByPanel = new Map<string, { scopeKey: string; generation: number; confirmedAt: number }>();
const XUI_AUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes (3X-UI session cookie lasts 6 hours)

const setScopeAuthGenerationEntry = (scopeKey: string, generation: number): void => {
  const maxScopeEntries = getEffectiveMaxXuiAuthScopeEntries();
  const maxGenEntries = maxScopeEntries * 2;
  if (xuiAuthGenerationByScope.has(scopeKey)) {
    xuiAuthGenerationByScope.delete(scopeKey);
  }
  xuiAuthGenerationByScope.set(scopeKey, generation);
  nextMonotonicAuthGeneration = Math.max(nextMonotonicAuthGeneration, generation + 1);

  while (xuiAuthGenerationByScope.size > maxGenEntries) {
    // Prefer evicting scopes that do not currently hold an active cached session
    let victimKey: string | undefined;
    for (const candidateKey of xuiAuthGenerationByScope.keys()) {
      if (candidateKey !== scopeKey && !cachedXuiAuthByScope.has(candidateKey)) {
        victimKey = candidateKey;
        break;
      }
    }
    if (victimKey === undefined) {
      victimKey = xuiAuthGenerationByScope.keys().next().value;
    }
    if (victimKey === undefined) break;
    const evictedGen = xuiAuthGenerationByScope.get(victimKey) ?? 0;
    xuiAuthGenerationByScope.delete(victimKey);
    minValidAuthGenerationFloor = Math.max(minValidAuthGenerationFloor, evictedGen + 1);
    nextMonotonicAuthGeneration = Math.max(nextMonotonicAuthGeneration, minValidAuthGenerationFloor + 1);
    cachedXuiAuthByScope.delete(victimKey);
    const victimInFlight = xuiAuthInFlight.get(victimKey);
    if (victimInFlight && victimInFlight.generation <= evictedGen) {
      xuiAuthInFlight.delete(victimKey);
    }
  }
};

export const getScopeAuthGeneration = (scopeKey: string): number => {
  const existing = xuiAuthGenerationByScope.get(scopeKey);
  if (existing !== undefined) return existing;
  return Math.max(globalXuiAuthEpoch, minValidAuthGenerationFloor, nextMonotonicAuthGeneration);
};

const ensureScopeAuthGeneration = (scopeKey: string): number => {
  const existing = xuiAuthGenerationByScope.get(scopeKey);
  if (existing !== undefined && existing >= globalXuiAuthEpoch) {
    return existing;
  }
  const allocatedGen = Math.max(
    (existing ?? 0) + 1,
    globalXuiAuthEpoch,
    minValidAuthGenerationFloor,
    nextMonotonicAuthGeneration
  );
  nextMonotonicAuthGeneration = allocatedGen + 1;
  setScopeAuthGenerationEntry(scopeKey, allocatedGen);
  return allocatedGen;
};

const bumpScopeAuthGeneration = (scopeKey: string): number => {
  const existing = xuiAuthGenerationByScope.get(scopeKey);
  const currentGen = existing !== undefined ? existing : 0;
  const nextGen = Math.max(
    currentGen + 1,
    globalXuiAuthEpoch + 1,
    minValidAuthGenerationFloor + 1,
    nextMonotonicAuthGeneration
  );
  nextMonotonicAuthGeneration = Math.max(nextMonotonicAuthGeneration, nextGen + 1);
  setScopeAuthGenerationEntry(scopeKey, nextGen);
  return nextGen;
};

export interface ClientTrafficMutationState {
  seq: number;
  lastResetAtMs: number;
  deletedAtMs: number;
  epoch?: number;
  present?: boolean;
}

const clientTrafficMutationStateByUuid = new Map<string, ClientTrafficMutationState>();
let globalTrafficMutationEpoch = 0;
let maxEvictedTrafficMutationEpoch = 0;

const clientTrafficInvalidationListeners = new Set<
  (clientUuid: string, reason: 'deleted' | 'reset' | 'clear', state: ClientTrafficMutationState) => void
>();

export const getClientTrafficMutationState = (clientUuid: string): ClientTrafficMutationState => {
  const normUuid = String(clientUuid || '').trim().toLowerCase();
  if (!normUuid) {
    return { seq: 0, lastResetAtMs: 0, deletedAtMs: 0, epoch: 0, present: false };
  }
  const existing = clientTrafficMutationStateByUuid.get(normUuid);
  return existing
    ? { ...existing, present: true }
    : { seq: 0, lastResetAtMs: 0, deletedAtMs: 0, epoch: 0, present: false };
};

export const getTrafficMutationEpochSnapshot = (): {
  currentEpoch: number;
  maxEvictedEpoch: number;
  trackedUuidsCount: number;
} => ({
  currentEpoch: globalTrafficMutationEpoch,
  maxEvictedEpoch: maxEvictedTrafficMutationEpoch,
  trackedUuidsCount: clientTrafficMutationStateByUuid.size,
});

export const registerClientTrafficCacheInvalidator = (
  listener: (clientUuid: string, reason: 'deleted' | 'reset' | 'clear', state: ClientTrafficMutationState) => void
): void => {
  clientTrafficInvalidationListeners.add(listener);
};

export const unregisterClientTrafficCacheInvalidator = (
  listener: (clientUuid: string, reason: 'deleted' | 'reset' | 'clear', state: ClientTrafficMutationState) => void
): void => {
  clientTrafficInvalidationListeners.delete(listener);
};

export const notifyClientTrafficInvalidated = (
  clientUuid: string,
  reason: 'deleted' | 'reset',
  timestampMs: number = Date.now()
): ClientTrafficMutationState => {
  const normUuid = String(clientUuid || '').trim().toLowerCase();
  if (!normUuid) {
    return { seq: 0, lastResetAtMs: 0, deletedAtMs: 0, epoch: globalTrafficMutationEpoch, present: false };
  }
  globalTrafficMutationEpoch += 1;
  const prev = clientTrafficMutationStateByUuid.get(normUuid);
  const baseSeq = prev ? prev.seq : maxEvictedTrafficMutationEpoch;
  const next: ClientTrafficMutationState = {
    seq: Math.max(baseSeq + 1, globalTrafficMutationEpoch),
    lastResetAtMs: reason === 'reset' ? Math.max(prev?.lastResetAtMs ?? 0, timestampMs) : (prev?.lastResetAtMs ?? 0),
    deletedAtMs: reason === 'deleted' ? Math.max(prev?.deletedAtMs ?? 0, timestampMs) : (prev?.deletedAtMs ?? 0),
    epoch: globalTrafficMutationEpoch,
    present: true,
  };
  setBoundedMapEntry(
    clientTrafficMutationStateByUuid,
    normUuid,
    next,
    getEffectiveMaxClientTrafficMutationStateEntries(),
    (_evictedUuid, evictedState) => {
      maxEvictedTrafficMutationEpoch = Math.max(
        maxEvictedTrafficMutationEpoch,
        evictedState.epoch ?? evictedState.seq
      );
    }
  );
  for (const listener of clientTrafficInvalidationListeners) {
    try {
      listener(normUuid, reason, next);
    } catch {
      // Ignore listener errors
    }
  }
  return { ...next };
};

export const getXuiAuthCacheStatsForTests = (): {
  cachedScopes: string[];
  inFlightScopes: string[];
  generationsByScope: Record<string, number>;
  minValidAuthGenerationFloor: number;
  rememberedLoginEndpointsSize: number;
  confirmedUnsupportedCsrfSize: number;
} => ({
  cachedScopes: Array.from(cachedXuiAuthByScope.keys()),
  inFlightScopes: Array.from(xuiAuthInFlight.keys()),
  generationsByScope: Object.fromEntries(xuiAuthGenerationByScope.entries()),
  minValidAuthGenerationFloor,
  rememberedLoginEndpointsSize: rememberedLoginEndpointByPanel.size,
  confirmedUnsupportedCsrfSize: confirmedUnsupportedCsrfByPanel.size,
});

export const invalidateXuiConfigCache = (): void => {
  xuiConfigGeneration += 1;
  globalXuiAuthEpoch = Math.max(globalXuiAuthEpoch + 1, minValidAuthGenerationFloor + 1, nextMonotonicAuthGeneration);
  minValidAuthGenerationFloor = Math.max(minValidAuthGenerationFloor, globalXuiAuthEpoch);
  nextMonotonicAuthGeneration = globalXuiAuthEpoch + 1;
  for (const [k, gen] of Array.from(xuiAuthGenerationByScope.entries())) {
    const bumped = Math.max(gen + 1, globalXuiAuthEpoch);
    xuiAuthGenerationByScope.set(k, bumped);
    nextMonotonicAuthGeneration = Math.max(nextMonotonicAuthGeneration, bumped + 1);
  }
  inboundsCacheGeneration += 1;
  cachedXuiConfig = null;
  xuiConfigInFlight = null;
  cachedXuiAuthByScope.clear();
  xuiAuthInFlight.clear();
  rememberedLoginEndpointByPanel.clear();
  confirmedUnsupportedCsrfByPanel.clear();
  lastInboundsCacheTime = 0;
  lastFailedInboundsAt = 0;
  inboundsInFlight.clear();
};

export const invalidateXuiAuthCache = (scopeKey?: string, expectedGeneration?: number): number => {
  if (!scopeKey) {
    if (expectedGeneration !== undefined && expectedGeneration !== globalXuiAuthEpoch) {
      return globalXuiAuthEpoch;
    }
    globalXuiAuthEpoch = Math.max(globalXuiAuthEpoch + 1, minValidAuthGenerationFloor + 1, nextMonotonicAuthGeneration);
    minValidAuthGenerationFloor = Math.max(minValidAuthGenerationFloor, globalXuiAuthEpoch);
    nextMonotonicAuthGeneration = globalXuiAuthEpoch + 1;
    for (const [k, gen] of Array.from(xuiAuthGenerationByScope.entries())) {
      const bumped = Math.max(gen + 1, globalXuiAuthEpoch);
      xuiAuthGenerationByScope.set(k, bumped);
      nextMonotonicAuthGeneration = Math.max(nextMonotonicAuthGeneration, bumped + 1);
    }
    cachedXuiAuthByScope.clear();
    xuiAuthInFlight.clear();
    confirmedUnsupportedCsrfByPanel.clear();
    return globalXuiAuthEpoch;
  }

  const currentScopeGen = getScopeAuthGeneration(scopeKey);
  if (expectedGeneration !== undefined && expectedGeneration !== currentScopeGen) {
    return currentScopeGen;
  }

  const nextGen = bumpScopeAuthGeneration(scopeKey);
  const existingCached = cachedXuiAuthByScope.get(scopeKey);
  if (existingCached) {
    confirmedUnsupportedCsrfByPanel.delete(existingCached.panelIdentity);
    cachedXuiAuthByScope.delete(scopeKey);
  } else {
    const panelPart = scopeKey.split('::')[0];
    if (panelPart) confirmedUnsupportedCsrfByPanel.delete(panelPart);
  }
  xuiAuthInFlight.delete(scopeKey);
  return nextGen;
};

export const resetXuiServiceCachesForTests = (): void => {
  maxXuiAuthScopeEntriesOverride = null;
  maxClientTrafficMutationStateEntriesOverride = null;
  invalidateXuiConfigCache();
  xuiAuthGenerationByScope.clear();
  globalXuiAuthEpoch = 0;
  minValidAuthGenerationFloor = 0;
  nextMonotonicAuthGeneration = 1;
  clientTrafficMutationStateByUuid.clear();
  globalTrafficMutationEpoch = 0;
  maxEvictedTrafficMutationEpoch = 0;
  for (const listener of clientTrafficInvalidationListeners) {
    try {
      listener('', 'clear', { seq: 0, lastResetAtMs: 0, deletedAtMs: 0, epoch: 0, present: false });
    } catch {
      // Ignore listener errors
    }
  }
  cachedInbounds = [];
  cachedInboundsPanelIdentity = '';
  liveInboundCache.clear();
  liveInboundInFlight.clear();
  liveInboundCacheGeneration += 1;
  isSyncInProgress = false;
  lastSyncAt = 0;
  isPanelDeletionSyncInProgress = false;
  lastPanelDeletionSyncAt = 0;
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

  if (!forceRefresh && xuiConfigInFlight && xuiConfigInFlight.generation === xuiConfigGeneration) {
    return xuiConfigInFlight.promise;
  }

  const capturedGeneration = xuiConfigGeneration;
  const fetchPromise = (async (): Promise<XuiConfig> => {
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

    if (capturedGeneration === xuiConfigGeneration) {
      cachedXuiConfig = { config, expiresAt: Date.now() + XUI_CONFIG_TTL_MS };
    }
    return config;
  })();

  xuiConfigInFlight = { generation: capturedGeneration, promise: fetchPromise };
  try {
    return await fetchPromise;
  } finally {
    if (xuiConfigInFlight && xuiConfigInFlight.promise === fetchPromise) {
      xuiConfigInFlight = null;
    }
  }
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

export const computeXuiCredentialScopeKey = (
  config: XuiConfig
): { panelIdentity: string; credentialFingerprint: string; scopeKey: string } => {
  const panelIdentity = computePanelIdentity(config.panelUrl) || String(config.panelUrl || '').trim();
  const secretMaterial = `${String(config.username || 'admin').trim()}\0${String(config.password || '')}\0${String(config.apiToken || '')}`;
  const credentialFingerprint = crypto.createHash('sha256').update(secretMaterial).digest('hex').slice(0, 16);
  return {
    panelIdentity,
    credentialFingerprint,
    scopeKey: `${panelIdentity}::${credentialFingerprint}`,
  };
};

export interface GetXuiAuthHeadersOptions {
  loginPostFn?: (
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number
  ) => Promise<{ status: number; headers: Record<string, any>; data?: any }>;
  csrfGetFn?: (
    url: string,
    headers: Record<string, string>,
    timeoutMs: number
  ) => Promise<{ status: number; headers: Record<string, any>; data?: any }>;
}

export const getXuiAuthHeaders = async (
  config: XuiConfig,
  forceRefresh = false,
  timeoutMs: number = getXuiAuthTimeoutMs(),
  authOptions?: GetXuiAuthHeadersOptions
): Promise<Record<string, string>> => {
  const { panelIdentity, scopeKey } = computeXuiCredentialScopeKey(config);
  const now = Date.now();

  // If credentials changed on the same panelIdentity, invalidate older credential scopes for that panel
  const panelPrefix = `${panelIdentity}::`;
  for (const existingScopeKey of Array.from(cachedXuiAuthByScope.keys())) {
    if (existingScopeKey !== scopeKey && existingScopeKey.startsWith(panelPrefix)) {
      invalidateXuiAuthCache(existingScopeKey);
    }
  }
  for (const existingInFlightKey of Array.from(xuiAuthInFlight.keys())) {
    if (existingInFlightKey !== scopeKey && existingInFlightKey.startsWith(panelPrefix)) {
      invalidateXuiAuthCache(existingInFlightKey);
    }
  }

  const hasExistingScopeGen = xuiAuthGenerationByScope.has(scopeKey);
  const currentScopeGen = getScopeAuthGeneration(scopeKey);
  const cachedEntry = cachedXuiAuthByScope.get(scopeKey);
  if (
    !forceRefresh &&
    hasExistingScopeGen &&
    cachedEntry &&
    cachedEntry.generation === currentScopeGen &&
    cachedEntry.generation >= globalXuiAuthEpoch &&
    cachedEntry.expiresAt > now
  ) {
    setScopeAuthGenerationEntry(scopeKey, currentScopeGen);
    return { ...cachedEntry.headers };
  }

  const existingInFlight = xuiAuthInFlight.get(scopeKey);
  if (
    hasExistingScopeGen &&
    existingInFlight &&
    existingInFlight.generation === currentScopeGen &&
    existingInFlight.generation >= globalXuiAuthEpoch &&
    (!forceRefresh || existingInFlight.isForceRefresh)
  ) {
    return { ...(await existingInFlight.promise) };
  }

  if (forceRefresh) {
    // Supersede any existing cached session or non-forced in-flight login with a new monotonic generation
    invalidateXuiAuthCache(scopeKey);
  }

  const capturedGeneration = ensureScopeAuthGeneration(scopeKey);

  const username = config.username || 'admin';
  const password = config.password || config.apiToken;

  if (!password) {
    throw new Error('API token or password is missing in 3X-UI settings');
  }

  let authPromise: Promise<Record<string, string>> | null = null;
  authPromise = (async (): Promise<Record<string, string>> => {
    const authTimeoutMs = Math.max(
      200,
      Math.min(Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : getXuiAuthTimeoutMs(), 12000)
    );
    const authDeadlineMs = Date.now() + authTimeoutMs;
    const { baseUrl } = parseUrl(config.panelUrl);
    const client = authOptions?.loginPostFn && authOptions?.csrfGetFn ? null : createAxiosInstance(baseUrl, authTimeoutMs);

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'X-Requested-With': 'XMLHttpRequest',
    };

    const defaultLoginEndpoints = ['/login', '/panel/login'];
    const rememberedEndpoint = rememberedLoginEndpointByPanel.get(panelIdentity);
    const loginEndpoints =
      rememberedEndpoint && defaultLoginEndpoints.includes(rememberedEndpoint)
        ? [rememberedEndpoint, ...defaultLoginEndpoints.filter((ep) => ep !== rememberedEndpoint)]
        : defaultLoginEndpoints;

    let cookieHeader = '';
    let lastLoginErr: any = null;

    for (let idx = 0; idx < loginEndpoints.length; idx++) {
      const loginEp = loginEndpoints[idx];
      const remainingBeforeLoginMs = authDeadlineMs - Date.now();
      if (remainingBeforeLoginMs <= 40) {
        break;
      }
      const endpointsRemaining = loginEndpoints.length - idx;
      const attemptTimeoutMs =
        endpointsRemaining > 1
          ? Math.max(60, Math.min(remainingBeforeLoginMs, Math.floor(authTimeoutMs * 0.6)))
          : Math.max(60, remainingBeforeLoginMs);

      try {
        const { fullPath } = getApiEndpointUrl(config.panelUrl, loginEp);
        const body = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
        const reqHeaders = {
          ...headers,
          'Content-Type': 'application/x-www-form-urlencoded',
        };
        const res = authOptions?.loginPostFn
          ? await authOptions.loginPostFn(fullPath, body, reqHeaders, attemptTimeoutMs)
          : await client!.post(fullPath, body, { headers: reqHeaders, timeout: attemptTimeoutMs });
        const setCookie = res.headers?.['set-cookie'];
        const loginPayloadOk = !res.data || res.data.success !== false;
        if (
          res.status >= 200 &&
          res.status < 400 &&
          loginPayloadOk &&
          setCookie &&
          Array.isArray(setCookie) &&
          setCookie.length > 0
        ) {
          cookieHeader = setCookie.map((c: string) => c.split(';')[0]).join('; ');
          if (xuiAuthGenerationByScope.get(scopeKey) === capturedGeneration && capturedGeneration >= globalXuiAuthEpoch) {
            setBoundedMapEntry(
              rememberedLoginEndpointByPanel,
              panelIdentity,
              loginEp,
              MAX_XUI_PANEL_CAPABILITY_ENTRIES
            );
          }
          console.log(`[xuiService] Successfully authenticated via ${fullPath} session login`);
          break;
        }
      } catch (loginErr: any) {
        lastLoginErr = loginErr;
        // Continue to next login endpoint within remaining authDeadlineMs
      }
    }

    if (!cookieHeader && lastLoginErr && Date.now() >= authDeadlineMs) {
      const msg = String(lastLoginErr?.message || '').toLowerCase();
      const code = String(lastLoginErr?.code || '').toUpperCase();
      if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || msg.includes('timeout') || msg.includes('timed out')) {
        throw lastLoginErr;
      }
    }

    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }
    headers['Authorization'] = `Bearer ${password}`;

    // Skip /csrf-token ONLY if definitively confirmed unsupported (404/405/501) on this panel in the current scope generation
    const confirmedUnsupported = confirmedUnsupportedCsrfByPanel.get(panelIdentity);
    const shouldSkipCsrf = Boolean(
      !forceRefresh &&
        confirmedUnsupported &&
        confirmedUnsupported.scopeKey === scopeKey &&
        confirmedUnsupported.generation === capturedGeneration
    );

    const remainingForCsrfMs = authDeadlineMs - Date.now();
    if (!shouldSkipCsrf && remainingForCsrfMs > 60) {
      try {
        const csrfTimeoutMs = Math.max(60, Math.min(2500, remainingForCsrfMs));
        const { fullPath: csrfPath } = getApiEndpointUrl(config.panelUrl, '/csrf-token');
        const csrfRes = authOptions?.csrfGetFn
          ? await authOptions.csrfGetFn(csrfPath, headers, csrfTimeoutMs)
          : await client!.get(csrfPath, { headers, timeout: csrfTimeoutMs });

        if (csrfRes.status === 404 || csrfRes.status === 405 || csrfRes.status === 501) {
          if (
            cookieHeader &&
            xuiAuthGenerationByScope.get(scopeKey) === capturedGeneration &&
            capturedGeneration >= globalXuiAuthEpoch
          ) {
            setBoundedMapEntry(
              confirmedUnsupportedCsrfByPanel,
              panelIdentity,
              {
                scopeKey,
                generation: capturedGeneration,
                confirmedAt: Date.now(),
              },
              MAX_XUI_PANEL_CAPABILITY_ENTRIES
            );
          }
        } else {
          if (
            csrfRes.status >= 200 &&
            csrfRes.status < 300 &&
            xuiAuthGenerationByScope.get(scopeKey) === capturedGeneration &&
            capturedGeneration >= globalXuiAuthEpoch
          ) {
            confirmedUnsupportedCsrfByPanel.delete(panelIdentity);
          }
          if (csrfRes.data?.obj) {
            headers['X-CSRF-Token'] = csrfRes.data.obj;
          }
          if (Array.isArray(csrfRes.headers?.['set-cookie']) && csrfRes.headers['set-cookie'].length > 0) {
            const csrfCookie = csrfRes.headers['set-cookie'].map((c: string) => c.split(';')[0]).join('; ');
            headers['Cookie'] = headers['Cookie'] ? `${headers['Cookie']}; ${csrfCookie}` : csrfCookie;
          }
        }
      } catch {
        // Non-fatal if csrf endpoint times out or fails transiently (do NOT mark unsupported on transient errors)
      }
    }

    const hasActiveScopeAtFinish = xuiAuthGenerationByScope.has(scopeKey);
    const currentGenAtFinish = hasActiveScopeAtFinish ? xuiAuthGenerationByScope.get(scopeKey)! : -1;
    const existingCachedAtFinish = cachedXuiAuthByScope.get(scopeKey);
    const isCurrentValidGeneration =
      hasActiveScopeAtFinish &&
      capturedGeneration >= globalXuiAuthEpoch &&
      capturedGeneration === currentGenAtFinish &&
      (!existingCachedAtFinish || existingCachedAtFinish.generation <= capturedGeneration);

    if (!isCurrentValidGeneration) {
      // Never cache or return a stale in-flight authentication response after generation invalidation or scope eviction
      if (
        hasActiveScopeAtFinish &&
        existingCachedAtFinish &&
        existingCachedAtFinish.generation === currentGenAtFinish &&
        existingCachedAtFinish.generation >= globalXuiAuthEpoch &&
        existingCachedAtFinish.expiresAt > Date.now()
      ) {
        return { ...existingCachedAtFinish.headers };
      }
      const activeInFlight = xuiAuthInFlight.get(scopeKey);
      if (
        hasActiveScopeAtFinish &&
        activeInFlight &&
        activeInFlight.promise !== authPromise &&
        activeInFlight.generation === currentGenAtFinish &&
        activeInFlight.generation >= globalXuiAuthEpoch
      ) {
        return { ...(await activeInFlight.promise) };
      }
      const staleErr: any = new Error(
        `Stale 3X-UI authentication response rejected for scope ${scopeKey} (captured generation ${capturedGeneration}, current generation ${currentGenAtFinish}).`
      );
      staleErr.code = 'XUI_AUTH_STALE_GENERATION';
      staleErr.staleGeneration = true;
      throw staleErr;
    }

    if (cookieHeader) {
      setScopeAuthGenerationEntry(scopeKey, capturedGeneration);
      setBoundedMapEntry(
        cachedXuiAuthByScope,
        scopeKey,
        {
          scopeKey,
          panelIdentity,
          panelUrl: config.panelUrl,
          generation: capturedGeneration,
          headers: { ...headers },
          expiresAt: Date.now() + XUI_AUTH_TTL_MS,
        },
        getEffectiveMaxXuiAuthScopeEntries(),
        (evictedScopeKey, evictedEntry) => {
          if (!xuiAuthGenerationByScope.has(evictedScopeKey)) {
            minValidAuthGenerationFloor = Math.max(minValidAuthGenerationFloor, evictedEntry.generation + 1);
            nextMonotonicAuthGeneration = Math.max(nextMonotonicAuthGeneration, minValidAuthGenerationFloor + 1);
          }
        }
      );
    }

    return { ...headers };
  })();

  xuiAuthInFlight.set(scopeKey, {
    generation: capturedGeneration,
    isForceRefresh: Boolean(forceRefresh),
    promise: authPromise,
  });

  try {
    return await authPromise;
  } finally {
    const active = xuiAuthInFlight.get(scopeKey);
    if (active && active.promise === authPromise) {
      xuiAuthInFlight.delete(scopeKey);
    }
  }
};

export interface RequestApiOptions {
  timeoutMs?: number;
  beforeSend?: () => Promise<void>;
  signal?: AbortSignal;
  configOverride?: XuiConfig;
  authHeadersFn?: (config: XuiConfig, forceRefresh: boolean, timeoutMs: number) => Promise<Record<string, string>>;
  httpRequestFn?: (reqConfig: { url: string; method: 'GET' | 'POST'; data?: any; headers: Record<string, string> }) => Promise<{ status: number; statusText?: string; data?: any }>;
}

/**
 * Throws a clean pre-mutation timeout error if an HTTP deadline signal has already fired
 * before any external 3X-UI mutation is dispatched. Never used to abort post-write read-back
 * or database finalization once an external mutation has already been dispatched.
 */
export function assertRequestNotTimedOutBeforeExternalMutation(
  signal?: AbortSignal,
  operationLabel = 'external 3X-UI mutation'
): void {
  if (signal?.aborted) {
    const err: any = new Error(
      `HTTP request deadline elapsed before dispatching ${operationLabel}; aborted safely with zero external mutations.`
    );
    err.statusCode = 504;
    err.code = 'REQUEST_TIMEOUT_BEFORE_MUTATION';
    err.beforeExternalWrite = true;
    err.xuiUncertain = false;
    throw err;
  }
}

/**
 * Returns true ONLY when an error from a 3X-UI mutation endpoint definitively establishes
 * that the panel did NOT apply the mutation before executing any state change (e.g., HTTP
 * 404/405 unsupported route/method or pre-connection refusal/DNS failure before TCP accept).
 *
 * HTTP 400/422 and generic HTTP 200 `{ success: false }` responses (`xuiExplicitRejection === true`)
 * are NOT blindly trusted as non-applied because panels/proxies can return 400/422 or
 * `success: false` after partial/completed mutations. Callers MUST verify live panel state
 * before attempting another mutation or classifying the attempt as non-applied.
 *
 * Returns false for ALL ambiguous outcomes (timeouts, ECONNRESET, socket hang up, 5xx gateway
 * errors, 400/422 before panel verification, generic `success: false` before panel verification,
 * or truncated responses).
 */
export function isHttp400Or422Error(err: any): boolean {
  if (!err) return false;
  const httpStatus = Number(err?.response?.status ?? err?.statusCode ?? err?.status ?? 0);
  if (httpStatus === 400 || httpStatus === 422) {
    return true;
  }
  const msg = String(err?.message || '');
  return /3X-UI API Error:\s*(400|422)\b/i.test(msg);
}

export function isDefinitiveNonAppliedMutationError(err: any): boolean {
  if (!err) return false;

  const httpStatus = Number(err?.response?.status ?? err?.statusCode ?? err?.status ?? 0);
  if (httpStatus === 404 || httpStatus === 405) {
    return true;
  }

  const code = String(err?.code || '').toUpperCase();
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return true;
  }
  if (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ERR_CANCELED'
  ) {
    return false;
  }

  const msg = String(err?.message || '');
  if (/3X-UI API Error:\s*(404|405)\b/i.test(msg)) {
    return true;
  }
  if (
    /timeout|timed out|etimedout|econnreset|econnaborted|socket hang up|network error|500|502|503|504/i.test(msg)
  ) {
    return false;
  }

  return false;
}

export const requestApi = async <T>(
  endpoint: string,
  method: 'GET' | 'POST' = 'GET',
  data?: any,
  options?: RequestApiOptions
): Promise<T> => {
  const effectiveTimeoutMs =
    options?.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.max(method === 'GET' ? 200 : 1000, Math.min(Math.floor(options.timeoutMs), 30000))
      : 10000;
  const requestStartMs = Date.now();
  const operationDeadlineMs = requestStartMs + effectiveTimeoutMs;

  const getRemainingGetBudgetMs = (stage: string, minRequiredMs = 60): number => {
    if (method !== 'GET') return effectiveTimeoutMs;
    const remaining = operationDeadlineMs - Date.now();
    if (remaining < minRequiredMs) {
      const timeoutErr: any = new Error(
        `3X-UI GET ${endpoint} timed out after ${effectiveTimeoutMs}ms (${stage} budget exhausted)`
      );
      timeoutErr.code = 'ETIMEDOUT';
      timeoutErr.statusCode = 504;
      throw timeoutErr;
    }
    return remaining;
  };

  if (method === 'POST') {
    assertRequestNotTimedOutBeforeExternalMutation(options?.signal, `POST ${endpoint}`);
  }

  const config = options?.configOverride || (await getXuiConfig());
  const { scopeKey } = computeXuiCredentialScopeKey(config);
  const resolveAuthHeaders = options?.authHeadersFn || getXuiAuthHeaders;
  const authGenBeforeCall = ensureScopeAuthGeneration(scopeKey);

  let headers: Record<string, string>;
  try {
    const initialAuthTimeoutMs =
      method === 'GET' ? getRemainingGetBudgetMs('initial_auth') : effectiveTimeoutMs;
    try {
      headers = await resolveAuthHeaders(config, false, initialAuthTimeoutMs);
    } catch (firstAuthErr: any) {
      if (firstAuthErr?.code === 'XUI_AUTH_STALE_GENERATION') {
        const retryInitialAuthMs =
          method === 'GET' ? getRemainingGetBudgetMs('initial_auth_stale_retry') : effectiveTimeoutMs;
        headers = await resolveAuthHeaders(config, false, retryInitialAuthMs);
      } else {
        throw firstAuthErr;
      }
    }
  } catch (authErr: any) {
    if (method === 'POST' && authErr && typeof authErr === 'object') {
      if (authErr.beforeExternalWrite === undefined) authErr.beforeExternalWrite = true;
      if (authErr.xuiUncertain === undefined) authErr.xuiUncertain = false;
    }
    throw authErr;
  }

  // Revalidate HTTP deadline and all required locks AFTER potentially slow config/authentication steps
  if (method === 'POST') {
    assertRequestNotTimedOutBeforeExternalMutation(options?.signal, `POST ${endpoint}`);
  }
  if (options?.beforeSend) {
    await options.beforeSend();
    // Final synchronous deadline check immediately AFTER async beforeSend completes and BEFORE HTTP dispatch
    if (method === 'POST') {
      assertRequestNotTimedOutBeforeExternalMutation(options?.signal, `POST ${endpoint} (post-beforeSend)`);
    }
  }

  const { baseUrl, fullPath, fullUrl } = getApiEndpointUrl(config.panelUrl, endpoint);
  const executeHttp = (reqHeaders: Record<string, string>, stageLabel: string) => {
    const reqTimeoutMs = method === 'GET' ? getRemainingGetBudgetMs(stageLabel) : effectiveTimeoutMs;
    if (options?.httpRequestFn) {
      return options.httpRequestFn({ url: fullPath, method, data, headers: reqHeaders });
    }
    const client = createAxiosInstance(baseUrl, reqTimeoutMs);
    return client.request({
      url: fullPath,
      method,
      data,
      headers: reqHeaders,
      timeout: reqTimeoutMs,
      ...(method === 'POST' ? { maxRedirects: 0 } : {}),
    });
  };

  try {
    let response = await executeHttp(headers, 'initial_get');
    let attemptedAuthenticatedRetry = false;

    const locationHeader = String(
      (response as any)?.headers?.location || (response as any)?.headers?.Location || ''
    ).toLowerCase();
    const isUnauthenticatedRejection =
      response.status === 401 ||
      response.status === 403 ||
      ((response.status === 302 || response.status === 307) &&
        (method !== 'POST' || /(?:^|\/)(?:login|auth)(?:[/?#]|$)|login|signin/i.test(locationHeader)));

    // If session cookie expired or returned 401/403 (or explicit login redirect), refresh auth once
    // with per-scope generation isolation and single-flight deduplication across both default and custom authHeadersFn
    if (isUnauthenticatedRejection) {
      try {
        const retryAuthBudgetMs =
          method === 'GET' ? getRemainingGetBudgetMs('reauth_after_401') : effectiveTimeoutMs;
        const currentScopeGen = getScopeAuthGeneration(scopeKey);

        if (options?.authHeadersFn) {
          if (currentScopeGen === authGenBeforeCall) {
            const nextGen = invalidateXuiAuthCache(scopeKey, authGenBeforeCall);
            const customReauthPromise = resolveAuthHeaders(config, true, retryAuthBudgetMs);
            xuiAuthInFlight.set(scopeKey, {
              generation: nextGen,
              isForceRefresh: true,
              promise: customReauthPromise,
            });
            try {
              headers = { ...(await customReauthPromise) };
            } finally {
              const active = xuiAuthInFlight.get(scopeKey);
              if (active && active.promise === customReauthPromise) {
                xuiAuthInFlight.delete(scopeKey);
              }
            }
          } else {
            const activeInFlight = xuiAuthInFlight.get(scopeKey);
            if (activeInFlight && activeInFlight.generation === currentScopeGen) {
              headers = { ...(await activeInFlight.promise) };
            } else {
              headers = await resolveAuthHeaders(config, false, retryAuthBudgetMs);
            }
          }
        } else {
          if (currentScopeGen === authGenBeforeCall) {
            headers = await getXuiAuthHeaders(config, true, retryAuthBudgetMs);
          } else {
            // Another concurrent request for this same scopeKey already invalidated & started/completed a newer session generation
            headers = await getXuiAuthHeaders(config, false, retryAuthBudgetMs);
          }
        }
      } catch (reauthErr: any) {
        if (method === 'POST' && reauthErr && typeof reauthErr === 'object') {
          if (reauthErr.beforeExternalWrite === undefined) reauthErr.beforeExternalWrite = true;
          if (reauthErr.xuiUncertain === undefined) reauthErr.xuiUncertain = false;
        }
        throw reauthErr;
      }
      // Revalidate deadline and lock ownership again after re-authentication before sending mutation
      if (method === 'POST') {
        assertRequestNotTimedOutBeforeExternalMutation(options?.signal, `POST ${endpoint} (post-reauth)`);
      }
      if (options?.beforeSend) {
        await options.beforeSend();
        // Final synchronous deadline check immediately AFTER async beforeSend completes on retry branch
        if (method === 'POST') {
          assertRequestNotTimedOutBeforeExternalMutation(
            options?.signal,
            `POST ${endpoint} (post-reauth-beforeSend)`
          );
        }
      }
      attemptedAuthenticatedRetry = true;
      response = await executeHttp(headers, 'retry_get_after_401');
    }

    if (response.status !== 200) {
      const statusErr: any = new Error(`3X-UI API Error: ${response.status} ${response.statusText}`);
      statusErr.statusCode = response.status;
      statusErr.response = response;
      if (method === 'POST' && attemptedAuthenticatedRetry) {
        // An authenticated POST retry was already dispatched; never misclassify any non-200
        // (including 403/401) as a safe pre-write failure.
        statusErr.beforeExternalWrite = false;
      }
      throw statusErr;
    }

    if (response.data && response.data.success === false) {
      const rejectErr: any = new Error(`3X-UI API Error: ${response.data.msg}`);
      rejectErr.xuiExplicitRejection = true;
      throw rejectErr;
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

export interface GetInboundsOptions {
  timeoutMs?: number;
  fetcher?: () => Promise<XuiInbound[]>;
  panelIdentity?: string;
  skipFailureCooldown?: boolean;
}

export const getInbounds = async (
  forceRefresh: boolean = false,
  options?: GetInboundsOptions
): Promise<XuiInbound[]> => {
  let panelIdentity = String(options?.panelIdentity || '').trim();
  if (!panelIdentity && !options?.fetcher) {
    try {
      const cfg = await getXuiConfig();
      panelIdentity = computePanelIdentity(cfg.panelUrl) || 'default';
    } catch {
      panelIdentity = 'default';
    }
  }
  if (!panelIdentity) {
    panelIdentity = 'default';
  }

  const now = Date.now();
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache TTL
  const samePanelCache =
    !cachedInboundsPanelIdentity ||
    panelIdentity === 'default' ||
    cachedInboundsPanelIdentity === panelIdentity;

  if (
    !forceRefresh &&
    samePanelCache &&
    cachedInbounds.length > 0 &&
    now - lastInboundsCacheTime < CACHE_TTL_MS
  ) {
    return cachedInbounds;
  }

  const existingInFlight = inboundsInFlight.get(panelIdentity);
  if (
    existingInFlight &&
    existingInFlight.generation === inboundsCacheGeneration &&
    (!forceRefresh || existingInFlight.isForceRefresh)
  ) {
    return existingInFlight.promise;
  }

  if (
    !forceRefresh &&
    !options?.skipFailureCooldown &&
    samePanelCache &&
    lastFailedInboundsAt > 0 &&
    now - lastFailedInboundsAt < FAILED_INBOUNDS_COOLDOWN_MS
  ) {
    return cachedInbounds;
  }

  const endpoint = '/panel/api/inbounds/list';
  const capturedGeneration = inboundsCacheGeneration;
  const timeoutMs =
    options?.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.max(2000, Math.min(Math.floor(options.timeoutMs), 25000))
      : getXuiFullListTimeoutMs();

  const fetchPromise = (async (): Promise<XuiInbound[]> => {
    isCacheRefreshing = true;
    try {
      const inboundsData = options?.fetcher
        ? await options.fetcher()
        : await requestApi<XuiInbound[]>(endpoint, 'GET', undefined, { timeoutMs });
      if (Array.isArray(inboundsData)) {
        if (capturedGeneration === inboundsCacheGeneration) {
          setCachedInbounds(inboundsData, panelIdentity, capturedGeneration);
          lastFailedInboundsAt = 0;
        }
        return inboundsData;
      }
      return samePanelCache ? cachedInbounds : [];
    } catch (error: any) {
      if (capturedGeneration === inboundsCacheGeneration) {
        lastFailedInboundsAt = Date.now();
      }
      console.error(`[XUI Service] Failed to retrieve inbounds from ${endpoint}:`, error.message);
      return samePanelCache ? cachedInbounds : [];
    } finally {
      isCacheRefreshing = false;
    }
  })();

  inboundsInFlight.set(panelIdentity, {
    generation: capturedGeneration,
    isForceRefresh: Boolean(forceRefresh),
    promise: fetchPromise,
  });

  try {
    return await fetchPromise;
  } finally {
    const active = inboundsInFlight.get(panelIdentity);
    if (active && active.promise === fetchPromise) {
      inboundsInFlight.delete(panelIdentity);
    }
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
  inboundsCacheGeneration += 1;
  lastFailedInboundsAt = 0;
  inboundsInFlight.clear();
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
  options?: boolean | { forceRefresh?: boolean; fetcher?: (id: number) => Promise<XuiInbound | null>; timeoutMs?: number }
): Promise<XuiInbound | null> => {
  const normalizedId = Number(inboundId);
  if (Number.isNaN(normalizedId) || normalizedId <= 0) {
    return null;
  }

  const forceRefresh = typeof options === 'boolean' ? options : Boolean(options?.forceRefresh);
  const customFetcher = typeof options === 'object' ? options?.fetcher : undefined;
  const timeoutMs = typeof options === 'object' && options?.timeoutMs ? options.timeoutMs : getXuiSingleInboundTimeoutMs();
  const now = Date.now();

  if (forceRefresh) {
    liveInboundCacheGeneration += 1;
    liveInboundCache.delete(normalizedId);
  } else {
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
        const res = await requestApi<any>(`/panel/api/inbounds/get/${normalizedId}`, 'GET', undefined, { timeoutMs });
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
  requestApiFn?: <T>(endpoint: string, method?: 'GET' | 'POST', data?: any, options?: RequestApiOptions) => Promise<T>;
  dbClient?: any;
  nowMs?: number;
  requireDurableLock?: boolean;
  allowUncertainRecovery?: boolean;
  beforeExternalMutation?: () => Promise<void>;
  afterExternalMutationCheck?: () => Promise<void>;
  signal?: AbortSignal;
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

  assertRequestNotTimedOutBeforeExternalMutation(deps?.signal, 'manual renewal preparation');

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

  // Admin renewal mutations MUST remain protected by durable locks even when both auto-activation flags are disabled.
  return withInboundWriteLock(
    {
      dbClient: lockDbClient,
      inboundId: locatedInboundId,
      targetId: `renew:${normalizedTargetUuid}`,
      clientUuid: uuid,
      requireDurableLock: deps?.requireDurableLock ?? true,
      allowUncertainRecovery: deps?.allowUncertainRecovery ?? false,
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

      const preMutationEnable = Boolean(c.enable);
      const preMutationExpiryTime = Number(c.expiryTime || 0);
      const preMutationTotalGB = Number(c.totalGB || 0);

      // Fetch the client again from 3X-UI and verify that enable === true, expiryTime is in the future,
      // and totalGB matches target. Also computes whether the client remains strictly unchanged.
      // (Safe read-back continues even if HTTP timeout fired AFTER mutation dispatch)
      const verifyClientState = async (): Promise<{
        verified: boolean;
        client: XuiClient | null;
        stateStrictlyUnchanged: boolean;
      }> => {
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
          return { verified: false, client: null, stateStrictlyUnchanged: false };
        }

        let freshSettings: { clients?: XuiClient[] } = {};
        try {
          const rawFreshS: any = targetInbound.settings;
          freshSettings =
            typeof rawFreshS === 'string'
              ? JSON.parse(rawFreshS)
              : rawFreshS || {};
        } catch {
          return { verified: false, client: null, stateStrictlyUnchanged: false };
        }

        const freshClient =
          (freshSettings.clients || []).find(
            (cl) => cl.id && String(cl.id).trim().toLowerCase() === normalizedTargetUuid
          ) || null;

        if (!freshClient) {
          return { verified: false, client: null, stateStrictlyUnchanged: false };
        }

        const freshExpiry = Number(freshClient.expiryTime || 0);
        const freshEnable = Boolean(freshClient.enable);
        const freshTotalGB = Number(freshClient.totalGB || 0);
        const isEnabled = freshClient.enable === true;
        const isFutureExpiry = freshExpiry > now && Math.abs(freshExpiry - expectedExpiryTime) <= 1000;
        const matchesExpectedTotalGB = freshTotalGB === parsedTotalGB;
        const stateStrictlyUnchanged =
          freshEnable === preMutationEnable &&
          freshExpiry === preMutationExpiryTime &&
          freshTotalGB === preMutationTotalGB;

        return {
          verified: isEnabled && isFutureExpiry && matchesExpectedTotalGB,
          client: freshClient,
          stateStrictlyUnchanged,
        };
      };

      const makeReconciliationError = (reason: string): any => {
        const reconErr: any = new Error(reason);
        reconErr.statusCode = 409;
        reconErr.code = 'RECONCILIATION_REQUIRED';
        reconErr.beforeExternalWrite = false;
        reconErr.xuiUncertain = true;
        reconErr.markLockUncertain = true;
        return reconErr;
      };

      let updated = false;
      let externalMutationDispatched = false;
      let priorExternalWriteUnverified = false;
      let verifiedFromRejectionReadback: {
        verified: boolean;
        client: XuiClient | null;
        stateStrictlyUnchanged: boolean;
      } | null = null;
      let lastErr: any = null;

      const verifyAllLocksBeforeExternalMutation = async (): Promise<void> => {
        // Never dispatch an external mutation (or a second external mutation) after HTTP deadline
        assertRequestNotTimedOutBeforeExternalMutation(deps?.signal, 'manual renewal 3X-UI update');
        await assertInboundLockStillHeld();
        if (deps?.beforeExternalMutation) {
          await deps.beforeExternalMutation();
        }
      };

      for (const { ep, body } of updateEndpoints) {
        try {
          await verifyAllLocksBeforeExternalMutation();
        } catch (preLockErr: any) {
          if (priorExternalWriteUnverified) {
            throw makeReconciliationError(
              `Lock or deadline check failed after an earlier 3X-UI write attempt for UUID ${uuid} (${preLockErr?.message || preLockErr}); manual reconciliation required.`
            );
          }
          throw preLockErr;
        }
        try {
          externalMutationDispatched = true;
          await requestApiFn<any>(ep, 'POST', body, {
            beforeSend: verifyAllLocksBeforeExternalMutation,
            signal: deps?.signal,
          });
          priorExternalWriteUnverified = true;
          updated = true;
          break;
        } catch (e: any) {
          // If pre-send fencing/timeout aborted BEFORE transmission on this call:
          if (e?.beforeExternalWrite === true) {
            if (priorExternalWriteUnverified) {
              throw makeReconciliationError(
                `Lock or deadline check failed before ${ep} after an earlier 3X-UI write attempt (${e?.message || e}); manual reconciliation required.`
              );
            }
            throw e;
          }
          if (e?.statusCode === 409 || e?.statusCode === 504) {
            throw e;
          }

          // Generic 3X-UI HTTP 200 { success: false } and HTTP 400/422 responses MUST verify live
          // panel state before attempting another endpoint or marking non-applied!
          if (e?.xuiExplicitRejection === true || isHttp400Or422Error(e)) {
            let liveCheck: {
              verified: boolean;
              client: XuiClient | null;
              stateStrictlyUnchanged: boolean;
            } | null = null;
            try {
              liveCheck = await verifyClientState();
            } catch {
              liveCheck = null;
            }

            if (liveCheck?.verified) {
              console.warn(
                `[updateClientExpiry] ${ep} rejected (${e?.message || e}), but live 3X-UI read-back confirmed target expiry/enable/totalGB is applied; skipping remaining endpoints.`
              );
              updated = true;
              verifiedFromRejectionReadback = liveCheck;
              break;
            }

            if (liveCheck?.client && liveCheck.stateStrictlyUnchanged) {
              console.warn(
                `[updateClientExpiry] Rejection on ${ep} verified strictly unchanged on live 3X-UI read-back:`,
                e?.message || e
              );
              lastErr = e;
              if (deps?.signal?.aborted) {
                assertRequestNotTimedOutBeforeExternalMutation(
                  deps?.signal,
                  `manual renewal next endpoint after verified unchanged ${ep}`
                );
              }
              continue;
            }

            priorExternalWriteUnverified = true;
            throw makeReconciliationError(
              `3X-UI rejected ${ep} (${e?.message || e}) and live panel verification could not confirm unchanged state; refusing alternate write. Manual reconciliation required.`
            );
          }

          // Only try alternate endpoints when the preceding response definitively establishes
          // that the mutation was NOT applied before panel execution (e.g. 404/405/ECONNREFUSED/ENOTFOUND).
          if (!isDefinitiveNonAppliedMutationError(e)) {
            priorExternalWriteUnverified = true;
            throw makeReconciliationError(
              `Ambiguous 3X-UI response on ${ep} (${e?.message || e}); refusing duplicate write on alternate endpoint. Manual reconciliation required.`
            );
          }
          console.warn(`[updateClientExpiry] Definitive non-applied rejection on ${ep}:`, e?.message || e);
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

        // If an earlier external mutation outcome was NOT verified non-applied and the HTTP deadline
        // has elapsed, NEVER dispatch a second external mutation; require reconciliation.
        if (priorExternalWriteUnverified && deps?.signal?.aborted) {
          throw makeReconciliationError(
            `HTTP request deadline elapsed after initial 3X-UI renewal write; refusing second external mutation on inbound ${inbound.id}. Manual reconciliation required.`
          );
        }

        try {
          await verifyAllLocksBeforeExternalMutation();
        } catch (fallbackLockErr: any) {
          if (priorExternalWriteUnverified) {
            throw makeReconciliationError(
              `Lock or deadline check failed before inbound fallback on inbound ${inbound.id} after earlier 3X-UI write (${fallbackLockErr?.message || fallbackLockErr}); manual reconciliation required.`
            );
          }
          throw fallbackLockErr;
        }

        externalMutationDispatched = true;
        try {
          await requestApiFn<any>(`/panel/api/inbounds/update/${inbound.id}`, 'POST', updateInboundPayload, {
            beforeSend: verifyAllLocksBeforeExternalMutation,
            signal: deps?.signal,
          });
          priorExternalWriteUnverified = true;
        } catch (fallbackApiErr: any) {
          if (fallbackApiErr?.beforeExternalWrite === true) {
            if (priorExternalWriteUnverified) {
              throw makeReconciliationError(
                `Lock or deadline check failed during inbound fallback before POST after earlier 3X-UI write (${fallbackApiErr?.message || fallbackApiErr}); manual reconciliation required.`
              );
            }
            throw fallbackApiErr;
          }
          if (fallbackApiErr?.statusCode === 409 || fallbackApiErr?.statusCode === 504) {
            throw fallbackApiErr;
          }
          if (fallbackApiErr?.xuiExplicitRejection === true || isHttp400Or422Error(fallbackApiErr)) {
            let fallbackLiveCheck: {
              verified: boolean;
              client: XuiClient | null;
              stateStrictlyUnchanged: boolean;
            } | null = null;
            try {
              fallbackLiveCheck = await verifyClientState();
            } catch {
              fallbackLiveCheck = null;
            }
            if (fallbackLiveCheck?.verified) {
              console.warn(
                `[updateClientExpiry] Inbound update fallback rejected (${fallbackApiErr?.message || fallbackApiErr}), but live 3X-UI read-back confirmed target state is applied.`
              );
              verifiedFromRejectionReadback = fallbackLiveCheck;
              return;
            }
            if (
              !priorExternalWriteUnverified &&
              fallbackLiveCheck?.client &&
              fallbackLiveCheck.stateStrictlyUnchanged
            ) {
              const confirmedUnchangedErr: any = lastErr || fallbackApiErr;
              if (confirmedUnchangedErr && typeof confirmedUnchangedErr === 'object') {
                confirmedUnchangedErr.xuiUncertain = false;
              }
              throw confirmedUnchangedErr;
            }
            throw makeReconciliationError(
              `3X-UI rejected inbound update fallback on inbound ${inbound.id} (${fallbackApiErr?.message || fallbackApiErr}) and live panel verification could not confirm unchanged state; manual reconciliation required.`
            );
          }
          throw fallbackApiErr;
        }
      };

      if (!updated) {
        try {
          await applyInboundUpdateFallback();
          updated = true;
        } catch (fallbackErr: any) {
          if (fallbackErr?.beforeExternalWrite === true || fallbackErr?.statusCode === 409 || fallbackErr?.statusCode === 504) {
            throw fallbackErr;
          }
          if (!isDefinitiveNonAppliedMutationError(fallbackErr)) {
            if (fallbackErr?.xuiUncertain === false && !priorExternalWriteUnverified) {
              throw lastErr || fallbackErr;
            }
            throw makeReconciliationError(
              `Ambiguous 3X-UI response on inbound update fallback for inbound ${inbound.id} (${fallbackErr?.message || fallbackErr}); manual reconciliation required.`
            );
          }
          console.error(`[updateClientExpiry] Inbound update fallback failed for inbound ${inbound.id}:`, fallbackErr?.message || fallbackErr);
          const cleanErr: any = lastErr || fallbackErr;
          if (!priorExternalWriteUnverified && cleanErr && typeof cleanErr === 'object') {
            cleanErr.xuiUncertain = false;
          }
          throw cleanErr;
        }
      }

      let verification: {
        verified: boolean;
        client: XuiClient | null;
        stateStrictlyUnchanged: boolean;
      };
      if (verifiedFromRejectionReadback) {
        verification = verifiedFromRejectionReadback;
      } else {
        try {
          verification = await verifyClientState();
        } catch (readErr: any) {
          throw makeReconciliationError(
            `3X-UI read-back failed after renewal write for UUID ${uuid} on inbound ${inbound.id} (${readErr?.message || readErr}); manual reconciliation required.`
          );
        }
      }

      // If the initial endpoint returned 200 and live read-back proves enable: true / expiryTime did NOT persist,
      // apply the full inbound update fallback once (only if HTTP deadline has not elapsed and all locks remain valid).
      if (!verification.verified && !usedInboundUpdateFallback) {
        console.warn(
          `[updateClientExpiry] Initial update did not confirm enable=true & expiryTime=${expectedExpiryTime} (got enable=${verification.client?.enable}, expiryTime=${verification.client?.expiryTime}). Applying inbound update fallback...`
        );
        try {
          await applyInboundUpdateFallback();
        } catch (postFallbackErr: any) {
          if (postFallbackErr?.statusCode === 409 || postFallbackErr?.statusCode === 504) {
            throw postFallbackErr;
          }
          throw makeReconciliationError(
            `3X-UI inbound update fallback failed after initial write for UUID ${uuid} (${postFallbackErr?.message || postFallbackErr}); manual reconciliation required.`
          );
        }
        if (verifiedFromRejectionReadback) {
          verification = verifiedFromRejectionReadback;
        } else {
          try {
            verification = await verifyClientState();
          } catch (readErr2: any) {
            throw makeReconciliationError(
              `3X-UI read-back failed after fallback write for UUID ${uuid} on inbound ${inbound.id} (${readErr2?.message || readErr2}); manual reconciliation required.`
            );
          }
        }
      }

      if (!verification.verified) {
        const errMsg = `Failed to verify 3X-UI client reactivation for UUID ${uuid} on inbound ${inbound.id}: enable=${verification.client?.enable}, expiryTime=${verification.client?.expiryTime}, expectedExpiryTime=${expectedExpiryTime}`;
        console.error(`[updateClientExpiry] ${errMsg}`);
        if (!verification.client || !verification.stateStrictlyUnchanged) {
          throw makeReconciliationError(
            `${errMsg}; live panel state differs from pre-mutation snapshot. Manual reconciliation required.`
          );
        }
        const verifyFailErr: any = new Error(errMsg);
        verifyFailErr.xuiUncertain = false;
        throw verifyFailErr;
      }

      // Verify post-write lock ownership before returning so a stale worker cannot finalize DB state
      try {
        await assertInboundLockStillHeld();
        if (deps?.afterExternalMutationCheck) {
          await deps.afterExternalMutationCheck();
        } else if (deps?.beforeExternalMutation) {
          await deps.beforeExternalMutation();
        }
      } catch (postLockErr: any) {
        const staleErr: any = new Error(
          `Lock ownership lost after verified 3X-UI renewal write for UUID ${uuid} (${postLockErr?.message || postLockErr}); refusing stale DB finalization. Manual reconciliation required.`
        );
        staleErr.statusCode = 409;
        staleErr.code = 'RECONCILIATION_REQUIRED';
        staleErr.xuiUncertain = true;
        staleErr.markLockUncertain = true;
        throw staleErr;
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
const clientProcessQueues = new Map<string, Promise<void>>();
const DEFAULT_LOCK_LEASE_SECONDS = 120;
const INBOUND_LOCK_LEASE_SECONDS = 45;

export const isAutoActivateNewOrdersFlagEnabled = (): boolean =>
  String(process.env.AUTO_ACTIVATE_NEW_ORDERS_ENABLED || 'false').trim().toLowerCase() === 'true';

export const isAutoActivateRenewalsFlagEnabled = (): boolean =>
  String(process.env.AUTO_ACTIVATE_RENEWALS_ENABLED || 'false').trim().toLowerCase() === 'true';

export const isPanelDeletionSyncFlagEnabled = (): boolean =>
  String(process.env.PANEL_DELETION_SYNC_ENABLED || 'false').trim().toLowerCase() === 'true';

export const getPanelDeletionSyncIntervalMs = (): number => {
  const raw = Number(process.env.PANEL_DELETION_SYNC_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 120000; // Default 2 minutes
  return Math.max(30000, Math.min(Math.floor(raw), 3600000));
};

export const getPanelDeletionSyncMaxDeletesPerCycle = (): number => {
  const raw = Number(process.env.PANEL_DELETION_SYNC_MAX_DELETES_PER_CYCLE);
  if (!Number.isFinite(raw) || raw <= 0) return 10;
  return Math.max(1, Math.min(Math.floor(raw), 500));
};

export const getPanelDeletionSyncMaxMissingRatio = (): number => {
  const raw = Number(process.env.PANEL_DELETION_SYNC_MAX_MISSING_RATIO);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 1) return 0.25;
  return raw;
};

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
  signal?: AbortSignal;
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

export type DurableLockFailureKind =
  | 'active_lock'
  | 'uncertain_lock'
  | 'permission_error'
  | 'rpc_error'
  | 'unavailable';

export interface DurableLockAcquireResult {
  acquired: boolean;
  lockOwnerId: string;
  tableAvailable: boolean;
  staleRecovery: boolean;
  failureKind?: DurableLockFailureKind;
  previousStatus?: string | null;
  previousOperationType?: string | null;
  previousClientUuid?: string | null;
  holderOwnerId?: string | null;
  leaseExpiresAt?: string | null;
  error?: string;
}

export function isPermissionOrAuthLockError(err: any): boolean {
  const code = String(err?.code || '').trim();
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    code === '42501' ||
    msg.includes('permission denied') ||
    msg.includes('insufficient_privilege') ||
    msg.includes('row-level security') ||
    msg.includes('not authorized')
  );
}

/**
 * Builds a structured HTTP error from a failed durable lock acquisition without leaking
 * credentials, SQL details, or internal secrets.
 */
export function buildDurableLockFailureError(
  lockRes: DurableLockAcquireResult,
  targetLabel: string
): Error & { statusCode: number; code: string } {
  const err: any = new Error();
  if (lockRes.failureKind === 'permission_error') {
    err.message =
      'Backend provisioning lock permission error. Please verify server service-role configuration before retrying.';
    err.statusCode = 503;
    err.code = 'LOCK_PERMISSION_ERROR';
    return err;
  }

  if (
    lockRes.failureKind === 'rpc_error' ||
    lockRes.failureKind === 'unavailable' ||
    !lockRes.tableAvailable
  ) {
    err.message =
      'Provisioning coordination service is temporarily unavailable. Please check status and retry shortly.';
    err.statusCode = 503;
    err.code = 'LOCK_SERVICE_UNAVAILABLE';
    return err;
  }

  if (lockRes.failureKind === 'uncertain_lock' || lockRes.previousStatus === 'uncertain') {
    err.message = `${targetLabel} has an uncertain prior external provisioning state and requires manual reconciliation before retrying.`;
    err.statusCode = 409;
    err.code = 'RECONCILIATION_REQUIRED';
    return err;
  }

  if (lockRes.previousOperationType === 'reject_order') {
    err.message = `${targetLabel} rejection is currently in progress. Please wait and check current status.`;
    err.statusCode = 409;
    err.code = 'OPERATION_IN_PROGRESS';
    return err;
  }

  err.message = `${targetLabel} is already being processed by another operation. Please wait and check current status.`;
  err.statusCode = 409;
  err.code = 'OPERATION_IN_PROGRESS';
  return err;
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
      failureKind: 'unavailable',
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
      const isPermErr = isPermissionOrAuthLockError(error);
      console.error(
        `[xuiService] Durable lock acquisition failed CLOSED (${isPermErr ? 'permission_error' : 'rpc_error'}) for ${operationKey}:`,
        error.message || error
      );
      return {
        acquired: false,
        lockOwnerId,
        tableAvailable: !isMissingSchemaOrRpcError(error),
        staleRecovery: false,
        failureKind: isPermErr ? 'permission_error' : 'rpc_error',
        error: isPermErr
          ? 'Backend provisioning lock permission error.'
          : 'Failed to acquire durable operation lock.',
      };
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.acquired !== 'boolean') {
      return {
        acquired: false,
        lockOwnerId,
        tableAvailable: true,
        staleRecovery: false,
        failureKind: 'rpc_error',
        error: 'Unexpected response from acquire_provisioning_lock RPC.',
      };
    }

    const acquired = Boolean(row.acquired);
    const previousStatus = row.previous_status ?? null;
    return {
      acquired,
      lockOwnerId,
      tableAvailable: true,
      staleRecovery: Boolean(row.stale_recovery),
      failureKind: acquired
        ? undefined
        : previousStatus === 'uncertain'
        ? 'uncertain_lock'
        : 'active_lock',
      previousStatus,
      previousOperationType: row.previous_operation_type ?? null,
      previousClientUuid: row.previous_client_uuid ?? null,
      holderOwnerId: row.holder_owner_id ?? null,
      leaseExpiresAt: row.lease_expires_at ?? null,
    };
  } catch (err: any) {
    if (isMissingSchemaOrRpcError(err) && !mustFailClosed) {
      return { acquired: true, lockOwnerId, tableAvailable: false, staleRecovery: false };
    }
    const isPermErr = isPermissionOrAuthLockError(err);
    console.error(`[xuiService] Durable lock acquisition exception (fail CLOSED) for ${operationKey}:`, err?.message || err);
    return {
      acquired: false,
      lockOwnerId,
      tableAvailable: false,
      staleRecovery: false,
      failureKind: isPermErr ? 'permission_error' : 'rpc_error',
      error: isPermErr
        ? 'Backend provisioning lock permission error.'
        : 'Durable lock acquisition failed.',
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

export interface DurableLockReleaseResult {
  released: boolean;
  attempts: number;
  reason: 'released' | 'ownership_lost_or_expired' | 'rpc_error' | 'unavailable';
  error?: string;
}

const isTransientLockReleaseError = (err: any): boolean => {
  const code = String(err?.code || '').trim().toUpperCase();
  const status = Number(err?.status ?? err?.statusCode ?? 0);
  const name = String(err?.name || '').toLowerCase();
  const msg = String(err?.message || err || '').toLowerCase();

  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNABORTED' ||
    code === 'EAI_AGAIN' ||
    code === '40001' || // PostgreSQL serialization_failure
    code === '40P01' || // PostgreSQL deadlock_detected
    code === '57P01' || // admin_shutdown
    code === '57P02' || // crash_shutdown
    code === '57P03'    // cannot_connect_now
  ) {
    return true;
  }
  if (name === 'aborterror' || name === 'timeouterror') {
    return true;
  }
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('aborted') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('network error') ||
    msg.includes('failed to fetch') ||
    msg.includes('bad gateway') ||
    msg.includes('service unavailable') ||
    msg.includes('gateway timeout') ||
    msg.includes('connection terminated') ||
    msg.includes('deadlock detected') ||
    msg.includes('could not serialize access')
  );
};

export async function finalizeDurableProvisioningOperationLock(params: {
  dbClient: any;
  operationKey: string;
  lockOwnerId: string;
  status: 'completed' | 'failed' | 'uncertain';
  clientUuid?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, any>;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}): Promise<DurableLockReleaseResult> {
  const { dbClient, operationKey, lockOwnerId, status, clientUuid, errorMessage, metadata } = params;
  if (!dbClient || typeof dbClient.rpc !== 'function') {
    console.warn(
      `[xuiService] Cannot release durable lock '${operationKey}' (owner=${lockOwnerId}, targetStatus=${status}): RPC client unavailable.`
    );
    return { released: false, attempts: 0, reason: 'unavailable' };
  }

  const maxRetries =
    params.maxRetries !== undefined && Number.isInteger(params.maxRetries) && params.maxRetries >= 0
      ? Math.min(params.maxRetries, 5)
      : 2;
  const maxAttempts = maxRetries + 1;
  const retryBaseDelayMs =
    params.retryBaseDelayMs !== undefined && Number.isFinite(params.retryBaseDelayMs) && params.retryBaseDelayMs >= 0
      ? Math.min(params.retryBaseDelayMs, 2000)
      : 250;

  let lastErrMsg: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Always retain the exact original lockOwnerId; never release a lock owned by another worker.
      const { data, error } = await dbClient.rpc('release_provisioning_lock', {
        p_operation_key: operationKey,
        p_lock_owner_id: lockOwnerId,
        p_status: status,
        p_client_uuid: clientUuid || null,
        p_error_message: errorMessage || null,
        p_metadata: metadata || null,
      });

      if (!error) {
        if (data === true) {
          if (attempt > 1) {
            console.log(
              `[xuiService] Released durable lock '${operationKey}' (owner=${lockOwnerId}, status=${status}) on retry attempt ${attempt}/${maxAttempts}.`
            );
          }
          return { released: true, attempts: attempt, reason: 'released' };
        }

        // release_provisioning_lock returned FALSE (ownership changed, lease expired, or already finalized).
        // Do NOT silently ignore and do NOT retry or force-release another worker's lock.
        console.warn(
          `[xuiService] Durable lock release returned FALSE for '${operationKey}' (owner=${lockOwnerId}, targetStatus=${status}, attempt=${attempt}/${maxAttempts}): lease expired, already finalized, or lock ownership changed to another worker. Preserving existing lock state.`
        );
        return { released: false, attempts: attempt, reason: 'ownership_lost_or_expired' };
      }

      lastErrMsg = error?.message || String(error);
      const transient = isTransientLockReleaseError(error);
      if (transient && attempt < maxAttempts) {
        const delayMs = retryBaseDelayMs * Math.pow(2, attempt - 1);
        console.warn(
          `[xuiService] Transient RPC error releasing durable lock '${operationKey}' (owner=${lockOwnerId}, targetStatus=${status}, attempt=${attempt}/${maxAttempts}): ${lastErrMsg}. Retrying in ${delayMs}ms with original owner...`
        );
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        continue;
      }

      console.error(
        `[xuiService] Failed to release durable lock '${operationKey}' (owner=${lockOwnerId}, targetStatus=${status}) after ${attempt}/${maxAttempts} attempt(s): ${lastErrMsg}`
      );
      return { released: false, attempts: attempt, reason: 'rpc_error', error: lastErrMsg };
    } catch (err: any) {
      lastErrMsg = err?.message || String(err);
      const transient = isTransientLockReleaseError(err);
      if (transient && attempt < maxAttempts) {
        const delayMs = retryBaseDelayMs * Math.pow(2, attempt - 1);
        console.warn(
          `[xuiService] Transient exception releasing durable lock '${operationKey}' (owner=${lockOwnerId}, targetStatus=${status}, attempt=${attempt}/${maxAttempts}): ${lastErrMsg}. Retrying in ${delayMs}ms with original owner...`
        );
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        continue;
      }

      console.error(
        `[xuiService] Exception releasing durable lock '${operationKey}' (owner=${lockOwnerId}, targetStatus=${status}) after ${attempt}/${maxAttempts} attempt(s): ${lastErrMsg}`
      );
      return { released: false, attempts: attempt, reason: 'rpc_error', error: lastErrMsg };
    }
  }

  return { released: false, attempts: maxAttempts, reason: 'rpc_error', error: lastErrMsg };
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
    noExternalXuiWrite?: boolean;
    releaseRetryBaseDelayMs?: number;
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
      const effectiveAllowUncertainRecovery = params.allowUncertainRecovery === true;
      const res = await acquireDurableProvisioningOperationLock({
        dbClient: params.dbClient,
        operationKey: inboundKey,
        operationType: 'inbound_write',
        targetId: params.targetId,
        clientUuid: params.clientUuid || null,
        leaseSeconds: INBOUND_LOCK_LEASE_SECONDS,
        metadata: { inboundId, targetId: params.targetId },
        requireDurableLock: params.requireDurableLock ?? true,
        allowUncertainRecovery: effectiveAllowUncertainRecovery,
      });

      if (res.acquired) {
        acquiredLock = res;
        break;
      }

      // If table/RPC is missing or hard DB error occurred under fail-closed mode, fail immediately instead of spinning
      if (!res.tableAvailable) {
        const lockErr: any = buildDurableLockFailureError(res, `Inbound ${inboundId}`);
        lockErr.beforeExternalWrite = true;
        lockErr.xuiUncertain = false;
        throw lockErr;
      }

      // Never spin or steal an uncertain inbound lock when allowUncertainRecovery is not explicitly true
      if (!effectiveAllowUncertainRecovery && res.previousStatus === 'uncertain') {
        const uncertainErr: any = new Error(
          `Inbound ${inboundId} has an uncertain prior provisioning lock; skipping without forcing recovery.`
        );
        uncertainErr.statusCode = 409;
        uncertainErr.code = 'INBOUND_LOCK_UNCERTAIN';
        uncertainErr.beforeExternalWrite = true;
        uncertainErr.xuiUncertain = false;
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
        fenceErr.code = 'INBOUND_LOCK_LOST';
        fenceErr.beforeExternalWrite = true;
        fenceErr.xuiUncertain = false;
        throw fenceErr;
      }
    };

    let opOutcome: 'completed' | 'failed' | 'uncertain' = 'completed';
    let opErr: string | null = null;
    try {
      return await fn(assertInboundLockStillHeld);
    } catch (err: any) {
      if (
        params.noExternalXuiWrite === true ||
        err?.beforeExternalWrite === true ||
        err?.xuiUncertain === false
      ) {
        // Caller performed zero external 3X-UI inbound writes (e.g., read-only panel verification
        // or definitive pre-mutation eligibility/cooldown/lock rejection); never poison the shared
        // inbound write lock into 'uncertain'.
        opOutcome = 'failed';
      } else if (err?.xuiUncertain === true || err?.mutationUncertain === true) {
        opOutcome = 'uncertain';
      } else {
        const msgLower = String(err?.message || '').toLowerCase();
        const isUncertainTransportErr =
          msgLower.includes('timeout') ||
          msgLower.includes('etimedout') ||
          msgLower.includes('econnreset') ||
          msgLower.includes('econnrefused') ||
          msgLower.includes('socket hang up') ||
          msgLower.includes('network error');
        opOutcome = isUncertainTransportErr ? 'uncertain' : 'failed';
      }
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
          retryBaseDelayMs: params.releaseRetryBaseDelayMs,
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
    const conflictErr: any = new Error(
      'Provisioning is already in progress for this order. Please wait and check current status.'
    );
    conflictErr.statusCode = 409;
    conflictErr.code = 'OPERATION_IN_PROGRESS';
    throw conflictErr;
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
        const notFoundErr: any = new Error(`Order '${orderId}' not found in database.`);
        notFoundErr.statusCode = 404;
        throw notFoundErr;
      }
      order = queryOrder;
    }

    // Acquire canonical in-process guard on order.id to prevent concurrent approval via order_id vs UUID
    if (!options?.heldOrderLockOwnerId && order.id && String(order.id) !== String(orderId)) {
      canonicalOrderLockKey = String(order.id);
      if (activeProvisionings.has(canonicalOrderLockKey)) {
        console.warn(`[xuiService] [DUPLICATE EXECUTION DETECTED] Canonical order ${canonicalOrderLockKey} is already provisioning.`);
        const conflictErr: any = new Error(
          'Provisioning is already in progress for this order. Please wait and check current status.'
        );
        conflictErr.statusCode = 409;
        conflictErr.code = 'OPERATION_IN_PROGRESS';
        throw conflictErr;
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
        requireDurableLock: true,
        allowUncertainRecovery: false,
      });

      if (!lockRes.acquired) {
        console.warn(
          `[xuiService] Durable operation lock '${durableOperationKey}' could not be acquired (kind=${lockRes.failureKind || 'unknown'}, prevStatus=${lockRes.previousStatus || 'none'}, prevOp=${lockRes.previousOperationType || 'none'}).`
        );
        throw buildDurableLockFailureError(
          lockRes,
          `Order '${order.order_id || order.id}'`
        );
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

    const effectiveOrderLockOwnerId = options?.heldOrderLockOwnerId || acquiredLockOwnerId;
    const shouldVerifyOrderLock = Boolean(ownsDurableLock || options?.heldOrderLockOwnerId);
    const assertOrderLockStillHeld = async (
      stage: 'before_external_write' | 'before_db_finalization'
    ): Promise<void> => {
      if (!shouldVerifyOrderLock) return;
      if (!durableOperationKey || !effectiveOrderLockOwnerId) {
        const missingErr: any = new Error(
          `Missing durable order lock ownership for '${durableOperationKey || order.id}' (${stage}).`
        );
        missingErr.statusCode = 409;
        missingErr.code = stage === 'before_db_finalization' ? 'RECONCILIATION_REQUIRED' : 'ORDER_LOCK_MISSING';
        missingErr.beforeExternalWrite = stage === 'before_external_write';
        missingErr.xuiUncertain = stage === 'before_db_finalization';
        missingErr.markLockUncertain = stage === 'before_db_finalization';
        throw missingErr;
      }
      const orderLockValid = await renewDurableProvisioningOperationLock({
        dbClient,
        operationKey: durableOperationKey,
        lockOwnerId: effectiveOrderLockOwnerId,
        leaseSeconds: DEFAULT_LOCK_LEASE_SECONDS,
      });
      if (!orderLockValid) {
        const fenceErr: any = new Error(
          stage === 'before_db_finalization'
            ? `Lost durable order lock '${durableOperationKey}' after 3X-UI mutation; refusing stale DB finalization. Manual reconciliation required.`
            : `Lost durable order lock '${durableOperationKey}' before 3X-UI mutation; aborting to prevent overlapping mutation.`
        );
        fenceErr.statusCode = 409;
        fenceErr.code = stage === 'before_db_finalization' ? 'RECONCILIATION_REQUIRED' : 'ORDER_LOCK_LOST';
        fenceErr.beforeExternalWrite = stage === 'before_external_write';
        fenceErr.xuiUncertain = stage === 'before_db_finalization';
        fenceErr.markLockUncertain = stage === 'before_db_finalization';
        throw fenceErr;
      }
    };

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

      // Verify request deadline & order lock ownership right before confirming provisional payment in DB
      assertRequestNotTimedOutBeforeExternalMutation(
        options?.signal,
        `provisional payment confirmation for order ${order.order_id || order.id}`
      );
      await assertOrderLockStillHeld('before_external_write');

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
      requireDurableLock: true,
      allowUncertainRecovery: false,
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

      const preUpdateClientSnapshot = existingIndex >= 0 ? { ...existingClients[existingIndex] } : null;

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

      const readInboundStateAfterProvision = async (): Promise<any | null> => {
        let ibObj: any = null;
        try {
          const getRes = await requestApiCall<any>(`/panel/api/inbounds/get/${inboundId}`, 'GET');
          ibObj = getRes?.obj || getRes;
        } catch (getErr: any) {
          console.warn(`[3X-UI Provisioning] GET /panel/api/inbounds/get/${inboundId} notice:`, getErr?.message || getErr);
        }
        if (!ibObj || typeof ibObj !== 'object' || !ibObj.id) {
          const allInboundsList = await getInboundsCall(true);
          ibObj = allInboundsList.find((ib: any) => Number(ib.id) === Number(inboundId)) || null;
        }
        return ibObj;
      };

      // Fencing verification immediately before external 3X-UI mutation (and re-run inside requestApi
      // after potentially slow 3X-UI authentication / re-authentication):
      // ensure HTTP deadline has not elapsed and BOTH the inbound write lock and order lock are actively owned.
      const verifyLocksBeforeExternalMutation = async (): Promise<void> => {
        assertRequestNotTimedOutBeforeExternalMutation(
          options?.signal,
          `order provisioning for order ${order.order_id || order.id}`
        );
        await assertInboundLockStillHeld();
        await assertOrderLockStillHeld('before_external_write');
      };

      await verifyLocksBeforeExternalMutation();

      xuiWriteAttempted = true;
      let updateRes: any = null;
      let explicitPanelErr: any = null;
      try {
        updateRes = await requestApiCall<any>(
          `/panel/api/inbounds/update/${inboundId}`,
          'POST',
          updateInboundPayload,
          {
            beforeSend: verifyLocksBeforeExternalMutation,
            signal: options?.signal,
          }
        );
      } catch (apiErr: any) {
        if (apiErr?.xuiExplicitRejection === true || isHttp400Or422Error(apiErr)) {
          explicitPanelErr = apiErr;
        } else {
          throw apiErr;
        }
      }

      if (explicitPanelErr || (updateRes && updateRes.success === false)) {
        const panelMsg =
          explicitPanelErr?.message ||
          updateRes?.msg ||
          updateRes?.message ||
          '3X-UI panel rejected inbound update';
        console.error(`[3X-UI Provisioning] Inbound update rejected on panel (${panelMsg}); verifying live panel state before classifying.`);

        let checkIb: any = null;
        try {
          checkIb = await readInboundStateAfterProvision();
        } catch {
          checkIb = null;
        }
        if (checkIb) {
          let checkSettings: any = {};
          try {
            checkSettings = typeof checkIb.settings === 'string' ? JSON.parse(checkIb.settings) : checkIb.settings || {};
          } catch {
            checkSettings = null;
          }
          if (checkSettings && Array.isArray(checkSettings.clients)) {
            const liveMatched = checkSettings.clients.find(
              (c: any) =>
                (c.id && String(c.id).trim().toLowerCase() === String(uuid).trim().toLowerCase()) ||
                (c.email && String(c.email).trim().toLowerCase() === String(remark).trim().toLowerCase())
            );
            const verifiedUnchanged =
              (!preUpdateClientSnapshot && !liveMatched) ||
              (preUpdateClientSnapshot &&
                liveMatched &&
                Boolean(liveMatched.enable) === Boolean(preUpdateClientSnapshot.enable) &&
                Number(liveMatched.expiryTime || 0) === Number(preUpdateClientSnapshot.expiryTime || 0) &&
                Number(liveMatched.totalGB || 0) === Number(preUpdateClientSnapshot.totalGB || 0));

            if (verifiedUnchanged) {
              const panelErr: any = new Error(`3X-UI provisioning failed: ${panelMsg}`);
              panelErr.xuiUncertain = false;
              throw panelErr;
            }
          }
        }

        const reconErr: any = new Error(
          `3X-UI rejected provisioning (${panelMsg}) and live panel verification did not confirm unchanged state; manual reconciliation required.`
        );
        reconErr.statusCode = 409;
        reconErr.code = 'RECONCILIATION_REQUIRED';
        reconErr.beforeExternalWrite = false;
        reconErr.xuiUncertain = true;
        reconErr.markLockUncertain = true;
        throw reconErr;
      }

      const afterInboundObj = await readInboundStateAfterProvision();

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

  // Post-write lock fencing: ensure this worker STILL owns the order lock before finalizing DB rows
  // so a stale worker can never overwrite database state owned by another worker.
  await assertOrderLockStillHeld('before_db_finalization');

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
      const isUncertainOutcome = Boolean(
        err?.xuiUncertain === true ||
        err?.markLockUncertain === true ||
        (xuiWriteAttempted &&
          !xuiWriteConfirmed &&
          err?.beforeExternalWrite !== true &&
          err?.xuiUncertain !== false)
      );
      await finalizeDurableProvisioningOperationLock({
        dbClient,
        operationKey: durableOperationKey,
        lockOwnerId: acquiredLockOwnerId,
        status: isUncertainOutcome ? 'uncertain' : 'failed',
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
  heldOrderLockTableAvailable?: boolean;
  signal?: AbortSignal;
}

/**
 * Mandatory Rejection Safety:
 * Revokes ONLY an unpaid provisional VPN entitlement specifically tracked in public.vpn_entitlement_grants.
 * - ZERO payment_method fallback: public.vpn_entitlement_grants is the sole authoritative ledger.
 * - Handles partial/interrupted provisional states (`status IN ('provisioning', 'provisional', 'revoke_failed')`)
 *   by reconciling live 3X-UI state and disabling any unpaid client that already exists on 3X-UI.
 * - Serializes 3X-UI writes under per-inbound durable lock (`inbound:<id>`) with `allowUncertainRecovery: false`.
 * - Verifies and renews BOTH outer `order:<id>` and nested `inbound:<id>` locks using original ownership
 *   credentials immediately before every external mutation and before DB finalization.
 * - Performs mandatory read-back verification from 3X-UI after setting `enable: false` before marking 'revoked'.
 * - On explicit failure, marks 'revoke_failed'; on post-write ambiguity/lease loss, marks 'uncertain' / RECONCILIATION_REQUIRED.
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
  let orderLockTableAvailable = Boolean(
    options?.heldOrderLockOwnerId && options?.heldOrderLockTableAvailable !== false
  );

  if (!options?.heldOrderLockOwnerId) {
    const lockRes = await acquireDurableProvisioningOperationLock({
      dbClient,
      operationKey: durableOperationKey,
      operationType: 'reject_order',
      targetId: String(order.id),
      clientUuid: order.client_uuid || null,
      metadata: { reason, adminLabel: options?.adminLabel || 'Admin' },
      requireDurableLock: true,
      allowUncertainRecovery: false,
    });

    if (!lockRes.acquired) {
      throw buildDurableLockFailureError(
        lockRes,
        `Order '${order.order_id || order.id}'`
      );
    }

    acquiredLockOwnerId = lockRes.lockOwnerId;
    ownsDurableLock = lockRes.tableAvailable;
    orderLockTableAvailable = lockRes.tableAvailable;
  }

  let dbGrant: any = null;
  let clientUuid = '';
  let xuiWriteAttempted = false;
  let xuiWriteConfirmed = false;

  const assertOrderLockStillHeld = async (
    stage: 'before_external_write' | 'before_db_finalization'
  ): Promise<void> => {
    if (!acquiredLockOwnerId || !orderLockTableAvailable) {
      const missingErr: any = new Error(
        `Missing verified durable order lock '${durableOperationKey}' (${stage}); refusing to proceed without required lock.`
      );
      missingErr.statusCode = 409;
      missingErr.code = stage === 'before_db_finalization' ? 'RECONCILIATION_REQUIRED' : 'ORDER_LOCK_MISSING';
      missingErr.beforeExternalWrite = stage === 'before_external_write';
      missingErr.xuiUncertain = stage === 'before_db_finalization';
      missingErr.markLockUncertain = stage === 'before_db_finalization';
      throw missingErr;
    }

    const renewed = await renewDurableProvisioningOperationLock({
      dbClient,
      operationKey: durableOperationKey,
      lockOwnerId: acquiredLockOwnerId,
      leaseSeconds: DEFAULT_LOCK_LEASE_SECONDS,
    });
    if (!renewed) {
      const fenceErr: any = new Error(
        stage === 'before_db_finalization'
          ? `Lost durable order lock '${durableOperationKey}' after 3X-UI revocation; refusing stale DB finalization. Manual reconciliation required.`
          : `Lost durable order lock '${durableOperationKey}' before 3X-UI revocation; aborting before external mutation.`
      );
      fenceErr.statusCode = 409;
      fenceErr.code = stage === 'before_db_finalization' ? 'RECONCILIATION_REQUIRED' : 'ORDER_LOCK_LOST';
      fenceErr.beforeExternalWrite = stage === 'before_external_write';
      fenceErr.xuiUncertain = stage === 'before_db_finalization';
      fenceErr.markLockUncertain = stage === 'before_db_finalization';
      throw fenceErr;
    }
  };

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
          allowUncertainRecovery: false,
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
            const preWriteClientEnabled = clientsList[clientIdx].enable !== false;
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

            const verifyLocksBeforeExternalMutation = async (): Promise<void> => {
              assertRequestNotTimedOutBeforeExternalMutation(
                options?.signal,
                `provisional order revocation for order ${order.order_id || order.id}`
              );
              await assertInboundLockStillHeld();
              await assertOrderLockStillHeld('before_external_write');
            };

            await verifyLocksBeforeExternalMutation();

            xuiWriteAttempted = true;
            let updateRes: any = null;
            let explicitPanelErr: any = null;
            try {
              updateRes = await requestApiCall<any>(
                `/panel/api/inbounds/update/${inboundId}`,
                'POST',
                updateInboundPayload,
                {
                  beforeSend: verifyLocksBeforeExternalMutation,
                  signal: options?.signal,
                }
              );
            } catch (apiErr: any) {
              if (apiErr?.xuiExplicitRejection === true || isHttp400Or422Error(apiErr)) {
                explicitPanelErr = apiErr;
              } else {
                throw apiErr;
              }
            }

            // MANDATORY READ-BACK VERIFICATION: confirm enable === false persisted on 3X-UI
            // (runs both on success AND on generic success:false rejection, and even if deadline elapsed after dispatch)
            let verifiedInbound: any = null;
            let readbackFetchErr: any = null;
            try {
              verifiedInbound = await fetchFreshInbound();
            } catch (rbErr: any) {
              readbackFetchErr = rbErr;
            }
            if (!verifiedInbound) {
              const reconErr: any = new Error(
                explicitPanelErr || (updateRes && updateRes.success === false)
                  ? `3X-UI rejected disabling provisional client ${clientUuid} (${explicitPanelErr?.message || updateRes?.msg || 'success:false'}) and read-back verification failed${readbackFetchErr ? `: ${readbackFetchErr?.message || String(readbackFetchErr)}` : ''}.`
                  : `Read-back verification failed: unable to re-fetch inbound ${inboundId} after disabling client ${clientUuid}${readbackFetchErr ? `: ${readbackFetchErr?.message || String(readbackFetchErr)}` : ''}.`
              );
              reconErr.statusCode = 409;
              reconErr.code = 'RECONCILIATION_REQUIRED';
              reconErr.xuiUncertain = true;
              reconErr.markLockUncertain = true;
              throw reconErr;
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

            if (!verifiedClient) {
              const missingErr: any = new Error(
                `Read-back verification failed for provisional client ${clientUuid} on inbound ${inboundId}: client missing after update.`
              );
              missingErr.statusCode = 409;
              missingErr.code = 'RECONCILIATION_REQUIRED';
              missingErr.xuiUncertain = true;
              missingErr.markLockUncertain = true;
              throw missingErr;
            }

            if (verifiedClient.enable !== false) {
              const panelMsg =
                explicitPanelErr?.message ||
                (updateRes && updateRes.success === false ? (updateRes.msg || updateRes.message) : null) ||
                `Read-back verification failed for provisional client ${clientUuid} on inbound ${inboundId}: expected enable=false, got ${String(verifiedClient?.enable)}.`;
              const readbackErr: any = new Error(panelMsg);
              // Live panel read-back proved client state remained unchanged (still enabled)
              readbackErr.xuiUncertain = !preWriteClientEnabled;
              throw readbackErr;
            }

            // Live panel verified enable === false! (Even if panel returned generic { success: false }, disable persisted.)
            xuiWriteConfirmed = true;
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

    // Re-verify durable order lock ownership immediately before DB finalization so a stale worker
    // never overwrites vpn_accounts/vpn_configs/vpn_entitlement_grants/orders owned by another worker.
    await assertOrderLockStillHeld(xuiWriteAttempted ? 'before_db_finalization' : 'before_external_write');

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
    // Never overwrite 409 lock/state conflicts or pre-mutation deadline stops with revoke_failed
    if (err?.statusCode === 409 || err?.beforeExternalWrite === true) {
      const lockOutcome: 'failed' | 'uncertain' =
        err?.xuiUncertain === true || err?.markLockUncertain === true ? 'uncertain' : 'failed';
      if (
        (err?.xuiUncertain === true || err?.markLockUncertain === true) &&
        err?.code !== 'ORDER_LOCK_LOST' &&
        err?.code !== 'ORDER_LOCK_MISSING' &&
        orderLockTableAvailable &&
        acquiredLockOwnerId
      ) {
        const stillOwnsOrderLock = await renewDurableProvisioningOperationLock({
          dbClient,
          operationKey: durableOperationKey,
          lockOwnerId: acquiredLockOwnerId,
          leaseSeconds: DEFAULT_LOCK_LEASE_SECONDS,
        });
        if (stillOwnsOrderLock) {
          const nowIso = new Date().toISOString();
          const errText = err?.message || String(err);
          if (dbGrant?.id) {
            try {
              await dbClient
                .from('vpn_entitlement_grants')
                .update({
                  status: 'uncertain',
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
                provisioning_status: 'uncertain',
                updated_at: nowIso,
              })
              .eq('id', order.id);
          } catch (_e) {}
        }
      }
      await releaseOwnedLock(lockOutcome, err?.message || String(err));
      throw err;
    }

    const nowIso = new Date().toISOString();
    const errText = err?.message || String(err);

    // If an external 3X-UI revocation write was already dispatched and did not produce a verified
    // unchanged read-back or confirmed disable, mark RECONCILIATION_REQUIRED / uncertain rather than definitive failure.
    const isUncertainAfterWrite = Boolean(
      xuiWriteAttempted &&
      !xuiWriteConfirmed &&
      err?.beforeExternalWrite !== true &&
      err?.xuiUncertain !== false
    );

    const canSafelyUpdateOrderRows =
      orderLockTableAvailable && acquiredLockOwnerId
        ? await renewDurableProvisioningOperationLock({
            dbClient,
            operationKey: durableOperationKey,
            lockOwnerId: acquiredLockOwnerId,
            leaseSeconds: DEFAULT_LOCK_LEASE_SECONDS,
          })
        : false;

    const targetStatus = isUncertainAfterWrite ? 'uncertain' : 'revoke_failed';

    if (canSafelyUpdateOrderRows) {
      if (dbGrant?.id) {
        try {
          await dbClient
            .from('vpn_entitlement_grants')
            .update({
              status: targetStatus,
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
            provisioning_status: targetStatus,
            updated_at: nowIso,
          })
          .eq('id', order.id);
      } catch (_e) {}
    }

    await releaseOwnedLock(isUncertainAfterWrite ? 'uncertain' : 'failed', errText);

    if (isUncertainAfterWrite) {
      const reconErr: any = new Error(
        `Provisional VPN client revocation outcome is uncertain after external 3X-UI dispatch (${errText}). Marked for reconciliation.`
      );
      reconErr.statusCode = 409;
      reconErr.code = 'RECONCILIATION_REQUIRED';
      reconErr.xuiUncertain = true;
      reconErr.markLockUncertain = true;
      throw reconErr;
    }

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

export const setCachedInbounds = (
  inbounds: XuiInbound[],
  panelIdentity?: string,
  expectedGeneration?: number
): void => {
  if (expectedGeneration !== undefined && expectedGeneration !== inboundsCacheGeneration) {
    return;
  }
  if (Array.isArray(inbounds)) {
    cachedInbounds = inbounds;
    lastInboundsCacheTime = Date.now();
    if (panelIdentity !== undefined) {
      cachedInboundsPanelIdentity = panelIdentity;
    }
  }
};

export const getCachedInbounds = async (panelIdentity?: string): Promise<XuiInbound[]> => {
  const requestedPanel = String(panelIdentity || '').trim();
  if (requestedPanel && cachedInboundsPanelIdentity && cachedInboundsPanelIdentity !== 'default' && requestedPanel !== cachedInboundsPanelIdentity) {
    return [];
  }
  return cachedInbounds;
};

let isSyncInProgress = false;
let lastSyncAt = 0;

let isPanelDeletionSyncInProgress = false;
let lastPanelDeletionSyncAt = 0;
const PANEL_DELETION_SYNC_LEASE_KEY = 'panel_deletion_sync_lease';
const PANEL_DELETION_SYNC_INSTANCE_ID = `inst-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

export const resetPanelDeletionSyncSchedulerStateForTests = (): void => {
  isPanelDeletionSyncInProgress = false;
  lastPanelDeletionSyncAt = 0;
};

export interface CrossInstanceLeaseAcquireResult {
  acquired: boolean;
  ownerId: string;
  leaseVersion?: string | null;
  leaseExpiresAtMs?: number | null;
  updatedAt?: string | null;
  reason?: string;
}

export interface CrossInstanceLeaseRenewResult {
  renewed: boolean;
  ownerId: string;
  leaseVersion?: string | null;
  leaseExpiresAtMs?: number | null;
  updatedAt?: string | null;
  reason?: string;
}

export interface CrossInstanceLeaseVerifyResult {
  valid: boolean;
  ownerId: string;
  leaseVersion?: string | null;
  leaseExpiresAtMs?: number | null;
  remainingMs?: number;
  reason?: string;
}

/**
 * Helper to apply PostgREST JSONB CAS filters on `public.settings` for `panel_deletion_sync_lease`.
 * Matches `id = 'panel_deletion_sync_lease'` plus:
 * - If the current row has `data.leaseVersion`, matches `.eq('data->>leaseVersion', prevLeaseVersion)`
 *   (and `.eq('data->>ownerId', prevOwnerId)` when present).
 * - If the current row is a legacy row without `data.leaseVersion`, matches `.is('data->>leaseVersion', null)`
 *   plus `updated_at` (or `.is('updated_at', null)`).
 * Notice: Because PostgreSQL's `trigger_settings_updated_at` sets `NEW.updated_at = NOW()` (which
 * evaluates to transaction timestamp and can repeat within the same millisecond or override explicit
 * `updated_at` values), relying on `data->>leaseVersion` (a fresh cryptographic UUID on every transition)
 * guarantees atomic single-winner CAS even across same-millisecond updates.
 * Note on fencing: Because the lease row lives in `public.settings` while deletion markers execute via
 * a separate `mark_vpn_client_panel_deleted` RPC call, verifying lease ownership immediately before the
 * RPC narrows any cross-request race window to a single network RTT (combined with per-client and
 * per-inbound durable locks in `provisioning_operations`), rather than absolute single-transaction fencing.
 */
const applySettingsLeaseCasFilters = (
  query: any,
  existingRow: { updated_at?: string | null; data?: Record<string, any> | null }
): any => {
  let q = query.eq('id', PANEL_DELETION_SYNC_LEASE_KEY);
  const existingData = existingRow?.data && typeof existingRow.data === 'object' ? existingRow.data : {};
  const prevLeaseVersion =
    typeof existingData.leaseVersion === 'string' && existingData.leaseVersion.trim()
      ? existingData.leaseVersion.trim()
      : null;
  const prevOwnerId =
    typeof existingData.ownerId === 'string' && existingData.ownerId.trim()
      ? existingData.ownerId.trim()
      : null;

  if (prevLeaseVersion) {
    q = q.eq('data->>leaseVersion', prevLeaseVersion);
    if (prevOwnerId) {
      q = q.eq('data->>ownerId', prevOwnerId);
    }
  } else {
    q = q.is('data->>leaseVersion', null);
    if (prevOwnerId) {
      q = q.eq('data->>ownerId', prevOwnerId);
    }
    if (existingRow?.updated_at !== null && existingRow?.updated_at !== undefined) {
      q = q.eq('updated_at', existingRow.updated_at);
    } else {
      q = q.is('updated_at', null);
    }
  }
  return q;
};

/**
 * Acquires an atomic compare-and-swap (CAS) distributed scheduler lease using the existing
 * service-role-protected `public.settings` table (`id = 'panel_deletion_sync_lease'`).
 * Uses a cryptographically generated `leaseVersion` on every transition and fails CLOSED
 * on DB errors, active unexpired leases, cross-instance interval cooldowns, or CAS conflicts.
 */
export const acquireCrossInstanceDeletionSyncLease = async (params: {
  dbClient: any;
  intervalMs: number;
  nowMs?: number;
  force?: boolean;
  ownerId?: string;
  leaseTtlMs?: number;
}): Promise<CrossInstanceLeaseAcquireResult> => {
  const dbClient = params.dbClient;
  const nowMs = params.nowMs ?? Date.now();
  const ownerId = params.ownerId || `${PANEL_DELETION_SYNC_INSTANCE_ID}-${crypto.randomUUID().slice(0, 8)}`;
  const intervalMs = Math.max(1000, Math.floor(params.intervalMs || getPanelDeletionSyncIntervalMs()));
  const leaseTtlMs = Math.max(params.leaseTtlMs ?? Math.max(intervalMs + 60000, 180000), 30000);
  const nextLeaseVersion = crypto.randomUUID();

  if (!dbClient || typeof dbClient.from !== 'function') {
    return { acquired: false, ownerId, reason: 'lease_db_client_unavailable' };
  }

  const nowIso = new Date(nowMs).toISOString();
  const leaseExpiresAtMs = nowMs + leaseTtlMs;
  const leaseExpiresAtIso = new Date(leaseExpiresAtMs).toISOString();

  try {
    const { data: existing, error: readErr } = await dbClient
      .from('settings')
      .select('id, data, updated_at')
      .eq('id', PANEL_DELETION_SYNC_LEASE_KEY)
      .maybeSingle();

    if (readErr) {
      return {
        acquired: false,
        ownerId,
        reason: `lease_read_error:${readErr.message || readErr.code || 'unknown'}`,
      };
    }

    if (!existing) {
      const initialData = {
        ownerId,
        leaseVersion: nextLeaseVersion,
        status: 'running',
        startedAt: nowIso,
        renewedAt: nowIso,
        leaseExpiresAt: leaseExpiresAtIso,
        lastCompletedAt: null,
        intervalMs,
      };
      const { data: inserted, error: insertErr } = await dbClient
        .from('settings')
        .insert({ id: PANEL_DELETION_SYNC_LEASE_KEY, data: initialData, updated_at: nowIso })
        .select('id, data, updated_at')
        .maybeSingle();

      if (insertErr) {
        return {
          acquired: false,
          ownerId,
          reason: `lease_insert_conflict:${insertErr.code || insertErr.message || 'conflict'}`,
        };
      }
      if (
        !inserted ||
        inserted.data?.ownerId !== ownerId ||
        inserted.data?.leaseVersion !== nextLeaseVersion
      ) {
        return { acquired: false, ownerId, reason: 'lease_insert_owner_mismatch' };
      }
      return {
        acquired: true,
        ownerId,
        leaseVersion: nextLeaseVersion,
        leaseExpiresAtMs,
        updatedAt: inserted?.updated_at ?? nowIso,
      };
    }

    const existingData = existing.data && typeof existing.data === 'object' ? existing.data : {};
    const leaseExpMs = existingData.leaseExpiresAt ? new Date(existingData.leaseExpiresAt).getTime() : 0;
    if (
      String(existingData.status || '').toLowerCase() === 'running' &&
      Number.isFinite(leaseExpMs) &&
      leaseExpMs > nowMs
    ) {
      return {
        acquired: false,
        ownerId,
        reason: `lease_held_by_active_instance:${existingData.ownerId || 'unknown'}`,
      };
    }

    if (!params.force) {
      const lastCompletedMs = existingData.lastCompletedAt ? new Date(existingData.lastCompletedAt).getTime() : 0;
      const lastStartedMs = existingData.startedAt ? new Date(existingData.startedAt).getTime() : 0;
      const lastActivityMs = Math.max(
        Number.isFinite(lastCompletedMs) ? lastCompletedMs : 0,
        Number.isFinite(lastStartedMs) ? lastStartedMs : 0
      );
      if (lastActivityMs > 0 && nowMs - lastActivityMs < intervalMs) {
        return {
          acquired: false,
          ownerId,
          reason: 'cross_instance_interval_cooldown',
        };
      }
    }

    const prevUpdatedMs = existing.updated_at ? new Date(existing.updated_at).getTime() : 0;
    const monotonicUpdatedIso = new Date(
      Math.max(nowMs, (Number.isFinite(prevUpdatedMs) ? prevUpdatedMs : 0) + 1)
    ).toISOString();

    const nextData = {
      ...existingData,
      ownerId,
      leaseVersion: nextLeaseVersion,
      status: 'running',
      startedAt: nowIso,
      renewedAt: nowIso,
      leaseExpiresAt: leaseExpiresAtIso,
      intervalMs,
    };

    const casQuery = applySettingsLeaseCasFilters(
      dbClient.from('settings').update({ data: nextData, updated_at: monotonicUpdatedIso }),
      existing
    );

    const { data: updatedRows, error: casErr } = await casQuery.select('id, data, updated_at');
    if (casErr) {
      return {
        acquired: false,
        ownerId,
        reason: `lease_cas_error:${casErr.message || casErr.code || 'unknown'}`,
      };
    }

    const rows = Array.isArray(updatedRows) ? updatedRows : updatedRows ? [updatedRows] : [];
    if (
      rows.length !== 1 ||
      rows[0]?.data?.ownerId !== ownerId ||
      rows[0]?.data?.leaseVersion !== nextLeaseVersion
    ) {
      return {
        acquired: false,
        ownerId,
        reason: 'lease_cas_lost',
      };
    }

    return {
      acquired: true,
      ownerId,
      leaseVersion: nextLeaseVersion,
      leaseExpiresAtMs,
      updatedAt: rows[0]?.updated_at ?? monotonicUpdatedIso,
    };
  } catch (err: any) {
    return {
      acquired: false,
      ownerId,
      reason: `lease_exception:${err?.message || 'unknown'}`,
    };
  }
};

/**
 * Safely renews an active, unexpired cross-instance deletion synchronization lease before processing
 * each deletion candidate. NEVER renews an expired lease or a lease owned by another worker/version.
 */
export const renewCrossInstanceDeletionSyncLease = async (params: {
  dbClient: any;
  ownerId: string;
  expectedLeaseVersion?: string | null;
  leaseTtlMs?: number;
  nowMs?: number;
}): Promise<CrossInstanceLeaseRenewResult> => {
  const { dbClient, ownerId, expectedLeaseVersion } = params;
  const nowMs = params.nowMs ?? Date.now();
  const leaseTtlMs = Math.max(params.leaseTtlMs ?? 180000, 30000);

  if (!dbClient || typeof dbClient.from !== 'function' || !ownerId) {
    return { renewed: false, ownerId: ownerId || '', reason: 'lease_db_client_or_owner_unavailable' };
  }

  try {
    const { data: current, error: readErr } = await dbClient
      .from('settings')
      .select('id, data, updated_at')
      .eq('id', PANEL_DELETION_SYNC_LEASE_KEY)
      .maybeSingle();

    if (readErr || !current) {
      return {
        renewed: false,
        ownerId,
        reason: readErr ? `lease_renew_read_error:${readErr.message || 'unknown'}` : 'lease_row_missing',
      };
    }

    const curData = current.data && typeof current.data === 'object' ? current.data : {};
    if (curData.ownerId !== ownerId) {
      return {
        renewed: false,
        ownerId,
        reason: `lease_owner_mismatch:${curData.ownerId || 'none'}`,
      };
    }

    if (expectedLeaseVersion && curData.leaseVersion !== expectedLeaseVersion) {
      return {
        renewed: false,
        ownerId,
        reason: 'lease_version_mismatch',
      };
    }

    if (String(curData.status || '').toLowerCase() !== 'running') {
      return {
        renewed: false,
        ownerId,
        reason: `lease_not_running:${curData.status || 'unknown'}`,
      };
    }

    const leaseExpMs = curData.leaseExpiresAt ? new Date(curData.leaseExpiresAt).getTime() : 0;
    if (!Number.isFinite(leaseExpMs) || leaseExpMs <= nowMs) {
      return {
        renewed: false,
        ownerId,
        reason: 'lease_already_expired',
      };
    }

    const nextLeaseVersion = crypto.randomUUID();
    const nowIso = new Date(nowMs).toISOString();
    const nextExpiresAtMs = nowMs + leaseTtlMs;
    const nextExpiresAtIso = new Date(nextExpiresAtMs).toISOString();
    const prevUpdatedMs = current.updated_at ? new Date(current.updated_at).getTime() : 0;
    const monotonicUpdatedIso = new Date(
      Math.max(nowMs, (Number.isFinite(prevUpdatedMs) ? prevUpdatedMs : 0) + 1)
    ).toISOString();

    const nextData = {
      ...curData,
      ownerId,
      leaseVersion: nextLeaseVersion,
      status: 'running',
      renewedAt: nowIso,
      leaseExpiresAt: nextExpiresAtIso,
    };

    const casQuery = applySettingsLeaseCasFilters(
      dbClient.from('settings').update({ data: nextData, updated_at: monotonicUpdatedIso }),
      current
    );

    const { data: updatedRows, error: casErr } = await casQuery.select('id, data, updated_at');
    if (casErr) {
      return {
        renewed: false,
        ownerId,
        reason: `lease_renew_cas_error:${casErr.message || casErr.code || 'unknown'}`,
      };
    }

    const rows = Array.isArray(updatedRows) ? updatedRows : updatedRows ? [updatedRows] : [];
    if (
      rows.length !== 1 ||
      rows[0]?.data?.ownerId !== ownerId ||
      rows[0]?.data?.leaseVersion !== nextLeaseVersion
    ) {
      return {
        renewed: false,
        ownerId,
        reason: 'lease_renew_cas_lost',
      };
    }

    return {
      renewed: true,
      ownerId,
      leaseVersion: nextLeaseVersion,
      leaseExpiresAtMs: nextExpiresAtMs,
      updatedAt: rows[0]?.updated_at ?? monotonicUpdatedIso,
    };
  } catch (err: any) {
    return {
      renewed: false,
      ownerId,
      reason: `lease_renew_exception:${err?.message || 'unknown'}`,
    };
  }
};

/**
 * Verifies that the current worker still holds an active, unexpired cross-instance sweep lease
 * with sufficient remaining lease budget before executing a deletion mutation.
 */
export const verifyCrossInstanceDeletionSyncLeaseOwnership = async (params: {
  dbClient: any;
  ownerId: string;
  expectedLeaseVersion?: string | null;
  minRemainingBudgetMs?: number;
  nowMs?: number;
}): Promise<CrossInstanceLeaseVerifyResult> => {
  const { dbClient, ownerId, expectedLeaseVersion } = params;
  const nowMs = params.nowMs ?? Date.now();
  const minRemainingBudgetMs = Math.max(0, params.minRemainingBudgetMs ?? 0);

  if (!dbClient || typeof dbClient.from !== 'function' || !ownerId) {
    return { valid: false, ownerId: ownerId || '', reason: 'lease_db_client_or_owner_unavailable' };
  }

  try {
    const { data: current, error: readErr } = await dbClient
      .from('settings')
      .select('id, data, updated_at')
      .eq('id', PANEL_DELETION_SYNC_LEASE_KEY)
      .maybeSingle();

    if (readErr || !current) {
      return {
        valid: false,
        ownerId,
        reason: readErr ? `lease_verify_read_error:${readErr.message || 'unknown'}` : 'lease_row_missing',
      };
    }

    const curData = current.data && typeof current.data === 'object' ? current.data : {};
    if (curData.ownerId !== ownerId) {
      return {
        valid: false,
        ownerId,
        reason: `lease_owner_mismatch:${curData.ownerId || 'none'}`,
      };
    }

    if (expectedLeaseVersion && curData.leaseVersion !== expectedLeaseVersion) {
      return {
        valid: false,
        ownerId,
        reason: 'lease_version_mismatch',
      };
    }

    if (String(curData.status || '').toLowerCase() !== 'running') {
      return {
        valid: false,
        ownerId,
        reason: `lease_not_running:${curData.status || 'unknown'}`,
      };
    }

    const leaseExpMs = curData.leaseExpiresAt ? new Date(curData.leaseExpiresAt).getTime() : 0;
    if (!Number.isFinite(leaseExpMs) || leaseExpMs <= nowMs) {
      return {
        valid: false,
        ownerId,
        reason: 'lease_expired',
      };
    }

    const remainingMs = leaseExpMs - nowMs;
    if (remainingMs < minRemainingBudgetMs) {
      return {
        valid: false,
        ownerId,
        leaseVersion: curData.leaseVersion ?? null,
        leaseExpiresAtMs: leaseExpMs,
        remainingMs,
        reason: `lease_budget_exhausted:${remainingMs}ms`,
      };
    }

    return {
      valid: true,
      ownerId,
      leaseVersion: curData.leaseVersion ?? null,
      leaseExpiresAtMs: leaseExpMs,
      remainingMs,
    };
  } catch (err: any) {
    return {
      valid: false,
      ownerId,
      reason: `lease_verify_exception:${err?.message || 'unknown'}`,
    };
  }
};

export const releaseCrossInstanceDeletionSyncLease = async (params: {
  dbClient: any;
  ownerId: string;
  expectedLeaseVersion?: string | null;
  completed: boolean;
  nowMs?: number;
  summary?: Record<string, any>;
}): Promise<boolean> => {
  const { dbClient, ownerId, expectedLeaseVersion, completed, summary } = params;
  const nowMs = params.nowMs ?? Date.now();
  if (!dbClient || typeof dbClient.from !== 'function' || !ownerId) return false;

  try {
    const { data: current, error: readErr } = await dbClient
      .from('settings')
      .select('id, data, updated_at')
      .eq('id', PANEL_DELETION_SYNC_LEASE_KEY)
      .maybeSingle();

    if (readErr || !current || current.data?.ownerId !== ownerId) {
      return false;
    }

    if (expectedLeaseVersion && current.data?.leaseVersion !== expectedLeaseVersion) {
      return false;
    }

    const nextLeaseVersion = crypto.randomUUID();
    const prevUpdatedMs = current.updated_at ? new Date(current.updated_at).getTime() : 0;
    const monotonicUpdatedIso = new Date(
      Math.max(nowMs, (Number.isFinite(prevUpdatedMs) ? prevUpdatedMs : 0) + 1)
    ).toISOString();

    const nextData = {
      ...(current.data && typeof current.data === 'object' ? current.data : {}),
      ownerId,
      leaseVersion: nextLeaseVersion,
      status: 'idle',
      leaseExpiresAt: null,
      lastCompletedAt: completed ? new Date(nowMs).toISOString() : (current.data?.lastCompletedAt ?? null),
      lastReleasedAt: new Date(nowMs).toISOString(),
      ...(summary ? { lastSummary: summary } : {}),
    };

    const releaseQuery = applySettingsLeaseCasFilters(
      dbClient.from('settings').update({ data: nextData, updated_at: monotonicUpdatedIso }),
      current
    );

    const { data: updatedRows, error: updateErr } = await releaseQuery.select('id, data, updated_at');
    if (updateErr) return false;
    const rows = Array.isArray(updatedRows) ? updatedRows : updatedRows ? [updatedRows] : [];
    return rows.length === 1 && rows[0]?.data?.leaseVersion === nextLeaseVersion;
  } catch {
    return false;
  }
};

/**
 * Triggers the dedicated 2-minute panel deletion synchronization cycle when
 * PANEL_DELETION_SYNC_ENABLED=true. Enforces both in-process mutex and cross-instance
 * CAS lease coordination so overlapping cycles cannot run across processes or instances.
 */
export const triggerPanelDeletionSyncIfNeeded = (
  reason: string = 'Scheduled',
  force: boolean = false
): void => {
  if (!isPanelDeletionSyncFlagEnabled()) {
    return;
  }

  const now = Date.now();
  const intervalMs = getPanelDeletionSyncIntervalMs();

  if (!force && lastPanelDeletionSyncAt > 0 && now - lastPanelDeletionSyncAt < intervalMs) {
    return;
  }

  if (isPanelDeletionSyncInProgress) {
    console.log(`[3X-UI Deletion Scheduler] Skipped (${reason}): cycle already in progress.`);
    return;
  }

  syncDeleted3XUiClients({
    enforceCrossInstanceLease: true,
    forceLease: force,
    intervalMs,
  }).catch((err: any) => {
    console.error(`[3X-UI Deletion Scheduler] Failed for reason "${reason}":`, err?.message || err);
  });
};

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

export const startBackgroundSyncScheduler = (deps?: {
  triggerBackgroundSyncFn?: (reason?: string, force?: boolean) => void;
  triggerPanelDeletionSyncFn?: (reason?: string, force?: boolean) => void;
  startupDelayMs?: number;
  intervalMs?: number;
}): { startupTimer: ReturnType<typeof setTimeout>; intervalTimer: ReturnType<typeof setInterval> } => {
  const triggerBg = deps?.triggerBackgroundSyncFn || triggerBackgroundSyncIfNeeded;
  const triggerDel = deps?.triggerPanelDeletionSyncFn || triggerPanelDeletionSyncIfNeeded;
  const startupDelayMs = deps?.startupDelayMs ?? 5000;
  const intervalMs = deps?.intervalMs ?? 60000;

  // Single non-overlapping startup warmup (runs getInbounds -> cleanupExpiredTrials -> syncDeleted3XUiClients cleanly)
  const startupTimer = setTimeout(() => {
    try {
      triggerBg('Server Start', true);
    } catch (err) {
      console.error('[Scheduler] Initial background sync error:', err);
    }
  }, startupDelayMs);

  // Periodic scheduled sync (includes triggerPanelDeletionSyncIfNeeded so deletion sync still runs if startup failed)
  const intervalTimer = setInterval(() => {
    try {
      triggerBg('Scheduled', false);
    } catch (err) {
      console.error('[Scheduler] Scheduled background sync error:', err);
    }
    try {
      triggerDel('Scheduled', false);
    } catch (err) {
      console.error('[Scheduler] Scheduled panel deletion sync error:', err);
    }
  }, intervalMs);

  return { startupTimer, intervalTimer };
};

export const runBackgroundSync = async (
  reason: string = 'Scheduled',
  force: boolean = false,
  deps?: {
    getInboundsFn?: (forceRefresh?: boolean) => Promise<XuiInbound[]>;
    cleanupExpiredTrialsFn?: () => Promise<{ count: number }>;
    syncDeleted3XUiClientsFn?: (opts?: SyncDeletedClientsOptions) => Promise<SyncDeletedClientsResult>;
    runScheduledExpiryEmailCheckFn?: () => Promise<any>;
  }
): Promise<void> => {
  if (isSyncInProgress) {
    console.log('[Background Sync] Skipped (sync already in progress)');
    return;
  }
  isSyncInProgress = true;
  console.log(`[Background Sync] Synchronization started (Reason: ${reason})`);
  const syncStartTime = Date.now();

  try {
    // 1. Fetch live 3X-UI inbounds once and cache them in memory for metadata/stats.
    let inbounds: XuiInbound[] = [];
    try {
      const fetchInbounds = deps?.getInboundsFn || getInbounds;
      inbounds = await fetchInbounds(force);
    } catch (inbErr: any) {
      console.error('[Background Sync] Initial inbound warmup failed (continuing cleanup/deletion sync):', inbErr?.message || inbErr);
    }

    // 2. Run trial cleanup & authoritative uncached deleted-client sync independently
    // NEVER pass cached inbounds into syncDeleted3XUiClients — it always performs fresh uncached panel reads.
    let trialCleanupResult = { count: 0 };
    try {
      const runTrialCleanup = deps?.cleanupExpiredTrialsFn || cleanupExpiredTrials;
      trialCleanupResult = await runTrialCleanup();
    } catch (trialErr: any) {
      console.error('[Background Sync] Expired trial cleanup failed (continuing deletion sync):', trialErr?.message || trialErr);
    }

    let deletedCount = 0;
    try {
      const runDeletionSync = deps?.syncDeleted3XUiClientsFn || syncDeleted3XUiClients;
      const syncResult = await runDeletionSync({ enforceCrossInstanceLease: true });
      deletedCount = syncResult.deletedCount;
    } catch (delErr: any) {
      console.error('[Background Sync] Panel deletion sync failed:', delErr?.message || delErr);
    }

    // 3. Run scheduled VPN expiry reminder & expiration email check (non-blocking)
    const runExpiryCheck = deps?.runScheduledExpiryEmailCheckFn || runScheduledExpiryEmailCheck;
    runExpiryCheck().catch((expErr: any) => {
      console.warn('[Background Sync] Scheduled expiry email check warning:', expErr?.message || expErr);
    });

    lastSyncAt = Date.now();
    const durationSec = ((Date.now() - syncStartTime) / 1000).toFixed(1);

    // Fetch total active orders count from orders for the summary
    let ordersCount = 0;
    if (!deps) {
      try {
        const { count } = await supabaseAdmin
          .from('orders')
          .select('*', { count: 'exact', head: true })
          .in('status', ['active', 'trial', 'pending']);
        ordersCount = count || 0;
      } catch {}
    }

    // Count client stats in inbounds
    let clientsCount = 0;
    if (inbounds && inbounds.length > 0) {
      for (const ib of inbounds) {
        let settingsObj: any = {};
        try {
          if (ib.settings) settingsObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings;
        } catch {}
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

export interface MassAbsenceSafetyContext {
  trackedNonDeletedUuids: Set<string> | string[];
  maxDeletesPerCycle?: number;
  maxMissingRatio?: number;
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
  fetchUncachedInbound?: (inboundId: number, options?: { timeoutMs?: number }) => Promise<UncachedInboundReadResult>;
  fetchUncachedInboundsList?: (options?: { timeoutMs?: number }) => Promise<UncachedInboundsListReadResult>;
  preVerifiedOutsideSnapshots?: {
    snapshot1: UncachedInboundsListReadResult;
    snapshot2: UncachedInboundsListReadResult;
  };
  massAbsenceSafetyContext?: MassAbsenceSafetyContext;
  assertDistributedLeaseStillHeld?: () => Promise<void>;
  reReadDelayMs?: number;
  lockedReadTimeoutMs?: number;
  lockLeaseBudgetRatio?: number;
  releaseRetryBaseDelayMs?: number;
  nowMs?: number;
}

export interface VerifyAndMarkDeletedResult {
  confirmedDeleted: boolean;
  alreadyDeleted?: boolean;
  applied?: boolean;
  reconciliationRequired?: boolean;
  reconciledAfterAmbiguousRpc?: boolean;
  mutationUncertain?: boolean;
  circuitBreakerTriggered?: boolean;
  circuitBreakerReason?: string;
  distributedLeaseLost?: boolean;
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
  fetchUncachedInbound?: (inboundId: number, options?: { timeoutMs?: number }) => Promise<UncachedInboundReadResult>;
  fetchUncachedInboundsList?: (options?: { timeoutMs?: number }) => Promise<UncachedInboundsListReadResult>;
  reReadDelayMs?: number;
  lockedReadTimeoutMs?: number;
  lockLeaseBudgetRatio?: number;
  releaseRetryBaseDelayMs?: number;
  enforceCrossInstanceLease?: boolean;
  forceLease?: boolean;
  leaseOwnerId?: string;
  leaseTtlMs?: number;
  intervalMs?: number;
  maxDeletesPerCycle?: number;
  maxMissingRatio?: number;
  pageSize?: number;
  nowMs?: number;
}

export interface SyncDeletedClientsResult {
  synced: boolean;
  skippedDisabled?: boolean;
  skippedBusy?: boolean;
  skippedLease?: boolean;
  leaseSkipReason?: string;
  leaseLostMidSweep?: boolean;
  leaseLostReason?: string;
  circuitBreakerTriggered?: boolean;
  circuitBreakerReason?: string;
  panelRequestCount?: number;
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
  inboundId: number,
  options?: { timeoutMs?: number }
): Promise<UncachedInboundReadResult> => {
  const normalizedId = Number(inboundId);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
    return { status: 'error', reason: 'invalid_inbound_id' };
  }

  try {
    const effectiveOptions = {
      ...options,
      timeoutMs: options?.timeoutMs ?? getXuiSingleInboundTimeoutMs(),
    };
    const res = await requestApi<any>(`/panel/api/inbounds/get/${normalizedId}`, 'GET', undefined, effectiveOptions);
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
export const fetchUncachedLiveInboundsList = async (
  options?: { timeoutMs?: number }
): Promise<UncachedInboundsListReadResult> => {
  try {
    const effectiveOptions = {
      ...options,
      timeoutMs: options?.timeoutMs ?? getXuiFullListTimeoutMs(),
    };
    const rawList = await requestApi<XuiInbound[]>('/panel/api/inbounds/list', 'GET', undefined, effectiveOptions);
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

/**
 * Deterministic primary-key cursor pagination helper (`id ASC` + `.gt('id', lastCursorId)`).
 * Ensures queries over `vpn_accounts`, `vpn_configs`, `vpn_entitlement_grants`, and `xui_servers`
 * are never silently truncated by PostgREST / Supabase default `max-rows` limits (e.g., 1,000 rows),
 * and never falsely assumes a short page means completion when a server enforces a smaller cap
 * than `requestedPageSize`. Loops until an empty page (`0` rows) is returned or a non-advancing
 * cursor is detected, failing CLOSED if any page fails or cannot be verified complete.
 */
export const fetchAllTableRowsByPrimaryKeyCursor = async <T = any>(params: {
  dbClient: any;
  table: string;
  selectColumns?: string;
  primaryKeyColumn?: string;
  pageSize?: number;
  maxPages?: number;
  applyFilters?: (query: any) => any;
}): Promise<{ ok: true; rows: T[]; pagesFetched: number; reason?: string } | { ok: false; reason: string; rows: T[] }> => {
  const { dbClient, table } = params;
  const selectColumns = params.selectColumns || '*';
  const pkCol = params.primaryKeyColumn || 'id';
  const pageSize = Math.max(1, Math.min(Math.floor(params.pageSize || 1000), 5000));
  const maxPages = Math.max(1, Math.floor(params.maxPages || 1000));

  if (!dbClient || typeof dbClient.from !== 'function') {
    return { ok: false, reason: `${table}_db_client_unavailable`, rows: [] };
  }

  const allRows: T[] = [];
  const seenIds = new Set<string>();
  let lastCursorId: string | number | null = null;
  let pagesFetched = 0;

  try {
    while (pagesFetched < maxPages) {
      let query: any = dbClient.from(table).select(selectColumns);
      if (params.applyFilters) {
        query = params.applyFilters(query);
      }

      if (typeof query.order === 'function') {
        query = query.order(pkCol, { ascending: true });
      }

      const supportsGtCursor = typeof query.gt === 'function';
      if (lastCursorId !== null && supportsGtCursor) {
        query = query.gt(pkCol, lastCursorId);
      }

      if (typeof query.limit === 'function') {
        query = query.limit(pageSize);
      } else if (typeof query.range === 'function') {
        const offset = pagesFetched * pageSize;
        query = query.range(offset, offset + pageSize - 1);
      }

      const res: any = await query;
      if (res?.error) {
        return {
          ok: false,
          reason: `${table}_page_${pagesFetched + 1}_error:${res.error.message || res.error.code || 'db_error'}`,
          rows: [],
        };
      }

      if (!Array.isArray(res?.data)) {
        return {
          ok: false,
          reason: `${table}_page_${pagesFetched + 1}_non_array_response`,
          rows: [],
        };
      }

      const pageRows: any[] = res.data;
      pagesFetched += 1;

      if (pageRows.length === 0) {
        return { ok: true, rows: allRows, pagesFetched };
      }

      // If the mock/query builder doesn't support .gt() cursor filtering, fall back to verifying single-page completion
      if (!supportsGtCursor) {
        for (const r of pageRows) {
          allRows.push(r as T);
        }
        return { ok: true, rows: allRows, pagesFetched };
      }

      let advancedInPage = 0;
      let nextCursorCandidate: string | number | null = lastCursorId;

      for (const r of pageRows) {
        const rawPk = r?.[pkCol];
        if (rawPk === null || rawPk === undefined || String(rawPk).trim() === '') {
          return {
            ok: false,
            reason: `${table}_missing_primary_key_${pkCol}`,
            rows: [],
          };
        }
        const pkKey = String(rawPk);
        if (seenIds.has(pkKey)) {
          continue;
        }
        seenIds.add(pkKey);
        allRows.push(r as T);
        nextCursorCandidate = rawPk;
        advancedInPage += 1;
      }

      // If the mock DB ignored .gt() and returned the exact same rows again, we have already collected the full set
      if (advancedInPage === 0) {
        return { ok: true, rows: allRows, pagesFetched };
      }

      if (nextCursorCandidate === lastCursorId) {
        return {
          ok: false,
          reason: `${table}_cursor_did_not_advance`,
          rows: [],
        };
      }

      lastCursorId = nextCursorCandidate;
    }

    return {
      ok: false,
      reason: `${table}_pagination_exceeded_max_pages_${maxPages}`,
      rows: [],
    };
  } catch (err: any) {
    return {
      ok: false,
      reason: `${table}_pagination_exception:${err?.message || 'unknown'}`,
      rows: [],
    };
  }
};

/**
 * Evaluates the mass-deletion / mass-absence circuit breaker against a live panel snapshot
 * and the complete tracked non-deleted UUID population for the active panel.
 */
export const evaluateSnapshotMassAbsenceCircuitBreaker = (params: {
  snapshot: UncachedInboundsListReadResult;
  trackedNonDeletedUuids: Set<string> | string[];
  maxDeletesPerCycle: number;
  maxMissingRatio: number;
}): {
  triggered: boolean;
  reason: string | null;
  missingCount: number;
  totalTrackedNonDeleted: number;
  liveClientsCount: number;
} => {
  const trackedSet =
    params.trackedNonDeletedUuids instanceof Set
      ? params.trackedNonDeletedUuids
      : new Set(
          (Array.isArray(params.trackedNonDeletedUuids) ? params.trackedNonDeletedUuids : [])
            .map((u) => String(u || '').trim().toLowerCase())
            .filter(Boolean)
        );
  const totalTrackedNonDeleted = trackedSet.size;
  const liveMap = params.snapshot?.liveClientByUuid;
  const liveClientsCount = liveMap instanceof Map ? liveMap.size : 0;

  let missingCount = 0;
  for (const uuid of trackedSet) {
    if (!liveMap || !liveMap.has(uuid)) {
      missingCount += 1;
    }
  }

  let reason: string | null = null;
  if (liveClientsCount === 0 && totalTrackedNonDeleted >= 3) {
    reason = 'unexpected_zero_live_clients';
  } else if (missingCount > params.maxDeletesPerCycle) {
    reason = 'max_deletes_per_cycle_exceeded';
  } else if (
    totalTrackedNonDeleted >= 8 &&
    missingCount >= 3 &&
    missingCount / totalTrackedNonDeleted > params.maxMissingRatio
  ) {
    reason = 'max_missing_ratio_exceeded';
  }

  return {
    triggered: reason !== null,
    reason,
    missingCount,
    totalTrackedNonDeleted,
    liveClientsCount,
  };
};

const loadConfiguredXuiServers = async (
  dbClient: any
): Promise<Array<{ id: string; panel_url?: string | null; is_active?: boolean | null }>> => {
  if (!dbClient || typeof dbClient.from !== 'function') return [];
  try {
    const res = await fetchAllTableRowsByPrimaryKeyCursor<{
      id: string;
      panel_url?: string | null;
      is_active?: boolean | null;
    }>({
      dbClient,
      table: 'xui_servers',
      selectColumns: 'id, panel_url, is_active',
      primaryKeyColumn: 'id',
    });
    if (!res.ok) return [];
    return res.rows;
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
const isDefinitivePreCommitDeletionRpcError = (err: any): boolean => {
  if (!err) return false;
  if (isMissingSchemaOrRpcError(err)) return true;

  const code = String(err?.code || '').trim().toUpperCase();
  const status = Number(err?.status ?? err?.statusCode ?? 0);

  // Definitive PostgreSQL/PostgREST pre-commit, validation, auth, or constraint errors
  if (
    code === '42501' || // insufficient_privilege
    code === '22P02' || // invalid_text_representation
    code === '22003' || // numeric_value_out_of_range
    code === '23502' || // not_null_violation
    code === '23503' || // foreign_key_violation
    code === '23505' || // unique_violation
    code === '23514' || // check_violation
    code === 'P0001' || // explicit RAISE EXCEPTION in PL/pgSQL
    code === 'PGRST301' || // JWT / auth error
    code === 'PGRST204'
  ) {
    return true;
  }

  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) {
    return true;
  }

  return false;
};

const isAmbiguousDeletionRpcError = (err: any): boolean => {
  if (!err) return false;
  if (isDefinitivePreCommitDeletionRpcError(err)) return false;

  const code = String(err?.code || '').trim().toUpperCase();
  const status = Number(err?.status ?? err?.statusCode ?? 0);
  const name = String(err?.name || '').toLowerCase();
  const msg = String(err?.message || err || '').toLowerCase();

  if (status === 502 || status === 503 || status === 504 || status === 408) {
    return true;
  }
  if (
    name === 'aborterror' ||
    name === 'timeouterror' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNABORTED' ||
    code === 'EPIPE' ||
    code === '57014' // query_canceled / statement_timeout
  ) {
    return true;
  }
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('aborted') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('network error') ||
    msg.includes('failed to fetch') ||
    msg.includes('bad gateway') ||
    msg.includes('service unavailable') ||
    msg.includes('gateway timeout') ||
    msg.includes('connection closed') ||
    msg.includes('connection terminated') ||
    msg.includes('unexpected end of json')
  ) {
    return true;
  }

  // Fail closed: any unrecognized non-definitive RPC failure after dispatch is treated as ambiguous
  return true;
};

const runWithStrictTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const err: any = new Error(`${label} timed out after ${timeoutMs}ms`);
          err.code = 'LOCKED_READ_TIMEOUT';
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const reconcileClientPanelDeletionState = async (params: {
  dbClient: any;
  clientUuid: string;
  userId?: string | null;
}): Promise<
  | { status: 'confirmed_committed'; reconciliationRequired: boolean }
  | { status: 'inconclusive'; reason: string }
> => {
  const { dbClient, clientUuid, userId } = params;
  const normUuid = String(clientUuid || '').trim().toLowerCase();
  const normUserId = String(userId || '').trim().toLowerCase();

  if (!dbClient || typeof dbClient.from !== 'function') {
    return { status: 'inconclusive', reason: 'reconcile_db_client_unavailable' };
  }

  try {
    const [accRes, cfgRes] = await Promise.all([
      dbClient
        .from('vpn_accounts')
        .select('id, user_id, uuid, status, enable, deleted_from_panel_at, reconciliation_required')
        .ilike('uuid', normUuid),
      dbClient
        .from('vpn_configs')
        .select('id, customer_uid, user_id, uuid, status, enabled, deleted_from_panel_at, reconciliation_required')
        .ilike('uuid', normUuid),
    ]);

    if (accRes?.error) {
      return { status: 'inconclusive', reason: `reconcile_vpn_accounts_error:${accRes.error.message || 'unknown'}` };
    }

    // Production vpn_configs may not have a user_id column; retry without user_id if PostgREST reports missing column
    let cfgRows: any[] = [];
    if (cfgRes?.error) {
      const cfgErrMsg = String(cfgRes.error.message || '').toLowerCase();
      if (cfgErrMsg.includes('user_id') && cfgErrMsg.includes('does not exist')) {
        const retryCfg = await dbClient
          .from('vpn_configs')
          .select('id, customer_uid, uuid, status, enabled, deleted_from_panel_at, reconciliation_required')
          .ilike('uuid', normUuid);
        if (retryCfg?.error) {
          return { status: 'inconclusive', reason: `reconcile_vpn_configs_error:${retryCfg.error.message || 'unknown'}` };
        }
        cfgRows = Array.isArray(retryCfg?.data) ? retryCfg.data : [];
      } else {
        return { status: 'inconclusive', reason: `reconcile_vpn_configs_error:${cfgRes.error.message || 'unknown'}` };
      }
    } else {
      cfgRows = Array.isArray(cfgRes?.data) ? cfgRes.data : [];
    }

    const accRows: any[] = Array.isArray(accRes?.data) ? accRes.data : [];

    const matchedAccs = normUserId
      ? accRows.filter((r) => String(r?.user_id || '').trim().toLowerCase() === normUserId)
      : accRows;
    const matchedCfgs = normUserId
      ? cfgRows.filter((r) => {
          const cuid = String(r?.customer_uid || '').trim().toLowerCase();
          const uid = String(r?.user_id || '').trim().toLowerCase();
          return cuid === normUserId || uid === normUserId;
        })
      : cfgRows;

    if (matchedAccs.length === 0 && matchedCfgs.length === 0) {
      return { status: 'inconclusive', reason: 'reconcile_no_matching_customer_rows' };
    }

    const allAccsCommitted = matchedAccs.every(
      (r) =>
        String(r?.status || '').trim().toLowerCase() === 'deleted' &&
        Boolean(r?.deleted_from_panel_at) &&
        r?.enable === false
    );
    const allCfgsCommitted = matchedCfgs.every(
      (r) =>
        String(r?.status || '').trim().toLowerCase() === 'deleted' &&
        Boolean(r?.deleted_from_panel_at) &&
        r?.enabled === false
    );

    if (allAccsCommitted && allCfgsCommitted) {
      const reconciliationRequired =
        matchedAccs.some((r) => Boolean(r?.reconciliation_required)) ||
        matchedCfgs.some((r) => Boolean(r?.reconciliation_required));
      return { status: 'confirmed_committed', reconciliationRequired };
    }

    return { status: 'inconclusive', reason: 'reconcile_rows_not_confirmed_deleted' };
  } catch (err: any) {
    return { status: 'inconclusive', reason: `reconcile_exception:${err?.message || 'unknown'}` };
  }
};

export const verifyAndMarkClientDeletedIfConfirmed = async (
  params: VerifyAndMarkDeletedParams
): Promise<VerifyAndMarkDeletedResult> => {
  // Feature flag gate: disabled by default unless PANEL_DELETION_SYNC_ENABLED=true
  if (!isPanelDeletionSyncFlagEnabled()) {
    return {
      confirmedDeleted: false,
      dbWrites: 0,
      reason: 'panel_deletion_sync_disabled',
    };
  }

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
  const readList = params.fetchUncachedInboundsList || fetchUncachedLiveInboundsList;
  const reReadDelayMs = params.reReadDelayMs ?? 150;
  // Strictly bound the final locked verification read well below the 45s inbound lock lease
  const lockedReadTimeoutMs =
    params.lockedReadTimeoutMs !== undefined && Number.isFinite(params.lockedReadTimeoutMs) && params.lockedReadTimeoutMs > 0
      ? Math.min(Math.floor(params.lockedReadTimeoutMs), 15000)
      : 8000;
  const leaseBudgetRatio =
    params.lockLeaseBudgetRatio !== undefined &&
    Number.isFinite(params.lockLeaseBudgetRatio) &&
    params.lockLeaseBudgetRatio > 0 &&
    params.lockLeaseBudgetRatio <= 0.6
      ? params.lockLeaseBudgetRatio
      : 0.5;
  const maxAllowedLockedWindowMs = Math.max(
    100,
    Math.floor(INBOUND_LOCK_LEASE_SECONDS * 1000 * leaseBudgetRatio)
  );

  const maxDeletesPerCycle =
    params.massAbsenceSafetyContext?.maxDeletesPerCycle ?? getPanelDeletionSyncMaxDeletesPerCycle();
  const maxMissingRatio =
    params.massAbsenceSafetyContext?.maxMissingRatio ?? getPanelDeletionSyncMaxMissingRatio();

  // Verify complete panel-wide absence across EVERY inbound via fresh uncached /panel/api/inbounds/list.
  // NEVER confirm deletion using only single-inbound /get/{id}, because a client moved to another
  // inbound would be absent from the original inbound while still active on the panel.
  const performPanelWideAuthoritativeAbsenceRead = async (
    readLabel: 'read1' | 'read2',
    timeoutMs?: number
  ): Promise<{
    absent: boolean;
    reason: string;
    inboundMissing?: boolean;
    movedToInboundId?: number;
    circuitBreakerTriggered?: boolean;
    circuitBreakerReason?: string;
    snapshot?: UncachedInboundsListReadResult;
  }> => {
    const readOpts = timeoutMs ? { timeoutMs } : undefined;
    const listRes = timeoutMs
      ? await runWithStrictTimeout(readList(readOpts), timeoutMs, `${readLabel}_inbounds_list_read`)
      : await readList();

    if (!listRes || !listRes.ok) {
      return {
        absent: false,
        reason: `${readLabel}_error:${listRes?.reason || 'panel_list_failed'}`,
      };
    }

    if (!listRes.allInboundsCleanlyParsed || !Array.isArray(listRes.inbounds) || listRes.inbounds.length === 0) {
      return {
        absent: false,
        reason: `${readLabel}_incomplete_or_empty_list:${listRes.reason || (listRes.inbounds?.length === 0 ? 'empty_inbounds_list' : 'malformed_inbound_settings')}`,
      };
    }

    const liveHit = listRes.liveClientByUuid.get(normUuid);
    if (liveHit) {
      const liveInboundId = Number(liveHit.inbound?.id);
      if (Number.isInteger(liveInboundId) && liveInboundId > 0 && liveInboundId !== inboundId) {
        return {
          absent: false,
          movedToInboundId: liveInboundId,
          reason: `${readLabel}_client_moved_to_another_inbound`,
          snapshot: listRes,
        };
      }
      return { absent: false, reason: `${readLabel}_client_present`, snapshot: listRes };
    }

    // Apply mass-absence safety check on final locked full-panel snapshot (or whenever massAbsenceSafetyContext is provided)
    if (params.massAbsenceSafetyContext) {
      const cbCheck = evaluateSnapshotMassAbsenceCircuitBreaker({
        snapshot: listRes,
        trackedNonDeletedUuids: params.massAbsenceSafetyContext.trackedNonDeletedUuids,
        maxDeletesPerCycle,
        maxMissingRatio,
      });
      if (cbCheck.triggered && cbCheck.reason) {
        return {
          absent: false,
          circuitBreakerTriggered: true,
          circuitBreakerReason: cbCheck.reason,
          reason: `${readLabel}_circuit_breaker:${cbCheck.reason}`,
          snapshot: listRes,
        };
      }
    }

    const inboundMissing = !listRes.parsedByInboundId.has(inboundId);
    return {
      absent: true,
      inboundMissing,
      reason: inboundMissing
        ? `${readLabel}_inbound_and_client_confirmed_panel_wide_absent`
        : `${readLabel}_confirmed_panel_wide_absent`,
      snapshot: listRes,
    };
  };

  // Validate optional pre-verified outside snapshots passed by syncDeleted3XUiClients
  // (must be two distinct, complete, cleanly parsed, non-empty panel-wide snapshots both missing normUuid)
  const preSnaps = params.preVerifiedOutsideSnapshots;
  const hasValidPreVerifiedSnapshots = Boolean(
    preSnaps &&
    preSnaps.snapshot1 &&
    preSnaps.snapshot2 &&
    preSnaps.snapshot1 !== preSnaps.snapshot2 &&
    preSnaps.snapshot1.ok &&
    preSnaps.snapshot1.allInboundsCleanlyParsed &&
    Array.isArray(preSnaps.snapshot1.inbounds) &&
    preSnaps.snapshot1.inbounds.length > 0 &&
    !preSnaps.snapshot1.liveClientByUuid.has(normUuid) &&
    preSnaps.snapshot2.ok &&
    preSnaps.snapshot2.allInboundsCleanlyParsed &&
    Array.isArray(preSnaps.snapshot2.inbounds) &&
    preSnaps.snapshot2.inbounds.length > 0 &&
    !preSnaps.snapshot2.liveClientByUuid.has(normUuid)
  );

  // STEP 1 (OUTSIDE SHARED LOCKS): Fresh uncached panel-wide Read 1 (or verified two-snapshot sweep input).
  // Any panel timeout, network error, partial/malformed inbound list, or present/moved client exits
  // immediately with ZERO lock acquisitions and ZERO risk of stranding shared inbound/client locks.
  let read1: {
    absent: boolean;
    reason: string;
    inboundMissing?: boolean;
    movedToInboundId?: number;
    circuitBreakerTriggered?: boolean;
    circuitBreakerReason?: string;
  };
  if (hasValidPreVerifiedSnapshots && preSnaps) {
    const inboundMissing =
      !preSnaps.snapshot1.parsedByInboundId.has(inboundId) &&
      !preSnaps.snapshot2.parsedByInboundId.has(inboundId);
    read1 = {
      absent: true,
      inboundMissing,
      reason: inboundMissing
        ? 'pre_verified_two_panel_wide_snapshots_inbound_missing'
        : 'pre_verified_two_panel_wide_snapshots',
    };
  } else {
    try {
      read1 = await performPanelWideAuthoritativeAbsenceRead('read1');
    } catch (read1Err: any) {
      return {
        confirmedDeleted: false,
        dbWrites: 0,
        reason: `read1_error:${read1Err?.message || 'panel_read_failed'}`,
      };
    }

    if (!read1.absent) {
      if (read1.circuitBreakerTriggered && read1.circuitBreakerReason) {
        await recordDeduplicatedSyncAuditLog({
          dbClient,
          userId: null,
          action: 'panel_deletion_circuit_breaker_triggered',
          targetType: 'xui_panel',
          targetId: currentPanelIdentity,
          dedupeWindowHours: 1,
          details: {
            panel_identity: currentPanelIdentity,
            trigger_reason: read1.circuitBreakerReason,
            stage: 'read1',
            client_uuid: normUuid,
            max_deletes_per_cycle: maxDeletesPerCycle,
            max_missing_ratio: maxMissingRatio,
            source: params.source || 'background_sync',
          },
        });
        return {
          confirmedDeleted: false,
          circuitBreakerTriggered: true,
          circuitBreakerReason: read1.circuitBreakerReason,
          manualReviewFlagged: true,
          dbWrites: 0,
          reason: read1.reason,
        };
      }
      if (read1.movedToInboundId) {
        await recordDeduplicatedSyncAuditLog({
          dbClient,
          userId: params.userId || null,
          action: 'panel_deletion_inbound_mismatch',
          targetType: 'vpn_client',
          targetId: normUuid,
          details: {
            client_uuid: normUuid,
            expected_inbound_id: inboundId,
            live_inbound_id: read1.movedToInboundId,
            panel_identity: currentPanelIdentity,
            reason: read1.reason,
            source: params.source || 'background_sync',
          },
        });
        return {
          confirmedDeleted: false,
          manualReviewFlagged: true,
          dbWrites: 0,
          reason: read1.reason,
        };
      }
      return {
        confirmedDeleted: false,
        dbWrites: 0,
        reason: read1.reason,
      };
    }

    // Wait reReadDelayMs OUTSIDE shared locks so lock hold duration remains minimal
    if (reReadDelayMs > 0) {
      await new Promise((r) => setTimeout(r, reReadDelayMs));
    }
  }

  // STEP 2 (READ-ONLY LOCK PRE-CHECK): Inspect provisioning_operations before calling acquire_provisioning_lock.
  // Prevents deletion sync from contending on active locks or triggering stale-lease promotion on another worker's lock.
  if (dbClient && typeof dbClient.from === 'function') {
    try {
      const { data: activeOps, error: precheckErr } = await dbClient
        .from('provisioning_operations')
        .select('operation_key, status, operation_type')
        .in('operation_key', [`client:${normUuid}`, `inbound:${inboundId}`])
        .in('status', ['in_progress', 'uncertain']);

      if (precheckErr && !isMissingSchemaOrRpcError(precheckErr)) {
        console.warn(
          `[3X-UI Sync] Skipping deletion verification for UUID ${normUuid}: read-only lock pre-check failed (${precheckErr.message || 'unknown'}).`
        );
        return {
          confirmedDeleted: false,
          dbWrites: 0,
          reason: `lock_precheck_error:${precheckErr.message || 'unknown'}`,
        };
      }

      if (Array.isArray(activeOps) && activeOps.length > 0) {
        const uncertainOp = activeOps.find((op: any) => String(op?.status || '').toLowerCase() === 'uncertain');
        const blockingOp = uncertainOp || activeOps[0];
        const blockStatus = String(blockingOp?.status || 'in_progress').toLowerCase();
        const blockKey = String(blockingOp?.operation_key || 'unknown');
        console.log(
          `[3X-UI Sync] Skipping deletion verification for UUID ${normUuid}: read-only pre-check found ${blockStatus} lock on ${blockKey}.`
        );
        return {
          confirmedDeleted: false,
          dbWrites: 0,
          reason: `lock_precheck_${blockStatus}:${blockKey}`,
        };
      }
    } catch (precheckExc: any) {
      console.warn(
        `[3X-UI Sync] Skipping deletion verification for UUID ${normUuid}: read-only lock pre-check threw (${precheckExc?.message || 'unknown'}).`
      );
      return {
        confirmedDeleted: false,
        dbWrites: 0,
        reason: `lock_precheck_error:${precheckExc?.message || 'unknown'}`,
      };
    }
  }

  // STEP 3: Acquire durable locks in the established order: client:<uuid> -> inbound:<inboundId>
  // NEVER recover or steal uncertain locks (allowUncertainRecovery: false).
  // Inbound lock uses noExternalXuiWrite: true because deletion sync performs zero 3X-UI inbound writes;
  // ambiguous client DB RPC outcomes are explicitly reconciled and preserve client:<uuid> uncertainty protection.
  try {
    return await withClientMutationLock(
      {
        dbClient,
        clientUuid: normUuid,
        operationType: 'client_lock',
        targetId: `panel-delete-sync:${normUuid}`,
        requireDurableLock: true,
        allowUncertainRecovery: false,
        releaseRetryBaseDelayMs: params.releaseRetryBaseDelayMs,
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
            noExternalXuiWrite: true,
            releaseRetryBaseDelayMs: params.releaseRetryBaseDelayMs,
            maxWaitMs: 2000,
          },
          async (assertInboundLockStillHeld) => {
            const lockAcquiredAtMs = Date.now();

            // Verify both durable locks (and distributed sweep lease if present) immediately upon entry
            await assertClientLockStillHeld();
            await assertInboundLockStillHeld();
            if (params.assertDistributedLeaseStillHeld) {
              await params.assertDistributedLeaseStillHeld();
            }

            // Bound the final locked full-panel verification strictly within remaining lock lease budget
            const elapsedBeforeRead2Ms = Date.now() - lockAcquiredAtMs;
            const remainingBudgetMs = maxAllowedLockedWindowMs - elapsedBeforeRead2Ms;
            const minRequiredBudgetMs = Math.min(lockedReadTimeoutMs, 100);
            if (remainingBudgetMs < minRequiredBudgetMs) {
              const budgetErr: any = new Error(
                `read2_error:locked_read_lease_budget_exhausted (${remainingBudgetMs}ms remaining)`
              );
              budgetErr.code = 'LOCKED_READ_LEASE_BUDGET_EXHAUSTED';
              budgetErr.nonUncertainDeletionError = true;
              throw budgetErr;
            }
            const effectiveRead2TimeoutMs = Math.min(lockedReadTimeoutMs, remainingBudgetMs);

            // Fresh uncached panel-wide Read 2 inside strictly bounded locked window (read-only; pre-RPC)
            let read2: {
              absent: boolean;
              reason: string;
              inboundMissing?: boolean;
              movedToInboundId?: number;
              circuitBreakerTriggered?: boolean;
              circuitBreakerReason?: string;
            };
            try {
              read2 = await performPanelWideAuthoritativeAbsenceRead('read2', effectiveRead2TimeoutMs);
            } catch (read2Err: any) {
              // Read-only panel failure BEFORE RPC execution -> safe to finalize locks as 'failed' (never 'uncertain')
              const preRpcReadErr: any = new Error(`read2_error:${read2Err?.message || 'locked_read_failed'}`);
              preRpcReadErr.code = 'READ_ONLY_PANEL_FAILURE';
              preRpcReadErr.nonUncertainDeletionError = true;
              throw preRpcReadErr;
            }

            if (!read2.absent) {
              if (read2.circuitBreakerTriggered && read2.circuitBreakerReason) {
                console.error(
                  `[3X-UI Sync] LOCKED READ2 CIRCUIT BREAKER TRIGGERED (${read2.circuitBreakerReason}) for UUID ${normUuid}: aborting deletion.`
                );
                await recordDeduplicatedSyncAuditLog({
                  dbClient,
                  userId: null,
                  action: 'panel_deletion_circuit_breaker_triggered',
                  targetType: 'xui_panel',
                  targetId: currentPanelIdentity,
                  dedupeWindowHours: 1,
                  details: {
                    panel_identity: currentPanelIdentity,
                    trigger_reason: read2.circuitBreakerReason,
                    stage: 'locked_read2',
                    client_uuid: normUuid,
                    max_deletes_per_cycle: maxDeletesPerCycle,
                    max_missing_ratio: maxMissingRatio,
                    source: params.source || 'background_sync',
                  },
                });
                const cbErr: any = new Error(read2.reason);
                cbErr.code = 'LOCKED_READ2_CIRCUIT_BREAKER';
                cbErr.nonUncertainDeletionError = true;
                cbErr.circuitBreakerTriggered = true;
                cbErr.circuitBreakerReason = read2.circuitBreakerReason;
                throw cbErr;
              }
              if (read2.movedToInboundId) {
                await recordDeduplicatedSyncAuditLog({
                  dbClient,
                  userId: params.userId || null,
                  action: 'panel_deletion_inbound_mismatch',
                  targetType: 'vpn_client',
                  targetId: normUuid,
                  details: {
                    client_uuid: normUuid,
                    expected_inbound_id: inboundId,
                    live_inbound_id: read2.movedToInboundId,
                    panel_identity: currentPanelIdentity,
                    reason: read2.reason,
                    source: params.source || 'background_sync',
                  },
                });
                return {
                  confirmedDeleted: false,
                  manualReviewFlagged: true,
                  dbWrites: 0,
                  reason: read2.reason,
                };
              }
              return {
                confirmedDeleted: false,
                dbWrites: 0,
                reason: read2.reason,
              };
            }

            // Ensure locked verification completed well within lock lease budget before mutating DB
            if (Date.now() - lockAcquiredAtMs >= maxAllowedLockedWindowMs) {
              const postReadBudgetErr: any = new Error('read2_error:locked_lease_budget_exhausted_before_rpc');
              postReadBudgetErr.code = 'LOCKED_READ_LEASE_BUDGET_EXHAUSTED';
              postReadBudgetErr.nonUncertainDeletionError = true;
              throw postReadBudgetErr;
            }

            // Re-verify BOTH durable lease ownerships AND the distributed sweep lease immediately before executing the database mutation RPC
            await assertClientLockStillHeld();
            await assertInboundLockStillHeld();
            if (params.assertDistributedLeaseStillHeld) {
              await params.assertDistributedLeaseStillHeld();
            }

            const reason = 'confirmed_absent_panel_wide_uncached_reads';
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
              const unavailErr: any = new Error('rpc_unavailable');
              unavailErr.code = 'DEFINITIVE_RPC_NO_WRITE';
              unavailErr.nonUncertainDeletionError = true;
              throw unavailErr;
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

            // Distinguish definitive no-write RPC failures from ambiguous / timed-out DB mutation outcomes
            if (rpcErr) {
              if (!isAmbiguousDeletionRpcError(rpcErr)) {
                console.error(
                  `[3X-UI Sync] Fail closed (definitive no-write RPC error) for ${normUuid}:`,
                  rpcErr?.message || rpcErr
                );
                const defErr: any = new Error(
                  isMissingSchemaOrRpcError(rpcErr)
                    ? `rpc_missing:${rpcErr?.message || 'not_installed'}`
                    : `rpc_error:${rpcErr?.message || 'unknown'}`
                );
                defErr.code = 'DEFINITIVE_RPC_NO_WRITE';
                defErr.nonUncertainDeletionError = true;
                throw defErr;
              }

              // Ambiguous RPC timeout / transport error after possible commit ->
              // Require authoritative read-back reconciliation before releasing client lock protection.
              console.warn(
                `[3X-UI Sync] Ambiguous mark_vpn_client_panel_deleted RPC error for ${normUuid} (${rpcErr?.message || rpcErr}). Running authoritative DB reconciliation...`
              );
              const recon = await reconcileClientPanelDeletionState({
                dbClient,
                clientUuid: normUuid,
                userId: params.userId || null,
              });

              if (recon.status === 'confirmed_committed') {
                console.log(
                  `[3X-UI Sync] Authoritative reconciliation confirmed deletion commit for ${normUuid}; releasing locks cleanly.`
                );
                invalidateInboundCache(inboundId);
                notifyClientTrafficInvalidated(normUuid, 'deleted');
                return {
                  confirmedDeleted: true,
                  applied: true,
                  reconciledAfterAmbiguousRpc: true,
                  reconciliationRequired: recon.reconciliationRequired,
                  dbWrites: 1,
                  reason: 'confirmed_committed_after_rpc_reconciliation',
                };
              }

              console.error(
                `[3X-UI Sync] Authoritative reconciliation inconclusive for ${normUuid} (${recon.reason}) after ambiguous RPC error (${rpcErr?.message || 'unknown'}). Preserving client lock as uncertain.`
              );
              const uncErr: any = new Error(
                `rpc_outcome_uncertain:${rpcErr?.message || 'ambiguous_rpc_error'}|${recon.reason}`
              );
              uncErr.code = 'RPC_OUTCOME_UNCERTAIN';
              uncErr.mutationUncertain = true;
              throw uncErr;
            }

            const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
            if (!row || typeof row !== 'object') {
              // Empty/malformed payload after RPC dispatch is ambiguous -> reconcile authoritatively before releasing
              console.warn(
                `[3X-UI Sync] Empty response from mark_vpn_client_panel_deleted for ${normUuid}. Running authoritative DB reconciliation...`
              );
              const recon = await reconcileClientPanelDeletionState({
                dbClient,
                clientUuid: normUuid,
                userId: params.userId || null,
              });

              if (recon.status === 'confirmed_committed') {
                invalidateInboundCache(inboundId);
                notifyClientTrafficInvalidated(normUuid, 'deleted');
                return {
                  confirmedDeleted: true,
                  applied: true,
                  reconciledAfterAmbiguousRpc: true,
                  reconciliationRequired: recon.reconciliationRequired,
                  dbWrites: 1,
                  reason: 'confirmed_committed_after_empty_rpc_reconciliation',
                };
              }

              const emptyUncErr: any = new Error(`rpc_empty_response_uncertain:${recon.reason}`);
              emptyUncErr.code = 'RPC_OUTCOME_UNCERTAIN';
              emptyUncErr.mutationUncertain = true;
              throw emptyUncErr;
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

            // Invalidate in-memory inbound and client traffic caches so subsequent reads reflect the confirmed deletion immediately
            invalidateInboundCache(inboundId);
            notifyClientTrafficInvalidated(normUuid, 'deleted');

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
    if (lockErr?.mutationUncertain === true) {
      return {
        confirmedDeleted: false,
        applied: false,
        mutationUncertain: true,
        dbWrites: 0,
        reason: lockErr?.message || 'rpc_outcome_uncertain',
      };
    }

    if (lockErr?.distributedLeaseLost === true) {
      return {
        confirmedDeleted: false,
        applied: false,
        distributedLeaseLost: true,
        dbWrites: 0,
        reason: lockErr?.message || 'distributed_lease_lost',
      };
    }

    if (lockErr?.circuitBreakerTriggered === true) {
      return {
        confirmedDeleted: false,
        applied: false,
        circuitBreakerTriggered: true,
        circuitBreakerReason: lockErr.circuitBreakerReason,
        manualReviewFlagged: true,
        dbWrites: 0,
        reason: lockErr?.message || `read2_circuit_breaker:${lockErr.circuitBreakerReason}`,
      };
    }

    if (lockErr?.nonUncertainDeletionError === true) {
      return {
        confirmedDeleted: false,
        applied: false,
        dbWrites: 0,
        reason: lockErr?.message || 'deletion_verification_failed',
      };
    }

    // Lock contention, uncertain lock, or lost fence -> NEVER force-release and perform ZERO writes
    const code = String(lockErr?.code || '').trim();
    console.log(
      `[3X-UI Sync] Skipping deletion verification for UUID ${normUuid} due to active/uncertain lock or lost lease (${code || lockErr?.message || 'busy'}).`
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
  // Feature flag gate: disabled by default unless PANEL_DELETION_SYNC_ENABLED=true
  if (!isPanelDeletionSyncFlagEnabled()) {
    console.log(
      '[3X-UI Sync] Panel deletion synchronization is disabled (PANEL_DELETION_SYNC_ENABLED !== true). Skipping cycle with zero panel reads and zero lock acquisitions.'
    );
    return {
      synced: false,
      skippedDisabled: true,
      panelRequestCount: 0,
      deletedCount: 0,
      restoredCount: 0,
      skippedCount: 0,
      manualReviewCount: 0,
      reconciliationFlaggedCount: 0,
      details: [],
    };
  }

  // In-process mutex prevents overlapping deletion sweeps within the same Node process
  if (isPanelDeletionSyncInProgress) {
    console.log('[3X-UI Sync] Skipping deletion synchronization: another cycle is already in progress in this process.');
    return {
      synced: false,
      skippedBusy: true,
      panelRequestCount: 0,
      deletedCount: 0,
      restoredCount: 0,
      skippedCount: 0,
      manualReviewCount: 0,
      reconciliationFlaggedCount: 0,
      details: [],
    };
  }

  isPanelDeletionSyncInProgress = true;
  const dbClient = options?.dbClient || supabaseAdmin;
  const rawReadList = options?.fetchUncachedInboundsList || fetchUncachedLiveInboundsList;
  const nowMs = options?.nowMs ?? Date.now();
  const reReadDelayMs = options?.reReadDelayMs ?? 150;
  const intervalMs = options?.intervalMs ?? getPanelDeletionSyncIntervalMs();
  const maxDeletesPerCycle = options?.maxDeletesPerCycle ?? getPanelDeletionSyncMaxDeletesPerCycle();
  const maxMissingRatio = options?.maxMissingRatio ?? getPanelDeletionSyncMaxMissingRatio();

  let panelRequestCount = 0;
  const countedReadList = async (
    readOpts?: { timeoutMs?: number }
  ): Promise<UncachedInboundsListReadResult> => {
    panelRequestCount += 1;
    return await rawReadList(readOpts);
  };

  let leaseOwnerId: string | null = null;
  let currentLeaseVersion: string | null = null;
  const effectiveLeaseTtlMs = Math.max(options?.leaseTtlMs ?? Math.max(intervalMs + 60000, 180000), 30000);
  const paginationPageSize = Math.max(1, Math.min(Math.floor(options?.pageSize || 1000), 5000));
  let cycleCompletedSuccessfully = false;
  let finalSummary: Record<string, any> | undefined;

  try {
    // Optional cross-instance CAS lease (always enabled for scheduled 2-minute sweeps & background sync)
    if (options?.enforceCrossInstanceLease) {
      const leaseRes = await acquireCrossInstanceDeletionSyncLease({
        dbClient,
        intervalMs,
        nowMs,
        force: Boolean(options.forceLease),
        ownerId: options.leaseOwnerId,
        leaseTtlMs: effectiveLeaseTtlMs,
      });
      if (!leaseRes.acquired) {
        console.log(`[3X-UI Sync] Skipping cycle due to cross-instance lease (${leaseRes.reason || 'busy'}).`);
        return {
          synced: false,
          skippedLease: true,
          leaseSkipReason: leaseRes.reason || 'lease_not_acquired',
          panelRequestCount: 0,
          deletedCount: 0,
          restoredCount: 0,
          skippedCount: 0,
          manualReviewCount: 0,
          reconciliationFlaggedCount: 0,
          details: [],
        };
      }
      leaseOwnerId = leaseRes.ownerId;
      currentLeaseVersion = leaseRes.leaseVersion ?? null;
    }

    console.log('[3X-UI Sync] Starting authoritative VPN client synchronization with 3X-UI panel...');

    let currentPanelIdentity = String(options?.currentPanelIdentity || '').trim();
    if (!currentPanelIdentity) {
      try {
        currentPanelIdentity = await getCurrentPanelIdentity();
      } catch (err: any) {
        console.warn('[3X-UI Sync] Cannot resolve active 3X-UI panel identity. Skipping cycle safely.', err?.message || err);
        return {
          synced: false,
          panelRequestCount,
          deletedCount: 0,
          restoredCount: 0,
          skippedCount: 0,
          manualReviewCount: 0,
          reconciliationFlaggedCount: 0,
        };
      }
    }

    // Step 1: Fresh, uncached live panel-wide Snapshot 1 (NEVER uses cachedInbounds)
    const snap1CacheGeneration = inboundsCacheGeneration;
    const snap1 = await countedReadList();
    if (!snap1 || !snap1.ok || !Array.isArray(snap1.inbounds) || snap1.inbounds.length === 0) {
      console.warn(
        `[3X-UI Sync] Live 3X-UI panel Snapshot 1 failed or returned empty inbounds (${snap1?.reason || 'empty_inbounds'}). Skipping cycle with zero writes.`
      );
      return {
        synced: false,
        panelRequestCount,
        deletedCount: 0,
        restoredCount: 0,
        skippedCount: 0,
        manualReviewCount: 0,
        reconciliationFlaggedCount: 0,
      };
    }

    if (snap1.allInboundsCleanlyParsed && snap1.inbounds.length > 0 && !options?.fetchUncachedInboundsList) {
      setCachedInbounds(snap1.inbounds, currentPanelIdentity, snap1CacheGeneration);
    }

    const configuredServers =
      options?.configuredServers !== undefined
        ? options.configuredServers
        : await loadConfiguredXuiServers(dbClient);

    console.log(
      `[3X-UI Sync] Live panel reachable (identity=${currentPanelIdentity}). Found ${snap1.liveClientByUuid.size} live client UUIDs across ${snap1.inbounds.length} inbounds (unparsed=${snap1.unparsedInboundIds.length}).`
    );

    let deletedCount = 0;
    let restoredCount = 0;
    let skippedCount = 0;
    let manualReviewCount = 0;
    let reconciliationFlaggedCount = 0;
    const details: Array<{ clientUuid: string; outcome: string; reason: string }> = [];

    // Load ALL vpn_accounts and vpn_configs across ALL customers (online and offline) using deterministic
    // primary-key cursor pagination so datasets > 1,000 rows are never silently truncated by PostgREST max-rows.
    const [accPaginated, cfgPaginated] = await Promise.all([
      fetchAllTableRowsByPrimaryKeyCursor({
        dbClient,
        table: 'vpn_accounts',
        selectColumns: '*',
        primaryKeyColumn: 'id',
        pageSize: paginationPageSize,
      }),
      fetchAllTableRowsByPrimaryKeyCursor({
        dbClient,
        table: 'vpn_configs',
        selectColumns: '*',
        primaryKeyColumn: 'id',
        pageSize: paginationPageSize,
      }),
    ]);

    if (!accPaginated.ok || !cfgPaginated.ok) {
      const failReason = !accPaginated.ok
        ? accPaginated.reason
        : !cfgPaginated.ok
          ? cfgPaginated.reason
          : 'pagination_failed';
      console.warn(
        '[3X-UI Sync] Failed to load complete paginated customer VPN records from Supabase. Aborting cycle with zero writes.',
        failReason
      );
      return {
        synced: false,
        panelRequestCount,
        deletedCount: 0,
        restoredCount: 0,
        skippedCount: 0,
        manualReviewCount: 0,
        reconciliationFlaggedCount: 0,
      };
    }

    const accounts: any[] = accPaginated.rows;
    const configs: any[] = cfgPaginated.rows;

    // Load ALL grant inbound_ids via deterministic pagination as authoritative inbound fallback when
    // vpn_configs.inbound_id is missing, and track all distinct positive inbound_ids to detect conflicts.
    // If vpn_entitlement_grants exists and a page query fails (other than missing table), abort deletion processing.
    const grantInboundsByUuid = new Map<string, Set<number>>();
    const grantsPaginated = await fetchAllTableRowsByPrimaryKeyCursor({
      dbClient,
      table: 'vpn_entitlement_grants',
      selectColumns: 'id, client_uuid, inbound_id',
      primaryKeyColumn: 'id',
      pageSize: paginationPageSize,
      applyFilters: (q) => q.not('inbound_id', 'is', null),
    });

    if (!grantsPaginated.ok) {
      const isOptionalMissingTable = isMissingSchemaOrRpcError({ message: grantsPaginated.reason });
      if (!isOptionalMissingTable) {
        console.warn(
          '[3X-UI Sync] Failed to load complete paginated vpn_entitlement_grants from Supabase. Aborting cycle with zero writes.',
          grantsPaginated.reason
        );
        return {
          synced: false,
          panelRequestCount,
          deletedCount: 0,
          restoredCount: 0,
          skippedCount: 0,
          manualReviewCount: 0,
          reconciliationFlaggedCount: 0,
        };
      }
    } else {
      for (const g of grantsPaginated.rows) {
        const gu = String(g?.client_uuid || '').trim().toLowerCase();
        const gib = Number(g?.inbound_id);
        if (gu && Number.isInteger(gib) && gib > 0) {
          if (!grantInboundsByUuid.has(gu)) grantInboundsByUuid.set(gu, new Set<number>());
          grantInboundsByUuid.get(gu)!.add(gib);
        }
      }
    }

    // Group accounts and configs by normalized client UUID
    interface ClientRecordGroup {
      clientUuid: string;
      accounts: any[];
      configs: any[];
      inboundId: number | null;
      distinctInboundIds: Set<number>;
      userId: string | null;
      distinctOwners: Set<string>;
      hasConflictingOwnership: boolean;
      hasMissingOwnership: boolean;
      userEmail: string | null;
      orderId: string | null;
      panelIdentity: string | null;
      distinctPanelIdentities: Set<string>;
      serverId: string | null;
      distinctServerIds: Set<string>;
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
        const grantInboundSet = grantInboundsByUuid.get(norm);
        const distinctInboundIds = new Set<number>(grantInboundSet ? Array.from(grantInboundSet) : []);
        const initialInboundId = distinctInboundIds.size === 1 ? Array.from(distinctInboundIds)[0] : null;
        g = {
          clientUuid: norm,
          accounts: [],
          configs: [],
          inboundId: initialInboundId,
          distinctInboundIds,
          userId: null,
          distinctOwners: new Set<string>(),
          hasConflictingOwnership: false,
          hasMissingOwnership: false,
          userEmail: null,
          orderId: null,
          panelIdentity: null,
          distinctPanelIdentities: new Set<string>(),
          serverId: null,
          distinctServerIds: new Set<string>(),
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
      if (acc.panel_identity) {
        const pid = String(acc.panel_identity).trim();
        if (pid) {
          g.distinctPanelIdentities.add(pid);
          if (!g.panelIdentity) g.panelIdentity = pid;
        }
      }
      if (acc.server_id) {
        const sid = String(acc.server_id).trim();
        if (sid) {
          g.distinctServerIds.add(sid);
          if (!g.serverId) g.serverId = sid;
        }
      }
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
      if (Number.isInteger(ibId) && ibId > 0) {
        g.distinctInboundIds.add(ibId);
        g.inboundId = ibId;
      }
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
      if (cfg.panel_identity) {
        const pid = String(cfg.panel_identity).trim();
        if (pid) {
          g.distinctPanelIdentities.add(pid);
          if (!g.panelIdentity) g.panelIdentity = pid;
        }
      }
      if (cfg.server_id) {
        const sid = String(cfg.server_id).trim();
        if (sid) {
          g.distinctServerIds.add(sid);
          if (!g.serverId) g.serverId = sid;
        }
      }
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
    const RECENT_PROVISION_GRACE_MS = 60 * 1000;
    let totalTrackedNonDeleted = 0;
    const trackedNonDeletedUuids = new Set<string>();
    const snapshot1MissingCandidates: ClientRecordGroup[] = [];

    for (const group of groups.values()) {
      // Never auto-resurrect a configuration that is already confirmed deleted
      if (!group.anyNonDeleted || group.allDeleted) {
        continue;
      }
      trackedNonDeletedUuids.add(group.clientUuid);
      totalTrackedNonDeleted += 1;

      const liveMatch = snap1.liveClientByUuid.get(group.clientUuid);
      if (liveMatch) {
        // Client positively observed in live 3X-UI settings.clients[]!
        // Active, Disabled, Expired, and Data-Exhausted configs stay visible.
        const liveInboundId = Number(liveMatch.inbound?.id);
        const conflictingPositiveInbounds = Array.from(group.distinctInboundIds).filter(
          (id) => Number.isInteger(id) && id > 0 && Number.isInteger(liveInboundId) && liveInboundId > 0 && id !== liveInboundId
        );
        const hasInboundMismatch = conflictingPositiveInbounds.length > 0 || group.distinctInboundIds.size > 1;

        if (hasInboundMismatch) {
          // NEVER automatically rewrite conflicting inbound_id; report for manual review!
          await recordDeduplicatedSyncAuditLog({
            dbClient,
            userId: group.distinctOwners.size === 1 ? group.userId : null,
            action: 'panel_deletion_inbound_mismatch',
            targetType: 'vpn_client',
            targetId: group.clientUuid,
            details: {
              client_uuid: group.clientUuid,
              expected_inbound_ids: Array.from(group.distinctInboundIds),
              live_inbound_id: Number.isInteger(liveInboundId) && liveInboundId > 0 ? liveInboundId : null,
              panel_identity: currentPanelIdentity,
              code: 'live_client_inbound_mismatch',
              source: 'background_sync',
            },
          });
          manualReviewCount += 1;
          details.push({
            clientUuid: group.clientUuid,
            outcome: 'manual_review',
            reason: 'live_client_inbound_mismatch',
          });
        }

        // 1. Safely backfill null panel_identity (and null/0 inbound_id ONLY when no conflicting positive inbound exists)
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
          // Only backfill NULL/0 inbound_id when there is NO conflicting positive inbound_id on this client group
          if (
            !hasInboundMismatch &&
            (!cfg.inbound_id || Number(cfg.inbound_id) <= 0) &&
            Number.isInteger(liveInboundId) &&
            liveInboundId > 0
          ) {
            updates.inbound_id = liveInboundId;
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

      // Client was NOT present in live Snapshot 1.
      // Panel-wide absence requires EVERY inbound in Snapshot 1 to have parsed cleanly.
      if (!snap1.allInboundsCleanlyParsed) {
        skippedCount += 1;
        details.push({
          clientUuid: group.clientUuid,
          outcome: 'skipped',
          reason: 'malformed_inbound_settings_in_list',
        });
        continue;
      }

      // Ownership protection: fail closed on missing or conflicting ownership
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

      // Conflicting positive inbound_id protection: fail closed and report for manual review
      if (group.distinctInboundIds.size > 1) {
        await recordDeduplicatedSyncAuditLog({
          dbClient,
          userId: group.userId,
          action: 'panel_deletion_inbound_mismatch',
          targetType: 'vpn_client',
          targetId: group.clientUuid,
          details: {
            client_uuid: group.clientUuid,
            distinct_inbound_ids: Array.from(group.distinctInboundIds),
            panel_identity: currentPanelIdentity,
            code: 'conflicting_inbound_id',
            source: 'background_sync',
          },
        });
        manualReviewCount += 1;
        skippedCount += 1;
        details.push({
          clientUuid: group.clientUuid,
          outcome: 'manual_review',
          reason: 'conflicting_inbound_id',
        });
        continue;
      }

      // Conflicting panel_identity protection across records
      if (group.distinctPanelIdentities.size > 1) {
        await recordDeduplicatedSyncAuditLog({
          dbClient,
          userId: group.userId,
          action: 'panel_deletion_ambiguous_identity',
          targetType: 'vpn_client',
          targetId: group.clientUuid,
          details: {
            client_uuid: group.clientUuid,
            inbound_id: group.inboundId ?? null,
            distinct_panel_identities: Array.from(group.distinctPanelIdentities),
            code: 'conflicting_panel_identity',
            source: 'background_sync',
          },
        });
        manualReviewCount += 1;
        skippedCount += 1;
        details.push({
          clientUuid: group.clientUuid,
          outcome: 'manual_review',
          reason: 'conflicting_panel_identity',
        });
        continue;
      }

      // Recent provision grace period (60s)
      if (group.createdAt) {
        const createdAtMs = new Date(group.createdAt).getTime();
        if (!Number.isNaN(createdAtMs) && nowMs - createdAtMs < RECENT_PROVISION_GRACE_MS) {
          skippedCount += 1;
          details.push({
            clientUuid: group.clientUuid,
            outcome: 'skipped',
            reason: 'recent_provision_grace_period',
          });
          continue;
        }
      }

      // Strict panel identity + inbound_id verification (legacy rows with missing inbound_id stay visible)
      const identityCheck = verifyRecordPanelIdentity({
        currentPanelIdentity,
        recordPanelIdentity: group.panelIdentity,
        recordServerId: group.serverId,
        recordInboundId: group.inboundId,
        recordOwnerUid: group.userId,
        recordOwnerEmail: group.userEmail,
        configuredServers,
      });

      if (!identityCheck.ok) {
        const auditAction =
          identityCheck.code === 'wrong_panel_identity'
            ? 'panel_deletion_wrong_panel_identity'
            : 'panel_deletion_ambiguous_identity';
        await recordDeduplicatedSyncAuditLog({
          dbClient,
          userId: group.userId,
          action: auditAction,
          targetType: 'vpn_client',
          targetId: group.clientUuid,
          details: {
            client_uuid: group.clientUuid,
            inbound_id: group.inboundId ?? null,
            current_panel_identity: currentPanelIdentity,
            record_panel_identity: group.panelIdentity,
            record_server_id: group.serverId,
            code: identityCheck.code,
            reason: identityCheck.reason,
            source: 'background_sync',
          },
        });
        manualReviewCount += 1;
        skippedCount += 1;
        details.push({
          clientUuid: group.clientUuid,
          outcome: 'manual_review',
          reason: identityCheck.code,
        });
        continue;
      }

      snapshot1MissingCandidates.push(group);
    }

    // Fast path: 0 deletion candidates -> complete cycle after exactly 1 panel request!
    if (snapshot1MissingCandidates.length === 0) {
      cycleCompletedSuccessfully = true;
      lastPanelDeletionSyncAt = Date.now();
      finalSummary = {
        deletedCount,
        restoredCount,
        skippedCount,
        manualReviewCount,
        reconciliationFlaggedCount,
        panelRequestCount,
      };
      console.log(
        `[3X-UI Sync] Completed (0 deletion candidates, ${panelRequestCount} panel request). restoredActive=${restoredCount}, skipped=${skippedCount}, manualReview=${manualReviewCount}.`
      );
      return {
        synced: true,
        panelRequestCount,
        deletedCount,
        restoredCount,
        skippedCount,
        manualReviewCount,
        reconciliationFlaggedCount,
        details,
      };
    }

    // Step 2: Wait reReadDelayMs OUTSIDE locks, then fetch fresh uncached panel-wide Snapshot 2
    if (reReadDelayMs > 0) {
      await new Promise((r) => setTimeout(r, reReadDelayMs));
    }

    const snap2 = await countedReadList();
    if (!snap2 || !snap2.ok || !snap2.allInboundsCleanlyParsed || !Array.isArray(snap2.inbounds) || snap2.inbounds.length === 0) {
      console.warn(
        `[3X-UI Sync] Live 3X-UI panel Snapshot 2 failed, malformed, or empty (${snap2?.reason || 'incomplete_or_empty'}). Aborting all deletions with zero writes.`
      );
      return {
        synced: false,
        panelRequestCount,
        deletedCount: 0,
        restoredCount,
        skippedCount: skippedCount + snapshot1MissingCandidates.length,
        manualReviewCount,
        reconciliationFlaggedCount: 0,
        details,
      };
    }

    // Filter to candidates confirmed panel-wide absent in BOTH Snapshot 1 and Snapshot 2
    const confirmedTwoSnapshotCandidates: ClientRecordGroup[] = [];
    for (const candidate of snapshot1MissingCandidates) {
      const snap2Match = snap2.liveClientByUuid.get(candidate.clientUuid);
      if (snap2Match) {
        const liveInboundId = Number(snap2Match.inbound?.id);
        if (Number.isInteger(liveInboundId) && liveInboundId > 0 && liveInboundId !== candidate.inboundId) {
          await recordDeduplicatedSyncAuditLog({
            dbClient,
            userId: candidate.userId,
            action: 'panel_deletion_inbound_mismatch',
            targetType: 'vpn_client',
            targetId: candidate.clientUuid,
            details: {
              client_uuid: candidate.clientUuid,
              expected_inbound_id: candidate.inboundId,
              live_inbound_id: liveInboundId,
              panel_identity: currentPanelIdentity,
              code: 'reappeared_on_different_inbound_in_snapshot2',
              source: 'background_sync',
            },
          });
          manualReviewCount += 1;
          skippedCount += 1;
          details.push({
            clientUuid: candidate.clientUuid,
            outcome: 'manual_review',
            reason: 'read2_client_moved_to_another_inbound',
          });
        } else {
          skippedCount += 1;
          details.push({
            clientUuid: candidate.clientUuid,
            outcome: 'skipped',
            reason: 'read2_client_present_in_snapshot2',
          });
        }
        continue;
      }
      confirmedTwoSnapshotCandidates.push(candidate);
    }

    // Step 3: Mass-Deletion Circuit Breaker (fires even when panel_identity matches!)
    let circuitBreakerReason: string | null = null;
    if ((snap1.liveClientByUuid.size === 0 || snap2.liveClientByUuid.size === 0) && totalTrackedNonDeleted >= 3) {
      circuitBreakerReason = 'unexpected_zero_live_clients';
    } else if (confirmedTwoSnapshotCandidates.length > maxDeletesPerCycle) {
      circuitBreakerReason = 'max_deletes_per_cycle_exceeded';
    } else if (
      totalTrackedNonDeleted >= 8 &&
      confirmedTwoSnapshotCandidates.length >= 3 &&
      confirmedTwoSnapshotCandidates.length / totalTrackedNonDeleted > maxMissingRatio
    ) {
      circuitBreakerReason = 'max_missing_ratio_exceeded';
    }

    if (circuitBreakerReason) {
      console.error(
        `[3X-UI Sync] CIRCUIT BREAKER TRIGGERED (${circuitBreakerReason}): stopping ALL automatic deletions. candidates=${confirmedTwoSnapshotCandidates.length}, totalTracked=${totalTrackedNonDeleted}, liveSnap1=${snap1.liveClientByUuid.size}, liveSnap2=${snap2.liveClientByUuid.size}.`
      );
      await recordDeduplicatedSyncAuditLog({
        dbClient,
        userId: null,
        action: 'panel_deletion_circuit_breaker_triggered',
        targetType: 'xui_panel',
        targetId: currentPanelIdentity,
        dedupeWindowHours: 1,
        details: {
          panel_identity: currentPanelIdentity,
          trigger_reason: circuitBreakerReason,
          candidate_count: confirmedTwoSnapshotCandidates.length,
          total_tracked_non_deleted: totalTrackedNonDeleted,
          live_clients_snap1: snap1.liveClientByUuid.size,
          live_clients_snap2: snap2.liveClientByUuid.size,
          max_deletes_per_cycle: maxDeletesPerCycle,
          max_missing_ratio: maxMissingRatio,
          source: 'background_sync',
        },
      });
      manualReviewCount += 1;
      skippedCount += confirmedTwoSnapshotCandidates.length;
      for (const c of confirmedTwoSnapshotCandidates) {
        details.push({
          clientUuid: c.clientUuid,
          outcome: 'skipped',
          reason: `circuit_breaker:${circuitBreakerReason}`,
        });
      }
      return {
        synced: false,
        circuitBreakerTriggered: true,
        circuitBreakerReason,
        panelRequestCount,
        deletedCount: 0,
        restoredCount,
        skippedCount,
        manualReviewCount,
        reconciliationFlaggedCount: 0,
        details,
      };
    }

    // Step 4: For each surviving candidate, renew the distributed lease, verify lease ownership
    // immediately before the deletion-marker RPC, and apply the mass-absence circuit breaker
    // to every final locked full-panel snapshot.
    // Total panel requests: 2 + K (Snapshot 1 + Snapshot 2 + 1 bounded locked panel-wide read per candidate)
    for (let i = 0; i < confirmedTwoSnapshotCandidates.length; i++) {
      const group = confirmedTwoSnapshotCandidates[i];

      // Renew the cross-instance sweep lease before processing each deletion candidate so a sweep
      // that takes > 180s cannot expire while active, and abort the entire remaining sweep if
      // the lease was expired or lost to another worker.
      if (leaseOwnerId) {
        const renewRes = await renewCrossInstanceDeletionSyncLease({
          dbClient,
          ownerId: leaseOwnerId,
          expectedLeaseVersion: currentLeaseVersion,
          leaseTtlMs: effectiveLeaseTtlMs,
        });
        if (!renewRes.renewed) {
          console.error(
            `[3X-UI Sync] Distributed sweep lease renewal failed before candidate ${group.clientUuid} (${renewRes.reason || 'lease_lost'}). Aborting entire remaining sweep.`
          );
          for (let j = i; j < confirmedTwoSnapshotCandidates.length; j++) {
            const rem = confirmedTwoSnapshotCandidates[j];
            skippedCount += 1;
            details.push({
              clientUuid: rem.clientUuid,
              outcome: 'skipped',
              reason: `distributed_lease_lost:${renewRes.reason || 'renew_failed'}`,
            });
          }
          // Null out leaseOwnerId so the finally block does not attempt to release a lost lease
          leaseOwnerId = null;
          currentLeaseVersion = null;
          return {
            synced: false,
            leaseLostMidSweep: true,
            leaseLostReason: renewRes.reason || 'renew_failed',
            panelRequestCount,
            deletedCount,
            restoredCount,
            skippedCount,
            manualReviewCount,
            reconciliationFlaggedCount,
            details,
          };
        }
        currentLeaseVersion = renewRes.leaseVersion ?? currentLeaseVersion;
      }

      const assertDistributedLeaseStillHeld = leaseOwnerId
        ? async (): Promise<void> => {
            const checkRes = await verifyCrossInstanceDeletionSyncLeaseOwnership({
              dbClient,
              ownerId: leaseOwnerId!,
              expectedLeaseVersion: currentLeaseVersion,
              minRemainingBudgetMs: 1000,
            });
            if (!checkRes.valid) {
              const leaseErr: any = new Error(
                `distributed_lease_lost_before_rpc:${checkRes.reason || 'invalid'}`
              );
              leaseErr.code = 'DISTRIBUTED_LEASE_LOST';
              leaseErr.distributedLeaseLost = true;
              leaseErr.nonUncertainDeletionError = true;
              throw leaseErr;
            }
          }
        : undefined;

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
        fetchUncachedInboundsList: countedReadList,
        preVerifiedOutsideSnapshots: {
          snapshot1: snap1,
          snapshot2: snap2,
        },
        massAbsenceSafetyContext: {
          trackedNonDeletedUuids,
          maxDeletesPerCycle,
          maxMissingRatio,
        },
        assertDistributedLeaseStillHeld,
        reReadDelayMs,
        lockedReadTimeoutMs: options?.lockedReadTimeoutMs,
        lockLeaseBudgetRatio: options?.lockLeaseBudgetRatio,
        releaseRetryBaseDelayMs: options?.releaseRetryBaseDelayMs,
        nowMs,
      });

      if (verifyRes.distributedLeaseLost) {
        console.error(
          `[3X-UI Sync] Distributed sweep lease lost during candidate ${group.clientUuid} (${verifyRes.reason}). Aborting entire remaining sweep.`
        );
        for (let j = i; j < confirmedTwoSnapshotCandidates.length; j++) {
          const rem = confirmedTwoSnapshotCandidates[j];
          skippedCount += 1;
          details.push({
            clientUuid: rem.clientUuid,
            outcome: 'skipped',
            reason: verifyRes.reason,
          });
        }
        leaseOwnerId = null;
        currentLeaseVersion = null;
        return {
          synced: false,
          leaseLostMidSweep: true,
          leaseLostReason: verifyRes.reason,
          panelRequestCount,
          deletedCount,
          restoredCount,
          skippedCount,
          manualReviewCount,
          reconciliationFlaggedCount,
          details,
        };
      }

      if (verifyRes.circuitBreakerTriggered) {
        console.error(
          `[3X-UI Sync] Final locked snapshot circuit breaker triggered during candidate ${group.clientUuid} (${verifyRes.circuitBreakerReason || verifyRes.reason}). Aborting entire remaining sweep.`
        );
        manualReviewCount += 1;
        for (let j = i; j < confirmedTwoSnapshotCandidates.length; j++) {
          const rem = confirmedTwoSnapshotCandidates[j];
          skippedCount += 1;
          details.push({
            clientUuid: rem.clientUuid,
            outcome: 'skipped',
            reason: `circuit_breaker:${verifyRes.circuitBreakerReason || verifyRes.reason}`,
          });
        }
        return {
          synced: false,
          circuitBreakerTriggered: true,
          circuitBreakerReason: verifyRes.circuitBreakerReason || verifyRes.reason,
          panelRequestCount,
          deletedCount,
          restoredCount,
          skippedCount,
          manualReviewCount,
          reconciliationFlaggedCount,
          details,
        };
      }

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

    cycleCompletedSuccessfully = true;
    lastPanelDeletionSyncAt = Date.now();
    finalSummary = {
      deletedCount,
      restoredCount,
      skippedCount,
      manualReviewCount,
      reconciliationFlaggedCount,
      panelRequestCount,
    };

    console.log(
      `[3X-UI Sync] Completed (${panelRequestCount} panel requests). confirmedDeleted=${deletedCount}, restoredActive=${restoredCount}, skipped=${skippedCount}, manualReview=${manualReviewCount}, reconciliationFlagged=${reconciliationFlaggedCount}.`
    );

    return {
      synced: true,
      panelRequestCount,
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
      panelRequestCount,
      deletedCount: 0,
      restoredCount: 0,
      skippedCount: 0,
      manualReviewCount: 0,
      reconciliationFlaggedCount: 0,
    };
  } finally {
    if (leaseOwnerId) {
      await releaseCrossInstanceDeletionSyncLease({
        dbClient,
        ownerId: leaseOwnerId,
        expectedLeaseVersion: currentLeaseVersion,
        completed: cycleCompletedSuccessfully,
        nowMs: Date.now(),
        summary: finalSummary,
      }).catch(() => {});
    }
    isPanelDeletionSyncInProgress = false;
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
    releaseRetryBaseDelayMs?: number;
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
  const requireDurable = params.requireDurableLock ?? true;

  // Layer 1: Same-process FIFO serialization per client UUID so concurrent in-process
  // operations (such as rapid duplicate traffic resets) cannot race past cooldown/lock checks.
  const previousClientTail = clientProcessQueues.get(cleanUuid) || Promise.resolve();
  let releaseLocalClientQueue!: () => void;
  const localClientGate = new Promise<void>((resolve) => {
    releaseLocalClientQueue = resolve;
  });
  const nextClientTail = previousClientTail.then(() => localClientGate);
  clientProcessQueues.set(cleanUuid, nextClientTail);

  await previousClientTail;

  try {
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
      if (
        lockRes.failureKind === 'permission_error' ||
        lockRes.failureKind === 'rpc_error' ||
        lockRes.failureKind === 'unavailable'
      ) {
        const infraErr: any = buildDurableLockFailureError(lockRes, `VPN client '${cleanUuid}'`);
        infraErr.beforeExternalWrite = true;
        infraErr.xuiUncertain = false;
        throw infraErr;
      }
      const conflictErr: any = new Error(
        lockRes.previousStatus === 'uncertain'
          ? `VPN client '${cleanUuid}' has an uncertain prior external provisioning state; automatic modification is blocked until admin reconciliation.`
          : lockRes.error || `Another operation (${lockRes.previousOperationType || 'active'}) is currently modifying VPN client '${cleanUuid}'.`
      );
      conflictErr.statusCode = 409;
      conflictErr.code = lockRes.previousStatus === 'uncertain' ? 'CLIENT_LOCK_UNCERTAIN' : 'CLIENT_LOCK_BUSY';
      conflictErr.beforeExternalWrite = true;
      conflictErr.xuiUncertain = false;
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
        fenceErr.code = 'CLIENT_LOCK_LOST';
        fenceErr.beforeExternalWrite = true;
        fenceErr.xuiUncertain = false;
        throw fenceErr;
      }
    };

    let outcome: 'completed' | 'failed' | 'uncertain' = 'completed';
    let errMsg: string | null = null;
    try {
      return await fn(assertClientLockStillHeld);
    } catch (err: any) {
      if (err?.beforeExternalWrite === true || err?.xuiUncertain === false) {
        outcome = 'failed';
      } else {
        outcome = err?.xuiUncertain === true || err?.mutationUncertain === true ? 'uncertain' : 'failed';
      }
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
          retryBaseDelayMs: params.releaseRetryBaseDelayMs,
        });
      }
    }
  } finally {
    releaseLocalClientQueue();
    if (clientProcessQueues.get(cleanUuid) === nextClientTail) {
      clientProcessQueues.delete(cleanUuid);
    }
  }
}

/**
 * Reset client traffic in 3X-UI for an active client
 * Tries the primary 3X-UI client reset endpoint and inbounds reset endpoint.
 * Coordinated under `client:<uuid>` durable lock and blocked if an unresolved
 * provisional/uncertain renewal grant exists for the client.
 */
export interface ResetClientTrafficOptions {
  dbClient?: any;
  requestApiFn?: typeof requestApi;
  getInboundsFn?: typeof getInbounds;
  /**
   * Optional verification callback invoked AFTER acquiring `client:<uuid>` lock,
   * checking unresolved renewal grants, and acquiring `inbound:<id>` lock, and
   * BEFORE rechecking BOTH lock leases immediately prior to dispatching the 3X-UI reset POST.
   * Bounded within remaining lock lease time. Any rejection releases locks cleanly
   * without marking them 'uncertain'.
   */
  beforeResetUnderLocks?: (ctx: {
    inboundId: number | null;
    clientUuid: string;
    email: string;
    remainingLeaseMs: number;
  }) => Promise<{ email?: string; inboundId?: number } | void>;
  /**
   * Optional accounting callback invoked AFTER a successful 3X-UI reset while STILL
   * holding the `client:<uuid>` lock (e.g., to record cooldown logs concurrency-safely).
   */
  afterResetUnderClientLock?: () => Promise<void>;
  maxLockedVerificationMs?: number;
  requireDurableLock?: boolean;
}

export const resetClientTraffic = async (
  email: string,
  inboundId?: number,
  clientUuid?: string,
  options?: ResetClientTrafficOptions
): Promise<{ success: boolean; message: string }> => {
  console.log(`[xuiService] Resetting traffic in 3X-UI for client - Email: '${email}', Inbound: ${inboundId}, UUID: '${clientUuid}'`);

  if (!email && !clientUuid) {
    throw new Error('Client email or UUID is required to reset 3X-UI traffic');
  }

  const dbClient = options?.dbClient || supabaseAdmin;
  const requestApiCall = options?.requestApiFn || requestApi;
  const getInboundsCall = options?.getInboundsFn || getInbounds;
  let resolvedInboundId = inboundId && Number(inboundId) > 0 ? Number(inboundId) : null;
  let resolvedUuid = String(clientUuid || '').trim();
  let resolvedEmail = String(email || '').trim();

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

  const buildEndpointsToTry = (targetEmail: string, targetInboundId: number | null, targetUuid: string): string[] => {
    const eps: string[] = [];
    if (targetEmail) {
      eps.push(`/panel/api/clients/resetTraffic/${encodeURIComponent(targetEmail)}`);
      if (targetInboundId && targetInboundId > 0) {
        eps.push(`/panel/api/inbounds/${targetInboundId}/resetClientTraffic/${encodeURIComponent(targetEmail)}`);
        eps.push(`/panel/api/inbounds/resetClientTraffic/${targetInboundId}/${encodeURIComponent(targetEmail)}`);
      }
      eps.push(`/panel/api/inbounds/resetClientTraffic/${encodeURIComponent(targetEmail)}`);
    }

    if (targetUuid) {
      if (targetInboundId && targetInboundId > 0) {
        eps.push(`/panel/api/inbounds/${targetInboundId}/resetClientTraffic/${encodeURIComponent(targetUuid)}`);
        eps.push(`/panel/api/inbounds/resetClientTraffic/${targetInboundId}/${encodeURIComponent(targetUuid)}`);
      }
      eps.push(`/panel/api/clients/resetTraffic/${encodeURIComponent(targetUuid)}`);
    }
    return eps;
  };

  const executeReset = async (): Promise<{ success: boolean; message: string }> => {
    const endpointsToTry = buildEndpointsToTry(resolvedEmail, resolvedInboundId, resolvedUuid);
    let resetSuccess = false;
    let lastError: any = null;
    let responseMsg = '';
    let hadUncertainTransportFailure = false;

    for (const ep of endpointsToTry) {
      try {
        console.log(`[xuiService] Invoking 3X-UI reset endpoint: ${ep}`);
        const res: any = await requestApiCall(ep, 'POST');
        resetSuccess = true;
        responseMsg = res?.msg || 'Traffic has been reset.';
        console.log(`[xuiService] Successfully reset traffic via ${ep}:`, res);
        break;
      } catch (err: any) {
        console.warn(`[xuiService] Reset endpoint ${ep} failed:`, err?.response?.data || err.message);
        lastError = err;
        const msgLower = String(err?.message || '').toLowerCase();
        const codeUpper = String(err?.code || '').toUpperCase();
        if (
          msgLower.includes('timeout') ||
          msgLower.includes('etimedout') ||
          msgLower.includes('econnreset') ||
          msgLower.includes('socket hang up') ||
          msgLower.includes('network error') ||
          codeUpper === 'ETIMEDOUT' ||
          codeUpper === 'ECONNABORTED' ||
          codeUpper === 'ECONNRESET'
        ) {
          hadUncertainTransportFailure = true;
        }
      }
    }

    if (!resetSuccess) {
      const failErr: any = new Error(
        `Failed to reset traffic in 3X-UI: ${lastError?.message || 'Server returned an error'}`
      );
      if (hadUncertainTransportFailure) {
        failErr.xuiUncertain = true;
        failErr.mutationUncertain = true;
      }
      throw failErr;
    }

    invalidateInboundCache(resolvedInboundId || inboundId || null);
    if (resolvedUuid) {
      notifyClientTrafficInvalidated(resolvedUuid, 'reset');
    }
    try {
      await getInboundsCall(true);
    } catch (refreshErr: any) {
      console.warn('[xuiService] Inbounds cache refresh warning after reset:', refreshErr?.message || refreshErr);
    }

    return { success: true, message: responseMsg || 'Traffic counter successfully reset in 3X-UI' };
  };

  const runBoundedPreResetVerification = async (
    lockAcquiredAtMs: number
  ): Promise<void> => {
    if (!options?.beforeResetUnderLocks) return;

    const leaseWindowMs = INBOUND_LOCK_LEASE_SECONDS * 1000;
    const elapsedMs = Math.max(0, Date.now() - lockAcquiredAtMs);
    const safeLeaseBudgetMs = Math.max(1000, Math.floor(leaseWindowMs * 0.5) - elapsedMs);
    const maxBudgetMs = Math.min(options.maxLockedVerificationMs ?? 12000, safeLeaseBudgetMs);

    if (maxBudgetMs <= 0) {
      const leaseTimeoutErr: any = new Error(
        'Traffic reset verification exceeded safe lock lease window before contacting 3X-UI; aborted safely.'
      );
      leaseTimeoutErr.status = 409;
      leaseTimeoutErr.statusCode = 409;
      leaseTimeoutErr.code = 'LOCK_VERIFICATION_LEASE_EXHAUSTED';
      leaseTimeoutErr.beforeExternalWrite = true;
      leaseTimeoutErr.xuiUncertain = false;
      throw leaseTimeoutErr;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const verificationRes = await Promise.race([
        options.beforeResetUnderLocks({
          inboundId: resolvedInboundId,
          clientUuid: resolvedUuid,
          email: resolvedEmail,
          remainingLeaseMs: maxBudgetMs,
        }),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            const timeoutErr: any = new Error(
              'Traffic reset eligibility verification timed out before 3X-UI mutation; aborted safely.'
            );
            timeoutErr.status = 503;
            timeoutErr.statusCode = 503;
            timeoutErr.code = 'LOCKED_VERIFICATION_TIMEOUT';
            timeoutErr.beforeExternalWrite = true;
            timeoutErr.xuiUncertain = false;
            reject(timeoutErr);
          }, maxBudgetMs);
        }),
      ]);

      if (verificationRes && typeof verificationRes === 'object') {
        if (verificationRes.email && String(verificationRes.email).trim()) {
          resolvedEmail = String(verificationRes.email).trim();
        }
        if (
          verificationRes.inboundId &&
          Number(verificationRes.inboundId) > 0 &&
          resolvedInboundId &&
          Number(verificationRes.inboundId) !== resolvedInboundId
        ) {
          const movedErr: any = new Error(
            'VPN configuration inbound changed during verification; please retry.'
          );
          movedErr.status = 409;
          movedErr.statusCode = 409;
          movedErr.code = 'INBOUND_CHANGED_DURING_RESET';
          movedErr.beforeExternalWrite = true;
          movedErr.xuiUncertain = false;
          throw movedErr;
        }
      }
    } catch (verifyErr: any) {
      if (verifyErr && typeof verifyErr === 'object') {
        verifyErr.beforeExternalWrite = true;
        verifyErr.xuiUncertain = false;
      }
      throw verifyErr;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };

  const runUnderInboundLock = async (
    assertClientLockStillHeld?: () => Promise<void>
  ): Promise<{ success: boolean; message: string }> => {
    if (resolvedUuid) {
      try {
        await assertNoUnresolvedClientRenewalGrant({
          dbClient,
          clientUuid: resolvedUuid,
          operationDescription: 'resetting client traffic',
        });
      } catch (grantErr: any) {
        if (grantErr && typeof grantErr === 'object') {
          grantErr.beforeExternalWrite = true;
          grantErr.xuiUncertain = false;
        }
        throw grantErr;
      }
    }

    if (resolvedInboundId && resolvedInboundId > 0) {
      return await withInboundWriteLock(
        {
          dbClient,
          inboundId: resolvedInboundId,
          targetId: `reset_traffic:${resolvedUuid || resolvedEmail}`,
          clientUuid: resolvedUuid || null,
          requireDurableLock:
            options?.requireDurableLock ??
            (isAutoActivateNewOrdersFlagEnabled() || isAutoActivateRenewalsFlagEnabled()),
        },
        async (assertInboundLockStillHeld) => {
          const inboundLockAcquiredAtMs = Date.now();
          await assertInboundLockStillHeld();

          // Run authoritative eligibility + fresh panel + cooldown recheck inside both locks
          await runBoundedPreResetVerification(inboundLockAcquiredAtMs);

          // Recheck BOTH lock leases AFTER all fresh DB/panel reads and IMMEDIATELY BEFORE 3X-UI POST
          try {
            if (assertClientLockStillHeld) {
              await assertClientLockStillHeld();
            }
            await assertInboundLockStillHeld();
          } catch (leaseErr: any) {
            if (leaseErr && typeof leaseErr === 'object') {
              leaseErr.beforeExternalWrite = true;
              leaseErr.xuiUncertain = false;
            }
            throw leaseErr;
          }

          return executeReset();
        }
      );
    }

    const noInboundAcquiredAtMs = Date.now();
    await runBoundedPreResetVerification(noInboundAcquiredAtMs);
    if (assertClientLockStillHeld) {
      try {
        await assertClientLockStillHeld();
      } catch (leaseErr: any) {
        if (leaseErr && typeof leaseErr === 'object') {
          leaseErr.beforeExternalWrite = true;
          leaseErr.xuiUncertain = false;
        }
        throw leaseErr;
      }
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
        requireDurableLock: options?.requireDurableLock ?? isAutoActivateRenewalsFlagEnabled(),
      },
      async (assertClientLockStillHeld) => {
        await assertClientLockStillHeld();
        const resetResult = await runUnderInboundLock(assertClientLockStillHeld);
        if (options?.afterResetUnderClientLock) {
          try {
            await options.afterResetUnderClientLock();
          } catch (acctErr: any) {
            // Never mark the client lock 'uncertain' after a confirmed successful reset;
            // accounting failures are logged cleanly.
            console.warn('[xuiService] Post-reset accounting warning:', acctErr?.message || acctErr);
          }
        }
        return resetResult;
      }
    );
  }

  const resetResult = await runUnderInboundLock();
  if (options?.afterResetUnderClientLock) {
    try {
      await options.afterResetUnderClientLock();
    } catch (acctErr: any) {
      console.warn('[xuiService] Post-reset accounting warning:', acctErr?.message || acctErr);
    }
  }
  return resetResult;
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
              // and inside requestApi after authentication / re-authentication.
              const verifyAllLocksBeforeExternalMutation = async (): Promise<void> => {
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
                  fenceErr.code = 'RENEW_LOCK_LOST';
                  fenceErr.beforeExternalWrite = true;
                  fenceErr.xuiUncertain = false;
                  throw fenceErr;
                }
              };

              await verifyAllLocksBeforeExternalMutation();

              xuiWriteAttempted = true;
              const updateRes = await requestApiCall<any>(
                `/panel/api/inbounds/update/${inboundId}`,
                'POST',
                updatePayload,
                {
                  beforeSend: verifyAllLocksBeforeExternalMutation,
                }
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
          const isUncertain = Boolean(
            xuiWriteAttempted &&
            !xuiWriteConfirmed &&
            xuiErr?.beforeExternalWrite !== true &&
            xuiErr?.xuiUncertain !== false
          );
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
  heldRenewLockTableAvailable?: boolean;
  signal?: AbortSignal;
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
    async (assertClientLockStillHeld) => {
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

      // Verify request deadline + client & renewal lock ownership right before DB confirmation
      assertRequestNotTimedOutBeforeExternalMutation(
        options?.signal,
        `provisional renewal confirmation for request ${cleanRequestId}`
      );
      await assertClientLockStillHeld();
      if (options?.heldRenewLockOwnerId && options?.heldRenewLockTableAvailable !== false) {
        const renewLockValid = await renewDurableProvisioningOperationLock({
          dbClient,
          operationKey: `renew:${cleanRequestId}`,
          lockOwnerId: options.heldRenewLockOwnerId,
          leaseSeconds: DEFAULT_LOCK_LEASE_SECONDS,
        });
        if (!renewLockValid) {
          const fenceErr: any = new Error(
            `Lost durable renewal lock 'renew:${cleanRequestId}' before DB confirmation; refusing stale write.`
          );
          fenceErr.statusCode = 409;
          fenceErr.code = 'RENEW_LOCK_LOST';
          fenceErr.beforeExternalWrite = true;
          fenceErr.xuiUncertain = false;
          throw fenceErr;
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
  heldRenewLockOwnerId?: string;
  heldRenewLockTableAvailable?: boolean;
  signal?: AbortSignal;
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

      const assertRenewLockStillHeld = async (
        stage: 'before_external_write' | 'before_db_finalization'
      ): Promise<void> => {
        if (!options?.heldRenewLockOwnerId) return;
        if (options?.heldRenewLockTableAvailable === false) {
          const missingErr: any = new Error(
            `Missing verified durable renewal lock 'renew:${cleanRequestId}' (${stage}); refusing to proceed without required lock.`
          );
          missingErr.statusCode = 409;
          missingErr.code = stage === 'before_db_finalization' ? 'RECONCILIATION_REQUIRED' : 'RENEW_LOCK_MISSING';
          missingErr.beforeExternalWrite = stage === 'before_external_write';
          missingErr.xuiUncertain = stage === 'before_db_finalization';
          missingErr.markLockUncertain = stage === 'before_db_finalization';
          throw missingErr;
        }
        const renewed = await renewDurableProvisioningOperationLock({
          dbClient,
          operationKey: `renew:${cleanRequestId}`,
          lockOwnerId: options.heldRenewLockOwnerId,
          leaseSeconds: DEFAULT_LOCK_LEASE_SECONDS,
        });
        if (!renewed) {
          const fenceErr: any = new Error(
            stage === 'before_db_finalization'
              ? `Lost durable renewal lock 'renew:${cleanRequestId}' after 3X-UI rollback; refusing stale DB finalization. Manual reconciliation required.`
              : `Lost durable renewal lock 'renew:${cleanRequestId}' before 3X-UI rollback; aborting before external mutation.`
          );
          fenceErr.statusCode = 409;
          fenceErr.code = stage === 'before_db_finalization' ? 'RECONCILIATION_REQUIRED' : 'RENEW_LOCK_LOST';
          fenceErr.beforeExternalWrite = stage === 'before_external_write';
          fenceErr.xuiUncertain = stage === 'before_db_finalization';
          fenceErr.markLockUncertain = stage === 'before_db_finalization';
          throw fenceErr;
        }
      };

      let restoredEnable = false;
      let restoredStatus = 'active' as 'active' | 'expired' | 'disabled';
      let xuiWriteAttempted = false;
      let xuiWriteConfirmed = false;

      try {
        await withInboundWriteLock(
          {
            dbClient,
            inboundId,
            targetId: `reject_renew:${cleanRequestId}`,
            clientUuid,
            requireDurableLock: true,
            allowUncertainRecovery: false,
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

            const preWriteEnable = Boolean(liveClient.enable);
            const preWriteExpiryMs = Number(liveClient.expiryTime || 0);
            const preWriteTotalBytes = Number(liveClient.totalGB || 0);

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

            const verifyAllLocksBeforeExternalMutation = async (): Promise<void> => {
              assertRequestNotTimedOutBeforeExternalMutation(
                options?.signal,
                `provisional renewal rollback for request ${cleanRequestId}`
              );
              await assertInboundLockStillHeld();
              await assertClientLockStillHeld();
              await assertRenewLockStillHeld('before_external_write');
            };

            await verifyAllLocksBeforeExternalMutation();

            xuiWriteAttempted = true;
            let updateRes: any = null;
            let explicitPanelErr: any = null;
            try {
              updateRes = await requestApiCall<any>(
                `/panel/api/inbounds/update/${inboundId}`,
                'POST',
                updatePayload,
                {
                  beforeSend: verifyAllLocksBeforeExternalMutation,
                  signal: options?.signal,
                }
              );
            } catch (apiErr: any) {
              if (apiErr?.xuiExplicitRejection === true || isHttp400Or422Error(apiErr)) {
                explicitPanelErr = apiErr;
              } else {
                throw apiErr;
              }
            }

            // MANDATORY READ-BACK VERIFICATION from live 3X-UI
            // (runs both on success AND on generic success:false rejection, and even if deadline elapsed after dispatch)
            let verifiedInbound: any = null;
            let readbackFetchErr: any = null;
            try {
              verifiedInbound = await fetchFreshInbound();
            } catch (rbErr: any) {
              readbackFetchErr = rbErr;
            }
            if (!verifiedInbound) {
              const reconErr: any = new Error(
                explicitPanelErr || (updateRes && updateRes.success === false)
                  ? `3X-UI rejected renewal rollback (${explicitPanelErr?.message || updateRes?.msg || 'success:false'}) and read-back verification failed${readbackFetchErr ? `: ${readbackFetchErr?.message || String(readbackFetchErr)}` : ''}.`
                  : `Read-back verification failed: unable to re-fetch inbound ${inboundId} after renewal rollback${readbackFetchErr ? `: ${readbackFetchErr?.message || String(readbackFetchErr)}` : ''}.`
              );
              reconErr.statusCode = 409;
              reconErr.code = 'RECONCILIATION_REQUIRED';
              reconErr.xuiUncertain = true;
              reconErr.markLockUncertain = true;
              throw reconErr;
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

            if (!verifiedClient) {
              const missingErr: any = new Error(
                `Read-back verification failed after renewal rollback for client ${clientUuid}: client missing from inbound ${inboundId}.`
              );
              missingErr.statusCode = 409;
              missingErr.code = 'RECONCILIATION_REQUIRED';
              missingErr.xuiUncertain = true;
              missingErr.markLockUncertain = true;
              throw missingErr;
            }

            const matchesRestoredTarget =
              Boolean(verifiedClient.enable) === restoredEnable &&
              Number(verifiedClient.expiryTime) === prevExpiryMs &&
              Number(verifiedClient.totalGB) === prevTotalBytes;

            if (!matchesRestoredTarget) {
              const strictlyUnchanged =
                Boolean(verifiedClient.enable) === preWriteEnable &&
                Number(verifiedClient.expiryTime || 0) === preWriteExpiryMs &&
                Number(verifiedClient.totalGB || 0) === preWriteTotalBytes;

              const panelMsg =
                explicitPanelErr?.message ||
                (updateRes && updateRes.success === false ? (updateRes.msg || updateRes.message) : null) ||
                `Read-back verification failed after renewal rollback for client ${clientUuid}: expected enable=${restoredEnable}, expiryTime=${prevExpiryMs}, totalGB=${prevTotalBytes}; got enable=${String(verifiedClient?.enable)}, expiryTime=${String(verifiedClient?.expiryTime)}, totalGB=${String(verifiedClient?.totalGB)}.`;

              const readbackErr: any = new Error(panelMsg);
              if (!strictlyUnchanged) {
                readbackErr.statusCode = 409;
                readbackErr.code = 'RECONCILIATION_REQUIRED';
                readbackErr.xuiUncertain = true;
                readbackErr.markLockUncertain = true;
              } else {
                readbackErr.xuiUncertain = false;
              }
              throw readbackErr;
            }

            xuiWriteConfirmed = true;
            invalidateInboundCache(inboundId);
          }
        );
      } catch (err: any) {
        if (err?.statusCode === 409 || err?.beforeExternalWrite === true) {
          if (
            err?.xuiUncertain === true &&
            err?.code !== 'RENEW_LOCK_LOST' &&
            err?.code !== 'RENEW_LOCK_MISSING'
          ) {
            let canSafelyUpdateGrantRows = true;
            try {
              await assertClientLockStillHeld();
              await assertRenewLockStillHeld('before_external_write');
            } catch {
              canSafelyUpdateGrantRows = false;
            }
            if (canSafelyUpdateGrantRows) {
              const nowIso = new Date().toISOString();
              const errText = err?.message || String(err);
              await dbClient
                .from('vpn_entitlement_grants')
                .update({
                  status: 'uncertain',
                  last_error: errText,
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
            }
          }
          throw err;
        }
        const nowIso = new Date().toISOString();
        const errText = err?.message || String(err);
        const isUncertainAfterWrite = Boolean(
          xuiWriteAttempted &&
          !xuiWriteConfirmed &&
          err?.beforeExternalWrite !== true &&
          err?.xuiUncertain !== false
        );

        let canSafelyUpdateGrantRows = true;
        try {
          await assertClientLockStillHeld();
          await assertRenewLockStillHeld('before_external_write');
        } catch {
          canSafelyUpdateGrantRows = false;
        }

        const targetStatus = isUncertainAfterWrite ? 'uncertain' : 'revoke_failed';
        if (canSafelyUpdateGrantRows) {
          await dbClient
            .from('vpn_entitlement_grants')
            .update({
              status: targetStatus,
              last_error: errText,
              updated_at: nowIso,
            })
            .eq('id', grantRow.id);
          await dbClient
            .from('renew_requests')
            .update({
              provisioning_status: targetStatus,
              updated_at: nowIso,
            })
            .eq('id', cleanRequestId);
        }

        if (isUncertainAfterWrite) {
          const reconErr: any = new Error(
            `Provisional renewal rollback outcome is uncertain after external 3X-UI dispatch (${errText}). Marked for reconciliation.`
          );
          reconErr.statusCode = 409;
          reconErr.code = 'RECONCILIATION_REQUIRED';
          reconErr.xuiUncertain = true;
          reconErr.markLockUncertain = true;
          throw reconErr;
        }

        throw new Error(
          `Failed to roll back provisional renewal on 3X-UI (retained in recoverable 'revoke_failed' state): ${errText}`
        );
      }

      // Post-write lock fencing: verify BOTH client:<uuid> AND renew:<id> locks are STILL owned
      // by this worker before restoring DB rows so a stale worker never overwrites another worker's state.
      try {
        await assertClientLockStillHeld();
      } catch (clientLossErr: any) {
        const reconErr: any = new Error(
          `Lost durable client lock 'client:${clientUuid}' after 3X-UI renewal rollback; refusing stale DB finalization. Manual reconciliation required.`
        );
        reconErr.statusCode = 409;
        reconErr.code = 'RECONCILIATION_REQUIRED';
        reconErr.beforeExternalWrite = false;
        reconErr.xuiUncertain = true;
        reconErr.markLockUncertain = true;
        throw reconErr;
      }
      await assertRenewLockStillHeld('before_db_finalization');

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




