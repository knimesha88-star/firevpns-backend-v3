import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePanelIdentity,
  parseInboundSettingsClientsStrict,
  verifyRecordPanelIdentity,
  verifyAndMarkClientDeletedIfConfirmed,
  syncDeleted3XUiClients,
  isSafeToRestoreActiveStatus,
  setCachedInbounds,
  resetPanelDeletionSyncSchedulerStateForTests,
  acquireCrossInstanceDeletionSyncLease,
  renewCrossInstanceDeletionSyncLease,
  verifyCrossInstanceDeletionSyncLeaseOwnership,
  releaseCrossInstanceDeletionSyncLease,
  fetchAllTableRowsByPrimaryKeyCursor,
  evaluateSnapshotMassAbsenceCircuitBreaker,
  XuiInbound,
  UncachedInboundReadResult,
  UncachedInboundsListReadResult,
} from '../xuiService.js';
import { getMyConfigs, evaluateVpnClientStatus } from '../vpnService.js';

const PANEL_A_URL = 'https://panel-a.firevpns.internal:2053/panel';
const PANEL_B_URL = 'https://panel-b.firevpns.internal:2053/panel';
const PANEL_A_ID = computePanelIdentity(PANEL_A_URL);
const PANEL_B_ID = computePanelIdentity(PANEL_B_URL);

const PAST_CREATED_AT = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const FUTURE_EXPIRY_MS = Date.now() + 15 * 24 * 60 * 60 * 1000;
const EXPIRED_EXPIRY_MS = Date.now() - 2 * 24 * 60 * 60 * 1000;

let prevDeletionSyncEnv: string | undefined;
test.beforeEach(() => {
  prevDeletionSyncEnv = process.env.PANEL_DELETION_SYNC_ENABLED;
  process.env.PANEL_DELETION_SYNC_ENABLED = 'true';
  resetPanelDeletionSyncSchedulerStateForTests();
});
test.afterEach(() => {
  resetPanelDeletionSyncSchedulerStateForTests();
  if (prevDeletionSyncEnv === undefined) {
    delete process.env.PANEL_DELETION_SYNC_ENABLED;
  } else {
    process.env.PANEL_DELETION_SYNC_ENABLED = prevDeletionSyncEnv;
  }
});

interface MockDbState {
  vpn_accounts: any[];
  vpn_configs: any[];
  orders: any[];
  vpn_entitlement_grants: any[];
  provisioning_operations: any[];
  profiles: any[];
  audit_logs: any[];
  xui_servers: any[];
  settings: any[];
  locks: Map<string, { ownerId: string; status: 'in_progress' | 'completed' | 'failed' | 'uncertain'; operationType: string }>;
  rpcCalls: Array<{ fn: string; args: Record<string, any> }>;
  writeLog: Array<{ table: string; op: 'update' | 'insert'; payload: Record<string, any> }>;
}

