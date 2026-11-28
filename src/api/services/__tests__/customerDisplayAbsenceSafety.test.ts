import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computePanelIdentity,
  resetXuiServiceCachesForTests,
  setCachedInbounds,
  XuiConfig,
  XuiInbound,
  UncachedInboundsListReadResult,
} from '../xuiService.js';
import {
  getMyConfigs,
  resetLastKnownClientTrafficCacheForTests,
} from '../vpnService.js';
import { getClientStatus } from '../clientService.js';
import {
  isVpnConfigDeleted,
  isVpnConfigRejected,
  isVpnConfigPanelWideAbsent,
  isUuidConfirmedDeleted,
  clearConfirmedDeletedVpnUuidsForTest,
  reconcileCustomerPanelAbsenceObservations,
  isUuidTemporarilyObservedPanelAbsent,
  clearCustomerPanelAbsenceObservations,
  isRenewalCandidateEligible,
  partitionUsableAndHistoricalVpnConfigs,
  markVpnConfigStatusUnavailable,
  mergeFreshVpnConfigStatus,
} from '../../../../../src/lib/vpnStatus.js';

const PANEL_URL = 'https://panel-prod.firevpn.example:2053/subpath';
const PANEL_ID = computePanelIdentity(PANEL_URL);
const PAST_CREATED_AT = '2026-01-01T00:00:00.000Z';
const FUTURE_EXPIRY_MS = Date.now() + 30 * 24 * 60 * 60 * 1000;
const PAST_EXPIRY_MS = Date.now() - 5 * 24 * 60 * 60 * 1000;

const CUSTOMER_ID = 'cust-prod-001';
const CUSTOMER_EMAIL = 'rexgg@example.com';
const REXGG_UUID = '9f8e7d6c-5b4a-4321-8765-123456789abc';
const SEE12_UUID = '102b70ff-37e9-4b1b-9913-7e6c3779737a';
const MOVED_UUID = '22222222-3333-4444-8555-666666666666';
const EXPIRED_UUID = '33333333-4444-4555-8666-777777777777';
const EXHAUSTED_UUID = '44444444-5555-4666-8777-888888888888';
const REJECTED_UUID = '55555555-6666-4777-8888-999999999999';
const DELETED_UUID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const PROVENANCE_ABSENT_UUID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

const makeConfig = (overrides: Partial<XuiConfig> = {}): XuiConfig => ({
  panelUrl: PANEL_URL,
  username: 'admin',
  password: 'secret-password',
  apiToken: 'secret-password',
  panelName: 'ProductionPanel',
  ...overrides,
});

