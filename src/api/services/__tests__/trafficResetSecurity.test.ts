import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyQuotaText,
  classifyNumericQuotaBytes,
  evaluateCustomerTrafficResetEligibility,
  resetVpnTraffic,
  getResetTrafficStatus,
  clearTrafficResetLogsForTest,
  TRAFFIC_RESET_UNLIMITED_ONLY_MESSAGE,
  TrafficResetLog,
  TrafficResetPolicy,
} from '../vpnService.js';
import { pathToFileURL } from 'node:url';
import { resetClientTraffic, XuiInbound } from '../xuiService.js';

async function loadFrontendVpnStatus() {
  const modPath = pathToFileURL(path.resolve('src/lib/vpnStatus.ts')).href;
  return import(modPath) as Promise<{
    isVpnConfigTrafficResetEligible: (config: Record<string, any>) => boolean;
  }>;
}

const FUTURE_MS = Date.now() + 20 * 24 * 60 * 60 * 1000;
const PAST_MS = Date.now() - 2 * 24 * 60 * 60 * 1000;
const FUTURE_ISO = new Date(FUTURE_MS).toISOString();
const PAST_ISO = new Date(PAST_MS).toISOString();

const GB = 1024 ** 3;

const DEFAULT_POLICY: TrafficResetPolicy = {
  enabled: true,
  cooldownHours: 24,
  maxResetsPerBillingPeriod: 1,
  allowTrialReset: false,
};

interface MockLock {
  operation_key: string;
  lock_owner_id: string;
  status: 'in_progress' | 'completed' | 'failed' | 'uncertain';
  operation_type: string;
}

function createResetMockDb(initial?: {
  vpn_accounts?: any[];
  vpn_configs?: any[];
  orders?: any[];
  vpn_entitlement_grants?: any[];
  provisioning_operations?: MockLock[];
}) {
  const state = {
    vpn_accounts: initial?.vpn_accounts ? structuredClone(initial.vpn_accounts) : [],
    vpn_configs: initial?.vpn_configs ? structuredClone(initial.vpn_configs) : [],
    orders: initial?.orders ? structuredClone(initial.orders) : [],
    vpn_entitlement_grants: initial?.vpn_entitlement_grants ? structuredClone(initial.vpn_entitlement_grants) : [],
    provisioning_operations: initial?.provisioning_operations ? structuredClone(initial.provisioning_operations) : [],
    settings: [] as any[],
    rpcCalls: [] as Array<{ fn: string; args: Record<string, any> }>,
  };

  const matchFilters = (row: any, filters: Array<{ op: string; col: string; val: any }>) => {
    for (const f of filters) {
      const rv = row?.[f.col];
      if (f.op === 'eq' && rv !== f.val) return false;
      if (f.op === 'ilike' && String(rv || '').toLowerCase() !== String(f.val || '').toLowerCase()) return false;
      if (f.op === 'in' && !(Array.isArray(f.val) && f.val.includes(rv))) return false;
    }
    return true;
  };

  const makeBuilder = (table: keyof typeof state) => {
    const filters: Array<{ op: string; col: string; val: any }> = [];
    let updatePayload: Record<string, any> | null = null;
    let singleMode = false;

    const execute = async () => {
      const rows = (state[table] as any[]) || [];
      if (updatePayload) {
        const matched = rows.filter((r) => matchFilters(r, filters));
        for (const r of matched) Object.assign(r, updatePayload);
        return { data: singleMode ? matched[0] || null : matched, error: null };
      }
      const matched = rows.filter((r) => matchFilters(r, filters));
      return { data: singleMode ? matched[0] || null : matched, error: null };
    };

    const builder: any = {
      select() { return builder; },
      order() { return builder; },
      eq(col: string, val: any) { filters.push({ op: 'eq', col, val }); return builder; },
      ilike(col: string, val: any) { filters.push({ op: 'ilike', col, val }); return builder; },
      in(col: string, val: any[]) { filters.push({ op: 'in', col, val }); return builder; },
      limit() { return builder; },
      maybeSingle() { singleMode = true; return execute(); },
      update(payload: Record<string, any>) { updatePayload = payload; return builder; },
      then(resolve: any, reject: any) { return execute().then(resolve, reject); },
    };
    return builder;
  };

  const getLockRow = (key: string) => state.provisioning_operations.find((r) => r.operation_key === key);

  const dbClient: any = {
    state,
    getLockRow,
    from(table: string) {
      return makeBuilder(table as keyof typeof state);
    },
    async rpc(fn: string, args: Record<string, any>) {
      state.rpcCalls.push({ fn, args: structuredClone(args) });
      if (fn === 'acquire_provisioning_lock') {
        const key = String(args.p_operation_key);
        const existing = getLockRow(key);
        if (existing && existing.status === 'in_progress' && existing.lock_owner_id !== args.p_lock_owner_id) {
          return { data: [{ acquired: false, previous_status: 'in_progress', holder_owner_id: existing.lock_owner_id }], error: null };
        }
        if (existing && existing.status === 'uncertain' && args.p_allow_uncertain_recovery !== true) {
          return { data: [{ acquired: false, previous_status: 'uncertain', holder_owner_id: existing.lock_owner_id }], error: null };
        }
        if (existing) {
          existing.lock_owner_id = String(args.p_lock_owner_id);
          existing.status = 'in_progress';
          existing.operation_type = String(args.p_operation_type);
        } else {
          state.provisioning_operations.push({
            operation_key: key,
            lock_owner_id: String(args.p_lock_owner_id),
            status: 'in_progress',
            operation_type: String(args.p_operation_type),
          });
        }
        return { data: [{ acquired: true, holder_owner_id: args.p_lock_owner_id }], error: null };
      }
      if (fn === 'renew_provisioning_lock') {
        const existing = getLockRow(String(args.p_operation_key));
        return { data: Boolean(existing && existing.status === 'in_progress' && existing.lock_owner_id === args.p_lock_owner_id), error: null };
      }
      if (fn === 'release_provisioning_lock') {
        const existing = getLockRow(String(args.p_operation_key));
        if (!existing || existing.status !== 'in_progress' || existing.lock_owner_id !== args.p_lock_owner_id) {
          return { data: false, error: null };
        }
        existing.status = args.p_status;
        return { data: true, error: null };
      }
      return { data: null, error: { message: `Unknown RPC ${fn}` } };
    },
  };
  return dbClient;
}

