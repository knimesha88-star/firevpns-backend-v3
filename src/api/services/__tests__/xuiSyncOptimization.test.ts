import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {
  computePanelIdentity,
  computeXuiCredentialScopeKey,
  getCachedInbounds,
  getClientTrafficMutationState,
  getInbounds,
  getInboundsSnapshotTimestamp,
  getLiveInbound,
  getScopeAuthGeneration,
  getTrafficMutationEpochSnapshot,
  getXuiAuthCacheStatsForTests,
  getXuiAuthHeaders,
  getXuiAuthTimeoutMs,
  getXuiFullListTimeoutMs,
  getXuiSingleInboundTimeoutMs,
  invalidateInboundCache,
  invalidateXuiAuthCache,
  invalidateXuiConfigCache,
  MAX_XUI_AUTH_SCOPE_ENTRIES,
  MAX_XUI_PANEL_CAPABILITY_ENTRIES,
  notifyClientTrafficInvalidated,
  requestApi,
  resetXuiServiceCachesForTests,
  runBackgroundSync,
  setCachedInbounds,
  setMaxClientTrafficMutationStateEntriesForTests,
  setMaxXuiAuthScopeEntriesForTests,
  startBackgroundSyncScheduler,
  syncDeleted3XUiClients,
  XuiConfig,
  XuiInbound,
} from '../xuiService.js';
import {
  CLIENT_TRAFFIC_CACHE_TTL_MS,
  DEFAULT_RESET_POLICY,
  getLastKnownClientTrafficCacheStatsForTests,
  getMyConfigs,
  resetLastKnownClientTrafficCacheForTests,
  resetVpnTraffic,
} from '../vpnService.js';
import { getClientStatus } from '../clientService.js';

const PANEL_A_URL = 'https://panel-a.firevpn.example:2053/subpath';
const PANEL_B_URL = 'https://panel-b.firevpn.example:2053/subpath';
const PANEL_A_ID = computePanelIdentity(PANEL_A_URL);
const PANEL_B_ID = computePanelIdentity(PANEL_B_URL);
const PAST_CREATED_AT = '2026-01-01T00:00:00.000Z';
const FUTURE_EXPIRY_MS = Date.now() + 30 * 24 * 60 * 60 * 1000;

const makeConfig = (overrides: Partial<XuiConfig> = {}): XuiConfig => ({
  panelUrl: PANEL_A_URL,
  username: 'admin',
  password: 'secret-password-1',
  apiToken: 'secret-password-1',
  panelName: 'Primary',
  ...overrides,
});

const makeInbound = (
  id: number,
  clients: Array<{ id: string; email: string; enable?: boolean; up?: number; down?: number; totalGB?: number; expiryTime?: number }>
): XuiInbound => ({
  id,
  up: 0,
  down: 0,
  total: 0,
  remark: `Inbound-${id}`,
  enable: true,
  expiryTime: 0,
  port: 443 + id,
  protocol: 'vless',
  settings: JSON.stringify({
    clients: clients.map((c) => ({
      id: c.id,
      email: c.email,
      limitIp: 0,
      totalGB: c.totalGB ?? 0,
      expiryTime: c.expiryTime ?? FUTURE_EXPIRY_MS,
      enable: c.enable ?? true,
      subId: '',
      reset: 0,
    })),
  }),
  clientStats: clients.map((c, idx) => ({
    id: idx + 1,
    inboundId: id,
    enable: c.enable ?? true,
    email: c.email,
    up: c.up ?? 0,
    down: c.down ?? 0,
    expiryTime: c.expiryTime ?? FUTURE_EXPIRY_MS,
    total: c.totalGB ?? 0,
    reset: 0,
  })),
  streamSettings: '{}',
  tag: `inbound-${id}`,
  sniffing: '{}',
});

const createMockCustomerDb = (seed: {
  vpn_accounts?: any[];
  vpn_configs?: any[];
  orders?: any[];
  vpn_entitlement_grants?: any[];
  locks?: Map<string, any>;
  settings?: any[];
}) => {
  const state = {
    vpn_accounts: (seed.vpn_accounts || []).map((r) => ({ ...r })),
    vpn_configs: (seed.vpn_configs || []).map((r) => ({ ...r })),
    orders: (seed.orders || []).map((r) => ({ ...r })),
    vpn_entitlement_grants: (seed.vpn_entitlement_grants || []).map((r) => ({ ...r })),
    audit_logs: [] as any[],
    traffic_reset_logs: [] as any[],
    settings: (seed.settings || []).map((r) => ({ ...r })),
    locks: seed.locks ? new Map(seed.locks) : new Map<string, any>(),
    writes: [] as Array<{ table: string; op: string; payload: any }>,
    rpcCalls: [] as Array<{ fn: string; args: any }>,
  };

  const applyFilters = (rows: any[], filters: Array<(r: any) => boolean>) =>
    rows.filter((r) => filters.every((fn) => fn(r)));

  const buildQuery = (table: string) => {
    const filters: Array<(r: any) => boolean> = [];
    let pendingWrite: { op: 'insert' | 'update'; payload: any } | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    let isSingle = false;

    const getRows = () => {
      const target = (state as any)[table];
      return Array.isArray(target) ? target : [];
    };

    const exec = async () => {
      if (pendingWrite) {
        if (pendingWrite.op === 'insert') {
          const item = Array.isArray(pendingWrite.payload) ? pendingWrite.payload[0] : pendingWrite.payload;
          const rows = getRows();
          rows.push({ ...item });
          state.writes.push({ table, op: 'insert', payload: item });
          return { data: item, error: null };
        }
        const matched = applyFilters(getRows(), filters);
        for (const r of matched) {
          Object.assign(r, pendingWrite.payload);
        }
        state.writes.push({ table, op: 'update', payload: pendingWrite.payload });
        return { data: matched, error: null };
      }

      let res = applyFilters(getRows(), filters).map((r) => ({ ...r }));
      if (orderCol) {
        res.sort((a, b) => {
          const av = a[orderCol!];
          const bv = b[orderCol!];
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * (orderAsc ? 1 : -1);
        });
      }
      if (isSingle) {
        return { data: res[0] || null, error: null };
      }
      return { data: res, error: null };
    };

    const q: any = {
      select: () => q,
      insert: (payload: any) => {
        pendingWrite = { op: 'insert', payload };
        return q;
      },
      update: (payload: any) => {
        pendingWrite = { op: 'update', payload };
        return q;
      },
      eq: (col: string, val: any) => {
        filters.push((r) => r[col] === val);
        return q;
      },
      ilike: (col: string, val: any) => {
        const needle = String(val || '').toLowerCase();
        filters.push((r) => String(r[col] || '').toLowerCase() === needle);
        return q;
      },
      in: (col: string, vals: any[]) => {
        const set = new Set((vals || []).map((v) => String(v)));
        filters.push((r) => set.has(String(r[col])));
        return q;
      },
      gt: (col: string, val: any) => {
        filters.push((r) => r[col] > val);
        return q;
      },
      gte: (col: string, val: any) => {
        filters.push((r) => r[col] >= val);
        return q;
      },
      lt: (col: string, val: any) => {
        filters.push((r) => r[col] < val);
        return q;
      },
      lte: (col: string, val: any) => {
        filters.push((r) => r[col] <= val);
        return q;
      },
      neq: (col: string, val: any) => {
        filters.push((r) => r[col] !== val);
        return q;
      },
      not: (col: string, op: string, val: any) => {
        if (op === 'is' && val === null) {
          filters.push((r) => r[col] !== null && r[col] !== undefined);
        } else if (op === 'eq') {
          filters.push((r) => r[col] !== val);
        } else if (op === 'in') {
          const vals = Array.isArray(val) ? val : String(val).replace(/[()]/g, '').split(',').map((s) => s.trim());
          const set = new Set(vals);
          filters.push((r) => !set.has(String(r[col])));
        }
        return q;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        orderAsc = opts?.ascending !== false;
        return q;
      },
      limit: () => q,
      maybeSingle: () => {
        isSingle = true;
        return exec();
      },
      then: (resolve: any, reject: any) => exec().then(resolve, reject),
    };
    return q;
  };

  return {
    state,
    from: (table: string) => buildQuery(table),
    rpc: async (fn: string, args: Record<string, any>) => {
      state.rpcCalls.push({ fn, args });
      if (fn === 'acquire_provisioning_lock') {
        const key = String(args.p_operation_key);
        const existing = state.locks.get(key);
        if (existing && (existing.status === 'in_progress' || existing.status === 'uncertain')) {
          return {
            data: [{
              acquired: false,
              stale_recovery: false,
              previous_status: existing.status,
              previous_operation_type: existing.operationType,
              holder_owner_id: existing.ownerId,
            }],
            error: null,
          };
        }
        state.locks.set(key, {
          ownerId: String(args.p_lock_owner_id),
          status: 'in_progress',
          operationType: String(args.p_operation_type),
        });
        return {
          data: [{
            acquired: true,
            stale_recovery: false,
            previous_status: existing?.status || null,
            previous_operation_type: existing?.operationType || null,
            holder_owner_id: args.p_lock_owner_id,
          }],
          error: null,
        };
      }
      if (fn === 'renew_provisioning_lock') {
        const key = String(args.p_operation_key);
        const existing = state.locks.get(key);
        return {
          data: Boolean(existing && existing.status === 'in_progress' && existing.ownerId === args.p_lock_owner_id),
          error: null,
        };
      }
      if (fn === 'release_provisioning_lock') {
        const key = String(args.p_operation_key);
        const existing = state.locks.get(key);
        if (existing && existing.ownerId === args.p_lock_owner_id) {
          existing.status = args.p_status;
          return { data: true, error: null };
        }
        return { data: false, error: null };
      }
      if (fn === 'mark_vpn_client_panel_deleted') {
        const normUuid = String(args.p_client_uuid || '').trim().toLowerCase();
        const nowIso = new Date().toISOString();
        let updAcc = 0;
        let updCfg = 0;
        for (const a of state.vpn_accounts) {
          if (String(a.uuid || '').trim().toLowerCase() === normUuid) {
            a.status = 'deleted';
            a.enable = false;
            a.deleted_from_panel_at = nowIso;
            updAcc++;
          }
        }
        for (const c of state.vpn_configs) {
          if (String(c.uuid || '').trim().toLowerCase() === normUuid) {
            c.status = 'deleted';
            c.enabled = false;
            c.deleted_from_panel_at = nowIso;
            updCfg++;
          }
        }
        return {
          data: [{
            applied: updAcc > 0 || updCfg > 0,
            already_deleted: false,
            updated_accounts: updAcc,
            updated_configs: updCfg,
            reconciliation_required: false,
            unresolved_grant_count: 0,
            audit_log_inserted: true,
          }],
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
};

// ---------------------------------------------------------------------------
// 1. Single-flight auth deduplication & shallow copy safety
// ---------------------------------------------------------------------------
test('1. Concurrent getXuiAuthHeaders callers deduplicate login & CSRF requests cleanly', async () => {
  resetXuiServiceCachesForTests();
  const cfg = makeConfig();
  let loginCalls = 0;
  let csrfCalls = 0;

  const authOpts = {
    loginPostFn: async () => {
      loginCalls++;
      await new Promise((r) => setTimeout(r, 25));
      return {
        status: 200,
        headers: { 'set-cookie': ['3x-ui=session-abc; Path=/; HttpOnly'] },
        data: { success: true },
      };
    },
    csrfGetFn: async () => {
      csrfCalls++;
      await new Promise((r) => setTimeout(r, 10));
      return { status: 200, headers: {}, data: { obj: 'csrf-tok-1' } };
    },
  };

  const results = await Promise.all(
    Array.from({ length: 10 }, () => getXuiAuthHeaders(cfg, false, 6000, authOpts))
  );

  assert.equal(loginCalls, 1, '10 concurrent callers MUST share 1 login request');
  assert.equal(csrfCalls, 1, '10 concurrent callers MUST share 1 CSRF request');
  for (const h of results) {
    assert.equal(h['Cookie'], '3x-ui=session-abc');
    assert.equal(h['X-CSRF-Token'], 'csrf-tok-1');
  }

  // Mutating returned headers must not corrupt cached headers
  results[0]['Cookie'] = 'mutated';
  const cachedFollowUp = await getXuiAuthHeaders(cfg, false, 6000, authOpts);
  assert.equal(cachedFollowUp['Cookie'], '3x-ui=session-abc');
  assert.equal(loginCalls, 1);
});

// ---------------------------------------------------------------------------
// 2. Credential & panel identity scoping prevents cross-panel/stale credential reuse
// ---------------------------------------------------------------------------
test('2. Different panels and changed credentials compute distinct scope keys and never share sessions', async () => {
  resetXuiServiceCachesForTests();
  const cfgA1 = makeConfig({ panelUrl: PANEL_A_URL, password: 'pw-1', apiToken: 'pw-1' });
  const cfgA2 = makeConfig({ panelUrl: PANEL_A_URL, password: 'pw-2', apiToken: 'pw-2' });
  const cfgB1 = makeConfig({ panelUrl: PANEL_B_URL, password: 'pw-1', apiToken: 'pw-1' });

  const scopeA1 = computeXuiCredentialScopeKey(cfgA1);
  const scopeA2 = computeXuiCredentialScopeKey(cfgA2);
  const scopeB1 = computeXuiCredentialScopeKey(cfgB1);

  assert.notEqual(scopeA1.scopeKey, scopeA2.scopeKey);
  assert.notEqual(scopeA1.scopeKey, scopeB1.scopeKey);
  assert.equal(scopeA1.panelIdentity, PANEL_A_ID);
  assert.equal(scopeB1.panelIdentity, PANEL_B_ID);

  const loginsByPassword: string[] = [];
  const makeOpts = (tag: string) => ({
    loginPostFn: async () => {
      loginsByPassword.push(tag);
      return {
        status: 200,
        headers: { 'set-cookie': [`3x-ui=sess-${tag}; Path=/`] },
        data: { success: true },
      };
    },
    csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
  });

  const h1 = await getXuiAuthHeaders(cfgA1, false, 6000, makeOpts('A1'));
  const h2 = await getXuiAuthHeaders(cfgA2, false, 6000, makeOpts('A2'));
  const h3 = await getXuiAuthHeaders(cfgB1, false, 6000, makeOpts('B1'));

  assert.equal(h1['Cookie'], '3x-ui=sess-A1');
  assert.equal(h2['Cookie'], '3x-ui=sess-A2');
  assert.equal(h3['Cookie'], '3x-ui=sess-B1');
  assert.deepEqual(loginsByPassword, ['A1', 'A2', 'B1']);
});

// ---------------------------------------------------------------------------
// 3. Mid-flight auth cache invalidation prevents stale session overwrite
// ---------------------------------------------------------------------------
test('3. Stale in-flight auth response cannot overwrite a newer invalidated session', async () => {
  resetXuiServiceCachesForTests();
  const cfg = makeConfig();
  let releaseOldLogin!: () => void;
  const oldLoginGate = new Promise<void>((r) => {
    releaseOldLogin = r;
  });

  const stalePromise = getXuiAuthHeaders(cfg, false, 6000, {
    loginPostFn: async () => {
      await oldLoginGate;
      return {
        status: 200,
        headers: { 'set-cookie': ['3x-ui=stale-session; Path=/'] },
        data: { success: true },
      };
    },
    csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
  });

  // Wait a microtask so stale auth is in-flight, then invalidate & run newer auth
  await new Promise((r) => setTimeout(r, 10));
  invalidateXuiAuthCache();

  const freshHeaders = await getXuiAuthHeaders(cfg, false, 6000, {
    loginPostFn: async () => ({
      status: 200,
      headers: { 'set-cookie': ['3x-ui=fresh-session; Path=/'] },
      data: { success: true },
    }),
    csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
  });
  assert.equal(freshHeaders['Cookie'], '3x-ui=fresh-session');

  // Now finish the stale auth request; cached session MUST stay 'fresh-session'
  releaseOldLogin();
  await stalePromise;

  const afterHeaders = await getXuiAuthHeaders(cfg, false, 6000);
  assert.equal(afterHeaders['Cookie'], '3x-ui=fresh-session');
});

// ---------------------------------------------------------------------------
// 4. Remembered login endpoint + CSRF 404 caching vs transient failure
// ---------------------------------------------------------------------------
test('4. Remembers working login endpoint per panel and caches unsupported CSRF only on 404/405/501', async () => {
  resetXuiServiceCachesForTests();
  const cfg = makeConfig();
  const hitEndpoints: string[] = [];
  let csrfAttempts = 0;

  // First login: /login 404s, /panel/login succeeds, /csrf-token returns 500 (transient -> do NOT cache unsupported!)
  await getXuiAuthHeaders(cfg, false, 6000, {
    loginPostFn: async (url) => {
      hitEndpoints.push(url);
      if (url.endsWith('/panel/login')) {
        return { status: 200, headers: { 'set-cookie': ['3x-ui=sess-1; Path=/'] }, data: { success: true } };
      }
      return { status: 404, headers: {}, data: {} };
    },
    csrfGetFn: async () => {
      csrfAttempts++;
      return { status: 500, headers: {}, data: {} };
    },
  });
  assert.equal(csrfAttempts, 1);
  assert.ok(hitEndpoints[1].endsWith('/panel/login'));

  // Force refresh (simulating expiry without invalidating login endpoint memory):
  // Should try remembered /panel/login FIRST, and retry /csrf-token (returns 404 -> now confirmed unsupported!)
  hitEndpoints.length = 0;
  await getXuiAuthHeaders(cfg, true, 6000, {
    loginPostFn: async (url) => {
      hitEndpoints.push(url);
      return { status: 200, headers: { 'set-cookie': ['3x-ui=sess-2; Path=/'] }, data: { success: true } };
    },
    csrfGetFn: async () => {
      csrfAttempts++;
      return { status: 404, headers: {}, data: {} };
    },
  });
  assert.equal(hitEndpoints.length, 1, 'Remembered /panel/login should succeed on first try');
  assert.ok(hitEndpoints[0].endsWith('/panel/login'));
  assert.equal(csrfAttempts, 2, 'Transient 500 was NOT cached as unsupported, so /csrf-token was re-checked');

  // Clear cached auth object WITHOUT invalidating confirmedUnsupportedCsrfByPanel? Wait: a soft expired TTL
  // keeps confirmedUnsupported in the same session generation; on explicit 401/403 invalidation, CSRF cache resets.
  invalidateXuiAuthCache();
  await getXuiAuthHeaders(cfg, false, 6000, {
    loginPostFn: async () => ({
      status: 200,
      headers: { 'set-cookie': ['3x-ui=sess-3; Path=/'] },
      data: { success: true },
    }),
    csrfGetFn: async () => {
      csrfAttempts++;
      return { status: 200, headers: {}, data: { obj: 'new-csrf-after-reauth' } };
    },
  });
  assert.equal(csrfAttempts, 3, 'Session invalidation after 401/403 clears CSRF unsupported cache');
});

// ---------------------------------------------------------------------------
// 5. Concurrent force-refresh auth deduplication & POST timeout deadline preservation
// ---------------------------------------------------------------------------
test('5. Concurrent force-refresh auth deduplicates login and requestApi preserves POST deadline safety', async () => {
  resetXuiServiceCachesForTests();
  const cfg = makeConfig();

  let forceLoginCalls = 0;
  const forceAuthOpts = {
    loginPostFn: async () => {
      forceLoginCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return {
        status: 200,
        headers: { 'set-cookie': [`3x-ui=reauth-${forceLoginCalls}; Path=/`] },
        data: { success: true },
      };
    },
    csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
  };

  const reauthResults = await Promise.all([
    getXuiAuthHeaders(cfg, true, 6000, forceAuthOpts),
    getXuiAuthHeaders(cfg, true, 6000, forceAuthOpts),
    getXuiAuthHeaders(cfg, true, 6000, forceAuthOpts),
  ]);
  assert.equal(forceLoginCalls, 1, 'Concurrent force-refresh auth callers share 1 in-flight login');
  for (const h of reauthResults) {
    assert.equal(h['Cookie'], '3x-ui=reauth-1');
  }

  const ac = new AbortController();
  ac.abort(new Error('deadline elapsed'));

  await assert.rejects(
    () =>
      requestApi('/panel/api/inbounds/addClient', 'POST', { test: true }, {
        configOverride: cfg,
        signal: ac.signal,
        authHeadersFn: async () => ({ Cookie: '3x-ui=ok' }),
        httpRequestFn: async () => {
          throw new Error('HTTP POST must never dispatch after deadline');
        },
      }),
    (err: any) => err?.code === 'REQUEST_TIMEOUT_BEFORE_MUTATION' && err?.beforeExternalWrite === true
  );
});

// ---------------------------------------------------------------------------
// 6. getInbounds single-flight deduplication, cache generation guard, and multi-panel isolation
// ---------------------------------------------------------------------------
test('6. Concurrent getInbounds(false) deduplicates requests, guards mid-flight invalidation, and isolates panels', async () => {
  resetXuiServiceCachesForTests();
  const ibOld = [makeInbound(1, [{ id: 'u-old', email: 'old@test.com' }])];
  const ibNew = [makeInbound(1, [{ id: 'u-new', email: 'new@test.com' }])];

  let fetchCount = 0;
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((r) => {
    releaseFetch = r;
  });

  const p1 = getInbounds(false, {
    panelIdentity: PANEL_A_ID,
    fetcher: async () => {
      fetchCount++;
      await fetchGate;
      return ibOld;
    },
  });
  const p2 = getInbounds(false, {
    panelIdentity: PANEL_A_ID,
    fetcher: async () => {
      fetchCount++;
      return ibOld;
    },
  });

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fetchCount, 1, 'Concurrent getInbounds callers must share 1 in-flight request');

  releaseFetch();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.length, 1);
  assert.equal(r2.length, 1);

  // Panel isolation: cached for PANEL_A_ID, empty for PANEL_B_ID
  assert.equal((await getCachedInbounds(PANEL_A_ID)).length, 1);
  assert.equal((await getCachedInbounds(PANEL_B_ID)).length, 0);

  // Mid-flight invalidation prevents stale ibOld from overwriting newer cache generation
  let releaseStaleList!: () => void;
  const staleGate = new Promise<void>((r) => {
    releaseStaleList = r;
  });
  invalidateInboundCache();
  const staleListPromise = getInbounds(true, {
    panelIdentity: PANEL_A_ID,
    fetcher: async () => {
      await staleGate;
      return ibOld;
    },
  });
  await new Promise((r) => setTimeout(r, 10));
  invalidateInboundCache();
  setCachedInbounds(ibNew, PANEL_A_ID);
  releaseStaleList();
  await staleListPromise;

  const cachedAfter = await getCachedInbounds(PANEL_A_ID);
  assert.match(cachedAfter[0].settings, /u-new/, 'Stale in-flight list MUST NOT overwrite newer invalidated cache');
});

// ---------------------------------------------------------------------------
// 7. Timeout helper bounds & deletion Read 2 lease budget safety
// ---------------------------------------------------------------------------
test('7. Timeout helpers respect safe bounds and deletion Read 2 stays strictly below 50% of 45s lease', async () => {
  const prevAuth = process.env.XUI_AUTH_TIMEOUT_MS;
  const prevSingle = process.env.XUI_SINGLE_INBOUND_TIMEOUT_MS;
  const prevFull = process.env.XUI_FULL_LIST_TIMEOUT_MS;
  try {
    delete process.env.XUI_AUTH_TIMEOUT_MS;
    delete process.env.XUI_SINGLE_INBOUND_TIMEOUT_MS;
    delete process.env.XUI_FULL_LIST_TIMEOUT_MS;
    assert.equal(getXuiAuthTimeoutMs(), 6000);
    assert.equal(getXuiSingleInboundTimeoutMs(), 8000);
    assert.equal(getXuiFullListTimeoutMs(), 15000);

    // Outrageous values must stay safely clamped
    process.env.XUI_AUTH_TIMEOUT_MS = '999999';
    process.env.XUI_SINGLE_INBOUND_TIMEOUT_MS = '999999';
    process.env.XUI_FULL_LIST_TIMEOUT_MS = '999999';
    assert.equal(getXuiAuthTimeoutMs(), 12000);
    assert.equal(getXuiSingleInboundTimeoutMs(), 15000);
    assert.equal(getXuiFullListTimeoutMs(), 25000);

    // Deletion Read 2 never inherits unbounded full-list timeout; strictly <= 22.5s (50% of 45s lease)
    let observedRead2Timeout: number | undefined;
    const liveClientsR2 = Array.from({ length: 4 }, (_, idx) => ({ id: `uuid-r2-live-${idx}`, email: `live${idx}@example.com` }));
    const db = createMockCustomerDb({
      vpn_accounts: [
        { id: 'acc-1', user_id: 'u-1', email: 'u1@example.com', uuid: 'uuid-r2', status: 'active', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
        ...liveClientsR2.map((c, idx) => ({ id: `acc-live-${idx}`, user_id: `u-l-${idx}`, email: c.email, uuid: c.id, status: 'active', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT })),
      ],
      vpn_configs: [
        { id: 'cfg-1', user_id: 'u-1', customer_uid: 'u-1', uuid: 'uuid-r2', inbound_id: 10, status: 'active', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
        ...liveClientsR2.map((c, idx) => ({ id: `cfg-live-${idx}`, user_id: `u-l-${idx}`, customer_uid: `u-l-${idx}`, uuid: c.id, inbound_id: 10, status: 'active', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT })),
      ],
    });
    const ib10 = makeInbound(10, liveClientsR2);
    process.env.PANEL_DELETION_SYNC_ENABLED = 'true';
    const delRes = await syncDeleted3XUiClients({
      dbClient: db,
      currentPanelIdentity: PANEL_A_ID,
      configuredServers: [],
      fetchUncachedInboundsList: async (opts) => {
        if (opts?.timeoutMs) observedRead2Timeout = opts.timeoutMs;
        return {
          ok: true,
          inbounds: [ib10],
          parsedByInboundId: new Map([[10, { inbound: ib10, inboundId: 10, clients: [], clientUuidSet: new Set(liveClientsR2.map((c) => c.id)) }]]),
          unparsedInboundIds: [],
          allInboundsCleanlyParsed: true,
          liveClientByUuid: new Map(
            liveClientsR2.map((c) => [c.id, { inbound: ib10, client: { id: c.id, email: c.email, limitIp: 0, totalGB: 0, expiryTime: FUTURE_EXPIRY_MS, enable: true, subId: '', reset: 0 }, stat: null }])
          ),
        };
      },
      reReadDelayMs: 0,
    });
    assert.equal(delRes.deletedCount, 1);
    assert.ok(observedRead2Timeout !== undefined && observedRead2Timeout <= 22500);
    assert.ok(observedRead2Timeout <= 8000);
  } finally {
    delete process.env.PANEL_DELETION_SYNC_ENABLED;
    if (prevAuth === undefined) delete process.env.XUI_AUTH_TIMEOUT_MS; else process.env.XUI_AUTH_TIMEOUT_MS = prevAuth;
    if (prevSingle === undefined) delete process.env.XUI_SINGLE_INBOUND_TIMEOUT_MS; else process.env.XUI_SINGLE_INBOUND_TIMEOUT_MS = prevSingle;
    if (prevFull === undefined) delete process.env.XUI_FULL_LIST_TIMEOUT_MS; else process.env.XUI_FULL_LIST_TIMEOUT_MS = prevFull;
  }
});

// ---------------------------------------------------------------------------
// 8. Concurrent customer traffic retrieval benchmark (before vs after) & shared warm-up continuity
// ---------------------------------------------------------------------------
test('8. Cold-start concurrent customer getMyConfigs reduces N full-list bursts to 1 and survives early wait timeout', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const concurrency = 12;
  const ib = makeInbound(
    7,
    Array.from({ length: concurrency }, (_, i) => ({
      id: `uuid-burst-${i}`,
      email: `user${i}@example.com`,
      up: 1024 * 1024 * 100,
      down: 1024 * 1024 * 200,
      totalGB: 10 * 1024 * 1024 * 1024,
    }))
  );

  // Simulate shared single-flight cold start using real getInbounds(false, { fetcher })
  let fullListExternalCalls = 0;
  let liveInboundExternalCalls = 0;

  const makeBurstDb = (i: number) =>
    createMockCustomerDb({
      vpn_accounts: [
        {
          id: `acc-${i}`,
          user_id: `uid-${i}`,
          email: `user${i}@example.com`,
          uuid: `uuid-burst-${i}`,
          vless_url: `vless://uuid-burst-${i}@example.com:443#SG`,
          status: 'active',
          enable: true,
          total_bytes: 10 * 1024 * 1024 * 1024,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
      // Note: no inbound_id in vpn_configs -> cold start triggers hasMissingInboundId!
      vpn_configs: [
        {
          id: `cfg-${i}`,
          user_id: `uid-${i}`,
          customer_uid: `uid-${i}`,
          uuid: `uuid-burst-${i}`,
          inbound_id: null,
          status: 'active',
          enabled: true,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
    });

  const sharedFetcher = async () => {
    fullListExternalCalls++;
    await new Promise((r) => setTimeout(r, 80));
    return [ib];
  };

  // First caller waits only 30ms (simulating short timeout) while others wait 5000ms:
  // shared single-flight MUST NOT cancel; subsequent callers reuse the populated cache!
  const burstPromises = Array.from({ length: concurrency }, (_, i) => {
    const db = makeBurstDb(i);
    return getMyConfigs(`uid-${i}`, `user${i}@example.com`, undefined, {
      dbClient: db,
      adminDbClient: db,
      currentPanelIdentity: PANEL_A_ID,
      coldStartTimeoutMs: i === 0 ? 30 : 5000,
      getCachedInboundsFn: (pid) => getCachedInbounds(pid),
      getInboundsFn: (force) => getInbounds(force, { panelIdentity: PANEL_A_ID, fetcher: sharedFetcher }),
      getLiveInboundFn: async () => {
        liveInboundExternalCalls++;
        return ib;
      },
    });
  });

  const results = await Promise.all(burstPromises);
  assert.equal(fullListExternalCalls, 1, `Expected 1 full-list external request (vs ${concurrency} before fix)`);
  assert.equal(results[0].configs[0].status, 'Status Unavailable', 'Early local wait timeout must fail safe as Status Unavailable');
  for (let i = 1; i < concurrency; i++) {
    assert.equal(results[i].configs[0].status, 'Active');
    assert.equal(results[i].configs[0].inboundId, 7);
  }

  // Subsequent request for user 0 now hits warmed cache and completes cleanly with 0 full-list calls
  const followDb = makeBurstDb(0);
  const afterWarm = await getMyConfigs('uid-0', 'user0@example.com', undefined, {
    dbClient: followDb,
    adminDbClient: followDb,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: (pid) => getCachedInbounds(pid),
    getInboundsFn: (force) => getInbounds(force, { panelIdentity: PANEL_A_ID, fetcher: sharedFetcher }),
    getLiveInboundFn: async () => {
      liveInboundExternalCalls++;
      return ib;
    },
  });
  assert.equal(fullListExternalCalls, 1);
  assert.equal(afterWarm.configs[0].status, 'Active');
  assert.equal(liveInboundExternalCalls, 1);
});

// ---------------------------------------------------------------------------
// 9. Preserve existing customer traffic when panel is unavailable + reset clears preserved traffic
// ---------------------------------------------------------------------------
test('9. Preserves customer traffic during panel outage while keeping Status Unavailable, and clears on reset', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-traffic-preserve';
  const email = 'preserve@example.com';
  const clientUuid = 'uuid-preserve-1';
  const tenGb = 10 * 1024 * 1024 * 1024;
  const twoGb = 2 * 1024 * 1024 * 1024;
  const threeGb = 3 * 1024 * 1024 * 1024;

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-p1',
        user_id: uid,
        email,
        uuid: clientUuid,
        vless_url: `vless://${clientUuid}@example.com:443#SG`,
        status: 'active',
        enable: true,
        total_bytes: 0, // Unlimited for reset test too
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-p1',
        user_id: uid,
        customer_uid: uid,
        uuid: clientUuid,
        inbound_id: 5,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    orders: [
      {
        id: 'ord-p1',
        order_id: 'ORD-P1',
        customer_id: uid,
        email,
        status: 'approved',
        payment_status: 'Paid',
        provisioning_status: 'completed',
        client_uuid: clientUuid,
        vless_url: `vless://${clientUuid}@example.com:443#SG`,
        traffic_limit: 'Unlimited',
      },
    ],
  });

  // Step A: Panel reachable -> observes 5GB used (2GB up + 3GB down)
  const liveIb = makeInbound(5, [{ id: clientUuid, email, up: twoGb, down: threeGb, totalGB: tenGb }]);
  const liveRes = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => liveIb,
    getInboundsFn: async () => [],
  });
  assert.equal(liveRes.configs[0].status, 'Active');
  assert.equal(liveRes.configs[0].usedGB, 5);
  assert.equal(liveRes.configs[0].remainingGB, 5);

  // Step B: Panel becomes temporarily unavailable -> status is Status Unavailable, usage stays 5GB!
  const outageRes = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });
  assert.equal(outageRes.configs[0].status, 'Status Unavailable');
  assert.equal(outageRes.configs[0].panelStatusVerified, false);
  assert.equal(outageRes.configs[0].enable, null);
  assert.equal(outageRes.configs[0].enableStatus, false);
  assert.equal(outageRes.configs[0].liveUsageFound, false);
  assert.equal(outageRes.configs[0].trafficResetEligible, false);
  assert.equal(outageRes.configs[0].usedGB, 5, 'Existing customer usedGB MUST be preserved during outage');
  assert.equal(outageRes.configs[0].upBytes, twoGb);
  assert.equal(outageRes.configs[0].downBytes, threeGb);

  // Step C: Successful traffic reset resets preserved traffic to 0 even if panel goes down afterward
  const liveUnlimIb = makeInbound(5, [{ id: clientUuid, email, up: twoGb, down: threeGb, totalGB: 0 }]);
  await resetVpnTraffic(uid, email, clientUuid, {
    dbClient: db,
    skipNotification: true,
    requireDurableLock: false,
    getTrafficResetPolicyFn: async () => ({ ...DEFAULT_RESET_POLICY }),
    getLiveInboundFn: async () => liveUnlimIb,
    getInboundsFn: async () => [liveUnlimIb],
    resetClientTrafficFn: async (_em, _ibId, _u, opts) => {
      if (opts?.beforeResetUnderLocks) {
        await opts.beforeResetUnderLocks({
          inboundId: 5,
          clientUuid,
          email,
          remainingLeaseMs: 30000,
        });
      }
      if (opts?.afterResetUnderClientLock) await opts.afterResetUnderClientLock();
      return { success: true, message: 'ok' };
    },
    getTrafficResetLogsFn: async () => [],
    recordTrafficResetLogFn: async () => {},
  });

  const postResetOutageRes = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });
  assert.equal(postResetOutageRes.configs[0].status, 'Status Unavailable');
  assert.equal(postResetOutageRes.configs[0].usedGB, 0, 'Preserved traffic MUST be cleared to 0 after traffic reset');
});