const makeInbound = (
  id: number,
  clients: Array<{
    id: string;
    email: string;
    enable?: boolean;
    up?: number;
    down?: number;
    totalGB?: number;
    expiryTime?: number;
  }>,
  rawSettingsOverride?: string
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
  settings:
    rawSettingsOverride ??
    JSON.stringify({
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

const makeUncachedListResult = (
  inbounds: XuiInbound[],
  opts?: { allInboundsCleanlyParsed?: boolean; unparsedInboundIds?: number[]; ok?: boolean }
): UncachedInboundsListReadResult => {
  const unparsedInboundIds = opts?.unparsedInboundIds ?? [];
  const allClean = opts?.allInboundsCleanlyParsed ?? unparsedInboundIds.length === 0;
  return {
    ok: opts?.ok ?? true,
    inbounds,
    parsedByInboundId: new Map(),
    unparsedInboundIds,
    allInboundsCleanlyParsed: allClean,
    liveClientByUuid: new Map(),
  };
};

const createMockCustomerDb = (seed: {
  vpn_accounts?: any[];
  vpn_configs?: any[];
  orders?: any[];
  profiles?: any[];
}) => {
  const state = {
    vpn_accounts: (seed.vpn_accounts || []).map((r) => ({ ...r })),
    vpn_configs: (seed.vpn_configs || []).map((r) => ({ ...r })),
    orders: (seed.orders || []).map((r) => ({ ...r })),
    profiles: (seed.profiles || []).map((r) => ({ ...r })),
    writes: [] as Array<{ table: string; op: string; payload: any }>,
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
        state.writes.push({ table, op: pendingWrite.op, payload: pendingWrite.payload });
        return { data: [], error: null };
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
      neq: (col: string, val: any) => {
        filters.push((r) => r[col] !== val);
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
  };
};

test('Scenario 1 & 5: Live working VPN (rexgg) remains visible while panel-wide absent historical record (see12) is separated without DB deletion', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-rexgg',
        user_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        uuid: REXGG_UUID,
        remark: 'rexgg',
        package_name: 'Dialog Unlimited',
        vless_url: `vless://${REXGG_UUID}@sg.firevpn.example:443?security=none#rexgg`,
        expiry_date: new Date(FUTURE_EXPIRY_MS).toISOString(),
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'acc-see12',
        user_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        uuid: SEE12_UUID,
        remark: 'see12',
        package_name: 'Zoom Package',
        vless_url: `vless://${SEE12_UUID}@sg.firevpn.example:443?security=none#see12`,
        expiry_date: new Date(FUTURE_EXPIRY_MS).toISOString(),
        status: 'active',
        panel_identity: null, // Historical record lacking panel provenance
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'acc-prov-absent',
        user_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        uuid: PROVENANCE_ABSENT_UUID,
        remark: 'old-verified-client',
        package_name: 'Router Unlimited',
        vless_url: `vless://${PROVENANCE_ABSENT_UUID}@sg.firevpn.example:443?security=none#old-verified-client`,
        expiry_date: new Date(FUTURE_EXPIRY_MS).toISOString(),
        status: 'active',
        panel_identity: PANEL_ID, // Has verified panel provenance
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-rexgg',
        customer_uid: CUSTOMER_ID,
        uuid: REXGG_UUID,
        inbound_id: 1,
        package_name: 'Dialog Unlimited',
        full_config: `vless://${REXGG_UUID}@sg.firevpn.example:443?security=none#rexgg`,
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'cfg-see12',
        customer_uid: CUSTOMER_ID,
        uuid: SEE12_UUID,
        inbound_id: 13,
        package_name: 'Zoom Package',
        full_config: `vless://${SEE12_UUID}@sg.firevpn.example:443?security=none#see12`,
        status: 'active',
        panel_identity: null,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'cfg-prov-absent',
        customer_uid: CUSTOMER_ID,
        uuid: PROVENANCE_ABSENT_UUID,
        inbound_id: 2,
        package_name: 'Router Unlimited',
        full_config: `vless://${PROVENANCE_ABSENT_UUID}@sg.firevpn.example:443?security=none#old-verified-client`,
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const inbound1 = makeInbound(1, [
    {
      id: REXGG_UUID,
      email: 'rexgg',
      enable: true,
      up: 2 * 1024 ** 3,
      down: 3 * 1024 ** 3,
      totalGB: 0,
      expiryTime: FUTURE_EXPIRY_MS,
    },
  ]);
  const inbound2 = makeInbound(2, []);
  const inbound13 = makeInbound(13, []);

  const myConfigsOptions = {
    dbClient: db as any,
    adminDbClient: db as any,
    currentPanelIdentity: PANEL_ID,
    getLiveInboundFn: async (id: number) => {
      if (id === 1) return inbound1;
      if (id === 2) return inbound2;
      if (id === 13) return inbound13;
      return null;
    },
    fetchUncachedLiveInboundsListFn: async () =>
      makeUncachedListResult([inbound1, inbound2, inbound13]),
  };

  const result = await getMyConfigs(CUSTOMER_ID, CUSTOMER_EMAIL, undefined, myConfigsOptions);

  assert.equal(result.configs.length, 3);
  assert.equal(db.state.writes.length, 0, 'Must perform zero database mutations');

  const rexgg = result.configs.find((c: any) => c.uuid === REXGG_UUID);
  assert.ok(rexgg);
  assert.equal(rexgg.status, 'Active');
  assert.equal(rexgg.panelWideAbsentVerified, false);
  assert.equal(rexgg.panelAbsenceClassification, null);
  assert.equal(rexgg.panelProvenanceVerified, true);

  const see12 = result.configs.find((c: any) => c.uuid === SEE12_UUID);
  assert.ok(see12);
  assert.equal(see12.status, 'Status Unavailable');
  assert.equal(see12.panelWideAbsentVerified, true);
  assert.equal(see12.panelAbsenceClassification, 'absent_from_current_panel_unverified_provenance');
  assert.equal(see12.panelProvenanceVerified, false);

  const provAbsent = result.configs.find((c: any) => c.uuid === PROVENANCE_ABSENT_UUID);
  assert.ok(provAbsent);
  assert.equal(provAbsent.status, 'Status Unavailable');
  assert.equal(provAbsent.panelWideAbsentVerified, true);
  assert.equal(provAbsent.panelAbsenceClassification, 'absent_from_current_panel');
  assert.equal(provAbsent.panelProvenanceVerified, true);

  // Partition helper separates rexgg into usableConfigs and see12 + provAbsent into historicalAbsentConfigs
  const { usableConfigs, historicalAbsentConfigs } = partitionUsableAndHistoricalVpnConfigs(result.configs);
  assert.equal(usableConfigs.length, 1);
  assert.equal(usableConfigs[0].uuid, REXGG_UUID);
  assert.equal(historicalAbsentConfigs.length, 2);
  assert.ok(historicalAbsentConfigs.some((c: any) => c.uuid === SEE12_UUID));
  assert.ok(historicalAbsentConfigs.some((c: any) => c.uuid === PROVENANCE_ABSENT_UUID));

  // Single inbound read alone without complete panel-wide snapshot must NEVER mark panelWideAbsentVerified = true
  const singleInboundOnlyResult = await getMyConfigs(CUSTOMER_ID, CUSTOMER_EMAIL, undefined, {
    dbClient: db as any,
    adminDbClient: db as any,
    currentPanelIdentity: PANEL_ID,
    getLiveInboundFn: async (id: number) => {
      if (id === 1) return inbound1;
      if (id === 2) return inbound2;
      if (id === 13) return inbound13;
      return null;
    },
    fetchUncachedLiveInboundsListFn: async () => {
      throw new Error('Panel-wide list endpoint timed out');
    },
  });

  const see12WithoutFullList = singleInboundOnlyResult.configs.find((c: any) => c.uuid === SEE12_UUID);
  assert.ok(see12WithoutFullList);
  assert.equal(
    see12WithoutFullList.panelWideAbsentVerified,
    false,
    'A single inbound read without a complete panel-wide snapshot must never mark a config as panelWideAbsentVerified'
  );
  assert.equal(see12WithoutFullList.panelAbsenceClassification, null);

  // Default getClientStatus (even when profiles.active_vpn_uuid points to stale see12) must prefer usable rexgg
  db.state.profiles.push({ id: CUSTOMER_ID, active_vpn_uuid: SEE12_UUID });
  const defaultClientStatus = await getClientStatus(CUSTOMER_EMAIL, undefined, CUSTOMER_ID, undefined, {
    dbClient: db as any,
    getMyConfigsOptions: myConfigsOptions,
  });
  assert.ok(defaultClientStatus);
  assert.equal(defaultClientStatus.uuid, REXGG_UUID);
  assert.equal(defaultClientStatus.panelWideAbsentVerified, false);

  // Explicit targetUuid lookup for see12 returns panelWideAbsentVerified=true so frontend can switch away cleanly
  const explicitSee12Status = await getClientStatus(CUSTOMER_EMAIL, SEE12_UUID, CUSTOMER_ID, undefined, {
    dbClient: db as any,
    getMyConfigsOptions: myConfigsOptions,
  });
  assert.ok(explicitSee12Status);
  assert.equal(explicitSee12Status.uuid, SEE12_UUID);
  assert.equal(explicitSee12Status.panelWideAbsentVerified, true);
  assert.equal(
    explicitSee12Status.panelAbsenceClassification,
    'absent_from_current_panel_unverified_provenance'
  );

  // Panel identity conflict (record belongs to another panel) must NEVER mark panelWideAbsentVerified=true
  const otherPanelId = computePanelIdentity('https://panel-other.firevpn.example:2053/subpath');
  const conflictResult = await getMyConfigs(CUSTOMER_ID, CUSTOMER_EMAIL, undefined, {
    ...myConfigsOptions,
    currentPanelIdentity: otherPanelId,
  });
  const provAbsentConflict = conflictResult.configs.find((c: any) => c.uuid === PROVENANCE_ABSENT_UUID);
  assert.ok(provAbsentConflict);
  assert.equal(
    provAbsentConflict.panelWideAbsentVerified,
    false,
    'Panel identity conflict must never classify a config as absent from the current panel'
  );
});

test('Scenario 2: Client moved to another inbound on 3X-UI is found via panel-wide check and remains visible as Active', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-moved',
        user_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        uuid: MOVED_UUID,
        remark: 'moved-client',
        package_name: 'Dialog Unlimited',
        vless_url: `vless://${MOVED_UUID}@sg.firevpn.example:443?security=none#moved-client`,
        expiry_date: new Date(FUTURE_EXPIRY_MS).toISOString(),
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-moved',
        customer_uid: CUSTOMER_ID,
        uuid: MOVED_UUID,
        inbound_id: 2, // Historical DB inbound_id is 2, but client moved to inbound 6 on 3X-UI
        package_name: 'Dialog Unlimited',
        full_config: `vless://${MOVED_UUID}@sg.firevpn.example:443?security=none#moved-client`,
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const inbound2Empty = makeInbound(2, []);
  const inbound6WithMovedClient = makeInbound(6, [
    {
      id: MOVED_UUID,
      email: 'moved-client',
      enable: true,
      up: 1 * 1024 ** 3,
      down: 4 * 1024 ** 3,
      totalGB: 100 * 1024 ** 3,
      expiryTime: FUTURE_EXPIRY_MS,
    },
  ]);

  const result = await getMyConfigs(CUSTOMER_ID, CUSTOMER_EMAIL, undefined, {
    dbClient: db as any,
    adminDbClient: db as any,
    currentPanelIdentity: PANEL_ID,
    getLiveInboundFn: async (id: number) => {
      if (id === 2) return inbound2Empty;
      return null;
    },
    fetchUncachedLiveInboundsListFn: async () =>
      makeUncachedListResult([inbound2Empty, inbound6WithMovedClient]),
  });

  assert.equal(result.configs.length, 1);
  const movedCfg = result.configs[0];
  assert.equal(movedCfg.uuid, MOVED_UUID);
  assert.equal(movedCfg.status, 'Active');
  assert.equal(movedCfg.inboundId, 6, 'In-memory inboundId reflects the live inbound on 3X-UI');
  assert.equal(movedCfg.panelWideAbsentVerified, false);
  assert.equal(movedCfg.panelAbsenceClassification, null);

  const { usableConfigs, historicalAbsentConfigs } = partitionUsableAndHistoricalVpnConfigs(result.configs);
  assert.equal(usableConfigs.length, 1);
  assert.equal(historicalAbsentConfigs.length, 0);
});

test('Scenario 3: Expired and Data Limit Reached live VPNs remain visible in usableConfigs and eligible for renewal', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-expired',
        user_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        uuid: EXPIRED_UUID,
        remark: 'expired-live-vpn',
        package_name: 'SIM 100GB',
        vless_url: `vless://${EXPIRED_UUID}@sg.firevpn.example:443?security=none#expired`,
        expiry_date: new Date(PAST_EXPIRY_MS).toISOString(),
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'acc-exhausted',
        user_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        uuid: EXHAUSTED_UUID,
        remark: 'exhausted-live-vpn',
        package_name: 'SIM 100GB',
        vless_url: `vless://${EXHAUSTED_UUID}@sg.firevpn.example:443?security=none#exhausted`,
        expiry_date: new Date(FUTURE_EXPIRY_MS).toISOString(),
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-expired',
        customer_uid: CUSTOMER_ID,
        uuid: EXPIRED_UUID,
        inbound_id: 1,
        package_name: 'SIM 100GB',
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'cfg-exhausted',
        customer_uid: CUSTOMER_ID,
        uuid: EXHAUSTED_UUID,
        inbound_id: 1,
        package_name: 'SIM 100GB',
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const quota100Gb = 100 * 1024 ** 3;
  const inbound1 = makeInbound(1, [
    {
      id: EXPIRED_UUID,
      email: 'expired-live-vpn',
      enable: true,
      up: 10 * 1024 ** 3,
      down: 20 * 1024 ** 3,
      totalGB: quota100Gb,
      expiryTime: PAST_EXPIRY_MS,
    },
    {
      id: EXHAUSTED_UUID,
      email: 'exhausted-live-vpn',
      enable: false,
      up: 50 * 1024 ** 3,
      down: 55 * 1024 ** 3,
      totalGB: quota100Gb,
      expiryTime: FUTURE_EXPIRY_MS,
    },
  ]);

  const result = await getMyConfigs(CUSTOMER_ID, CUSTOMER_EMAIL, undefined, {
    dbClient: db as any,
    adminDbClient: db as any,
    currentPanelIdentity: PANEL_ID,
    getLiveInboundFn: async () => inbound1,
    fetchUncachedLiveInboundsListFn: async () => makeUncachedListResult([inbound1]),
  });

  const expiredCfg = result.configs.find((c: any) => c.uuid === EXPIRED_UUID);
  const exhaustedCfg = result.configs.find((c: any) => c.uuid === EXHAUSTED_UUID);

  assert.ok(expiredCfg);
  assert.equal(expiredCfg.status, 'Expired');
  assert.equal(expiredCfg.panelWideAbsentVerified, false);

  assert.ok(exhaustedCfg);
  assert.equal(exhaustedCfg.status, 'Data Limit Reached');
  assert.equal(exhaustedCfg.panelWideAbsentVerified, false);

  const { usableConfigs, historicalAbsentConfigs } = partitionUsableAndHistoricalVpnConfigs(result.configs);
  assert.equal(usableConfigs.length, 2);
  assert.equal(historicalAbsentConfigs.length, 0);
});

test('Scenario 4: Rejected VPN behavior remains unchanged (isRejected: true, credentials redacted, panelWideAbsentVerified: false)', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-rejected',
        user_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        uuid: REJECTED_UUID,
        order_id: 'ord-rej-1',
        remark: 'rejected-vpn',
        package_name: 'Dialog Unlimited',
        vless_url: `vless://${REJECTED_UUID}@sg.firevpn.example:443?security=none#rejected`,
        expiry_date: new Date(FUTURE_EXPIRY_MS).toISOString(),
        status: 'rejected',
        created_at: PAST_CREATED_AT,
      },
    ],
    orders: [
      {
        id: 'ord-rej-1',
        order_id: 'ORD-REJ-1',
        customer_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        client_uuid: REJECTED_UUID,
        package_name: 'Dialog Unlimited',
        status: 'rejected',
        rejection_reason: 'Invalid payment slip',
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const result = await getMyConfigs(CUSTOMER_ID, CUSTOMER_EMAIL, undefined, {
    dbClient: db as any,
    adminDbClient: db as any,
    currentPanelIdentity: PANEL_ID,
    getLiveInboundFn: async () => makeInbound(1, []),
    fetchUncachedLiveInboundsListFn: async () => makeUncachedListResult([makeInbound(1, [])]),
  });

  assert.equal(result.configs.length, 1);
  const rejCfg = result.configs[0];
  assert.equal(rejCfg.isRejected, true);
  assert.equal(rejCfg.status, 'Disabled');
  assert.equal(rejCfg.configUrl, '');
  assert.equal(rejCfg.panelWideAbsentVerified, false);
  assert.equal(isVpnConfigRejected(rejCfg), true);
  assert.equal(isVpnConfigPanelWideAbsent(rejCfg), false);
});

