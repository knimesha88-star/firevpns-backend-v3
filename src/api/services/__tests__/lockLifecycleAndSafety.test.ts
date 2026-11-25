import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePanelIdentity,
  isPanelDeletionSyncFlagEnabled,
  verifyAndMarkClientDeletedIfConfirmed,
  syncDeleted3XUiClients,
  finalizeDurableProvisioningOperationLock,
  withInboundWriteLock,
  withClientMutationLock,
  provisionOrderClient,
  revokeProvisionalOrderClient,
  provisionProvisionalRenewal,
  confirmProvisionalRenewal,
  revokeProvisionalRenewal,
  parseInboundSettingsClientsStrict,
  XuiInbound,
  UncachedInboundReadResult,
  UncachedInboundsListReadResult,
} from '../xuiService.js';
import { getMyConfigs } from '../vpnService.js';

const PANEL_URL = 'https://panel-prod.firevpns.internal:2053/panel';
const PANEL_ID = computePanelIdentity(PANEL_URL);
const PAST_CREATED_AT = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
const FUTURE_EXPIRY_MS = Date.now() + 20 * 24 * 60 * 60 * 1000;
const EXPIRED_EXPIRY_MS = Date.now() - 3 * 24 * 60 * 60 * 1000;

interface LockRecord {
  operation_key: string;
  operation_type: string;
  target_id: string;
  client_uuid: string | null;
  lock_owner_id: string;
  status: 'in_progress' | 'completed' | 'failed' | 'uncertain';
  error_message?: string | null;
}

interface MockState {
  vpn_accounts: any[];
  vpn_configs: any[];
  orders: any[];
  renew_requests: any[];
  vpn_entitlement_grants: any[];
  provisioning_operations: LockRecord[];
  profiles: any[];
  audit_logs: any[];
  xui_servers: any[];
  provision_templates: any[];
  rpcCalls: Array<{ fn: string; args: Record<string, any> }>;
  writeLog: Array<{ table: string; op: 'insert' | 'update'; payload: Record<string, any> }>;
}

function createLockAwareMockDb(initial?: Partial<MockState>) {
  const state: MockState = {
    vpn_accounts: initial?.vpn_accounts ? structuredClone(initial.vpn_accounts) : [],
    vpn_configs: initial?.vpn_configs ? structuredClone(initial.vpn_configs) : [],
    orders: initial?.orders ? structuredClone(initial.orders) : [],
    renew_requests: initial?.renew_requests ? structuredClone(initial.renew_requests) : [],
    vpn_entitlement_grants: initial?.vpn_entitlement_grants ? structuredClone(initial.vpn_entitlement_grants) : [],
    provisioning_operations: initial?.provisioning_operations ? structuredClone(initial.provisioning_operations) : [],
    profiles: initial?.profiles ? structuredClone(initial.profiles) : [],
    audit_logs: initial?.audit_logs ? structuredClone(initial.audit_logs) : [],
    xui_servers: initial?.xui_servers ? structuredClone(initial.xui_servers) : [],
    provision_templates: initial?.provision_templates ? structuredClone(initial.provision_templates) : [],
    rpcCalls: [],
    writeLog: [],
  };

  const matchFilters = (row: any, filters: Array<{ op: string; col: string; val: any }>) => {
    for (const f of filters) {
      const rv = row?.[f.col];
      if (f.op === 'eq' && rv !== f.val) return false;
      if (f.op === 'neq' && rv === f.val) return false;
      if (f.op === 'ilike' && String(rv || '').toLowerCase() !== String(f.val || '').toLowerCase()) return false;
      if (f.op === 'in' && !(Array.isArray(f.val) && f.val.includes(rv))) return false;
      if (f.op === 'gte' && !(rv && String(rv) >= String(f.val))) return false;
      if (f.op === 'not_null' && (rv === null || rv === undefined)) return false;
    }
    return true;
  };

  const makeBuilder = (table: keyof MockState) => {
    const filters: Array<{ op: string; col: string; val: any }> = [];
    let updatePayload: Record<string, any> | null = null;
    let insertPayload: Record<string, any> | null = null;
    let limitCount: number | null = null;
    let singleMode = false;

    const execute = async () => {
      const rows = (state[table] as any[]) || [];

      if (insertPayload) {
        const rec = {
          id: `${String(table)}-${rows.length + 1}`,
          created_at: new Date().toISOString(),
          ...insertPayload,
        };
        rows.push(rec);
        state.writeLog.push({ table: String(table), op: 'insert', payload: insertPayload });
        return { data: singleMode ? rec : [rec], error: null };
      }

      if (updatePayload) {
        if (table === 'vpn_configs' && 'updated_at' in updatePayload) {
          return { data: null, error: { message: 'column "updated_at" of relation "vpn_configs" does not exist' } };
        }
        const matched = rows.filter((r) => matchFilters(r, filters));
        for (const r of matched) {
          Object.assign(r, updatePayload);
        }
        if (matched.length > 0) {
          state.writeLog.push({ table: String(table), op: 'update', payload: { ...updatePayload } });
        }
        return { data: singleMode ? matched[0] || null : matched, error: null };
      }

      let matched = rows.filter((r) => matchFilters(r, filters));
      if (limitCount !== null) matched = matched.slice(0, limitCount);
      return { data: singleMode ? matched[0] || null : matched, error: null };
    };

    const builder: any = {
      select() { return builder; },
      order() { return builder; },
      eq(col: string, val: any) { filters.push({ op: 'eq', col, val }); return builder; },
      neq(col: string, val: any) { filters.push({ op: 'neq', col, val }); return builder; },
      ilike(col: string, val: any) { filters.push({ op: 'ilike', col, val }); return builder; },
      in(col: string, val: any[]) { filters.push({ op: 'in', col, val }); return builder; },
      gte(col: string, val: any) { filters.push({ op: 'gte', col, val }); return builder; },
      not(col: string, op: string, val: any) {
        if (op === 'is' && val === null) filters.push({ op: 'not_null', col, val: null });
        return builder;
      },
      limit(n: number) { limitCount = n; return builder; },
      maybeSingle() { singleMode = true; return execute(); },
      single() { singleMode = true; return execute(); },
      update(payload: Record<string, any>) { updatePayload = payload; return builder; },
      insert(payload: Record<string, any>) { insertPayload = payload; return builder; },
      upsert(payload: Record<string, any>) {
        const rows = (state[table] as any[]) || [];
        const existing = rows.find(
          (r) =>
            (payload.id && r.id === payload.id) ||
            (payload.uuid && r.uuid === payload.uuid) ||
            (payload.grant_type && payload.source_id && r.grant_type === payload.grant_type && r.source_id === payload.source_id)
        );
        if (existing) {
          Object.assign(existing, payload);
          return builder;
        }
        insertPayload = payload;
        return builder;
      },
      then(resolve: any, reject: any) { return execute().then(resolve, reject); },
    };
    return builder;
  };

  const getLockRow = (key: string) =>
    state.provisioning_operations.find((r) => r.operation_key === key);

  const dbClient: any = {
    state,
    getLockRow,
    from(table: string) {
      return makeBuilder(table as keyof MockState);
    },
    async rpc(fn: string, args: Record<string, any>) {
      state.rpcCalls.push({ fn, args: structuredClone(args) });

      if (fn === 'acquire_provisioning_lock') {
        const key = String(args.p_operation_key);
        const existing = getLockRow(key);
        if (existing && existing.status === 'in_progress' && existing.lock_owner_id !== args.p_lock_owner_id) {
          return {
            data: [{
              acquired: false,
              stale_recovery: false,
              previous_status: 'in_progress',
              previous_operation_type: existing.operation_type,
              holder_owner_id: existing.lock_owner_id,
            }],
            error: null,
          };
        }
        if (existing && existing.status === 'uncertain' && args.p_allow_uncertain_recovery !== true) {
          return {
            data: [{
              acquired: false,
              stale_recovery: false,
              previous_status: 'uncertain',
              previous_operation_type: existing.operation_type,
              holder_owner_id: existing.lock_owner_id,
            }],
            error: null,
          };
        }

        const prevStatus = existing?.status || null;
        const prevOp = existing?.operation_type || null;
        if (existing) {
          existing.operation_type = String(args.p_operation_type);
          existing.target_id = String(args.p_target_id);
          existing.client_uuid = args.p_client_uuid || null;
          existing.lock_owner_id = String(args.p_lock_owner_id);
          existing.status = 'in_progress';
          existing.error_message = null;
        } else {
          state.provisioning_operations.push({
            operation_key: key,
            operation_type: String(args.p_operation_type),
            target_id: String(args.p_target_id),
            client_uuid: args.p_client_uuid || null,
            lock_owner_id: String(args.p_lock_owner_id),
            status: 'in_progress',
            error_message: null,
          });
        }
        return {
          data: [{
            acquired: true,
            stale_recovery: prevStatus === 'uncertain',
            previous_status: prevStatus,
            previous_operation_type: prevOp,
            holder_owner_id: args.p_lock_owner_id,
          }],
          error: null,
        };
      }

      if (fn === 'renew_provisioning_lock') {
        const key = String(args.p_operation_key);
        const existing = getLockRow(key);
        const ok = Boolean(existing && existing.status === 'in_progress' && existing.lock_owner_id === args.p_lock_owner_id);
        return { data: ok, error: null };
      }

      if (fn === 'release_provisioning_lock') {
        const key = String(args.p_operation_key);
        const existing = getLockRow(key);
        if (!existing || existing.status !== 'in_progress' || existing.lock_owner_id !== args.p_lock_owner_id) {
          return { data: false, error: null };
        }
        existing.status = args.p_status;
        existing.error_message = args.p_error_message || null;
        return { data: true, error: null };
      }

      if (fn === 'mark_vpn_client_panel_deleted') {
        const normUuid = String(args.p_client_uuid || '').trim().toLowerCase();
        const nowIso = new Date().toISOString();
        let accountsUpdated = 0;
        for (const acc of state.vpn_accounts) {
          if (String(acc.uuid || '').trim().toLowerCase() === normUuid) {
            acc.status = 'deleted';
            acc.enable = false;
            acc.deleted_from_panel_at = nowIso;
            acc.deleted_from_panel_inbound_id = args.p_inbound_id;
            acc.deleted_from_panel_identity = args.p_panel_identity;
            accountsUpdated++;
          }
        }
        let configsUpdated = 0;
        for (const cfg of state.vpn_configs) {
          if (String(cfg.uuid || '').trim().toLowerCase() === normUuid) {
            cfg.status = 'deleted';
            cfg.enabled = false;
            cfg.deleted_from_panel_at = nowIso;
            cfg.deleted_from_panel_inbound_id = args.p_inbound_id;
            cfg.deleted_from_panel_identity = args.p_panel_identity;
            configsUpdated++;
          }
        }
        return {
          data: [{
            applied: accountsUpdated > 0 || configsUpdated > 0,
            already_deleted: false,
            reconciliation_required: false,
            unresolved_grant_count: 0,
            audit_log_inserted: true,
          }],
          error: null,
        };
      }

      return { data: null, error: { message: `Unknown RPC ${fn}` } };
    },
  };

  return dbClient;
}