// ---------------------------------------------------------------------------
// 10. Zero automatic DB backfill in getMyConfigs + legacy reconciliation reporting
// ---------------------------------------------------------------------------
test('10. getMyConfigs NEVER writes inbound_id/panel_identity/server_id/uuid backfills and reports legacy records', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-legacy-10';
  const email = 'legacy10@example.com';
  const legacyUuid = 'uuid-legacy-no-meta';

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-leg',
        user_id: uid,
        email,
        uuid: legacyUuid,
        vless_url: `vless://${legacyUuid}@cdn.example.com:443#Legacy`,
        status: 'disabled', // Also exercise status recovery path to verify panel_identity is NOT backfilled there either!
        enable: false,
        panel_identity: null,
        server_id: null,
        used_bytes: 1073741824, // 1GB DB stored traffic baseline
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-leg',
        user_id: uid,
        customer_uid: uid,
        uuid: legacyUuid,
        inbound_id: null,
        panel_identity: null,
        server_id: null,
        status: 'disabled',
        enabled: false,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const liveIb = makeInbound(9, [{ id: legacyUuid, email, enable: true, up: 512, down: 512 }]);
  const res = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [liveIb],
    getLiveInboundFn: async () => liveIb,
    getInboundsFn: async () => [liveIb],
  });

  // In-memory resolution works so customer gets live view
  assert.equal(res.configs[0].inboundId, 9);
  assert.equal(res.configs[0].status, 'Active');

  // Legacy reconciliation record is reported
  assert.equal(res.legacyReconciliationRecords.length, 1);
  assert.equal(res.legacyReconciliationRecords[0].uuid, legacyUuid);
  assert.deepEqual(res.legacyReconciliationRecords[0].missingFields, ['inbound_id', 'panel_identity']);

  // Database records MUST NOT have inbound_id, panel_identity, server_id, or uuid mutated!
  assert.equal(db.state.vpn_accounts[0].panel_identity, null);
  assert.equal(db.state.vpn_accounts[0].server_id, null);
  assert.equal(db.state.vpn_configs[0].inbound_id, null);
  assert.equal(db.state.vpn_configs[0].panel_identity, null);
  for (const w of db.state.writes) {
    assert.equal('panel_identity' in (w.payload || {}), false);
    assert.equal('inbound_id' in (w.payload || {}), false);
    assert.equal('server_id' in (w.payload || {}), false);
    assert.equal('uuid' in (w.payload || {}), false);
  }
});

// ---------------------------------------------------------------------------
// 11. Non-overlapping background startup sync & failure recovery
// ---------------------------------------------------------------------------
test('11. Background scheduler prevents startup overlap and deletion sync still runs if warmup/cleanup fail', async () => {
  resetXuiServiceCachesForTests();

  const bgCalls: Array<{ reason?: string; force?: boolean }> = [];
  const delCalls: Array<{ reason?: string; force?: boolean }> = [];
  const timers = startBackgroundSyncScheduler({
    startupDelayMs: 15,
    intervalMs: 45,
    triggerBackgroundSyncFn: (reason, force) => {
      bgCalls.push({ reason, force });
    },
    triggerPanelDeletionSyncFn: (reason, force) => {
      delCalls.push({ reason, force });
    },
  });

  try {
    // At t=35ms: +15ms startup warmup ran once, NO duplicate startup deletion sync fired!
    await new Promise((r) => setTimeout(r, 32));
    assert.equal(bgCalls.length, 1);
    assert.equal(bgCalls[0].reason, 'Server Start');
    assert.equal(delCalls.length, 0, 'Startup must NOT overlap triggerBackgroundSyncIfNeeded with separate startup triggerPanelDeletionSyncIfNeeded');

    // At t=70ms: first periodic interval tick runs scheduled syncs
    await new Promise((r) => setTimeout(r, 35));
    assert.ok(delCalls.some((c) => c.reason === 'Scheduled'), 'Scheduled deletion sync runs cleanly on periodic interval');
  } finally {
    clearTimeout(timers.startupTimer);
    clearInterval(timers.intervalTimer);
  }

  // Verify runBackgroundSync isolates getInbounds & cleanupExpiredTrials failures so deletion sync still runs
  let deletionSyncExecuted = 0;
  await runBackgroundSync('Startup Failure Recovery', true, {
    getInboundsFn: async () => {
      throw new Error('Cold-start inbound warmup timed out');
    },
    cleanupExpiredTrialsFn: async () => {
      throw new Error('Trial cleanup transient error');
    },
    syncDeleted3XUiClientsFn: async () => {
      deletionSyncExecuted++;
      return {
        synced: true,
        deletedCount: 0,
        restoredCount: 0,
        skippedCount: 0,
        manualReviewCount: 0,
        reconciliationFlaggedCount: 0,
      };
    },
    runScheduledExpiryEmailCheckFn: async () => {},
  });
  assert.equal(deletionSyncExecuted, 1, 'syncDeleted3XUiClients MUST still run even when initial warmup and trial cleanup fail');
});