test('Scenario 6: Partial panel responses (missing a known cached inbound or malformed inbound settings) never hide valid clients', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-see12',
        user_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        uuid: SEE12_UUID,
        remark: 'see12',
        package_name: 'Zoom Package',
        vless_url: `vless://${SEE12_UUID}@sg.firevpn.example:443?security=none#see12`,
        expiry_date: new Date(FUTURE_EXPIRY_MS).toISOString(),
        status: 'active',
        panel_identity: null,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-see12',
        customer_uid: CUSTOMER_ID,
        uuid: SEE12_UUID,
        inbound_id: 13,
        package_name: 'Zoom Package',
        status: 'active',
        panel_identity: null,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  // Case 6A: Cached inbounds include inbound 1 and inbound 13, but the panel-wide list response omits inbound 13
  setCachedInbounds([makeInbound(1, []), makeInbound(13, [])], PANEL_ID);

  const partialMissingInboundResult = await getMyConfigs(CUSTOMER_ID, CUSTOMER_EMAIL, undefined, {
    dbClient: db as any,
    adminDbClient: db as any,
    currentPanelIdentity: PANEL_ID,
    getLiveInboundFn: async () => null,
    fetchUncachedLiveInboundsListFn: async () =>
      makeUncachedListResult([makeInbound(1, [])]), // Missing known cached inbound 13
  });

  assert.equal(partialMissingInboundResult.configs[0].panelWideAbsentVerified, false);
  assert.equal(
    partitionUsableAndHistoricalVpnConfigs(partialMissingInboundResult.configs).usableConfigs.length,
    1,
    'Partial panel response missing a known inbound must never hide or move a configuration to historical'
  );

  // Case 6B: Panel-wide list contains a malformed inbound settings JSON
  resetXuiServiceCachesForTests();
  const malformedInbound = makeInbound(2, [], '{malformed-json');
  const malformedPanelResult = await getMyConfigs(CUSTOMER_ID, CUSTOMER_EMAIL, undefined, {
    dbClient: db as any,
    adminDbClient: db as any,
    currentPanelIdentity: PANEL_ID,
    getLiveInboundFn: async () => makeInbound(13, []),
    fetchUncachedLiveInboundsListFn: async () =>
      makeUncachedListResult([makeInbound(13, []), malformedInbound], {
        allInboundsCleanlyParsed: false,
        unparsedInboundIds: [2],
      }),
  });

  assert.equal(malformedPanelResult.configs[0].panelWideAbsentVerified, false);
  assert.equal(
    partitionUsableAndHistoricalVpnConfigs(malformedPanelResult.configs).usableConfigs.length,
    1,
    'Malformed inbound JSON in panel response must never hide or move a configuration to historical'
  );
});

