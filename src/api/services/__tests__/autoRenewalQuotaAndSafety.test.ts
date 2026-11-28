import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCalendarMonths,
  buildVerifiedPreRenewalDbSnapshot,
  calculateApprovedRenewalEntitlement,
  parseExplicitRenewalQuotaSignal,
  parseVerifiedLiveTotalBytes,
  resolveAuthoritativeRenewalQuota,
  sanitizeAutoRenewalBlockedReason,
  provisionProvisionalRenewal,
  updateClientExpiry,
  XuiInbound,
} from '../xuiService.js';
import {
  createRenewRequest,
  executeRenewalApproval,
  executeRenewalRejection,
  persistAutoRenewalBlockedReasonCas,
} from '../../controllers/renewController.js';
import {
  handleTelegramCallbackQuery,
  sanitizeTelegramErrorMessage,
} from '../telegramService.js';

const GB = 1024 * 1024 * 1024;

interface LockRecord {
  operation_key: string;
  operation_type: string;
  target_id: string;
  lock_owner_id: string;
  status: 'in_progress' | 'completed' | 'failed' | 'uncertain';
  client_uuid: string | null;
  error_message: string | null;
}

interface MockDbOptions {
  tables?: Record<string, any[]>;
  initialLocks?: Record<string, Partial<LockRecord>>;
  storageDownloadBytes?: Buffer;
  receiptClaimConflict?: { claimed: boolean; conflict_reason?: string };
}