function makeLiveInbound(id: number, client: any, stat?: any, inboundEnable = true): XuiInbound {
  return {
    id,
    up: 0,
    down: 0,
    total: 0,
    remark: `Inbound-${id}`,
    enable: inboundEnable,
    expiryTime: 0,
    clientStats: stat ? [stat] : [],
    port: 443,
    protocol: 'vless',
    settings: JSON.stringify({ clients: client ? [client] : [] }),
    streamSettings: '{}',
    tag: `inbound-${id}`,
    sniffing: '{}',
  };
}

function makeUnlimitedRecords(overrides?: {
  uuid?: string;
  userId?: string;
  email?: string;
  packageName?: string;
  dataLimit?: string;
  totalGB?: number;
  statTotal?: number;
  clientEnable?: boolean;
  expiryTime?: number;
}) {
  const uuid = overrides?.uuid || 'uuid-unlim-1';
  const userId = overrides?.userId || 'user-unlim-1';
  const email = overrides?.email || 'unlim@example.com';
  const packageName = overrides?.packageName || 'SIM Unlimited 1 Month';
  const dataLimit = overrides?.dataLimit ?? 'Unlimited';
  const totalGB = overrides?.totalGB ?? 0;
  const statTotal = overrides?.statTotal ?? 0;
  const clientEnable = overrides?.clientEnable ?? true;
  const expiryTime = overrides?.expiryTime ?? FUTURE_MS;

  const vpnAccount: Record<string, any> = {
    id: 'va-1',
    user_id: userId,
    email,
    uuid,
    order_id: 'ord-1',
    status: 'active',
    enable: true,
    expiry_date: new Date(expiryTime).toISOString(),
    package_name: packageName,
    data_limit: dataLimit,
    is_trial: false,
    created_at: PAST_ISO,
  };
  const vpnConfig: Record<string, any> = {
    id: 'vc-1',
    customer_uid: userId,
    uuid,
    order_id: 'ord-1',
    inbound_id: 2,
    status: 'active',
    enabled: true,
    package_name: packageName,
    data_limit: dataLimit,
    created_at: PAST_ISO,
  };
  const order: Record<string, any> = {
    id: 'ord-1',
    order_id: 'ORD-1',
    customer_id: userId,
    email,
    client_uuid: uuid,
    status: 'completed',
    payment_status: 'Paid',
    provisioning_status: 'completed',
    package_name: packageName,
    plan: packageName,
    data_limit: dataLimit,
    created_at: PAST_ISO,
  };
  const liveClient = {
    id: uuid,
    email: 'xui_unlim_1',
    enable: clientEnable,
    totalGB,
    expiryTime,
    up: 2 * GB,
    down: 3 * GB,
  };
  const liveStat = {
    id: 1,
    inboundId: 2,
    email: 'xui_unlim_1',
    enable: clientEnable,
    up: 2 * GB,
    down: 3 * GB,
    total: statTotal,
    expiryTime,
    reset: 0,
  };
  const liveInbound = makeLiveInbound(2, liveClient, liveStat, true);
  return { uuid, userId, email, vpnAccount, vpnConfig, order, liveClient, liveStat, liveInbound };
}

test.beforeEach(() => {
  clearTrafficResetLogsForTest();
});

// 1-4: Quota text & numeric classification hardening
test('TR-01: classifyQuotaText recognizes explicit unlimited strings and finite GB/TB strings', () => {
  assert.equal(classifyQuotaText('Unlimited'), 'unlimited');
  assert.equal(classifyQuotaText('SIM Unlimited'), 'unlimited');
  assert.equal(classifyQuotaText('Router Unlimited 1 Month'), 'unlimited');
  assert.equal(classifyQuotaText('100 GB'), 'finite');
  assert.equal(classifyQuotaText('200GB'), 'finite');
  assert.equal(classifyQuotaText('1 TB'), 'finite');
  assert.equal(classifyQuotaText('SIM 100GB'), 'finite');
});

test('TR-02: classifyQuotaText NEVER treats null, undefined, empty, negative, or garbage strings as unlimited', () => {
  assert.equal(classifyQuotaText(null), 'unknown');
  assert.equal(classifyQuotaText(undefined), 'unknown');
  assert.equal(classifyQuotaText(''), 'unknown');
  assert.equal(classifyQuotaText('   '), 'unknown');
  assert.equal(classifyQuotaText('null'), 'invalid');
  assert.equal(classifyQuotaText('-1'), 'invalid');
  assert.equal(classifyQuotaText('-100 GB'), 'invalid');
  assert.equal(classifyQuotaText(true), 'invalid');
  assert.equal(classifyQuotaText(NaN), 'invalid');
});

test('TR-03: classifyQuotaText rejects conflicting strings that mention both unlimited and finite GB', () => {
  assert.equal(classifyQuotaText('Unlimited 100 GB'), 'finite');
  assert.equal(classifyQuotaText('SIM Unlimited (200GB cap)'), 'finite');
});