test('Scenario 7: Panel timeout and authentication failures never hide valid clients', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-rexgg',
        user_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        uuid: REXGG_UUID,
        remark: 'rexgg',
        package_name: 'Dialog Unlimited',
        vless_url: `vless://${REXGG_UUID}@sg.firevpn.example:443?security=none#rexgg`,
        expiry_date: new Date(FUTURE_EXPIRY_MS).toISOString(),
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-rexgg',
        customer_uid: CUSTOMER_ID,
        uuid: REXGG_UUID,
        inbound_id: 1,
        package_name: 'Dialog Unlimited',
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const timeoutResult = await getMyConfigs(CUSTOMER_ID, CUSTOMER_EMAIL, undefined, {
    dbClient: db as any,
    adminDbClient: db as any,
    currentPanelIdentity: PANEL_ID,
    getLiveInboundFn: async () => {
      throw new Error('3X-UI authentication timeout');
    },
    fetchUncachedLiveInboundsListFn: async () => {
      throw new Error('3X-UI authentication timeout');
    },
  });

  assert.equal(timeoutResult.configs.length, 1);
  assert.equal(timeoutResult.configs[0].uuid, REXGG_UUID);
  assert.equal(timeoutResult.configs[0].panelWideAbsentVerified, false);
  assert.equal(timeoutResult.configs[0].panelAbsenceClassification, null);

  // Frontend helper safety on network/timeout errors
  const markedList = markVpnConfigStatusUnavailable(
    [
      {
        ...timeoutResult.configs[0],
        panelWideAbsentVerified: true,
        panelAbsenceClassification: 'absent_from_current_panel',
      },
    ],
    REXGG_UUID
  );
  assert.equal(markedList[0].panelWideAbsentVerified, false);
  assert.equal(markedList[0].panelAbsenceClassification, null);

  const mergedList = mergeFreshVpnConfigStatus([timeoutResult.configs[0]], {
    uuid: REXGG_UUID,
    status: 'Status Unavailable',
    panelStatusVerified: false,
  });
  assert.equal(mergedList[0].panelWideAbsentVerified, false);
  assert.equal(mergedList[0].panelAbsenceClassification, null);
  assert.equal(partitionUsableAndHistoricalVpnConfigs(mergedList).usableConfigs.length, 1);
});