function createMockDb(initial?: Partial<MockDbState> & { serverMaxRows?: number; freezeSettingsTriggerTimestamp?: string }) {
  let settingsVersionCounter = 1;
  const serverMaxRows = initial?.serverMaxRows ?? null;
  const freezeTriggerTs = initial?.freezeSettingsTriggerTimestamp ?? null;
  const state: MockDbState = {
    vpn_accounts: initial?.vpn_accounts ? structuredClone(initial.vpn_accounts) : [],
    vpn_configs: initial?.vpn_configs ? structuredClone(initial.vpn_configs) : [],
    orders: initial?.orders ? structuredClone(initial.orders) : [],
    vpn_entitlement_grants: initial?.vpn_entitlement_grants ? structuredClone(initial.vpn_entitlement_grants) : [],
    provisioning_operations: initial?.provisioning_operations ? structuredClone(initial.provisioning_operations) : [],
    profiles: initial?.profiles ? structuredClone(initial.profiles) : [],
    audit_logs: initial?.audit_logs ? structuredClone(initial.audit_logs) : [],
    xui_servers: initial?.xui_servers ? structuredClone(initial.xui_servers) : [],
    settings: initial?.settings ? structuredClone(initial.settings) : [],
    locks: initial?.locks ? new Map(initial.locks) : new Map(),
    rpcCalls: [],
    writeLog: [],
  };

  const getColumnValue = (row: any, col: string): any => {
    if (!row || typeof row !== 'object') return undefined;
    if (col.includes('->>')) {
      const [jsonCol, jsonKey] = col.split('->>').map((s) => s.trim());
      const jsonObj = row?.[jsonCol];
      if (!jsonObj || typeof jsonObj !== 'object') return null;
      const val = jsonObj[jsonKey];
      return val === undefined || val === null ? null : String(val);
    }
    return row?.[col];
  };

  const matchFilters = (row: any, filters: Array<{ op: string; col: string; val: any }>) => {
    for (const f of filters) {
      const rv = getColumnValue(row, f.col);
      if (f.op === 'eq' && rv !== f.val) return false;
      if (f.op === 'is' && (f.val === null ? rv !== null && rv !== undefined : rv !== f.val)) return false;
      if (f.op === 'ilike' && String(rv || '').toLowerCase() !== String(f.val || '').toLowerCase()) return false;
      if (f.op === 'in' && !(Array.isArray(f.val) && f.val.includes(rv))) return false;
      if (f.op === 'gte' && !(rv !== null && rv !== undefined && String(rv) >= String(f.val))) return false;
      if (f.op === 'gt' && !(rv !== null && rv !== undefined && String(rv) > String(f.val))) return false;
      if (f.op === 'not_null' && (rv === null || rv === undefined)) return false;
    }
    return true;
  };

  const makeBuilder = (table: keyof MockDbState) => {
    const filters: Array<{ op: string; col: string; val: any }> = [];
    let updatePayload: Record<string, any> | null = null;
    let insertPayload: Record<string, any> | null = null;
    let limitCount: number | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    let singleMode = false;

    const execute = async () => {
      const rows = (state[table] as any[]) || [];

      if (insertPayload) {
        if (table === 'settings' && insertPayload.id && rows.some((r) => r.id === insertPayload!.id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "settings_pkey"' } };
        }
        const rec = {
          id: `${String(table)}-${rows.length + 1}`,
          created_at: new Date().toISOString(),
          ...(table === 'settings'
            ? {
                updated_at:
                  freezeTriggerTs ||
                  `2026-11-26T00:00:${String(settingsVersionCounter++).padStart(2, '0')}.000Z`,
              }
            : {}),
          ...structuredClone(insertPayload),
          ...(table === 'settings' && freezeTriggerTs ? { updated_at: freezeTriggerTs } : {}),
        };
        rows.push(rec);
        state.writeLog.push({ table: String(table), op: 'insert', payload: structuredClone(insertPayload) });
        return { data: singleMode ? structuredClone(rec) : [structuredClone(rec)], error: null };
      }

      if (updatePayload) {
        // Guardrail assertion: vpn_configs does NOT have an updated_at column in production schema!
        if (table === 'vpn_configs' && 'updated_at' in updatePayload) {
          return {
            data: null,
            error: { message: 'column "updated_at" of relation "vpn_configs" does not exist' },
          };
        }
        const matched = rows.filter((r) => matchFilters(r, filters));
        for (const r of matched) {
          Object.assign(r, structuredClone(updatePayload));
          if (table === 'settings') {
            // Simulate PostgreSQL BEFORE UPDATE trigger `NEW.updated_at = NOW()` (which may override explicit updated_at)
            r.updated_at =
              freezeTriggerTs ||
              `2026-11-26T00:00:${String(settingsVersionCounter++).padStart(2, '0')}.000Z`;
          }
        }
        if (matched.length > 0) {
          state.writeLog.push({ table: String(table), op: 'update', payload: structuredClone(updatePayload) });
        }
        return { data: singleMode ? (matched[0] ? structuredClone(matched[0]) : null) : structuredClone(matched), error: null };
      }

      let matched = rows.filter((r) => matchFilters(r, filters));
      if (orderCol) {
        const col = orderCol;
        const asc = orderAsc;
        matched = [...matched].sort((a, b) => {
          const av = String(a?.[col] ?? '');
          const bv = String(b?.[col] ?? '');
          if (av === bv) return 0;
          return asc ? (av < bv ? -1 : 1) : (av > bv ? -1 : 1);
        });
      }
      const effectiveLimit =
        limitCount !== null && serverMaxRows !== null
          ? Math.min(limitCount, serverMaxRows)
          : limitCount !== null
            ? limitCount
            : serverMaxRows;
      if (effectiveLimit !== null) matched = matched.slice(0, effectiveLimit);
      return { data: singleMode ? (matched[0] ? structuredClone(matched[0]) : null) : structuredClone(matched), error: null };
    };

    const builder: any = {
      select() { return builder; },
      order(col?: string, opts?: { ascending?: boolean }) {
        if (col) {
          orderCol = col;
          orderAsc = opts?.ascending !== false;
        }
        return builder;
      },
      eq(col: string, val: any) { filters.push({ op: 'eq', col, val }); return builder; },
      is(col: string, val: any) { filters.push({ op: 'is', col, val }); return builder; },
      ilike(col: string, val: any) { filters.push({ op: 'ilike', col, val }); return builder; },
      in(col: string, val: any[]) { filters.push({ op: 'in', col, val }); return builder; },
      gte(col: string, val: any) { filters.push({ op: 'gte', col, val }); return builder; },
      gt(col: string, val: any) { filters.push({ op: 'gt', col, val }); return builder; },
      not(col: string, op: string, val: any) {
        if (op === 'is' && val === null) filters.push({ op: 'not_null', col, val: null });
        return builder;
      },
      limit(n: number) { limitCount = n; return builder; },
      maybeSingle() { singleMode = true; return execute(); },
      update(payload: Record<string, any>) { updatePayload = payload; return builder; },
      insert(payload: Record<string, any>) { insertPayload = payload; return builder; },
      then(resolve: any, reject: any) { return execute().then(resolve, reject); },
    };
    return builder;
  };

  const dbClient = {
    state,
    from(table: string) {
      return makeBuilder(table as keyof MockDbState);
    },
    async rpc(fn: string, args: Record<string, any>) {
      state.rpcCalls.push({ fn, args });

      if (fn === 'acquire_provisioning_lock') {
        const key = String(args.p_operation_key);
        const existing = state.locks.get(key);
        if (existing && existing.status === 'in_progress') {
          return {
            data: [{
              acquired: false,
              stale_recovery: false,
              previous_status: 'in_progress',
              previous_operation_type: existing.operationType,
              holder_owner_id: existing.ownerId,
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
        }
        return { data: true, error: null };
      }

      if (fn === 'mark_vpn_client_panel_deleted') {
        const normUuid = String(args.p_client_uuid || '').trim().toLowerCase();
        const nowIso = new Date().toISOString();

        const unresolvedGrants = state.vpn_entitlement_grants.filter(
          (g) =>
            String(g.client_uuid || '').trim().toLowerCase() === normUuid &&
            ['provisioning', 'provisional', 'uncertain', 'revoke_failed'].includes(String(g.status || '').toLowerCase())
        );
        const reconciliationRequired = unresolvedGrants.length > 0;
        const reconciliationNote = reconciliationRequired
          ? `Client confirmed permanently deleted in 3X-UI while ${unresolvedGrants.length} unresolved entitlement grant(s) exist. Admin reconciliation required.`
          : null;

        let accountsUpdated = 0;
        for (const acc of state.vpn_accounts) {
          if (String(acc.uuid || '').trim().toLowerCase() === normUuid && (acc.status !== 'deleted' || !acc.deleted_from_panel_at)) {
            acc.status = 'deleted';
            acc.enable = false;
            acc.deleted_from_panel_at = nowIso;
            acc.deleted_from_panel_inbound_id = args.p_inbound_id;
            acc.deleted_from_panel_identity = args.p_panel_identity;
            acc.reconciliation_required = reconciliationRequired;
            acc.reconciliation_note = reconciliationNote;
            acc.updated_at = nowIso;
            accountsUpdated++;
          }
        }

        let configsUpdated = 0;
        for (const cfg of state.vpn_configs) {
          if (String(cfg.uuid || '').trim().toLowerCase() === normUuid && (cfg.status !== 'deleted' || !cfg.deleted_from_panel_at)) {
            cfg.status = 'deleted';
            cfg.enabled = false;
            cfg.deleted_from_panel_at = nowIso;
            cfg.deleted_from_panel_inbound_id = args.p_inbound_id;
            cfg.deleted_from_panel_identity = args.p_panel_identity;
            cfg.reconciliation_required = reconciliationRequired;
            cfg.reconciliation_note = reconciliationNote;
            configsUpdated++;
          }
        }

        let profilesCleared = 0;
        for (const p of state.profiles) {
          if (String(p.active_vpn_uuid || '').trim().toLowerCase() === normUuid) {
            p.active_vpn_uuid = null;
            profilesCleared++;
          }
        }

        const action = reconciliationRequired
          ? 'panel_client_deleted_reconciliation_required'
          : 'panel_client_deleted_confirmed';

        const alreadyAudited = state.audit_logs.some(
          (a) => a.action === action && a.target_type === 'vpn_client' && a.target_id === normUuid
        );
        let auditLogged = false;
        if (!alreadyAudited && (accountsUpdated > 0 || configsUpdated > 0 || reconciliationRequired)) {
          state.audit_logs.push({
            id: `audit-${state.audit_logs.length + 1}`,
            user_id: args.p_user_id || null,
            action,
            target_type: 'vpn_client',
            target_id: normUuid,
            details: {
              ...(args.p_details || {}),
              client_uuid: normUuid,
              inbound_id: args.p_inbound_id,
              panel_identity: args.p_panel_identity,
              reconciliation_required: reconciliationRequired,
              unresolved_grant_count: unresolvedGrants.length,
            },
            created_at: nowIso,
          });
          auditLogged = true;
        }

        return {
          data: [{
            applied: accountsUpdated > 0 || configsUpdated > 0,
            accounts_updated: accountsUpdated,
            configs_updated: configsUpdated,
            profiles_cleared: profilesCleared,
            reconciliation_required: reconciliationRequired,
            unresolved_grant_count: unresolvedGrants.length,
            audit_logged: auditLogged,
          }],
          error: null,
        };
      }

      return { data: null, error: { message: `Unknown RPC ${fn}` } };
    },
  };

  return dbClient;
}

function makeInbound(id: number, clients: any[], opts?: { enable?: boolean; clientStats?: any[]; rawSettings?: string }): XuiInbound {
  return {
    id,
    up: 0,
    down: 0,
    total: 0,
    remark: `Inbound-${id}`,
    enable: opts?.enable ?? true,
    expiryTime: 0,
    clientStats: opts?.clientStats ?? [],
    port: 443,
    protocol: 'vless',
    settings: opts?.rawSettings !== undefined ? opts.rawSettings : JSON.stringify({ clients }),
    streamSettings: '{}',
    tag: `inbound-${id}`,
    sniffing: '{}',
  };
}

function buildListResult(inbounds: XuiInbound[]): UncachedInboundsListReadResult {
  const parsedByInboundId = new Map<number, any>();
  const unparsedInboundIds: number[] = [];
  const liveClientByUuid = new Map<string, any>();

  for (const ib of inbounds) {
    const parsed = parseInboundSettingsClientsStrict(ib);
    if (!parsed.ok) {
      unparsedInboundIds.push(Number(ib.id) || -1);
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
      const u = String(c.id || '').trim().toLowerCase();
      if (!u) continue;
      const stat = stats.find((s: any) => String(s.email || '').toLowerCase() === String(c.email || '').toLowerCase()) || null;
      liveClientByUuid.set(u, { inbound: ib, client: c, stat });
    }
  }

  return {
    ok: true,
    inbounds,
    parsedByInboundId,
    unparsedInboundIds,
    allInboundsCleanlyParsed: unparsedInboundIds.length === 0,
    liveClientByUuid,
  };
}

function makeInboundFetcher(inbounds: XuiInbound[]): (id: number) => Promise<UncachedInboundReadResult> {
  return async (id: number) => {
    const found = inbounds.find((ib) => Number(ib.id) === Number(id));
    if (!found) return { status: 'not_found' };
    const parsed = parseInboundSettingsClientsStrict(found);
    if ('reason' in parsed) return { status: 'error', reason: parsed.reason };
    return { status: 'found', inbound: found, clients: parsed.clients, clientUuidSet: parsed.clientUuidSet };
  };
}

// ---------------------------------------------------------------------------
// 1. Enabled, Disabled, Expired, Exhausted VPN clients remain visible
// ---------------------------------------------------------------------------
test('1. Enabled, Disabled, Expired, and Quota-Exhausted VPN clients all remain visible with accurate statuses', async () => {
  const uid = 'user-1';
  const email = 'customer1@example.com';

  const db = createMockDb({
    vpn_accounts: [
      { id: 'acc-en', user_id: uid, email, uuid: 'uuid-enabled', status: 'active', enable: true, order_id: 'ord-en', vless_url: 'vless://uuid-enabled@sg.example.com:443#Enabled', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-dis', user_id: uid, email, uuid: 'uuid-disabled', status: 'disabled', enable: false, order_id: 'ord-dis', vless_url: 'vless://uuid-disabled@sg.example.com:443#Disabled', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-exp', user_id: uid, email, uuid: 'uuid-expired', status: 'expired', enable: true, order_id: 'ord-exp', vless_url: 'vless://uuid-expired@sg.example.com:443#Expired', expiry_date: new Date(EXPIRED_EXPIRY_MS).toISOString(), panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-exh', user_id: uid, email, uuid: 'uuid-exhausted', status: 'active', enable: true, order_id: 'ord-exh', vless_url: 'vless://uuid-exhausted@sg.example.com:443#Exhausted', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-en', user_id: uid, customer_uid: uid, uuid: 'uuid-enabled', inbound_id: 10, status: 'active', enabled: true, order_id: 'ord-en', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-dis', user_id: uid, customer_uid: uid, uuid: 'uuid-disabled', inbound_id: 10, status: 'disabled', enabled: false, order_id: 'ord-dis', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-exp', user_id: uid, customer_uid: uid, uuid: 'uuid-expired', inbound_id: 10, status: 'expired', enabled: true, order_id: 'ord-exp', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-exh', user_id: uid, customer_uid: uid, uuid: 'uuid-exhausted', inbound_id: 10, status: 'active', enabled: true, order_id: 'ord-exh', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    orders: [
      { id: 'ord-en', order_id: 'ORD-EN', customer_id: uid, email, status: 'completed', payment_status: 'Paid', client_uuid: 'uuid-enabled', vless_url: 'vless://uuid-enabled@sg.example.com:443#Enabled' },
      { id: 'ord-dis', order_id: 'ORD-DIS', customer_id: uid, email, status: 'completed', payment_status: 'Paid', client_uuid: 'uuid-disabled', vless_url: 'vless://uuid-disabled@sg.example.com:443#Disabled' },
      { id: 'ord-exp', order_id: 'ORD-EXP', customer_id: uid, email, status: 'completed', payment_status: 'Paid', client_uuid: 'uuid-expired', vless_url: 'vless://uuid-expired@sg.example.com:443#Expired' },
      { id: 'ord-exh', order_id: 'ORD-EXH', customer_id: uid, email, status: 'completed', payment_status: 'Paid', client_uuid: 'uuid-exhausted', vless_url: 'vless://uuid-exhausted@sg.example.com:443#Exhausted' },
    ],
  });

  const liveIb = makeInbound(10, [
    { id: 'uuid-enabled', email: 'en@example.com', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 100 * 1024 ** 3 },
    { id: 'uuid-disabled', email: 'dis@example.com', enable: false, expiryTime: FUTURE_EXPIRY_MS, totalGB: 100 * 1024 ** 3 },
    { id: 'uuid-expired', email: 'exp@example.com', enable: true, expiryTime: EXPIRED_EXPIRY_MS, totalGB: 100 * 1024 ** 3 },
    { id: 'uuid-exhausted', email: 'exh@example.com', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 10 * 1024 ** 3 },
  ], {
    clientStats: [
      { id: 1, inboundId: 10, email: 'en@example.com', enable: true, up: 1024, down: 2048, total: 100 * 1024 ** 3, expiryTime: FUTURE_EXPIRY_MS, reset: 0 },
      { id: 2, inboundId: 10, email: 'dis@example.com', enable: true, up: 0, down: 0, total: 100 * 1024 ** 3, expiryTime: FUTURE_EXPIRY_MS, reset: 0 },
      { id: 3, inboundId: 10, email: 'exp@example.com', enable: true, up: 0, down: 0, total: 100 * 1024 ** 3, expiryTime: EXPIRED_EXPIRY_MS, reset: 0 },
      { id: 4, inboundId: 10, email: 'exh@example.com', enable: true, up: 5 * 1024 ** 3, down: 6 * 1024 ** 3, total: 10 * 1024 ** 3, expiryTime: FUTURE_EXPIRY_MS, reset: 0 },
    ],
  });

  const res = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    getCachedInboundsFn: async () => [liveIb],
    getLiveInboundFn: async () => liveIb,
    getInboundsFn: async () => [liveIb],
    currentPanelIdentity: PANEL_A_ID,
  });

  assert.equal(res.configs.length, 4);
  assert.equal(res.deletedUuids.length, 0);
  const byUuid = new Map(res.configs.map((c) => [c.uuid, c]));
  assert.equal(byUuid.get('uuid-enabled')?.status, 'Active');
  assert.equal(byUuid.get('uuid-disabled')?.status, 'Disabled');
  assert.equal(byUuid.get('uuid-expired')?.status, 'Expired');
  assert.equal(byUuid.get('uuid-exhausted')?.status, 'Data Limit Reached');
});

// ---------------------------------------------------------------------------
// 2. Re-enabled client safely recovers Active; rejected/revoked/deleted NEVER restore
// ---------------------------------------------------------------------------
test('2. Re-enabled legitimate client recovers Active, while rejected, revoked, and previously deleted clients never auto-restore', async () => {
  const uid = 'user-2';
  const email = 'customer2@example.com';

  const db = createMockDb({
    vpn_accounts: [
      { id: 'acc-reen', user_id: uid, email, uuid: 'uuid-reenabled', status: 'disabled', enable: false, order_id: 'ord-ok', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-rej', user_id: uid, email, uuid: 'uuid-rejected', status: 'disabled', enable: false, order_id: 'ord-rej', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-del', user_id: uid, email, uuid: 'uuid-previously-deleted', status: 'deleted', enable: false, deleted_from_panel_at: PAST_CREATED_AT, order_id: 'ord-del', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-reen', user_id: uid, customer_uid: uid, uuid: 'uuid-reenabled', inbound_id: 10, status: 'disabled', enabled: false, order_id: 'ord-ok', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-rej', user_id: uid, customer_uid: uid, uuid: 'uuid-rejected', inbound_id: 10, status: 'disabled', enabled: false, order_id: 'ord-rej', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-del', user_id: uid, customer_uid: uid, uuid: 'uuid-previously-deleted', inbound_id: 10, status: 'deleted', enabled: false, deleted_from_panel_at: PAST_CREATED_AT, order_id: 'ord-del', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    orders: [
      { id: 'ord-ok', status: 'completed', payment_status: 'Paid', provisioning_status: 'completed' },
      { id: 'ord-rej', status: 'rejected', payment_status: 'Rejected', provisioning_status: 'revoked', reject_reason: 'Invalid slip' },
      { id: 'ord-del', status: 'completed', payment_status: 'Paid', provisioning_status: 'completed' },
    ],
  });

  const liveIb = makeInbound(10, [
    { id: 'uuid-reenabled', email: 'reen@example.com', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
    { id: 'uuid-rejected', email: 'rej@example.com', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
    { id: 'uuid-previously-deleted', email: 'del@example.com', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
  ]);

  const syncRes = await syncDeleted3XUiClients({
    dbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => buildListResult([liveIb]),
    fetchUncachedInbound: makeInboundFetcher([liveIb]),
    reReadDelayMs: 0,
  });

  assert.equal(syncRes.synced, true);
  assert.equal(syncRes.deletedCount, 0);
  assert.equal(syncRes.restoredCount, 1);

  assert.equal(db.state.vpn_accounts.find((a) => a.uuid === 'uuid-reenabled')?.status, 'active');
  assert.equal(db.state.vpn_configs.find((c) => c.uuid === 'uuid-reenabled')?.status, 'active');
  // Rejected order client MUST remain disabled!
  assert.equal(db.state.vpn_accounts.find((a) => a.uuid === 'uuid-rejected')?.status, 'disabled');
  // Previously deleted client MUST remain deleted (never auto-resurrected)!
  assert.equal(db.state.vpn_accounts.find((a) => a.uuid === 'uuid-previously-deleted')?.status, 'deleted');
});

// ---------------------------------------------------------------------------
// 3. Permanently deleted Active, Disabled, and Expired clients are ALL detected & removed
//    Orders are NEVER mutated, and other configs of same customer are preserved
// ---------------------------------------------------------------------------
test('3. Permanently deleted Active, Disabled, and Expired clients are removed while preserving remaining configs and historical orders', async () => {
  const uid = 'user-3';
  const email = 'customer3@example.com';

  const db = createMockDb({
    vpn_accounts: [
      { id: 'acc-keep', user_id: uid, email, uuid: 'uuid-keep', status: 'active', enable: true, order_id: 'ord-keep', vless_url: 'vless://uuid-keep@sg.example.com:443#Keep', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-del-act', user_id: uid, email, uuid: 'uuid-del-active', status: 'active', enable: true, order_id: 'ord-del-act', vless_url: 'vless://uuid-del-active@sg.example.com:443#DelAct', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-del-dis', user_id: uid, email, uuid: 'uuid-del-disabled', status: 'disabled', enable: false, order_id: 'ord-del-dis', vless_url: 'vless://uuid-del-disabled@sg.example.com:443#DelDis', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-del-exp', user_id: uid, email, uuid: 'uuid-del-expired', status: 'expired', enable: true, order_id: 'ord-del-exp', vless_url: 'vless://uuid-del-expired@sg.example.com:443#DelExp', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-keep', user_id: uid, customer_uid: uid, uuid: 'uuid-keep', inbound_id: 10, status: 'active', enabled: true, order_id: 'ord-keep', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-del-act', user_id: uid, customer_uid: uid, uuid: 'uuid-del-active', inbound_id: 10, status: 'active', enabled: true, order_id: 'ord-del-act', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-del-dis', user_id: uid, customer_uid: uid, uuid: 'uuid-del-disabled', inbound_id: 10, status: 'disabled', enabled: false, order_id: 'ord-del-dis', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-del-exp', user_id: uid, customer_uid: uid, uuid: 'uuid-del-expired', inbound_id: 10, status: 'expired', enabled: true, order_id: 'ord-del-exp', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    orders: [
      { id: 'ord-keep', order_id: 'ORD-KEEP', customer_id: uid, email, status: 'completed', payment_status: 'Paid', amount: 400, client_uuid: 'uuid-keep', vless_url: 'vless://uuid-keep@sg.example.com:443#Keep' },
      { id: 'ord-del-act', order_id: 'ORD-DA', customer_id: uid, email, status: 'completed', payment_status: 'Paid', amount: 400, client_uuid: 'uuid-del-active', vless_url: 'vless://uuid-del-active@sg.example.com:443#DelAct' },
      { id: 'ord-del-dis', order_id: 'ORD-DD', customer_id: uid, email, status: 'completed', payment_status: 'Paid', amount: 200, client_uuid: 'uuid-del-disabled', vless_url: 'vless://uuid-del-disabled@sg.example.com:443#DelDis' },
      { id: 'ord-del-exp', order_id: 'ORD-DE', customer_id: uid, email, status: 'completed', payment_status: 'Paid', amount: 600, client_uuid: 'uuid-del-expired', vless_url: 'vless://uuid-del-expired@sg.example.com:443#DelExp' },
    ],
    profiles: [{ id: uid, active_vpn_uuid: 'uuid-del-active' }],
  });

  // Live inbound has ONLY uuid-keep; note stale clientStats still has uuid-del-active to prove clientStats is ignored!
  const liveIb = makeInbound(10, [
    { id: 'uuid-keep', email: 'keep@example.com', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
  ], {
    clientStats: [
      { id: 'uuid-del-active' as any, inboundId: 10, email: 'deleted@example.com', enable: true, up: 100, down: 100, total: 0, expiryTime: FUTURE_EXPIRY_MS, reset: 0 },
    ],
  });

  const syncRes = await syncDeleted3XUiClients({
    dbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => buildListResult([liveIb]),
    fetchUncachedInbound: makeInboundFetcher([liveIb]),
    reReadDelayMs: 0,
  });

  assert.equal(syncRes.synced, true);
  assert.equal(syncRes.deletedCount, 3);

  // uuid-keep untouched; all 3 deleted UUIDs marked deleted
  assert.equal(db.state.vpn_accounts.find((a) => a.uuid === 'uuid-keep')?.status, 'active');
  assert.equal(db.state.vpn_accounts.find((a) => a.uuid === 'uuid-del-active')?.status, 'deleted');
  assert.equal(db.state.vpn_accounts.find((a) => a.uuid === 'uuid-del-disabled')?.status, 'deleted');
  assert.equal(db.state.vpn_accounts.find((a) => a.uuid === 'uuid-del-expired')?.status, 'deleted');

  // profiles.active_vpn_uuid pointing to deleted UUID was cleared
  assert.equal(db.state.profiles[0].active_vpn_uuid, null);

  // CRITICAL: Historical orders MUST remain 100% untouched (status='completed', payment_status='Paid')
  for (const ord of db.state.orders) {
    assert.equal(ord.status, 'completed');
    assert.equal(ord.payment_status, 'Paid');
  }

  // Customer getMyConfigs now returns ONLY uuid-keep and reports the 3 deletedUuids
  const myRes = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    getCachedInboundsFn: async () => [liveIb],
    getLiveInboundFn: async () => liveIb,
    getInboundsFn: async () => [liveIb],
    currentPanelIdentity: PANEL_A_ID,
  });
  assert.equal(myRes.configs.length, 1);
  assert.equal(myRes.configs[0].uuid, 'uuid-keep');
  assert.deepEqual(new Set(myRes.deletedUuids), new Set(['uuid-del-active', 'uuid-del-disabled', 'uuid-del-expired']));

  // Idempotency: second sync performs 0 additional deletions and 0 duplicate audit logs
  const auditCountAfterFirst = db.state.audit_logs.length;
  const syncRes2 = await syncDeleted3XUiClients({
    dbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => buildListResult([liveIb]),
    fetchUncachedInbound: makeInboundFetcher([liveIb]),
    reReadDelayMs: 0,
  });
  assert.equal(syncRes2.deletedCount, 0);
  assert.equal(db.state.audit_logs.length, auditCountAfterFirst);
});

// ---------------------------------------------------------------------------
// 4. Deleting the last VPN configuration yields clean empty state
// ---------------------------------------------------------------------------
test('4. Deleting the customer last VPN configuration returns 0 configs while preserving order history', async () => {
  const uid = 'user-4';
  const email = 'customer4@example.com';

  const db = createMockDb({
    vpn_accounts: [
      { id: 'acc-last', user_id: uid, email, uuid: 'uuid-last', status: 'active', enable: true, order_id: 'ord-last', vless_url: 'vless://uuid-last@sg.example.com:443#Last', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-last', user_id: uid, customer_uid: uid, uuid: 'uuid-last', inbound_id: 10, status: 'active', enabled: true, order_id: 'ord-last', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    orders: [
      { id: 'ord-last', order_id: 'ORD-LAST', customer_id: uid, email, status: 'completed', payment_status: 'Paid', amount: 400, client_uuid: 'uuid-last', vless_url: 'vless://uuid-last@sg.example.com:443#Last' },
    ],
    profiles: [{ id: uid, active_vpn_uuid: 'uuid-last' }],
  });

  const emptyIb = makeInbound(10, []);

  const syncRes = await syncDeleted3XUiClients({
    dbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => buildListResult([emptyIb]),
    fetchUncachedInbound: makeInboundFetcher([emptyIb]),
    reReadDelayMs: 0,
  });

  assert.equal(syncRes.deletedCount, 1);
  assert.equal(db.state.orders[0].status, 'completed');
  assert.equal(db.state.orders[0].payment_status, 'Paid');

  const myRes = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    getCachedInboundsFn: async () => [emptyIb],
    getLiveInboundFn: async () => emptyIb,
    getInboundsFn: async () => [emptyIb],
    currentPanelIdentity: PANEL_A_ID,
  });
  assert.equal(myRes.configs.length, 0);
  assert.deepEqual(myRes.deletedUuids, ['uuid-last']);
});

// ---------------------------------------------------------------------------
// 5. Panel timeout / unreachable, stale cache, malformed JSON, incomplete inbound -> ZERO writes
// ---------------------------------------------------------------------------
test('5. Panel timeout, stale cache, malformed JSON, and missing/incomplete inbound perform ZERO deletion writes', async () => {
  const uid = 'user-5';
  const email = 'customer5@example.com';

  const makeState = () => createMockDb({
    vpn_accounts: [
      { id: 'acc-safe', user_id: uid, email, uuid: 'uuid-safe', status: 'active', enable: true, order_id: 'ord-safe', vless_url: 'vless://uuid-safe@sg.example.com:443#Safe', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-safe', user_id: uid, customer_uid: uid, uuid: 'uuid-safe', inbound_id: 10, status: 'active', enabled: true, order_id: 'ord-safe', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
  });

  // 5a. Panel timeout / unreachable
  const dbTimeout = makeState();
  const timeoutRes = await syncDeleted3XUiClients({
    dbClient: dbTimeout,
    currentPanelIdentity: PANEL_A_ID,
    fetchUncachedInboundsList: async () => ({
      ok: false,
      reason: 'ETIMEDOUT',
      inbounds: [],
      parsedByInboundId: new Map(),
      unparsedInboundIds: [],
      allInboundsCleanlyParsed: false,
      liveClientByUuid: new Map(),
    }),
    reReadDelayMs: 0,
  });
  assert.equal(timeoutRes.synced, false);
  assert.equal(timeoutRes.deletedCount, 0);
  assert.equal(dbTimeout.state.vpn_accounts[0].status, 'active');

  // 5b. Stale cache missing the client while fresh uncached live panel still has the client
  setCachedInbounds([makeInbound(10, [])]); // Poison in-memory cache with empty clients
  const dbCache = makeState();
  const liveHasClient = makeInbound(10, [{ id: 'uuid-safe', email, enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 }]);
  const cacheRes = await syncDeleted3XUiClients({
    dbClient: dbCache,
    currentPanelIdentity: PANEL_A_ID,
    fetchUncachedInboundsList: async () => buildListResult([liveHasClient]),
    fetchUncachedInbound: makeInboundFetcher([liveHasClient]),
    reReadDelayMs: 0,
  });
  assert.equal(cacheRes.deletedCount, 0);
  assert.equal(dbCache.state.vpn_accounts[0].status, 'active');

  // 5c. Malformed JSON in inbound.settings
  const dbMalformed = makeState();
  const malformedIb = makeInbound(10, [], { rawSettings: '{broken-json' });
  const malRes = await syncDeleted3XUiClients({
    dbClient: dbMalformed,
    currentPanelIdentity: PANEL_A_ID,
    fetchUncachedInboundsList: async () => buildListResult([malformedIb]),
    fetchUncachedInbound: makeInboundFetcher([malformedIb]),
    reReadDelayMs: 0,
  });
  assert.equal(malRes.deletedCount, 0);
  assert.equal(dbMalformed.state.vpn_accounts[0].status, 'active');

  // 5d. Missing inbound on get/{id} when /inbounds/list returns empty array (incomplete response)
  const dbEmptyList = makeState();
  const emptyListCheck = await verifyAndMarkClientDeletedIfConfirmed({
    clientUuid: 'uuid-safe',
    inboundId: 10,
    userId: uid,
    userEmail: email,
    recordPanelIdentity: PANEL_A_ID,
    createdAt: PAST_CREATED_AT,
    dbClient: dbEmptyList,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInbound: async () => ({ status: 'not_found' }),
    fetchUncachedInboundsList: async () => buildListResult([]),
    reReadDelayMs: 0,
  });
  assert.equal(emptyListCheck.confirmedDeleted, false);
  assert.equal(emptyListCheck.dbWrites, 0);
  assert.equal(dbEmptyList.state.vpn_accounts[0].status, 'active');

  // 5e. Two-read panel-wide verification: absent on Read 1, reappears on Read 2 -> ZERO writes
  const dbFlap = makeState();
  let readCallCount = 0;
  const flapCheck = await verifyAndMarkClientDeletedIfConfirmed({
    clientUuid: 'uuid-safe',
    inboundId: 10,
    userId: uid,
    userEmail: email,
    recordPanelIdentity: PANEL_A_ID,
    createdAt: PAST_CREATED_AT,
    dbClient: dbFlap,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => {
      readCallCount++;
      if (readCallCount === 1) {
        return buildListResult([makeInbound(10, [])]);
      }
      const c = { id: 'uuid-safe', email, enable: true, limitIp: 0, totalGB: 0, expiryTime: FUTURE_EXPIRY_MS, subId: '', reset: 0 };
      return buildListResult([makeInbound(10, [c])]);
    },
    reReadDelayMs: 0,
  });
  assert.equal(readCallCount, 2);
  assert.equal(flapCheck.confirmedDeleted, false);
  assert.equal(flapCheck.dbWrites, 0);
  assert.equal(dbFlap.state.vpn_accounts[0].status, 'active');
});

// ---------------------------------------------------------------------------
// 6. Wrong panel identity & ambiguous multi-panel identity -> ZERO writes + manual review audit
// ---------------------------------------------------------------------------
test('6. Wrong panel identity and ambiguous multi-panel records preserve config and log deduplicated manual review', async () => {
  const uid = 'user-6';
  const email = 'customer6@example.com';

  // Verify panel identity never matches by display name or VLESS host
  assert.notEqual(PANEL_A_ID, PANEL_B_ID);

  const db = createMockDb({
    vpn_accounts: [
      { id: 'acc-wrong-panel', user_id: uid, email, uuid: 'uuid-panel-b', status: 'active', enable: true, server_name: 'Singapore', panel_identity: PANEL_B_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-legacy-ambig', user_id: uid, email, uuid: 'uuid-ambig', status: 'active', enable: true, server_name: 'Singapore', panel_identity: null, server_id: null, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-wrong-panel', user_id: uid, customer_uid: uid, uuid: 'uuid-panel-b', inbound_id: 10, status: 'active', enabled: true, server_name: 'Singapore', panel_identity: PANEL_B_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-legacy-ambig', user_id: uid, customer_uid: uid, uuid: 'uuid-ambig', inbound_id: 10, status: 'active', enabled: true, server_name: 'Singapore', panel_identity: null, server_id: null, created_at: PAST_CREATED_AT },
    ],
    xui_servers: [
      { id: 'srv-a', panel_url: PANEL_A_URL, is_active: true },
      { id: 'srv-b', panel_url: PANEL_B_URL, is_active: true },
    ],
  });

  const emptyIb = makeInbound(10, []);

  const syncRes = await syncDeleted3XUiClients({
    dbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    fetchUncachedInboundsList: async () => buildListResult([emptyIb]),
    fetchUncachedInbound: makeInboundFetcher([emptyIb]),
    reReadDelayMs: 0,
  });

  assert.equal(syncRes.deletedCount, 0);
  assert.equal(syncRes.manualReviewCount, 2);
  assert.equal(db.state.vpn_accounts[0].status, 'active');
  assert.equal(db.state.vpn_accounts[1].status, 'active');

  const actions = db.state.audit_logs.map((l) => l.action);
  assert.ok(actions.includes('panel_deletion_wrong_panel_identity'));
  assert.ok(actions.includes('panel_deletion_ambiguous_identity'));

  // Verify audit deduplication on repeated cycle
  const countBefore = db.state.audit_logs.length;
  await syncDeleted3XUiClients({
    dbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    fetchUncachedInboundsList: async () => buildListResult([emptyIb]),
    fetchUncachedInbound: makeInboundFetcher([emptyIb]),
    reReadDelayMs: 0,
  });
  assert.equal(db.state.audit_logs.length, countBefore);
});

// ---------------------------------------------------------------------------
// 7. Concurrent lock contention & uncertain locks -> ZERO writes, NEVER force-released
// ---------------------------------------------------------------------------
test('7. Concurrent client lock, inbound lock, or uncertain lock aborts safely with zero writes and allowUncertainRecovery=false', async () => {
  const uid = 'user-7';
  const email = 'customer7@example.com';

  // 7a. Active renewal holding client:<uuid> lock
  const dbClientBusy = createMockDb({
    vpn_accounts: [{ id: 'acc-1', user_id: uid, email, uuid: 'uuid-busy', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT }],
    vpn_configs: [{ id: 'cfg-1', user_id: uid, customer_uid: uid, uuid: 'uuid-busy', inbound_id: 10, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT }],
    locks: new Map([['client:uuid-busy', { ownerId: 'renew-worker-1', status: 'in_progress', operationType: 'client_lock' }]]),
  });

  const emptyIb = makeInbound(10, []);
  const resBusy = await verifyAndMarkClientDeletedIfConfirmed({
    clientUuid: 'uuid-busy',
    inboundId: 10,
    userId: uid,
    userEmail: email,
    recordPanelIdentity: PANEL_A_ID,
    createdAt: PAST_CREATED_AT,
    dbClient: dbClientBusy,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInbound: makeInboundFetcher([emptyIb]),
    fetchUncachedInboundsList: async () => buildListResult([emptyIb]),
    reReadDelayMs: 0,
  });
  assert.equal(resBusy.confirmedDeleted, false);
  assert.equal(resBusy.dbWrites, 0);
  assert.equal(dbClientBusy.state.locks.get('client:uuid-busy')?.ownerId, 'renew-worker-1');
  assert.equal(dbClientBusy.state.vpn_accounts[0].status, 'active');

  // 7b. Uncertain inbound lock MUST NOT be stolen/force-released
  const dbInboundUncertain = createMockDb({
    vpn_accounts: [{ id: 'acc-2', user_id: uid, email, uuid: 'uuid-unc', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT }],
    vpn_configs: [{ id: 'cfg-2', user_id: uid, customer_uid: uid, uuid: 'uuid-unc', inbound_id: 10, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT }],
    locks: new Map([['inbound:10', { ownerId: 'crashed-worker-9', status: 'uncertain', operationType: 'inbound_write' }]]),
  });

  const resUnc = await verifyAndMarkClientDeletedIfConfirmed({
    clientUuid: 'uuid-unc',
    inboundId: 10,
    userId: uid,
    userEmail: email,
    recordPanelIdentity: PANEL_A_ID,
    createdAt: PAST_CREATED_AT,
    dbClient: dbInboundUncertain,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInbound: makeInboundFetcher([emptyIb]),
    fetchUncachedInboundsList: async () => buildListResult([emptyIb]),
    reReadDelayMs: 0,
  });
  assert.equal(resUnc.confirmedDeleted, false);
  assert.equal(resUnc.dbWrites, 0);
  assert.equal(dbInboundUncertain.state.locks.get('inbound:10')?.status, 'uncertain');
  assert.equal(dbInboundUncertain.state.locks.get('inbound:10')?.ownerId, 'crashed-worker-9');

  // Verify EVERY acquire_provisioning_lock RPC call passed p_allow_uncertain_recovery: false
  const lockCalls = dbInboundUncertain.state.rpcCalls.filter((c) => c.fn === 'acquire_provisioning_lock');
  assert.ok(lockCalls.length >= 2);
  for (const call of lockCalls) {
    assert.equal(call.args.p_allow_uncertain_recovery, false);
  }
  // Verify lock acquisition order: client:<uuid> acquired BEFORE inbound:<inboundId>
  assert.equal(lockCalls[0].args.p_operation_key, 'client:uuid-unc');
  assert.equal(lockCalls[1].args.p_operation_key, 'inbound:10');
});

// ---------------------------------------------------------------------------
// 8. Unresolved provisional entitlement grant -> sets durable reconciliation flag & deduplicated audit log
// ---------------------------------------------------------------------------
test('8. Deleting a client with an unresolved provisional grant sets reconciliation_required and writes deduplicated audit_logs without mutating grants or orders', async () => {
  const uid = 'user-8';
  const email = 'customer8@example.com';

  const db = createMockDb({
    vpn_accounts: [
      { id: 'acc-prov', user_id: uid, email, uuid: 'uuid-prov', status: 'active', enable: true, order_id: 'ord-prov', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-prov', user_id: uid, customer_uid: uid, uuid: 'uuid-prov', inbound_id: 10, status: 'active', enabled: true, order_id: 'ord-prov', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    orders: [
      { id: 'ord-prov', order_id: 'ORD-PROV', customer_id: uid, email, status: 'pending', payment_status: 'Pending Verification', provisioning_status: 'provisional', client_uuid: 'uuid-prov' },
    ],
    vpn_entitlement_grants: [
      { id: 'grant-1', grant_type: 'renewal', source_id: 'ren-1', order_id: 'ord-prov', client_uuid: 'uuid-prov', inbound_id: 10, status: 'provisional' },
    ],
  });

  const emptyIb = makeInbound(10, []);

  const syncRes = await syncDeleted3XUiClients({
    dbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => buildListResult([emptyIb]),
    fetchUncachedInbound: makeInboundFetcher([emptyIb]),
    reReadDelayMs: 0,
  });

  assert.equal(syncRes.deletedCount, 1);
  assert.equal(syncRes.reconciliationFlaggedCount, 1);
  assert.equal(db.state.vpn_accounts[0].status, 'deleted');
  assert.equal(db.state.vpn_accounts[0].reconciliation_required, true);
  assert.match(String(db.state.vpn_accounts[0].reconciliation_note), /unresolved entitlement grant/i);
  assert.equal(db.state.vpn_configs[0].status, 'deleted');
  assert.equal(db.state.vpn_configs[0].reconciliation_required, true);

  // Order and entitlement grant records remain completely intact!
  assert.equal(db.state.orders[0].status, 'pending');
  assert.equal(db.state.orders[0].payment_status, 'Pending Verification');
  assert.equal(db.state.vpn_entitlement_grants[0].status, 'provisional');

  // Deduplicated audit log recorded
  const recAudits = db.state.audit_logs.filter((a) => a.action === 'panel_client_deleted_reconciliation_required');
  assert.equal(recAudits.length, 1);
  assert.equal(recAudits[0].target_type, 'vpn_client');
  assert.equal(recAudits[0].target_id, 'uuid-prov');
});

// ---------------------------------------------------------------------------
// 9. Fail-closed RPC safety: missing, failing, empty, or skipped RPC performs ZERO writes
// ---------------------------------------------------------------------------
test('9. Missing, failing, or unavailable mark_vpn_client_panel_deleted RPC fails closed with zero independent DB writes', async () => {
  const uid = 'user-9';
  const email = 'customer9@example.com';
  const emptyIb = makeInbound(10, []);

  // 9a. Missing RPC in schema cache -> MUST fail closed (NO independent fallback updates!)
  const dbMissing = createMockDb({
    vpn_accounts: [
      { id: 'acc-fb', user_id: uid, email, uuid: 'uuid-fb', status: 'active', enable: true, order_id: 'ord-fb', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-fb', user_id: uid, customer_uid: uid, uuid: 'uuid-fb', inbound_id: 10, status: 'active', enabled: true, order_id: 'ord-fb', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    profiles: [{ id: uid, active_vpn_uuid: 'uuid-fb' }],
  });
  const origMissingRpc = dbMissing.rpc.bind(dbMissing);
  dbMissing.rpc = async (fn: string, args: Record<string, any>) => {
    if (fn === 'mark_vpn_client_panel_deleted') {
      return { data: null, error: { message: 'Could not find the function public.mark_vpn_client_panel_deleted in the schema cache' } };
    }
    return origMissingRpc(fn, args);
  };

  const resMissing = await verifyAndMarkClientDeletedIfConfirmed({
    clientUuid: 'uuid-fb',
    inboundId: 10,
    userId: uid,
    userEmail: email,
    recordPanelIdentity: PANEL_A_ID,
    createdAt: PAST_CREATED_AT,
    dbClient: dbMissing,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInbound: makeInboundFetcher([emptyIb]),
    fetchUncachedInboundsList: async () => buildListResult([emptyIb]),
    reReadDelayMs: 0,
  });

  assert.equal(resMissing.confirmedDeleted, false);
  assert.equal(resMissing.applied, false);
  assert.equal(resMissing.dbWrites, 0);
  assert.match(String(resMissing.reason), /^rpc_missing:/);
  assert.equal(dbMissing.state.vpn_accounts[0].status, 'active');
  assert.equal(dbMissing.state.vpn_configs[0].status, 'active');
  assert.equal(dbMissing.state.profiles[0].active_vpn_uuid, 'uuid-fb');
  assert.equal(dbMissing.state.writeLog.length, 0, 'Missing RPC must perform ZERO independent DB writes');

  // 9b. Transient DB/RPC error -> MUST fail closed with zero writes
  const dbErr = createMockDb({
    vpn_accounts: [
      { id: 'acc-err', user_id: uid, email, uuid: 'uuid-err', status: 'active', enable: true, order_id: 'ord-err', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-err', user_id: uid, customer_uid: uid, uuid: 'uuid-err', inbound_id: 10, status: 'active', enabled: true, order_id: 'ord-err', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
  });
  const origErrRpc = dbErr.rpc.bind(dbErr);
  dbErr.rpc = async (fn: string, args: Record<string, any>) => {
    if (fn === 'mark_vpn_client_panel_deleted') {
      return { data: null, error: { message: 'connection terminated unexpectedly' } };
    }
    return origErrRpc(fn, args);
  };

  const resErr = await verifyAndMarkClientDeletedIfConfirmed({
    clientUuid: 'uuid-err',
    inboundId: 10,
    userId: uid,
    userEmail: email,
    recordPanelIdentity: PANEL_A_ID,
    createdAt: PAST_CREATED_AT,
    dbClient: dbErr,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInbound: makeInboundFetcher([emptyIb]),
    fetchUncachedInboundsList: async () => buildListResult([emptyIb]),
    reReadDelayMs: 0,
  });
  assert.equal(resErr.confirmedDeleted, false);
  assert.equal(resErr.dbWrites, 0);
  assert.equal(dbErr.state.writeLog.length, 0);
  assert.equal(dbErr.state.vpn_accounts[0].status, 'active');
  assert.equal(dbErr.state.vpn_configs[0].status, 'active');

  // 9c. RPC returns skip_reason (e.g., ownership_mismatch) -> MUST fail closed with confirmedDeleted=false
  const dbSkip = createMockDb({
    vpn_accounts: [
      { id: 'acc-skip', user_id: uid, email, uuid: 'uuid-skip', status: 'active', enable: true, order_id: 'ord-skip', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-skip', user_id: uid, customer_uid: uid, uuid: 'uuid-skip', inbound_id: 10, status: 'active', enabled: true, order_id: 'ord-skip', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
  });
  const origSkipRpc = dbSkip.rpc.bind(dbSkip);
  (dbSkip as any).rpc = async (fn: string, args: Record<string, any>) => {
    if (fn === 'mark_vpn_client_panel_deleted') {
      return {
        data: [{
          applied: false,
          already_deleted: false,
          updated_accounts: 0,
          updated_configs: 0,
          reconciliation_required: false,
          unresolved_grant_count: 0,
          unresolved_grant_ids: [],
          audit_log_inserted: false,
          skip_reason: 'ownership_mismatch',
        }],
        error: null,
      };
    }
    return origSkipRpc(fn, args);
  };

  const resSkip = await verifyAndMarkClientDeletedIfConfirmed({
    clientUuid: 'uuid-skip',
    inboundId: 10,
    userId: uid,
    userEmail: email,
    recordPanelIdentity: PANEL_A_ID,
    createdAt: PAST_CREATED_AT,
    dbClient: dbSkip,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInbound: makeInboundFetcher([emptyIb]),
    fetchUncachedInboundsList: async () => buildListResult([emptyIb]),
    reReadDelayMs: 0,
  });
  assert.equal(resSkip.confirmedDeleted, false);
  assert.equal(resSkip.applied, false);
  assert.equal(resSkip.dbWrites, 0);
  assert.equal(resSkip.reason, 'rpc_skipped:ownership_mismatch');
  assert.equal(dbSkip.state.writeLog.length, 0);
});

// ---------------------------------------------------------------------------
// 10. Legacy customer configurations including CDN VLESS addresses
// ---------------------------------------------------------------------------
test('10. Legacy customer configs with CDN addresses never guess panel identity from hostnames/display names and backfill cleanly in single-panel deployments', async () => {
  const uid = 'user-legacy';
  const email = 'legacy-cdn@example.com';

  // 10a. Legacy CDN config with panel_identity=NULL, server_id=NULL, inbound_id=2 in single-panel deployment:
  // First seen live -> sync automatically backfills panel_identity without manual metadata edits
  const dbSinglePanel = createMockDb({
    vpn_accounts: [
      {
        id: 'acc-leg-cdn',
        user_id: uid,
        email,
        uuid: 'uuid-legacy-cdn',
        status: 'active',
        enable: true,
        server_id: null,
        server_name: 'Singapore CDN VIP',
        vless_url: 'vless://uuid-legacy-cdn@cdn.cloudflare.net:443?type=ws&security=tls&sni=zoom.us#SG-CDN',
        panel_identity: null,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-leg-cdn',
        customer_uid: uid,
        uuid: 'uuid-legacy-cdn',
        inbound_id: null, // Legacy config missing inbound_id too!
        server: 'Singapore CDN VIP',
        server_address: 'cdn.cloudflare.net',
        sni: 'zoom.us',
        vless_url: 'vless://uuid-legacy-cdn@cdn.cloudflare.net:443?type=ws&security=tls&sni=zoom.us#SG-CDN',
        status: 'active',
        enabled: true,
        panel_identity: null,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const liveClient = { id: 'uuid-legacy-cdn', email: 'leg_cdn', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 };
  const liveIb = makeInbound(2, [liveClient]);

  // Cycle 1: client is live -> panel_identity & inbound_id are backfilled automatically (no updated_at written to vpn_configs)
  const cycle1 = await syncDeleted3XUiClients({
    dbClient: dbSinglePanel,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [{ id: 'srv-a', panel_url: PANEL_A_URL, is_active: true }],
    fetchUncachedInboundsList: async () => buildListResult([liveIb]),
    fetchUncachedInbound: makeInboundFetcher([liveIb]),
    reReadDelayMs: 0,
  });
  assert.equal(cycle1.deletedCount, 0);
  assert.equal(dbSinglePanel.state.vpn_accounts[0].panel_identity, PANEL_A_ID);
  assert.equal(dbSinglePanel.state.vpn_configs[0].panel_identity, PANEL_A_ID);
  assert.equal(dbSinglePanel.state.vpn_configs[0].inbound_id, 2);
  assert.equal('updated_at' in dbSinglePanel.state.vpn_configs[0], false);

  // Cycle 2: client is now permanently deleted from 3X-UI -> deleted cleanly using explicit backfilled panel_identity + inbound_id
  const emptyIb = makeInbound(2, []);
  const cycle2 = await syncDeleted3XUiClients({
    dbClient: dbSinglePanel,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [{ id: 'srv-a', panel_url: PANEL_A_URL, is_active: true }],
    fetchUncachedInboundsList: async () => buildListResult([emptyIb]),
    fetchUncachedInbound: makeInboundFetcher([emptyIb]),
    reReadDelayMs: 0,
  });
  assert.equal(cycle2.deletedCount, 1);
  assert.equal(dbSinglePanel.state.vpn_accounts[0].status, 'deleted');
  assert.equal(dbSinglePanel.state.vpn_configs[0].status, 'deleted');

  // 10b. Legacy CDN config already deleted BEFORE ever being seen live, with inbound_id=2 in single-panel deployment
  const idResSingle = verifyRecordPanelIdentity({
    currentPanelIdentity: PANEL_A_ID,
    recordPanelIdentity: null,
    recordServerId: null,
    recordInboundId: 2,
    recordOwnerUid: uid,
    recordOwnerEmail: email,
    configuredServers: [{ id: 'srv-a', panel_url: PANEL_A_URL, is_active: true }],
  });
  assert.equal(idResSingle.ok, true);
  assert.equal(idResSingle.code, 'matched_single_panel_legacy');

  // 10c. Legacy CDN config WITHOUT inbound_id already absent from 3X-UI -> preserved safely (never guesses)
  const idResNoInbound = verifyRecordPanelIdentity({
    currentPanelIdentity: PANEL_A_ID,
    recordPanelIdentity: null,
    recordServerId: null,
    recordInboundId: null,
    recordOwnerUid: uid,
    recordOwnerEmail: email,
    configuredServers: [{ id: 'srv-a', panel_url: PANEL_A_URL, is_active: true }],
  });
  assert.equal(idResNoInbound.ok, false);
  assert.equal(idResNoInbound.code, 'missing_inbound_id');

  // 10d. Legacy CDN config with panel_identity=NULL, server_id=NULL in MULTI-PANEL deployment -> ambiguous (preserved, NEVER guessed from CDN hostname)
  const idResMulti = verifyRecordPanelIdentity({
    currentPanelIdentity: PANEL_A_ID,
    recordPanelIdentity: null,
    recordServerId: null,
    recordInboundId: 2,
    recordOwnerUid: uid,
    recordOwnerEmail: email,
    configuredServers: [
      { id: 'srv-a', panel_url: PANEL_A_URL, is_active: true },
      { id: 'srv-b', panel_url: PANEL_B_URL, is_active: true },
    ],
  });
  assert.equal(idResMulti.ok, false);
  assert.equal(idResMulti.code, 'ambiguous_panel_identity');
});

// ---------------------------------------------------------------------------
// 11. Strict ownership checks: conflicting customer_uid/user_id, duplicate UUID
//     across different customers, and missing user_id must perform ZERO writes
// ---------------------------------------------------------------------------
test('11. Conflicting customer_uid/user_id, duplicate UUID multi-owner, and missing user_id abort with manual review and zero writes', async () => {
  const emptyIb = makeInbound(2, []);
  const db = createMockDb({
    vpn_accounts: [
      { id: 'acc-dup', user_id: 'user-a', email: 'a@example.com', uuid: 'uuid-dup-owners', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-no-owner', user_id: null, email: 'orphan@example.com', uuid: 'uuid-no-owner', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-conflict', user_id: 'user-b', customer_uid: 'user-a', uuid: 'uuid-conflict', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-dup', user_id: 'user-b', customer_uid: 'user-b', uuid: 'uuid-dup-owners', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-no-owner', user_id: null, customer_uid: null, uuid: 'uuid-no-owner', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
  });

  const syncRes = await syncDeleted3XUiClients({
    dbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    fetchUncachedInboundsList: async () => buildListResult([emptyIb]),
    fetchUncachedInbound: makeInboundFetcher([emptyIb]),
    reReadDelayMs: 0,
  });

  assert.equal(syncRes.deletedCount, 0);
  assert.equal(syncRes.manualReviewCount, 3);
  assert.equal(db.state.vpn_accounts.find((a) => a.uuid === 'uuid-dup-owners')?.status, 'active');
  assert.equal(db.state.vpn_accounts.find((a) => a.uuid === 'uuid-no-owner')?.status, 'active');
  assert.equal(db.state.vpn_configs.find((c) => c.uuid === 'uuid-conflict')?.status, 'active');
  assert.equal(db.state.vpn_configs.find((c) => c.uuid === 'uuid-dup-owners')?.status, 'active');
  assert.equal(db.state.vpn_configs.find((c) => c.uuid === 'uuid-no-owner')?.status, 'active');

  // Direct verifyRecordPanelIdentity with email only (missing ownerUid) must also reject
  const idResNoUid = verifyRecordPanelIdentity({
    currentPanelIdentity: PANEL_A_ID,
    recordPanelIdentity: PANEL_A_ID,
    recordInboundId: 2,
    recordOwnerUid: null,
    recordOwnerEmail: 'orphan@example.com',
    configuredServers: [],
  });
  assert.equal(idResNoUid.ok, false);
  assert.equal(idResNoUid.code, 'missing_customer_ownership');
});

// ---------------------------------------------------------------------------
// 12. Client moved to another inbound -> NEVER deleted, NEVER auto-rewritten, manual review logged
// ---------------------------------------------------------------------------
test('12. Client moved to another inbound is NEVER marked deleted, inbound_id is NOT auto-rewritten, and mismatch is logged for manual review', async () => {
  const uid = 'user-moved';
  const email = 'moved@example.com';

  const db = createMockDb({
    vpn_accounts: [
      { id: 'acc-mv', user_id: uid, email, uuid: 'uuid-moved', status: 'active', enable: true, order_id: 'ord-mv', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-mv', user_id: uid, customer_uid: uid, uuid: 'uuid-moved', inbound_id: 10, status: 'active', enabled: true, order_id: 'ord-mv', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
  });

  // Client is absent from original inbound 10, but ACTIVE on inbound 20!
  const ib10 = makeInbound(10, []);
  const ib20 = makeInbound(20, [
    { id: 'uuid-moved', email: 'moved_cli', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
  ]);

  // 12a. Direct verifyAndMarkClientDeletedIfConfirmed MUST check panel-wide list and refuse deletion
  const directRes = await verifyAndMarkClientDeletedIfConfirmed({
    clientUuid: 'uuid-moved',
    inboundId: 10,
    userId: uid,
    userEmail: email,
    recordPanelIdentity: PANEL_A_ID,
    createdAt: PAST_CREATED_AT,
    dbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => buildListResult([ib10, ib20]),
    reReadDelayMs: 0,
  });
  assert.equal(directRes.confirmedDeleted, false);
  assert.equal(directRes.manualReviewFlagged, true);
  assert.equal(directRes.reason, 'read1_client_moved_to_another_inbound');
  assert.equal(directRes.dbWrites, 0);
  assert.equal(db.state.vpn_accounts[0].status, 'active');
  assert.equal(db.state.vpn_configs[0].status, 'active');
  assert.equal(db.state.vpn_configs[0].inbound_id, 10, 'Conflicting inbound_id MUST NOT be rewritten automatically');
  assert.ok(db.state.audit_logs.some((a) => a.action === 'panel_deletion_inbound_mismatch'));

  // 12b. Full background sweep also preserves client, does NOT rewrite inbound_id=10 to 20, and flags manual review
  const syncRes = await syncDeleted3XUiClients({
    dbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => buildListResult([ib10, ib20]),
    reReadDelayMs: 0,
  });
  assert.equal(syncRes.synced, true);
  assert.equal(syncRes.deletedCount, 0);
  assert.equal(syncRes.manualReviewCount, 1);
  assert.equal(db.state.vpn_accounts[0].status, 'active');
  assert.equal(db.state.vpn_configs[0].inbound_id, 10, 'Background sweep MUST NOT rewrite conflicting inbound_id');
});

// ---------------------------------------------------------------------------
// 13. Offline customers & non-selected VPNs swept + exact panel request budget (1 vs 2+K)
// ---------------------------------------------------------------------------
test('13. Background sweep covers offline customers and uses 1 panel call for 0 deletions and 2+K panel calls for K deletions', async () => {
  const db = createMockDb({
    vpn_accounts: [
      { id: 'acc-1', user_id: 'cust-online', email: 'c1@example.com', uuid: 'uuid-c1-live', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-2', user_id: 'cust-offline-a', email: 'c2@example.com', uuid: 'uuid-c2-live', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-3', user_id: 'cust-offline-b', email: 'c3@example.com', uuid: 'uuid-c3-del', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-4', user_id: 'cust-offline-c', email: 'c4@example.com', uuid: 'uuid-c4-del', status: 'disabled', enable: false, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-5', user_id: 'cust-offline-d', email: 'c5@example.com', uuid: 'uuid-c5-live', status: 'expired', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-6', user_id: 'cust-offline-e', email: 'c6@example.com', uuid: 'uuid-c6-live', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-7', user_id: 'cust-offline-f', email: 'c7@example.com', uuid: 'uuid-c7-live', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-8', user_id: 'cust-offline-g', email: 'c8@example.com', uuid: 'uuid-c8-live', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-9', user_id: 'cust-offline-h', email: 'c9@example.com', uuid: 'uuid-c9-live', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-10', user_id: 'cust-offline-i', email: 'c10@example.com', uuid: 'uuid-c10-live', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-1', customer_uid: 'cust-online', uuid: 'uuid-c1-live', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-2', customer_uid: 'cust-offline-a', uuid: 'uuid-c2-live', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-3', customer_uid: 'cust-offline-b', uuid: 'uuid-c3-del', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-4', customer_uid: 'cust-offline-c', uuid: 'uuid-c4-del', inbound_id: 3, status: 'disabled', enabled: false, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-5', customer_uid: 'cust-offline-d', uuid: 'uuid-c5-live', inbound_id: 3, status: 'expired', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-6', customer_uid: 'cust-offline-e', uuid: 'uuid-c6-live', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-7', customer_uid: 'cust-offline-f', uuid: 'uuid-c7-live', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-8', customer_uid: 'cust-offline-g', uuid: 'uuid-c8-live', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-9', customer_uid: 'cust-offline-h', uuid: 'uuid-c9-live', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-10', customer_uid: 'cust-offline-i', uuid: 'uuid-c10-live', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
  });

  // 13a. All 10 present -> 0 deletions, EXACTLY 1 panel request!
  let listCalls0 = 0;
  const allLiveIb2 = makeInbound(2, [
    { id: 'uuid-c1-live', email: 'c1', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
    { id: 'uuid-c2-live', email: 'c2', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
    { id: 'uuid-c3-del', email: 'c3', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
    { id: 'uuid-c6-live', email: 'c6', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
    { id: 'uuid-c7-live', email: 'c7', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
    { id: 'uuid-c8-live', email: 'c8', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
    { id: 'uuid-c9-live', email: 'c9', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
    { id: 'uuid-c10-live', email: 'c10', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
  ]);
  const allLiveIb3 = makeInbound(3, [
    { id: 'uuid-c4-del', email: 'c4', enable: false, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
    { id: 'uuid-c5-live', email: 'c5', enable: true, expiryTime: EXPIRED_EXPIRY_MS, totalGB: 0 },
  ]);

  const resZero = await syncDeleted3XUiClients({
    dbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => {
      listCalls0++;
      return buildListResult([allLiveIb2, allLiveIb3]);
    },
    reReadDelayMs: 0,
  });
  assert.equal(resZero.synced, true);
  assert.equal(resZero.deletedCount, 0);
  assert.equal(resZero.panelRequestCount, 1);
  assert.equal(listCalls0, 1, '0 deletion candidates MUST perform exactly 1 panel request');

  // 13b. K=2 offline customers deleted (20% <= 25%) -> EXACTLY 2 + 2 = 4 panel requests!
  let listCallsK = 0;
  const ib2After = makeInbound(2, [
    { id: 'uuid-c1-live', email: 'c1', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
    { id: 'uuid-c2-live', email: 'c2', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
    { id: 'uuid-c6-live', email: 'c6', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
    { id: 'uuid-c7-live', email: 'c7', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
    { id: 'uuid-c8-live', email: 'c8', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
    { id: 'uuid-c9-live', email: 'c9', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
    { id: 'uuid-c10-live', email: 'c10', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 },
  ]);
  const ib3After = makeInbound(3, [
    { id: 'uuid-c5-live', email: 'c5', enable: true, expiryTime: EXPIRED_EXPIRY_MS, totalGB: 0 },
  ]);

  const resTwo = await syncDeleted3XUiClients({
    dbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => {
      listCallsK++;
      return buildListResult([ib2After, ib3After]);
    },
    reReadDelayMs: 0,
  });
  assert.equal(resTwo.synced, true);
  assert.equal(resTwo.deletedCount, 2);
  assert.equal(resTwo.panelRequestCount, 4, 'K=2 deletions MUST perform exactly 2 + K = 4 panel requests');
  assert.equal(listCallsK, 4);
  assert.equal(db.state.vpn_accounts.find((a) => a.uuid === 'uuid-c3-del')?.status, 'deleted');
  assert.equal(db.state.vpn_accounts.find((a) => a.uuid === 'uuid-c4-del')?.status, 'deleted');
  assert.equal(db.state.vpn_accounts.find((a) => a.uuid === 'uuid-c5-live')?.status, 'expired');
});

// ---------------------------------------------------------------------------
// 14. Mass-Deletion Circuit Breaker (even when panel_identity matches!)
// ---------------------------------------------------------------------------
test('14. Mass-deletion circuit breaker stops ALL automatic deletions with zero locks even when panel_identity matches', async () => {
  const makePopulatedDb = (count: number) => {
    const accounts: any[] = [];
    const configs: any[] = [];
    for (let i = 1; i <= count; i++) {
      accounts.push({ id: `acc-${i}`, user_id: `u-${i}`, email: `u${i}@example.com`, uuid: `uuid-cb-${i}`, status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT });
      configs.push({ id: `cfg-${i}`, customer_uid: `u-${i}`, uuid: `uuid-cb-${i}`, inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT });
    }
    return createMockDb({ vpn_accounts: accounts, vpn_configs: configs });
  };

  // 14a. Unexpected zero live clients when >= 3 tracked (e.g. wiped/reset panel with same panel_identity)
  const dbZeroLive = makePopulatedDb(5);
  const resZeroLive = await syncDeleted3XUiClients({
    dbClient: dbZeroLive,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => buildListResult([makeInbound(2, [])]),
    reReadDelayMs: 0,
  });
  assert.equal(resZeroLive.synced, false);
  assert.equal(resZeroLive.circuitBreakerTriggered, true);
  assert.equal(resZeroLive.circuitBreakerReason, 'unexpected_zero_live_clients');
  assert.equal(resZeroLive.deletedCount, 0);
  assert.equal(dbZeroLive.state.rpcCalls.length, 0, 'Circuit breaker MUST stop before acquiring any locks or calling deletion RPC');
  assert.ok(dbZeroLive.state.vpn_accounts.every((a) => a.status === 'active'));
  assert.ok(dbZeroLive.state.audit_logs.some((a) => a.action === 'panel_deletion_circuit_breaker_triggered'));

  // 14b. Missing ratio > 25% on 10 tracked clients (4 missing = 40%, 6 still live)
  const dbRatio = makePopulatedDb(10);
  const sixLiveClients = [5, 6, 7, 8, 9, 10].map((i) => ({
    id: `uuid-cb-${i}`,
    email: `u${i}`,
    enable: true,
    expiryTime: FUTURE_EXPIRY_MS,
    totalGB: 0,
  }));
  const resRatio = await syncDeleted3XUiClients({
    dbClient: dbRatio,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => buildListResult([makeInbound(2, sixLiveClients)]),
    reReadDelayMs: 0,
  });
  assert.equal(resRatio.synced, false);
  assert.equal(resRatio.circuitBreakerTriggered, true);
  assert.equal(resRatio.circuitBreakerReason, 'max_missing_ratio_exceeded');
  assert.equal(resRatio.deletedCount, 0);
  assert.equal(dbRatio.state.rpcCalls.length, 0);
  assert.ok(dbRatio.state.vpn_accounts.every((a) => a.status === 'active'));

  // 14c. Absolute cap exceeded (> maxDeletesPerCycle = 2 on 20 tracked clients -> 3 missing = 15% <= 25% but 3 > 2!)
  const dbCap = makePopulatedDb(20);
  const seventeenLiveClients = Array.from({ length: 17 }, (_, idx) => ({
    id: `uuid-cb-${idx + 4}`,
    email: `u${idx + 4}`,
    enable: true,
    expiryTime: FUTURE_EXPIRY_MS,
    totalGB: 0,
  }));
  const resCap = await syncDeleted3XUiClients({
    dbClient: dbCap,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => buildListResult([makeInbound(2, seventeenLiveClients)]),
    maxDeletesPerCycle: 2,
    reReadDelayMs: 0,
  });
  assert.equal(resCap.synced, false);
  assert.equal(resCap.circuitBreakerTriggered, true);
  assert.equal(resCap.circuitBreakerReason, 'max_deletes_per_cycle_exceeded');
  assert.equal(resCap.deletedCount, 0);
  assert.equal(dbCap.state.rpcCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 15. Cross-Instance CAS Scheduler Lease Anti-Overlap (public.settings)
// ---------------------------------------------------------------------------
test('15. Cross-instance CAS lease prevents overlapping sweeps, enforces 2-minute interval across instances, recovers expired leases, and fails closed on DB error', async () => {
  const baseNow = Date.now();
  const db = createMockDb({
    vpn_accounts: [
      { id: 'acc-l1', user_id: 'u-1', email: 'u1@example.com', uuid: 'uuid-lease-live', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-l1', customer_uid: 'u-1', uuid: 'uuid-lease-live', inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
  });
  const liveIb = makeInbound(2, [{ id: 'uuid-lease-live', email: 'u1', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 }]);

  // 15a. Instance A runs and releases lease; Instance B within 2 minutes is skipped with 0 panel calls
  let callsA = 0;
  const resA = await syncDeleted3XUiClients({
    dbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    enforceCrossInstanceLease: true,
    leaseOwnerId: 'instance-A',
    intervalMs: 120000,
    nowMs: baseNow,
    fetchUncachedInboundsList: async () => {
      callsA++;
      return buildListResult([liveIb]);
    },
    reReadDelayMs: 0,
  });
  assert.equal(resA.synced, true);
  assert.equal(callsA, 1);

  let callsB = 0;
  const resB = await syncDeleted3XUiClients({
    dbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    enforceCrossInstanceLease: true,
    leaseOwnerId: 'instance-B',
    intervalMs: 120000,
    nowMs: baseNow + 60000, // Only 60s later (< 120s interval)
    fetchUncachedInboundsList: async () => {
      callsB++;
      return buildListResult([liveIb]);
    },
    reReadDelayMs: 0,
  });
  assert.equal(resB.synced, false);
  assert.equal(resB.skippedLease, true);
  assert.equal(resB.leaseSkipReason, 'cross_instance_interval_cooldown');
  assert.equal(callsB, 0);

  // 15b. Active unexpired lease held by another instance blocks acquisition; expired lease is lawfully taken over
  const leaseRow = db.state.settings.find((s) => s.id === 'panel_deletion_sync_lease');
  assert.ok(leaseRow);
  leaseRow.data = {
    ownerId: 'instance-C',
    status: 'running',
    startedAt: new Date(baseNow + 200000).toISOString(),
    leaseExpiresAt: new Date(baseNow + 400000).toISOString(),
    lastCompletedAt: null,
  };
  const activeBlock = await acquireCrossInstanceDeletionSyncLease({
    dbClient: db,
    intervalMs: 120000,
    nowMs: baseNow + 250000,
    ownerId: 'instance-D',
  });
  assert.equal(activeBlock.acquired, false);
  assert.match(String(activeBlock.reason), /^lease_held_by_active_instance:/);

  // After TTL expires (crashed worker), Instance D acquires cleanly via CAS
  const afterExpiry = await acquireCrossInstanceDeletionSyncLease({
    dbClient: db,
    intervalMs: 120000,
    nowMs: baseNow + 500000,
    ownerId: 'instance-D',
  });
  assert.equal(afterExpiry.acquired, true);
  assert.equal(afterExpiry.ownerId, 'instance-D');

  // Releasing with wrong ownerId MUST NOT release Instance D's lease
  const wrongRelease = await releaseCrossInstanceDeletionSyncLease({
    dbClient: db,
    ownerId: 'instance-C',
    completed: true,
    nowMs: baseNow + 501000,
  });
  assert.equal(wrongRelease, false);
  assert.equal(db.state.settings.find((s) => s.id === 'panel_deletion_sync_lease')?.data?.status, 'running');

  // Releasing with matching ownerId succeeds
  const rightRelease = await releaseCrossInstanceDeletionSyncLease({
    dbClient: db,
    ownerId: 'instance-D',
    completed: true,
    nowMs: baseNow + 502000,
  });
  assert.equal(rightRelease, true);
  assert.equal(db.state.settings.find((s) => s.id === 'panel_deletion_sync_lease')?.data?.status, 'idle');

  // 15c. DB error reading lease fails closed with 0 panel calls
  let errCalls = 0;
  const brokenDb = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: null, error: { message: 'connection refused' } }; },
      };
    },
  };
  const errRes = await syncDeleted3XUiClients({
    dbClient: brokenDb,
    currentPanelIdentity: PANEL_A_ID,
    enforceCrossInstanceLease: true,
    fetchUncachedInboundsList: async () => {
      errCalls++;
      return buildListResult([liveIb]);
    },
  });
  assert.equal(errRes.synced, false);
  assert.equal(errRes.skippedLease, true);
  assert.match(String(errRes.leaseSkipReason), /^lease_read_error:/);
  assert.equal(errCalls, 0);
});

// ---------------------------------------------------------------------------
// 16. Conflicting inbound_id, conflicting panel_identity, and missing inbound_id fail closed
// ---------------------------------------------------------------------------
test('16. Conflicting positive inbound_id, conflicting panel_identity, and legacy NULL inbound_id fail closed with zero deletion writes', async () => {
  const db = createMockDb({
    vpn_accounts: [
      { id: 'acc-cib', user_id: 'u-1', email: 'u1@example.com', uuid: 'uuid-conflict-ib', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-cpid', user_id: 'u-2', email: 'u2@example.com', uuid: 'uuid-conflict-pid', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-null-ib', user_id: 'u-3', email: 'u3@example.com', uuid: 'uuid-null-ib', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-cib', customer_uid: 'u-1', uuid: 'uuid-conflict-ib', inbound_id: 10, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-cpid', customer_uid: 'u-2', uuid: 'uuid-conflict-pid', inbound_id: 10, status: 'active', enabled: true, panel_identity: PANEL_B_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-null-ib', customer_uid: 'u-3', uuid: 'uuid-null-ib', inbound_id: null, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_entitlement_grants: [
      { id: 'g-cib', client_uuid: 'uuid-conflict-ib', inbound_id: 20, status: 'verified' },
    ],
  });

  const emptyIb = makeInbound(10, []);
  const syncRes = await syncDeleted3XUiClients({
    dbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => buildListResult([emptyIb]),
    reReadDelayMs: 0,
  });

  assert.equal(syncRes.deletedCount, 0);
  assert.equal(syncRes.manualReviewCount, 3);
  assert.equal(syncRes.panelRequestCount, 1, 'No eligible candidates -> finishes in 1 panel request with 0 locks');
  assert.equal(db.state.rpcCalls.length, 0);
  assert.ok(db.state.vpn_accounts.every((a) => a.status === 'active'));
  assert.ok(db.state.audit_logs.some((a) => a.action === 'panel_deletion_inbound_mismatch' && a.target_id === 'uuid-conflict-ib'));
});

// ---------------------------------------------------------------------------
// 17. Customer HTTP getMyConfigs NEVER triggers deletion sync or acquires deletion locks
// ---------------------------------------------------------------------------
test('17. Customer HTTP getMyConfigs makes ZERO deletion verification calls and ZERO deletion lock acquisitions even when PANEL_DELETION_SYNC_ENABLED=true', async () => {
  const uid = 'cust-http';
  const email = 'http@example.com';
  const db = createMockDb({
    vpn_accounts: [
      { id: 'acc-miss', user_id: uid, email, uuid: 'uuid-missing-not-yet-swept', status: 'active', enable: true, order_id: 'ord-1', vless_url: 'vless://uuid-missing-not-yet-swept@sg.example.com:443#A', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'acc-del', user_id: uid, email, uuid: 'uuid-already-deleted-by-bg', status: 'deleted', enable: false, deleted_from_panel_at: PAST_CREATED_AT, order_id: 'ord-2', vless_url: 'vless://uuid-already-deleted-by-bg@sg.example.com:443#B', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-miss', customer_uid: uid, uuid: 'uuid-missing-not-yet-swept', inbound_id: 2, status: 'active', enabled: true, order_id: 'ord-1', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'cfg-del', customer_uid: uid, uuid: 'uuid-already-deleted-by-bg', inbound_id: 2, status: 'deleted', enabled: false, deleted_from_panel_at: PAST_CREATED_AT, order_id: 'ord-2', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    orders: [
      { id: 'ord-1', order_id: 'ORD-1', customer_id: uid, email, status: 'completed', payment_status: 'Paid', client_uuid: 'uuid-missing-not-yet-swept', vless_url: 'vless://uuid-missing-not-yet-swept@sg.example.com:443#A' },
      { id: 'ord-2', order_id: 'ORD-2', customer_id: uid, email, status: 'completed', payment_status: 'Paid', client_uuid: 'uuid-already-deleted-by-bg', vless_url: 'vless://uuid-already-deleted-by-bg@sg.example.com:443#B' },
    ],
  });

  let verifyCalls = 0;
  const emptyIb = makeInbound(2, []);
  const res = await getMyConfigs(uid, email, undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [emptyIb],
    getLiveInboundFn: async () => emptyIb,
    getInboundsFn: async () => [emptyIb],
    verifyDeletedFn: async () => {
      verifyCalls++;
      return { confirmedDeleted: true, dbWrites: 1, reason: 'must_never_be_called' };
    },
  });

  assert.equal(verifyCalls, 0, 'getMyConfigs MUST NOT call verifyDeletedFn synchronously');
  assert.equal(db.state.rpcCalls.length, 0, 'getMyConfigs MUST acquire ZERO deletion locks');
  assert.equal(res.configs.length, 1);
  assert.equal(res.configs[0].uuid, 'uuid-missing-not-yet-swept');
  assert.deepEqual(res.deletedUuids, ['uuid-already-deleted-by-bg']);
});

// ---------------------------------------------------------------------------
// 18. Partial malformed inbound list (1 of 2 inbounds broken) -> ZERO deletions panel-wide
// ---------------------------------------------------------------------------
test('18. Partial malformed inbound list (1 malformed inbound alongside 1 valid inbound) performs ZERO deletions across all customers', async () => {
  const db = createMockDb({
    vpn_accounts: [
      { id: 'acc-1', user_id: 'u-1', email: 'u1@example.com', uuid: 'uuid-on-ib10', status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'cfg-1', customer_uid: 'u-1', uuid: 'uuid-on-ib10', inbound_id: 10, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
  });

  // Inbound 10 is cleanly parsed & empty, BUT inbound 20 has malformed JSON -> cannot prove panel-wide absence!
  const cleanEmptyIb10 = makeInbound(10, []);
  const brokenIb20 = makeInbound(20, [], { rawSettings: '{malformed-json' });

  const syncRes = await syncDeleted3XUiClients({
    dbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => buildListResult([cleanEmptyIb10, brokenIb20]),
    reReadDelayMs: 0,
  });

  assert.equal(syncRes.deletedCount, 0);
  assert.equal(db.state.rpcCalls.length, 0);
  assert.equal(db.state.vpn_accounts[0].status, 'active');
  assert.equal(syncRes.details?.[0]?.reason, 'malformed_inbound_settings_in_list');
});

// ---------------------------------------------------------------------------
// 19. Customer-scoped deletedUuids isolation: customer A never receives customer B's deleted UUIDs
// ---------------------------------------------------------------------------
test('19. Customer-scoped deletedUuids never leak across customers', async () => {
  const db = createMockDb({
    vpn_accounts: [
      { id: 'a1', user_id: 'cust-A', email: 'a@example.com', uuid: 'uuid-a-live', status: 'active', enable: true, order_id: 'oa-1', vless_url: 'vless://uuid-a-live@sg.example.com:443#A1', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'a2', user_id: 'cust-A', email: 'a@example.com', uuid: 'uuid-a-deleted', status: 'deleted', enable: false, deleted_from_panel_at: PAST_CREATED_AT, order_id: 'oa-2', vless_url: 'vless://uuid-a-deleted@sg.example.com:443#A2', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'b1', user_id: 'cust-B', email: 'b@example.com', uuid: 'uuid-b-deleted', status: 'deleted', enable: false, deleted_from_panel_at: PAST_CREATED_AT, order_id: 'ob-1', vless_url: 'vless://uuid-b-deleted@sg.example.com:443#B1', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    vpn_configs: [
      { id: 'c1', customer_uid: 'cust-A', uuid: 'uuid-a-live', inbound_id: 2, status: 'active', enabled: true, order_id: 'oa-1', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'c2', customer_uid: 'cust-A', uuid: 'uuid-a-deleted', inbound_id: 2, status: 'deleted', enabled: false, deleted_from_panel_at: PAST_CREATED_AT, order_id: 'oa-2', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
      { id: 'c3', customer_uid: 'cust-B', uuid: 'uuid-b-deleted', inbound_id: 2, status: 'deleted', enabled: false, deleted_from_panel_at: PAST_CREATED_AT, order_id: 'ob-1', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT },
    ],
    orders: [
      { id: 'oa-1', order_id: 'OA-1', customer_id: 'cust-A', email: 'a@example.com', status: 'completed', payment_status: 'Paid', client_uuid: 'uuid-a-live', vless_url: 'vless://uuid-a-live@sg.example.com:443#A1' },
      { id: 'oa-2', order_id: 'OA-2', customer_id: 'cust-A', email: 'a@example.com', status: 'completed', payment_status: 'Paid', client_uuid: 'uuid-a-deleted', vless_url: 'vless://uuid-a-deleted@sg.example.com:443#A2' },
      { id: 'ob-1', order_id: 'OB-1', customer_id: 'cust-B', email: 'b@example.com', status: 'completed', payment_status: 'Paid', client_uuid: 'uuid-b-deleted', vless_url: 'vless://uuid-b-deleted@sg.example.com:443#B1' },
    ],
  });

  const liveIb = makeInbound(2, [{ id: 'uuid-a-live', email: 'a@example.com', enable: true, expiryTime: FUTURE_EXPIRY_MS, totalGB: 0 }]);
  const resA = await getMyConfigs('cust-A', 'a@example.com', undefined, {
    dbClient: db,
    adminDbClient: db,
    currentPanelIdentity: PANEL_A_ID,
    getCachedInboundsFn: async () => [liveIb],
    getLiveInboundFn: async () => liveIb,
    getInboundsFn: async () => [liveIb],
  });

  assert.equal(resA.configs.length, 1);
  assert.equal(resA.configs[0].uuid, 'uuid-a-live');
  assert.deepEqual(resA.deletedUuids, ['uuid-a-deleted']);
  assert.equal(resA.deletedUuids.includes('uuid-b-deleted'), false, 'Customer A MUST NEVER receive Customer B deleted UUIDs');
});

// ---------------------------------------------------------------------------
// 20. Distributed Lease Renewal & Ownership Verification Before Every Deletion RPC
// ---------------------------------------------------------------------------
test('20. Distributed lease renews before each candidate, verifies ownership before every deletion RPC, aborts remaining sweep if lease expires or is stolen, and prevents old worker from overwriting new lease', async () => {
  const baseNow = Date.now();
  // Create 12 tracked clients (10 live, 2 deleted candidates: uuid-del-1 and uuid-del-2)
  const accounts: any[] = [];
  const configs: any[] = [];
  for (let i = 1; i <= 10; i++) {
    const u = `uuid-live-${i}`;
    accounts.push({ id: `acc-l-${i}`, user_id: `u-${i}`, email: `u${i}@example.com`, uuid: u, status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT });
    configs.push({ id: `cfg-l-${i}`, customer_uid: `u-${i}`, uuid: u, inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT });
  }
  for (let i = 1; i <= 2; i++) {
    const u = `uuid-del-${i}`;
    accounts.push({ id: `acc-d-${i}`, user_id: `ud-${i}`, email: `ud${i}@example.com`, uuid: u, status: 'active', enable: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT });
    configs.push({ id: `cfg-d-${i}`, customer_uid: `ud-${i}`, uuid: u, inbound_id: 2, status: 'active', enabled: true, panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT });
  }

  const tenLiveClients = Array.from({ length: 10 }, (_, idx) => ({
    id: `uuid-live-${idx + 1}`,
    email: `u${idx + 1}`,
    enable: true,
    expiryTime: FUTURE_EXPIRY_MS,
    totalGB: 0,
  }));

  // 20a. Normal sweep with 2 candidates renews leaseVersion before each candidate and completes both deletions
  const dbNormal = createMockDb({ vpn_accounts: accounts, vpn_configs: configs });
  const observedLeaseVersions = new Set<string>();
  const origFrom = dbNormal.from.bind(dbNormal);
  dbNormal.from = (table: string) => {
    const row = dbNormal.state.settings.find((s) => s.id === 'panel_deletion_sync_lease');
    if (row?.data?.leaseVersion) observedLeaseVersions.add(row.data.leaseVersion);
    return origFrom(table);
  };

  const resNormal = await syncDeleted3XUiClients({
    dbClient: dbNormal,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    enforceCrossInstanceLease: true,
    leaseOwnerId: 'worker-1',
    fetchUncachedInboundsList: async () => buildListResult([makeInbound(2, tenLiveClients)]),
    reReadDelayMs: 0,
  });
  assert.equal(resNormal.synced, true);
  assert.equal(resNormal.deletedCount, 2);
  // Initial acquire version + 2 candidate renewals + 1 release version -> >= 3 distinct versions observed
  assert.ok(observedLeaseVersions.size >= 3, `Expected >= 3 distinct leaseVersions, got ${observedLeaseVersions.size}`);

  // 20b. Lease stolen/expired mid-sweep (right before candidate 1's locked RPC) aborts candidate 1 RPC AND candidate 2,
  // and does NOT overwrite the newer worker's lease in the finally block!
  const dbStolen = createMockDb({ vpn_accounts: accounts, vpn_configs: configs });
  let listCallCount = 0;
  const resStolen = await syncDeleted3XUiClients({
    dbClient: dbStolen,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    enforceCrossInstanceLease: true,
    leaseOwnerId: 'worker-old',
    fetchUncachedInboundsList: async () => {
      listCallCount++;
      // Call 1 = Snapshot 1, Call 2 = Snapshot 2, Call 3 = Locked Read 2 for candidate 1.
      // Right during Locked Read 2 (before mark_vpn_client_panel_deleted RPC!), simulate lease takeover by worker-new!
      if (listCallCount === 3) {
        const leaseRow = dbStolen.state.settings.find((s) => s.id === 'panel_deletion_sync_lease');
        if (leaseRow) {
          leaseRow.data = {
            ...leaseRow.data,
            ownerId: 'worker-new',
            leaseVersion: 'ver-taken-over-by-new-worker',
            status: 'running',
            leaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
          };
        }
      }
      return buildListResult([makeInbound(2, tenLiveClients)]);
    },
    reReadDelayMs: 0,
  });

  assert.equal(resStolen.synced, false);
  assert.equal(resStolen.leaseLostMidSweep, true);
  assert.equal(resStolen.deletedCount, 0, 'Expired/stolen worker MUST NOT execute any deletion RPC');
  assert.equal(
    dbStolen.state.rpcCalls.filter((c) => c.fn === 'mark_vpn_client_panel_deleted').length,
    0,
    'mark_vpn_client_panel_deleted RPC must NEVER be called after lease ownership is lost'
  );
  assert.equal(listCallCount, 3, 'Candidate 2 must be aborted immediately without even running Locked Read 2');
  // Verify worker-new's lease was NOT released or overwritten by worker-old's finally block
  const survivingLease = dbStolen.state.settings.find((s) => s.id === 'panel_deletion_sync_lease');
  assert.equal(survivingLease?.data?.ownerId, 'worker-new');
  assert.equal(survivingLease?.data?.leaseVersion, 'ver-taken-over-by-new-worker');
  assert.equal(survivingLease?.data?.status, 'running');
});

// ---------------------------------------------------------------------------
// 21. Atomic Cryptographic leaseVersion CAS Protection (Even With Frozen updated_at Trigger)
// ---------------------------------------------------------------------------
test('21. Cryptographic leaseVersion CAS prevents race condition even when PostgreSQL updated_at trigger returns identical timestamp, and handles legacy rows without leaseVersion', async () => {
  const fixedNow = Date.now();
  // Freeze settings.updated_at to a constant timestamp to prove CAS does NOT rely solely on updated_at
  const db = createMockDb({
    freezeSettingsTriggerTimestamp: '2026-11-26T12:00:00.000Z',
    settings: [
      {
        id: 'panel_deletion_sync_lease',
        // Legacy row WITHOUT leaseVersion
        data: {
          ownerId: 'legacy-worker',
          status: 'idle',
          startedAt: new Date(fixedNow - 300000).toISOString(),
          leaseExpiresAt: null,
          lastCompletedAt: new Date(fixedNow - 300000).toISOString(),
          intervalMs: 120000,
        },
        updated_at: '2026-11-26T12:00:00.000Z',
      },
    ],
  });

  // 21a. Legacy row without leaseVersion upgrades cleanly to a cryptographic leaseVersion
  const acq1 = await acquireCrossInstanceDeletionSyncLease({
    dbClient: db,
    intervalMs: 120000,
    nowMs: fixedNow,
    ownerId: 'worker-A',
  });
  assert.equal(acq1.acquired, true);
  assert.ok(acq1.leaseVersion && acq1.leaseVersion.length >= 32, 'Must generate cryptographic leaseVersion');

  // 21b. Never renew with stale leaseVersion or wrong ownerId even if updated_at is identical
  const staleVersionRenew = await renewCrossInstanceDeletionSyncLease({
    dbClient: db,
    ownerId: 'worker-A',
    expectedLeaseVersion: 'stale-version-000',
    nowMs: fixedNow + 1000,
  });
  assert.equal(staleVersionRenew.renewed, false);
  assert.equal(staleVersionRenew.reason, 'lease_version_mismatch');

  const wrongOwnerRenew = await renewCrossInstanceDeletionSyncLease({
    dbClient: db,
    ownerId: 'worker-B',
    expectedLeaseVersion: acq1.leaseVersion,
    nowMs: fixedNow + 1000,
  });
  assert.equal(wrongOwnerRenew.renewed, false);
  assert.match(String(wrongOwnerRenew.reason), /^lease_owner_mismatch:/);

  // 21c. Valid renewal rotates leaseVersion atomically
  const validRenew = await renewCrossInstanceDeletionSyncLease({
    dbClient: db,
    ownerId: 'worker-A',
    expectedLeaseVersion: acq1.leaseVersion,
    nowMs: fixedNow + 5000,
    leaseTtlMs: 180000,
  });
  assert.equal(validRenew.renewed, true);
  assert.notEqual(validRenew.leaseVersion, acq1.leaseVersion, 'Renewal must rotate leaseVersion');

  // 21d. Never renew an already-expired lease
  const expiredRenew = await renewCrossInstanceDeletionSyncLease({
    dbClient: db,
    ownerId: 'worker-A',
    expectedLeaseVersion: validRenew.leaseVersion,
    nowMs: fixedNow + 250000, // Past 180s TTL
  });
  assert.equal(expiredRenew.renewed, false);
  assert.equal(expiredRenew.reason, 'lease_already_expired');

  // 21e. Expired lease is taken over by worker-B; stale worker-A cannot release or overwrite worker-B
  const takeover = await acquireCrossInstanceDeletionSyncLease({
    dbClient: db,
    intervalMs: 120000,
    nowMs: fixedNow + 250000,
    ownerId: 'worker-B',
  });
  assert.equal(takeover.acquired, true);
  assert.equal(takeover.ownerId, 'worker-B');

  const staleRelease = await releaseCrossInstanceDeletionSyncLease({
    dbClient: db,
    ownerId: 'worker-A',
    expectedLeaseVersion: validRenew.leaseVersion,
    completed: true,
    nowMs: fixedNow + 251000,
  });
  assert.equal(staleRelease, false);

  const staleVerify = await verifyCrossInstanceDeletionSyncLeaseOwnership({
    dbClient: db,
    ownerId: 'worker-A',
    expectedLeaseVersion: validRenew.leaseVersion,
    nowMs: fixedNow + 251000,
  });
  assert.equal(staleVerify.valid, false);
});

// ---------------------------------------------------------------------------
// 22. Complete Deterministic Cursor Pagination (>1,000 and >2,500 Records + Short Server Cap)
// ---------------------------------------------------------------------------
test('22. Deterministic PK cursor pagination loads >1,000 and >2,500 records even when server enforces a 400-row cap, handles duplicates/conflicts, and aborts on page failure', async () => {
  // Build 2,600 customer records (with serverMaxRows = 400, smaller than requested pageSize = 1000!)
  // Include 2 permanently deleted clients at the very end (index 2599 and 2600, well past row 1,000 and 2,500),
  // 1 duplicate UUID with conflicting inbound_id (index 2550), and 2,597 live clients.
  const TOTAL_RECORDS = 2600;
  const accounts: any[] = [];
  const configs: any[] = [];
  const grants: any[] = [];
  const liveClients: any[] = [];

  for (let i = 1; i <= TOTAL_RECORDS; i++) {
    const padded = String(i).padStart(5, '0');
    const uuid = `uuid-pag-${padded}`;
    const uid = `user-pag-${padded}`;

    accounts.push({
      id: `acc-pag-${padded}`,
      user_id: uid,
      email: `${uid}@example.com`,
      uuid,
      status: 'active',
      enable: true,
      panel_identity: PANEL_A_ID,
      created_at: PAST_CREATED_AT,
    });
    configs.push({
      id: `cfg-pag-${padded}`,
      customer_uid: uid,
      uuid,
      inbound_id: 2,
      status: 'active',
      enabled: true,
      panel_identity: PANEL_A_ID,
      created_at: PAST_CREATED_AT,
    });
    grants.push({
      id: `grt-pag-${padded}`,
      client_uuid: uuid,
      inbound_id: i === 2550 ? 99 : 2, // Conflicting inbound_id on record #2550
      status: 'verified',
    });

    // Keep all clients live EXCEPT #2550 (conflicting inbound_id, missing from panel), #2599, and #2600 (genuinely deleted)
    if (i !== 2550 && i !== 2599 && i !== 2600) {
      liveClients.push({
        id: uuid,
        email: `${uid}@example.com`,
        enable: true,
        expiryTime: FUTURE_EXPIRY_MS,
        totalGB: 0,
      });
    }
  }

  // Add a duplicate vpn_configs row for #2599 with same owner & same inbound_id (valid duplicate)
  configs.push({
    id: 'cfg-pag-99999-dup',
    customer_uid: 'user-pag-02599',
    uuid: 'uuid-pag-02599',
    inbound_id: 2,
    status: 'active',
    enabled: true,
    panel_identity: PANEL_A_ID,
    created_at: PAST_CREATED_AT,
  });

  // Enforce serverMaxRows: 400 while sync requests pageSize: 1000 -> proves short pages do NOT stop pagination early!
  const dbPaginated = createMockDb({
    serverMaxRows: 400,
    vpn_accounts: accounts,
    vpn_configs: configs,
    vpn_entitlement_grants: grants,
  });

  const syncRes = await syncDeleted3XUiClients({
    dbClient: dbPaginated,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    pageSize: 1000,
    fetchUncachedInboundsList: async () => buildListResult([makeInbound(2, liveClients)]),
    reReadDelayMs: 0,
  });

  assert.equal(syncRes.synced, true);
  assert.equal(syncRes.deletedCount, 2, 'Records #2599 and #2600 beyond row 2,500 must be detected and deleted');
  assert.equal(syncRes.manualReviewCount, 1, 'Conflicting inbound_id record #2550 must be flagged for manual review');

  const acc2550 = dbPaginated.state.vpn_accounts.find((a) => a.uuid === 'uuid-pag-02550');
  const acc2599 = dbPaginated.state.vpn_accounts.find((a) => a.uuid === 'uuid-pag-02599');
  const acc2600 = dbPaginated.state.vpn_accounts.find((a) => a.uuid === 'uuid-pag-02600');
  assert.equal(acc2550?.status, 'active', 'Conflicting record #2550 must fail closed and stay active');
  assert.equal(acc2599?.status, 'deleted', 'Record #2599 must be marked deleted');
  assert.equal(acc2600?.status, 'deleted', 'Record #2600 must be marked deleted');

  // 22b. Mid-pagination failure on page 3 aborts the entire sweep with zero deletions
  let pageCallCount = 0;
  const failingPageDb = {
    from(table: string) {
      const b = dbPaginated.from(table);
      if (table === 'vpn_configs') {
        const origThen = b.then.bind(b);
        b.then = (resolve: any, reject: any) => {
          pageCallCount++;
          if (pageCallCount === 3) {
            return Promise.resolve({ data: null, error: { message: 'page_3_connection_reset' } }).then(resolve, reject);
          }
          return origThen(resolve, reject);
        };
      }
      return b;
    },
    rpc: dbPaginated.rpc.bind(dbPaginated),
  };

  const failRes = await syncDeleted3XUiClients({
    dbClient: failingPageDb,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    pageSize: 1000,
    fetchUncachedInboundsList: async () => buildListResult([makeInbound(2, liveClients)]),
    reReadDelayMs: 0,
  });
  assert.equal(failRes.synced, false);
  assert.equal(failRes.deletedCount, 0);
});

// ---------------------------------------------------------------------------
// 23. Final Locked Snapshot Mass-Absence Circuit Breaker Protection
// ---------------------------------------------------------------------------
test('23. Final locked full-panel snapshot enforces mass-absence circuit breaker (zero live clients, max count, max ratio) and aborts remaining sweep with zero RPC calls', async () => {
  // Populate 10 tracked non-deleted clients (including active, disabled, and expired configs).
  // Suppose 2 clients (uuid-m-1, uuid-m-2) are absent in Snapshot 1 and Snapshot 2 (2/10 = 20% <= 25%, passes outer check).
  // Then during candidate 1's final locked Read 2, the panel suddenly drops all clients (or 5 clients = 50% > 25%)!
  const makeTenClientsDb = () => {
    const accs: any[] = [];
    const cfgs: any[] = [];
    const statuses = ['active', 'disabled', 'expired'];
    for (let i = 1; i <= 10; i++) {
      const u = `uuid-m-${i}`;
      const st = statuses[i % statuses.length];
      accs.push({ id: `am-${i}`, user_id: `um-${i}`, email: `um${i}@example.com`, uuid: u, status: st, enable: st === 'active', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT });
      cfgs.push({ id: `cm-${i}`, customer_uid: `um-${i}`, uuid: u, inbound_id: 2, status: st, enabled: st === 'active', panel_identity: PANEL_A_ID, created_at: PAST_CREATED_AT });
    }
    return createMockDb({ vpn_accounts: accs, vpn_configs: cfgs });
  };

  const eightLiveClients = Array.from({ length: 8 }, (_, idx) => ({
    id: `uuid-m-${idx + 3}`,
    email: `um${idx + 3}`,
    enable: true,
    expiryTime: FUTURE_EXPIRY_MS,
    totalGB: 0,
  }));

  // 23a. Final locked snapshot returns 0 live clients (unexpected_zero_live_clients) -> aborts remaining sweep!
  const dbZero = makeTenClientsDb();
  let callNumZero = 0;
  const resZero = await syncDeleted3XUiClients({
    dbClient: dbZero,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => {
      callNumZero++;
      // Calls 1 & 2 (Snapshot 1 & 2): 8 live clients present (only uuid-m-1 & uuid-m-2 missing)
      if (callNumZero <= 2) {
        return buildListResult([makeInbound(2, eightLiveClients)]);
      }
      // Call 3 (Locked Read 2 for candidate 1): panel suddenly returns 0 live clients!
      return buildListResult([makeInbound(2, [])]);
    },
    reReadDelayMs: 0,
  });

  assert.equal(resZero.synced, false);
  assert.equal(resZero.circuitBreakerTriggered, true);
  assert.equal(resZero.circuitBreakerReason, 'unexpected_zero_live_clients');
  assert.equal(resZero.deletedCount, 0);
  assert.equal(callNumZero, 3, 'Must abort entire remaining sweep after candidate 1 locked read trips circuit breaker');
  assert.equal(
    dbZero.state.rpcCalls.filter((c) => c.fn === 'mark_vpn_client_panel_deleted').length,
    0,
    'Zero deletion RPCs may execute when locked Read 2 trips circuit breaker'
  );
  // Locks acquired for candidate 1 must be finalized cleanly as failed (never left in_progress or uncertain)
  assert.equal(dbZero.state.locks.get('client:uuid-m-1')?.status, 'failed');
  assert.equal(dbZero.state.locks.get('inbound:2')?.status, 'failed');

  // 23b. Final locked snapshot exceeds maxMissingRatio (5 of 10 missing = 50% > 25%) -> aborts remaining sweep!
  const dbRatio = makeTenClientsDb();
  const fiveLiveClients = eightLiveClients.slice(0, 5);
  let callNumRatio = 0;
  const resRatio = await syncDeleted3XUiClients({
    dbClient: dbRatio,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    fetchUncachedInboundsList: async () => {
      callNumRatio++;
      if (callNumRatio <= 2) {
        return buildListResult([makeInbound(2, eightLiveClients)]);
      }
      return buildListResult([makeInbound(2, fiveLiveClients)]);
    },
    reReadDelayMs: 0,
  });

  assert.equal(resRatio.synced, false);
  assert.equal(resRatio.circuitBreakerTriggered, true);
  assert.equal(resRatio.circuitBreakerReason, 'max_missing_ratio_exceeded');
  assert.equal(resRatio.deletedCount, 0);
  assert.equal(callNumRatio, 3);
  assert.equal(dbRatio.state.rpcCalls.filter((c) => c.fn === 'mark_vpn_client_panel_deleted').length, 0);

  // 23c. Final locked snapshot exceeds maxDeletesPerCycle (1 missing in Snapshots 1 & 2 with maxDeletesPerCycle=1, then 2 missing in locked Read 2) -> aborts!
  const dbCount = makeTenClientsDb();
  const nineLiveClients = Array.from({ length: 9 }, (_, idx) => ({
    id: `uuid-m-${idx + 2}`,
    email: `um${idx + 2}`,
    enable: true,
    expiryTime: FUTURE_EXPIRY_MS,
    totalGB: 0,
  }));
  let callNumCount = 0;
  const resCount = await syncDeleted3XUiClients({
    dbClient: dbCount,
    currentPanelIdentity: PANEL_A_ID,
    configuredServers: [],
    maxDeletesPerCycle: 1,
    fetchUncachedInboundsList: async () => {
      callNumCount++;
      if (callNumCount <= 2) {
        return buildListResult([makeInbound(2, nineLiveClients)]);
      }
      return buildListResult([makeInbound(2, eightLiveClients)]);
    },
    reReadDelayMs: 0,
  });

  assert.equal(resCount.synced, false);
  assert.equal(resCount.circuitBreakerTriggered, true);
  assert.equal(resCount.circuitBreakerReason, 'max_deletes_per_cycle_exceeded');
  assert.equal(resCount.deletedCount, 0);
  assert.equal(callNumCount, 3);
  assert.equal(dbCount.state.rpcCalls.filter((c) => c.fn === 'mark_vpn_client_panel_deleted').length, 0);
});