test('TR-04: classifyNumericQuotaBytes requires strict 0 with allowZeroAsUnlimited and rejects null/empty/negative/NaN/positive', () => {
  assert.equal(classifyNumericQuotaBytes(0), 'unknown');
  assert.equal(classifyNumericQuotaBytes(0, { allowZeroAsUnlimited: true }), 'unlimited');
  assert.equal(classifyNumericQuotaBytes(100 * GB, { allowZeroAsUnlimited: true }), 'finite');
  assert.equal(classifyNumericQuotaBytes(null, { allowZeroAsUnlimited: true }), 'unknown');
  assert.equal(classifyNumericQuotaBytes(undefined, { allowZeroAsUnlimited: true }), 'unknown');
  assert.equal(classifyNumericQuotaBytes('', { allowZeroAsUnlimited: true }), 'unknown');
  assert.equal(classifyNumericQuotaBytes(-1, { allowZeroAsUnlimited: true }), 'invalid');
  assert.equal(classifyNumericQuotaBytes(NaN, { allowZeroAsUnlimited: true }), 'invalid');
});

// 5-16: Core eligibility evaluator matrix
test('TR-05: SIM Unlimited active verified config is eligible', () => {
  const f = makeUnlimitedRecords({ packageName: 'SIM Unlimited 1 Month', dataLimit: 'Unlimited' });
  const res = evaluateCustomerTrafficResetEligibility({
    vpnAccount: f.vpnAccount,
    vpnConfig: f.vpnConfig,
    orders: [f.order],
    grants: [],
    ownershipSource: 'vpn_accounts',
    panelReachable: true,
    liveInbound: f.liveInbound,
    liveClient: f.liveClient,
    liveStat: f.liveStat,
  });
  assert.equal(res.eligible, true);
  assert.equal(res.isUnlimitedPlan, true);
});

test('TR-06: Router Unlimited active verified config is eligible', () => {
  const f = makeUnlimitedRecords({ packageName: 'Router Unlimited 1 Month', dataLimit: 'Unlimited' });
  const res = evaluateCustomerTrafficResetEligibility({
    vpnAccount: f.vpnAccount,
    vpnConfig: f.vpnConfig,
    orders: [f.order],
    grants: [],
    ownershipSource: 'vpn_accounts',
    panelReachable: true,
    liveInbound: f.liveInbound,
    liveClient: f.liveClient,
    liveStat: f.liveStat,
  });
  assert.equal(res.eligible, true);
  assert.equal(res.isUnlimitedPlan, true);
});

test('TR-07: 100 GB finite package is blocked with 403', () => {
  const f = makeUnlimitedRecords({ packageName: 'SIM 100 GB', dataLimit: '100 GB', totalGB: 100 * GB, statTotal: 100 * GB });
  const res = evaluateCustomerTrafficResetEligibility({
    vpnAccount: f.vpnAccount,
    vpnConfig: f.vpnConfig,
    orders: [f.order],
    grants: [],
    ownershipSource: 'vpn_accounts',
    panelReachable: true,
    liveInbound: f.liveInbound,
    liveClient: f.liveClient,
    liveStat: f.liveStat,
  });
  assert.equal(res.eligible, false);
  assert.equal(res.httpStatus, 403);
  assert.equal(res.customerMessage, TRAFFIC_RESET_UNLIMITED_ONLY_MESSAGE);
});

test('TR-08: 200 GB and future 500 GB / 1 TB finite packages are blocked with 403', () => {
  for (const [pkg, gb] of [['Router 200 GB', 200], ['SIM 500 GB', 500], ['Enterprise 1 TB', 1024]] as const) {
    const f = makeUnlimitedRecords({ packageName: pkg, dataLimit: `${gb} GB`, totalGB: gb * GB, statTotal: gb * GB });
    const res = evaluateCustomerTrafficResetEligibility({
      vpnAccount: f.vpnAccount,
      vpnConfig: f.vpnConfig,
      orders: [f.order],
      grants: [],
      ownershipSource: 'vpn_accounts',
      panelReachable: true,
      liveInbound: f.liveInbound,
      liveClient: f.liveClient,
      liveStat: f.liveStat,
    });
    assert.equal(res.eligible, false, `${pkg} must be blocked`);
    assert.equal(res.httpStatus, 403);
  }
});

test('TR-09: Package name claiming Unlimited while 3X-UI has positive totalGB > 0 is blocked (do not trust name alone)', () => {
  const f = makeUnlimitedRecords({ packageName: 'SIM Unlimited', dataLimit: 'Unlimited', totalGB: 100 * GB, statTotal: 100 * GB });
  const res = evaluateCustomerTrafficResetEligibility({
    vpnAccount: f.vpnAccount,
    vpnConfig: f.vpnConfig,
    orders: [f.order],
    grants: [],
    ownershipSource: 'vpn_accounts',
    panelReachable: true,
    liveInbound: f.liveInbound,
    liveClient: f.liveClient,
    liveStat: f.liveStat,
  });
  assert.equal(res.eligible, false);
  assert.equal(res.httpStatus, 403);
});

test('TR-10: 3X-UI totalGB === 0 while DB entitlement says 100 GB is blocked', () => {
  const f = makeUnlimitedRecords({ packageName: 'SIM 100 GB', dataLimit: '100 GB', totalGB: 0, statTotal: 0 });
  const res = evaluateCustomerTrafficResetEligibility({
    vpnAccount: f.vpnAccount,
    vpnConfig: f.vpnConfig,
    orders: [f.order],
    grants: [],
    ownershipSource: 'vpn_accounts',
    panelReachable: true,
    liveInbound: f.liveInbound,
    liveClient: f.liveClient,
    liveStat: f.liveStat,
  });
  assert.equal(res.eligible, false);
  assert.equal(res.httpStatus, 403);
});