test('Scenario 8: Confirmed-deleted records cannot reappear through cache or orders fallback', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-deleted',
        user_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        uuid: DELETED_UUID,
        order_id: 'ord-del-1',
        remark: 'deleted-client',
        package_name: 'Dialog Unlimited',
        vless_url: `vless://${DELETED_UUID}@sg.firevpn.example:443?security=none#deleted`,
        expiry_date: new Date(FUTURE_EXPIRY_MS).toISOString(),
        status: 'deleted',
        deleted_from_panel_at: '2026-06-01T00:00:00.000Z',
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-deleted',
        customer_uid: CUSTOMER_ID,
        uuid: DELETED_UUID,
        order_id: 'ord-del-1',
        inbound_id: 1,
        package_name: 'Dialog Unlimited',
        status: 'deleted',
        deleted_from_panel_at: '2026-06-01T00:00:00.000Z',
        created_at: PAST_CREATED_AT,
      },
    ],
    orders: [
      {
        id: 'ord-del-1',
        order_id: 'ORD-DEL-1',
        customer_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        client_uuid: DELETED_UUID,
        package_name: 'Dialog Unlimited',
        status: 'approved',
        vless_link: `vless://${DELETED_UUID}@sg.firevpn.example:443?security=none#deleted`,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const result = await getMyConfigs(CUSTOMER_ID, CUSTOMER_EMAIL, undefined, {
    dbClient: db as any,
    adminDbClient: db as any,
    currentPanelIdentity: PANEL_ID,
    getLiveInboundFn: async () => makeInbound(1, []),
    fetchUncachedLiveInboundsListFn: async () => makeUncachedListResult([makeInbound(1, [])]),
  });

  assert.equal(result.configs.length, 0, 'Confirmed-deleted config must not be resurrected by orders fallback');
  assert.ok(result.deletedUuids.includes(DELETED_UUID));
  assert.equal(
    isVpnConfigDeleted({ uuid: DELETED_UUID, status: 'deleted', deleted_from_panel_at: '2026-06-01T00:00:00.000Z' }),
    true
  );
  const partitioned = partitionUsableAndHistoricalVpnConfigs([
    { uuid: DELETED_UUID, status: 'deleted', deleted_from_panel_at: '2026-06-01T00:00:00.000Z' },
  ]);
  assert.equal(partitioned.usableConfigs.length, 0);
  assert.equal(partitioned.historicalAbsentConfigs.length, 0);
});

test('Scenario 9: Older backend responses without the new panelWideAbsentVerified fields remain compatible', () => {
  const legacyActiveConfig = {
    id: 'legacy-1',
    uuid: REXGG_UUID,
    packageName: 'Dialog Unlimited',
    status: 'Active',
    isActive: true,
    configUrl: `vless://${REXGG_UUID}@sg.firevpn.example:443?security=none#rexgg`,
  };
  const legacyUnavailableConfig = {
    id: 'legacy-2',
    uuid: SEE12_UUID,
    packageName: 'Zoom Package',
    status: 'Status Unavailable',
    isActive: false,
    configUrl: `vless://${SEE12_UUID}@sg.firevpn.example:443?security=none#see12`,
  };

  assert.equal(isVpnConfigPanelWideAbsent(legacyActiveConfig), false);
  assert.equal(isVpnConfigPanelWideAbsent(legacyUnavailableConfig), false);

  const { usableConfigs, historicalAbsentConfigs } = partitionUsableAndHistoricalVpnConfigs([
    legacyActiveConfig,
    legacyUnavailableConfig,
  ]);
  assert.equal(usableConfigs.length, 2);
  assert.equal(historicalAbsentConfigs.length, 0);
});