function createRenewalMockDb(opts: MockDbOptions = {}) {
  const tables: Record<string, any[]> = {
    orders: [],
    vpn_accounts: [],
    vpn_configs: [],
    vpn_entitlement_grants: [],
    renew_requests: [],
    payment_receipt_claims: [],
    settings: [],
    notifications: [],
    ...(opts.tables || {}),
  };

  const locks = new Map<string, LockRecord>();
  for (const [key, partial] of Object.entries(opts.initialLocks || {})) {
    locks.set(key, {
      operation_key: key,
      operation_type: partial.operation_type || 'auto_renew',
      target_id: partial.target_id || 'existing-target',
      lock_owner_id: partial.lock_owner_id || 'existing-worker',
      status: partial.status || 'in_progress',
      client_uuid: partial.client_uuid ?? null,
      error_message: partial.error_message ?? null,
    });
  }

  const rpcCalls: Array<{ fn: string; args: any; result?: any }> = [];
  const updateCalls: Array<{ table: string; payload: any; filters: Array<[string, string, any]> }> = [];
  const deleteCalls: Array<{ table: string; filters: Array<[string, string, any]> }> = [];

  const matchesFilters = (row: any, filters: Array<[string, string, any]>) =>
    filters.every(([op, col, val]) => {
      const rv = row?.[col];
      if (op === 'eq') return rv !== null && rv !== undefined && String(rv) === String(val);
      if (op === 'neq') return String(rv) !== String(val);
      if (op === 'is') return (rv ?? null) === val;
      if (op === 'ilike') return String(rv || '').toLowerCase() === String(val || '').toLowerCase();
      if (op === 'in') return Array.isArray(val) && val.includes(rv);
      if (op === 'gte') return String(rv || '') >= String(val || '');
      return true;
    });

  const makeQuery = (table: string) => {
    const filters: Array<[string, string, any]> = [];
    let mode: 'select' | 'update' | 'insert' | 'upsert' | 'delete' = 'select';
    let payload: any = null;

    const execute = (singleMode: 'many' | 'maybeSingle') => {
      const list = tables[table] || [];
      if (mode === 'select') {
        const rows = list.filter((r) => matchesFilters(r, filters)).map((r) => ({ ...r }));
        return Promise.resolve({
          data: singleMode === 'maybeSingle' ? rows[0] || null : rows,
          error: null,
        });
      }
      if (mode === 'update') {
        updateCalls.push({ table, payload: { ...payload }, filters: [...filters] });
        const updated: any[] = [];
        for (let i = 0; i < list.length; i++) {
          if (matchesFilters(list[i], filters)) {
            list[i] = { ...list[i], ...payload };
            updated.push({ ...list[i] });
          }
        }
        return Promise.resolve({
          data: singleMode === 'maybeSingle' ? updated[0] || null : updated,
          error: null,
        });
      }
      if (mode === 'delete') {
        deleteCalls.push({ table, filters: [...filters] });
        const remaining: any[] = [];
        const deleted: any[] = [];
        for (const r of list) {
          if (matchesFilters(r, filters)) {
            deleted.push({ ...r });
          } else {
            remaining.push(r);
          }
        }
        tables[table] = remaining;
        return Promise.resolve({
          data: singleMode === 'maybeSingle' ? deleted[0] || null : deleted,
          error: null,
        });
      }
      if (mode === 'insert' || mode === 'upsert') {
        const rec = { id: payload.id || `${table}-${list.length + 1}`, ...payload };
        list.push(rec);
        tables[table] = list;
        return Promise.resolve({
          data: singleMode === 'maybeSingle' ? { ...rec } : [{ ...rec }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    };

    const q: any = {
      select: () => q,
      update: (p: any) => {
        mode = 'update';
        payload = p;
        return q;
      },
      insert: (p: any) => {
        mode = 'insert';
        payload = p;
        return q;
      },
      upsert: (p: any) => {
        mode = 'upsert';
        payload = p;
        return q;
      },
      delete: () => {
        mode = 'delete';
        return q;
      },
      eq: (col: string, val: any) => {
        filters.push(['eq', col, val]);
        return q;
      },
      neq: (col: string, val: any) => {
        filters.push(['neq', col, val]);
        return q;
      },
      is: (col: string, val: any) => {
        filters.push(['is', col, val]);
        return q;
      },
      ilike: (col: string, val: any) => {
        filters.push(['ilike', col, val]);
        return q;
      },
      in: (col: string, val: any[]) => {
        filters.push(['in', col, val]);
        return q;
      },
      gte: (col: string, val: any) => {
        filters.push(['gte', col, val]);
        return q;
      },
      order: () => q,
      limit: () => q,
      maybeSingle: () => execute('maybeSingle'),
      single: () => execute('maybeSingle'),
      then: (resolve: any, reject: any) => execute('many').then(resolve, reject),
    };
    return q;
  };

  const storageBytes = opts.storageDownloadBytes || Buffer.from('fake-png-receipt-bytes-for-test');

  const dbClient: any = {
    tables,
    locks,
    rpcCalls,
    updateCalls,
    deleteCalls,
    from: (table: string) => makeQuery(table),
    storage: {
      from: (_bucket: string) => ({
        download: async (_path: string) => ({
          data: new Blob([storageBytes], { type: 'image/png' }),
          error: null,
        }),
      }),
    },
    rpc: async (fn: string, args: any) => {
      if (fn === 'acquire_provisioning_lock') {
        const key = String(args.p_operation_key);
        const existing = locks.get(key);
        const allowUncertain = Boolean(args.p_allow_uncertain_recovery);
        if (existing) {
          if (existing.status === 'in_progress') {
            const res = {
              acquired: false,
              lock_owner_id: existing.lock_owner_id,
              previous_status: 'in_progress',
              previous_operation_type: existing.operation_type,
              previous_target_id: existing.target_id,
              previous_error: existing.error_message,
            };
            rpcCalls.push({ fn, args, result: res });
            return { data: [res], error: null };
          }
          if (existing.status === 'uncertain' && !allowUncertain) {
            const res = {
              acquired: false,
              lock_owner_id: existing.lock_owner_id,
              previous_status: 'uncertain',
              previous_operation_type: existing.operation_type,
              previous_target_id: existing.target_id,
              previous_error: existing.error_message || 'Previous attempt uncertain',
            };
            rpcCalls.push({ fn, args, result: res });
            return { data: [res], error: null };
          }
        }
        locks.set(key, {
          operation_key: key,
          operation_type: args.p_operation_type,
          target_id: args.p_target_id,
          lock_owner_id: args.p_lock_owner_id,
          status: 'in_progress',
          client_uuid: args.p_client_uuid ?? null,
          error_message: null,
        });
        const res = {
          acquired: true,
          lock_owner_id: args.p_lock_owner_id,
          previous_status: existing?.status || null,
          previous_operation_type: existing?.operation_type || null,
          previous_target_id: existing?.target_id || null,
          previous_error: existing?.error_message || null,
        };
        rpcCalls.push({ fn, args, result: res });
        return { data: [res], error: null };
      }

      if (fn === 'renew_provisioning_lock') {
        const key = String(args.p_operation_key);
        const existing = locks.get(key);
        const ok = Boolean(
          existing && existing.status === 'in_progress' && existing.lock_owner_id === args.p_lock_owner_id
        );
        rpcCalls.push({ fn, args, result: ok });
        return { data: ok, error: null };
      }

      if (fn === 'release_provisioning_lock') {
        const key = String(args.p_operation_key);
        const existing = locks.get(key);
        if (existing && existing.lock_owner_id === args.p_lock_owner_id) {
          existing.status = args.p_status;
          existing.client_uuid = args.p_client_uuid ?? existing.client_uuid;
          existing.error_message = args.p_error_message ?? null;
          locks.set(key, existing);
        }
        rpcCalls.push({ fn, args, result: true });
        return { data: true, error: null };
      }

      if (fn === 'claim_renewal_payment_receipt') {
        if (opts.receiptClaimConflict) {
          const row = {
            claimed: opts.receiptClaimConflict.claimed,
            conflict_reason: opts.receiptClaimConflict.conflict_reason || 'duplicate_receipt_sha256',
          };
          rpcCalls.push({ fn, args, result: row });
          return { data: [row], error: null };
        }
        const row = {
          claimed: true,
          existing_order_id: null,
          existing_renew_request_id: args.p_renew_request_id,
          existing_user_id: args.p_user_id,
          conflict_reason: null,
        };
        rpcCalls.push({ fn, args, result: row });
        return { data: [row], error: null };
      }

      return { data: null, error: null };
    },
  };

  return dbClient;
}

function createMockExpressRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function buildLiveInbound(
  clients: any[],
  clientStats: any[] = [],
  inboundId = 2,
  enable = true
): XuiInbound {
  return {
    id: inboundId,
    enable,
    port: 443,
    protocol: 'vless',
    remark: 'DIALOG/AIRTEL/ROUTERS',
    tag: `inbound-${inboundId}`,
    settings: JSON.stringify({ clients }),
    streamSettings: '{}',
    sniffing: '{}',
    clientStats,
  } as any;
}

// -----------------------------------------------------------------------------
// Scenario 1: Normal 100GB renewals (automatic + manual)
// -----------------------------------------------------------------------------
test('Scenario 1: Normal 1-month SIM 100GB automatic provisional renewal adds exactly 100GB and preserves credentials', async () => {
  const fixedNow = Date.UTC(2026, 10, 27, 10, 0, 0);
  const prevExpiryMs = Date.UTC(2026, 11, 5, 10, 0, 0); // active
  const uuid = '11111111-1111-4111-8111-111111111111';

  let liveClients = [
    {
      id: uuid,
      email: 'sim100_normal_user',
      password: 'preserve-me-password',
      subId: 'sub_normal_100',
      flow: 'xtls-rprx-vision',
      limitIp: 2,
      totalGB: 100 * GB,
      expiryTime: prevExpiryMs,
      enable: true,
      reset: 0,
    },
  ];
  const liveStats = [{ id: uuid, email: 'sim100_normal_user', up: 10 * GB, down: 25 * GB }];

  const db = createRenewalMockDb({
    tables: {
      orders: [
        {
          id: 'ord-normal-100',
          customer_id: 'user-1',
          email: 'user1@example.com',
          package_name: 'Mobitel Zoom',
          status: 'completed',
          payment_status: 'Paid',
          provisioning_status: 'verified',
          expiry_date: new Date(prevExpiryMs).toISOString(),
          client_uuid: uuid,
        },
      ],
      vpn_accounts: [
        {
          id: 'acc-normal-100',
          user_id: 'user-1',
          email: 'user1@example.com',
          order_id: 'ord-normal-100',
          uuid,
          inbound_id: 2,
          remark: 'sim100_normal_user',
          data_limit: '100GB',
          total_bytes: 100 * GB,
          expiry_time: prevExpiryMs,
          expiry_date: new Date(prevExpiryMs).toISOString(),
          status: 'active',
          enable: true,
        },
      ],
      vpn_configs: [
        {
          id: 'cfg-normal-100',
          order_id: 'ord-normal-100',
          uuid,
          package_name: 'Mobitel Zoom',
          data_limit: '100GB',
          expiry_date: new Date(prevExpiryMs).toISOString(),
          status: 'active',
          enabled: true,
        },
      ],
      renew_requests: [
        {
          id: 'req-normal-100',
          user_id: 'user-1',
          user_email: 'user1@example.com',
          plan_name: 'Mobitel Zoom (SIM 100GB)',
          status: 'pending',
          provisioning_status: 'pending',
          notes: JSON.stringify({
            planId: 'sim_100',
            verified_plan_id: 'sim_100',
            package_type: 'SIM 100GB',
            data_limit: '100GB',
            category: 'SIM',
            quota_mode: 'finite',
            monthly_quota_gb: 100,
            quota_verified_by_server: true,
            package_id: 'mobitel_zoom',
            package_name: 'Mobitel Zoom',
            durationMonths: 1,
            vpn_account_id: 'acc-normal-100',
            uuid,
          }),
        },
      ],
    },
  });

  const result = await provisionProvisionalRenewal('req-normal-100', {
    dbClient: db,
    nowMs: fixedNow,
    skipSideEffects: true,
    getInboundsFn: async () => [buildLiveInbound(liveClients, liveStats, 2)],
    requestApiFn: async <T>(ep: string, method?: 'GET' | 'POST', data?: any): Promise<T> => {
      if (ep === '/panel/api/inbounds/get/2' && method === 'GET') {
        return { success: true, obj: buildLiveInbound(liveClients, liveStats, 2) } as unknown as T;
      }
      if (ep === '/panel/api/inbounds/update/2' && method === 'POST') {
        const parsed = JSON.parse(data.settings);
        liveClients = parsed.clients;
        return { success: true } as unknown as T;
      }
      throw new Error(`Unexpected API call: ${method} ${ep}`);
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.autoRenewed, true);
  assert.equal(result.addedQuotaBytes, 100 * GB);
  assert.equal(result.grantedTotalBytes, 200 * GB);
  assert.equal(result.grantedExpiryMs, addCalendarMonths(prevExpiryMs, 1));
  assert.equal(liveClients[0].totalGB, 200 * GB);
  assert.equal(liveClients[0].password, 'preserve-me-password');
  assert.equal(liveClients[0].subId, 'sub_normal_100');
  assert.equal(liveClients[0].id, uuid);
});

// -----------------------------------------------------------------------------
// Scenario 2: 100GB Special Offer automatic renewal NEVER becomes Unlimited
// -----------------------------------------------------------------------------
test('Scenario 2: 3-month 100GB Special Offer automatic renewal grants +300GB (never 0 Unlimited) even with promo plan_name', async () => {
  const fixedNow = Date.UTC(2026, 10, 27, 10, 0, 0);
  const prevExpiryMs = Date.UTC(2026, 11, 10, 10, 0, 0);
  const uuid = '22222222-2222-4222-8222-222222222222';

  let liveClients = [
    {
      id: uuid,
      email: 'special_100_auto',
      subId: 'sub_special_100',
      totalGB: 100 * GB,
      expiryTime: prevExpiryMs,
      enable: true,
      reset: 0,
    },
  ];
  const liveStats = [{ id: uuid, email: 'special_100_auto', up: 20 * GB, down: 30 * GB }];

  const db = createRenewalMockDb({
    tables: {
      orders: [
        {
          id: 'ord-special-100',
          customer_id: 'user-2',
          email: 'user2@example.com',
          package_name: 'Mobitel Zoom',
          status: 'completed',
          payment_status: 'Paid',
          provisioning_status: 'verified',
          expiry_date: new Date(prevExpiryMs).toISOString(),
          client_uuid: uuid,
        },
      ],
      vpn_accounts: [
        {
          id: 'acc-special-100',
          user_id: 'user-2',
          email: 'user2@example.com',
          order_id: 'ord-special-100',
          uuid,
          inbound_id: 2,
          data_limit: '100GB',
          total_bytes: 100 * GB,
          expiry_time: prevExpiryMs,
          expiry_date: new Date(prevExpiryMs).toISOString(),
          status: 'active',
          enable: true,
        },
      ],
      vpn_configs: [
        {
          id: 'cfg-special-100',
          order_id: 'ord-special-100',
          uuid,
          package_name: 'Mobitel Zoom',
          data_limit: '100GB',
          expiry_date: new Date(prevExpiryMs).toISOString(),
          status: 'active',
          enabled: true,
        },
      ],
      renew_requests: [
        {
          id: 'req-special-100-auto',
          user_id: 'user-2',
          user_email: 'user2@example.com',
          // Even a legacy Special Offer display name without "100GB" in plan_name
          plan_name: 'Mobitel Zoom (Summer Promo - 3 Months)',
          status: 'pending',
          provisioning_status: 'pending',
          notes: JSON.stringify({
            planId: 'sim_100',
            verified_plan_id: 'sim_100',
            package_type: 'SIM 100GB',
            data_limit: '100GB',
            category: 'SIM',
            quota_mode: 'finite',
            monthly_quota_gb: 100,
            quota_verified_by_server: true,
            is_special_offer: true,
            offer_id: 'offer-summer-3m',
            offer_name: 'Summer Promo',
            package_id: 'mobitel_zoom',
            package_name: 'Mobitel Zoom',
            durationMonths: 3,
            vpn_account_id: 'acc-special-100',
            uuid,
          }),
        },
      ],
    },
  });

  const result = await provisionProvisionalRenewal('req-special-100-auto', {
    dbClient: db,
    nowMs: fixedNow,
    skipSideEffects: true,
    getInboundsFn: async () => [buildLiveInbound(liveClients, liveStats, 2)],
    requestApiFn: async <T>(ep: string, method?: 'GET' | 'POST', data?: any): Promise<T> => {
      if (ep === '/panel/api/inbounds/get/2' && method === 'GET') {
        return { success: true, obj: buildLiveInbound(liveClients, liveStats, 2) } as unknown as T;
      }
      if (ep === '/panel/api/inbounds/update/2' && method === 'POST') {
        liveClients = JSON.parse(data.settings).clients;
        return { success: true } as unknown as T;
      }
      throw new Error(`Unexpected API call: ${method} ${ep}`);
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.autoRenewed, true);
  assert.equal(result.addedQuotaBytes, 300 * GB, '3-month 100GB Special Offer must add 300GB');
  assert.equal(result.grantedTotalBytes, 400 * GB, '100GB existing + 300GB added = 400GB (NEVER 0 Unlimited)');
  assert.equal(liveClients[0].totalGB, 400 * GB);
  assert.notEqual(liveClients[0].totalGB, 0, '100GB Special Offer must NEVER become Unlimited');
});

// -----------------------------------------------------------------------------
// Scenario 3: 100GB Special Offer manual approval (including legacy pending extra.planId='sim_100')
// -----------------------------------------------------------------------------
test('Scenario 3: 100GB Special Offer manual admin approval grants +300GB (never 0 Unlimited) for both new and legacy metadata', async () => {
  const fixedNow = Date.UTC(2026, 10, 27, 10, 0, 0);
  const prevExpiryMs = Date.UTC(2026, 11, 10, 10, 0, 0);
  const uuid = '33333333-3333-4333-8333-333333333333';

  let liveClients = [
    {
      id: uuid,
      email: 'special_100_manual',
      subId: 'sub_special_manual',
      totalGB: 100 * GB,
      expiryTime: prevExpiryMs,
      enable: true,
      reset: 0,
    },
  ];

  // Legacy pending Special Offer request (no quota_verified_by_server, promo-only plan_name, extra.planId='sim_100')
  const db = createRenewalMockDb({
    tables: {
      vpn_accounts: [
        {
          id: 'acc-special-manual',
          user_id: 'user-3',
          email: 'user3@example.com',
          uuid,
          inbound_id: 2,
          data_limit: '100GB',
          total_bytes: 100 * GB,
          expiry_time: prevExpiryMs,
          expiry_date: new Date(prevExpiryMs).toISOString(),
          status: 'active',
          enable: true,
        },
      ],
      renew_requests: [
        {
          id: 'req-special-100-manual',
          user_id: 'user-3',
          user_email: 'user3@example.com',
          plan_name: 'Mobitel Zoom (Summer Promo - 3 Months)',
          status: 'pending',
          provisioning_status: 'pending',
          notes: JSON.stringify({
            planId: 'sim_100',
            is_special_offer: true,
            offer_name: 'Summer Promo',
            package_id: 'mobitel_zoom',
            package_name: 'Mobitel Zoom',
            durationMonths: 3,
            vpn_account_id: 'acc-special-manual',
            uuid,
            old_expiry: new Date(prevExpiryMs).toISOString(),
          }),
        },
      ],
    },
  });

  const res = await executeRenewalApproval('req-special-100-manual', {
    dbClient: db,
    nowMs: fixedNow,
    skipSideEffects: true,
    getInboundsFn: async () => [buildLiveInbound(liveClients, [], 2)],
    requestApiFn: async <T>(ep: string, _method?: 'GET' | 'POST', data?: any): Promise<T> => {
      if (ep === `/panel/api/inbounds/updateClient/${uuid}` && data?.settings) {
        const updatedClient = JSON.parse(data.settings).clients[0];
        liveClients = liveClients.map((c) => (c.id === uuid ? { ...c, ...updatedClient } : c));
        return { success: true } as unknown as T;
      }
      throw new Error(`Unexpected endpoint: ${ep}`);
    },
  });

  assert.equal(res.success, true);
  assert.equal(liveClients[0].totalGB, 400 * GB, 'Manual approval of 3-month 100GB Special Offer must add 300GB');
  assert.notEqual(liveClients[0].totalGB, 0, 'Manual approval must NEVER turn 100GB Special Offer into Unlimited');
  assert.equal(db.tables.vpn_accounts[0].total_bytes, 400 * GB);
  assert.equal(db.tables.vpn_accounts[0].data_limit, '400GB');
});

// -----------------------------------------------------------------------------
// Scenario 4: Unlimited renewals (SIM Unlimited & Router Unlimited)
// -----------------------------------------------------------------------------
test('Scenario 4: SIM Unlimited and Router Unlimited renewals extend expiry cleanly with totalGB=0', async () => {
  const fixedNow = Date.UTC(2026, 10, 27, 10, 0, 0);
  const prevExpiryMs = Date.UTC(2026, 11, 10, 10, 0, 0);
  const uuid = '44444444-4444-4444-8444-444444444444';

  // Router catalog resolution even on legacy request without explicit "Unlimited" text
  const routerCatalogQuota = resolveAuthoritativeRenewalQuota({
    renewRequest: { plan_name: 'SLT FIBER ZOOM (Summer Promo - 3 Months)' },
    extraNotes: { package_id: 'slt_fiber_zoom', package_name: 'SLT FIBER ZOOM', is_special_offer: true, durationMonths: 3 },
    durationMonths: 3,
    vpnAccount: { total_bytes: 0, data_limit: 'Unlimited' },
    liveClientTotalBytes: 0,
  });
  assert.equal(routerCatalogQuota.resolved, true);
  assert.equal(routerCatalogQuota.quotaMode, 'unlimited');
  assert.equal(routerCatalogQuota.canonicalPlanId, 'router_unlimited');
  assert.equal(routerCatalogQuota.addedQuotaBytes, 0);

  let liveClients = [
    {
      id: uuid,
      email: 'sim_unlimited_user',
      subId: 'sub_unlim',
      totalGB: 0,
      expiryTime: prevExpiryMs,
      enable: true,
      reset: 0,
    },
  ];
  const liveStats = [{ id: uuid, email: 'sim_unlimited_user', up: 40 * GB, down: 90 * GB }];

  const db = createRenewalMockDb({
    tables: {
      orders: [
        {
          id: 'ord-unlim',
          customer_id: 'user-4',
          email: 'user4@example.com',
          package_name: 'Hutch Zoom',
          status: 'completed',
          payment_status: 'Paid',
          provisioning_status: 'verified',
          expiry_date: new Date(prevExpiryMs).toISOString(),
          client_uuid: uuid,
        },
      ],
      vpn_accounts: [
        {
          id: 'acc-unlim',
          user_id: 'user-4',
          email: 'user4@example.com',
          order_id: 'ord-unlim',
          uuid,
          inbound_id: 2,
          data_limit: 'Unlimited',
          total_bytes: 0,
          expiry_time: prevExpiryMs,
          expiry_date: new Date(prevExpiryMs).toISOString(),
          status: 'active',
          enable: true,
        },
      ],
      renew_requests: [
        {
          id: 'req-unlim',
          user_id: 'user-4',
          user_email: 'user4@example.com',
          plan_name: 'Hutch Zoom - SIM Unlimited (Summer Promo - 3 Months)',
          status: 'pending',
          provisioning_status: 'pending',
          notes: JSON.stringify({
            planId: 'sim_unlimited',
            verified_plan_id: 'sim_unlimited',
            package_type: 'SIM Unlimited',
            data_limit: 'Unlimited',
            category: 'SIM',
            quota_mode: 'unlimited',
            monthly_quota_gb: null,
            quota_verified_by_server: true,
            is_special_offer: true,
            package_id: 'hutch_zoom',
            package_name: 'Hutch Zoom',
            durationMonths: 3,
            vpn_account_id: 'acc-unlim',
            uuid,
          }),
        },
      ],
    },
  });

  const result = await provisionProvisionalRenewal('req-unlim', {
    dbClient: db,
    nowMs: fixedNow,
    skipSideEffects: true,
    getInboundsFn: async () => [buildLiveInbound(liveClients, liveStats, 2)],
    requestApiFn: async <T>(ep: string, method?: 'GET' | 'POST', data?: any): Promise<T> => {
      if (ep === '/panel/api/inbounds/get/2' && method === 'GET') {
        return { success: true, obj: buildLiveInbound(liveClients, liveStats, 2) } as unknown as T;
      }
      if (ep === '/panel/api/inbounds/update/2' && method === 'POST') {
        liveClients = JSON.parse(data.settings).clients;
        return { success: true } as unknown as T;
      }
      throw new Error(`Unexpected API call: ${method} ${ep}`);
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.autoRenewed, true);
  assert.equal(result.addedQuotaBytes, 0);
  assert.equal(result.grantedTotalBytes, 0);
  assert.equal(result.grantedExpiryMs, addCalendarMonths(prevExpiryMs, 3));
  assert.equal(liveClients[0].totalGB, 0);
});

// -----------------------------------------------------------------------------
// Scenario 5: Missing or ambiguous legacy metadata FAILS CLOSED with zero 3X-UI writes
// -----------------------------------------------------------------------------
test('Scenario 5: Missing or ambiguous legacy metadata never defaults to Unlimited and blocks 3X-UI mutations', async () => {
  // Bare "100" without GB/sim_100 must NOT falsely match
  assert.equal(parseExplicitRenewalQuotaSignal('Promo 100 Special').kind, 'none');
  // Contradictory single string must be ambiguous
  assert.equal(parseExplicitRenewalQuotaSignal('SIM 100GB Unlimited').kind, 'ambiguous');

  const fixedNow = Date.UTC(2026, 10, 27, 10, 0, 0);
  const prevExpiryMs = Date.UTC(2026, 11, 10, 10, 0, 0);
  const uuid = '55555555-5555-4555-8555-555555555555';
  let xuiWriteCount = 0;

  const liveClients = [
    {
      id: uuid,
      email: 'legacy_missing_meta',
      subId: 'sub_legacy',
      totalGB: 100 * GB,
      expiryTime: prevExpiryMs,
      enable: true,
      reset: 0,
    },
  ];

  const db = createRenewalMockDb({
    tables: {
      orders: [
        {
          id: 'ord-legacy-missing',
          customer_id: 'user-5',
          email: 'user5@example.com',
          package_name: 'Mobitel Zoom',
          status: 'completed',
          payment_status: 'Paid',
          provisioning_status: 'verified',
          expiry_date: new Date(prevExpiryMs).toISOString(),
          client_uuid: uuid,
        },
      ],
      vpn_accounts: [
        {
          id: 'acc-legacy-missing',
          user_id: 'user-5',
          email: 'user5@example.com',
          order_id: 'ord-legacy-missing',
          uuid,
          inbound_id: 2,
          data_limit: '100GB',
          total_bytes: 100 * GB,
          expiry_time: prevExpiryMs,
          expiry_date: new Date(prevExpiryMs).toISOString(),
          status: 'active',
          enable: true,
        },
      ],
      renew_requests: [
        {
          id: 'req-legacy-missing',
          user_id: 'user-5',
          user_email: 'user5@example.com',
          plan_name: 'Mobitel Zoom (Summer Promo - 3 Months)',
          status: 'pending',
          provisioning_status: 'pending',
          notes: JSON.stringify({
            is_special_offer: true,
            package_id: 'mobitel_zoom',
            package_name: 'Mobitel Zoom',
            durationMonths: 3,
            vpn_account_id: 'acc-legacy-missing',
            uuid,
            old_expiry: new Date(prevExpiryMs).toISOString(),
          }),
        },
      ],
    },
  });

  // 5a: Automatic provisional renewal holds for manual reconciliation with zero 3X-UI writes
  const autoRes = await provisionProvisionalRenewal('req-legacy-missing', {
    dbClient: db,
    nowMs: fixedNow,
    skipSideEffects: true,
    getInboundsFn: async () => [buildLiveInbound(liveClients, [], 2)],
    requestApiFn: async () => {
      xuiWriteCount++;
      throw new Error('Must never touch 3X-UI on unverified quota metadata');
    },
  });

  assert.equal(autoRes.success, false);
  assert.equal(autoRes.autoRenewed, false);
  assert.equal(autoRes.provisioningStatus, 'pending');
  assert.equal(autoRes.blockedReason, 'UNVERIFIED_RENEWAL_QUOTA_METADATA');
  assert.equal(xuiWriteCount, 0);
  assert.equal(db.locks.get(`client:${uuid}`)?.status, 'failed');
  assert.equal(db.locks.get('renew:req-legacy-missing')?.status, 'failed');

  // 5b: Manual approval ALSO fails closed with 409 UNVERIFIED_RENEWAL_QUOTA_METADATA and zero 3X-UI writes
  await assert.rejects(
    async () => {
      await executeRenewalApproval('req-legacy-missing', {
        dbClient: db,
        nowMs: fixedNow,
        skipSideEffects: true,
        getInboundsFn: async () => [buildLiveInbound(liveClients, [], 2)],
        requestApiFn: async () => {
          xuiWriteCount++;
          throw new Error('Must never touch 3X-UI on unverified quota metadata');
        },
      });
    },
    (err: any) => err?.statusCode === 409 && err?.code === 'UNVERIFIED_RENEWAL_QUOTA_METADATA'
  );
  assert.equal(xuiWriteCount, 0);

  // 5c: Direct updateClientExpiry with unknown/empty planName also fails closed before any 3X-UI write
  await assert.rejects(
    async () => {
      await updateClientExpiry(uuid, 3, 'Mobitel Zoom (Summer Promo - 3 Months)', prevExpiryMs, {
        dbClient: db,
        nowMs: fixedNow,
        getInboundsFn: async () => [buildLiveInbound(liveClients, [], 2)],
        requestApiFn: async () => {
          xuiWriteCount++;
          throw new Error('Must never touch 3X-UI');
        },
      });
    },
    (err: any) => err?.statusCode === 409 && err?.code === 'UNVERIFIED_RENEWAL_QUOTA_METADATA'
  );
  assert.equal(xuiWriteCount, 0);
});

// -----------------------------------------------------------------------------
// Scenario 6: Forged customer-submitted quota metadata blocked at controller AND resolver
// -----------------------------------------------------------------------------
test('Scenario 6: Forged customer-submitted quota metadata is rejected with HTTP 400 and blocked by resolver', async () => {
  const uuid = '66666666-6666-4666-8666-666666666666';
  const db = createRenewalMockDb({
    tables: {
      vpn_accounts: [
        {
          id: 'acc-forged-6',
          user_id: 'user-6',
          email: 'user6@example.com',
          uuid,
          data_limit: '100GB',
          total_bytes: 100 * GB,
          status: 'active',
        },
      ],
    },
  });

  // 6a: Conflicting planId='sim_100' + forged dataLimit='Unlimited' -> HTTP 400
  const req1: any = {
    user: { uid: 'user-6', id: 'user-6', email: 'user6@example.com' },
    dbClient: db,
    body: {
      planId: 'sim_100',
      dataLimit: 'Unlimited',
      packageType: 'SIM Unlimited',
      durationMonths: 1,
      vpn_account_id: 'acc-forged-6',
      uuid,
      quota_verified_by_server: true,
      verified_plan_id: 'sim_unlimited',
    },
  };
  const res1 = createMockExpressRes();
  await createRenewRequest(req1, res1);
  assert.equal(res1.statusCode, 400);
  assert.equal(res1.body?.code, 'CONFLICTING_QUOTA_METADATA');
  assert.equal(db.tables.renew_requests.length, 0, 'No renew_requests row may be created on forged metadata');

  // 6b: Non-standard forged quota '9999GB' -> HTTP 400
  const req2: any = {
    user: { uid: 'user-6', id: 'user-6', email: 'user6@example.com' },
    dbClient: db,
    body: {
      planId: 'sim_100',
      dataLimit: '9999GB',
      durationMonths: 1,
      vpn_account_id: 'acc-forged-6',
      uuid,
    },
  };
  const res2 = createMockExpressRes();
  await createRenewRequest(req2, res2);
  assert.equal(res2.statusCode, 400);
  assert.equal(res2.body?.code, 'INVALID_QUOTA_METADATA');

  // 6c: Defense-in-depth resolver blocks Special Offer Unlimited spoof on a finite 100GB account
  const spoofedSpecialOffer = resolveAuthoritativeRenewalQuota({
    renewRequest: { plan_name: 'Mobitel Zoom - SIM Unlimited (Summer Promo - 3 Months)' },
    extraNotes: {
      planId: 'sim_unlimited',
      verified_plan_id: 'sim_unlimited',
      package_type: 'SIM Unlimited',
      data_limit: 'Unlimited',
      quota_mode: 'unlimited',
      quota_verified_by_server: true,
      is_special_offer: true,
      package_id: 'mobitel_zoom',
      package_name: 'Mobitel Zoom',
      durationMonths: 3,
    },
    durationMonths: 3,
    vpnAccount: { total_bytes: 100 * GB, data_limit: '100GB' },
    liveClientTotalBytes: 100 * GB,
  });
  assert.equal(spoofedSpecialOffer.resolved, false);
  assert.equal(spoofedSpecialOffer.blockedReason, 'CONFLICTING_SPECIAL_OFFER_QUOTA_METADATA');
});

// -----------------------------------------------------------------------------
// Scenario 7: Active, expired (Option 4B), and exhausted unexpired clients
// -----------------------------------------------------------------------------
test('Scenario 7: Active, expired (Option 4B), and exhausted unexpired finite clients compute exact quotas without resetting counters', () => {
  const now = Date.UTC(2026, 10, 27, 10, 0, 0);

  // 7a: Active finite (100GB total, 35GB used) + 100GB -> 200GB total, expiry extends from previousExpiryMs
  const activePrevExp = now + 10 * 24 * 60 * 60 * 1000;
  const activeCalc = calculateApprovedRenewalEntitlement({
    previousExpiryMs: activePrevExp,
    previousTotalBytes: 100 * GB,
    liveUpBytes: 10 * GB,
    liveDownBytes: 25 * GB,
    liveEnable: true,
    inboundEnable: true,
    dbAccountStatus: 'active',
    addedDurationMonths: 1,
    addedQuotaBytes: 100 * GB,
    nowMs: now,
  });
  assert.equal(activeCalc.eligible, true);
  assert.equal(activeCalc.mode, 'active_finite');
  assert.equal(activeCalc.grantedExpiryMs, addCalendarMonths(activePrevExp, 1));
  assert.equal(activeCalc.grantedTotalBytes, 200 * GB);

  // 7b: Expired finite (Option 4B): 100GB old total, 62GB cumulative used -> (62GB + 300GB) = 362GB, expiry from now
  const expiredPrevExp = now - 5 * 24 * 60 * 60 * 1000;
  const expiredCalc = calculateApprovedRenewalEntitlement({
    previousExpiryMs: expiredPrevExp,
    previousTotalBytes: 100 * GB,
    liveUpBytes: 12 * GB,
    liveDownBytes: 50 * GB,
    liveEnable: true,
    inboundEnable: true,
    dbAccountStatus: 'expired',
    addedDurationMonths: 3,
    addedQuotaBytes: 300 * GB,
    nowMs: now,
  });
  assert.equal(expiredCalc.eligible, true);
  assert.equal(expiredCalc.mode, 'expired_finite_option_4b');
  assert.equal(expiredCalc.grantedExpiryMs, addCalendarMonths(now, 3));
  assert.equal(expiredCalc.grantedTotalBytes, 362 * GB);

  // 7c: Exhausted unexpired finite: 100GB old total, 108GB cumulative used -> max(100, 108) + 100 = 208GB
  const exhaustedCalc = calculateApprovedRenewalEntitlement({
    previousExpiryMs: activePrevExp,
    previousTotalBytes: 100 * GB,
    liveUpBytes: 28 * GB,
    liveDownBytes: 80 * GB,
    liveEnable: true,
    inboundEnable: true,
    dbAccountStatus: 'active',
    addedDurationMonths: 1,
    addedQuotaBytes: 100 * GB,
    nowMs: now,
  });
  assert.equal(exhaustedCalc.eligible, true);
  assert.equal(exhaustedCalc.mode, 'exhausted_finite');
  assert.equal(exhaustedCalc.grantedExpiryMs, addCalendarMonths(activePrevExp, 1));
  assert.equal(exhaustedCalc.grantedTotalBytes, 208 * GB);
});

// -----------------------------------------------------------------------------
// Scenario 8: Approval of provisional renewal does NOT extend expiry or quota twice
// -----------------------------------------------------------------------------
test('Scenario 8: Admin approval confirms provisional renewal without double expiry or double quota', async () => {
  const fixedNow = Date.UTC(2026, 10, 27, 10, 0, 0);
  const prevExpiryMs = Date.UTC(2026, 11, 5, 10, 0, 0);
  const uuid = '88888888-8888-4888-8888-888888888888';

  let liveClients = [
    {
      id: uuid,
      email: 'no_double_grant',
      subId: 'sub_no_double',
      totalGB: 100 * GB,
      expiryTime: prevExpiryMs,
      enable: true,
      reset: 0,
    },
  ];
  let postMutationCount = 0;

  const db = createRenewalMockDb({
    tables: {
      orders: [
        {
          id: 'ord-8',
          customer_id: 'user-8',
          email: 'user8@example.com',
          package_name: 'Mobitel Zoom',
          status: 'completed',
          payment_status: 'Paid',
          provisioning_status: 'verified',
          expiry_date: new Date(prevExpiryMs).toISOString(),
          client_uuid: uuid,
        },
      ],
      vpn_accounts: [
        {
          id: 'acc-8',
          user_id: 'user-8',
          email: 'user8@example.com',
          order_id: 'ord-8',
          uuid,
          inbound_id: 2,
          data_limit: '100GB',
          total_bytes: 100 * GB,
          expiry_time: prevExpiryMs,
          expiry_date: new Date(prevExpiryMs).toISOString(),
          status: 'active',
          enable: true,
        },
      ],
      vpn_configs: [
        {
          id: 'cfg-8',
          order_id: 'ord-8',
          uuid,
          package_name: 'Mobitel Zoom',
          data_limit: '100GB',
          expiry_date: new Date(prevExpiryMs).toISOString(),
          status: 'active',
          enabled: true,
        },
      ],
      renew_requests: [
        {
          id: 'req-8',
          user_id: 'user-8',
          user_email: 'user8@example.com',
          plan_name: 'Mobitel Zoom - SIM 100GB (Summer Promo - 3 Months)',
          status: 'pending',
          provisioning_status: 'pending',
          notes: JSON.stringify({
            planId: 'sim_100',
            verified_plan_id: 'sim_100',
            package_type: 'SIM 100GB',
            data_limit: '100GB',
            category: 'SIM',
            quota_mode: 'finite',
            monthly_quota_gb: 100,
            quota_verified_by_server: true,
            is_special_offer: true,
            durationMonths: 3,
            vpn_account_id: 'acc-8',
            uuid,
          }),
        },
      ],
    },
  });

  // Step 1: Provisionally renew
  const provRes = await provisionProvisionalRenewal('req-8', {
    dbClient: db,
    nowMs: fixedNow,
    skipSideEffects: true,
    getInboundsFn: async () => [buildLiveInbound(liveClients, [], 2)],
    requestApiFn: async <T>(ep: string, method?: 'GET' | 'POST', data?: any): Promise<T> => {
      if (ep === '/panel/api/inbounds/get/2' && method === 'GET') {
        return { success: true, obj: buildLiveInbound(liveClients, [], 2) } as unknown as T;
      }
      if (ep === '/panel/api/inbounds/update/2' && method === 'POST') {
        postMutationCount++;
        liveClients = JSON.parse(data.settings).clients;
        return { success: true } as unknown as T;
      }
      throw new Error(`Unexpected API call: ${method} ${ep}`);
    },
  });
  assert.equal(provRes.autoRenewed, true);
  assert.equal(postMutationCount, 1);
  const expectedFinalExpiry = addCalendarMonths(prevExpiryMs, 3);
  assert.equal(liveClients[0].expiryTime, expectedFinalExpiry);
  assert.equal(liveClients[0].totalGB, 400 * GB);

  // Step 2: Admin approves -> confirms provisional grant with ZERO additional 3X-UI writes
  const approveRes = await executeRenewalApproval('req-8', {
    dbClient: db,
    nowMs: fixedNow + 60_000,
    skipSideEffects: true,
    getInboundsFn: async () => [buildLiveInbound(liveClients, [], 2)],
    requestApiFn: async () => {
      postMutationCount++;
      throw new Error('Approval of provisional renewal must NOT mutate 3X-UI a second time');
    },
  });

  assert.equal(approveRes.success, true);
  assert.equal(approveRes.provisionalConfirmed, true);
  assert.equal(postMutationCount, 1, '3X-UI must NOT be written twice');
  assert.equal(liveClients[0].expiryTime, expectedFinalExpiry);
  assert.equal(liveClients[0].totalGB, 400 * GB);
  assert.equal(db.tables.renew_requests[0].status, 'approved');
  assert.equal(db.tables.vpn_entitlement_grants[0].status, 'verified');
});

// -----------------------------------------------------------------------------
// Scenario 9: Rejection rolls back provisional renewal and preserves previously paid entitlement
// -----------------------------------------------------------------------------
test('Scenario 9: Admin rejection rolls back provisional renewal and preserves original paid expiry and quota', async () => {
  const fixedNow = Date.UTC(2026, 10, 27, 10, 0, 0);
  const prevExpiryMs = Date.UTC(2026, 11, 15, 10, 0, 0);
  const uuid = '99999999-9999-4999-8999-999999999999';

  let liveClients = [
    {
      id: uuid,
      email: 'rollback_paid_user',
      subId: 'sub_paid_keep',
      totalGB: 100 * GB,
      expiryTime: prevExpiryMs,
      enable: true,
      reset: 0,
    },
  ];

  const db = createRenewalMockDb({
    tables: {
      orders: [
        {
          id: 'ord-9',
          customer_id: 'user-9',
          email: 'user9@example.com',
          package_name: 'Mobitel Zoom',
          status: 'completed',
          payment_status: 'Paid',
          provisioning_status: 'verified',
          expiry_date: new Date(prevExpiryMs).toISOString(),
          client_uuid: uuid,
        },
      ],
      vpn_accounts: [
        {
          id: 'acc-9',
          user_id: 'user-9',
          email: 'user9@example.com',
          order_id: 'ord-9',
          uuid,
          inbound_id: 2,
          data_limit: '100GB',
          total_bytes: 100 * GB,
          expiry_time: prevExpiryMs,
          expiry_date: new Date(prevExpiryMs).toISOString(),
          status: 'active',
          enable: true,
        },
      ],
      vpn_configs: [
        {
          id: 'cfg-9',
          order_id: 'ord-9',
          uuid,
          package_name: 'Mobitel Zoom',
          data_limit: '100GB',
          expiry_date: new Date(prevExpiryMs).toISOString(),
          status: 'active',
          enabled: true,
        },
      ],
      renew_requests: [
        {
          id: 'req-9',
          user_id: 'user-9',
          user_email: 'user9@example.com',
          plan_name: 'Mobitel Zoom - SIM 100GB (Summer Promo - 3 Months)',
          status: 'pending',
          provisioning_status: 'pending',
          notes: JSON.stringify({
            planId: 'sim_100',
            verified_plan_id: 'sim_100',
            package_type: 'SIM 100GB',
            data_limit: '100GB',
            category: 'SIM',
            quota_mode: 'finite',
            monthly_quota_gb: 100,
            quota_verified_by_server: true,
            is_special_offer: true,
            durationMonths: 3,
            vpn_account_id: 'acc-9',
            uuid,
          }),
        },
      ],
    },
  });

  const apiMock = async <T>(ep: string, method?: 'GET' | 'POST', data?: any): Promise<T> => {
    if (ep === '/panel/api/inbounds/get/2' && method === 'GET') {
      return { success: true, obj: buildLiveInbound(liveClients, [], 2) } as unknown as T;
    }
    if (ep === '/panel/api/inbounds/update/2' && method === 'POST') {
      liveClients = JSON.parse(data.settings).clients;
      return { success: true } as unknown as T;
    }
    throw new Error(`Unexpected API call: ${method} ${ep}`);
  };

  // Provisionally renew first (+3 months, +300GB)
  const provRes = await provisionProvisionalRenewal('req-9', {
    dbClient: db,
    nowMs: fixedNow,
    skipSideEffects: true,
    getInboundsFn: async () => [buildLiveInbound(liveClients, [], 2)],
    requestApiFn: apiMock,
  });
  assert.equal(provRes.autoRenewed, true);
  assert.equal(liveClients[0].totalGB, 400 * GB);

  // Admin rejects fake slip -> restores exact paid entitlement (prevExpiryMs, 100GB, enable=true, orders.payment_status='Paid')
  const rejectRes = await executeRenewalRejection('req-9', 'Fake payment slip', {
    dbClient: db,
    skipSideEffects: true,
    getInboundsFn: async () => [buildLiveInbound(liveClients, [], 2)],
    requestApiFn: apiMock,
  });

  assert.equal(rejectRes.success, true);
  assert.equal(rejectRes.provisionalRevoked, true);
  assert.equal(liveClients[0].expiryTime, prevExpiryMs, 'Paid expiry must be restored exactly');
  assert.equal(liveClients[0].totalGB, 100 * GB, 'Paid 100GB quota must be restored exactly');
  assert.equal(liveClients[0].enable, true, 'Paid client must remain enabled');
  assert.equal(db.tables.orders[0].payment_status, 'Paid', 'Parent paid order must remain Paid');
  assert.equal(db.tables.renew_requests[0].status, 'rejected');
  assert.equal(db.tables.vpn_entitlement_grants[0].status, 'revoked');
});

// -----------------------------------------------------------------------------
// Scenario 10: Pre-dispatch cancellation aborts cleanly with zero 3X-UI writes and 'failed' locks
// -----------------------------------------------------------------------------
test('Scenario 10: Pre-dispatch AbortSignal cancellation prevents 3X-UI writes, deletes provisioning grant, and finalizes locks as failed', async () => {
  const fixedNow = Date.UTC(2026, 10, 27, 10, 0, 0);
  const prevExpiryMs = Date.UTC(2026, 11, 5, 10, 0, 0);
  const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let xuiPostCalled = false;

  const liveClients = [
    {
      id: uuid,
      email: 'pre_cancel_user',
      subId: 'sub_cancel',
      totalGB: 100 * GB,
      expiryTime: prevExpiryMs,
      enable: true,
      reset: 0,
    },
  ];

  const db = createRenewalMockDb({
    tables: {
      orders: [
        {
          id: 'ord-10',
          customer_id: 'user-10',
          email: 'user10@example.com',
          package_name: 'Mobitel Zoom',
          status: 'completed',
          payment_status: 'Paid',
          provisioning_status: 'verified',
          expiry_date: new Date(prevExpiryMs).toISOString(),
          client_uuid: uuid,
        },
      ],
      vpn_accounts: [
        {
          id: 'acc-10',
          user_id: 'user-10',
          email: 'user10@example.com',
          order_id: 'ord-10',
          uuid,
          inbound_id: 2,
          data_limit: '100GB',
          total_bytes: 100 * GB,
          expiry_time: prevExpiryMs,
          expiry_date: new Date(prevExpiryMs).toISOString(),
          status: 'active',
          enable: true,
        },
      ],
      renew_requests: [
        {
          id: 'req-10',
          user_id: 'user-10',
          user_email: 'user10@example.com',
          plan_name: 'Mobitel Zoom (SIM 100GB)',
          status: 'pending',
          provisioning_status: 'pending',
          notes: JSON.stringify({
            planId: 'sim_100',
            verified_plan_id: 'sim_100',
            package_type: 'SIM 100GB',
            data_limit: '100GB',
            quota_mode: 'finite',
            monthly_quota_gb: 100,
            quota_verified_by_server: true,
            durationMonths: 1,
            vpn_account_id: 'acc-10',
            uuid,
          }),
        },
      ],
    },
  });

  const controller = new AbortController();

  const res = await provisionProvisionalRenewal('req-10', {
    dbClient: db,
    nowMs: fixedNow,
    skipSideEffects: true,
    signal: controller.signal,
    getInboundsFn: async () => [buildLiveInbound(liveClients, [], 2)],
    requestApiFn: async <T>(ep: string, method?: 'GET' | 'POST', _data?: any, options?: any): Promise<T> => {
      if (ep === '/panel/api/inbounds/get/2' && method === 'GET') {
        // Trigger cancellation right after inbound GET, BEFORE POST dispatch!
        controller.abort();
        return { success: true, obj: buildLiveInbound(liveClients, [], 2) } as unknown as T;
      }
      if (method === 'POST') {
        if (options?.beforeSend) await options.beforeSend();
        xuiPostCalled = true;
        return { success: true } as unknown as T;
      }
      throw new Error(`Unexpected API call: ${method} ${ep}`);
    },
  });

  assert.equal(xuiPostCalled, false, 'POST mutation must NEVER be dispatched after AbortSignal fires');
  assert.equal(res.success, false);
  assert.equal(res.autoRenewed, false);
  assert.equal(res.provisioningStatus, 'pending');
  assert.equal(res.blockedReason, 'REQUEST_TIMEOUT_BEFORE_MUTATION');
  assert.equal(db.tables.vpn_entitlement_grants.length, 0, 'Temporary provisioning grant must be deleted');
  assert.equal(db.tables.renew_requests[0].provisioning_status, 'pending');
  assert.equal(db.locks.get('renew:req-10')?.status, 'failed');
  assert.equal(db.locks.get(`client:${uuid}`)?.status, 'failed');
  assert.equal(db.locks.get('inbound:2')?.status, 'failed');
});

// -----------------------------------------------------------------------------
// Scenario 11: Ambiguous post-dispatch timeout marks renew, client, AND inbound locks 'uncertain'
// -----------------------------------------------------------------------------
test('Scenario 11: Ambiguous post-dispatch timeout marks renew, client, inbound locks, grant, and request as uncertain', async () => {
  const fixedNow = Date.UTC(2026, 10, 27, 10, 0, 0);
  const prevExpiryMs = Date.UTC(2026, 11, 5, 10, 0, 0);
  const uuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const liveClients = [
    {
      id: uuid,
      email: 'post_timeout_user',
      subId: 'sub_timeout',
      totalGB: 100 * GB,
      expiryTime: prevExpiryMs,
      enable: true,
      reset: 0,
    },
  ];

  const db = createRenewalMockDb({
    tables: {
      orders: [
        {
          id: 'ord-11',
          customer_id: 'user-11',
          email: 'user11@example.com',
          package_name: 'Mobitel Zoom',
          status: 'completed',
          payment_status: 'Paid',
          provisioning_status: 'verified',
          expiry_date: new Date(prevExpiryMs).toISOString(),
          client_uuid: uuid,
        },
      ],
      vpn_accounts: [
        {
          id: 'acc-11',
          user_id: 'user-11',
          email: 'user11@example.com',
          order_id: 'ord-11',
          uuid,
          inbound_id: 2,
          data_limit: '100GB',
          total_bytes: 100 * GB,
          expiry_time: prevExpiryMs,
          expiry_date: new Date(prevExpiryMs).toISOString(),
          status: 'active',
          enable: true,
        },
      ],
      renew_requests: [
        {
          id: 'req-11',
          user_id: 'user-11',
          user_email: 'user11@example.com',
          plan_name: 'Mobitel Zoom (SIM 100GB)',
          status: 'pending',
          provisioning_status: 'pending',
          notes: JSON.stringify({
            planId: 'sim_100',
            verified_plan_id: 'sim_100',
            package_type: 'SIM 100GB',
            data_limit: '100GB',
            quota_mode: 'finite',
            monthly_quota_gb: 100,
            quota_verified_by_server: true,
            durationMonths: 1,
            vpn_account_id: 'acc-11',
            uuid,
          }),
        },
      ],
    },
  });

  const res = await provisionProvisionalRenewal('req-11', {
    dbClient: db,
    nowMs: fixedNow,
    skipSideEffects: true,
    getInboundsFn: async () => [buildLiveInbound(liveClients, [], 2)],
    requestApiFn: async <T>(ep: string, method?: 'GET' | 'POST'): Promise<T> => {
      if (ep === '/panel/api/inbounds/get/2' && method === 'GET') {
        return { success: true, obj: buildLiveInbound(liveClients, [], 2) } as unknown as T;
      }
      if (ep === '/panel/api/inbounds/update/2' && method === 'POST') {
        const err: any = new Error('timeout of 15000ms exceeded');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      throw new Error(`Unexpected API call: ${method} ${ep}`);
    },
  });

  assert.equal(res.success, false);
  assert.equal(res.autoRenewed, false);
  assert.equal(res.provisioningStatus, 'uncertain');
  assert.equal(db.tables.vpn_entitlement_grants[0].status, 'uncertain');
  assert.equal(db.tables.renew_requests[0].provisioning_status, 'uncertain');
  assert.equal(db.locks.get('renew:req-11')?.status, 'uncertain', 'renew:<id> lock must be uncertain');
  assert.equal(db.locks.get(`client:${uuid}`)?.status, 'uncertain', 'client:<uuid> lock must be uncertain');
  assert.equal(db.locks.get('inbound:2')?.status, 'uncertain', 'inbound:<id> lock must be uncertain');
});

// -----------------------------------------------------------------------------
// Scenario 12: Uncertain lock protection (allowUncertainRecovery: false retained!)
// -----------------------------------------------------------------------------
test('Scenario 12: Uncertain renew:<id> lock blocks Admin Approve and Reject with 409 RECONCILIATION_REQUIRED (allowUncertainRecovery=false)', async () => {
  const uuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const db = createRenewalMockDb({
    tables: {
      renew_requests: [
        {
          id: 'req-12-uncertain',
          user_id: 'user-12',
          user_email: 'user12@example.com',
          plan_name: 'Mobitel Zoom (SIM 100GB)',
          status: 'pending',
          provisioning_status: 'uncertain',
          notes: JSON.stringify({ planId: 'sim_100', uuid }),
        },
      ],
    },
    initialLocks: {
      'renew:req-12-uncertain': {
        operation_type: 'auto_renew',
        target_id: 'req-12-uncertain',
        status: 'uncertain',
        client_uuid: uuid,
        error_message: 'Prior 3X-UI timeout',
      },
    },
  });

  let xuiTouched = false;

  await assert.rejects(
    async () => {
      await executeRenewalApproval('req-12-uncertain', {
        dbClient: db,
        skipSideEffects: true,
        requestApiFn: async () => {
          xuiTouched = true;
          return {} as any;
        },
      });
    },
    (err: any) => err?.statusCode === 409 && err?.code === 'RECONCILIATION_REQUIRED'
  );

  await assert.rejects(
    async () => {
      await executeRenewalRejection('req-12-uncertain', 'Reject attempt', {
        dbClient: db,
        skipSideEffects: true,
        requestApiFn: async () => {
          xuiTouched = true;
          return {} as any;
        },
      });
    },
    (err: any) => err?.statusCode === 409 && err?.code === 'RECONCILIATION_REQUIRED'
  );

  assert.equal(xuiTouched, false);
  const acquireCalls = db.rpcCalls.filter((c: any) => c.fn === 'acquire_provisioning_lock');
  assert.ok(acquireCalls.length >= 2);
  for (const call of acquireCalls) {
    assert.equal(
      call.args.p_allow_uncertain_recovery,
      false,
      'allowUncertainRecovery MUST remain false on renew:<id>'
    );
  }
});

// -----------------------------------------------------------------------------
// Scenario 13: Deleted clients are NEVER recreated during automatic or manual renewal
// -----------------------------------------------------------------------------
test('Scenario 13: Clients deleted from 3X-UI are never recreated by automatic or manual renewal', async () => {
  const fixedNow = Date.UTC(2026, 10, 27, 10, 0, 0);
  const prevExpiryMs = Date.UTC(2026, 11, 5, 10, 0, 0);
  const deletedUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const apiEndpointsCalled: string[] = [];

  const db = createRenewalMockDb({
    tables: {
      orders: [
        {
          id: 'ord-13',
          customer_id: 'user-13',
          email: 'user13@example.com',
          package_name: 'Mobitel Zoom',
          status: 'completed',
          payment_status: 'Paid',
          provisioning_status: 'verified',
          expiry_date: new Date(prevExpiryMs).toISOString(),
          client_uuid: deletedUuid,
        },
      ],
      vpn_accounts: [
        {
          id: 'acc-13',
          user_id: 'user-13',
          email: 'user13@example.com',
          order_id: 'ord-13',
          uuid: deletedUuid,
          inbound_id: 2,
          data_limit: '100GB',
          total_bytes: 100 * GB,
          expiry_time: prevExpiryMs,
          expiry_date: new Date(prevExpiryMs).toISOString(),
          status: 'active',
          enable: true,
        },
      ],
      renew_requests: [
        {
          id: 'req-13-deleted',
          user_id: 'user-13',
          user_email: 'user13@example.com',
          plan_name: 'Mobitel Zoom (SIM 100GB)',
          status: 'pending',
          provisioning_status: 'pending',
          notes: JSON.stringify({
            planId: 'sim_100',
            verified_plan_id: 'sim_100',
            package_type: 'SIM 100GB',
            data_limit: '100GB',
            quota_mode: 'finite',
            monthly_quota_gb: 100,
            quota_verified_by_server: true,
            durationMonths: 1,
            vpn_account_id: 'acc-13',
            uuid: deletedUuid,
            old_expiry: new Date(prevExpiryMs).toISOString(),
          }),
        },
      ],
    },
  });

  // Live inbound has ZERO matching clients (deleted from 3X-UI)
  const emptyInbound = buildLiveInbound([], [], 2);

  const autoRes = await provisionProvisionalRenewal('req-13-deleted', {
    dbClient: db,
    nowMs: fixedNow,
    skipSideEffects: true,
    getInboundsFn: async () => [emptyInbound],
    requestApiFn: async <T>(ep: string): Promise<T> => {
      apiEndpointsCalled.push(ep);
      return { success: true } as unknown as T;
    },
  });

  assert.equal(autoRes.success, false);
  assert.equal(autoRes.autoRenewed, false);
  assert.equal(autoRes.blockedReason, 'xui_client_not_found');

  await assert.rejects(
    async () => {
      await executeRenewalApproval('req-13-deleted', {
        dbClient: db,
        nowMs: fixedNow,
        skipSideEffects: true,
        getInboundsFn: async () => [emptyInbound],
        requestApiFn: async <T>(ep: string): Promise<T> => {
          apiEndpointsCalled.push(ep);
          return { success: true } as unknown as T;
        },
      });
    },
    /not found in 3X-UI/i
  );

  assert.equal(
    apiEndpointsCalled.some((ep) => /addClient|inbounds\/add/i.test(ep)),
    false,
    'Deleted client must NEVER be recreated via addClient/add'
  );
  assert.equal(apiEndpointsCalled.length, 0);
});

// -----------------------------------------------------------------------------
// Scenario 14: Non-allowlisted customers stay on manual renewal path + sanitized blocked reason persistence
// -----------------------------------------------------------------------------
test('Scenario 14: Non-allowlisted customers stay on manual queue with server-verified quota metadata; allowlisted held renewals persist sanitized blocked reason', async () => {
  const prevEnabled = process.env.AUTO_ACTIVATE_RENEWALS_ENABLED;
  const prevAllowlist = process.env.AUTO_ACTIVATE_RENEWALS_ALLOWLIST;
  process.env.AUTO_ACTIVATE_RENEWALS_ENABLED = 'true';
  process.env.AUTO_ACTIVATE_RENEWALS_ALLOWLIST = 'pilot@example.com';

  try {
    const uuid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const db = createRenewalMockDb({
      tables: {
        vpn_accounts: [
          {
            id: 'acc-14',
            user_id: 'user-non-pilot',
            email: 'regular@example.com',
            uuid,
            data_limit: '100GB',
            total_bytes: 100 * GB,
            status: 'active',
          },
          {
            id: 'acc-14-pilot',
            user_id: 'user-pilot',
            email: 'pilot@example.com',
            uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            data_limit: '100GB',
            total_bytes: 100 * GB,
            status: 'active',
          },
        ],
      },
    });

    // 14a: Non-allowlisted customer submits 1-month SIM 100GB renewal -> stays manual, persists verified quota metadata
    const reqManual: any = {
      user: { uid: 'user-non-pilot', id: 'user-non-pilot', email: 'regular@example.com' },
      dbClient: db,
      body: {
        planId: 'sim_100',
        packageId: 'mobitel_zoom',
        packageName: 'Mobitel Zoom',
        packageType: 'SIM 100GB',
        dataLimit: '100GB',
        durationMonths: 1,
        vpn_account_id: 'acc-14',
        uuid,
        slipUrl: 'payment-slips/renewals/user-non-pilot/slip.png',
        message: 'Paid via bank transfer',
      },
    };
    const resManual = createMockExpressRes();
    await createRenewRequest(reqManual, resManual);

    assert.equal(resManual.statusCode, 200);
    assert.equal(resManual.body?.success, true);
    assert.equal(resManual.body?.autoRenewed, false);
    assert.equal(resManual.body?.provisioningStatus, 'pending');
    assert.equal(db.tables.renew_requests.length, 1);

    const savedNotes = JSON.parse(db.tables.renew_requests[0].notes);
    assert.equal(savedNotes.quota_verified_by_server, true);
    assert.equal(savedNotes.verified_plan_id, 'sim_100');
    assert.equal(savedNotes.package_type, 'SIM 100GB');
    assert.equal(savedNotes.data_limit, '100GB');
    assert.equal(savedNotes.quota_mode, 'finite');
    assert.equal(savedNotes.monthly_quota_gb, 100);
    assert.equal(savedNotes.message, 'Paid via bank transfer');

    // 14b: Allowlisted customer missing slip -> auto-renewal held, sanitized blocked reason persisted WITHOUT overwriting notes
    const reqHeld: any = {
      user: { uid: 'user-pilot', id: 'user-pilot', email: 'pilot@example.com' },
      dbClient: db,
      body: {
        planId: 'sim_100',
        packageId: 'mobitel_zoom',
        packageName: 'Mobitel Zoom',
        packageType: 'SIM 100GB',
        dataLimit: '100GB',
        durationMonths: 1,
        vpn_account_id: 'acc-14-pilot',
        uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        slipUrl: '',
        message: 'Preserve this customer note',
      },
    };
    const resHeld = createMockExpressRes();
    await createRenewRequest(reqHeld, resHeld);

    assert.equal(resHeld.statusCode, 200);
    assert.equal(resHeld.body?.autoRenewed, false);
    assert.equal(resHeld.body?.autoRenewalBlockedReason, 'MISSING_PAYMENT_SLIP');

    const heldNotes = JSON.parse(db.tables.renew_requests[1].notes);
    assert.equal(heldNotes.auto_renewal_blocked_reason, 'MISSING_PAYMENT_SLIP');
    assert.ok(heldNotes.auto_renewal_held_at);
    assert.equal(heldNotes.message, 'Preserve this customer note', 'Existing renewal notes must be preserved');
    assert.equal(heldNotes.verified_plan_id, 'sim_100', 'Verified quota metadata must be preserved');

    // Verify sanitizer strips tokens/URLs/keys
    const cleaned = sanitizeAutoRenewalBlockedReason(
      'Failed at https://panel.secret.local:2053 with bot123456:ABCDEF_secret Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig sb_secret_1234567890'
    );
    assert.ok(cleaned);
    assert.doesNotMatch(cleaned!, /bot123456:ABCDEF_secret/);
    assert.doesNotMatch(cleaned!, /eyJhbGciOi/);
    assert.doesNotMatch(cleaned!, /sb_secret_1234567890/);
    assert.doesNotMatch(cleaned!, /panel\.secret\.local/);
  } finally {
    if (prevEnabled === undefined) delete process.env.AUTO_ACTIVATE_RENEWALS_ENABLED;
    else process.env.AUTO_ACTIVATE_RENEWALS_ENABLED = prevEnabled;
    if (prevAllowlist === undefined) delete process.env.AUTO_ACTIVATE_RENEWALS_ALLOWLIST;
    else process.env.AUTO_ACTIVATE_RENEWALS_ALLOWLIST = prevAllowlist;
  }
});

// -----------------------------------------------------------------------------
// Scenario 15: Telegram failure notifications after callback already answered + secret redaction
// -----------------------------------------------------------------------------
test('Scenario 15: Telegram callback sends sanitized follow-up error message after initial callback acknowledgement and redacts all secrets', async () => {
  const answeredCalls: Array<{ qid: string; text?: string; showAlert?: boolean }> = [];
  const followUpCalls: Array<{ chatId: string | number; text: string; replyTo?: number }> = [];

  const db = createRenewalMockDb({
    tables: {
      renew_requests: [
        {
          id: 'req-tg-fail-1',
          user_id: 'user-15',
          user_email: 'secret-customer@example.com',
          status: 'pending',
          provisioning_status: 'pending',
          plan_name: 'Mobitel Zoom (Summer Promo - 3 Months)',
        },
      ],
    },
  });

  // 15a: Error with raw secrets/tokens/URLs thrown AFTER answerCallbackQuery("⏳ Approving...")
  await handleTelegramCallbackQuery(
    {
      id: 'cbq-15-a',
      from: { id: 999001, username: 'admin_boss' },
      data: 'approve_renew:req-tg-fail-1',
      message: {
        message_id: 4242,
        chat: { id: -100777888 },
        text: 'Renewal Request #req-tg-fail-1',
      },
    },
    {
      dbClient: db,
      verifyAdminFn: async () => ({ authorized: true }),
      answerCallbackFn: async (qid, text, showAlert) => {
        answeredCalls.push({ qid, text, showAlert });
      },
      sendFollowUpFn: async (chatId, text, replyTo) => {
        followUpCalls.push({ chatId, text, replyTo });
      },
      executeRenewalApprovalFn: async () => {
        const err: any = new Error(
          'Upstream failure for secret-customer@example.com via https://xui.internal:2053/login bot987654:SecretBotToken_XYZ Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYWRtaW4ifQ.sig sb_secret_supersecret999 password=myPass123'
        );
        throw err;
      },
    }
  );

  assert.equal(answeredCalls.length, 1, 'answerCallbackQuery must only be called once (initial progress ack)');
  assert.match(answeredCalls[0].text || '', /Approving renewal/);
  assert.equal(followUpCalls.length, 1, 'Follow-up error message must be sent when callback was already answered');
  assert.equal(followUpCalls[0].chatId, -100777888);
  assert.equal(followUpCalls[0].replyTo, 4242);
  assert.match(followUpCalls[0].text, /Renewal Approval Failed \(#req-tg-fail-1\)/);

  // Verify zero secret leakage
  const sentText = followUpCalls[0].text;
  assert.doesNotMatch(sentText, /SecretBotToken_XYZ/);
  assert.doesNotMatch(sentText, /eyJhbGciOi/);
  assert.doesNotMatch(sentText, /sb_secret_supersecret999/);
  assert.doesNotMatch(sentText, /xui\.internal/);
  assert.doesNotMatch(sentText, /myPass123/);
  assert.doesNotMatch(sentText, /secret-customer@example\.com/);

  // 15b: Mapped operational error code (RECONCILIATION_REQUIRED) produces clean actionable message
  const mappedMsg = sanitizeTelegramErrorMessage({
    code: 'RECONCILIATION_REQUIRED',
    message: 'raw postgres://admin:pass@db.internal/prod error',
  });
  assert.match(mappedMsg, /Uncertain prior state detected/);
  assert.doesNotMatch(mappedMsg, /postgres:/);

  // 15c: Raw SQL error without code is replaced with generic safe message
  const sqlMsg = sanitizeTelegramErrorMessage(
    new Error('ERROR: duplicate key value violates check constraint in SELECT * FROM vpn_accounts')
  );
  assert.match(sqlMsg, /Backend or upstream service error occurred/);
  assert.doesNotMatch(sqlMsg, /vpn_accounts/);
});

// -----------------------------------------------------------------------------
// Scenario 16: Concurrent notes update CAS protection, NULL notes, error handling & untrimmed legacy_notes
// -----------------------------------------------------------------------------
test('Scenario 16: persistAutoRenewalBlockedReasonCas uses conditional CAS, merges concurrent JSON updates, handles NULL notes & DB errors, and never truncates legacy_notes', async () => {
  const canonicalFallback = {
    planId: 'sim_100',
    verified_plan_id: 'sim_100',
    package_type: 'SIM 100GB',
    data_limit: '100GB',
    category: 'SIM',
    quota_mode: 'finite',
    monthly_quota_gb: 100,
    quota_verified_by_server: true,
    package_id: 'mobitel_zoom',
    package_name: 'Mobitel Zoom',
    durationMonths: 3,
  };

  // 16a: NULL initial notes uses .is('notes', null) CAS condition and preserves canonical fallback metadata
  const dbNull = createRenewalMockDb({
    tables: {
      renew_requests: [
        {
          id: 'req-cas-null',
          status: 'pending',
          notes: null,
        },
      ],
    },
  });

  const resNull = await persistAutoRenewalBlockedReasonCas({
    dbClient: dbNull,
    renewRequestId: 'req-cas-null',
    blockedReason: 'MISSING_PAYMENT_SLIP',
    canonicalExtraMetadata: canonicalFallback,
    nowIso: '2026-11-28T01:00:00.000Z',
  });
  assert.equal(resNull.persisted, true);
  assert.equal(resNull.attempts, 1);
  assert.ok(
    dbNull.updateCalls[0].filters.some(
      ([op, col, val]: [string, string, any]) => op === 'is' && col === 'notes' && val === null
    ),
    'NULL initial notes must use .is("notes", null) CAS predicate'
  );
  const parsedNullNotes = JSON.parse(dbNull.tables.renew_requests[0].notes);
  assert.equal(parsedNullNotes.auto_renewal_blocked_reason, 'MISSING_PAYMENT_SLIP');
  assert.equal(parsedNullNotes.verified_plan_id, 'sim_100');
  assert.equal(parsedNullNotes.quota_verified_by_server, true);

  // 16b: Concurrent JSON modification between read and update triggers bounded CAS retry and merges both updates
  let firstReadIntercepted = false;
  const dbConcurrent = createRenewalMockDb({
    tables: {
      renew_requests: [
        {
          id: 'req-cas-retry',
          status: 'pending',
          notes: JSON.stringify({
            ...canonicalFallback,
            message: 'Initial customer message',
          }),
        },
      ],
    },
  });
  const origFrom = dbConcurrent.from.bind(dbConcurrent);
  dbConcurrent.from = (table: string) => {
    const q = origFrom(table);
    const origUpdate = q.update.bind(q);
    q.update = (payload: any) => {
      if (!firstReadIntercepted) {
        firstReadIntercepted = true;
        // Simulate a concurrent process updating notes just before attempt 1's CAS update executes
        dbConcurrent.tables.renew_requests[0].notes = JSON.stringify({
          ...canonicalFallback,
          message: 'Initial customer message',
          concurrent_worker_note: 'added_by_concurrent_writer',
          // Simulate concurrent writer accidentally omitting verified_plan_id — canonical fallback must restore it!
          verified_plan_id: undefined,
        });
      }
      return origUpdate(payload);
    };
    return q;
  };

  const resRetry = await persistAutoRenewalBlockedReasonCas({
    dbClient: dbConcurrent,
    renewRequestId: 'req-cas-retry',
    blockedReason: 'XUI_LOCK_BUSY',
    canonicalExtraMetadata: canonicalFallback,
    nowIso: '2026-11-28T01:05:00.000Z',
    maxAttempts: 2,
  });
  assert.equal(resRetry.persisted, true);
  assert.equal(resRetry.attempts, 2, 'Should succeed on bounded retry attempt 2 after CAS conflict');
  const mergedNotes = JSON.parse(dbConcurrent.tables.renew_requests[0].notes);
  assert.equal(mergedNotes.concurrent_worker_note, 'added_by_concurrent_writer', 'Concurrent field must be preserved');
  assert.equal(mergedNotes.auto_renewal_blocked_reason, 'XUI_LOCK_BUSY');
  assert.equal(mergedNotes.verified_plan_id, 'sim_100', 'Canonical quota metadata must never be lost');
  assert.equal(mergedNotes.quota_verified_by_server, true);

  // 16c: Persistent contention across all maxAttempts safely skips persistence without throwing
  const dbAlwaysConflict = createRenewalMockDb({
    tables: {
      renew_requests: [
        {
          id: 'req-cas-exhausted',
          status: 'pending',
          notes: JSON.stringify(canonicalFallback),
        },
      ],
    },
  });
  const origFromConflict = dbAlwaysConflict.from.bind(dbAlwaysConflict);
  let conflictCounter = 0;
  dbAlwaysConflict.from = (table: string) => {
    const q = origFromConflict(table);
    const origUpdate = q.update.bind(q);
    q.update = (payload: any) => {
      conflictCounter++;
      dbAlwaysConflict.tables.renew_requests[0].notes = JSON.stringify({
        ...canonicalFallback,
        seq: conflictCounter,
      });
      return origUpdate(payload);
    };
    return q;
  };

  const resExhausted = await persistAutoRenewalBlockedReasonCas({
    dbClient: dbAlwaysConflict,
    renewRequestId: 'req-cas-exhausted',
    blockedReason: 'XUI_TIMEOUT',
    canonicalExtraMetadata: canonicalFallback,
    maxAttempts: 2,
  });
  assert.equal(resExhausted.persisted, false);
  assert.equal(resExhausted.reason, 'CAS_CONFLICT_SKIPPED');
  assert.equal(resExhausted.attempts, 2);

  // 16d: Concurrent admin approval/rejection (status !== 'pending') skips persistence immediately
  const dbAdminApproved = createRenewalMockDb({
    tables: {
      renew_requests: [
        {
          id: 'req-cas-approved',
          status: 'approved',
          notes: JSON.stringify({ ...canonicalFallback, admin_note: 'Approved manually' }),
        },
      ],
    },
  });
  const resApproved = await persistAutoRenewalBlockedReasonCas({
    dbClient: dbAdminApproved,
    renewRequestId: 'req-cas-approved',
    blockedReason: 'LATE_AUTO_RENEW_REASON',
    canonicalExtraMetadata: canonicalFallback,
  });
  assert.equal(resApproved.persisted, false);
  assert.equal(resApproved.reason, 'CONCURRENT_ADMIN_STATE_CHANGE');
  assert.equal(dbAdminApproved.updateCalls.length, 0, 'Must never update a non-pending request');

  // 16e: Explicit Supabase read/update error handling
  const dbReadErr: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: { message: 'simulated read failure' } }),
        }),
      }),
    }),
  };
  const resReadErr = await persistAutoRenewalBlockedReasonCas({
    dbClient: dbReadErr,
    renewRequestId: 'req-err',
    blockedReason: 'REASON',
    canonicalExtraMetadata: canonicalFallback,
  });
  assert.equal(resReadErr.persisted, false);
  assert.equal(resReadErr.reason, 'SUPABASE_READ_ERROR');

  const dbUpdateErr: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { id: 'req-err', status: 'pending', notes: null },
            error: null,
          }),
        }),
      }),
      update: () => ({
        eq: () => ({
          eq: () => ({
            is: () => ({
              select: () => async () => ({ data: null, error: { message: 'simulated update failure' } }),
            }),
          }),
        }),
      }),
    }),
  };
  // Use direct promise return on .select() for updateBuilder.select('id, notes')
  const dbUpdateErrDirect: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { id: 'req-err', status: 'pending', notes: null },
            error: null,
          }),
        }),
      }),
      update: () => ({
        eq: () => ({
          eq: () => ({
            is: () => ({
              select: async () => ({ data: null, error: { message: 'simulated update failure' } }),
            }),
          }),
        }),
      }),
    }),
  };
  const resUpdateErr = await persistAutoRenewalBlockedReasonCas({
    dbClient: dbUpdateErrDirect,
    renewRequestId: 'req-err',
    blockedReason: 'REASON',
    canonicalExtraMetadata: canonicalFallback,
  });
  assert.equal(resUpdateErr.persisted, false);
  assert.equal(resUpdateErr.reason, 'SUPABASE_UPDATE_ERROR');

  // 16f: Long plain-text or malformed-JSON notes (>1000 chars) are preserved in full inside legacy_notes without truncation
  const longLegacyNote = 'LEGACY_CUSTOMER_NOTE_' + 'X'.repeat(2400) + '_END_MARKER';
  const dbLongLegacy = createRenewalMockDb({
    tables: {
      renew_requests: [
        {
          id: 'req-cas-long-legacy',
          status: 'pending',
          notes: longLegacyNote,
        },
      ],
    },
  });
  const resLong = await persistAutoRenewalBlockedReasonCas({
    dbClient: dbLongLegacy,
    renewRequestId: 'req-cas-long-legacy',
    blockedReason: 'UNVERIFIED_RENEWAL_QUOTA_METADATA',
    canonicalExtraMetadata: canonicalFallback,
  });
  assert.equal(resLong.persisted, true);
  const parsedLong = JSON.parse(dbLongLegacy.tables.renew_requests[0].notes);
  assert.equal(parsedLong.legacy_notes.length, longLegacyNote.length, 'legacy_notes must NOT be truncated to 1000 chars');
  assert.equal(parsedLong.legacy_notes, longLegacyNote);
  assert.ok(parsedLong.legacy_notes.endsWith('_END_MARKER'));
  assert.equal(parsedLong.verified_plan_id, 'sim_100');
});