test('TR-11: Free trial is unconditionally blocked even when 3X-UI totalGB === 0', () => {
  const f = makeUnlimitedRecords({ packageName: 'Free Trial 3 Days', dataLimit: 'Unlimited', totalGB: 0, statTotal: 0 });
  f.vpnAccount.is_trial = true;
  const res = evaluateCustomerTrafficResetEligibility({
    vpnAccount: f.vpnAccount,
    vpnConfig: f.vpnConfig,
    orders: [f.order],
    grants: [],
    ownershipSource: 'vpn_accounts',
    panelReachable: true,
    liveInbound: f.liveInbound,
    liveClient: f.liveClient,
    liveStat: f.liveStat,
  });
  assert.equal(res.eligible, false);
  assert.equal(res.httpStatus, 403);
});

test('TR-12: Expired unlimited config is blocked', () => {
  const f = makeUnlimitedRecords({ expiryTime: PAST_MS });
  const res = evaluateCustomerTrafficResetEligibility({
    vpnAccount: f.vpnAccount,
    vpnConfig: f.vpnConfig,
    orders: [f.order],
    grants: [],
    ownershipSource: 'vpn_accounts',
    panelReachable: true,
    liveInbound: f.liveInbound,
    liveClient: f.liveClient,
    liveStat: f.liveStat,
  });
  assert.equal(res.eligible, false);
});

test('TR-13: Disabled unlimited config (client enable=false or inbound enable=false) is blocked', () => {
  const f = makeUnlimitedRecords({ clientEnable: false });
  const res = evaluateCustomerTrafficResetEligibility({
    vpnAccount: f.vpnAccount,
    vpnConfig: f.vpnConfig,
    orders: [f.order],
    grants: [],
    ownershipSource: 'vpn_accounts',
    panelReachable: true,
    liveInbound: f.liveInbound,
    liveClient: f.liveClient,
    liveStat: f.liveStat,
  });
  assert.equal(res.eligible, false);

  const f2 = makeUnlimitedRecords({ clientEnable: true });
  f2.liveInbound.enable = false;
  const res2 = evaluateCustomerTrafficResetEligibility({
    vpnAccount: f2.vpnAccount,
    vpnConfig: f2.vpnConfig,
    orders: [f2.order],
    grants: [],
    ownershipSource: 'vpn_accounts',
    panelReachable: true,
    liveInbound: f2.liveInbound,
    liveClient: f2.liveClient,
    liveStat: f2.liveStat,
  });
  assert.equal(res2.eligible, false);
});

test('TR-14: Rejected, revoked, or deleted unlimited config is blocked', () => {
  const fDel = makeUnlimitedRecords();
  fDel.vpnAccount.status = 'deleted';
  fDel.vpnAccount.deleted_from_panel_at = PAST_ISO;
  assert.equal(
    evaluateCustomerTrafficResetEligibility({
      vpnAccount: fDel.vpnAccount,
      vpnConfig: fDel.vpnConfig,
      orders: [fDel.order],
      grants: [],
      ownershipSource: 'vpn_accounts',
      panelReachable: true,
      liveInbound: fDel.liveInbound,
      liveClient: fDel.liveClient,
      liveStat: fDel.liveStat,
    }).eligible,
    false
  );

  const fRej = makeUnlimitedRecords();
  fRej.order.status = 'rejected';
  fRej.order.payment_status = 'Rejected';
  assert.equal(
    evaluateCustomerTrafficResetEligibility({
      vpnAccount: fRej.vpnAccount,
      vpnConfig: fRej.vpnConfig,
      orders: [fRej.order],
      grants: [],
      ownershipSource: 'vpn_accounts',
      panelReachable: true,
      liveInbound: fRej.liveInbound,
      liveClient: fRej.liveClient,
      liveStat: fRej.liveStat,
    }).eligible,
    false
  );
});

test('TR-15: Panel unreachable / unverified or pure 3X-UI fallback (no DB record) is blocked', () => {
  const f = makeUnlimitedRecords();
  const resOffline = evaluateCustomerTrafficResetEligibility({
    vpnAccount: f.vpnAccount,
    vpnConfig: f.vpnConfig,
    orders: [f.order],
    grants: [],
    ownershipSource: 'vpn_accounts',
    panelReachable: false,
    liveInbound: null,
    liveClient: null,
    liveStat: null,
  });
  assert.equal(resOffline.eligible, false);

  const resFallback = evaluateCustomerTrafficResetEligibility({
    vpnAccount: null,
    vpnConfig: null,
    orders: [],
    grants: [],
    ownershipSource: '3xui',
    panelReachable: true,
    liveInbound: f.liveInbound,
    liveClient: f.liveClient,
    liveStat: f.liveStat,
  });
  assert.equal(resFallback.eligible, false);
});

test('TR-16: Missing/null/empty DB entitlement metadata with 3X-UI totalGB === 0 fails closed (never defaults to unlimited)', () => {
  const f = makeUnlimitedRecords({ packageName: 'Standard VPN', dataLimit: '', totalGB: 0, statTotal: 0 });
  f.vpnAccount.data_limit = null;
  f.vpnConfig.data_limit = null;
  f.order.data_limit = null;
  const res = evaluateCustomerTrafficResetEligibility({
    vpnAccount: f.vpnAccount,
    vpnConfig: f.vpnConfig,
    orders: [f.order],
    grants: [],
    ownershipSource: 'vpn_accounts',
    panelReachable: true,
    liveInbound: f.liveInbound,
    liveClient: f.liveClient,
    liveStat: f.liveStat,
  });
  assert.equal(res.eligible, false);
  assert.equal(res.httpStatus, 403);
});

