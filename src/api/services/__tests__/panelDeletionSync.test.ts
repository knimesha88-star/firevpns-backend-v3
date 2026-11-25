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

interface MockDbState {
  vpn_accounts: any[];
  vpn_configs: any[];
  orders: any[];
  vpn_entitlement_grants: any[];
  provisioning_operations: any[];
  profiles: any[];
  audit_logs: any[];
  xui_servers: any[];
  locks: Map<string, { ownerId: string; status: 'in_progress' | 'completed' | 'failed' | 'uncertain'; operationType: string }>;
  rpcCalls: Array<{ fn: string; args: Record<string, any> }>;
  writeLog: Array<{ table: string; op: 'update' | 'insert'; payload: Record<string, any> }>;
}

function createMockDb(initial?: Partial<MockDbState>) {
  const state: MockDbState = {
    vpn_accounts: initial?.vpn_accounts ? structuredClone(initial.vpn_accounts) : [],
    vpn_configs: initial?.vpn_configs ? structuredClone(initial.vpn_configs) : [],
    orders: initial?.orders ? structuredClone(initial.orders) : [],
    vpn_entitlement_grants: initial?.vpn_entitlement_grants ? structuredClone(initial.vpn_entitlement_grants) : [],
    provisioning_operations: initial?.provisioning_operations ? structuredClone(initial.provisioning_operations) : [],
    profiles: initial?.profiles ? structuredClone(initial.profiles) : [],
    audit_logs: initial?.audit_logs ? structuredClone(initial.audit_logs) : [],
    xui_servers: initial?.xui_servers ? structuredClone(initial.xui_servers) : [],
    locks: initial?.locks ? new Map(initial.locks) : new Map(),
    rpcCalls: [],
    writeLog: [],
  };

  const matchFilters = (row: any, filters: Array<{ op: string; col: string; val: any }>) => {
    for (const f of filters) {
      const rv = row?.[f.col];
      if (f.op === 'eq' && rv !== f.val) return false;
      if (f.op === 'ilike' && String(rv || '').toLowerCase() !== String(f.val || '').toLowerCase()) return false;
      if (f.op === 'in' && !(Array.isArray(f.val) && f.val.includes(rv))) return false;
      if (f.op === 'gte' && !(rv && String(rv) >= String(f.val))) return false;
      if (f.op === 'not_null' && (rv === null || rv === undefined)) return false;
    }
    return true;
  };

  const makeBuilder = (table: keyof MockDbState) => {
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
        // Guardrail assertion: vpn_configs does NOT have an updated_at column in production schema!
        if (table === 'vpn_configs' && 'updated_at' in updatePayload) {
          return {
            data: null,
            error: { message: 'column "updated_at" of relation "vpn_configs" does not exist' },
          };
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
      ilike(col: string, val: any) { filters.push({ op: 'ilike', col, val }); return builder; },
      in(col: string, val: any[]) { filters.push({ op: 'in', col, val }); return builder; },
      gte(col: string, val: any) { filters.push({ op: 'gte', col, val }); return builder; },
      not(col: string, op: string, val: any) {
        if (op === 'is' && val === null) filters.push({ op: 'not_null', col, val: null });
        return builder;
      },
      limit(n: number) { limitCount = n; return builder; },
      maybeSingle() { singleMode = true; return execute(); },
      update(payload: Record<string, any>) { updatePayload = payload; return builder; },
      insert(payload: Record<string, any>) { insertPayload = payload; return execute(); },
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

  // 5e. Two-read verification: absent on Read 1, reappears on Read 2 -> ZERO writes
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
    fetchUncachedInbound: async () => {
      readCallCount++;
      if (readCallCount === 1) {
        return { status: 'found', inbound: makeInbound(10, []), clients: [], clientUuidSet: new Set() };
      }
      const c = { id: 'uuid-safe', email, enable: true, limitIp: 0, totalGB: 0, expiryTime: FUTURE_EXPIRY_MS, subId: '', reset: 0 };
      return { status: 'found', inbound: makeInbound(10, [c]), clients: [c], clientUuidSet: new Set(['uuid-safe']) };
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