function makeInbound(id: number, clients: any[], opts?: { enable?: boolean }): XuiInbound {
  return {
    id,
    up: 0,
    down: 0,
    total: 0,
    remark: `Inbound-${id}`,
    enable: opts?.enable ?? true,
    expiryTime: 0,
    clientStats: [],
    port: 443,
    protocol: 'vless',
    settings: JSON.stringify({ clients }),
    streamSettings: '{}',
    tag: `inbound-${id}`,
    sniffing: '{}',
  };
}

function buildListResult(inbounds: XuiInbound[]): UncachedInboundsListReadResult {
  const parsedByInboundId = new Map<number, any>();
  const liveClientByUuid = new Map<string, any>();
  for (const ib of inbounds) {
    const parsed = parseInboundSettingsClientsStrict(ib);
    if (!parsed.ok) continue;
    parsedByInboundId.set(parsed.inboundId, {
      inbound: ib,
      inboundId: parsed.inboundId,
      clients: parsed.clients,
      clientUuidSet: parsed.clientUuidSet,
    });
    for (const c of parsed.clients) {
      const u = String(c.id || '').trim().toLowerCase();
      if (u) liveClientByUuid.set(u, { inbound: ib, client: c, stat: null });
    }
  }
  return {
    ok: true,
    inbounds,
    parsedByInboundId,
    unparsedInboundIds: [],
    allInboundsCleanlyParsed: true,
    liveClientByUuid,
  };
}