// 17-20: Historical vs current entitlements & unresolved renewals
test('TR-17: Customer upgraded from old 100GB order/config to newer verified SIM Unlimited grant is ALLOWED', () => {
  const f = makeUnlimitedRecords({ packageName: 'SIM Unlimited 1 Month', dataLimit: 'Unlimited', totalGB: 0, statTotal: 0 });
  const oldIso = new Date(Date.now() - 60 * 86400000).toISOString();
  const newIso = new Date(Date.now() - 1 * 86400000).toISOString();
  const oldFiniteOrder = {
    ...f.order,
    id: 'ord-old',
    package_name: 'SIM 100 GB',
    data_limit: '100 GB',
    created_at: oldIso,
  };
  const newerUnlimitedGrant = {
    id: 'grant-new',
    client_uuid: f.uuid,
    grant_type: 'renewal',
    status: 'verified',
    package_name: 'SIM Unlimited 1 Month',
    granted_unlimited: true,
    granted_total_bytes: 0,
    created_at: newIso,
    updated_at: newIso,
  };
  const res = evaluateCustomerTrafficResetEligibility({
    vpnAccount: f.vpnAccount,
    vpnConfig: { ...f.vpnConfig, package_name: 'SIM 100 GB', data_limit: '100 GB', created_at: oldIso },
    orders: [oldFiniteOrder],
    grants: [newerUnlimitedGrant],
    ownershipSource: 'vpn_accounts',
    panelReachable: true,
    liveInbound: f.liveInbound,
    liveClient: f.liveClient,
    liveStat: f.liveStat,
  });
  assert.equal(res.eligible, true);
});

test('TR-18: Customer downgraded from old Unlimited order to newer verified 200GB grant is BLOCKED', () => {
  const f = makeUnlimitedRecords({ packageName: 'SIM Unlimited', dataLimit: 'Unlimited', totalGB: 0, statTotal: 0 });
  const newerFiniteGrant = {
    id: 'grant-fin',
    client_uuid: f.uuid,
    grant_type: 'renewal',
    status: 'verified',
    package_name: 'SIM 200 GB',
    granted_unlimited: false,
    granted_total_bytes: 200 * GB,
    created_at: new Date(Date.now() - 1 * 86400000).toISOString(),
    updated_at: new Date(Date.now() - 1 * 86400000).toISOString(),
  };
  const res = evaluateCustomerTrafficResetEligibility({
    vpnAccount: f.vpnAccount,
    vpnConfig: f.vpnConfig,
    orders: [f.order],
    grants: [newerFiniteGrant],
    ownershipSource: 'vpn_accounts',
    panelReachable: true,
    liveInbound: f.liveInbound,
    liveClient: f.liveClient,
    liveStat: f.liveStat,
  });
  assert.equal(res.eligible, false);
  assert.equal(res.httpStatus, 403);
});

test('TR-19: Unresolved provisional/uncertain/provisioning renewal grant blocks traffic reset', () => {
  for (const st of ['provisional', 'provisioning', 'uncertain', 'revoke_failed']) {
    const f = makeUnlimitedRecords();
    const res = evaluateCustomerTrafficResetEligibility({
      vpnAccount: f.vpnAccount,
      vpnConfig: f.vpnConfig,
      orders: [f.order],
      grants: [{ id: 'g-u', client_uuid: f.uuid, grant_type: 'renewal', status: st, created_at: PAST_ISO }],
      ownershipSource: 'vpn_accounts',
      panelReachable: true,
      liveInbound: f.liveInbound,
      liveClient: f.liveClient,
      liveStat: f.liveStat,
    });
    assert.equal(res.eligible, false, `Status ${st} must block reset`);
  }
});

test('TR-20: Conflicting negative live totalGB or missing client in live inbound blocks reset', () => {
  const fNeg = makeUnlimitedRecords({ totalGB: -10 });
  assert.equal(
    evaluateCustomerTrafficResetEligibility({
      vpnAccount: fNeg.vpnAccount,
      vpnConfig: fNeg.vpnConfig,
      orders: [fNeg.order],
      grants: [],
      ownershipSource: 'vpn_accounts',
      panelReachable: true,
      liveInbound: fNeg.liveInbound,
      liveClient: fNeg.liveClient,
      liveStat: fNeg.liveStat,
    }).eligible,
    false
  );

  const fMissing = makeUnlimitedRecords();
  assert.equal(
    evaluateCustomerTrafficResetEligibility({
      vpnAccount: fMissing.vpnAccount,
      vpnConfig: fMissing.vpnConfig,
      orders: [fMissing.order],
      grants: [],
      ownershipSource: 'vpn_accounts',
      panelReachable: true,
      liveInbound: fMissing.liveInbound,
      liveClient: null,
      liveStat: null,
    }).eligible,
    false
  );
});

// 21-28: End-to-end resetVpnTraffic & xuiService.resetClientTraffic security, locking & concurrency
test('TR-21: resetVpnTraffic succeeds for eligible SIM Unlimited with 1 3X-UI POST and records cooldown log', async () => {
  const f = makeUnlimitedRecords({ packageName: 'SIM Unlimited 1 Month', dataLimit: 'Unlimited' });
  const db = createResetMockDb({ vpn_accounts: [f.vpnAccount], vpn_configs: [f.vpnConfig], orders: [f.order] });
  const logs: TrafficResetLog[] = [];
  let xuiResetCalls = 0;

  const res = await resetVpnTraffic(f.userId, f.email, f.uuid, {
    dbClient: db,
    requireDurableLock: true,
    skipNotification: true,
    skipUsedBytesUpdate: true,
    getTrafficResetPolicyFn: async () => DEFAULT_POLICY,
    getTrafficResetLogsFn: async () => logs,
    recordTrafficResetLogFn: async (l) => { logs.push(l); },
    getLiveInboundFn: async () => f.liveInbound,
    getInboundsFn: async () => [f.liveInbound],
    resetClientTrafficFn: (email, inboundId, uuid, opts) =>
      resetClientTraffic(email, inboundId, uuid, {
        ...opts,
        dbClient: db,
        requireDurableLock: true,
        requestApiFn: async <T>(endpoint: string) => {
          if (endpoint.includes('resetTraffic') || endpoint.includes('resetClientTraffic')) xuiResetCalls++;
          return { success: true } as T;
        },
      }),
  });

  assert.equal(res.success, true);
  assert.equal(xuiResetCalls, 1);
  assert.equal(logs.length, 1);
  assert.equal(db.getLockRow(`client:${f.uuid}`)?.status, 'completed');
  assert.equal(db.getLockRow('inbound:2')?.status, 'completed');
});