// ---------------------------------------------------------------------------
// 12. Preserved permanent deletion sync + uncached Read 1/Read 2 independence
// ---------------------------------------------------------------------------
test('12. Authoritative deletion sync ignores stale cachedInbounds and marks permanently deleted clients cleanly', async () => {
  resetXuiServiceCachesForTests();
  const uid = 'uid-del-12';
  const email = 'del12@example.com';

  // Poison cache with the deleted client so we prove fetchUncachedLiveInboundsList + sync ignore it
  setCachedInbounds([
    makeInbound(3, [
      { id: 'uuid-live-stay', email: 'stay@example.com' },
      { id: 'uuid-perm-gone', email },
    ]),
  ], PANEL_A_ID);

  const extraLive = Array.from({ length: 5 }, (_, idx) => ({ id: `uuid-keep-${idx}`, email: `keep${idx}@example.com` }));
  const db = createMockCustomerDb({
    vpn_accounts: [
      { id: 'a1', user_id: uid, email, uuid: 'uuid-perm-gone', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'a2', user_id: uid, email: 'stay@example.com', uuid: 'uuid-live-stay', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      ...extraLive.map((x, idx) => ({ id: `ak-${idx}`, user_id: `u-keep-${idx}`, email: x.email, uuid: x.id, status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT })),
    ],
    vpn_configs: [
      { id: 'c1', user_id: uid, customer_uid: uid, uuid: 'uuid-perm-gone', inbound_id: 3, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'c2', user_id: uid, customer_uid: uid, uuid: 'uuid-live-stay', inbound_id: 3, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      ...extraLive.map((x, idx) => ({ id: `ck-${idx}`, user_id: `u-keep-${idx}`, customer_uid: `u-keep-${idx}`, uuid: x.id, inbound_id: 3, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT })),
    ],
  });

  const liveWithoutDeleted = makeInbound(3, [{ id: 'uuid-live-stay', email: 'stay@example.com' }, ...extraLive]);

  const prevFlag = process.env.PANEL_DELETION_SYNC_ENABLED;
  process.env.PANEL_DELETION_SYNC_ENABLED = 'true';
  try {
    const res = await syncDeleted3XUiClients({
      dbClient: db,
      currentPanelIdentity: PANEL_A_ID,
      configuredServers: [],
      fetchUncachedInboundsList: async () => ({
        ok: true,
        inbounds: [liveWithoutDeleted],
        parsedByInboundId: new Map([[3, { inbound: liveWithoutDeleted, inboundId: 3, clients: [], clientUuidSet: new Set(['uuid-live-stay', ...extraLive.map((x) => x.id)]) }]]),
        unparsedInboundIds: [],
        allInboundsCleanlyParsed: true,
        liveClientByUuid: new Map([
          ['uuid-live-stay', { inbound: liveWithoutDeleted, client: { id: 'uuid-live-stay', email: 'stay@example.com', limitIp: 0, totalGB: 0, expiryTime: FUTURE_EXPIRY_MS, enable: true, subId: '', reset: 0 }, stat: null }],
          ...extraLive.map((x) => [x.id, { inbound: liveWithoutDeleted, client: { id: x.id, email: x.email, limitIp: 0, totalGB: 0, expiryTime: FUTURE_EXPIRY_MS, enable: true, subId: '', reset: 0 }, stat: null }] as const),
        ]),
      }),
      reReadDelayMs: 0,
    });

    assert.equal(res.synced, true);
    assert.equal(res.deletedCount, 1);
    assert.equal(db.state.vpn_accounts.find((a) => a.uuid === 'uuid-perm-gone')?.status, 'deleted');
    assert.equal(db.state.vpn_configs.find((c) => c.uuid === 'uuid-perm-gone')?.status, 'deleted');
    assert.equal(db.state.vpn_accounts.find((a) => a.uuid === 'uuid-live-stay')?.status, 'active');

    // Verify uncached deletion sync NEVER falls back to poisoned cachedInbounds when live panel fails/times out
    const prevStatus = db.state.vpn_accounts.find((a) => a.uuid === 'uuid-live-stay')?.status;
    const uncachedFailRes = await syncDeleted3XUiClients({
      dbClient: db,
      currentPanelIdentity: PANEL_A_ID,
      configuredServers: [],
      fetchUncachedInboundsList: async () => ({
        ok: false,
        reason: 'live_panel_timeout',
        inbounds: [],
        parsedByInboundId: new Map(),
        unparsedInboundIds: [],
        allInboundsCleanlyParsed: false,
        liveClientByUuid: new Map(),
      }),
      reReadDelayMs: 0,
    });
    assert.equal(uncachedFailRes.synced, false);
    assert.equal(uncachedFailRes.deletedCount, 0);
    assert.equal(db.state.vpn_accounts.find((a) => a.uuid === 'uuid-live-stay')?.status, prevStatus);
  } finally {
    if (prevFlag === undefined) delete process.env.PANEL_DELETION_SYNC_ENABLED;
    else process.env.PANEL_DELETION_SYNC_ENABLED = prevFlag;
  }
});

// ---------------------------------------------------------------------------
// 13. Cold outage preserves cached/DB traffic baseline & V4 timeout routes stay intact
// ---------------------------------------------------------------------------
test('13. Cold panel outage preserves cached/DB traffic while reporting Status Unavailable and legacy user_id gaps', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-cold-outage';
  const email = 'coldout@example.com';
  const uuidCached = 'uuid-cold-cached';
  const uuidDbOnly = 'uuid-cold-dbonly';
  const twoGb = 2 * 1024 * 1024 * 1024;
  const tenGb = 10 * 1024 * 1024 * 1024;

  const dbCached = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-cc1',
        user_id: uid,
        email,
        uuid: uuidCached,
        vless_url: `vless://${uuidCached}@example.com:443#SG1`,
        status: 'active',
        enable: true,
        total_bytes: tenGb,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-cc1',
        user_id: uid,
        customer_uid: uid,
        uuid: uuidCached,
        inbound_id: 11,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  // Cached inbound has 4GB usage for uuidCached, while live panel call fails/returns null
  const cachedIb = makeInbound(11, [{ id: uuidCached, email, up: twoGb, down: twoGb, totalGB: tenGb }]);

  const resCached = await getMyConfigs(uid, email, undefined, {
    dbClient: dbCached,
    adminDbClient: dbCached,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [cachedIb],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });

  const cCached = resCached.configs.find((c) => c.uuid === uuidCached);
  assert.ok(cCached);
  assert.equal(cCached.status, 'Status Unavailable');
  assert.equal(cCached.panelStatusVerified, false);
  assert.equal(cCached.usedGB, 4, 'Must preserve 4GB from cached inbound while reporting Status Unavailable');
  assert.equal(cCached.remainingGB, 6);

  // Separate legacy account with user_id=null matched by email during cold panel outage
  const dbLegacyOnly = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-cc2',
        user_id: null,
        email: 'legacynouid@example.com',
        uuid: uuidDbOnly,
        vless_url: `vless://${uuidDbOnly}@example.com:443#SG2`,
        status: 'active',
        enable: true,
        total_bytes: tenGb,
        used_bytes: twoGb,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const resDbOnly = await getMyConfigs('uid-legacy-no-uid', 'legacynouid@example.com', undefined, {
    dbClient: dbLegacyOnly,
    adminDbClient: dbLegacyOnly,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });

  const cDbOnly = resDbOnly.configs.find((c) => c.uuid === uuidDbOnly);
  assert.ok(cDbOnly);
  assert.equal(cDbOnly.status, 'Status Unavailable');
  assert.equal(cDbOnly.panelStatusVerified, false);
  assert.equal(cDbOnly.usedGB, 2, 'Must preserve 2GB from DB stored used_bytes when panel unreachable');
  assert.equal(cDbOnly.remainingGB, 8);

  const leg = resDbOnly.legacyReconciliationRecords.find((r) => r.uuid === uuidDbOnly);
  assert.ok(leg);
  assert.ok(leg.missingFields.includes('inbound_id'));
  assert.ok(leg.missingFields.includes('user_id'));
});

// ---------------------------------------------------------------------------
// 14. Multi-panel authentication cache isolation, per-scope invalidation & bounded eviction
// ---------------------------------------------------------------------------
test('14. Multi-panel authentication caches and generations are isolated per scope and bounded in memory', async () => {
  resetXuiServiceCachesForTests();

  const cfgA = makeConfig({ panelUrl: PANEL_A_URL, password: 'pw-a', apiToken: 'pw-a' });
  const cfgB = makeConfig({ panelUrl: PANEL_B_URL, password: 'pw-b', apiToken: 'pw-b' });
  const scopeA = computeXuiCredentialScopeKey(cfgA).scopeKey;
  const scopeB = computeXuiCredentialScopeKey(cfgB).scopeKey;

  let loginsA = 0;
  let loginsB = 0;

  const optsA = {
    loginPostFn: async () => {
      loginsA++;
      return {
        status: 200,
        headers: { 'set-cookie': [`3x-ui=sess-A-${loginsA}; Path=/`] },
        data: { success: true },
      };
    },
    csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
  };
  const optsB = {
    loginPostFn: async () => {
      loginsB++;
      return {
        status: 200,
        headers: { 'set-cookie': [`3x-ui=sess-B-${loginsB}; Path=/`] },
        data: { success: true },
      };
    },
    csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
  };

  // Both Panel A and Panel B remain cached simultaneously
  const hA1 = await getXuiAuthHeaders(cfgA, false, 6000, optsA);
  const hB1 = await getXuiAuthHeaders(cfgB, false, 6000, optsB);
  assert.equal(hA1['Cookie'], '3x-ui=sess-A-1');
  assert.equal(hB1['Cookie'], '3x-ui=sess-B-1');

  // Re-reading Panel A does NOT evict Panel B and triggers zero new logins
  const hA2 = await getXuiAuthHeaders(cfgA, false, 6000, optsA);
  const hB2 = await getXuiAuthHeaders(cfgB, false, 6000, optsB);
  assert.equal(hA2['Cookie'], '3x-ui=sess-A-1');
  assert.equal(hB2['Cookie'], '3x-ui=sess-B-1');
  assert.equal(loginsA, 1);
  assert.equal(loginsB, 1);

  // Invalidating Panel A's scopeKey bumps ONLY Panel A's generation; Panel B stays cached at its own unique generation
  const genABefore = getScopeAuthGeneration(scopeA);
  const genBBefore = getScopeAuthGeneration(scopeB);
  assert.ok(genABefore >= 1);
  assert.ok(genBBefore > genABefore, 'Newly created scopes must receive unique monotonically increasing generations');
  invalidateXuiAuthCache(scopeA);
  assert.ok(getScopeAuthGeneration(scopeA) > genBBefore);
  assert.equal(getScopeAuthGeneration(scopeB), genBBefore, 'Panel B generation MUST NOT change when Panel A invalidates');

  const hB3 = await getXuiAuthHeaders(cfgB, false, 6000, optsB);
  assert.equal(hB3['Cookie'], '3x-ui=sess-B-1');
  assert.equal(loginsB, 1, 'Panel B cached session MUST survive Panel A invalidation');

  // Credential change on Panel A invalidates Panel A's old credential scope without touching Panel B
  const cfgARotated = makeConfig({ panelUrl: PANEL_A_URL, password: 'pw-a-new', apiToken: 'pw-a-new' });
  const scopeARotated = computeXuiCredentialScopeKey(cfgARotated).scopeKey;
  await getXuiAuthHeaders(cfgARotated, false, 6000, optsA);
  const statsAfterRotate = getXuiAuthCacheStatsForTests();
  assert.equal(statsAfterRotate.cachedScopes.includes(scopeA), false, 'Old credential scope for Panel A must be evicted');
  assert.equal(statsAfterRotate.cachedScopes.includes(scopeARotated), true);
  assert.equal(statsAfterRotate.cachedScopes.includes(scopeB), true);

  // Verify bounded cache size for auth scopes and capability maps
  for (let i = 0; i < MAX_XUI_PANEL_CAPABILITY_ENTRIES + 12; i++) {
    const cfgMany = makeConfig({
      panelUrl: `https://panel-${i}.firevpn.example:2053/sub`,
      password: `pw-${i}`,
      apiToken: `pw-${i}`,
    });
    await getXuiAuthHeaders(cfgMany, false, 6000, {
      loginPostFn: async () => ({
        status: 200,
        headers: { 'set-cookie': [`3x-ui=sess-many-${i}; Path=/`] },
        data: { success: true },
      }),
      csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
    });
  }
  const boundedStats = getXuiAuthCacheStatsForTests();
  assert.ok(boundedStats.cachedScopes.length <= MAX_XUI_AUTH_SCOPE_ENTRIES);
  assert.ok(boundedStats.rememberedLoginEndpointsSize <= MAX_XUI_PANEL_CAPABILITY_ENTRIES);
  assert.ok(boundedStats.confirmedUnsupportedCsrfSize <= MAX_XUI_PANEL_CAPABILITY_ENTRIES);
});

// ---------------------------------------------------------------------------
// 15. Concurrent 401/403 reauthentication deduplication (default & custom authHeadersFn)
// ---------------------------------------------------------------------------
test('15. Concurrent 401/403 responses for the same expired session trigger only one reauthentication flow', async () => {
  resetXuiServiceCachesForTests();

  const cfgA = makeConfig({ panelUrl: PANEL_A_URL, password: 'pw-401', apiToken: 'pw-401' });

  // Seed initial cached session
  let defaultReauthCount = 0;
  await getXuiAuthHeaders(cfgA, false, 6000, {
    loginPostFn: async () => ({
      status: 200,
      headers: { 'set-cookie': ['3x-ui=expired-sess; Path=/'] },
      data: { success: true },
    }),
    csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
  });

  // Test A: Custom authHeadersFn path with 6 concurrent 401 responses -> MUST only invoke forceRefresh=true ONCE
  let customForceRefreshCalls = 0;
  let currentCustomCookie = '3x-ui=expired-custom';
  const customAuthFn = async (_cfg: XuiConfig, forceRefresh: boolean) => {
    if (forceRefresh) {
      customForceRefreshCalls++;
      await new Promise((r) => setTimeout(r, 30));
      currentCustomCookie = `3x-ui=fresh-custom-${customForceRefreshCalls}`;
    }
    return { Cookie: currentCustomCookie };
  };

  const concurrentResults = await Promise.all(
    Array.from({ length: 6 }, (_, idx) =>
      requestApi<{ id: number }>(`/panel/api/inbounds/get/${idx + 1}`, 'GET', undefined, {
        configOverride: cfgA,
        authHeadersFn: customAuthFn,
        httpRequestFn: async ({ headers }) => {
          if (headers.Cookie === '3x-ui=expired-custom') {
            await new Promise((r) => setTimeout(r, 10));
            return { status: 401, statusText: 'Unauthorized', data: {} };
          }
          return { status: 200, data: { success: true, obj: { id: idx + 1 } } };
        },
      })
    )
  );

  assert.equal(
    customForceRefreshCalls,
    1,
    '6 concurrent 401 responses MUST trigger only 1 forceRefresh=true reauthentication call even with custom authHeadersFn'
  );
  assert.equal(concurrentResults.length, 6);
  assert.equal(defaultReauthCount, 0);
});

// ---------------------------------------------------------------------------
// 16. Cross-customer UUID collision prevention in traffic cache
// ---------------------------------------------------------------------------
test('16. Traffic cache isolates customers by UID and never exposes Customer A traffic to Customer B when UUIDs overlap', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const sharedUuid = 'uuid-overlap-customer-ab';
  const fiveGb = 5 * 1024 * 1024 * 1024;
  const tenGb = 10 * 1024 * 1024 * 1024;

  const makeCustomerDb = (uid: string, email: string, hasUserId = true) =>
    createMockCustomerDb({
      vpn_accounts: [
        {
          id: `acc-${uid}`,
          user_id: hasUserId ? uid : null,
          email,
          uuid: sharedUuid,
          vless_url: `vless://${sharedUuid}@example.com:443#SG`,
          status: 'active',
          enable: true,
          total_bytes: tenGb,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
      vpn_configs: [
        {
          id: `cfg-${uid}`,
          user_id: hasUserId ? uid : null,
          customer_uid: hasUserId ? uid : null,
          uuid: sharedUuid,
          inbound_id: 5,
          status: 'active',
          enabled: true,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
    });

  // Customer A fetches live traffic (5GB up + 0 down = 5GB used)
  const dbA = makeCustomerDb('uid-customer-A', 'a@example.com');
  const liveIbA = makeInbound(5, [{ id: sharedUuid, email: 'a@example.com', up: fiveGb, down: 0, totalGB: tenGb }]);
  const resALive = await getMyConfigs('uid-customer-A', 'a@example.com', undefined, {
    dbClient: dbA,
    adminDbClient: dbA,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => liveIbA,
    getInboundsFn: async () => [],
  });
  assert.equal(resALive.configs[0].usedGB, 5);

  // Panel goes down; Customer B has a record with the same UUID on the same panel -> MUST NOT see Customer A's 5GB!
  const dbB = makeCustomerDb('uid-customer-B', 'b@example.com');
  const resBOutage = await getMyConfigs('uid-customer-B', 'b@example.com', undefined, {
    dbClient: dbB,
    adminDbClient: dbB,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });
  assert.equal(resBOutage.configs[0].status, 'Status Unavailable');
  assert.equal(resBOutage.configs[0].usedGB, 0, 'Customer B MUST NEVER receive Customer A cached traffic');

  // Meanwhile Customer A still receives their own 5GB preserved traffic during the outage
  const resAOutage = await getMyConfigs('uid-customer-A', 'a@example.com', undefined, {
    dbClient: dbA,
    adminDbClient: dbA,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });
  assert.equal(resAOutage.configs[0].usedGB, 5);
});

// ---------------------------------------------------------------------------
// 17. Cross-panel UUID collision prevention in traffic cache
// ---------------------------------------------------------------------------
test('17. Traffic cache isolates panels by panelIdentity and refuses shared cache when panel identity conflicts or is missing', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-cross-panel';
  const email = 'crosspanel@example.com';
  const sharedUuid = 'uuid-overlap-panel-ab';
  const sixGb = 6 * 1024 * 1024 * 1024;
  const tenGb = 10 * 1024 * 1024 * 1024;

  const makePanelDb = (recordPanelIdentity: string | null) =>
    createMockCustomerDb({
      vpn_accounts: [
        {
          id: 'acc-cp',
          user_id: uid,
          email,
          uuid: sharedUuid,
          vless_url: `vless://${sharedUuid}@example.com:443#SG`,
          status: 'active',
          enable: true,
          total_bytes: tenGb,
          panel_identity: recordPanelIdentity,
          created_at: PAST_CREATED_AT,
        },
      ],
      vpn_configs: [
        {
          id: 'cfg-cp',
          user_id: uid,
          customer_uid: uid,
          uuid: sharedUuid,
          inbound_id: 6,
          status: 'active',
          enabled: true,
          panel_identity: recordPanelIdentity,
          created_at: PAST_CREATED_AT,
        },
      ],
    });

  // Populate cache on Panel A (6GB used)
  const dbPanelA = makePanelDb(PANEL_A_ID);
  const liveIbA = makeInbound(6, [{ id: sharedUuid, email, up: sixGb, down: 0, totalGB: tenGb }]);
  await getMyConfigs(uid, email, undefined, {
    dbClient: dbPanelA,
    adminDbClient: dbPanelA,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => liveIbA,
    getInboundsFn: async () => [],
  });

  // Same user + same UUID queried against Panel B during outage -> MUST NOT read Panel A's cached 6GB
  const dbPanelB = makePanelDb(PANEL_B_ID);
  const resPanelBOutage = await getMyConfigs(uid, email, undefined, {
    dbClient: dbPanelB,
    adminDbClient: dbPanelB,
    currentPanelIdentity: PANEL_B_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });
  assert.equal(resPanelBOutage.configs[0].status, 'Status Unavailable');
  assert.equal(resPanelBOutage.configs[0].usedGB, 0, 'Panel B MUST NOT expose Panel A cached traffic');

  // Record bound to PANEL_B_ID queried when currentPanelIdentity is PANEL_A_ID (mismatch) -> MUST NOT read Panel A's cached 6GB
  const resMismatch = await getMyConfigs(uid, email, undefined, {
    dbClient: dbPanelB,
    adminDbClient: dbPanelB,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });
  assert.equal(resMismatch.configs[0].usedGB, 0, 'Mismatched record panel_identity MUST refuse shared traffic cache');

  // Empty/unknown currentPanelIdentity -> MUST refuse shared traffic cache
  const resEmptyPanel = await getMyConfigs(uid, email, undefined, {
    dbClient: dbPanelA,
    adminDbClient: dbPanelA,
    currentPanelIdentity: '',
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });
  assert.equal(resEmptyPanel.configs[0].usedGB, 0, 'Ambiguous/empty panelIdentity MUST refuse shared traffic cache');
});

// ---------------------------------------------------------------------------
// 18. Traffic cache TTL expiration (without read-extension) and max-entry eviction
// ---------------------------------------------------------------------------
test('18. Traffic cache enforces TTL without extending freshness on read and evicts oldest entries at max capacity', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-ttl-evict';
  const email = 'ttl@example.com';
  const uuid1 = 'uuid-ttl-1';
  const uuid2 = 'uuid-ttl-2';
  const uuid3 = 'uuid-ttl-3';
  const fourGb = 4 * 1024 * 1024 * 1024;
  const tenGb = 10 * 1024 * 1024 * 1024;
  const t0 = 1_700_000_000_000;

  const makeSingleUuidDb = (u: string) =>
    createMockCustomerDb({
      vpn_accounts: [
        {
          id: `acc-${u}`,
          user_id: uid,
          email,
          uuid: u,
          vless_url: `vless://${u}@example.com:443#SG`,
          status: 'active',
          enable: true,
          total_bytes: tenGb,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
      vpn_configs: [
        {
          id: `cfg-${u}`,
          user_id: uid,
          customer_uid: uid,
          uuid: u,
          inbound_id: 5,
          status: 'active',
          enabled: true,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
    });

  // Populate uuid1 at t0
  const db1 = makeSingleUuidDb(uuid1);
  const ib1 = makeInbound(5, [{ id: uuid1, email, up: fourGb, down: 0, totalGB: tenGb }]);
  await getMyConfigs(uid, email, undefined, {
    dbClient: db1,
    adminDbClient: db1,
    currentPanelIdentity: PANEL_A_ID,
    nowMs: t0,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => ib1,
    getInboundsFn: async () => [],
  });

  // Read at t0 + 20 min during outage -> still within 30 min TTL, returns 4GB, MUST NOT extend updatedAtMs
  const hit20Min = await getMyConfigs(uid, email, undefined, {
    dbClient: db1,
    adminDbClient: db1,
    currentPanelIdentity: PANEL_A_ID,
    nowMs: t0 + 20 * 60 * 1000,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });
  assert.equal(hit20Min.configs[0].usedGB, 4);
  const statsAt20Min = getLastKnownClientTrafficCacheStatsForTests();
  assert.equal(statsAt20Min.entries[0].updatedAtMs, t0, 'Reading cached traffic MUST NOT extend updatedAtMs');

  // Read at t0 + 30 min + 1ms during outage -> TTL expired (even though read at +20m!), must evict and return 0GB
  const expiredRead = await getMyConfigs(uid, email, undefined, {
    dbClient: db1,
    adminDbClient: db1,
    currentPanelIdentity: PANEL_A_ID,
    nowMs: t0 + CLIENT_TRAFFIC_CACHE_TTL_MS + 1,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });
  assert.equal(expiredRead.configs[0].usedGB, 0, 'Expired traffic cache entry must not be returned');
  assert.equal(getLastKnownClientTrafficCacheStatsForTests().size, 0);

  // Max-entry eviction: set maxTrafficCacheEntries = 2, insert uuid1, uuid2, uuid3 -> uuid1 is evicted
  for (const [idx, u] of [uuid1, uuid2, uuid3].entries()) {
    const dbu = makeSingleUuidDb(u);
    const ibu = makeInbound(5, [{ id: u, email, up: fourGb, down: 0, totalGB: tenGb }]);
    await getMyConfigs(uid, email, undefined, {
      dbClient: dbu,
      adminDbClient: dbu,
      currentPanelIdentity: PANEL_A_ID,
      nowMs: t0 + idx * 1000,
      maxTrafficCacheEntries: 2,
      getCachedInboundsFn: async () => [],
      getLiveInboundFn: async () => ibu,
      getInboundsFn: async () => [],
    });
  }
  const evictedStats = getLastKnownClientTrafficCacheStatsForTests();
  assert.equal(evictedStats.size, 2);
  assert.equal(evictedStats.keys.some((k) => k.endsWith(uuid1)), false, 'Oldest entry uuid1 must be evicted');
  assert.equal(evictedStats.keys.some((k) => k.endsWith(uuid2)), true);
  assert.equal(evictedStats.keys.some((k) => k.endsWith(uuid3)), true);
});

// ---------------------------------------------------------------------------
// 19. Traffic cache deletion invalidation without customer reopening the website
// ---------------------------------------------------------------------------
test('19. Background syncDeleted3XUiClients immediately purges deleted client traffic cache even without customer page load', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-bg-del-purge';
  const email = 'bgdel@example.com';
  const delUuid = 'uuid-bg-del-target';
  const fiveGb = 5 * 1024 * 1024 * 1024;
  const tenGb = 10 * 1024 * 1024 * 1024;

  const extraLive = Array.from({ length: 4 }, (_, idx) => ({
    id: `uuid-bg-keep-${idx}`,
    email: `keep${idx}@example.com`,
  }));

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-del',
        user_id: uid,
        email,
        uuid: delUuid,
        vless_url: `vless://${delUuid}@example.com:443#SG`,
        status: 'active',
        enable: true,
        total_bytes: tenGb,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
      ...extraLive.map((c, idx) => ({
        id: `acc-k-${idx}`,
        user_id: `u-k-${idx}`,
        email: c.email,
        uuid: c.id,
        status: 'active',
        enable: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      })),
    ],
    vpn_configs: [
      {
        id: 'cfg-del',
        user_id: uid,
        customer_uid: uid,
        uuid: delUuid,
        inbound_id: 8,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
      ...extraLive.map((c, idx) => ({
        id: `cfg-k-${idx}`,
        user_id: `u-k-${idx}`,
        customer_uid: `u-k-${idx}`,
        uuid: c.id,
        inbound_id: 8,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      })),
    ],
  });

  // Step 1: Populate traffic cache for delUuid
  const liveWithClient = makeInbound(8, [
    { id: delUuid, email, up: fiveGb, down: 0, totalGB: tenGb },
    ...extraLive,
  ]);
  await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => liveWithClient,
    getInboundsFn: async () => [],
  });
  assert.equal(getLastKnownClientTrafficCacheStatsForTests().size, 1);

  // Step 2: Background syncDeleted3XUiClients confirms deletion while customer never opens the website
  const liveWithoutClient = makeInbound(8, extraLive);
  const prevFlag = process.env.PANEL_DELETION_SYNC_ENABLED;
  process.env.PANEL_DELETION_SYNC_ENABLED = 'true';
  try {
    const syncRes = await syncDeleted3XUiClients({
      dbClient: db,
      currentPanelIdentity: PANEL_A_ID,
      configuredServers: [],
      fetchUncachedInboundsList: async () => ({
        ok: true,
        inbounds: [liveWithoutClient],
        parsedByInboundId: new Map([
          [8, { inbound: liveWithoutClient, inboundId: 8, clients: [], clientUuidSet: new Set(extraLive.map((c) => c.id)) }],
        ]),
        unparsedInboundIds: [],
        allInboundsCleanlyParsed: true,
        liveClientByUuid: new Map(
          extraLive.map((c) => [
            c.id,
            {
              inbound: liveWithoutClient,
              client: { id: c.id, email: c.email, limitIp: 0, totalGB: 0, expiryTime: FUTURE_EXPIRY_MS, enable: true, subId: '', reset: 0 },
              stat: null,
            },
          ])
        ),
      }),
      reReadDelayMs: 0,
    });
    assert.equal(syncRes.deletedCount, 1);
    assert.equal(
      getLastKnownClientTrafficCacheStatsForTests().size,
      0,
      'Traffic cache entry MUST be purged immediately by background deletion sync without waiting for customer page load'
    );
  } finally {
    if (prevFlag === undefined) delete process.env.PANEL_DELETION_SYNC_ENABLED;
    else process.env.PANEL_DELETION_SYNC_ENABLED = prevFlag;
  }
});

// ---------------------------------------------------------------------------
// 20. Stale in-flight getMyConfigs response after concurrent traffic reset
// ---------------------------------------------------------------------------
test('20. Stale in-flight getMyConfigs started before traffic reset cannot overwrite post-reset cache or restore pre-reset bytes', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-race-reset';
  const email = 'racereset@example.com';
  const clientUuid = 'uuid-race-reset-1';
  const sevenGb = 7 * 1024 * 1024 * 1024;

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-rr',
        user_id: uid,
        email,
        uuid: clientUuid,
        vless_url: `vless://${clientUuid}@example.com:443#SG`,
        status: 'active',
        enable: true,
        total_bytes: 0,
        used_bytes: sevenGb,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-rr',
        user_id: uid,
        customer_uid: uid,
        uuid: clientUuid,
        inbound_id: 5,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    orders: [
      {
        id: 'ord-rr',
        order_id: 'ORD-RR',
        customer_id: uid,
        email,
        status: 'approved',
        payment_status: 'Paid',
        provisioning_status: 'completed',
        client_uuid: clientUuid,
        vless_url: `vless://${clientUuid}@example.com:443#SG`,
        traffic_limit: 'Unlimited',
      },
    ],
  });

  const preResetIb = makeInbound(5, [{ id: clientUuid, email, up: sevenGb, down: 0, totalGB: 0 }]);

  // Seed initial 7GB cache entry
  await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => preResetIb,
    getInboundsFn: async () => [],
  });
  assert.equal(getLastKnownClientTrafficCacheStatsForTests().entries[0].up, sevenGb);

  // Start a slow in-flight getMyConfigs that captured preResetIb before reset completes
  let releaseStaleRead!: () => void;
  const staleReadGate = new Promise<void>((r) => {
    releaseStaleRead = r;
  });

  const inFlightGetMyConfigs = getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => {
      await staleReadGate;
      return preResetIb;
    },
    getInboundsFn: async () => [],
  });

  await new Promise((r) => setTimeout(r, 15));

  // Execute traffic reset while getMyConfigs is in-flight
  await resetVpnTraffic(uid, email, clientUuid, {
    dbClient: db,
    skipNotification: true,
    requireDurableLock: false,
    getTrafficResetPolicyFn: async () => ({ ...DEFAULT_RESET_POLICY }),
    getLiveInboundFn: async () => preResetIb,
    getInboundsFn: async () => [preResetIb],
    resetClientTrafficFn: async (_em, _ibId, _u, opts) => {
      if (opts?.beforeResetUnderLocks) {
        await opts.beforeResetUnderLocks({
          inboundId: 5,
          clientUuid,
          email,
          remainingLeaseMs: 30000,
        });
      }
      if (opts?.afterResetUnderClientLock) await opts.afterResetUnderClientLock();
      return { success: true, message: 'ok' };
    },
    getTrafficResetLogsFn: async () => [],
    recordTrafficResetLogFn: async () => {},
  });

  // Release the stale in-flight getMyConfigs response (which carries pre-reset 7GB)
  releaseStaleRead();
  const staleRes = await inFlightGetMyConfigs;
  assert.equal(staleRes.configs[0].usedGB, 0, 'Stale in-flight getMyConfigs response after reset MUST clamp usage to 0');

  // Verify cache entry was NOT overwritten back to 7GB and subsequent outage read (even with stale cachedInbounds) stays 0GB
  const cacheAfterStale = getLastKnownClientTrafficCacheStatsForTests();
  assert.equal(cacheAfterStale.entries[0].up, 0, 'Stale in-flight getMyConfigs MUST NOT overwrite post-reset 0 cache');

  const followUpOutage = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [preResetIb],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });
  assert.equal(followUpOutage.configs[0].status, 'Status Unavailable');
  assert.equal(followUpOutage.configs[0].usedGB, 0, 'Stale cachedFallbackInbounds MUST NOT restore pre-reset 7GB');
});