test('Scenario 10: Duplicate UUIDs in full-panel snapshot (both duplicated target UUID and unrelated duplicated UUID) prevent absence classification without hiding valid VPNs', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const DUP_TARGET_UUID = '88888888-9999-4aaa-8bbb-cccccccccccc';
  const UNRELATED_DUP_UUID = '99999999-aaaa-4bbb-8ccc-dddddddddddd';

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-rexgg',
        user_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        uuid: REXGG_UUID,
        remark: 'rexgg',
        package_name: 'Dialog Unlimited',
        vless_url: `vless://${REXGG_UUID}@sg.firevpn.example:443?security=none#rexgg`,
        expiry_date: new Date(FUTURE_EXPIRY_MS).toISOString(),
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'acc-dup-target',
        user_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        uuid: DUP_TARGET_UUID,
        remark: 'dup-target',
        package_name: 'Router Unlimited',
        vless_url: `vless://${DUP_TARGET_UUID}@sg.firevpn.example:443?security=none#dup-target`,
        expiry_date: new Date(FUTURE_EXPIRY_MS).toISOString(),
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'acc-see12',
        user_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        uuid: SEE12_UUID,
        remark: 'see12',
        package_name: 'Zoom Package',
        vless_url: `vless://${SEE12_UUID}@sg.firevpn.example:443?security=none#see12`,
        expiry_date: new Date(FUTURE_EXPIRY_MS).toISOString(),
        status: 'active',
        panel_identity: null,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-rexgg',
        customer_uid: CUSTOMER_ID,
        uuid: REXGG_UUID,
        inbound_id: 1,
        package_name: 'Dialog Unlimited',
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'cfg-dup-target',
        customer_uid: CUSTOMER_ID,
        uuid: DUP_TARGET_UUID,
        inbound_id: 2,
        package_name: 'Router Unlimited',
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'cfg-see12',
        customer_uid: CUSTOMER_ID,
        uuid: SEE12_UUID,
        inbound_id: 13,
        package_name: 'Zoom Package',
        status: 'active',
        panel_identity: null,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  // Case 10A: Customer's own target UUID (DUP_TARGET_UUID) is duplicated across inbound 1 and inbound 2
  const inbound1WithDupTarget = makeInbound(1, [
    {
      id: REXGG_UUID,
      email: 'rexgg',
      enable: true,
      up: 1 * 1024 ** 3,
      down: 2 * 1024 ** 3,
      totalGB: 0,
      expiryTime: FUTURE_EXPIRY_MS,
    },
    {
      id: DUP_TARGET_UUID,
      email: 'dup-target-a',
      enable: true,
      expiryTime: FUTURE_EXPIRY_MS,
    },
  ]);
  const inbound2WithDupTarget = makeInbound(2, [
    {
      id: DUP_TARGET_UUID,
      email: 'dup-target-b',
      enable: true,
      expiryTime: FUTURE_EXPIRY_MS,
    },
  ]);
  const inbound13Empty = makeInbound(13, []);

  const dupTargetResult = await getMyConfigs(CUSTOMER_ID, CUSTOMER_EMAIL, undefined, {
    dbClient: db as any,
    adminDbClient: db as any,
    currentPanelIdentity: PANEL_ID,
    getLiveInboundFn: async (id: number) => {
      if (id === 1) return inbound1WithDupTarget;
      if (id === 2) return inbound2WithDupTarget;
      if (id === 13) return inbound13Empty;
      return null;
    },
    fetchUncachedLiveInboundsListFn: async () =>
      makeUncachedListResult([inbound1WithDupTarget, inbound2WithDupTarget, inbound13Empty]),
  });

  const rexgg10A = dupTargetResult.configs.find((c: any) => c.uuid === REXGG_UUID);
  const dupTarget10A = dupTargetResult.configs.find((c: any) => c.uuid === DUP_TARGET_UUID);
  const see12_10A = dupTargetResult.configs.find((c: any) => c.uuid === SEE12_UUID);

  assert.ok(rexgg10A && dupTarget10A && see12_10A);
  assert.equal(rexgg10A.status, 'Active');
  assert.equal(rexgg10A.panelWideAbsentVerified, false);
  assert.equal(dupTarget10A.panelWideAbsentVerified, false);
  assert.equal(
    see12_10A.panelWideAbsentVerified,
    false,
    'Any duplicate UUID in the full-panel snapshot must prevent panel-wide absence classification'
  );
  assert.equal(see12_10A.panelAbsenceClassification, null);
  assert.equal(
    partitionUsableAndHistoricalVpnConfigs(dupTargetResult.configs).usableConfigs.length,
    3,
    'Duplicate UUID ambiguity must never hide valid configurations'
  );
  assert.equal(db.state.writes.length, 0);

  // Case 10B: An UNRELATED third-party UUID is duplicated across inbound 1 and inbound 2
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const inbound1WithUnrelatedDup = makeInbound(1, [
    {
      id: REXGG_UUID,
      email: 'rexgg',
      enable: true,
      up: 1 * 1024 ** 3,
      down: 2 * 1024 ** 3,
      totalGB: 0,
      expiryTime: FUTURE_EXPIRY_MS,
    },
    {
      id: UNRELATED_DUP_UUID,
      email: 'other-customer-a',
      enable: true,
      expiryTime: FUTURE_EXPIRY_MS,
    },
  ]);
  const inbound2WithUnrelatedDup = makeInbound(2, [
    {
      id: DUP_TARGET_UUID,
      email: 'dup-target-clean',
      enable: true,
      expiryTime: FUTURE_EXPIRY_MS,
    },
    {
      id: UNRELATED_DUP_UUID,
      email: 'other-customer-b',
      enable: true,
      expiryTime: FUTURE_EXPIRY_MS,
    },
  ]);

  const unrelatedDupResult = await getMyConfigs(CUSTOMER_ID, CUSTOMER_EMAIL, undefined, {
    dbClient: db as any,
    adminDbClient: db as any,
    currentPanelIdentity: PANEL_ID,
    getLiveInboundFn: async (id: number) => {
      if (id === 1) return inbound1WithUnrelatedDup;
      if (id === 2) return inbound2WithUnrelatedDup;
      if (id === 13) return inbound13Empty;
      return null;
    },
    fetchUncachedLiveInboundsListFn: async () =>
      makeUncachedListResult([inbound1WithUnrelatedDup, inbound2WithUnrelatedDup, inbound13Empty]),
  });

  const rexgg10B = unrelatedDupResult.configs.find((c: any) => c.uuid === REXGG_UUID);
  const dupTarget10B = unrelatedDupResult.configs.find((c: any) => c.uuid === DUP_TARGET_UUID);
  const see12_10B = unrelatedDupResult.configs.find((c: any) => c.uuid === SEE12_UUID);

  assert.ok(rexgg10B && dupTarget10B && see12_10B);
  assert.equal(rexgg10B.status, 'Active');
  assert.equal(rexgg10B.panelWideAbsentVerified, false);
  assert.equal(dupTarget10B.status, 'Active');
  assert.equal(dupTarget10B.panelWideAbsentVerified, false);
  assert.equal(
    see12_10B.panelWideAbsentVerified,
    false,
    'An unrelated duplicate UUID anywhere in the full-panel snapshot must invalidate panel-wide absence classification'
  );
  assert.equal(see12_10B.panelAbsenceClassification, null);
  assert.equal(partitionUsableAndHistoricalVpnConfigs(unrelatedDupResult.configs).usableConfigs.length, 3);
  assert.equal(db.state.writes.length, 0);
});