const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// ---------------------------------------------------------------------------
// 1. Feature disabled (default unset & explicit false):
//    Zero deletion verification calls, zero deletion lock acquisitions,
//    confirmed deleted VPNs remain hidden, disabled & expired remain visible.
// ---------------------------------------------------------------------------
test('R1. Feature disabled (unset or false): zero deletion calls, zero lock acquisitions, deleted hidden, disabled/expired visible', async () => {
  for (const envVal of [undefined, 'false', 'FALSE', '0']) {
    await withEnv({ PANEL_DELETION_SYNC_ENABLED: envVal }, async () => {
      assert.equal(isPanelDeletionSyncFlagEnabled(), false);

      let panelReadCalls = 0;
      const db = createLockAwareMockDb({
        vpn_accounts: [
          { id: 'a-del', user_id: 'u-1', email: 'c@example.com', uuid: 'uuid-already-deleted', order_id: 'o-del', vless_url: 'vless://uuid-already-deleted@sg.example.com:443#Del', status: 'deleted', enable: false, deleted_from_panel_at: PAST_CREATED_AT, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT },
          { id: 'a-dis', user_id: 'u-1', email: 'c@example.com', uuid: 'uuid-disabled', order_id: 'o-dis', vless_url: 'vless://uuid-disabled@sg.example.com:443#Dis', status: 'disabled', enable: false, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT },
          { id: 'a-exp', user_id: 'u-1', email: 'c@example.com', uuid: 'uuid-expired', order_id: 'o-exp', vless_url: 'vless://uuid-expired@sg.example.com:443#Exp', status: 'expired', enable: true, expiry_date: new Date(EXPIRED_EXPIRY_MS).toISOString(), panel_identity: PANEL_ID, created_at: PAST_CREATED_AT },
          { id: 'a-miss', user_id: 'u-1', email: 'c@example.com', uuid: 'uuid-missing-live', order_id: 'o-miss', vless_url: 'vless://uuid-missing-live@sg.example.com:443#Miss', status: 'active', enable: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT },
        ],
        vpn_configs: [
          { id: 'c-del', customer_uid: 'u-1', uuid: 'uuid-already-deleted', order_id: 'o-del', inbound_id: 2, status: 'deleted', enabled: false, deleted_from_panel_at: PAST_CREATED_AT, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT },
          { id: 'c-dis', customer_uid: 'u-1', uuid: 'uuid-disabled', order_id: 'o-dis', inbound_id: 2, status: 'disabled', enabled: false, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT },
          { id: 'c-exp', customer_uid: 'u-1', uuid: 'uuid-expired', order_id: 'o-exp', inbound_id: 2, status: 'expired', enabled: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT },
          { id: 'c-miss', customer_uid: 'u-1', uuid: 'uuid-missing-live', order_id: 'o-miss', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT },
        ],
        orders: [
          { id: 'o-del', order_id: 'ORD-DEL', customer_id: 'u-1', email: 'c@example.com', status: 'completed', payment_status: 'Paid', client_uuid: 'uuid-already-deleted', vless_url: 'vless://uuid-already-deleted@sg.example.com:443#Del' },
          { id: 'o-dis', order_id: 'ORD-DIS', customer_id: 'u-1', email: 'c@example.com', status: 'completed', payment_status: 'Paid', client_uuid: 'uuid-disabled', vless_url: 'vless://uuid-disabled@sg.example.com:443#Dis' },
          { id: 'o-exp', order_id: 'ORD-EXP', customer_id: 'u-1', email: 'c@example.com', status: 'completed', payment_status: 'Paid', client_uuid: 'uuid-expired', vless_url: 'vless://uuid-expired@sg.example.com:443#Exp' },
          { id: 'o-miss', order_id: 'ORD-MISS', customer_id: 'u-1', email: 'c@example.com', status: 'completed', payment_status: 'Paid', client_uuid: 'uuid-missing-live', vless_url: 'vless://uuid-missing-live@sg.example.com:443#Miss' },
        ],
      });

      // Scheduled background sync
      const syncRes = await syncDeleted3XUiClients({
        dbClient: db,
        currentPanelIdentity: PANEL_ID,
        fetchUncachedInboundsList: async () => {
          panelReadCalls++;
          return buildListResult([makeInbound(2, [])]);
        },
        fetchUncachedInbound: async () => {
          panelReadCalls++;
          return { status: 'found', inbound: makeInbound(2, []), clients: [], clientUuidSet: new Set() };
        },
      });
      assert.equal(syncRes.synced, false);
      assert.equal(syncRes.skippedDisabled, true);
      assert.equal(syncRes.deletedCount, 0);
      assert.equal(panelReadCalls, 0);
      assert.equal(db.state.rpcCalls.length, 0);
      assert.equal(db.state.provisioning_operations.length, 0);

      // Direct verification entry point
      const directRes = await verifyAndMarkClientDeletedIfConfirmed({
        clientUuid: 'uuid-missing-live',
        inboundId: 2,
        userId: 'u-1',
        recordPanelIdentity: PANEL_ID,
        createdAt: PAST_CREATED_AT,
        dbClient: db,
        currentPanelIdentity: PANEL_ID,
        fetchUncachedInbound: async () => {
          panelReadCalls++;
          return { status: 'found', inbound: makeInbound(2, []), clients: [], clientUuidSet: new Set() };
        },
      });
      assert.equal(directRes.confirmedDeleted, false);
      assert.equal(directRes.reason, 'panel_deletion_sync_disabled');
      assert.equal(panelReadCalls, 0);
      assert.equal(db.state.rpcCalls.length, 0);

      // Customer-triggered getMyConfigs path
      let verifySpyCalls = 0;
      const liveIb = makeInbound(2, [
        { id: 'uuid-disabled', email: 'dis', enable: false, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
        { id: 'uuid-expired', email: 'exp', enable: true, expiryTime: EXPIRED_EXPIRY_MS, totalGB: 0 },
      ]);
      const customerRes = await getMyConfigs('u-1', 'c@example.com', undefined, {
        dbClient: db,
        adminDbClient: db,
        currentPanelIdentity: PANEL_ID,
        getCachedInboundsFn: async () => [liveIb],
        getLiveInboundFn: async (id) => (id === 2 ? liveIb : null),
        getInboundsFn: async () => [liveIb],
        verifyDeletedFn: async () => {
          verifySpyCalls++;
          return { confirmedDeleted: true, dbWrites: 1, reason: 'should_never_run' };
        },
      });
      const customerConfigs = customerRes.configs;

      assert.equal(verifySpyCalls, 0, 'Customer read must NOT trigger deletion verification when flag is disabled');
      assert.equal(db.state.rpcCalls.length, 0, 'Zero lock acquisitions allowed when flag is disabled');

      // Confirmed deleted VPN remains hidden
      assert.equal(customerConfigs.some((c: any) => c.uuid === 'uuid-already-deleted'), false);
      // Disabled and expired VPNs remain visible with proper statuses
      const disCfg = customerConfigs.find((c: any) => c.uuid === 'uuid-disabled');
      const expCfg = customerConfigs.find((c: any) => c.uuid === 'uuid-expired');
      assert.ok(disCfg, 'Disabled VPN must remain visible');
      assert.equal(disCfg.status, 'Disabled');
      assert.ok(expCfg, 'Expired VPN must remain visible');
      assert.equal(expCfg.status, 'Expired');
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Panel read timeout (Read 1 AND Read 2 inside locks): NO stranded or uncertain locks
// ---------------------------------------------------------------------------
test('R2. Panel read timeout (Read 1 and bounded Read 2): zero stranded or uncertain locks', async () => {
  await withEnv({ PANEL_DELETION_SYNC_ENABLED: 'true' }, async () => {
    const db = createLockAwareMockDb({
      vpn_accounts: [{ id: 'a-1', user_id: 'u-1', uuid: 'uuid-timeout', status: 'active', enable: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT }],
      vpn_configs: [{ id: 'c-1', customer_uid: 'u-1', uuid: 'uuid-timeout', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT }],
    });

    // 2a. Read 1 timeout (outside locks) -> ZERO lock RPC calls at all!
    const res1 = await verifyAndMarkClientDeletedIfConfirmed({
      clientUuid: 'uuid-timeout',
      inboundId: 2,
      userId: 'u-1',
      recordPanelIdentity: PANEL_ID,
      createdAt: PAST_CREATED_AT,
      dbClient: db,
      currentPanelIdentity: PANEL_ID,
      reReadDelayMs: 0,
      fetchUncachedInbound: async () => ({ status: 'error', reason: 'timeout of 10000ms exceeded' }),
    });
    assert.equal(res1.confirmedDeleted, false);
    assert.match(res1.reason, /^read1_error:/);
    assert.equal(db.state.rpcCalls.length, 0, 'Read 1 timeout must not touch any lock RPCs');
    assert.equal(db.state.provisioning_operations.length, 0);

    // 2b. Read 1 absent, Read 2 hangs past lockedReadTimeoutMs -> bounded timeout aborts Read 2 BEFORE RPC;
    // BOTH locks finalize cleanly as 'failed' (NOT 'in_progress' and NOT 'uncertain')!
    let readAttempt = 0;
    const emptyIb = makeInbound(2, []);
    const res2 = await verifyAndMarkClientDeletedIfConfirmed({
      clientUuid: 'uuid-timeout',
      inboundId: 2,
      userId: 'u-1',
      recordPanelIdentity: PANEL_ID,
      createdAt: PAST_CREATED_AT,
      dbClient: db,
      currentPanelIdentity: PANEL_ID,
      reReadDelayMs: 0,
      lockedReadTimeoutMs: 40,
      releaseRetryBaseDelayMs: 1,
      fetchUncachedInbound: async (): Promise<UncachedInboundReadResult> => {
        readAttempt++;
        if (readAttempt === 1) {
          return { status: 'found', inbound: emptyIb, clients: [], clientUuidSet: new Set() };
        }
        // Hang longer than lockedReadTimeoutMs
        await new Promise((r) => setTimeout(r, 200));
        return { status: 'found', inbound: emptyIb, clients: [], clientUuidSet: new Set() };
      },
    });

    assert.equal(res2.confirmedDeleted, false);
    assert.equal(res2.mutationUncertain, undefined);
    assert.match(res2.reason, /read2_error:.*timed out/);
    assert.equal(db.getLockRow('inbound:2')?.status, 'failed');
    assert.equal(db.getLockRow('client:uuid-timeout')?.status, 'failed');
    assert.equal(db.state.rpcCalls.some((c: any) => c.fn === 'mark_vpn_client_panel_deleted'), false);
    assert.equal(db.state.vpn_accounts[0].status, 'active');
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. Missing inbound & Inbound mismatch: NO stranded or uncertain locks
// ---------------------------------------------------------------------------
test('R3 & R4. Missing inbound and inbound_id_mismatch leave zero stranded or uncertain locks', async () => {
  await withEnv({ PANEL_DELETION_SYNC_ENABLED: 'true' }, async () => {
    const db = createLockAwareMockDb({
      vpn_accounts: [{ id: 'a-m', user_id: 'u-1', uuid: 'uuid-miss-ib', status: 'active', enable: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT }],
      vpn_configs: [{ id: 'c-m', customer_uid: 'u-1', uuid: 'uuid-miss-ib', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT }],
    });

    // Missing inbound on Read 1 with empty list -> exits before lock acquisition
    const resMiss1 = await verifyAndMarkClientDeletedIfConfirmed({
      clientUuid: 'uuid-miss-ib',
      inboundId: 2,
      userId: 'u-1',
      recordPanelIdentity: PANEL_ID,
      createdAt: PAST_CREATED_AT,
      dbClient: db,
      currentPanelIdentity: PANEL_ID,
      reReadDelayMs: 0,
      fetchUncachedInbound: async () => ({ status: 'not_found' }),
      fetchUncachedInboundsList: async () => buildListResult([]),
    });
    assert.equal(resMiss1.confirmedDeleted, false);
    assert.equal(db.state.rpcCalls.length, 0);

    // Missing inbound on Read 2 with incomplete list -> exits cleanly, both locks completed (not uncertain/in_progress)
    let callIdx = 0;
    const emptyIb = makeInbound(2, []);
    const resMiss2 = await verifyAndMarkClientDeletedIfConfirmed({
      clientUuid: 'uuid-miss-ib',
      inboundId: 2,
      userId: 'u-1',
      recordPanelIdentity: PANEL_ID,
      createdAt: PAST_CREATED_AT,
      dbClient: db,
      currentPanelIdentity: PANEL_ID,
      reReadDelayMs: 0,
      fetchUncachedInbound: async () => {
        callIdx++;
        return callIdx === 1
          ? { status: 'found', inbound: emptyIb, clients: [], clientUuidSet: new Set() }
          : { status: 'not_found' };
      },
      fetchUncachedInboundsList: async () => ({
        ok: false,
        reason: 'network_error',
        inbounds: [],
        parsedByInboundId: new Map(),
        unparsedInboundIds: [],
        allInboundsCleanlyParsed: false,
        liveClientByUuid: new Map(),
      }),
    });
    assert.equal(resMiss2.confirmedDeleted, false);
    assert.equal(db.getLockRow('inbound:2')?.status, 'completed');
    assert.equal(db.getLockRow('client:uuid-miss-ib')?.status, 'completed');

    // Inbound mismatch on Read 2 -> clean completion with zero writes and zero stranded/uncertain locks
    let mismatchIdx = 0;
    const resMismatch = await verifyAndMarkClientDeletedIfConfirmed({
      clientUuid: 'uuid-miss-ib',
      inboundId: 2,
      userId: 'u-1',
      recordPanelIdentity: PANEL_ID,
      createdAt: PAST_CREATED_AT,
      dbClient: db,
      currentPanelIdentity: PANEL_ID,
      reReadDelayMs: 0,
      fetchUncachedInbound: async () => {
        mismatchIdx++;
        return mismatchIdx === 1
          ? { status: 'found', inbound: emptyIb, clients: [], clientUuidSet: new Set() }
          : { status: 'error', reason: 'inbound_id_mismatch' };
      },
    });
    assert.equal(resMismatch.confirmedDeleted, false);
    assert.equal(resMismatch.reason, 'read2_error:inbound_id_mismatch');
    assert.equal(db.getLockRow('inbound:2')?.status, 'completed');
    assert.equal(db.getLockRow('client:uuid-miss-ib')?.status, 'completed');
  });
});

// ---------------------------------------------------------------------------
// 5. RPC definitive rejection: safe lock finalization (NEVER uncertain)
// ---------------------------------------------------------------------------
test('R5. RPC definitive skip_reason and definitive pre-commit DB error finalize locks safely without uncertain state', async () => {
  await withEnv({ PANEL_DELETION_SYNC_ENABLED: 'true' }, async () => {
    const emptyIb = makeInbound(2, []);

    // 5a. Definitive skip_reason ('ownership_mismatch') -> completed cleanly
    const dbSkip = createLockAwareMockDb({
      vpn_accounts: [{ id: 'a-s', user_id: 'u-1', uuid: 'uuid-def-skip', status: 'active', enable: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT }],
      vpn_configs: [{ id: 'c-s', customer_uid: 'u-1', uuid: 'uuid-def-skip', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT }],
    });
    const origSkipRpc = dbSkip.rpc.bind(dbSkip);
    dbSkip.rpc = async (fn: string, args: Record<string, any>) => {
      if (fn === 'mark_vpn_client_panel_deleted') {
        return { data: [{ applied: false, already_deleted: false, skip_reason: 'ownership_mismatch' }], error: null };
      }
      return origSkipRpc(fn, args);
    };

    const resSkip = await verifyAndMarkClientDeletedIfConfirmed({
      clientUuid: 'uuid-def-skip',
      inboundId: 2,
      userId: 'u-1',
      recordPanelIdentity: PANEL_ID,
      createdAt: PAST_CREATED_AT,
      dbClient: dbSkip,
      currentPanelIdentity: PANEL_ID,
      reReadDelayMs: 0,
      fetchUncachedInbound: async () => ({ status: 'found', inbound: emptyIb, clients: [], clientUuidSet: new Set() }),
    });
    assert.equal(resSkip.confirmedDeleted, false);
    assert.equal(resSkip.reason, 'rpc_skipped:ownership_mismatch');
    assert.equal(dbSkip.getLockRow('inbound:2')?.status, 'completed');
    assert.equal(dbSkip.getLockRow('client:uuid-def-skip')?.status, 'completed');

    // 5b. Definitive pre-commit DB error (42501 insufficient_privilege) -> finalized as 'failed' (NEVER 'uncertain')
    const dbPerm = createLockAwareMockDb({
      vpn_accounts: [{ id: 'a-p', user_id: 'u-1', uuid: 'uuid-def-err', status: 'active', enable: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT }],
      vpn_configs: [{ id: 'c-p', customer_uid: 'u-1', uuid: 'uuid-def-err', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT }],
    });
    const origPermRpc = dbPerm.rpc.bind(dbPerm);
    dbPerm.rpc = async (fn: string, args: Record<string, any>) => {
      if (fn === 'mark_vpn_client_panel_deleted') {
        return { data: null, error: { code: '42501', message: 'permission denied for function mark_vpn_client_panel_deleted' } };
      }
      return origPermRpc(fn, args);
    };

    const resPerm = await verifyAndMarkClientDeletedIfConfirmed({
      clientUuid: 'uuid-def-err',
      inboundId: 2,
      userId: 'u-1',
      recordPanelIdentity: PANEL_ID,
      createdAt: PAST_CREATED_AT,
      dbClient: dbPerm,
      currentPanelIdentity: PANEL_ID,
      reReadDelayMs: 0,
      fetchUncachedInbound: async () => ({ status: 'found', inbound: emptyIb, clients: [], clientUuidSet: new Set() }),
    });
    assert.equal(resPerm.confirmedDeleted, false);
    assert.equal(resPerm.mutationUncertain, undefined);
    assert.match(resPerm.reason, /^rpc_error:/);
    assert.equal(dbPerm.getLockRow('inbound:2')?.status, 'failed');
    assert.equal(dbPerm.getLockRow('client:uuid-def-err')?.status, 'failed');
  });
});

// ---------------------------------------------------------------------------
// 6. RPC timeout after possible commit: authoritative reconciliation
//    - Subcase A: committed in DB -> reconciles as confirmedDeleted & releases cleanly
//    - Subcase B: NOT confirmed in DB -> keeps client lock 'uncertain' & inbound 'failed'
// ---------------------------------------------------------------------------
test('R6. RPC timeout after possible commit reconciles authoritatively (confirmed commit vs uncertain preservation)', async () => {
  await withEnv({ PANEL_DELETION_SYNC_ENABLED: 'true' }, async () => {
    const emptyIb = makeInbound(2, []);

    // 6a. Timeout AFTER commit succeeded in PostgreSQL -> read-back confirms deleted -> locks finalize as 'completed'
    const dbCommitted = createLockAwareMockDb({
      vpn_accounts: [{ id: 'a-c', user_id: 'u-1', uuid: 'uuid-rpc-commit', status: 'active', enable: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT }],
      vpn_configs: [{ id: 'c-c', customer_uid: 'u-1', uuid: 'uuid-rpc-commit', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT }],
    });
    const origCommittedRpc = dbCommitted.rpc.bind(dbCommitted);
    dbCommitted.rpc = async (fn: string, args: Record<string, any>) => {
      if (fn === 'mark_vpn_client_panel_deleted') {
        // Commit succeeds in DB, then client experiences network timeout receiving response
        await origCommittedRpc(fn, args);
        return { data: null, error: { name: 'AbortError', message: 'The operation was aborted due to timeout' } };
      }
      return origCommittedRpc(fn, args);
    };

    const resCommitted = await verifyAndMarkClientDeletedIfConfirmed({
      clientUuid: 'uuid-rpc-commit',
      inboundId: 2,
      userId: 'u-1',
      recordPanelIdentity: PANEL_ID,
      createdAt: PAST_CREATED_AT,
      dbClient: dbCommitted,
      currentPanelIdentity: PANEL_ID,
      reReadDelayMs: 0,
      fetchUncachedInbound: async () => ({ status: 'found', inbound: emptyIb, clients: [], clientUuidSet: new Set() }),
    });
    assert.equal(resCommitted.confirmedDeleted, true);
    assert.equal(resCommitted.reconciledAfterAmbiguousRpc, true);
    assert.equal(dbCommitted.getLockRow('inbound:2')?.status, 'completed');
    assert.equal(dbCommitted.getLockRow('client:uuid-rpc-commit')?.status, 'completed');

    // 6b. Timeout where DB is NOT confirmed committed (still active / possible in-flight commit) ->
    // inbound:2 finalizes as 'failed' (no 3X-UI inbound write), client:<uuid> preserved as 'uncertain'!
    const dbUnconfirmed = createLockAwareMockDb({
      vpn_accounts: [{ id: 'a-u', user_id: 'u-1', uuid: 'uuid-rpc-unc', status: 'active', enable: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT }],
      vpn_configs: [{ id: 'c-u', customer_uid: 'u-1', uuid: 'uuid-rpc-unc', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT }],
    });
    const origUnconfirmedRpc = dbUnconfirmed.rpc.bind(dbUnconfirmed);
    dbUnconfirmed.rpc = async (fn: string, args: Record<string, any>) => {
      if (fn === 'mark_vpn_client_panel_deleted') {
        return { data: null, error: { name: 'TimeoutError', message: '504 Gateway Timeout' } };
      }
      return origUnconfirmedRpc(fn, args);
    };

    const resUnconfirmed = await verifyAndMarkClientDeletedIfConfirmed({
      clientUuid: 'uuid-rpc-unc',
      inboundId: 2,
      userId: 'u-1',
      recordPanelIdentity: PANEL_ID,
      createdAt: PAST_CREATED_AT,
      dbClient: dbUnconfirmed,
      currentPanelIdentity: PANEL_ID,
      reReadDelayMs: 0,
      fetchUncachedInbound: async () => ({ status: 'found', inbound: emptyIb, clients: [], clientUuidSet: new Set() }),
    });
    assert.equal(resUnconfirmed.confirmedDeleted, false);
    assert.equal(resUnconfirmed.mutationUncertain, true);
    assert.match(resUnconfirmed.reason, /^rpc_outcome_uncertain:/);
    assert.equal(dbUnconfirmed.getLockRow('inbound:2')?.status, 'failed');
    assert.equal(dbUnconfirmed.getLockRow('client:uuid-rpc-unc')?.status, 'uncertain');
  });
});

// ---------------------------------------------------------------------------
// 7 & 8. Transient lock release failure & Lock ownership change during retries
// ---------------------------------------------------------------------------
test('R7 & R8. Transient lock release retries retain original owner and never release another worker lock', async () => {
  // 7. Transient failure on attempts 1 & 2, succeeds on attempt 3 with original lockOwnerId
  const dbRetry = createLockAwareMockDb({
    provisioning_operations: [
      { operation_key: 'client:uuid-rel', operation_type: 'client_lock', target_id: 't1', client_uuid: 'uuid-rel', lock_owner_id: 'worker-A', status: 'in_progress' },
    ],
  });
  const origRetryRpc = dbRetry.rpc.bind(dbRetry);
  let releaseAttempts = 0;
  const seenOwners: string[] = [];
  dbRetry.rpc = async (fn: string, args: Record<string, any>) => {
    if (fn === 'release_provisioning_lock') {
      releaseAttempts++;
      seenOwners.push(String(args.p_lock_owner_id));
      if (releaseAttempts < 3) {
        return { data: null, error: { status: 503, message: '503 Service Unavailable' } };
      }
    }
    return origRetryRpc(fn, args);
  };

  const relRes = await finalizeDurableProvisioningOperationLock({
    dbClient: dbRetry,
    operationKey: 'client:uuid-rel',
    lockOwnerId: 'worker-A',
    status: 'completed',
    clientUuid: 'uuid-rel',
    maxRetries: 2,
    retryBaseDelayMs: 1,
  });
  assert.equal(relRes.released, true);
  assert.equal(relRes.attempts, 3);
  assert.equal(relRes.reason, 'released');
  assert.deepEqual(seenOwners, ['worker-A', 'worker-A', 'worker-A']);
  assert.equal(dbRetry.getLockRow('client:uuid-rel')?.status, 'completed');

  // 8. Lock ownership changes to worker-B between attempt 1 (transient failure) and attempt 2:
  // Attempt 2 sends original 'worker-A', receives FALSE, stops immediately, NEVER touches worker-B's lock!
  const dbOwnerChanged = createLockAwareMockDb({
    provisioning_operations: [
      { operation_key: 'client:uuid-stolen', operation_type: 'client_lock', target_id: 't1', client_uuid: 'uuid-stolen', lock_owner_id: 'worker-A', status: 'in_progress' },
    ],
  });
  const origOwnerRpc = dbOwnerChanged.rpc.bind(dbOwnerChanged);
  let ownerAttempts = 0;
  const retryOwners: string[] = [];
  dbOwnerChanged.rpc = async (fn: string, args: Record<string, any>) => {
    if (fn === 'release_provisioning_lock') {
      ownerAttempts++;
      retryOwners.push(String(args.p_lock_owner_id));
      if (ownerAttempts === 1) {
        // Simulate worker-B lawfully acquiring the lock after worker-A's lease expired
        const row = dbOwnerChanged.getLockRow('client:uuid-stolen')!;
        row.lock_owner_id = 'worker-B';
        row.status = 'in_progress';
        throw new Error('fetch failed: ECONNRESET');
      }
    }
    return origOwnerRpc(fn, args);
  };

  const ownerRes = await finalizeDurableProvisioningOperationLock({
    dbClient: dbOwnerChanged,
    operationKey: 'client:uuid-stolen',
    lockOwnerId: 'worker-A',
    status: 'failed',
    clientUuid: 'uuid-stolen',
    maxRetries: 3,
    retryBaseDelayMs: 1,
  });
  assert.equal(ownerRes.released, false);
  assert.equal(ownerRes.attempts, 2, 'Must stop immediately when RPC returns FALSE (ownership changed)');
  assert.equal(ownerRes.reason, 'ownership_lost_or_expired');
  assert.deepEqual(retryOwners, ['worker-A', 'worker-A']);
  assert.equal(dbOwnerChanged.getLockRow('client:uuid-stolen')?.lock_owner_id, 'worker-B');
  assert.equal(dbOwnerChanged.getLockRow('client:uuid-stolen')?.status, 'in_progress');
});

// ---------------------------------------------------------------------------
// 9. Lease expiration during verification: aborts BEFORE RPC with zero DB mutations
// ---------------------------------------------------------------------------
test('R9. Lease expiration during verification aborts before deletion RPC with zero DB writes', async () => {
  await withEnv({ PANEL_DELETION_SYNC_ENABLED: 'true' }, async () => {
    const emptyIb = makeInbound(2, []);
    const db = createLockAwareMockDb({
      vpn_accounts: [{ id: 'a-exp-lease', user_id: 'u-1', uuid: 'uuid-lease-exp', status: 'active', enable: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT }],
      vpn_configs: [{ id: 'c-exp-lease', customer_uid: 'u-1', uuid: 'uuid-lease-exp', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT }],
    });

    const origRpc = db.rpc.bind(db);
    let renewCount = 0;
    db.rpc = async (fn: string, args: Record<string, any>) => {
      if (fn === 'renew_provisioning_lock') {
        renewCount++;
        // First 2 renew calls succeed (entry fence for client + inbound);
        // 3rd renew call (pre-RPC fence!) fails because lease expired during Read 2.
        if (renewCount >= 3) {
          return { data: false, error: null };
        }
      }
      return origRpc(fn, args);
    };

    const res = await verifyAndMarkClientDeletedIfConfirmed({
      clientUuid: 'uuid-lease-exp',
      inboundId: 2,
      userId: 'u-1',
      recordPanelIdentity: PANEL_ID,
      createdAt: PAST_CREATED_AT,
      dbClient: db,
      currentPanelIdentity: PANEL_ID,
      reReadDelayMs: 0,
      releaseRetryBaseDelayMs: 1,
      fetchUncachedInbound: async () => ({ status: 'found', inbound: emptyIb, clients: [], clientUuidSet: new Set() }),
    });

    assert.equal(res.confirmedDeleted, false);
    assert.equal(res.dbWrites, 0);
    assert.equal(db.state.rpcCalls.some((c: any) => c.fn === 'mark_vpn_client_panel_deleted'), false, 'RPC MUST NOT execute after lease expires');
    assert.equal(db.state.vpn_accounts[0].status, 'active');
    assert.equal(db.state.vpn_configs[0].status, 'active');
  });
});

// ---------------------------------------------------------------------------
// 10. Concurrent purchases and renewals:
//     - Read-only pre-check skips active/uncertain locks with ZERO acquire_provisioning_lock calls
//     - Real write locks (purchases, renewals, approvals, rejections) STILL keep full uncertainty protection
// ---------------------------------------------------------------------------
test('R10. Concurrent purchase/renewal locks are respected by read-only pre-check and write-lock uncertainty protection remains intact', async () => {
  await withEnv({ PANEL_DELETION_SYNC_ENABLED: 'true' }, async () => {
    const emptyIb = makeInbound(2, []);
    const db = createLockAwareMockDb({
      vpn_accounts: [{ id: 'a-c', user_id: 'u-1', uuid: 'uuid-concurrent', status: 'active', enable: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT }],
      vpn_configs: [{ id: 'c-c', customer_uid: 'u-1', uuid: 'uuid-concurrent', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_ID, created_at: PAST_CREATED_AT }],
      provisioning_operations: [
        { operation_key: 'inbound:2', operation_type: 'inbound_write', target_id: 'order-999', client_uuid: 'uuid-other', lock_owner_id: 'purchase-worker-1', status: 'in_progress' },
      ],
    });

    // Deletion sync sees active purchase lock in pre-check -> skips with ZERO acquire_provisioning_lock calls!
    const skipActive = await verifyAndMarkClientDeletedIfConfirmed({
      clientUuid: 'uuid-concurrent',
      inboundId: 2,
      userId: 'u-1',
      recordPanelIdentity: PANEL_ID,
      createdAt: PAST_CREATED_AT,
      dbClient: db,
      currentPanelIdentity: PANEL_ID,
      reReadDelayMs: 0,
      fetchUncachedInbound: async () => ({ status: 'found', inbound: emptyIb, clients: [], clientUuidSet: new Set() }),
    });
    assert.equal(skipActive.confirmedDeleted, false);
    assert.equal(skipActive.reason, 'lock_precheck_in_progress:inbound:2');
    assert.equal(db.state.rpcCalls.filter((c: any) => c.fn === 'acquire_provisioning_lock').length, 0);
    assert.equal(db.getLockRow('inbound:2')?.lock_owner_id, 'purchase-worker-1');

    // Uncertain client lock also skipped at pre-check with ZERO acquire_provisioning_lock calls
    db.state.provisioning_operations = [
      { operation_key: 'client:uuid-concurrent', operation_type: 'client_lock', target_id: 'renew-777', client_uuid: 'uuid-concurrent', lock_owner_id: 'renew-worker-1', status: 'uncertain' },
    ];
    const skipUnc = await verifyAndMarkClientDeletedIfConfirmed({
      clientUuid: 'uuid-concurrent',
      inboundId: 2,
      userId: 'u-1',
      recordPanelIdentity: PANEL_ID,
      createdAt: PAST_CREATED_AT,
      dbClient: db,
      currentPanelIdentity: PANEL_ID,
      reReadDelayMs: 0,
      fetchUncachedInbound: async () => ({ status: 'found', inbound: emptyIb, clients: [], clientUuidSet: new Set() }),
    });
    assert.equal(skipUnc.confirmedDeleted, false);
    assert.equal(skipUnc.reason, 'lock_precheck_uncertain:client:uuid-concurrent');
    assert.equal(db.state.rpcCalls.filter((c: any) => c.fn === 'acquire_provisioning_lock').length, 0);
    assert.equal(db.getLockRow('client:uuid-concurrent')?.status, 'uncertain');

    // Verify REAL inbound write lock (default noExternalXuiWrite=false) STILL transitions to 'uncertain' on transport timeout!
    const dbReal = createLockAwareMockDb();
    await assert.rejects(
      () =>
        withInboundWriteLock(
          { dbClient: dbReal, inboundId: 2, targetId: 'real-purchase-order', requireDurableLock: true, releaseRetryBaseDelayMs: 1 },
          async () => {
            throw new Error('ECONNRESET socket hang up during 3X-UI addClient');
          }
        ),
      /ECONNRESET/
    );
    assert.equal(dbReal.getLockRow('inbound:2')?.status, 'uncertain', 'Real inbound write transport error MUST remain uncertain');

    // Verify REAL client mutation lock STILL transitions to 'uncertain' on xuiUncertain=true!
    await assert.rejects(
      () =>
        withClientMutationLock(
          { dbClient: dbReal, clientUuid: 'uuid-real-renew', targetId: 'real-renew-1', requireDurableLock: true, releaseRetryBaseDelayMs: 1 },
          async () => {
            const err: any = new Error('3X-UI updateClient timeout');
            err.xuiUncertain = true;
            throw err;
          }
        ),
      /timeout/
    );
    assert.equal(dbReal.getLockRow('client:uuid-real-renew')?.status, 'uncertain', 'Real client mutation xuiUncertain MUST remain uncertain');
  });
});

// ---------------------------------------------------------------------------
// 11 & 12. Existing automatic purchases, manual approvals, and manual rejections
//          continue working identically with PANEL_DELETION_SYNC_ENABLED=false
// ---------------------------------------------------------------------------
test('R11 & R12. Existing automatic purchase, order revocation, renewal approval, and renewal rejection work cleanly with deletion sync disabled', async () => {
  await withEnv({ PANEL_DELETION_SYNC_ENABLED: 'false', AUTO_ACTIVATE_NEW_ORDERS_ENABLED: 'true', AUTO_ACTIVATE_RENEWALS_ENABLED: 'true' }, async () => {
    assert.equal(isPanelDeletionSyncFlagEnabled(), false);

    // 12. Automatic provisional purchase (provisionOrderClient) + rejection (revokeProvisionalOrderClient)
    const orderId = '11111111-1111-4111-8111-111111111111';
    const customerId = '22222222-2222-4222-8222-222222222222';
    const liveClients: any[] = [];
    const buildLiveInbound = () => makeInbound(2, liveClients);

    const dbOrder = createLockAwareMockDb({
      orders: [
        {
          id: orderId,
          order_id: 'ORD-AUTO-1',
          customer_id: customerId,
          email: 'buyer@example.com',
          package_name: '1 Month 100GB',
          amount: 1000,
          payment_status: 'Pending Verification',
          status: 'pending',
          provisioning_status: 'pending',
          created_at: PAST_CREATED_AT,
        },
      ],
      profiles: [{ id: customerId, email: 'buyer@example.com', full_name: 'Buyer One' }],
      xui_servers: [{ id: 'srv-1', panel_url: PANEL_URL, is_active: true }],
    });

    const provRes = await provisionOrderClient(orderId, undefined, {
      provisional: true,
      dbClient: dbOrder,
      skipSideEffects: true,
      getInboundsFn: async () => [buildLiveInbound()],
      getClientByEmailFn: async () => null,
      findProvisioningTemplateFn: async () => ({
        inboundId: 2,
        address: 'vpn.firevpns.test',
        sni: 'vpn.firevpns.test',
        remarkTemplate: 'FIRE-{email}',
        trafficLimitGB: 100,
        durationDays: 30,
      }),
      requestApiFn: async <T>(endpoint: string, method?: 'GET' | 'POST', data?: any): Promise<T> => {
        if (endpoint === '/panel/api/inbounds/addClient' && method === 'POST') {
          const parsed = JSON.parse(data.settings);
          liveClients.push(...parsed.clients);
          return {} as T;
        }
        if (endpoint === '/panel/api/inbounds/update/2' && method === 'POST') {
          const parsed = JSON.parse(data.settings);
          liveClients.splice(0, liveClients.length, ...(parsed.clients || []));
          return {} as T;
        }
        if (endpoint === '/panel/api/inbounds/get/2' && method === 'GET') {
          return buildLiveInbound() as unknown as T;
        }
        return {} as T;
      },
    });

    assert.equal(provRes.success, true);
    assert.ok(provRes.uuid);
    assert.equal(liveClients.length, 1);
    assert.equal(dbOrder.getLockRow('inbound:2')?.status, 'completed');

    // Manual rejection of that provisional order revokes & disables the client in 3X-UI
    const revokeOrderRes = await revokeProvisionalOrderClient(orderId, 'Invalid receipt', {
      dbClient: dbOrder,
      getInboundsFn: async () => [buildLiveInbound()],
      requestApiFn: async <T>(endpoint: string, method?: 'GET' | 'POST', data?: any): Promise<T> => {
        if (endpoint.startsWith('/panel/api/inbounds/updateClient/') && method === 'POST') {
          const updated = JSON.parse(data.settings).clients[0];
          const idx = liveClients.findIndex((c) => c.id === updated.id);
          if (idx >= 0) liveClients[idx] = { ...liveClients[idx], ...updated };
          return {} as T;
        }
        if (endpoint === '/panel/api/inbounds/update/2' && method === 'POST') {
          const parsed = JSON.parse(data.settings);
          liveClients.splice(0, liveClients.length, ...(parsed.clients || []));
          return {} as T;
        }
        if (endpoint === '/panel/api/inbounds/get/2' && method === 'GET') {
          return buildLiveInbound() as unknown as T;
        }
        return {} as T;
      },
    });
    assert.equal(revokeOrderRes.revoked, true);
    assert.equal(liveClients[0].enable, false);
    assert.equal(dbOrder.getLockRow('inbound:2')?.status, 'completed');

    // 11. Manual renewal approval (confirmProvisionalRenewal) and rejection (revokeProvisionalRenewal)
    const renewUuid = '33333333-3333-4333-8333-333333333333';
    const renApproveId = '44444444-4444-4444-8444-444444444444';
    const renRejectId = '55555555-5555-4555-8555-555555555555';
    const renewClients: any[] = [
      { id: renewUuid, email: 'renew_user', enable: true, expiryTime: FUTURE_EXPIRY_MS + 30 * 86400000, totalGB: 200 * 1024 ** 3 },
    ];
    const buildRenewInbound = () => makeInbound(2, renewClients);

    const dbApprove = createLockAwareMockDb({
      renew_requests: [{ id: renApproveId, user_id: customerId, user_email: 'buyer@example.com', plan_name: '1 Month 100GB', status: 'pending', provisioning_status: 'provisional' }],
      vpn_entitlement_grants: [{
        id: 'g-app',
        grant_type: 'renewal',
        source_id: renApproveId,
        renew_request_id: renApproveId,
        user_id: customerId,
        client_uuid: renewUuid,
        inbound_id: 2,
        status: 'provisional',
        provisional: true,
        previous_expiry_ms: FUTURE_EXPIRY_MS,
        granted_expiry_ms: FUTURE_EXPIRY_MS + 30 * 86400000,
        added_duration_months: 1,
        package_name: '1 Month 100GB',
      }],
    });

    const approveRes = await confirmProvisionalRenewal(renApproveId, {
      dbClient: dbApprove,
      adminLabel: 'Admin Test',
      getInboundsFn: async () => [buildRenewInbound()],
    });
    assert.equal(approveRes.handledAsProvisional, true);
    assert.equal(approveRes.confirmed, true);
    assert.equal(dbApprove.state.vpn_entitlement_grants[0].status, 'verified');
    assert.equal(dbApprove.getLockRow(`client:${renewUuid}`)?.status, 'completed');

    // Manual renewal rejection restores previous expiry & quota cleanly
    const dbReject = createLockAwareMockDb({
      renew_requests: [{ id: renRejectId, user_id: customerId, user_email: 'buyer@example.com', plan_name: '1 Month 100GB', status: 'pending', provisioning_status: 'provisional' }],
      vpn_accounts: [{ id: 'va-r', user_id: customerId, uuid: renewUuid, status: 'active', enable: true }],
      vpn_configs: [{ id: 'vc-r', customer_uid: customerId, uuid: renewUuid, inbound_id: 2, status: 'active', enabled: true }],
      vpn_entitlement_grants: [{
        id: 'g-rej',
        grant_type: 'renewal',
        source_id: renRejectId,
        renew_request_id: renRejectId,
        user_id: customerId,
        client_uuid: renewUuid,
        inbound_id: 2,
        status: 'provisional',
        provisional: true,
        previous_expiry_ms: FUTURE_EXPIRY_MS,
        previous_total_bytes: 100 * 1024 ** 3,
        previous_was_unlimited: false,
        previous_enable: true,
        previous_status: 'active',
        granted_expiry_ms: FUTURE_EXPIRY_MS + 30 * 86400000,
        granted_total_bytes: 200 * 1024 ** 3,
        added_duration_months: 1,
        package_name: '1 Month 100GB',
        pre_renewal_db_snapshot: {
          vpn_account: { expiry_time: FUTURE_EXPIRY_MS, expiry_date: new Date(FUTURE_EXPIRY_MS).toISOString(), total_bytes: 100 * 1024 ** 3, status: 'active', enable: true },
          vpn_config: { expiry_time: new Date(FUTURE_EXPIRY_MS).toISOString(), expiry_date: new Date(FUTURE_EXPIRY_MS).toISOString(), status: 'active', enabled: true, inbound_id: 2 },
        },
      }],
    });

    const rejectRes = await revokeProvisionalRenewal(renRejectId, 'Rejected payment slip', {
      dbClient: dbReject,
      adminLabel: 'Admin Test',
      getInboundsFn: async () => [buildRenewInbound()],
      requestApiFn: async <T>(endpoint: string, method?: 'GET' | 'POST', data?: any): Promise<T> => {
        if (endpoint.startsWith('/panel/api/inbounds/updateClient/') && method === 'POST') {
          const updated = JSON.parse(data.settings).clients[0];
          const idx = renewClients.findIndex((c) => c.id === updated.id);
          if (idx >= 0) renewClients[idx] = { ...renewClients[idx], ...updated };
          return {} as T;
        }
        if (endpoint === '/panel/api/inbounds/update/2' && method === 'POST') {
          const parsed = JSON.parse(data.settings);
          renewClients.splice(0, renewClients.length, ...(parsed.clients || []));
          return {} as T;
        }
        if (endpoint === '/panel/api/inbounds/get/2' && method === 'GET') {
          return buildRenewInbound() as unknown as T;
        }
        return {} as T;
      },
    });
    assert.equal(rejectRes.handledAsProvisional, true);
    assert.equal(rejectRes.revoked, true);
    assert.equal(renewClients[0].expiryTime, FUTURE_EXPIRY_MS);
    assert.equal(dbReject.state.vpn_entitlement_grants[0].status, 'revoked');
    assert.equal(dbReject.getLockRow(`client:${renewUuid}`)?.status, 'completed');
    assert.equal(dbReject.getLockRow('inbound:2')?.status, 'completed');

    // Quick sanity check that provisionProvisionalRenewal is exported and unaffected
    assert.equal(typeof provisionProvisionalRenewal, 'function');
  });
});