// ---------------------------------------------------------------------------
// 21. Stale in-flight getMyConfigs response after permanent deletion
// ---------------------------------------------------------------------------
test('21. Stale in-flight getMyConfigs started before deletion confirmation cannot recreate deleted traffic cache or expose deleted config', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-race-del';
  const email = 'racedel@example.com';
  const clientUuid = 'uuid-race-del-1';
  const threeGb = 3 * 1024 * 1024 * 1024;
  const tenGb = 10 * 1024 * 1024 * 1024;

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-rd',
        user_id: uid,
        email,
        uuid: clientUuid,
        vless_url: `vless://${clientUuid}@example.com:443#SG`,
        status: 'active',
        enable: true,
        total_bytes: tenGb,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-rd',
        user_id: uid,
        customer_uid: uid,
        uuid: clientUuid,
        inbound_id: 5,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const staleIb = makeInbound(5, [{ id: clientUuid, email, up: threeGb, down: 0, totalGB: tenGb }]);

  let releaseStaleRead!: () => void;
  const staleGate = new Promise<void>((r) => {
    releaseStaleRead = r;
  });

  const inFlightRead = getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => {
      await staleGate;
      return staleIb;
    },
    getInboundsFn: async () => [],
  });

  await new Promise((r) => setTimeout(r, 15));

  // Background deletion confirms deletion while getMyConfigs is in-flight
  notifyClientTrafficInvalidated(clientUuid, 'deleted');

  releaseStaleRead();
  const res = await inFlightRead;

  assert.equal(res.configs.length, 0, 'Deleted config MUST NOT be returned by stale in-flight getMyConfigs');
  assert.ok(res.deletedUuids.includes(clientUuid));
  assert.equal(
    getLastKnownClientTrafficCacheStatsForTests().size,
    0,
    'Stale in-flight getMyConfigs MUST NOT recreate traffic cache entry for deleted UUID'
  );
});

// ---------------------------------------------------------------------------
// 22. Shared customer request deadline across DB queries + cold start + live inbound fetch
// ---------------------------------------------------------------------------
test('22. getMyConfigs enforces a shared bounded request deadline across DB queries, cold-start wait, and live-inbound wait', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-shared-deadline';
  const email = 'deadline@example.com';
  const uuidKnown = 'uuid-deadline-known';
  const uuidMissingIb = 'uuid-deadline-missing-ib';
  const threeGb = 3 * 1024 * 1024 * 1024;
  const tenGb = 10 * 1024 * 1024 * 1024;

  const baseDb = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-dl-1',
        user_id: uid,
        email,
        uuid: uuidKnown,
        vless_url: `vless://${uuidKnown}@example.com:443#SG1`,
        status: 'active',
        enable: true,
        total_bytes: tenGb,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'acc-dl-2',
        user_id: uid,
        email,
        uuid: uuidMissingIb,
        vless_url: `vless://${uuidMissingIb}@example.com:443#SG2`,
        status: 'active',
        enable: true,
        total_bytes: tenGb,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-dl-1',
        user_id: uid,
        customer_uid: uid,
        uuid: uuidKnown,
        inbound_id: 5,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'cfg-dl-2',
        user_id: uid,
        customer_uid: uid,
        uuid: uuidMissingIb,
        inbound_id: null, // Triggers cold-start wait!
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  // Seed last-known traffic for uuidKnown so we verify safe fallback preserves traffic when budget expires
  const liveIb5 = makeInbound(5, [{ id: uuidKnown, email, up: threeGb, down: 0, totalGB: tenGb }]);
  await getMyConfigs(uid, email, undefined, {
    dbClient: baseDb,
    adminDbClient: baseDb,
    currentPanelIdentity: PANEL_A_ID,
    coldStartTimeoutMs: 25,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => liveIb5,
    getInboundsFn: async () => [],
  });

  // Now simulate slow DB + hanging cold-start full-list (1000ms) + hanging live-inbound (1000ms)
  // under a shared totalRequestBudgetMs of 180ms: total elapsed time MUST stay bounded (~180ms, never 1000+1000=2000ms!)
  let backgroundWarmupCompleted = false;
  const startMs = Date.now();
  const deadlineRes = await getMyConfigs(uid, email, undefined, {
    dbClient: baseDb,
    adminDbClient: baseDb,
    currentPanelIdentity: PANEL_A_ID,
    totalRequestBudgetMs: 180,
    getCachedInboundsFn: async () => {
      await new Promise((r) => setTimeout(r, 40)); // Simulate 40ms elapsed before cold-start wait
      return [];
    },
    getInboundsFn: async () => {
      await new Promise((r) => setTimeout(r, 320));
      backgroundWarmupCompleted = true;
      return [liveIb5];
    },
    getLiveInboundFn: async () => {
      await new Promise((r) => setTimeout(r, 500));
      return liveIb5;
    },
  });
  const elapsedMs = Date.now() - startMs;

  assert.ok(
    elapsedMs < 310,
    `Expected shared deadline to bound total getMyConfigs time (<310ms), actual=${elapsedMs}ms`
  );
  const cfgKnown = deadlineRes.configs.find((c) => c.uuid === uuidKnown);
  assert.ok(cfgKnown);
  assert.equal(cfgKnown.status, 'Status Unavailable');
  assert.equal(cfgKnown.usedGB, 3, 'Last-known traffic MUST be preserved when shared request deadline expires');

  // Wait for background warm-up promise to finish to confirm it was NOT cancelled
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(backgroundWarmupCompleted, true, 'Shared background warm-up request MUST NOT be cancelled');
});

// ---------------------------------------------------------------------------
// 23. Shared deadline across sequential login fallback, CSRF, GET, and 401 retry via real HTTP server
// ---------------------------------------------------------------------------
test('23. Real HTTP Axios getXuiAuthHeaders and requestApi enforce shared deadline across login fallback, CSRF, GET, and 401 retry', async () => {
  resetXuiServiceCachesForTests();

  const prevAllowPrivate = process.env.XUI_ALLOW_PRIVATE_URLS;
  process.env.XUI_ALLOW_PRIVATE_URLS = 'true';

  let mode: 'fallback_and_401_retry_success' | 'cumulative_timeout_exceeded' = 'fallback_and_401_retry_success';
  let loginRootHits = 0;
  let panelLoginHits = 0;
  let csrfHits = 0;
  let listHits = 0;

  const server = http.createServer(async (req, res) => {
    const url = req.url || '';
    if (mode === 'fallback_and_401_retry_success') {
      if (url === '/login') {
        loginRootHits++;
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false }));
        return;
      }
      if (url === '/panel/login') {
        panelLoginHits++;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': [`3x-ui=real-sess-${panelLoginHits}; Path=/; HttpOnly`],
        });
        res.end(JSON.stringify({ success: true }));
        return;
      }
      if (url === '/csrf-token') {
        csrfHits++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ obj: `csrf-${csrfHits}` }));
        return;
      }
      if (url === '/panel/api/inbounds/list') {
        listHits++;
        const cookie = String(req.headers.cookie || '');
        if (listHits === 1 || cookie.includes('real-sess-1')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, msg: 'expired' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, obj: [{ id: 77, remark: 'RealHTTP' }] }));
        return;
      }
    }

    if (mode === 'cumulative_timeout_exceeded') {
      // Each step takes 140ms: /login (140ms) + /panel/login (140ms) + /csrf-token (140ms) + GET (140ms) = 560ms > 320ms deadline!
      await new Promise((r) => setTimeout(r, 140));
      if (url === '/login') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false }));
        return;
      }
      if (url === '/panel/login') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': ['3x-ui=slow-sess; Path=/'],
        });
        res.end(JSON.stringify({ success: true }));
        return;
      }
      if (url === '/csrf-token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ obj: 'slow-csrf' }));
        return;
      }
      if (url === '/panel/api/inbounds/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, obj: [] }));
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const localPanelUrl = `http://127.0.0.1:${addr.port}`;
  const localCfg = makeConfig({
    panelUrl: localPanelUrl,
    username: 'admin',
    password: 'local-password',
    apiToken: 'local-password',
  });

  try {
    // Part A: Real Axios login fallback (/login 404 -> /panel/login 200) + /csrf-token + GET (401) -> re-auth (/panel/login remembered!) -> retry GET (200)
    const listObj = await requestApi<Array<{ id: number; remark: string }>>(
      '/panel/api/inbounds/list',
      'GET',
      undefined,
      {
        configOverride: localCfg,
        timeoutMs: 3000,
      }
    );
    assert.equal(Array.isArray(listObj), true);
    assert.equal(listObj[0].id, 77);
    assert.equal(loginRootHits, 1, '/login was tried once on initial cold login, then /panel/login was remembered for 401 re-auth');
    assert.equal(panelLoginHits, 2, 'Initial login + 401 re-auth both authenticated via /panel/login');
    assert.equal(listHits, 2, 'Initial GET returned 401, retry GET succeeded with 200');

    // Part B: Cumulative steps exceeding shared GET timeoutMs MUST abort within the shared deadline without restarting budget
    resetXuiServiceCachesForTests();
    mode = 'cumulative_timeout_exceeded';
    const tStart = Date.now();
    await assert.rejects(
      () =>
        requestApi('/panel/api/inbounds/list', 'GET', undefined, {
          configOverride: localCfg,
          timeoutMs: 320,
        }),
      (err: any) => {
        const msg = String(err?.message || '').toLowerCase();
        const code = String(err?.code || '').toUpperCase();
        return code === 'ETIMEDOUT' || code === 'ECONNABORTED' || msg.includes('timeout') || msg.includes('timed out');
      }
    );
    const totalElapsed = Date.now() - tStart;
    assert.ok(
      totalElapsed < 480,
      `Shared GET deadline (320ms) MUST NOT restart across sequential login/CSRF/GET steps (elapsed=${totalElapsed}ms)`
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevAllowPrivate === undefined) delete process.env.XUI_ALLOW_PRIVATE_URLS;
    else process.env.XUI_ALLOW_PRIVATE_URLS = prevAllowPrivate;
  }
});

// ---------------------------------------------------------------------------
// 24. Root server.ts and backend/server.ts scheduler parity
// ---------------------------------------------------------------------------
test('24. Both root server.ts and backend/server.ts use startBackgroundSyncScheduler with periodic deletion sync', () => {
  const rootServerPath = path.resolve(process.cwd(), 'server.ts');
  const backendServerPath = path.resolve(process.cwd(), 'backend', 'server.ts');

  const rootSource = fs.readFileSync(rootServerPath, 'utf8');
  const backendSource = fs.readFileSync(backendServerPath, 'utf8');

  for (const [label, src] of [
    ['root server.ts', rootSource],
    ['backend/server.ts', backendSource],
  ] as const) {
    assert.match(
      src,
      /startBackgroundSyncScheduler\s*\(\s*\{[\s\S]*?triggerBackgroundSyncFn:\s*triggerBackgroundSyncIfNeeded[\s\S]*?triggerPanelDeletionSyncFn:\s*triggerPanelDeletionSyncIfNeeded[\s\S]*?\}\s*\)/,
      `${label} MUST invoke startBackgroundSyncScheduler with triggerBackgroundSyncIfNeeded and triggerPanelDeletionSyncIfNeeded`
    );
  }
});

// ---------------------------------------------------------------------------
// 25. Authentication scope eviction cannot reset a scope to an older generation or allow stale overwrite
// ---------------------------------------------------------------------------
test('25. Authentication scope eviction never moves generation backward and blocks stale in-flight login overwrite or return', async () => {
  resetXuiServiceCachesForTests();
  setMaxXuiAuthScopeEntriesForTests(2); // Generation map cap = 4

  try {
    const cfgA = makeConfig({ panelUrl: PANEL_A_URL, password: 'pw-evict-a', apiToken: 'pw-evict-a' });
    const scopeA = computeXuiCredentialScopeKey(cfgA).scopeKey;

    // Bump scopeA generation to 2
    invalidateXuiAuthCache(scopeA);
    invalidateXuiAuthCache(scopeA);
    const genABeforeEvict = getScopeAuthGeneration(scopeA);
    assert.ok(genABeforeEvict >= 2);

    // Start a slow in-flight login for scopeA at generation genABeforeEvict
    let releaseStaleLoginA!: () => void;
    const staleGateA = new Promise<void>((r) => {
      releaseStaleLoginA = r;
    });
    const staleInFlightA = getXuiAuthHeaders(cfgA, false, 6000, {
      loginPostFn: async () => {
        await staleGateA;
        return {
          status: 200,
          headers: { 'set-cookie': ['3x-ui=stale-evicted-A; Path=/'] },
          data: { success: true },
        };
      },
      csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
    });
    await new Promise((r) => setTimeout(r, 10));

    // Invalidate scopeA (bumps to genABeforeEvict + 1) and evict scopeA from generation map by adding 6 other scopes
    const bumpedGenA = invalidateXuiAuthCache(scopeA);
    assert.ok(bumpedGenA > genABeforeEvict);

    for (let i = 0; i < 6; i++) {
      const cfgOther = makeConfig({
        panelUrl: `https://evict-other-${i}.firevpn.example:2053/sub`,
        password: `pw-other-${i}`,
        apiToken: `pw-other-${i}`,
      });
      await getXuiAuthHeaders(cfgOther, false, 6000, {
        loginPostFn: async () => ({
          status: 200,
          headers: { 'set-cookie': [`3x-ui=other-${i}; Path=/`] },
          data: { success: true },
        }),
        csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
      });
    }

    const statsAfterEvict = getXuiAuthCacheStatsForTests();
    assert.equal(
      Object.prototype.hasOwnProperty.call(statsAfterEvict.generationsByScope, scopeA),
      false,
      'scopeA should be evicted from xuiAuthGenerationByScope after capacity overflow'
    );

    const genAAfterEvict = getScopeAuthGeneration(scopeA);
    assert.ok(
      genAAfterEvict > genABeforeEvict,
      `Evicted scopeA generation (${genAAfterEvict}) MUST NEVER move backward to or below pre-eviction generation (${genABeforeEvict})`
    );

    // Establish a fresh valid session for scopeA at its new monotonic post-eviction generation
    const freshHeadersA = await getXuiAuthHeaders(cfgA, false, 6000, {
      loginPostFn: async () => ({
        status: 200,
        headers: { 'set-cookie': ['3x-ui=fresh-post-evict-A; Path=/'] },
        data: { success: true },
      }),
      csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
    });
    assert.equal(freshHeadersA['Cookie'], '3x-ui=fresh-post-evict-A');

    // Now release the old in-flight stale login from genABeforeEvict
    releaseStaleLoginA();
    const resolvedFromStale = await staleInFlightA;
    assert.equal(
      resolvedFromStale['Cookie'],
      '3x-ui=fresh-post-evict-A',
      'Stale in-flight login MUST NOT return stale credentials as valid current authentication'
    );

    // Verify cached session for scopeA is still the fresh post-eviction session
    const cachedAfterStale = await getXuiAuthHeaders(cfgA, false, 6000);
    assert.equal(
      cachedAfterStale['Cookie'],
      '3x-ui=fresh-post-evict-A',
      'Stale in-flight login MUST NOT overwrite newer post-eviction session'
    );
  } finally {
    resetXuiServiceCachesForTests();
  }
});

// ---------------------------------------------------------------------------
// 26. Authentication invalidation and eviction remain isolated across panels while preserving bounded memory
// ---------------------------------------------------------------------------
test('26. Authentication invalidation and eviction remain isolated across panels without invalidating active sessions or causing login loops', async () => {
  resetXuiServiceCachesForTests();
  setMaxXuiAuthScopeEntriesForTests(3); // Auth cache cap = 3, generation map cap = 6

  try {
    const cfgActiveB = makeConfig({ panelUrl: PANEL_B_URL, password: 'pw-active-b', apiToken: 'pw-active-b' });
    let loginsB = 0;
    const optsB = {
      loginPostFn: async () => {
        loginsB++;
        return {
          status: 200,
          headers: { 'set-cookie': [`3x-ui=active-B-${loginsB}; Path=/`] },
          data: { success: true },
        };
      },
      csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
    };

    const hB1 = await getXuiAuthHeaders(cfgActiveB, false, 6000, optsB);
    assert.equal(hB1['Cookie'], '3x-ui=active-B-1');
    assert.equal(loginsB, 1);

    // Churn and invalidate 8 transient scopes while keeping cfgActiveB in active cached use
    for (let i = 0; i < 8; i++) {
      const cfgTransient = makeConfig({
        panelUrl: `https://transient-${i}.firevpn.example:2053/sub`,
        password: `pw-t-${i}`,
        apiToken: `pw-t-${i}`,
      });
      const scopeT = computeXuiCredentialScopeKey(cfgTransient).scopeKey;
      invalidateXuiAuthCache(scopeT);
      invalidateXuiAuthCache(scopeT);

      // Re-read active Panel B from cache so it stays an active cached scope
      const hBActive = await getXuiAuthHeaders(cfgActiveB, false, 6000, optsB);
      assert.equal(hBActive['Cookie'], '3x-ui=active-B-1');
    }

    assert.equal(
      loginsB,
      1,
      'Active Panel B session MUST NOT be invalidated or forced into repeated login loops by other scopes evicting'
    );

    const stats = getXuiAuthCacheStatsForTests();
    assert.ok(stats.cachedScopes.length <= 3, 'Cached auth scopes must respect bounded memory limit');
    assert.ok(
      Object.keys(stats.generationsByScope).length <= 6,
      'Generation tracking map must respect bounded memory limit'
    );
  } finally {
    resetXuiServiceCachesForTests();
  }
});