// -----------------------------------------------------------------------------
// Scenario 17: Invalid live quota rejection & legacy category / tier-upgrade / multi-month safety
// -----------------------------------------------------------------------------
test('Scenario 17: Invalid live quota values never become Unlimited (0), and legacy resolution enforces category, tier-upgrade/downgrade, and multi-month finite rules', async () => {
  // 17a: parseVerifiedLiveTotalBytes strict validation (V5.4.2 hardened against arrays, objects, unsafe ints, non-canonical strings)
  const invalidQuotaInputs: unknown[] = [
    undefined,
    null,
    '',
    '   ',
    '\t\n',
    true,
    false,
    [],
    [0],
    ['0'],
    [''],
    ['   '],
    [100],
    [0, 1],
    {},
    { totalGB: 0 },
    { valueOf: () => 0 },
    { toString: () => '0' },
    new Number(0),
    NaN,
    Infinity,
    -Infinity,
    -0,
    -1,
    -100,
    0.5,
    100.5,
    Number.MAX_SAFE_INTEGER + 1,
    String(Number.MAX_SAFE_INTEGER + 1),
    '-0',
    '+0',
    '+100',
    '-1',
    '-100',
    '00',
    '0100',
    '0.0',
    '100.0',
    '100.5',
    '1e5',
    '0x0',
    '0x64',
    '0b0',
    '0o0',
    'NaN',
    'Infinity',
    '-Infinity',
    'unlimited',
    BigInt(0),
    () => 0,
  ];

  for (const badInput of invalidQuotaInputs) {
    const res = parseVerifiedLiveTotalBytes(badInput);
    assert.equal(
      res.valid,
      false,
      `Expected parseVerifiedLiveTotalBytes(${ inspectValue(badInput) }) to be invalid, got valid=${res.valid}, totalBytes=${res.totalBytes}`
    );
    assert.equal(res.totalBytes, -1);
  }

  // Explicitly supported valid zero and positive safe integer numbers and decimal integer strings
  assert.deepEqual(parseVerifiedLiveTotalBytes(0), { valid: true, totalBytes: 0 });
  assert.deepEqual(parseVerifiedLiveTotalBytes('0'), { valid: true, totalBytes: 0 });
  assert.deepEqual(parseVerifiedLiveTotalBytes(' 0 '), { valid: true, totalBytes: 0 });
  assert.deepEqual(parseVerifiedLiveTotalBytes(1), { valid: true, totalBytes: 1 });
  assert.deepEqual(parseVerifiedLiveTotalBytes(100 * GB), { valid: true, totalBytes: 100 * GB });
  assert.deepEqual(parseVerifiedLiveTotalBytes(String(100 * GB)), { valid: true, totalBytes: 100 * GB });
  assert.deepEqual(parseVerifiedLiveTotalBytes(`  ${100 * GB}  `), { valid: true, totalBytes: 100 * GB });
  assert.deepEqual(parseVerifiedLiveTotalBytes(Number.MAX_SAFE_INTEGER), {
    valid: true,
    totalBytes: Number.MAX_SAFE_INTEGER,
  });
  assert.deepEqual(parseVerifiedLiveTotalBytes(String(Number.MAX_SAFE_INTEGER)), {
    valid: true,
    totalBytes: Number.MAX_SAFE_INTEGER,
  });

  // 17b: Negative, array, object, or unsafe-integer liveClientTotalBytes in resolveAuthoritativeRenewalQuota fails closed (never Unlimited)
  for (const malformedLive of [-1, [], [0], {}, '', '-0', Number.MAX_SAFE_INTEGER + 1] as any[]) {
    const badLiveQuota = resolveAuthoritativeRenewalQuota({
      renewRequest: { plan_name: 'Mobitel Zoom (SIM 100GB)' },
      extraNotes: {
        planId: 'sim_100',
        verified_plan_id: 'sim_100',
        package_type: 'SIM 100GB',
        data_limit: '100GB',
        quota_mode: 'finite',
        monthly_quota_gb: 100,
        quota_verified_by_server: true,
        durationMonths: 1,
      },
      durationMonths: 1,
      vpnAccount: { total_bytes: 100 * GB, data_limit: '100GB' },
      liveClientTotalBytes: malformedLive,
    });
    assert.equal(badLiveQuota.resolved, false);
    assert.equal(badLiveQuota.blockedReason, 'INVALID_LIVE_CLIENT_QUOTA');
  }

  // calculateApprovedRenewalEntitlement rejects negative, array, object, or unsafe previousTotalBytes
  for (const malformedPrev of [-1, [], [0], {}, NaN, Number.MAX_SAFE_INTEGER + 1] as any[]) {
    const badCalc = calculateApprovedRenewalEntitlement({
      previousExpiryMs: Date.now() + 86400000,
      previousTotalBytes: malformedPrev,
      liveUpBytes: 0,
      liveDownBytes: 0,
      liveEnable: true,
      inboundEnable: true,
      addedDurationMonths: 1,
      addedQuotaBytes: 100 * GB,
    });
    assert.equal(badCalc.eligible, false);
    assert.equal(badCalc.code, 'INVALID_PARAMETERS');
  }

  // updateClientExpiry rejects corrupted negative or array live totalGB before any 3X-UI write
  const badUuid = '17171717-1717-4717-8717-171717171717';
  for (const corruptedTotalGb of [-1, [], [0], {}, ''] as any[]) {
    const corruptedLiveClients = [
      {
        id: badUuid,
        email: 'corrupted_live_quota',
        subId: 'sub_bad',
        totalGB: corruptedTotalGb,
        expiryTime: Date.now() + 86400000,
        enable: true,
        reset: 0,
      },
    ];
    await assert.rejects(
      async () => {
        await updateClientExpiry(badUuid, 1, 'Mobitel Zoom (SIM 100GB)', null, {
          dbClient: createRenewalMockDb(),
          getInboundsFn: async () => [buildLiveInbound(corruptedLiveClients, [], 2)],
          requestApiFn: async () => {
            throw new Error('Must never write to 3X-UI when live totalGB is malformed/corrupted');
          },
        });
      },
      (err: any) => err?.statusCode === 409 && err?.code === 'INVALID_LIVE_CLIENT_QUOTA'
    );
  }

  // 17c: Legacy unverified request cannot upgrade an existing finite 100GB account to Unlimited
  const legacyUpgradeAttempt = resolveAuthoritativeRenewalQuota({
    renewRequest: { plan_name: 'Mobitel Zoom (SIM Unlimited)' },
    extraNotes: {
      planId: 'sim_unlimited',
      package_id: 'mobitel_zoom',
      package_name: 'Mobitel Zoom',
      durationMonths: 1,
      // quota_verified_by_server is NOT true (legacy unverified metadata)
    },
    durationMonths: 1,
    vpnAccount: { total_bytes: 100 * GB, data_limit: '100GB', package_name: 'Mobitel Zoom' },
    liveClientTotalBytes: 100 * GB,
  });
  assert.equal(legacyUpgradeAttempt.resolved, false);
  assert.equal(legacyUpgradeAttempt.blockedReason, 'UNVERIFIED_LEGACY_TIER_UPGRADE');

  // Existing Unlimited account cannot be downgraded to finite 100GB
  const downgradeAttempt = resolveAuthoritativeRenewalQuota({
    renewRequest: { plan_name: 'Mobitel Zoom (SIM 100GB)' },
    extraNotes: {
      planId: 'sim_100',
      package_id: 'mobitel_zoom',
      package_name: 'Mobitel Zoom',
      durationMonths: 1,
    },
    durationMonths: 1,
    vpnAccount: { total_bytes: 0, data_limit: 'Unlimited', package_name: 'Mobitel Zoom' },
    liveClientTotalBytes: 0,
  });
  assert.equal(downgradeAttempt.resolved, false);
  assert.equal(downgradeAttempt.blockedReason, 'CONFLICTING_TIER_DOWNGRADE_METADATA');

  // Package category mismatch (existing ROUTER account receiving SIM renewal metadata) fails closed
  const categoryMismatch = resolveAuthoritativeRenewalQuota({
    renewRequest: { plan_name: 'Mobitel Zoom (SIM Unlimited)' },
    extraNotes: {
      planId: 'sim_unlimited',
      package_id: 'mobitel_zoom',
      package_name: 'Mobitel Zoom',
      category: 'SIM',
      durationMonths: 1,
    },
    durationMonths: 1,
    vpnAccount: { total_bytes: 0, data_limit: 'Unlimited', package_name: 'SLT FIBER ZOOM' },
    parentOrder: { package_name: 'SLT FIBER ZOOM' },
    liveClientTotalBytes: 0,
  });
  assert.equal(categoryMismatch.resolved, false);
  assert.equal(categoryMismatch.blockedReason, 'CONFLICTING_PACKAGE_CATEGORY_METADATA');

  // 17d: Multi-month finite quota calculations (1M=100GB, 3M=300GB, 6M=600GB, 12M=1200GB) + legacy cumulative label normalization
  for (const months of [1, 3, 6, 12]) {
    const resMulti = resolveAuthoritativeRenewalQuota({
      renewRequest: { plan_name: `Mobitel Zoom - SIM 100GB (${months} Months)` },
      extraNotes: {
        planId: 'sim_100',
        data_limit: `${100 * months}GB`, // Even if legacy request stored cumulative "300GB" for 3 months
        package_id: 'mobitel_zoom',
        package_name: 'Mobitel Zoom',
        durationMonths: months,
      },
      durationMonths: months,
      vpnAccount: { total_bytes: 100 * GB, data_limit: '100GB' },
      liveClientTotalBytes: 100 * GB,
    });
    assert.equal(resMulti.resolved, true, `Failed for ${months}M finite renewal`);
    assert.equal(resMulti.quotaMode, 'finite');
    assert.equal(resMulti.monthlyQuotaGb, 100);
    assert.equal(resMulti.addedQuotaBytes, 100 * months * GB);
  }

  // Conflicting finite quota signals ("sim_100" vs "500GB" on a 1-month renewal) fails closed with CONFLICTING_QUOTA_METADATA
  const conflictingFinite = resolveAuthoritativeRenewalQuota({
    renewRequest: { plan_name: 'Mobitel Zoom (500GB)' },
    extraNotes: {
      planId: 'sim_100',
      data_limit: '500GB',
      durationMonths: 1,
    },
    durationMonths: 1,
    vpnAccount: { total_bytes: 100 * GB, data_limit: '100GB' },
    liveClientTotalBytes: 100 * GB,
  });
  assert.equal(conflictingFinite.resolved, false);
  assert.equal(conflictingFinite.blockedReason, 'CONFLICTING_QUOTA_METADATA');

  // Single non-canonical finite quota label ("500GB" on a 1-month renewal) fails closed with CONFLICTING_QUOTA_METADATA
  const nonCanonicalFinite = resolveAuthoritativeRenewalQuota({
    renewRequest: { plan_name: 'Mobitel Zoom (500GB)' },
    extraNotes: {
      data_limit: '500GB',
      durationMonths: 1,
    },
    durationMonths: 1,
    vpnAccount: { total_bytes: 500 * GB },
    liveClientTotalBytes: 500 * GB,
  });
  assert.equal(nonCanonicalFinite.resolved, false);
  assert.equal(nonCanonicalFinite.blockedReason, 'CONFLICTING_QUOTA_METADATA');
  assert.match(nonCanonicalFinite.reason || '', /Unrecognized non-canonical finite quota value \(500GB/);
});

function inspectValue(val: unknown): string {
  if (typeof val === 'bigint') return `${val.toString()}n`;
  if (typeof val === 'function') return '[Function]';
  if (Object.is(val, -0)) return '-0';
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

/**
 * Exact TypeScript mirror of the installed 13-argument PostgreSQL validator:
 * `public.is_valid_pre_renewal_db_snapshot(p_snapshot, p_vpn_account_id, p_order_id, p_client_uuid,
 *   p_inbound_id, p_previous_enable, p_previous_status, p_previous_expiry_ms, p_previous_total_bytes,
 *   p_previous_up_bytes, p_previous_down_bytes, p_granted_expiry_ms, p_granted_total_bytes)`
 */
function simulateInstalled13ArgSnapshotValidator(params: {
  p_snapshot: any;
  p_vpn_account_id: string;
  p_order_id: string;
  p_client_uuid: string;
  p_inbound_id: number;
  p_previous_enable: boolean;
  p_previous_status: string;
  p_previous_expiry_ms: number;
  p_previous_total_bytes: number;
  p_previous_up_bytes: number;
  p_previous_down_bytes: number;
  p_granted_expiry_ms: number;
  p_granted_total_bytes: number;
}): boolean {
  const {
    p_snapshot,
    p_vpn_account_id,
    p_order_id,
    p_client_uuid,
    p_inbound_id,
    p_previous_enable,
    p_previous_status,
    p_previous_expiry_ms,
    p_previous_total_bytes,
    p_previous_up_bytes,
    p_previous_down_bytes,
    p_granted_expiry_ms,
    p_granted_total_bytes,
  } = params;

  const isPlainObj = (v: any) => Boolean(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0);
  const isoRegex = /^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$/;
  const digitRegex = /^[0-9]+$/;

  if (
    !isPlainObj(p_snapshot) ||
    !p_vpn_account_id ||
    !p_order_id ||
    !p_client_uuid ||
    typeof p_inbound_id !== 'number' ||
    p_inbound_id <= 0 ||
    typeof p_previous_enable !== 'boolean' ||
    !p_previous_status ||
    typeof p_previous_expiry_ms !== 'number' ||
    p_previous_expiry_ms <= 0 ||
    typeof p_previous_total_bytes !== 'number' ||
    p_previous_total_bytes < 0 ||
    typeof p_previous_up_bytes !== 'number' ||
    p_previous_up_bytes < 0 ||
    typeof p_previous_down_bytes !== 'number' ||
    p_previous_down_bytes < 0 ||
    typeof p_granted_expiry_ms !== 'number' ||
    p_granted_expiry_ms <= p_previous_expiry_ms ||
    typeof p_granted_total_bytes !== 'number' ||
    p_granted_total_bytes < 0
  ) {
    return false;
  }

  const v_clean_uuid = p_client_uuid.trim();
  const v_clean_prev_status = p_previous_status.trim();
  if (!v_clean_uuid || !v_clean_prev_status) return false;

  const v_acc = p_snapshot.vpn_account;
  const v_ord = p_snapshot.parent_order;
  const v_cfg = p_snapshot.vpn_config;
  const v_xui = p_snapshot.xui_client;
  const v_granted = p_snapshot.granted_db_state;

  if (!isPlainObj(v_acc) || !isPlainObj(v_ord) || !isPlainObj(v_cfg) || !isPlainObj(v_xui) || !isPlainObj(v_granted)) {
    return false;
  }

  // 1. vpn_account checks
  const reqAccKeys = ['id', 'uuid', 'order_id', 'enable', 'status', 'expiry_time', 'expiry_date', 'total_bytes', 'data_limit'];
  if (!reqAccKeys.every((k) => k in v_acc)) return false;
  if (
    typeof v_acc.id !== 'string' ||
    v_acc.id !== p_vpn_account_id ||
    typeof v_acc.uuid !== 'string' ||
    v_acc.uuid.trim() !== v_clean_uuid ||
    typeof v_acc.order_id !== 'string' ||
    v_acc.order_id !== p_order_id ||
    typeof v_acc.enable !== 'boolean' ||
    v_acc.enable !== p_previous_enable ||
    typeof v_acc.status !== 'string' ||
    v_acc.status.trim() !== v_clean_prev_status ||
    typeof v_acc.expiry_time !== 'number' ||
    !digitRegex.test(String(v_acc.expiry_time)) ||
    v_acc.expiry_time !== p_previous_expiry_ms ||
    typeof v_acc.expiry_date !== 'string' ||
    !isoRegex.test(v_acc.expiry_date) ||
    Math.round(new Date(v_acc.expiry_date).getTime()) !== p_previous_expiry_ms ||
    typeof v_acc.total_bytes !== 'number' ||
    !digitRegex.test(String(v_acc.total_bytes)) ||
    v_acc.total_bytes !== p_previous_total_bytes ||
    typeof v_acc.data_limit !== 'string' ||
    v_acc.data_limit.trim().length === 0
  ) {
    return false;
  }

  // 2. parent_order checks
  const reqOrdKeys = ['id', 'client_uuid', 'status', 'payment_status', 'expiry_date'];
  if (!reqOrdKeys.every((k) => k in v_ord)) return false;
  if (
    typeof v_ord.id !== 'string' ||
    v_ord.id !== p_order_id ||
    typeof v_ord.client_uuid !== 'string' ||
    v_ord.client_uuid.trim() !== v_clean_uuid ||
    typeof v_ord.status !== 'string' ||
    v_ord.status.trim().length === 0 ||
    typeof v_ord.payment_status !== 'string' ||
    v_ord.payment_status.trim().length === 0
  ) {
    return false;
  }
  if (v_ord.expiry_date !== null) {
    if (
      typeof v_ord.expiry_date !== 'string' ||
      !isoRegex.test(v_ord.expiry_date) ||
      Math.round(new Date(v_ord.expiry_date).getTime()) !== p_previous_expiry_ms
    ) {
      return false;
    }
  }

  // 3. vpn_config checks
  if (!('exists' in v_cfg) || typeof v_cfg.exists !== 'boolean') return false;
  if (v_cfg.exists === true) {
    const reqCfgKeys = ['id', 'uuid', 'enabled', 'status', 'expiry_date', 'data_limit', 'traffic_limit'];
    if (!reqCfgKeys.every((k) => k in v_cfg)) return false;
    if (
      typeof v_cfg.id !== 'string' ||
      v_cfg.id.trim().length === 0 ||
      typeof v_cfg.uuid !== 'string' ||
      v_cfg.uuid.trim() !== v_clean_uuid ||
      typeof v_cfg.enabled !== 'boolean' ||
      typeof v_cfg.status !== 'string' ||
      v_cfg.status.trim().length === 0 ||
      typeof v_cfg.data_limit !== 'string' ||
      v_cfg.data_limit.trim().length === 0 ||
      typeof v_cfg.expiry_date !== 'string' ||
      !isoRegex.test(v_cfg.expiry_date) ||
      Math.round(new Date(v_cfg.expiry_date).getTime()) !== p_previous_expiry_ms
    ) {
      return false;
    }
    if (v_cfg.traffic_limit !== null) {
      if (typeof v_cfg.traffic_limit !== 'string' || v_cfg.traffic_limit.trim().length === 0) {
        return false;
      }
    }
  }

  // 4. xui_client checks
  const reqXuiKeys = [
    'inbound_id',
    'client_uuid',
    'enable',
    'expiry_time_ms',
    'total_bytes',
    'up_bytes_at_renewal',
    'down_bytes_at_renewal',
  ];
  if (!reqXuiKeys.every((k) => k in v_xui)) return false;
  if (
    typeof v_xui.inbound_id !== 'number' ||
    !digitRegex.test(String(v_xui.inbound_id)) ||
    v_xui.inbound_id !== p_inbound_id ||
    typeof v_xui.client_uuid !== 'string' ||
    v_xui.client_uuid.trim() !== v_clean_uuid ||
    typeof v_xui.enable !== 'boolean' ||
    v_xui.enable !== p_previous_enable ||
    typeof v_xui.expiry_time_ms !== 'number' ||
    !digitRegex.test(String(v_xui.expiry_time_ms)) ||
    v_xui.expiry_time_ms !== p_previous_expiry_ms ||
    typeof v_xui.total_bytes !== 'number' ||
    !digitRegex.test(String(v_xui.total_bytes)) ||
    v_xui.total_bytes !== p_previous_total_bytes ||
    typeof v_xui.up_bytes_at_renewal !== 'number' ||
    !digitRegex.test(String(v_xui.up_bytes_at_renewal)) ||
    v_xui.up_bytes_at_renewal !== p_previous_up_bytes ||
    typeof v_xui.down_bytes_at_renewal !== 'number' ||
    !digitRegex.test(String(v_xui.down_bytes_at_renewal)) ||
    v_xui.down_bytes_at_renewal !== p_previous_down_bytes
  ) {
    return false;
  }

  // 5. granted_db_state checks
  const reqGrantedKeys = [
    'granted_expiry_ms',
    'granted_expiry_date',
    'granted_total_bytes',
    'granted_data_limit',
    'granted_enable',
    'granted_status',
  ];
  if (!reqGrantedKeys.every((k) => k in v_granted)) return false;
  if (
    typeof v_granted.granted_expiry_ms !== 'number' ||
    !digitRegex.test(String(v_granted.granted_expiry_ms)) ||
    v_granted.granted_expiry_ms !== p_granted_expiry_ms ||
    typeof v_granted.granted_expiry_date !== 'string' ||
    !isoRegex.test(v_granted.granted_expiry_date) ||
    Math.round(new Date(v_granted.granted_expiry_date).getTime()) !== p_granted_expiry_ms ||
    typeof v_granted.granted_total_bytes !== 'number' ||
    !digitRegex.test(String(v_granted.granted_total_bytes)) ||
    v_granted.granted_total_bytes !== p_granted_total_bytes ||
    typeof v_granted.granted_data_limit !== 'string' ||
    v_granted.granted_data_limit.trim().length === 0 ||
    typeof v_granted.granted_enable !== 'boolean' ||
    typeof v_granted.granted_status !== 'string' ||
    v_granted.granted_status.trim().length === 0
  ) {
    return false;
  }

  return true;
}

// -----------------------------------------------------------------------------
// Scenario 18: Verify buildVerifiedPreRenewalDbSnapshot matches the installed 13-arg production validator
// -----------------------------------------------------------------------------
test('Scenario 18: buildVerifiedPreRenewalDbSnapshot satisfies the installed 13-argument is_valid_pre_renewal_db_snapshot contract across finite, unlimited, and optional config states', () => {
  const accId = '11111111-2222-4333-8444-555555555555';
  const ordId = '66666666-7777-4888-8999-000000000000';
  const cfgId = '99999999-8888-4777-8666-555555555555';
  const clientUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const inboundId = 2;
  const prevExpiryMs = Date.UTC(2026, 11, 15, 10, 0, 0);
  const grantedExpiryMs = addCalendarMonths(prevExpiryMs, 3);

  // 18a: Finite 100GB -> 400GB renewal with vpn_config present
  const finiteSnapshot = buildVerifiedPreRenewalDbSnapshot({
    capturedAtMs: Date.UTC(2026, 10, 28, 2, 0, 0),
    clientUuid,
    inboundId,
    previousExpiryMs: prevExpiryMs,
    previousTotalBytes: 100 * GB,
    previousUpBytes: 12 * GB,
    previousDownBytes: 34 * GB,
    previousEnable: true,
    grantedExpiryMs,
    grantedTotalBytes: 400 * GB,
    grantedDataLimit: '300GB',
    vpnAccount: {
      id: accId,
      uuid: clientUuid,
      order_id: ordId,
      status: 'active',
      data_limit: '100GB',
      expiry_time: prevExpiryMs,
      expiry_date: new Date(prevExpiryMs).toISOString(),
    },
    parentOrder: {
      id: ordId,
      client_uuid: clientUuid,
      status: 'completed',
      payment_status: 'Paid',
      provisioning_status: 'completed',
      expiry_date: new Date(prevExpiryMs).toISOString(),
    },
    vpnConfig: {
      id: cfgId,
      uuid: clientUuid,
      enabled: true,
      status: 'active',
      expiry_date: new Date(prevExpiryMs).toISOString(),
      data_limit: '100GB',
      traffic_limit: null,
    },
    liveClient: {
      id: clientUuid,
      email: 'sim100_customer',
      subId: 'sub_123',
    },
  });

  assert.equal(
    simulateInstalled13ArgSnapshotValidator({
      p_snapshot: finiteSnapshot,
      p_vpn_account_id: accId,
      p_order_id: ordId,
      p_client_uuid: clientUuid,
      p_inbound_id: inboundId,
      p_previous_enable: true,
      p_previous_status: 'active',
      p_previous_expiry_ms: prevExpiryMs,
      p_previous_total_bytes: 100 * GB,
      p_previous_up_bytes: 12 * GB,
      p_previous_down_bytes: 34 * GB,
      p_granted_expiry_ms: grantedExpiryMs,
      p_granted_total_bytes: 400 * GB,
    }),
    true,
    'Finite 100GB pre_renewal_db_snapshot must satisfy all 13 arguments of is_valid_pre_renewal_db_snapshot'
  );

  // 18b: Unlimited renewal (previous_total_bytes = 0, granted_total_bytes = 0) without vpn_config and with null parent_order.expiry_date
  const unlimitedSnapshot = buildVerifiedPreRenewalDbSnapshot({
    capturedAtMs: Date.UTC(2026, 10, 28, 2, 0, 0),
    clientUuid,
    inboundId,
    previousExpiryMs: prevExpiryMs,
    previousTotalBytes: 0,
    previousUpBytes: 50 * GB,
    previousDownBytes: 120 * GB,
    previousEnable: true,
    grantedExpiryMs,
    grantedTotalBytes: 0,
    grantedDataLimit: 'Unlimited',
    vpnAccount: {
      id: accId,
      uuid: clientUuid,
      order_id: ordId,
      status: 'active',
      data_limit: 'Unlimited',
      expiry_time: prevExpiryMs,
      expiry_date: new Date(prevExpiryMs).toISOString(),
    },
    parentOrder: {
      id: ordId,
      client_uuid: clientUuid,
      status: 'completed',
      payment_status: 'Paid',
      provisioning_status: 'completed',
      expiry_date: null,
    },
    vpnConfig: null,
    liveClient: {
      id: clientUuid,
      email: 'unlimited_customer',
    },
  });

  assert.equal(
    simulateInstalled13ArgSnapshotValidator({
      p_snapshot: unlimitedSnapshot,
      p_vpn_account_id: accId,
      p_order_id: ordId,
      p_client_uuid: clientUuid,
      p_inbound_id: inboundId,
      p_previous_enable: true,
      p_previous_status: 'active',
      p_previous_expiry_ms: prevExpiryMs,
      p_previous_total_bytes: 0,
      p_previous_up_bytes: 50 * GB,
      p_previous_down_bytes: 120 * GB,
      p_granted_expiry_ms: grantedExpiryMs,
      p_granted_total_bytes: 0,
    }),
    true,
    'Unlimited pre_renewal_db_snapshot (without vpn_config) must satisfy all 13 arguments of is_valid_pre_renewal_db_snapshot'
  );

  // 18c: Negative checks confirming 13-arg contract rejects mismatched cross-columns or non-increasing expiry
  assert.equal(
    simulateInstalled13ArgSnapshotValidator({
      p_snapshot: finiteSnapshot,
      p_vpn_account_id: accId,
      p_order_id: ordId,
      p_client_uuid: clientUuid,
      p_inbound_id: inboundId,
      p_previous_enable: true,
      p_previous_status: 'active',
      p_previous_expiry_ms: prevExpiryMs,
      p_previous_total_bytes: 0, // Mismatch against 100GB in snapshot
      p_previous_up_bytes: 12 * GB,
      p_previous_down_bytes: 34 * GB,
      p_granted_expiry_ms: grantedExpiryMs,
      p_granted_total_bytes: 400 * GB,
    }),
    false
  );
  assert.equal(
    simulateInstalled13ArgSnapshotValidator({
      p_snapshot: finiteSnapshot,
      p_vpn_account_id: accId,
      p_order_id: ordId,
      p_client_uuid: clientUuid,
      p_inbound_id: inboundId,
      p_previous_enable: true,
      p_previous_status: 'active',
      p_previous_expiry_ms: prevExpiryMs,
      p_previous_total_bytes: 100 * GB,
      p_previous_up_bytes: 12 * GB,
      p_previous_down_bytes: 34 * GB,
      p_granted_expiry_ms: prevExpiryMs, // Non-increasing expiry rejected
      p_granted_total_bytes: 400 * GB,
    }),
    false
  );
});