test('TR-22: resetVpnTraffic blocks 100GB finite package before acquiring locks and makes ZERO 3X-UI POSTs', async () => {
  const f = makeUnlimitedRecords({ packageName: 'SIM 100 GB', dataLimit: '100 GB', totalGB: 100 * GB, statTotal: 100 * GB });
  const db = createResetMockDb({ vpn_accounts: [f.vpnAccount], vpn_configs: [f.vpnConfig], orders: [f.order] });
  let xuiResetCalls = 0;

  await assert.rejects(
    () =>
      resetVpnTraffic(f.userId, f.email, f.uuid, {
        dbClient: db,
        requireDurableLock: true,
        skipNotification: true,
        getTrafficResetPolicyFn: async () => DEFAULT_POLICY,
        getTrafficResetLogsFn: async () => [],
        getLiveInboundFn: async () => f.liveInbound,
        getInboundsFn: async () => [f.liveInbound],
        resetClientTrafficFn: async () => {
          xuiResetCalls++;
          return { success: true, message: 'should_not_run' };
        },
      }),
    (err: any) => err.status === 403 && err.message === TRAFFIC_RESET_UNLIMITED_ONLY_MESSAGE
  );

  assert.equal(xuiResetCalls, 0);
  assert.equal(db.state.rpcCalls.length, 0);
});

test('TR-23: resetVpnTraffic blocks Free Trial even when admin policy.allowTrialReset=true', async () => {
  const f = makeUnlimitedRecords({ packageName: 'Free Trial', dataLimit: 'Unlimited' });
  f.vpnAccount.is_trial = true;
  const db = createResetMockDb({ vpn_accounts: [f.vpnAccount], vpn_configs: [f.vpnConfig], orders: [f.order] });
  let xuiResetCalls = 0;

  await assert.rejects(
    () =>
      resetVpnTraffic(f.userId, f.email, f.uuid, {
        dbClient: db,
        requireDurableLock: true,
        skipNotification: true,
        getTrafficResetPolicyFn: async () => ({ ...DEFAULT_POLICY, allowTrialReset: true }),
        getTrafficResetLogsFn: async () => [],
        getLiveInboundFn: async () => f.liveInbound,
        getInboundsFn: async () => [f.liveInbound],
        resetClientTrafficFn: async () => {
          xuiResetCalls++;
          return { success: true, message: 'should_not_run' };
        },
      }),
    (err: any) => err.status === 403
  );
  assert.equal(xuiResetCalls, 0);
});

test('TR-24: Cross-customer ownership bypass is blocked with 403 and zero 3X-UI calls', async () => {
  const f = makeUnlimitedRecords({ userId: 'victim-uid', email: 'victim@example.com' });
  const db = createResetMockDb({ vpn_accounts: [f.vpnAccount], vpn_configs: [f.vpnConfig], orders: [f.order] });
  let xuiResetCalls = 0;

  await assert.rejects(
    () =>
      resetVpnTraffic('attacker-uid', 'attacker@example.com', f.uuid, {
        dbClient: db,
        requireDurableLock: true,
        skipNotification: true,
        getTrafficResetPolicyFn: async () => DEFAULT_POLICY,
        getTrafficResetLogsFn: async () => [],
        getLiveInboundFn: async () => f.liveInbound,
        getInboundsFn: async () => [f.liveInbound],
        resetClientTrafficFn: async () => {
          xuiResetCalls++;
          return { success: true, message: 'should_not_run' };
        },
      }),
    (err: any) => err.status === 403 || err.status === 404
  );
  assert.equal(xuiResetCalls, 0);
});

test('TR-25: Quota changed from unlimited to 100GB between pre-check and locked verification aborts cleanly without uncertain lock', async () => {
  const f = makeUnlimitedRecords({ packageName: 'SIM Unlimited', dataLimit: 'Unlimited', totalGB: 0, statTotal: 0 });
  const db = createResetMockDb({ vpn_accounts: [f.vpnAccount], vpn_configs: [f.vpnConfig], orders: [f.order] });
  let inboundFetchCount = 0;
  let xuiResetCalls = 0;

  await assert.rejects(
    () =>
      resetVpnTraffic(f.userId, f.email, f.uuid, {
        dbClient: db,
        requireDurableLock: true,
        skipNotification: true,
        getTrafficResetPolicyFn: async () => DEFAULT_POLICY,
        getTrafficResetLogsFn: async () => [],
        getLiveInboundFn: async () => {
          inboundFetchCount++;
          if (inboundFetchCount === 1) return f.liveInbound;
          // Inside locks, fresh 3X-UI read reveals package is now finite 100 GB!
          return makeLiveInbound(2, { ...f.liveClient, totalGB: 100 * GB }, { ...f.liveStat, total: 100 * GB }, true);
        },
        getInboundsFn: async () => [f.liveInbound],
        resetClientTrafficFn: (email, inboundId, uuid, opts) =>
          resetClientTraffic(email, inboundId, uuid, {
            ...opts,
            dbClient: db,
            requireDurableLock: true,
            requestApiFn: async <T>() => {
              xuiResetCalls++;
              return { success: true } as T;
            },
          }),
      }),
    (err: any) => err.status === 403
  );

  assert.equal(xuiResetCalls, 0, 'Locked re-verification MUST abort before 3X-UI POST');
  assert.equal(db.getLockRow(`client:${f.uuid}`)?.status, 'failed', 'Pre-mutation rejection MUST NOT create uncertain lock');
  assert.equal(db.getLockRow('inbound:2')?.status, 'failed', 'Pre-mutation rejection MUST NOT create uncertain lock');
});