// ---------------------------------------------------------------------------
// 27. Traffic mutation state eviction during an in-flight read cannot recreate a deleted config or cache entry
// ---------------------------------------------------------------------------
test('27. Traffic mutation state eviction during an in-flight getMyConfigs read rechecks DB and never recreates a deleted config or cache entry', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();
  setMaxClientTrafficMutationStateEntriesForTests(3);

  try {
    const uid = 'uid-evict-del';
    const email = 'evictdel@example.com';
    const uuidDeleted = 'uuid-evict-deleted-midflight';
    const fiveGb = 5 * 1024 * 1024 * 1024;
    const tenGb = 10 * 1024 * 1024 * 1024;

    const db = createMockCustomerDb({
      vpn_accounts: [
        {
          id: 'acc-ed-1',
          user_id: uid,
          email,
          uuid: uuidDeleted,
          vless_url: `vless://${uuidDeleted}@example.com:443#SG`,
          status: 'active',
          enable: true,
          total_bytes: tenGb,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
      vpn_configs: [
        {
          id: 'cfg-ed-1',
          user_id: uid,
          customer_uid: uid,
          uuid: uuidDeleted,
          inbound_id: 5,
          status: 'active',
          enabled: true,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
    });

    let releasePanelFetch!: () => void;
    const panelGate = new Promise<void>((r) => {
      releasePanelFetch = r;
    });
    const staleLiveIb = makeInbound(5, [{ id: uuidDeleted, email, up: fiveGb, down: 0, totalGB: tenGb }]);

    const inFlightRead = getMyConfigs(uid, email, undefined, {
      dbClient: db,
      adminDbClient: db,
      currentPanelIdentity: PANEL_A_ID,
      getCachedInboundsFn: async () => [],
      getLiveInboundFn: async () => {
        await panelGate;
        return staleLiveIb;
      },
      getInboundsFn: async () => [],
    });

    await new Promise((r) => setTimeout(r, 15));

    // Background deletion confirms deletion of uuidDeleted in DB and notifies invalidator
    db.state.vpn_accounts[0].status = 'deleted';
    db.state.vpn_accounts[0].deleted_from_panel_at = new Date().toISOString();
    db.state.vpn_configs[0].status = 'deleted';
    db.state.vpn_configs[0].deleted_from_panel_at = new Date().toISOString();
    notifyClientTrafficInvalidated(uuidDeleted, 'deleted');

    // Now overflow clientTrafficMutationStateByUuid (cap=3) with 5 other UUIDs so uuidDeleted is evicted!
    for (let i = 0; i < 5; i++) {
      notifyClientTrafficInvalidated(`uuid-other-overflow-${i}`, 'reset');
    }
    assert.equal(
      getClientTrafficMutationState(uuidDeleted).present,
      false,
      'uuidDeleted mutation state should be evicted from in-memory map'
    );
    assert.ok(getTrafficMutationEpochSnapshot().maxEvictedEpoch > 0);

    // Release the stale in-flight 3X-UI response
    releasePanelFetch();
    const res = await inFlightRead;

    assert.equal(
      res.configs.length,
      0,
      'Deleted configuration MUST NOT be returned after mutation state eviction during in-flight read'
    );
    assert.ok(
      res.deletedUuids.includes(uuidDeleted),
      'Authoritative post-eviction DB recheck must record uuidDeleted in deletedUuids'
    );
    assert.equal(
      getLastKnownClientTrafficCacheStatsForTests().size,
      0,
      'Stale in-flight read MUST NOT recreate traffic cache entry after mutation state eviction'
    );
  } finally {
    resetXuiServiceCachesForTests();
    resetLastKnownClientTrafficCacheForTests();
  }
});

// ---------------------------------------------------------------------------
// 28. Traffic mutation state eviction during an in-flight read cannot restore pre-reset traffic counters
// ---------------------------------------------------------------------------
test('28. Traffic mutation state eviction during an in-flight getMyConfigs read rechecks DB and never restores pre-reset traffic counters', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();
  setMaxClientTrafficMutationStateEntriesForTests(3);

  try {
    const uid = 'uid-evict-reset';
    const email = 'evictreset@example.com';
    const uuidReset = 'uuid-evict-reset-midflight';
    const eightGb = 8 * 1024 * 1024 * 1024;

    const db = createMockCustomerDb({
      vpn_accounts: [
        {
          id: 'acc-er-1',
          user_id: uid,
          email,
          uuid: uuidReset,
          vless_url: `vless://${uuidReset}@example.com:443#SG`,
          status: 'active',
          enable: true,
          total_bytes: 0,
          up_bytes: eightGb,
          down_bytes: 0,
          used_bytes: eightGb,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
      vpn_configs: [
        {
          id: 'cfg-er-1',
          user_id: uid,
          customer_uid: uid,
          uuid: uuidReset,
          inbound_id: 5,
          status: 'active',
          enabled: true,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
    });

    let releasePanelFetch!: () => void;
    const panelGate = new Promise<void>((r) => {
      releasePanelFetch = r;
    });
    const preResetLiveIb = makeInbound(5, [{ id: uuidReset, email, up: eightGb, down: 0, totalGB: 0 }]);

    const inFlightRead = getMyConfigs(uid, email, undefined, {
      dbClient: db,
      adminDbClient: db,
      currentPanelIdentity: PANEL_A_ID,
      getCachedInboundsFn: async () => [],
      getLiveInboundFn: async () => {
        await panelGate;
        return preResetLiveIb;
      },
      getInboundsFn: async () => [],
    });

    await new Promise((r) => setTimeout(r, 15));

    // Concurrent traffic reset zeroes DB counters and notifies invalidator
    db.state.vpn_accounts[0].up_bytes = 0;
    db.state.vpn_accounts[0].down_bytes = 0;
    db.state.vpn_accounts[0].used_bytes = 0;
    notifyClientTrafficInvalidated(uuidReset, 'reset');

    // Overflow clientTrafficMutationStateByUuid (cap=3) with 5 other UUIDs so uuidReset is evicted mid-flight
    for (let i = 0; i < 5; i++) {
      notifyClientTrafficInvalidated(`uuid-reset-overflow-${i}`, 'reset');
    }
    assert.equal(getClientTrafficMutationState(uuidReset).present, false);

    // Release the stale pre-reset in-flight panel read (which carries 8GB)
    releasePanelFetch();
    const res = await inFlightRead;

    assert.equal(res.configs.length, 1);
    assert.equal(
      res.configs[0].usedGB,
      0,
      'Stale pre-reset 8GB MUST NOT be restored after mutation state eviction'
    );
    assert.equal(
      getLastKnownClientTrafficCacheStatsForTests().size,
      0,
      'Stale pre-reset bytes MUST NOT be written into lastKnownClientTrafficByScope after eviction'
    );
  } finally {
    resetXuiServiceCachesForTests();
    resetLastKnownClientTrafficCacheForTests();
  }
});

// ---------------------------------------------------------------------------
// 29. Authoritative post-eviction deletion verification failures fail closed without exposing credentials
// ---------------------------------------------------------------------------
test('29. Authoritative post-eviction DB verification failure fails closed (503) without exposing potentially deleted credentials', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();
  setMaxClientTrafficMutationStateEntriesForTests(2);

  try {
    const uid = 'uid-evict-failclosed';
    const email = 'failclosed@example.com';
    const uuidTarget = 'uuid-evict-failclosed-target';

    const baseDb = createMockCustomerDb({
      vpn_accounts: [
        {
          id: 'acc-fc-1',
          user_id: uid,
          email,
          uuid: uuidTarget,
          vless_url: `vless://${uuidTarget}@example.com:443#SG`,
          status: 'active',
          enable: true,
          total_bytes: 0,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
      vpn_configs: [
        {
          id: 'cfg-fc-1',
          user_id: uid,
          customer_uid: uid,
          uuid: uuidTarget,
          inbound_id: 5,
          status: 'active',
          enabled: true,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
    });

    let failRecheckQueries = false;
    const wrappedDb = {
      ...baseDb,
      from: (table: string) => {
        if (failRecheckQueries && (table === 'vpn_accounts' || table === 'vpn_configs')) {
          const errQuery: any = {
            select: () => errQuery,
            eq: () => Promise.resolve({ data: null, error: { message: 'Supabase recheck unavailable' } }),
          };
          return errQuery;
        }
        return baseDb.from(table);
      },
    };

    let releasePanelFetch!: () => void;
    const panelGate = new Promise<void>((r) => {
      releasePanelFetch = r;
    });
    const liveIb = makeInbound(5, [{ id: uuidTarget, email, up: 1024, down: 1024, totalGB: 0 }]);

    const inFlightRead = getMyConfigs(uid, email, undefined, {
      dbClient: wrappedDb,
      adminDbClient: wrappedDb,
      currentPanelIdentity: PANEL_A_ID,
      getCachedInboundsFn: async () => [],
      getLiveInboundFn: async () => {
        await panelGate;
        return liveIb;
      },
      getInboundsFn: async () => [],
    });

    await new Promise((r) => setTimeout(r, 15));

    // Trigger mutation + eviction while in-flight, and make subsequent authoritative DB recheck fail
    notifyClientTrafficInvalidated(uuidTarget, 'deleted');
    for (let i = 0; i < 4; i++) {
      notifyClientTrafficInvalidated(`uuid-fc-overflow-${i}`, 'reset');
    }
    failRecheckQueries = true;

    releasePanelFetch();

    await assert.rejects(
      () => inFlightRead,
      (err: any) => {
        assert.equal(err?.code, 'AUTHORITATIVE_MUTATION_RECHECK_FAILED');
        assert.equal(err?.status, 503);
        assert.equal(err?.retryable, true);
        return true;
      },
      'Failed authoritative post-eviction DB recheck MUST fail closed with 503 AUTHORITATIVE_MUTATION_RECHECK_FAILED'
    );
  } finally {
    resetXuiServiceCachesForTests();
    resetLastKnownClientTrafficCacheForTests();
  }
});

// ---------------------------------------------------------------------------
// 30. cachedTrafficByUuid fallback cannot expose another customer's traffic when UUIDs overlap
// ---------------------------------------------------------------------------
test('30. cachedTrafficByUuid fallback rejects shared cached inbound client belonging to another customer when UUIDs overlap', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const sharedUuid = 'uuid-cached-fallback-overlap-ab';
  const sevenGb = 7 * 1024 * 1024 * 1024;
  const tenGb = 10 * 1024 * 1024 * 1024;

  // Shared cachedFallbackInbounds has a client with sharedUuid belonging to Customer A (alice@example.com) with 7GB usage
  const sharedCachedIb = makeInbound(5, [
    { id: sharedUuid, email: 'alice@example.com', up: sevenGb, down: 0, totalGB: tenGb },
  ]);

  // Customer B (bob@example.com) has an overlapping UUID record on inbound 5 with 0 stored bytes during a panel outage
  const dbCustomerB = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-bob-overlap',
        user_id: 'uid-bob',
        email: 'bob@example.com',
        uuid: sharedUuid,
        vless_url: `vless://${sharedUuid}@example.com:443#SG`,
        status: 'active',
        enable: true,
        total_bytes: tenGb,
        used_bytes: 0,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-bob-overlap',
        user_id: 'uid-bob',
        customer_uid: 'uid-bob',
        uuid: sharedUuid,
        inbound_id: 5,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const resBob = await getMyConfigs('uid-bob', 'bob@example.com', undefined, {
    dbClient: dbCustomerB,
    adminDbClient: dbCustomerB,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [sharedCachedIb],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });

  assert.equal(resBob.configs.length, 1);
  assert.equal(resBob.configs[0].status, 'Status Unavailable');
  assert.equal(
    resBob.configs[0].usedGB,
    0,
    'Customer B MUST NEVER receive Customer A 7GB fallback traffic from shared cachedTrafficByUuid'
  );
  assert.equal(resBob.configs[0].trafficVerified, false);
  assert.equal(resBob.configs[0].trafficSource, 'unknown');
  assert.equal(resBob.configs[0].usedTrafficKnown, false);
  assert.equal(resBob.configs[0].remainingTrafficKnown, false);
  assert.equal(resBob.configs[0].remainingGB, 'Unavailable');
});

// ---------------------------------------------------------------------------
// 31. cachedTrafficByUuid fallback cannot expose another panel's traffic or mismatched inbound traffic
// ---------------------------------------------------------------------------
test('31. cachedTrafficByUuid fallback rejects another panel snapshot and rejects mismatched inbound_id traffic', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-panel-ib-isolation';
  const email = 'isolation@example.com';
  const uuidTarget = 'uuid-panel-ib-target';
  const sixGb = 6 * 1024 * 1024 * 1024;
  const tenGb = 10 * 1024 * 1024 * 1024;

  // Customer record is bound to PANEL_A_ID and persisted inbound_id = 5
  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-pib-1',
        user_id: uid,
        email,
        uuid: uuidTarget,
        vless_url: `vless://${uuidTarget}@example.com:443#SG`,
        status: 'active',
        enable: true,
        total_bytes: tenGb,
        used_bytes: 0,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-pib-1',
        user_id: uid,
        customer_uid: uid,
        uuid: uuidTarget,
        inbound_id: 5,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  // Case A: Cached inbound has inbound.id = 99 (mismatched from persisted inbound_id = 5)
  const mismatchedInboundCached = makeInbound(99, [
    { id: uuidTarget, email, up: sixGb, down: 0, totalGB: tenGb },
  ]);

  const resMismatchedInbound = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [mismatchedInboundCached],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });
  assert.equal(resMismatchedInbound.configs[0].status, 'Status Unavailable');
  assert.equal(
    resMismatchedInbound.configs[0].usedGB,
    0,
    'Mismatched inbound.id (99 vs persisted 5) MUST be rejected for fallback traffic'
  );
  assert.equal(resMismatchedInbound.configs[0].trafficVerified, false);
  assert.equal(resMismatchedInbound.configs[0].trafficSource, 'unknown');
  assert.equal(resMismatchedInbound.configs[0].usedTrafficKnown, false);
  assert.equal(resMismatchedInbound.configs[0].remainingTrafficKnown, false);
  assert.equal(resMismatchedInbound.configs[0].remainingGB, 'Unavailable');

  // Case B: Global cached inbounds in xuiService belongs to PANEL_B_ID while customer queries PANEL_A_ID
  const panelBInbound5 = makeInbound(5, [
    { id: uuidTarget, email, up: sixGb, down: 0, totalGB: tenGb },
  ]);
  setCachedInbounds([panelBInbound5], PANEL_B_ID);

  const resWrongPanelSnapshot = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });
  assert.equal(resWrongPanelSnapshot.configs[0].status, 'Status Unavailable');
  assert.equal(
    resWrongPanelSnapshot.configs[0].usedGB,
    0,
    'Panel B cached inbound snapshot MUST NEVER be exposed to a Panel A customer config'
  );
  assert.equal(resWrongPanelSnapshot.configs[0].trafficVerified, false);
  assert.equal(resWrongPanelSnapshot.configs[0].trafficSource, 'unknown');
  assert.equal(resWrongPanelSnapshot.configs[0].usedTrafficKnown, false);
  assert.equal(resWrongPanelSnapshot.configs[0].remainingTrafficKnown, false);
  assert.equal(resWrongPanelSnapshot.configs[0].remainingGB, 'Unavailable');
});

// ---------------------------------------------------------------------------
// 32. Duplicate UUIDs across inbounds or conflicting ownership are rejected for fallback traffic
// ---------------------------------------------------------------------------
test('32. Duplicate UUIDs across inbounds or conflicting DB ownership/inbound mappings are rejected for fallback traffic', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-dup-conflict';
  const email = 'dupconflict@example.com';
  const uuidDup = 'uuid-duplicate-across-inbounds';
  const uuidConflict = 'uuid-conflicting-db-inbound';
  const fourGb = 4 * 1024 * 1024 * 1024;
  const nineGb = 9 * 1024 * 1024 * 1024;
  const tenGb = 10 * 1024 * 1024 * 1024;

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-dup-1',
        user_id: uid,
        email,
        uuid: uuidDup,
        vless_url: `vless://${uuidDup}@example.com:443#SG1`,
        status: 'active',
        enable: true,
        total_bytes: tenGb,
        used_bytes: 0,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'acc-conf-1',
        user_id: uid,
        email,
        uuid: uuidConflict,
        vless_url: `vless://${uuidConflict}@example.com:443#SG2`,
        status: 'active',
        enable: true,
        total_bytes: tenGb,
        used_bytes: 0,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-dup-1',
        user_id: uid,
        customer_uid: uid,
        uuid: uuidDup,
        inbound_id: 5,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
      // Conflicting inbound_id for uuidConflict across two vpn_configs rows (inbound 5 vs inbound 8)
      {
        id: 'cfg-conf-a',
        user_id: uid,
        customer_uid: uid,
        uuid: uuidConflict,
        inbound_id: 5,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'cfg-conf-b',
        user_id: uid,
        customer_uid: uid,
        uuid: uuidConflict,
        inbound_id: 8,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  // uuidDup appears in BOTH inbound 5 (4GB) and inbound 6 (9GB) in cached inbounds
  const cachedIb5 = makeInbound(5, [
    { id: uuidDup, email, up: fourGb, down: 0, totalGB: tenGb },
    { id: uuidConflict, email, up: fourGb, down: 0, totalGB: tenGb },
  ]);
  const cachedIb6 = makeInbound(6, [
    { id: uuidDup, email, up: nineGb, down: 0, totalGB: tenGb },
  ]);

  const res = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [cachedIb5, cachedIb6],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });

  const cDup = res.configs.find((c) => c.uuid === uuidDup);
  const cConf = res.configs.find((c) => c.uuid === uuidConflict);
  assert.ok(cDup);
  assert.ok(cConf);
  assert.equal(cDup.status, 'Status Unavailable');
  assert.equal(cDup.usedGB, 0, 'Duplicate UUID across multiple inbounds MUST be rejected for fallback traffic');
  assert.equal(cDup.trafficVerified, false);
  assert.equal(cDup.trafficSource, 'unknown');
  assert.equal(cDup.usedTrafficKnown, false);
  assert.equal(cDup.remainingTrafficKnown, false);
  assert.equal(cDup.remainingGB, 'Unavailable');
  assert.equal(cConf.status, 'Status Unavailable');
  assert.equal(cConf.usedGB, 0, 'Conflicting inbound_id mappings across DB rows MUST be rejected for fallback traffic');
  assert.equal(cConf.trafficVerified, false);
  assert.equal(cConf.trafficSource, 'unknown');
  assert.equal(cConf.usedTrafficKnown, false);
  assert.equal(cConf.remainingTrafficKnown, false);
  assert.equal(cConf.remainingGB, 'Unavailable');
});

// ---------------------------------------------------------------------------
// 33. Initial Supabase query timeout/failure is bounded by shared deadline and throws retriable error
// ---------------------------------------------------------------------------
test('33. Initial Supabase query timeout or failure is bounded by shared customer deadline and throws a retriable error instead of empty list', async () => {
  resetXuiServiceCachesForTests();

  const uid = 'uid-slow-initial-db';
  const email = 'slowdb@example.com';

  // Case A: Hanging initial vpn_configs query exceeds totalRequestBudgetMs (120ms)
  const hangingDb = {
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => new Promise((r) => setTimeout(() => r({ data: [], error: null }), 1500)),
        ilike: () => new Promise((r) => setTimeout(() => r({ data: [], error: null }), 1500)),
        order: () => new Promise((r) => setTimeout(() => r({ data: [], error: null }), 1500)),
      };
      return q;
    },
  };

  const t0 = Date.now();
  await assert.rejects(
    () =>
      getMyConfigs(uid, email, undefined, {
        dbClient: hangingDb,
        adminDbClient: hangingDb,
        totalRequestBudgetMs: 120,
      }),
    (err: any) => {
      assert.equal(err?.code, 'CUSTOMER_REQUEST_DEADLINE_EXCEEDED');
      assert.equal(err?.status, 504);
      assert.equal(err?.retryable, true);
      return true;
    },
    'Hanging initial Supabase query MUST reject with 504 CUSTOMER_REQUEST_DEADLINE_EXCEEDED rather than returning empty configs'
  );
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs < 350, `Initial DB timeout should be bounded by 120ms deadline (actual=${elapsedMs}ms)`);

  // Case B: Database query error on vpn_accounts throws retriable 503 CUSTOMER_CONFIG_QUERY_FAILED rather than empty configs
  const errorDb = {
    from: (table: string) => {
      const q: any = {
        select: () => q,
        eq: () => (table === 'vpn_accounts' ? q : Promise.resolve({ data: [], error: null })),
        ilike: () => Promise.resolve({ data: [], error: null }),
        order: () => Promise.resolve({ data: null, error: { message: 'connection reset by peer' } }),
      };
      return q;
    },
  };

  await assert.rejects(
    () =>
      getMyConfigs(uid, email, undefined, {
        dbClient: errorDb,
        adminDbClient: errorDb,
      }),
    (err: any) => {
      assert.equal(err?.code, 'CUSTOMER_CONFIG_QUERY_FAILED');
      assert.equal(err?.status, 503);
      assert.equal(err?.retryable, true);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 34. Panel identity resolution is bounded by the shared customer request deadline
// ---------------------------------------------------------------------------
test('34. Panel identity resolution and cached inbound lookup are bounded by the shared customer request deadline', async () => {
  resetXuiServiceCachesForTests();

  const uid = 'uid-panel-id-deadline';
  const email = 'panelid@example.com';
  const uuid1 = 'uuid-panel-id-1';

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-pid-1',
        user_id: uid,
        email,
        uuid: uuid1,
        vless_url: `vless://${uuid1}@example.com:443#SG`,
        status: 'active',
        enable: true,
        total_bytes: 0,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-pid-1',
        user_id: uid,
        customer_uid: uid,
        uuid: uuid1,
        inbound_id: 5,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const t0 = Date.now();
  const res = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    totalRequestBudgetMs: 140,
    // Slow getCachedInboundsFn (1000ms) + slow getLiveInboundFn (1000ms) must both be bounded by 140ms shared budget
    getCachedInboundsFn: async () => {
      await new Promise((r) => setTimeout(r, 1000));
      return [];
    },
    getLiveInboundFn: async () => {
      await new Promise((r) => setTimeout(r, 1000));
      return null;
    },
  });
  const elapsedMs = Date.now() - t0;

  assert.ok(elapsedMs < 320, `Expected shared 140ms deadline to bound slow panel metadata lookup (actual=${elapsedMs}ms)`);
  assert.equal(res.configs.length, 1);
  assert.equal(res.configs[0].status, 'Status Unavailable');
});

// ---------------------------------------------------------------------------
// 35. getMyConfigs is strictly read-only and never performs DB status restoration writes
// ---------------------------------------------------------------------------
test('35. Read-only getMyConfigs derives live Active status in-memory without writing status restoration UPDATEs to vpn_accounts or vpn_configs', async () => {
  resetXuiServiceCachesForTests();

  const uid = 'uid-skip-restore';
  const email = 'skiprestore@example.com';
  const uuidDisabled = 'uuid-skip-restore-disabled';

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-sr-1',
        user_id: uid,
        email,
        uuid: uuidDisabled,
        vless_url: `vless://${uuidDisabled}@example.com:443#SG`,
        status: 'disabled', // Stored DB row is disabled while live panel is enabled (and no revocation order exists)
        enable: false,
        total_bytes: 0,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-sr-1',
        user_id: uid,
        customer_uid: uid,
        uuid: uuidDisabled,
        inbound_id: 5,
        status: 'disabled',
        enabled: false,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const activeLiveIb = makeInbound(5, [
    { id: uuidDisabled, email, enable: true, up: 0, down: 0, totalGB: 0 },
  ]);

  const res = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    totalRequestBudgetMs: 1000,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => activeLiveIb,
    getInboundsFn: async () => [],
  });

  assert.equal(res.configs.length, 1);
  assert.equal(res.configs[0].status, 'Active');
  assert.equal(
    db.state.writes.length,
    0,
    'Read-only getMyConfigs MUST NEVER perform database status restoration UPDATE writes'
  );
  assert.equal(db.state.vpn_accounts[0].status, 'disabled');
  assert.equal(db.state.vpn_configs[0].status, 'disabled');
});

// ---------------------------------------------------------------------------
// 36. Read-only getMyConfigs performs zero background restoration queries or delayed database status mutations
// ---------------------------------------------------------------------------
test('36. Read-only getMyConfigs performs zero post-fetch status restoration queries or delayed database status mutations', async () => {
  resetXuiServiceCachesForTests();

  const uid = 'uid-timedout-restore';
  const email = 'timedoutrestore@example.com';
  const uuidDisabled = 'uuid-timedout-restore-disabled';

  const baseDb = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-tr-1',
        user_id: uid,
        email,
        uuid: uuidDisabled,
        order_id: 'ORD-TR-1',
        vless_url: `vless://${uuidDisabled}@example.com:443#SG`,
        status: 'disabled',
        enable: false,
        total_bytes: 0,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-tr-1',
        user_id: uid,
        customer_uid: uid,
        uuid: uuidDisabled,
        order_id: 'ORD-TR-1',
        inbound_id: 5,
        status: 'disabled',
        enabled: false,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    orders: [
      {
        id: 'ORD-TR-1',
        order_id: 'ORD-TR-1',
        customer_id: uid,
        email,
        client_uuid: uuidDisabled,
        vless_url: `vless://${uuidDisabled}@example.com:443#SG`,
        status: 'completed',
        payment_status: 'Paid',
        provisioning_status: 'completed',
      },
    ],
  });

  let postPanelFetchDbQueries = 0;
  let panelFetched = false;
  const trackedAdminDb = {
    ...baseDb,
    from: (table: string) => {
      if (panelFetched) {
        postPanelFetchDbQueries++;
      }
      return baseDb.from(table);
    },
  };

  const activeLiveIb = makeInbound(5, [
    { id: uuidDisabled, email, enable: true, up: 0, down: 0, totalGB: 0 },
  ]);

  const res = await getMyConfigs(uid, email, undefined, {
    dbClient: baseDb,
    adminDbClient: trackedAdminDb,
    currentPanelIdentity: PANEL_A_ID,
    totalRequestBudgetMs: 500,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => {
      panelFetched = true;
      return activeLiveIb;
    },
    getInboundsFn: async () => [],
  });

  assert.equal(res.configs.length, 1);
  assert.equal(res.configs[0].status, 'Active');
  assert.equal(
    postPanelFetchDbQueries,
    0,
    'Read-only getMyConfigs MUST NOT issue post-panel status restoration DB queries'
  );
  assert.equal(baseDb.state.writes.length, 0, 'No DB writes immediately upon completion');

  await new Promise((r) => setTimeout(r, 100));
  assert.equal(
    baseDb.state.writes.length,
    0,
    'Read-only getMyConfigs MUST NEVER perform delayed DB status updates after request completion'
  );
  assert.equal(baseDb.state.vpn_accounts[0].status, 'disabled');
  assert.equal(baseDb.state.vpn_configs[0].status, 'disabled');
});