test('Scenario 11: Historical configuration whose original inbound (13) has been removed from 3X-UI keeps existing safety and is NOT classified as panelWideAbsentVerified', async () => {
  resetXuiServiceCachesForTests();
  resetLastKnownClientTrafficCacheForTests();

  const db = createMockCustomerDb({
    vpn_accounts: [
      {
        id: 'acc-rexgg',
        user_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        uuid: REXGG_UUID,
        remark: 'rexgg',
        package_name: 'Dialog Unlimited',
        vless_url: `vless://${REXGG_UUID}@sg.firevpn.example:443?security=none#rexgg`,
        expiry_date: new Date(FUTURE_EXPIRY_MS).toISOString(),
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'acc-see12',
        user_id: CUSTOMER_ID,
        email: CUSTOMER_EMAIL,
        uuid: SEE12_UUID,
        remark: 'see12',
        package_name: 'Zoom Package',
        vless_url: `vless://${SEE12_UUID}@sg.firevpn.example:443?security=none#see12`,
        expiry_date: new Date(FUTURE_EXPIRY_MS).toISOString(),
        status: 'active',
        panel_identity: null,
        created_at: PAST_CREATED_AT,
      },
    ],
    vpn_configs: [
      {
        id: 'cfg-rexgg',
        customer_uid: CUSTOMER_ID,
        uuid: REXGG_UUID,
        inbound_id: 1,
        package_name: 'Dialog Unlimited',
        status: 'active',
        panel_identity: PANEL_ID,
        created_at: PAST_CREATED_AT,
      },
      {
        id: 'cfg-see12',
        customer_uid: CUSTOMER_ID,
        uuid: SEE12_UUID,
        inbound_id: 13, // Original inbound 13 no longer exists in live 3X-UI panel
        package_name: 'Zoom Package',
        status: 'active',
        panel_identity: null,
        created_at: PAST_CREATED_AT,
      },
    ],
  });

  const inbound1 = makeInbound(1, [
    {
      id: REXGG_UUID,
      email: 'rexgg',
      enable: true,
      up: 512 * 1024 ** 2,
      down: 1024 ** 3,
      totalGB: 0,
      expiryTime: FUTURE_EXPIRY_MS,
    },
  ]);
  const inbound2 = makeInbound(2, []);

  // Live panel snapshot has only inbounds 1 and 2 (inbound 13 is permanently removed)
  const result = await getMyConfigs(CUSTOMER_ID, CUSTOMER_EMAIL, undefined, {
    dbClient: db as any,
    adminDbClient: db as any,
    currentPanelIdentity: PANEL_ID,
    getLiveInboundFn: async (id: number) => {
      if (id === 1) return inbound1;
      if (id === 2) return inbound2;
      return null; // Inbound 13 does not exist
    },
    fetchUncachedLiveInboundsListFn: async () => makeUncachedListResult([inbound1, inbound2]),
  });

  const rexgg = result.configs.find((c: any) => c.uuid === REXGG_UUID);
  const see12 = result.configs.find((c: any) => c.uuid === SEE12_UUID);

  assert.ok(rexgg && see12);
  assert.equal(rexgg.status, 'Active');
  assert.equal(rexgg.panelWideAbsentVerified, false);

  assert.equal(see12.status, 'Status Unavailable');
  assert.equal(
    see12.panelWideAbsentVerified,
    false,
    'expectedInboundVerifiedInPanelWideSnapshot must stay false when original inbound 13 is not in the live panel snapshot'
  );
  assert.equal(see12.panelAbsenceClassification, null);

  const { usableConfigs, historicalAbsentConfigs } = partitionUsableAndHistoricalVpnConfigs(result.configs);
  assert.equal(usableConfigs.length, 2);
  assert.equal(historicalAbsentConfigs.length, 0);
  assert.equal(db.state.writes.length, 0);
});