test('TR-26: Lost lock lease immediately before 3X-UI mutation aborts BEFORE POST', async () => {
  const f = makeUnlimitedRecords();
  const db = createResetMockDb({ vpn_accounts: [f.vpnAccount], vpn_configs: [f.vpnConfig], orders: [f.order] });
  const origRpc = db.rpc.bind(db);
  let renewCalls = 0;
  db.rpc = async (fn: string, args: Record<string, any>) => {
    if (fn === 'renew_provisioning_lock') {
      renewCalls++;
      // Fail the pre-mutation dual lease recheck
      if (renewCalls >= 2) return { data: false, error: null };
    }
    return origRpc(fn, args);
  };
  let xuiResetCalls = 0;

  await assert.rejects(
    () =>
      resetClientTraffic(f.liveClient.email, 2, f.uuid, {
        dbClient: db,
        requireDurableLock: true,
        beforeResetUnderLocks: async () => {},
        requestApiFn: async <T>() => {
          xuiResetCalls++;
          return { success: true } as T;
        },
      })
  );

  assert.equal(xuiResetCalls, 0, 'Lost lease MUST abort before dispatching 3X-UI reset POST');
});

test('TR-27: Concurrent double traffic-reset requests cannot bypass cooldown (1 succeeds, 1 rejected with 429)', async () => {
  const f = makeUnlimitedRecords({ uuid: 'uuid-conc-reset' });
  const db = createResetMockDb({ vpn_accounts: [f.vpnAccount], vpn_configs: [f.vpnConfig], orders: [f.order] });
  const logs: TrafficResetLog[] = [];
  let xuiResetCalls = 0;

  const runOne = () =>
    resetVpnTraffic(f.userId, f.email, f.uuid, {
      dbClient: db,
      requireDurableLock: true,
      skipNotification: true,
      skipUsedBytesUpdate: true,
      getTrafficResetPolicyFn: async () => DEFAULT_POLICY,
      getTrafficResetLogsFn: async () => [...logs],
      recordTrafficResetLogFn: async (l) => { logs.push(l); },
      getLiveInboundFn: async () => f.liveInbound,
      getInboundsFn: async () => [f.liveInbound],
      resetClientTrafficFn: (email, inboundId, uuid, opts) =>
        resetClientTraffic(email, inboundId, uuid, {
          ...opts,
          dbClient: db,
          requireDurableLock: true,
          requestApiFn: async <T>() => {
            await new Promise((r) => setTimeout(r, 25));
            xuiResetCalls++;
            return { success: true } as T;
          },
        }),
    });

  const results = await Promise.allSettled([runOne(), runOne()]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.equal(fulfilled.length, 1, 'Exactly one concurrent reset should succeed');
  assert.equal(rejected.length, 1, 'Second concurrent reset must be blocked by cooldown/lock');
  assert.equal(xuiResetCalls, 1, '3X-UI reset POST must execute exactly once');
});

test('TR-28: Rejected pre-mutation reset (policy disabled / cooldown) leaves zero uncertain locks', async () => {
  const f = makeUnlimitedRecords({ uuid: 'uuid-cool-1' });
  const db = createResetMockDb({ vpn_accounts: [f.vpnAccount], vpn_configs: [f.vpnConfig], orders: [f.order] });
  const recentMs = Date.now() - 1000;
  const recentLog: TrafficResetLog = {
    id: 'log-1',
    userId: f.userId,
    userEmail: f.email,
    configUuid: f.uuid,
    clientEmail: f.liveClient.email,
    inboundId: 2,
    resetTimestamp: new Date(recentMs).toISOString(),
    resetTimestampMs: recentMs,
    upBytesBefore: 2 * GB,
    downBytesBefore: 3 * GB,
    totalBytesBefore: 5 * GB,
    status: 'success',
  };
  let xuiResetCalls = 0;

  await assert.rejects(
    () =>
      resetVpnTraffic(f.userId, f.email, f.uuid, {
        dbClient: db,
        requireDurableLock: true,
        skipNotification: true,
        getTrafficResetPolicyFn: async () => DEFAULT_POLICY,
        getTrafficResetLogsFn: async () => [recentLog],
        getLiveInboundFn: async () => f.liveInbound,
        getInboundsFn: async () => [f.liveInbound],
        resetClientTrafficFn: async () => {
          xuiResetCalls++;
          return { success: true, message: 'should_not_run' };
        },
      }),
    (err: any) => err.status === 429
  );
  assert.equal(xuiResetCalls, 0);
  assert.equal(db.state.provisioning_operations.some((l: MockLock) => l.status === 'uncertain'), false);
});

// 29-32: Route wiring, status endpoint, and frontend visibility parity
test('TR-29: Both POST /api/vpn/reset-traffic and POST /api/vpn/reset-data routes sit behind authMiddleware and map to hardened resetTraffic', () => {
  const routesSrc = fs.readFileSync(path.resolve('backend/src/api/routes/vpnRoutes.ts'), 'utf8');
  const authIdx = routesSrc.indexOf('router.use(authMiddleware)');
  const resetTrafficIdx = routesSrc.indexOf("router.post('/reset-traffic', resetTraffic)");
  const resetDataIdx = routesSrc.indexOf("router.post('/reset-data', resetTraffic)");
  assert.ok(authIdx !== -1, 'authMiddleware must protect customer VPN routes');
  assert.ok(resetTrafficIdx > authIdx, '/reset-traffic must be mounted after authMiddleware');
  assert.ok(resetDataIdx > authIdx, '/reset-data must be mounted after authMiddleware');
});

test('TR-30: getResetTrafficStatus reports eligible=true for unlimited and eligible=false for limited packages', async () => {
  const fUnlim = makeUnlimitedRecords({ uuid: 'uuid-st-unlim', packageName: 'Router Unlimited', dataLimit: 'Unlimited' });
  const dbUnlim = createResetMockDb({ vpn_accounts: [fUnlim.vpnAccount], vpn_configs: [fUnlim.vpnConfig], orders: [fUnlim.order] });
  const stUnlim = await getResetTrafficStatus(fUnlim.userId, fUnlim.email, fUnlim.uuid, {
    dbClient: dbUnlim,
    getTrafficResetPolicyFn: async () => DEFAULT_POLICY,
    getTrafficResetLogsFn: async () => [],
    getLiveInboundFn: async () => fUnlim.liveInbound,
    getInboundsFn: async () => [fUnlim.liveInbound],
  });
  assert.equal(stUnlim.canReset, true);
  assert.equal(stUnlim.eligibleForTrafficReset, true);

  const fLim = makeUnlimitedRecords({ uuid: 'uuid-st-lim', packageName: 'SIM 100 GB', dataLimit: '100 GB', totalGB: 100 * GB, statTotal: 100 * GB });
  const dbLim = createResetMockDb({ vpn_accounts: [fLim.vpnAccount], vpn_configs: [fLim.vpnConfig], orders: [fLim.order] });
  const stLim = await getResetTrafficStatus(fLim.userId, fLim.email, fLim.uuid, {
    dbClient: dbLim,
    getTrafficResetPolicyFn: async () => DEFAULT_POLICY,
    getTrafficResetLogsFn: async () => [],
    getLiveInboundFn: async () => fLim.liveInbound,
    getInboundsFn: async () => [fLim.liveInbound],
  });
  assert.equal(stLim.canReset, false);
  assert.equal(stLim.eligibleForTrafficReset, false);
});

test('TR-31: Frontend isVpnConfigTrafficResetEligible hides button for limited/trial/expired/disabled/unverified and shows only for eligible unlimited', async () => {
  const { isVpnConfigTrafficResetEligible } = await loadFrontendVpnStatus();
  assert.equal(
    isVpnConfigTrafficResetEligible({
      uuid: 'u1',
      status: 'Active',
      enable: true,
      enableStatus: true,
      panelStatusVerified: true,
      expiryDate: FUTURE_ISO,
      trafficResetEligible: true,
      isUnlimitedPlan: true,
      isTrial: false,
      totalTrafficBytes: 0,
    }),
    true
  );

  // Finite 100 GB package hidden
  assert.equal(
    isVpnConfigTrafficResetEligible({
      uuid: 'u2',
      status: 'Active',
      enable: true,
      enableStatus: true,
      panelStatusVerified: true,
      expiryDate: FUTURE_ISO,
      trafficResetEligible: false,
      isUnlimitedPlan: false,
      totalTrafficBytes: 100 * GB,
    }),
    false
  );

  // Free trial hidden even if flag mistakenly true
  assert.equal(
    isVpnConfigTrafficResetEligible({
      uuid: 'u3',
      status: 'Active',
      enable: true,
      enableStatus: true,
      panelStatusVerified: true,
      expiryDate: FUTURE_ISO,
      trafficResetEligible: true,
      isUnlimitedPlan: true,
      isTrial: true,
      totalTrafficBytes: 0,
    }),
    false
  );

  // Expired, Disabled, Status Unavailable hidden
  assert.equal(
    isVpnConfigTrafficResetEligible({
      uuid: 'u4',
      status: 'Expired',
      enable: true,
      expiryDate: PAST_ISO,
      trafficResetEligible: true,
    }),
    false
  );
  assert.equal(
    isVpnConfigTrafficResetEligible({
      uuid: 'u5',
      status: 'Disabled',
      enable: false,
      expiryDate: FUTURE_ISO,
      trafficResetEligible: true,
    }),
    false
  );
  assert.equal(
    isVpnConfigTrafficResetEligible({
      uuid: 'u6',
      status: 'Status Unavailable',
      panelStatusVerified: false,
      expiryDate: FUTURE_ISO,
      trafficResetEligible: true,
    }),
    false
  );
});

test('TR-32: Switching between unlimited and limited configs updates frontend eligibility immediately without stale carryover', async () => {
  const { isVpnConfigTrafficResetEligible } = await loadFrontendVpnStatus();
  const unlimCfg = {
    uuid: 'u-sim-unlim',
    packageName: 'SIM Unlimited',
    status: 'Active',
    enable: true,
    enableStatus: true,
    panelStatusVerified: true,
    expiryDate: FUTURE_ISO,
    trafficResetEligible: true,
    isUnlimitedPlan: true,
    isTrial: false,
    totalTrafficBytes: 0,
  };
  const limCfg = {
    uuid: 'u-sim-100gb',
    packageName: 'SIM 100 GB',
    status: 'Active',
    enable: true,
    enableStatus: true,
    panelStatusVerified: true,
    expiryDate: FUTURE_ISO,
    trafficResetEligible: false,
    isUnlimitedPlan: false,
    isTrial: false,
    totalTrafficBytes: 100 * GB,
  };

  assert.equal(isVpnConfigTrafficResetEligible(unlimCfg), true);
  assert.equal(isVpnConfigTrafficResetEligible(limCfg), false);
  assert.equal(isVpnConfigTrafficResetEligible(unlimCfg), true);
});