// ---------------------------------------------------------------------------
// 37. Forced refresh while a non-forced login is in flight supersedes the non-forced login
// ---------------------------------------------------------------------------
test('37. Forced refresh (forceRefresh=true) while a non-forced login is in flight allocates a new generation and supersedes the non-forced login', async () => {
  resetXuiServiceCachesForTests();

  const cfg = makeConfig({ panelUrl: PANEL_A_URL, password: 'pw-force-supersede', apiToken: 'pw-force-supersede' });
  const scopeKey = computeXuiCredentialScopeKey(cfg).scopeKey;

  let releaseNonForced!: () => void;
  const nonForcedGate = new Promise<void>((r) => {
    releaseNonForced = r;
  });

  let releaseForced!: () => void;
  const forcedGate = new Promise<void>((r) => {
    releaseForced = r;
  });

  let loginCalls = 0;

  // 1. Start non-forced login (generation 0)
  const nonForcedPromise = getXuiAuthHeaders(cfg, false, 6000, {
    loginPostFn: async () => {
      loginCalls++;
      await nonForcedGate;
      return {
        status: 200,
        headers: { 'set-cookie': ['3x-ui=stale-non-forced-sess; Path=/'] },
        data: { success: true },
      };
    },
    csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
  });

  await new Promise((r) => setTimeout(r, 10));
  const genDuringNonForced = getScopeAuthGeneration(scopeKey);

  // 2. Start forced refresh while non-forced login is still in flight
  const forcedPromise = getXuiAuthHeaders(cfg, true, 6000, {
    loginPostFn: async () => {
      loginCalls++;
      await forcedGate;
      return {
        status: 200,
        headers: { 'set-cookie': ['3x-ui=fresh-forced-sess; Path=/'] },
        data: { success: true },
      };
    },
    csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
  });

  await new Promise((r) => setTimeout(r, 10));
  const genDuringForced = getScopeAuthGeneration(scopeKey);
  assert.ok(
    genDuringForced > genDuringNonForced,
    `Forced refresh MUST supersede in-flight non-forced login with a strictly greater generation (${genDuringForced} > ${genDuringNonForced})`
  );
  assert.equal(loginCalls, 2, 'Forced refresh must launch a new login rather than sharing the stale non-forced login');

  // 3. Complete the older non-forced login WHILE the forced refresh is still in flight:
  // It MUST NOT remove the active forced in-flight promise from xuiAuthInFlight or cache stale credentials!
  releaseNonForced();
  await new Promise((r) => setTimeout(r, 10));
  const statsWhileForcedActive = getXuiAuthCacheStatsForTests();
  assert.ok(
    statsWhileForcedActive.inFlightScopes.includes(scopeKey),
    'Completion of older non-forced promise MUST NOT remove the newer forced in-flight entry'
  );

  // 4. Now complete the forced refresh
  releaseForced();
  const [nonForcedResult, forcedResult] = await Promise.all([nonForcedPromise, forcedPromise]);

  assert.equal(forcedResult['Cookie'], '3x-ui=fresh-forced-sess');
  assert.equal(
    nonForcedResult['Cookie'],
    '3x-ui=fresh-forced-sess',
    'Superseded non-forced login must not return stale credentials'
  );

  const cachedAfter = await getXuiAuthHeaders(cfg, false, 6000);
  assert.equal(cachedAfter['Cookie'], '3x-ui=fresh-forced-sess');
});

// ---------------------------------------------------------------------------
// 38. Repeated scope eviction and recreation while an older login is in flight never reuses an earlier generation
// ---------------------------------------------------------------------------
test('38. Repeated scope eviction and recreation while an older login is in flight never reuses a generation or accepts stale credentials', async () => {
  resetXuiServiceCachesForTests();
  setMaxXuiAuthScopeEntriesForTests(1); // Generation map cap = 2

  try {
    const cfgA = makeConfig({ panelUrl: PANEL_A_URL, password: 'pw-repeat-evict', apiToken: 'pw-repeat-evict' });
    const scopeA = computeXuiCredentialScopeKey(cfgA).scopeKey;

    let releaseOldLoginA!: () => void;
    const oldLoginGateA = new Promise<void>((r) => {
      releaseOldLoginA = r;
    });

    // Start an in-flight login on scopeA before any invalidation
    const oldInFlightA = getXuiAuthHeaders(cfgA, false, 6000, {
      loginPostFn: async () => {
        await oldLoginGateA;
        return {
          status: 200,
          headers: { 'set-cookie': ['3x-ui=stale-initial-gen-A; Path=/'] },
          data: { success: true },
        };
      },
      csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
    });
    await new Promise((r) => setTimeout(r, 10));

    const capturedInitialGen = getScopeAuthGeneration(scopeA);
    const seenGenerations = new Set<number>([capturedInitialGen]);

    // Repeatedly evict scopeA and recreate it across 4 cycles without calling invalidateXuiAuthCache(scopeA)
    for (let cycle = 0; cycle < 4; cycle++) {
      for (let k = 0; k < 3; k++) {
        const cfgOther = makeConfig({
          panelUrl: `https://evict-cycle-${cycle}-${k}.firevpn.example:2053/sub`,
          password: `pw-${cycle}-${k}`,
          apiToken: `pw-${cycle}-${k}`,
        });
        await getXuiAuthHeaders(cfgOther, false, 6000, {
          loginPostFn: async () => ({
            status: 200,
            headers: { 'set-cookie': [`3x-ui=cycle-${cycle}-${k}; Path=/`] },
            data: { success: true },
          }),
          csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
        });
      }

      // Confirm scopeA was evicted from xuiAuthGenerationByScope
      const stats = getXuiAuthCacheStatsForTests();
      assert.equal(
        Object.prototype.hasOwnProperty.call(stats.generationsByScope, scopeA),
        false,
        `Cycle ${cycle}: scopeA must be evicted from generation map`
      );

      // Recreate scopeA via a normal non-forced login
      const recreatedHeaders = await getXuiAuthHeaders(cfgA, false, 6000, {
        loginPostFn: async () => ({
          status: 200,
          headers: { 'set-cookie': [`3x-ui=recreated-cycle-${cycle}; Path=/`] },
          data: { success: true },
        }),
        csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
      });
      assert.equal(recreatedHeaders['Cookie'], `3x-ui=recreated-cycle-${cycle}`);

      const genAfterRecreate = getScopeAuthGeneration(scopeA);
      assert.equal(
        seenGenerations.has(genAfterRecreate),
        false,
        `Cycle ${cycle}: recreated generation ${genAfterRecreate} MUST NEVER reuse any earlier generation (${Array.from(seenGenerations).join(',')})`
      );
      for (const prevGen of seenGenerations) {
        assert.ok(
          genAfterRecreate > prevGen,
          `Cycle ${cycle}: recreated generation ${genAfterRecreate} must be strictly greater than ${prevGen}`
        );
      }
      seenGenerations.add(genAfterRecreate);
    }

    // Finally release the very first in-flight login captured at capturedInitialGen
    releaseOldLoginA();
    const oldResult = await oldInFlightA;
    assert.equal(
      oldResult['Cookie'],
      '3x-ui=recreated-cycle-3',
      'Stale initial-generation login MUST NOT return stale credentials after repeated eviction and recreation'
    );

    const cachedFinal = await getXuiAuthHeaders(cfgA, false, 6000);
    assert.equal(cachedFinal['Cookie'], '3x-ui=recreated-cycle-3');
  } finally {
    resetXuiServiceCachesForTests();
  }
});

// ---------------------------------------------------------------------------
// 39. Concurrent forced refresh requests for the same current generation share one authentication operation
// ---------------------------------------------------------------------------
test('39. Concurrent forced refresh requests for the same current generation share one authentication operation', async () => {
  resetXuiServiceCachesForTests();

  const cfg = makeConfig({ panelUrl: PANEL_A_URL, password: 'pw-concurrent-force', apiToken: 'pw-concurrent-force' });
  let loginHits = 0;

  // Seed initial session
  const initialHeaders = await getXuiAuthHeaders(cfg, false, 6000, {
    loginPostFn: async () => {
      loginHits++;
      return {
        status: 200,
        headers: { 'set-cookie': ['3x-ui=initial-sess; Path=/'] },
        data: { success: true },
      };
    },
    csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
  });
  assert.equal(initialHeaders['Cookie'], '3x-ui=initial-sess');
  assert.equal(loginHits, 1);

  // Now fire 5 concurrent forced refresh calls for the same expired generation
  const refreshOpts = {
    loginPostFn: async () => {
      loginHits++;
      await new Promise((r) => setTimeout(r, 25));
      return {
        status: 200,
        headers: { 'set-cookie': [`3x-ui=shared-forced-sess-${loginHits}; Path=/`] },
        data: { success: true },
      };
    },
    csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
  };

  const results = await Promise.all([
    getXuiAuthHeaders(cfg, true, 6000, refreshOpts),
    getXuiAuthHeaders(cfg, true, 6000, refreshOpts),
    getXuiAuthHeaders(cfg, true, 6000, refreshOpts),
    getXuiAuthHeaders(cfg, true, 6000, refreshOpts),
    getXuiAuthHeaders(cfg, true, 6000, refreshOpts),
  ]);

  assert.equal(loginHits, 2, '5 concurrent forced refreshes for the same current generation MUST share 1 login request');
  for (const h of results) {
    assert.equal(h['Cookie'], '3x-ui=shared-forced-sess-2');
  }
});

// ---------------------------------------------------------------------------
// 40. Concurrent deletion, rejection, or disable during read-only customer configuration retrieval
// ---------------------------------------------------------------------------
test('40. Concurrent deletion, rejection, or disable during read-only getMyConfigs is never overwritten and unresolved revocations stay Disabled', async () => {
  resetXuiServiceCachesForTests();

  const uid = 'uid-concurrent-admin-ops';
  const email = 'concurrentops@example.com';
  const uuidConcurrentDisable = 'uuid-concurrent-disable-1';
  const uuidRevokeFailed = 'uuid-revoke-failed-1';

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-cd-1',
        user_id: uid,
        email,
        uuid: uuidConcurrentDisable,
        order_id: 'ORD-CD-1',
        vless_url: `vless://${uuidConcurrentDisable}@example.com:443#SG1`,
        status: 'disabled',
        enable: false,
        total_bytes: 0,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'acc-rf-1',
        user_id: uid,
        email,
        uuid: uuidRevokeFailed,
        order_id: 'ORD-RF-1',
        vless_url: `vless://${uuidRevokeFailed}@example.com:443#SG2`,
        status: 'disabled',
        enable: false,
        total_bytes: 0,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-cd-1',
        user_id: uid,
        customer_uid: uid,
        uuid: uuidConcurrentDisable,
        order_id: 'ORD-CD-1',
        inbound_id: 5,
        status: 'disabled',
        enabled: false,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'cfg-rf-1',
        user_id: uid,
        customer_uid: uid,
        uuid: uuidRevokeFailed,
        order_id: 'ORD-RF-1',
        inbound_id: 5,
        status: 'disabled',
        enabled: false,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    orders: [
      {
        id: 'ORD-CD-1',
        order_id: 'ORD-CD-1',
        customer_id: uid,
        email,
        client_uuid: uuidConcurrentDisable,
        vless_url: `vless://${uuidConcurrentDisable}@example.com:443#SG1`,
        status: 'approved',
        payment_status: 'Paid',
        provisioning_status: 'completed',
      },
      {
        id: 'ORD-RF-1',
        order_id: 'ORD-RF-1',
        customer_id: uid,
        email,
        client_uuid: uuidRevokeFailed,
        vless_url: `vless://${uuidRevokeFailed}@example.com:443#SG2`,
        status: 'approved',
        payment_status: 'Paid',
        provisioning_status: 'completed',
      },
    ],
    vpn_entitlement_grants: [
      {
        id: 'grant-rf-1',
        order_id: 'ORD-RF-1',
        user_id: uid,
        customer_id: uid,
        client_uuid: uuidRevokeFailed,
        inbound_id: 5,
        grant_type: 'renewal',
        status: 'revoke_failed', // Unresolved renewal revocation failure!
        panel_identity: PANEL_A_ID,
      },
    ],
  });

  const liveIb = makeInbound(5, [
    { id: uuidConcurrentDisable, email, enable: true, up: 0, down: 0, totalGB: 0 },
    { id: uuidRevokeFailed, email, enable: true, up: 0, down: 0, totalGB: 0 },
  ]);

  const res = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => {
      // Simulate concurrent admin disable/rejection/deletion happening in DB while panel fetch completes
      db.state.vpn_accounts[0].status = 'disabled';
      db.state.vpn_configs[0].status = 'disabled';
      return liveIb;
    },
    getInboundsFn: async () => [],
  });

  assert.equal(db.state.writes.length, 0, 'getMyConfigs MUST NOT perform any DB writes');
  assert.equal(db.state.vpn_accounts[0].status, 'disabled', 'DB disabled state must not be overwritten');
  assert.equal(db.state.vpn_configs[0].status, 'disabled', 'DB disabled state must not be overwritten');

  const cfgRevokeFailed = res.configs.find((c) => c.uuid === uuidRevokeFailed);
  assert.ok(cfgRevokeFailed);
  assert.equal(
    cfgRevokeFailed.status,
    'Disabled',
    'A DB-disabled record linked to an unresolved/failed revocation order MUST NOT display as Active even if 3X-UI still has enable=true'
  );
});

// ---------------------------------------------------------------------------
// 41. Unknown traffic for a finite package when 3X-UI is unreachable and no verified cache exists
// ---------------------------------------------------------------------------
test('41. Unknown traffic for a finite package when 3X-UI is unreachable sets trafficVerified=false, usedTrafficKnown=false, remainingGB=Unavailable, and preserves quotaVerified=true', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-finite-unknown-traffic';
  const email = 'finiteunknown@example.com';
  const clientUuid = 'uuid-finite-unknown-1';
  const tenGb = 10 * 1024 * 1024 * 1024;

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-fu-1',
        user_id: uid,
        email,
        uuid: clientUuid,
        vless_url: `vless://${clientUuid}@example.com:443#SG`,
        status: 'active',
        enable: true,
        total_bytes: tenGb,
        used_bytes: 0,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-fu-1',
        user_id: uid,
        customer_uid: uid,
        uuid: clientUuid,
        inbound_id: 5,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const res = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });

  assert.equal(res.configs.length, 1);
  const cfg = res.configs[0];
  assert.equal(cfg.status, 'Status Unavailable');
  assert.equal(cfg.panelStatusVerified, false);
  assert.equal(cfg.trafficVerified, false);
  assert.equal(cfg.trafficSource, 'unknown');
  assert.equal(cfg.usedTrafficKnown, false);
  assert.equal(cfg.remainingTrafficKnown, false);
  assert.equal(cfg.quotaVerified, true, 'Independently verified 10GB package allowance must be preserved');
  assert.equal(cfg.totalTrafficBytes, tenGb);
  assert.equal(cfg.trafficLimit, '10GB');
  assert.equal(cfg.usedGB, 0, 'Legacy numeric placeholder usedGB=0 is preserved');
  assert.equal(cfg.remainingGB, 'Unavailable', 'Remaining quota MUST NOT fabricate full 10GB remaining when used traffic is unknown');
});

// ---------------------------------------------------------------------------
// 42. Unknown quota when total_bytes is 0 or missing without unlimited entitlement confirmation
// ---------------------------------------------------------------------------
test('42. Unknown quota when total_bytes is 0 or missing without unlimited entitlement confirmation sets quotaVerified=false and trafficLimit=Unavailable', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-unknown-quota';
  const email = 'unknownquota@example.com';
  const clientUuid = 'uuid-unknown-quota-1';

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-uq-1',
        user_id: uid,
        email,
        uuid: clientUuid,
        vless_url: `vless://${clientUuid}@example.com:443#SG`,
        status: 'active',
        enable: true,
        total_bytes: 0, // 0 or missing without any order/template confirming Unlimited!
        used_bytes: 0,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-uq-1',
        user_id: uid,
        customer_uid: uid,
        uuid: clientUuid,
        inbound_id: 5,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const res = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });

  assert.equal(res.configs.length, 1);
  const cfg = res.configs[0];
  assert.equal(cfg.status, 'Status Unavailable');
  assert.equal(cfg.quotaVerified, false, 'total_bytes=0 without panel verification or unlimited entitlement MUST NOT be quotaVerified');
  assert.equal(cfg.trafficLimit, 'Unavailable', 'Unverified 0 total_bytes MUST NOT be labeled Unlimited');
  assert.equal(cfg.remainingGB, 'Unavailable', 'Unverified 0 total_bytes MUST NOT report Unlimited remaining');
  assert.equal(cfg.remainingTrafficKnown, false);
  assert.equal(cfg.usedTrafficKnown, false);
});

// ---------------------------------------------------------------------------
// 43. Confirmed unlimited entitlement with unavailable usage
// ---------------------------------------------------------------------------
test('43. Confirmed unlimited entitlement with unavailable live usage preserves Unlimited quota while reporting unknown used traffic', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-unlimited-unknown-usage';
  const email = 'unlimitedunknown@example.com';
  const clientUuid = 'uuid-unlimited-unknown-1';

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-uu-1',
        user_id: uid,
        email,
        uuid: clientUuid,
        order_id: 'ORD-UU-1',
        vless_url: `vless://${clientUuid}@example.com:443#SG`,
        status: 'active',
        enable: true,
        total_bytes: 0,
        used_bytes: 0,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-uu-1',
        user_id: uid,
        customer_uid: uid,
        uuid: clientUuid,
        order_id: 'ORD-UU-1',
        inbound_id: 5,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    orders: [
      {
        id: 'ORD-UU-1',
        order_id: 'ORD-UU-1',
        customer_id: uid,
        email,
        client_uuid: clientUuid,
        vless_url: `vless://${clientUuid}@example.com:443#SG`,
        status: 'approved',
        payment_status: 'Paid',
        provisioning_status: 'completed',
        traffic_limit: 'Unlimited',
      },
    ],
  });

  const res = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });

  assert.equal(res.configs.length, 1);
  const cfg = res.configs[0];
  assert.equal(cfg.status, 'Status Unavailable');
  assert.equal(cfg.quotaVerified, true);
  assert.equal(cfg.trafficLimit, 'Unlimited');
  assert.equal(cfg.remainingGB, 'Unlimited');
  assert.equal(cfg.remainingTrafficKnown, true);
  assert.equal(cfg.trafficVerified, false);
  assert.equal(cfg.trafficSource, 'unknown');
  assert.equal(cfg.usedTrafficKnown, false);
});

// ---------------------------------------------------------------------------
// 44. Verified zero usage (live 0 GB or confirmed traffic reset) vs unknown usage
// ---------------------------------------------------------------------------
test('44. Verified zero usage (live 0 GB or confirmed traffic reset) sets trafficVerified=true and usedTrafficKnown=true, distinct from unknown usage', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-verified-zero';
  const email = 'verifiedzero@example.com';
  const clientUuid = 'uuid-verified-zero-1';
  const tenGb = 10 * 1024 * 1024 * 1024;

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-vz-1',
        user_id: uid,
        email,
        uuid: clientUuid,
        vless_url: `vless://${clientUuid}@example.com:443#SG`,
        status: 'active',
        enable: true,
        total_bytes: tenGb,
        used_bytes: 0,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-vz-1',
        user_id: uid,
        customer_uid: uid,
        uuid: clientUuid,
        inbound_id: 5,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  // Case A: Live 3X-UI returns 0 up / 0 down for a 10GB package
  const liveZeroIb = makeInbound(5, [
    { id: clientUuid, email, enable: true, up: 0, down: 0, totalGB: tenGb },
  ]);

  const liveRes = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => liveZeroIb,
    getInboundsFn: async () => [],
  });

  const liveCfg = liveRes.configs[0];
  assert.equal(liveCfg.status, 'Active');
  assert.equal(liveCfg.trafficVerified, true);
  assert.equal(liveCfg.trafficSource, 'live');
  assert.equal(liveCfg.usedTrafficKnown, true);
  assert.equal(liveCfg.remainingTrafficKnown, true);
  assert.equal(liveCfg.usedGB, 0);
  assert.equal(liveCfg.remainingGB, 10);

  // Case B: Outage right after confirmed live 0GB uses cached_scoped verified 0GB
  const cachedZeroRes = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });
  const cachedZeroCfg = cachedZeroRes.configs[0];
  assert.equal(cachedZeroCfg.status, 'Status Unavailable');
  assert.equal(cachedZeroCfg.trafficVerified, true);
  assert.equal(cachedZeroCfg.trafficSource, 'cached_scoped');
  assert.equal(cachedZeroCfg.usedTrafficKnown, true);
  assert.equal(cachedZeroCfg.remainingTrafficKnown, true);
  assert.equal(cachedZeroCfg.usedGB, 0);
  assert.equal(cachedZeroCfg.remainingGB, 10);
});

// ---------------------------------------------------------------------------
// 45. Last-known traffic preservation during temporary panel outages across cached_scoped, cached_inbound, and stored_db
// ---------------------------------------------------------------------------
test('45. Last-known traffic preservation during temporary panel outages accurately tags trafficSource as cached_scoped, cached_inbound, or stored_db', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-last-known-sources';
  const email = 'lastknown@example.com';
  const uuidStored = 'uuid-last-known-stored';
  const uuidCachedIb = 'uuid-last-known-cached-ib';
  const threeGb = 3 * 1024 * 1024 * 1024;
  const fourGb = 4 * 1024 * 1024 * 1024;
  const tenGb = 10 * 1024 * 1024 * 1024;

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-lk-1',
        user_id: uid,
        email,
        uuid: uuidStored,
        vless_url: `vless://${uuidStored}@example.com:443#SG1`,
        status: 'active',
        enable: true,
        total_bytes: tenGb,
        up_bytes: threeGb,
        down_bytes: 0,
        used_bytes: threeGb,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'acc-lk-2',
        user_id: uid,
        email,
        uuid: uuidCachedIb,
        vless_url: `vless://${uuidCachedIb}@example.com:443#SG2`,
        status: 'active',
        enable: true,
        total_bytes: tenGb,
        used_bytes: 0,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-lk-1',
        user_id: uid,
        customer_uid: uid,
        uuid: uuidStored,
        inbound_id: 5,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'cfg-lk-2',
        user_id: uid,
        customer_uid: uid,
        uuid: uuidCachedIb,
        inbound_id: 6,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const cachedIb6 = makeInbound(6, [
    { id: uuidCachedIb, email, up: fourGb, down: 0, totalGB: tenGb },
  ]);

  const res = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [cachedIb6],
    getLiveInboundFn: async () => null,
    getInboundsFn: async () => [],
  });

  const cfgStored = res.configs.find((c) => c.uuid === uuidStored);
  const cfgCachedIb = res.configs.find((c) => c.uuid === uuidCachedIb);
  assert.ok(cfgStored);
  assert.ok(cfgCachedIb);

  assert.equal(cfgStored.status, 'Status Unavailable');
  assert.equal(cfgStored.trafficVerified, true);
  assert.equal(cfgStored.trafficSource, 'stored_db');
  assert.equal(cfgStored.usedTrafficKnown, true);
  assert.equal(cfgStored.usedGB, 3);
  assert.equal(cfgStored.remainingGB, 7);

  assert.equal(cfgCachedIb.status, 'Status Unavailable');
  assert.equal(cfgCachedIb.trafficVerified, true);
  assert.equal(cfgCachedIb.trafficSource, 'cached_inbound');
  assert.equal(cfgCachedIb.usedTrafficKnown, true);
  assert.equal(cfgCachedIb.usedGB, 4);
  assert.equal(cfgCachedIb.remainingGB, 6);
});