test('Scenario 12: Renewal dropdown fallback protects against previously verified panel-absent configs during /vpn/my-configs failure without permanently blacklisting or leaking across customers', () => {
  clearCustomerPanelAbsenceObservations();
  clearConfirmedDeletedVpnUuidsForTest();

  const DISABLED_LIVE_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const scopeCustomerA = { userId: CUSTOMER_ID, email: CUSTOMER_EMAIL };
  const scopeCustomerB = { userId: 'cust-prod-002', email: 'other@example.com' };

  // 1. Fresh authoritative observation marks see12 panel-wide absent and rexgg live Active
  reconcileCustomerPanelAbsenceObservations(scopeCustomerA, [
    {
      uuid: REXGG_UUID,
      status: 'Active',
      panelStatusVerified: true,
      panelWideAbsentVerified: false,
    },
    {
      uuid: SEE12_UUID,
      status: 'Status Unavailable',
      panelStatusVerified: false,
      panelWideAbsentVerified: true,
      panelAbsenceClassification: 'absent_from_current_panel_unverified_provenance',
    },
  ]);

  assert.equal(isUuidTemporarilyObservedPanelAbsent(SEE12_UUID, scopeCustomerA), true);
  assert.equal(isUuidTemporarilyObservedPanelAbsent(REXGG_UUID, scopeCustomerA), false);
  assert.equal(
    isUuidConfirmedDeleted(SEE12_UUID),
    false,
    'Temporary panel-absence observation must stay strictly separate from permanent deletion tombstones'
  );

  // 2. Network failure / unverified Status Unavailable response must NEVER clear the temporary absence observation
  reconcileCustomerPanelAbsenceObservations(scopeCustomerA, [
    {
      uuid: SEE12_UUID,
      status: 'Status Unavailable',
      panelStatusVerified: false,
      panelWideAbsentVerified: false,
    },
  ]);
  assert.equal(
    isUuidTemporarilyObservedPanelAbsent(SEE12_UUID, scopeCustomerA),
    true,
    'Unverified or Status Unavailable payload must not be interpreted as restored client presence'
  );

  // 3. During a later /vpn/my-configs failure (direct Supabase fallback & stale selectedConfig),
  //    previously observed panel-absent see12 remains excluded while valid live states remain eligible
  const supabaseSee12Account = {
    id: 'acc-see12',
    uuid: SEE12_UUID,
    status: 'active',
    package_name: 'Zoom Package',
    data_limit: 'Unlimited',
    is_trial: false,
  };
  assert.equal(
    isRenewalCandidateEligible({
      uuid: SEE12_UUID,
      account: supabaseSee12Account,
      liveConfig: undefined, // /vpn/my-configs failed
      customerScope: scopeCustomerA,
    }),
    false,
    'Direct Supabase fallback must not re-expose a previously observed panel-absent UUID'
  );
  assert.equal(
    isRenewalCandidateEligible({
      uuid: SEE12_UUID,
      config: { uuid: SEE12_UUID, status: 'Active', packageName: 'Zoom Package' }, // stale selectedConfig
      liveConfig: undefined,
      customerScope: scopeCustomerA,
    }),
    false,
    'Stale selectedConfig must not bypass temporary panel-absence protection'
  );

  // Valid renewable configurations remain eligible: Active, Expired, Data Limit Reached, and non-rejected Disabled
  assert.equal(
    isRenewalCandidateEligible({
      uuid: REXGG_UUID,
      account: { uuid: REXGG_UUID, status: 'active', package_name: 'Dialog Unlimited' },
      liveConfig: { uuid: REXGG_UUID, status: 'Active', panelStatusVerified: true, panelWideAbsentVerified: false },
      customerScope: scopeCustomerA,
    }),
    true,
    'Live Active VPN must remain eligible for renewal'
  );
  assert.equal(
    isRenewalCandidateEligible({
      uuid: EXPIRED_UUID,
      account: { uuid: EXPIRED_UUID, status: 'expired', package_name: 'SIM 100GB' },
      liveConfig: { uuid: EXPIRED_UUID, status: 'Expired', panelStatusVerified: true, panelWideAbsentVerified: false },
      customerScope: scopeCustomerA,
    }),
    true,
    'Live Expired VPN must remain eligible for renewal'
  );
  assert.equal(
    isRenewalCandidateEligible({
      uuid: EXHAUSTED_UUID,
      account: { uuid: EXHAUSTED_UUID, status: 'active', package_name: 'SIM 100GB' },
      liveConfig: {
        uuid: EXHAUSTED_UUID,
        status: 'Data Limit Reached',
        panelStatusVerified: true,
        panelWideAbsentVerified: false,
      },
      customerScope: scopeCustomerA,
    }),
    true,
    'Live Data Limit Reached VPN must remain eligible for renewal'
  );
  assert.equal(
    isRenewalCandidateEligible({
      uuid: DISABLED_LIVE_UUID,
      account: { uuid: DISABLED_LIVE_UUID, status: 'disabled', package_name: 'Router Unlimited' },
      liveConfig: {
        uuid: DISABLED_LIVE_UUID,
        status: 'Disabled',
        isRejected: false,
        panelStatusVerified: true,
        panelWideAbsentVerified: false,
      },
      customerScope: scopeCustomerA,
    }),
    true,
    'Live non-rejected Disabled VPN must remain eligible for renewal'
  );
  assert.equal(
    isRenewalCandidateEligible({
      uuid: REJECTED_UUID,
      account: { uuid: REJECTED_UUID, status: 'disabled', package_name: 'Router Unlimited' },
      liveConfig: {
        uuid: REJECTED_UUID,
        status: 'Disabled',
        isRejected: true,
        panelStatusVerified: true,
      },
      customerScope: scopeCustomerA,
    }),
    false,
    'Payment-rejected Disabled VPN must remain ineligible for renewal'
  );

  // 4. Account switching isolation: Customer A's temporary observation never affects Customer B
  assert.equal(
    isUuidTemporarilyObservedPanelAbsent(SEE12_UUID, scopeCustomerB),
    false,
    'Temporary absence observations must be scoped strictly per customer'
  );
  assert.equal(
    isRenewalCandidateEligible({
      uuid: SEE12_UUID,
      account: supabaseSee12Account,
      customerScope: scopeCustomerB,
    }),
    true
  );

  // 5. Fresh authoritative presence clears the temporary absence observation (never permanently blacklisted)
  reconcileCustomerPanelAbsenceObservations(scopeCustomerA, [
    {
      uuid: SEE12_UUID,
      status: 'Active',
      panelStatusVerified: true,
      panelWideAbsentVerified: false,
    },
  ]);
  assert.equal(isUuidTemporarilyObservedPanelAbsent(SEE12_UUID, scopeCustomerA), false);
  assert.equal(
    isRenewalCandidateEligible({
      uuid: SEE12_UUID,
      account: supabaseSee12Account,
      customerScope: scopeCustomerA,
    }),
    true,
    'Fresh authoritative live presence must clear temporary absence observation and restore renewal eligibility'
  );

  // 6. Older backend payload compatibility (fields panelStatusVerified & panelWideAbsentVerified omitted)
  reconcileCustomerPanelAbsenceObservations(scopeCustomerA, [
    {
      uuid: SEE12_UUID,
      status: 'Status Unavailable',
      panelStatusVerified: false,
      panelWideAbsentVerified: true,
    },
  ]);
  assert.equal(isUuidTemporarilyObservedPanelAbsent(SEE12_UUID, scopeCustomerA), true);

  // Legacy Status Unavailable must NOT clear observation
  reconcileCustomerPanelAbsenceObservations(scopeCustomerA, [
    {
      uuid: SEE12_UUID,
      status: 'Status Unavailable',
    },
  ]);
  assert.equal(isUuidTemporarilyObservedPanelAbsent(SEE12_UUID, scopeCustomerA), true);

  // Legacy Active payload safely clears observation
  reconcileCustomerPanelAbsenceObservations(scopeCustomerA, [
    {
      uuid: SEE12_UUID,
      status: 'Active',
    },
  ]);
  assert.equal(isUuidTemporarilyObservedPanelAbsent(SEE12_UUID, scopeCustomerA), false);

  clearCustomerPanelAbsenceObservations();
});