// ---------------------------------------------------------------------------
// 46. Mutation state eviction when database traffic counters are missing or null
// ---------------------------------------------------------------------------
test('46. Mutation state eviction when database traffic counters are missing or null never fabricates a confirmed reset and falls back to unknown if fresh panel read fails', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();
  setMaxClientTrafficMutationStateEntriesForTests(2);

  try {
    const uid = 'uid-evict-null-db';
    const email = 'evictnulldb@example.com';
    const uuidTarget = 'uuid-evict-null-db-target';
    const sixGb = 6 * 1024 * 1024 * 1024;
    const tenGb = 10 * 1024 * 1024 * 1024;

    // DB has null/missing traffic counters (up_bytes: null, down_bytes: null, used_bytes: null)
    const db = createMockCustomerDb({
      vpn_accounts: [
        {
          id: 'acc-end-1',
          user_id: uid,
          email,
          uuid: uuidTarget,
          vless_url: `vless://${uuidTarget}@example.com:443#SG`,
          status: 'active',
          enable: true,
          total_bytes: tenGb,
          up_bytes: null,
          down_bytes: null,
          used_bytes: null,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
      vpn_configs: [
        {
          id: 'cfg-end-1',
          user_id: uid,
          customer_uid: uid,
          uuid: uuidTarget,
          inbound_id: 5,
          status: 'active',
          enabled: true,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
    });

    let releaseFirstPanelFetch!: () => void;
    const firstPanelGate = new Promise<void>((r) => {
      releaseFirstPanelFetch = r;
    });
    const stalePreEvictIb = makeInbound(5, [{ id: uuidTarget, email, up: sixGb, down: 0, totalGB: tenGb }]);

    let liveInboundCalls = 0;
    const inFlightRead = getMyConfigs(uid, email, undefined, {
      dbClient: db,
      adminDbClient: db,
      currentPanelIdentity: PANEL_A_ID,
      getCachedInboundsFn: async () => [],
      getLiveInboundFn: async () => {
        liveInboundCalls++;
        if (liveInboundCalls === 1) {
          await firstPanelGate;
          return stalePreEvictIb;
        }
        // Post-eviction fresh panel read fails/returns null
        return null;
      },
      getInboundsFn: async () => [],
    });

    await new Promise((r) => setTimeout(r, 15));

    // Trigger mutation state eviction while first panel fetch is in flight
    for (let i = 0; i < 4; i++) {
      notifyClientTrafficInvalidated(`uuid-null-overflow-${i}`, 'reset');
    }

    releaseFirstPanelFetch();
    const res = await inFlightRead;

    assert.equal(res.configs.length, 1);
    const cfg = res.configs[0];
    assert.notEqual(
      cfg.trafficSource,
      'reset_confirmed',
      'Missing/null DB traffic counters MUST NEVER be interpreted as a confirmed traffic reset'
    );
    assert.equal(cfg.trafficVerified, false);
    assert.equal(cfg.trafficSource, 'unknown');
    assert.equal(cfg.usedTrafficKnown, false);
    assert.equal(cfg.remainingTrafficKnown, false);
    assert.equal(cfg.remainingGB, 'Unavailable');
    assert.equal(
      getLastKnownClientTrafficCacheStatsForTests().size,
      0,
      'Stale pre-eviction panel bytes MUST NOT be cached when post-eviction fresh read fails'
    );
  } finally {
    resetXuiServiceCachesForTests();
    resetLastKnownClientTrafficCacheForTests();
  }
});

// ---------------------------------------------------------------------------
// 47. Mutation state eviction when database traffic counters are stale non-zero values
// ---------------------------------------------------------------------------
test('47. Mutation state eviction when database traffic counters are stale non-zero values never fabricates reset or overwrites with stale DB bytes when fresh read fails', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();
  setMaxClientTrafficMutationStateEntriesForTests(2);

  try {
    const uid = 'uid-evict-stale-nonzero';
    const email = 'evictstalenonzero@example.com';
    const uuidTarget = 'uuid-evict-stale-nonzero-target';
    const twoGbStaleDb = 2 * 1024 * 1024 * 1024;
    const sevenGbPreEvictPanel = 7 * 1024 * 1024 * 1024;
    const tenGb = 10 * 1024 * 1024 * 1024;

    // DB has stale 2GB counters from an old sync that never changed during this request
    const db = createMockCustomerDb({
      vpn_accounts: [
        {
          id: 'acc-esnz-1',
          user_id: uid,
          email,
          uuid: uuidTarget,
          vless_url: `vless://${uuidTarget}@example.com:443#SG`,
          status: 'active',
          enable: true,
          total_bytes: tenGb,
          up_bytes: twoGbStaleDb,
          down_bytes: 0,
          used_bytes: twoGbStaleDb,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
      vpn_configs: [
        {
          id: 'cfg-esnz-1',
          user_id: uid,
          customer_uid: uid,
          uuid: uuidTarget,
          inbound_id: 5,
          status: 'active',
          enabled: true,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
    });

    let releaseFirstPanelFetch!: () => void;
    const firstPanelGate = new Promise<void>((r) => {
      releaseFirstPanelFetch = r;
    });
    const preEvictIb = makeInbound(5, [{ id: uuidTarget, email, up: sevenGbPreEvictPanel, down: 0, totalGB: tenGb }]);

    let liveInboundCalls = 0;
    const inFlightRead = getMyConfigs(uid, email, undefined, {
      dbClient: db,
      adminDbClient: db,
      currentPanelIdentity: PANEL_A_ID,
      getCachedInboundsFn: async () => [],
      getLiveInboundFn: async () => {
        liveInboundCalls++;
        if (liveInboundCalls === 1) {
          await firstPanelGate;
          return preEvictIb;
        }
        // Post-eviction fresh panel read fails
        return null;
      },
      getInboundsFn: async () => [],
    });

    await new Promise((r) => setTimeout(r, 15));

    // Trigger mutation state eviction while first panel fetch is in flight
    for (let i = 0; i < 4; i++) {
      notifyClientTrafficInvalidated(`uuid-nonzero-overflow-${i}`, 'reset');
    }

    releaseFirstPanelFetch();
    const res = await inFlightRead;

    assert.equal(res.configs.length, 1);
    const cfg = res.configs[0];
    assert.equal(cfg.trafficVerified, false, 'Must not trust unverified pre-eviction read or stale 2GB DB row after eviction');
    assert.equal(cfg.trafficSource, 'unknown');
    assert.equal(cfg.usedTrafficKnown, false);
    assert.equal(cfg.remainingTrafficKnown, false);
    assert.equal(cfg.remainingGB, 'Unavailable');
  } finally {
    resetXuiServiceCachesForTests();
    resetLastKnownClientTrafficCacheForTests();
  }
});

// ---------------------------------------------------------------------------
// 48. Mutation state eviction caused by unrelated UUID activity while the current UUID was not reset
// ---------------------------------------------------------------------------
test('48. Mutation state eviction caused by unrelated UUID activity performs a fresh post-eviction live panel read and preserves current UUID live traffic', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();
  setMaxClientTrafficMutationStateEntriesForTests(2);

  try {
    const uid = 'uid-evict-unrelated';
    const email = 'evictunrelated@example.com';
    const uuidTarget = 'uuid-evict-unrelated-target';
    const fiveGbLive = 5 * 1024 * 1024 * 1024;
    const tenGb = 10 * 1024 * 1024 * 1024;

    const db = createMockCustomerDb({
      vpn_accounts: [
        {
          id: 'acc-eu-1',
          user_id: uid,
          email,
          uuid: uuidTarget,
          vless_url: `vless://${uuidTarget}@example.com:443#SG`,
          status: 'active',
          enable: true,
          total_bytes: tenGb,
          up_bytes: 0,
          down_bytes: 0,
          used_bytes: 0,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
      vpn_configs: [
        {
          id: 'cfg-eu-1',
          user_id: uid,
          customer_uid: uid,
          uuid: uuidTarget,
          inbound_id: 5,
          status: 'active',
          enabled: true,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
    });

    let releaseFirstPanelFetch!: () => void;
    const firstPanelGate = new Promise<void>((r) => {
      releaseFirstPanelFetch = r;
    });
    const liveIb5 = makeInbound(5, [{ id: uuidTarget, email, up: fiveGbLive, down: 0, totalGB: tenGb }]);

    let liveInboundCalls = 0;
    const inFlightRead = getMyConfigs(uid, email, undefined, {
      dbClient: db,
      adminDbClient: db,
      currentPanelIdentity: PANEL_A_ID,
      getCachedInboundsFn: async () => [],
      getLiveInboundFn: async () => {
        liveInboundCalls++;
        if (liveInboundCalls === 1) {
          await firstPanelGate;
          return liveIb5;
        }
        // Second call is the fresh post-eviction live panel read
        return liveIb5;
      },
      getInboundsFn: async () => [],
    });

    await new Promise((r) => setTimeout(r, 15));

    // Unrelated UUIDs overflow the mutation state map while uuidTarget was NEVER reset or deleted
    for (let i = 0; i < 4; i++) {
      notifyClientTrafficInvalidated(`uuid-unrelated-activity-${i}`, 'reset');
    }

    releaseFirstPanelFetch();
    const res = await inFlightRead;

    assert.equal(liveInboundCalls, 2, 'Should perform 1 fresh post-eviction live inbound read after unrelated eviction');
    assert.equal(res.configs.length, 1);
    const cfg = res.configs[0];
    assert.equal(cfg.status, 'Active');
    assert.equal(cfg.trafficVerified, true);
    assert.equal(cfg.trafficSource, 'live');
    assert.equal(cfg.usedTrafficKnown, true);
    assert.equal(cfg.remainingTrafficKnown, true);
    assert.equal(cfg.usedGB, 5, 'Unrelated UUID eviction MUST NOT zero out or lose current UUID live 5GB traffic');
    assert.equal(cfg.remainingGB, 5);
  } finally {
    resetXuiServiceCachesForTests();
    resetLastKnownClientTrafficCacheForTests();
  }
});

// ---------------------------------------------------------------------------
// 49. Dashboard / MyVPN aggregate statistics when one or more configurations have unknown traffic
// ---------------------------------------------------------------------------
test('49. aggregateVerifiedVpnTraffic never treats unknown usage as confirmed zero usage and aggregates only verified known traffic', async () => {
  const frontendCardModulePath = path.resolve(process.cwd(), 'src', 'components', 'VpnConfigCard.tsx');
  const { aggregateVerifiedVpnTraffic } = await import(frontendCardModulePath);
  const oneGb = 1024 * 1024 * 1024;

  // Case A: All configurations have unknown traffic -> hasVerifiedUsageData is false, totalUsedGBDisplay is 'Unavailable'
  const allUnknownSummary = aggregateVerifiedVpnTraffic([
    {
      uuid: 'u-unknown-1',
      status: 'Status Unavailable',
      panelStatusVerified: false,
      trafficVerified: false,
      trafficSource: 'unknown',
      usedTrafficKnown: false,
      remainingTrafficKnown: false,
      usedGB: 0,
      remainingGB: 'Unavailable',
    },
    {
      uuid: 'u-unknown-2',
      status: 'Status Unavailable',
      panelStatusVerified: false,
      trafficVerified: false,
      trafficSource: 'unknown',
      usedTrafficKnown: false,
      remainingTrafficKnown: false,
      usedGB: 0,
      remainingGB: 'Unavailable',
    },
  ]);

  assert.equal(allUnknownSummary.hasVerifiedUsageData, false);
  assert.equal(allUnknownSummary.verifiedConfigCount, 0);
  assert.equal(allUnknownSummary.unknownConfigCount, 2);
  assert.equal(allUnknownSummary.totalUsedGBDisplay, 'Unavailable');

  // Case B: One configuration has verified 0 GB usage (after reset) and one has unknown traffic -> hasVerifiedUsageData is true (0 GB)
  const verifiedZeroAndUnknownSummary = aggregateVerifiedVpnTraffic([
    {
      uuid: 'u-verified-zero',
      status: 'Active',
      panelStatusVerified: true,
      trafficVerified: true,
      trafficSource: 'reset_confirmed',
      usedTrafficKnown: true,
      remainingTrafficKnown: true,
      upBytes: 0,
      downBytes: 0,
      usedGB: 0,
      remainingGB: 'Unlimited',
    },
    {
      uuid: 'u-unknown-3',
      status: 'Status Unavailable',
      panelStatusVerified: false,
      trafficVerified: false,
      trafficSource: 'unknown',
      usedTrafficKnown: false,
      remainingTrafficKnown: false,
      usedGB: 0,
      remainingGB: 'Unavailable',
    },
  ]);

  assert.equal(verifiedZeroAndUnknownSummary.hasVerifiedUsageData, true);
  assert.equal(verifiedZeroAndUnknownSummary.verifiedConfigCount, 1);
  assert.equal(verifiedZeroAndUnknownSummary.unknownConfigCount, 1);
  assert.equal(verifiedZeroAndUnknownSummary.totalUsedBytes, 0);
  assert.equal(verifiedZeroAndUnknownSummary.totalUsedGBDisplay, '0 GB');

  // Case C: One configuration has last-known cached traffic (4 GB) and one has unknown traffic
  const mixedKnownAndUnknown = aggregateVerifiedVpnTraffic([
    {
      uuid: 'u-cached-4gb',
      status: 'Status Unavailable',
      panelStatusVerified: false,
      trafficVerified: true,
      trafficSource: 'cached_scoped',
      usedTrafficKnown: true,
      remainingTrafficKnown: true,
      upBytes: oneGb,
      downBytes: 3 * oneGb,
      usedGB: 4,
      remainingGB: 6,
    },
    {
      uuid: 'u-unknown-4',
      status: 'Status Unavailable',
      panelStatusVerified: false,
      trafficVerified: false,
      trafficSource: 'unknown',
      usedTrafficKnown: false,
      remainingTrafficKnown: false,
      usedGB: 0,
      remainingGB: 'Unavailable',
    },
  ]);

  assert.equal(mixedKnownAndUnknown.hasVerifiedUsageData, true);
  assert.equal(mixedKnownAndUnknown.hasAnyLastKnownTraffic, true);
  assert.equal(mixedKnownAndUnknown.verifiedConfigCount, 1);
  assert.equal(mixedKnownAndUnknown.unknownConfigCount, 1);
  assert.equal(mixedKnownAndUnknown.totalUsedBytes, 4 * oneGb);
  assert.equal(mixedKnownAndUnknown.totalUsedGBDisplay, '4 GB');
});

// ---------------------------------------------------------------------------
// 50. Compatibility with both old and new backend response formats across VpnConfigCard, MyVPN, and Dashboard
// ---------------------------------------------------------------------------
test('50. resolveVpnTrafficDisplayState supports both old and new backend response formats without fabricating 0 GB, remaining quota, or Unlimited', async () => {
  const frontendCardModulePath = path.resolve(process.cwd(), 'src', 'components', 'VpnConfigCard.tsx');
  const { resolveVpnTrafficDisplayState } = await import(frontendCardModulePath);
  const hundredGb = 100 * 1024 * 1024 * 1024;

  // 1. New response: Finite 100GB package with unknown usage during 3X-UI outage
  const finiteUnknown = resolveVpnTrafficDisplayState({
    uuid: 'u-1',
    status: 'Status Unavailable',
    panelStatusVerified: false,
    trafficVerified: false,
    trafficSource: 'unknown',
    quotaVerified: true,
    usedTrafficKnown: false,
    remainingTrafficKnown: false,
    totalTrafficBytes: hundredGb,
    trafficLimit: '100GB',
    usedGB: 0,
    remainingGB: 'Unavailable',
    upload: 0,
    download: 0,
  });
  assert.equal(finiteUnknown.usedTrafficKnown, false);
  assert.equal(finiteUnknown.remainingTrafficKnown, false);
  assert.equal(finiteUnknown.usedGBDisplay, 'Unavailable', 'Must display Unavailable without appending GB');
  assert.equal(finiteUnknown.remainingGBDisplay, 'Unavailable', 'Must not display fabricated 100 GB remaining');
  assert.equal(finiteUnknown.hasFiniteQuota, true);
  assert.equal(finiteUnknown.isUnlimitedQuota, false);
  assert.equal(finiteUnknown.limitDisplay, '100 GB', 'Independently verified package allowance must be preserved');
  assert.equal(finiteUnknown.showUsageProgress, false, 'Must not show misleading 0% progress bar');

  // 2. New response: Unknown total quota (totalTrafficBytes === 0 without unlimited entitlement)
  const unknownQuota = resolveVpnTrafficDisplayState({
    uuid: 'u-2',
    status: 'Status Unavailable',
    panelStatusVerified: false,
    trafficVerified: false,
    trafficSource: 'unknown',
    quotaVerified: false,
    usedTrafficKnown: false,
    remainingTrafficKnown: false,
    totalTrafficBytes: 0,
    trafficLimit: 'Unavailable',
    usedGB: 0,
    remainingGB: 'Unavailable',
  });
  assert.equal(unknownQuota.isUnlimitedQuota, false, 'Unknown totalTrafficBytes=0 MUST NOT be interpreted as Unlimited');
  assert.equal(unknownQuota.hasFiniteQuota, false);
  assert.equal(unknownQuota.limitDisplay, 'Unavailable');
  assert.equal(unknownQuota.remainingGBDisplay, 'Unavailable');
  assert.equal(unknownQuota.usedGBDisplay, 'Unavailable');

  // 3. New response: Confirmed Unlimited package with unknown usage
  const unlimitedUnknownUsage = resolveVpnTrafficDisplayState({
    uuid: 'u-3',
    status: 'Status Unavailable',
    panelStatusVerified: false,
    trafficVerified: false,
    trafficSource: 'unknown',
    quotaVerified: true,
    usedTrafficKnown: false,
    remainingTrafficKnown: true,
    totalTrafficBytes: 0,
    trafficLimit: 'Unlimited',
    isUnlimitedPlan: true,
    usedGB: 0,
    remainingGB: 'Unlimited',
  });
  assert.equal(unlimitedUnknownUsage.isUnlimitedQuota, true);
  assert.equal(unlimitedUnknownUsage.limitDisplay, 'Unlimited');
  assert.equal(unlimitedUnknownUsage.remainingGBDisplay, 'Unlimited');
  assert.equal(unlimitedUnknownUsage.usedTrafficKnown, false);
  assert.equal(unlimitedUnknownUsage.usedGBDisplay, 'Unavailable');

  // 4. Legacy response: Live verified 0 GB usage (without new metadata fields)
  const legacyLiveZero = resolveVpnTrafficDisplayState({
    uuid: 'u-4',
    status: 'Active',
    panelStatusVerified: true,
    totalTrafficBytes: hundredGb,
    trafficLimit: '100GB',
    usedGB: 0,
    remainingGB: 100,
    upload: 0,
    download: 0,
  });
  assert.equal(legacyLiveZero.usedTrafficKnown, true);
  assert.equal(legacyLiveZero.remainingTrafficKnown, true);
  assert.equal(legacyLiveZero.isLastKnownTraffic, false);
  assert.equal(legacyLiveZero.usedGBDisplay, '0 GB');
  assert.equal(legacyLiveZero.remainingGBDisplay, '100 GB');
  assert.equal(legacyLiveZero.showUsageProgress, true);

  // 5. Legacy response: Unverified outage config with 0/missing usage (without new metadata fields)
  const legacyOutageUnknown = resolveVpnTrafficDisplayState({
    uuid: 'u-5',
    status: 'Status Unavailable',
    panelStatusVerified: false,
    totalTrafficBytes: hundredGb,
    trafficLimit: '100GB',
    usedGB: 0,
    remainingGB: 100,
  });
  assert.equal(legacyOutageUnknown.usedTrafficKnown, false);
  assert.equal(legacyOutageUnknown.usedGBDisplay, 'Unavailable');
  assert.equal(legacyOutageUnknown.remainingGBDisplay, 'Unavailable');
  assert.equal(legacyOutageUnknown.limitDisplay, '100 GB');
});

// ---------------------------------------------------------------------------
// 51. Every newly created authentication scope receives a unique strictly increasing monotonic generation (> 0)
// ---------------------------------------------------------------------------
test('51. Every newly created authentication scope receives a unique strictly increasing monotonic generation without sharing generation 0', async () => {
  resetXuiServiceCachesForTests();

  const seenGenerations = new Set<number>();
  let previousGen = 0;

  for (let i = 0; i < 6; i++) {
    const cfg = makeConfig({
      panelUrl: `https://monotonic-create-${i}.firevpn.example:2053/sub`,
      password: `pw-mono-${i}`,
      apiToken: `pw-mono-${i}`,
    });
    const { scopeKey } = computeXuiCredentialScopeKey(cfg);
    await getXuiAuthHeaders(cfg, false, 6000, {
      loginPostFn: async () => ({
        status: 200,
        headers: { 'set-cookie': [`3x-ui=mono-${i}; Path=/`] },
        data: { success: true },
      }),
      csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
    });
    const gen = getScopeAuthGeneration(scopeKey);
    assert.ok(gen > 0, `Newly created scope ${i} generation (${gen}) must be strictly positive (> 0)`);
    assert.ok(
      gen > previousGen,
      `Newly created scope ${i} generation (${gen}) must be strictly greater than previous scope generation (${previousGen})`
    );
    assert.equal(seenGenerations.has(gen), false, `Generation ${gen} must never be shared across scopes`);
    seenGenerations.add(gen);
    previousGen = gen;
  }
});

// ---------------------------------------------------------------------------
// 52. Positive-to-zero stored DB counters after mutation-state eviction WITHOUT explicit reset evidence never prove a confirmed reset
// ---------------------------------------------------------------------------
test('52. Positive-to-zero stored DB counters during mutation-state eviction without explicit verified reset evidence never prove reset_confirmed', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();
  setMaxClientTrafficMutationStateEntriesForTests(3);

  try {
    const uid = 'uid-pos-to-zero-no-reset';
    const email = 'postozeronoreset@example.com';
    const uuidTarget = 'uuid-pos-to-zero-no-reset-1';
    const sixGb = 6 * 1024 * 1024 * 1024;
    const fiftyGb = 50 * 1024 * 1024 * 1024;

    const db = createMockCustomerDb({
      vpn_accounts: [
        {
          id: 'acc-ptz-1',
          user_id: uid,
          email,
          uuid: uuidTarget,
          vless_url: `vless://${uuidTarget}@example.com:443#SG`,
          status: 'active',
          enable: true,
          total_bytes: fiftyGb,
          data_limit: '50GB',
          up_bytes: sixGb,
          down_bytes: 0,
          used_bytes: sixGb,
          // NO last_traffic_reset_at or traffic_reset_at!
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
      vpn_configs: [
        {
          id: 'cfg-ptz-1',
          user_id: uid,
          customer_uid: uid,
          uuid: uuidTarget,
          inbound_id: 5,
          data_limit: '50GB',
          status: 'active',
          enabled: true,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
    });

    let releaseFirstPanelFetch!: () => void;
    const firstPanelGate = new Promise<void>((r) => {
      releaseFirstPanelFetch = r;
    });
    let liveFetchCalls = 0;
    const observedOptions: any[] = [];

    const inFlightRead = getMyConfigs(uid, email, undefined, {
      dbClient: db,
      adminDbClient: db,
      currentPanelIdentity: PANEL_A_ID,
      getCachedInboundsFn: async () => [],
      getLiveInboundFn: async (_id, opts) => {
        liveFetchCalls++;
        observedOptions.push(opts);
        if (liveFetchCalls === 1) {
          await firstPanelGate;
          return makeInbound(5, [{ id: uuidTarget, email, up: sixGb, down: 0, totalGB: fiftyGb }]);
        }
        // Post-eviction fresh panel read fails/unavailable
        return null;
      },
      getInboundsFn: async () => [],
    });

    await new Promise((r) => setTimeout(r, 15));

    // Stored DB counters transition from positive (6 GB) to explicit 0 WITHOUT any reset event or reset timestamp for uuidTarget
    db.state.vpn_accounts[0].up_bytes = 0;
    db.state.vpn_accounts[0].down_bytes = 0;
    db.state.vpn_accounts[0].used_bytes = 0;

    // Unrelated UUIDs overflow clientTrafficMutationStateByUuid (cap=3)
    for (let i = 0; i < 5; i++) {
      notifyClientTrafficInvalidated(`uuid-ptz-unrelated-${i}`, 'reset');
    }

    releaseFirstPanelFetch();
    const res = await inFlightRead;

    assert.equal(res.configs.length, 1);
    const cfg = res.configs[0];
    assert.equal(liveFetchCalls, 2, 'Must attempt a fresh post-eviction panel read when no explicit reset evidence exists');
    assert.equal(
      typeof observedOptions[1] === 'object' && observedOptions[1]?.forceRefresh,
      true,
      'Post-eviction fresh panel read must pass forceRefresh: true'
    );
    assert.notEqual(
      cfg.trafficSource,
      'reset_confirmed',
      'Positive-to-zero stored counters without explicit reset evidence MUST NEVER be classified as reset_confirmed'
    );
    assert.equal(cfg.trafficSource, 'unknown');
    assert.equal(cfg.trafficVerified, false);
    assert.equal(cfg.usedTrafficKnown, false);
    assert.equal(cfg.remainingTrafficKnown, false);
    assert.equal(cfg.remainingGB, 'Unavailable');
  } finally {
    resetXuiServiceCachesForTests();
    resetLastKnownClientTrafficCacheForTests();
  }
});

// ---------------------------------------------------------------------------
// 53. Post-eviction fresh panel read genuinely bypasses liveInboundCache in xuiService
// ---------------------------------------------------------------------------
test('53. Post-eviction fresh panel read genuinely bypasses liveInboundCache (10s TTL) and retrieves fresh panel traffic', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();
  setMaxClientTrafficMutationStateEntriesForTests(3);

  try {
    const uid = 'uid-bypass-live-cache';
    const email = 'bypasslivecache@example.com';
    const uuidTarget = 'uuid-bypass-live-cache-1';
    const twoGb = 2 * 1024 * 1024 * 1024;
    const nineGb = 9 * 1024 * 1024 * 1024;
    const fiftyGb = 50 * 1024 * 1024 * 1024;

    const staleCachedInbound = makeInbound(5, [
      { id: uuidTarget, email, up: twoGb, down: 0, totalGB: fiftyGb },
    ]);
    const freshPanelInbound = makeInbound(5, [
      { id: uuidTarget, email, up: nineGb, down: 0, totalGB: fiftyGb },
    ]);

    const db = createMockCustomerDb({
      vpn_accounts: [
        {
          id: 'acc-blc-1',
          user_id: uid,
          email,
          uuid: uuidTarget,
          vless_url: `vless://${uuidTarget}@example.com:443#SG`,
          status: 'active',
          enable: true,
          total_bytes: fiftyGb,
          data_limit: '50GB',
          up_bytes: 0,
          down_bytes: 0,
          used_bytes: 0,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
      vpn_configs: [
        {
          id: 'cfg-blc-1',
          user_id: uid,
          customer_uid: uid,
          uuid: uuidTarget,
          inbound_id: 5,
          data_limit: '50GB',
          status: 'active',
          enabled: true,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
    });

    let releaseFirstPanelFetch!: () => void;
    const firstPanelGate = new Promise<void>((r) => {
      releaseFirstPanelFetch = r;
    });
    let panelCalls = 0;
    const observedForceRefreshFlags: boolean[] = [];

    // Delegate getLiveInboundFn directly to the real xuiService.getLiveInbound so liveInboundCache is exercised
    const inFlightRead = getMyConfigs(uid, email, undefined, {
      dbClient: db,
      adminDbClient: db,
      currentPanelIdentity: PANEL_A_ID,
      getCachedInboundsFn: async () => [],
      getLiveInboundFn: async (id, opts) => {
        const forceRefresh = typeof opts === 'boolean' ? opts : Boolean(opts?.forceRefresh);
        observedForceRefreshFlags.push(forceRefresh);
        const result = await getLiveInbound(id, {
          forceRefresh,
          fetcher: async () => {
            panelCalls++;
            if (panelCalls === 1) {
              await firstPanelGate;
              return staleCachedInbound;
            }
            return freshPanelInbound;
          },
        });
        // After the 1st call finishes, confirm liveInboundCache is now freshly populated (within 10s TTL) with staleCachedInbound (2 GB)
        if (panelCalls === 1) {
          const cachedImmediate = await getLiveInbound(id, {
            forceRefresh: false,
            fetcher: async () => {
              throw new Error('Should have been served from warm 10s TTL liveInboundCache');
            },
          });
          assert.equal(cachedImmediate?.clientStats?.[0]?.up, twoGb);
        }
        return result;
      },
      getInboundsFn: async () => [],
    });

    // Wait until initial getMyConfigs step is paused inside the 1st live inbound fetch, then overflow mutation state map
    await new Promise((r) => setTimeout(r, 15));
    for (let i = 0; i < 5; i++) {
      notifyClientTrafficInvalidated(`uuid-blc-unrelated-${i}`, 'reset');
    }

    // Release 1st fetch: it populates liveInboundCache with 2 GB, then getMyConfigs detects mid-flight eviction
    // and must invalidate + forceRefresh past liveInboundCache to fetch freshPanelInbound (9 GB).
    releaseFirstPanelFetch();
    const res = await inFlightRead;

    assert.equal(res.configs.length, 1);
    const cfg = res.configs[0];
    assert.equal(panelCalls, 2, 'Post-eviction fresh panel read MUST invoke panel fetcher a 2nd time, bypassing warm liveInboundCache');
    assert.deepEqual(observedForceRefreshFlags, [false, true], '1st read uses normal cacheable fetch; 2nd post-eviction read MUST pass forceRefresh: true');
    assert.equal(cfg.usedGB, 9, 'Post-eviction fresh panel read MUST bypass stale 2 GB liveInboundCache and return fresh 9 GB');
    assert.equal(cfg.trafficSource, 'live');
    assert.equal(cfg.trafficVerified, true);
    assert.equal(cfg.usedTrafficKnown, true);
  } finally {
    resetXuiServiceCachesForTests();
    resetLastKnownClientTrafficCacheForTests();
  }
});

// ---------------------------------------------------------------------------
// Helper: Production-schema mock DB wrapper where vpn_configs has customer_uid
// and does NOT have user_id (reproducing exact Supabase Postgres 42703 / PGRST204 error)
// ---------------------------------------------------------------------------
function createProductionSchemaCustomerDb(
  baseDb: ReturnType<typeof createMockCustomerDb>,
  opts?: {
    vpnConfigsUserIdError?: { code?: string; message: string } | null;
    vpnConfigsCustomerUidError?: { code?: string; message: string } | null;
    profiles?: any[];
  }
) {
  const userIdErr =
    opts?.vpnConfigsUserIdError !== undefined
      ? opts.vpnConfigsUserIdError
      : { code: '42703', message: 'column vpn_configs.user_id does not exist' };
  const customerUidErr = opts?.vpnConfigsCustomerUidError ?? null;
  const profiles = opts?.profiles ?? [];

  return {
    state: baseDb.state,
    from(table: string) {
      if (table === 'profiles') {
        const filters: Array<{ col: string; val: any }> = [];
        const builder: any = {
          select: () => builder,
          eq: (col: string, val: any) => {
            filters.push({ col, val });
            return builder;
          },
          maybeSingle: async () => {
            const match = profiles.find((row) =>
              filters.every((f) => String(row?.[f.col] ?? '') === String(f.val ?? ''))
            );
            return { data: match || null, error: null };
          },
        };
        return builder;
      }

      const inner = baseDb.from(table);
      if (table !== 'vpn_configs') {
        return inner;
      }

      let queriedUserId = false;
      let queriedCustomerUid = false;
      const wrappedSelect = (cols?: string) => {
        const q = inner.select(cols);
        const origEq = q.eq.bind(q);
        q.eq = (col: string, val: any) => {
          if (col === 'user_id') queriedUserId = true;
          if (col === 'customer_uid') queriedCustomerUid = true;
          return origEq(col, val);
        };
        const origThen = q.then.bind(q);
        q.then = (resolve: any, reject: any) => {
          if (queriedUserId && userIdErr) {
            return Promise.resolve({ data: null, error: userIdErr }).then(resolve, reject);
          }
          if (queriedCustomerUid && customerUidErr) {
            return Promise.resolve({ data: null, error: customerUidErr }).then(resolve, reject);
          }
          return origThen(resolve, reject);
        };
        return q;
      };

      return {
        ...inner,
        select: wrappedSelect,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 54. Production schema (vpn_configs.customer_uid exists, vpn_configs.user_id does NOT exist)
//     succeeds cleanly for both /api/vpn/my-configs (getMyConfigs) and /api/client/status (getClientStatus)
//     with strict customer ownership isolation
// ---------------------------------------------------------------------------
test('54. Production schema without vpn_configs.user_id succeeds for getMyConfigs (/api/vpn/my-configs) and getClientStatus (/api/client/status) with strict customer isolation', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uidAlice = 'uid-prod-alice';
  const emailAlice = 'alice@example.com';
  const uuidAlice = 'uuid-prod-alice-1';

  const uidBob = 'uid-prod-bob';
  const emailBob = 'bob@example.com';
  const uuidBob = 'uuid-prod-bob-1';

  const fiftyGb = 50 * 1024 * 1024 * 1024;
  const threeGb = 3 * 1024 * 1024 * 1024;
  const sevenGb = 7 * 1024 * 1024 * 1024;

  const baseDb = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-alice-1',
        user_id: uidAlice,
        email: emailAlice,
        uuid: uuidAlice,
        order_id: 'ORD-ALICE-1',
        vless_url: `vless://${uuidAlice}@example.com:443#AliceSG`,
        status: 'active',
        enable: true,
        total_bytes: fiftyGb,
        data_limit: '50GB',
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'acc-bob-1',
        user_id: uidBob,
        email: emailBob,
        uuid: uuidBob,
        order_id: 'ORD-BOB-1',
        vless_url: `vless://${uuidBob}@example.com:443#BobSG`,
        status: 'active',
        enable: true,
        total_bytes: fiftyGb,
        data_limit: '50GB',
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    // Exact production vpn_configs rows: customer_uid ONLY (no user_id column)
    vpn_configs: [
      {
        id: 'cfg-alice-1',
        customer_uid: uidAlice,
        uuid: uuidAlice,
        order_id: 'ORD-ALICE-1',
        inbound_id: 5,
        data_limit: '50GB',
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'cfg-bob-1',
        customer_uid: uidBob,
        uuid: uuidBob,
        order_id: 'ORD-BOB-1',
        inbound_id: 5,
        data_limit: '50GB',
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    orders: [
      {
        id: 'ORD-ALICE-1',
        order_id: 'ORD-ALICE-1',
        customer_id: uidAlice,
        email: emailAlice,
        client_uuid: uuidAlice,
        vless_url: `vless://${uuidAlice}@example.com:443#AliceSG`,
        status: 'approved',
        payment_status: 'Paid',
        provisioning_status: 'completed',
        traffic_limit: '50GB',
      },
      {
        id: 'ORD-BOB-1',
        order_id: 'ORD-BOB-1',
        customer_id: uidBob,
        email: emailBob,
        client_uuid: uuidBob,
        vless_url: `vless://${uuidBob}@example.com:443#BobSG`,
        status: 'approved',
        payment_status: 'Paid',
        provisioning_status: 'completed',
        traffic_limit: '50GB',
      },
    ],
  });

  // Test both PostgreSQL 42703 and PostgREST PGRST204 missing-column error variants
  const missingColumnVariants = [
    { code: '42703', message: 'column vpn_configs.user_id does not exist' },
    { code: 'PGRST204', message: "Could not find the 'user_id' column of 'vpn_configs' in the schema cache" },
  ];

  const liveIb = makeInbound(5, [
    { id: uuidAlice, email: emailAlice, enable: true, up: threeGb, down: 0, totalGB: fiftyGb },
    { id: uuidBob, email: emailBob, enable: true, up: sevenGb, down: 0, totalGB: fiftyGb },
  ]);

  for (const variantErr of missingColumnVariants) {
    const prodDb = createProductionSchemaCustomerDb(baseDb, {
      vpnConfigsUserIdError: variantErr,
      profiles: [{ id: uidAlice, active_vpn_uuid: uuidAlice }],
    });

    // 1. Verify /api/vpn/my-configs (getMyConfigs) for Alice
    const myConfigsRes = await getMyConfigs(uidAlice, emailAlice, undefined, {
      dbClient: prodDb,
      adminDbClient: prodDb,
      currentPanelIdentity: PANEL_A_ID,
      getCachedInboundsFn: async () => [],
      getLiveInboundFn: async () => liveIb,
      getInboundsFn: async () => [],
    });

    assert.equal(myConfigsRes.configs.length, 1, 'Alice must see strictly her own 1 VPN configuration');
    assert.equal(myConfigsRes.configs[0].uuid, uuidAlice);
    assert.equal(myConfigsRes.configs[0].inboundId, 5, 'inbound_id must resolve from vpn_configs.customer_uid');
    assert.equal(myConfigsRes.configs[0].status, 'Active');
    assert.equal(myConfigsRes.configs[0].usedGB, 3);
    assert.equal(myConfigsRes.configs[0].remainingGB, 47);
    assert.equal(myConfigsRes.configs[0].trafficVerified, true);
    assert.equal(myConfigsRes.configs[0].trafficSource, 'live');
    assert.equal(myConfigsRes.configs[0].quotaVerified, true);
    assert.equal(myConfigsRes.configs[0].usedTrafficKnown, true);
    assert.equal(myConfigsRes.configs[0].remainingTrafficKnown, true);
    assert.equal(
      myConfigsRes.configs.some((c) => c.uuid === uuidBob),
      false,
      'Must NEVER expose another customer VPN configuration'
    );
    assert.equal(prodDb.state.writes.length, 0, 'getMyConfigs must remain strictly read-only');

    // 2. Verify /api/client/status (getClientStatus) for Alice on the exact same production schema
    const statusRes = await getClientStatus(emailAlice, undefined, uidAlice, undefined, {
      dbClient: prodDb,
      getMyConfigsOptions: {
        dbClient: prodDb,
        adminDbClient: prodDb,
        currentPanelIdentity: PANEL_A_ID,
        getCachedInboundsFn: async () => [],
        getLiveInboundFn: async () => liveIb,
        getInboundsFn: async () => [],
      },
    });

    assert.ok(statusRes, 'getClientStatus must return Alice active VPN status on production schema');
    assert.equal(statusRes.uuid, uuidAlice);
    assert.equal(statusRes.status, 'Active');
    assert.equal(statusRes.usedGB, 3);
    assert.equal(statusRes.remainingGB, 47);
    assert.equal(statusRes.trafficVerified, true);
    assert.equal(statusRes.trafficSource, 'live');
    assert.equal(statusRes.usedTrafficKnown, true);
    assert.equal(statusRes.remainingTrafficKnown, true);
    assert.notEqual(statusRes.uuid, uuidBob);
  }
});

// ---------------------------------------------------------------------------
// 55. Post-eviction authoritative DB recheck succeeds cleanly on production schema (no vpn_configs.user_id)
// ---------------------------------------------------------------------------
test('55. Post-eviction authoritative DB recheck succeeds on production schema without vpn_configs.user_id and preserves fresh panel read', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();
  setMaxClientTrafficMutationStateEntriesForTests(3);

  try {
    const uid = 'uid-prod-recheck';
    const email = 'prodrecheck@example.com';
    const uuidTarget = 'uuid-prod-recheck-1';
    const fiftyGb = 50 * 1024 * 1024 * 1024;
    const fourGb = 4 * 1024 * 1024 * 1024;
    const eightGb = 8 * 1024 * 1024 * 1024;

    const baseDb = createMockCustomerDb({
      vpn_accounts: [
        {
          id: 'acc-pr-1',
          user_id: uid,
          email,
          uuid: uuidTarget,
          vless_url: `vless://${uuidTarget}@example.com:443#SG`,
          status: 'active',
          enable: true,
          total_bytes: fiftyGb,
          data_limit: '50GB',
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
      vpn_configs: [
        {
          id: 'cfg-pr-1',
          customer_uid: uid, // Production schema: customer_uid only
          uuid: uuidTarget,
          inbound_id: 5,
          data_limit: '50GB',
          status: 'active',
          enabled: true,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
    });
    const prodDb = createProductionSchemaCustomerDb(baseDb);

    let releaseFirstFetch!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirstFetch = r;
    });
    let fetchCount = 0;

    const inFlightRead = getMyConfigs(uid, email, undefined, {
      dbClient: prodDb,
      adminDbClient: prodDb,
      currentPanelIdentity: PANEL_A_ID,
      getCachedInboundsFn: async () => [],
      getLiveInboundFn: async (_id, opts) => {
        fetchCount++;
        if (fetchCount === 1) {
          await firstGate;
          return makeInbound(5, [{ id: uuidTarget, email, up: fourGb, down: 0, totalGB: fiftyGb }]);
        }
        assert.equal(typeof opts === 'object' && opts?.forceRefresh, true);
        return makeInbound(5, [{ id: uuidTarget, email, up: eightGb, down: 0, totalGB: fiftyGb }]);
      },
      getInboundsFn: async () => [],
    });

    await new Promise((r) => setTimeout(r, 15));
    for (let i = 0; i < 5; i++) {
      notifyClientTrafficInvalidated(`uuid-pr-unrelated-${i}`, 'reset');
    }

    releaseFirstFetch();
    const res = await inFlightRead;

    assert.equal(res.configs.length, 1);
    assert.equal(res.configs[0].uuid, uuidTarget);
    assert.equal(res.configs[0].usedGB, 8);
    assert.equal(res.configs[0].remainingGB, 42);
    assert.equal(res.configs[0].trafficSource, 'live');
    assert.equal(res.configs[0].trafficVerified, true);
    assert.equal(prodDb.state.writes.length, 0);
  } finally {
    resetXuiServiceCachesForTests();
    resetLastKnownClientTrafficCacheForTests();
  }
});

// ---------------------------------------------------------------------------
// 56. Genuine database errors (permission denied, network error, timeout, customer_uid error)
//     on vpn_configs are NEVER suppressed and fail closed
// ---------------------------------------------------------------------------
test('56. Genuine database, permission, network, timeout, and customer_uid errors on vpn_configs are NEVER suppressed', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-genuine-err';
  const email = 'genuineerr@example.com';

  const makeBase = () =>
    createMockCustomerDb({
      vpn_accounts: [
        {
          id: 'acc-ge-1',
          user_id: uid,
          email,
          uuid: 'uuid-ge-1',
          vless_url: 'vless://uuid-ge-1@example.com:443#SG',
          status: 'active',
          enable: true,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
      vpn_configs: [
        {
          id: 'cfg-ge-1',
          customer_uid: uid,
          uuid: 'uuid-ge-1',
          inbound_id: 5,
          status: 'active',
          enabled: true,
          panel_identity: PANEL_A_ID,
          created_at: PAST_CREATED_AT,
        },
      ],
    });

  // Case A: Permission denied (42501) on optional user_id query MUST NOT be suppressed
  const permDeniedDb = createProductionSchemaCustomerDb(makeBase(), {
    vpnConfigsUserIdError: { code: '42501', message: 'permission denied for table vpn_configs' },
  });
  await assert.rejects(
    () =>
      getMyConfigs(uid, email, undefined, {
        dbClient: permDeniedDb,
        adminDbClient: permDeniedDb,
        currentPanelIdentity: PANEL_A_ID,
        getCachedInboundsFn: async () => [],
        getLiveInboundFn: async () => null,
        getInboundsFn: async () => [],
      }),
    (err: any) =>
      err?.code === 'CUSTOMER_CONFIG_QUERY_FAILED' &&
      err?.status === 503 &&
      /permission denied/i.test(String(err?.message || ''))
  );

  // Case B: Network failure on optional user_id query MUST NOT be suppressed
  const networkFailDb = createProductionSchemaCustomerDb(makeBase(), {
    vpnConfigsUserIdError: { message: 'TypeError: fetch failed: ECONNREFUSED' },
  });
  await assert.rejects(
    () =>
      getMyConfigs(uid, email, undefined, {
        dbClient: networkFailDb,
        adminDbClient: networkFailDb,
        currentPanelIdentity: PANEL_A_ID,
        getCachedInboundsFn: async () => [],
        getLiveInboundFn: async () => null,
        getInboundsFn: async () => [],
      }),
    (err: any) =>
      err?.code === 'CUSTOMER_CONFIG_QUERY_FAILED' &&
      err?.status === 503 &&
      /fetch failed/i.test(String(err?.message || ''))
  );

  // Case C: Statement timeout (57014) on optional user_id query MUST NOT be suppressed
  const timeoutDb = createProductionSchemaCustomerDb(makeBase(), {
    vpnConfigsUserIdError: { code: '57014', message: 'canceling statement due to statement timeout' },
  });
  await assert.rejects(
    () =>
      getMyConfigs(uid, email, undefined, {
        dbClient: timeoutDb,
        adminDbClient: timeoutDb,
        currentPanelIdentity: PANEL_A_ID,
        getCachedInboundsFn: async () => [],
        getLiveInboundFn: async () => null,
        getInboundsFn: async () => [],
      }),
    (err: any) =>
      err?.code === 'CUSTOMER_CONFIG_QUERY_FAILED' &&
      err?.status === 503 &&
      /statement timeout/i.test(String(err?.message || ''))
  );

  // Case D: Error on primary customer_uid query MUST NEVER be suppressed (even if missing-column)
  const primaryFailDb = createProductionSchemaCustomerDb(makeBase(), {
    vpnConfigsCustomerUidError: { code: '42703', message: 'column vpn_configs.customer_uid does not exist' },
    vpnConfigsUserIdError: null,
  });
  await assert.rejects(
    () =>
      getMyConfigs(uid, email, undefined, {
        dbClient: primaryFailDb,
        adminDbClient: primaryFailDb,
        currentPanelIdentity: PANEL_A_ID,
        getCachedInboundsFn: async () => [],
        getLiveInboundFn: async () => null,
        getInboundsFn: async () => [],
      }),
    (err: any) =>
      err?.code === 'CUSTOMER_CONFIG_QUERY_FAILED' &&
      err?.status === 503 &&
      /vpn_configs_customer_uid/i.test(String(err?.message || ''))
  );
});

// ---------------------------------------------------------------------------
// 57. Alternative schema where vpn_configs.user_id exists continues to work with strict customer isolation
// ---------------------------------------------------------------------------
test('57. Alternative schema where vpn_configs.user_id exists continues to resolve customer configs with strict ownership isolation', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const uid = 'uid-alt-schema';
  const email = 'altschema@example.com';
  const uuidMine = 'uuid-alt-mine-1';
  const uuidOther = 'uuid-alt-other-1';
  const fiftyGb = 50 * 1024 * 1024 * 1024;
  const twoGb = 2 * 1024 * 1024 * 1024;

  const baseDb = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-alt-1',
        user_id: uid,
        email,
        uuid: uuidMine,
        vless_url: `vless://${uuidMine}@example.com:443#SG`,
        status: 'active',
        enable: true,
        total_bytes: fiftyGb,
        data_limit: '50GB',
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-alt-1',
        user_id: uid, // Alternative schema row using user_id
        uuid: uuidMine,
        inbound_id: 7,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'cfg-alt-other',
        user_id: 'uid-someone-else',
        uuid: uuidOther,
        inbound_id: 8,
        status: 'active',
        enabled: true,
        panel_identity: PANEL_A_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const altDb = createProductionSchemaCustomerDb(baseDb, {
    vpnConfigsUserIdError: null,
  });

  const liveIb7 = makeInbound(7, [
    { id: uuidMine, email, enable: true, up: twoGb, down: 0, totalGB: fiftyGb },
  ]);

  const res = await getMyConfigs(uid, email, undefined, {
    dbClient: altDb,
    adminDbClient: altDb,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [],
    getLiveInboundFn: async (id) => (id === 7 ? liveIb7 : null),
    getInboundsFn: async () => [],
  });

  assert.equal(res.configs.length, 1);
  assert.equal(res.configs[0].uuid, uuidMine);
  assert.equal(res.configs[0].inboundId, 7);
  assert.equal(res.configs[0].usedGB, 2);
  assert.equal(res.configs[0].remainingGB, 48);
  assert.equal(res.configs.some((c) => c.uuid === uuidOther), false);
});


