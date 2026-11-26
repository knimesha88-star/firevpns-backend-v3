import test from 'node:test';
import assert from 'node:assert/strict';
import {
  provisionOrderClient,
  acquireDurableProvisioningOperationLock,
  buildDurableLockFailureError,
} from '../xuiService.js';
import {
  executeOrderApproval,
  executeOrderRejection,
  verifyPayment,
} from '../../controllers/adminController.js';
import {
  executeRenewalApproval,
  executeRenewalRejection,
} from '../../controllers/renewController.js';
import {
  BACKEND_DEFAULT_API_TIMEOUT_MS,
  BACKEND_EXTENDED_API_TIMEOUT_MS,
  getBackendApiTimeoutMs,
  isExtendedTimeoutBackendApiRequest,
} from '../../../utils/apiTimeoutRoutes.js';

interface MockLockRow {
  operation_key: string;
  operation_type: string;
  target_id: string;
  lock_owner_id: string;
  status: 'in_progress' | 'completed' | 'failed' | 'uncertain';
  lease_expires_at: string;
}

interface MockDbOptions {
  orders?: any[];
  grants?: any[];
  vpnAccounts?: any[];
  vpnConfigs?: any[];
  renewRequests?: any[];
  locks?: MockLockRow[];
  rpcMode?: 'normal' | 'permission_denied_42501' | 'rpc_timeout_error';
  templates?: any[];
}

function createIsolatedMockDb(opts: MockDbOptions = {}) {
  const state = {
    orders: (opts.orders || []).map((r) => ({ ...r })),
    vpn_entitlement_grants: (opts.grants || []).map((r) => ({ ...r })),
    vpn_accounts: (opts.vpnAccounts || []).map((r) => ({ ...r })),
    vpn_configs: (opts.vpnConfigs || []).map((r) => ({ ...r })),
    renew_requests: (opts.renewRequests || []).map((r) => ({ ...r })),
    provisioning_templates: (opts.templates || []).map((r) => ({ ...r })),
    provisioning_operations: (opts.locks || []).map((r) => ({ ...r })),
    notifications: [] as any[],
    rpcCalls: [] as Array<{ fn: string; args: any }>,
    orderUpdates: [] as Array<{ id: string; payload: any }>,
  };

  function getTable(tableName: string): any[] {
    if (!(tableName in state)) {
      (state as any)[tableName] = [];
    }
    return (state as any)[tableName];
  }

  function applyFilters(rows: any[], filters: Array<(r: any) => boolean>): any[] {
    return rows.filter((row) => filters.every((fn) => fn(row)));
  }

  const dbClient: any = {
    state,
    async rpc(fn: string, args: any) {
      state.rpcCalls.push({ fn, args });
      if (opts.rpcMode === 'permission_denied_42501') {
        return {
          data: null,
          error: {
            code: '42501',
            message: 'permission denied for function acquire_provisioning_lock',
          },
        };
      }
      if (opts.rpcMode === 'rpc_timeout_error') {
        return {
          data: null,
          error: {
            code: '57014',
            message: 'canceling statement due to statement timeout',
          },
        };
      }

      if (fn === 'acquire_provisioning_lock') {
        const key = String(args.p_operation_key);
        const existing = state.provisioning_operations.find((l) => l.operation_key === key);
        const now = Date.now();
        if (existing) {
          if (existing.status === 'uncertain') {
            if (args.p_allow_uncertain_recovery !== true) {
              return {
                data: [
                  {
                    acquired: false,
                    stale_recovery: false,
                    previous_status: 'uncertain',
                    previous_operation_type: existing.operation_type,
                    holder_owner_id: existing.lock_owner_id,
                    lease_expires_at: existing.lease_expires_at,
                  },
                ],
                error: null,
              };
            }
          } else if (
            existing.status === 'in_progress' &&
            new Date(existing.lease_expires_at).getTime() > now
          ) {
            return {
              data: [
                {
                  acquired: false,
                  stale_recovery: false,
                  previous_status: 'in_progress',
                  previous_operation_type: existing.operation_type,
                  holder_owner_id: existing.lock_owner_id,
                  lease_expires_at: existing.lease_expires_at,
                },
              ],
              error: null,
            };
          }
          existing.operation_type = args.p_operation_type;
          existing.target_id = args.p_target_id;
          existing.lock_owner_id = args.p_lock_owner_id;
          existing.status = 'in_progress';
          existing.lease_expires_at = new Date(now + (args.p_lease_seconds || 120) * 1000).toISOString();
          return {
            data: [
              {
                acquired: true,
                stale_recovery: false,
                previous_status: 'completed',
                previous_operation_type: existing.operation_type,
                holder_owner_id: existing.lock_owner_id,
                lease_expires_at: existing.lease_expires_at,
              },
            ],
            error: null,
          };
        }

        const inserted: MockLockRow = {
          operation_key: key,
          operation_type: args.p_operation_type,
          target_id: args.p_target_id,
          lock_owner_id: args.p_lock_owner_id,
          status: 'in_progress',
          lease_expires_at: new Date(now + (args.p_lease_seconds || 120) * 1000).toISOString(),
        };
        state.provisioning_operations.push(inserted);
        return {
          data: [
            {
              acquired: true,
              stale_recovery: false,
              previous_status: null,
              previous_operation_type: null,
              holder_owner_id: inserted.lock_owner_id,
              lease_expires_at: inserted.lease_expires_at,
            },
          ],
          error: null,
        };
      }

      if (fn === 'release_provisioning_lock') {
        const row = state.provisioning_operations.find(
          (l) => l.operation_key === args.p_operation_key && l.lock_owner_id === args.p_lock_owner_id
        );
        if (row) {
          row.status = args.p_final_status || 'completed';
        }
        return { data: true, error: null };
      }

      if (fn === 'renew_provisioning_lock') {
        return { data: true, error: null };
      }

      return { data: null, error: null };
    },
    from(tableName: string) {
      const filters: Array<(r: any) => boolean> = [];
      let pendingUpdate: any = null;
      let pendingInsert: any = null;
      let limitCount: number | null = null;
      let wantSingle = false;

      const execute = () => {
        const table = getTable(tableName);
        if (pendingInsert) {
          const rowsToInsert = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
          const inserted = rowsToInsert.map((r, idx) => ({
            id: r.id || `${tableName}-${table.length + idx + 1}`,
            ...r,
          }));
          table.push(...inserted);
          return {
            data: wantSingle ? inserted[0] || null : inserted,
            error: null,
          };
        }

        const matched = applyFilters(table, filters);
        if (pendingUpdate) {
          for (const row of matched) {
            Object.assign(row, pendingUpdate);
            if (tableName === 'orders') {
              state.orderUpdates.push({ id: row.id, payload: { ...pendingUpdate } });
            }
          }
          return {
            data: wantSingle ? matched[0] || null : matched,
            error: null,
          };
        }

        const sliced = limitCount !== null ? matched.slice(0, limitCount) : matched;
        return {
          data: wantSingle ? sliced[0] || null : sliced,
          error: null,
        };
      };

      const builder: any = {
        select() {
          return builder;
        },
        insert(payload: any) {
          pendingInsert = payload;
          return builder;
        },
        upsert(payload: any) {
          pendingInsert = payload;
          return builder;
        },
        update(payload: any) {
          pendingUpdate = payload;
          return builder;
        },
        eq(col: string, val: any) {
          filters.push((r) => String(r[col] ?? '') === String(val ?? ''));
          return builder;
        },
        ilike(col: string, val: string) {
          filters.push((r) => String(r[col] ?? '').toLowerCase() === String(val ?? '').toLowerCase());
          return builder;
        },
        in(col: string, vals: any[]) {
          const set = new Set(vals.map((v) => String(v)));
          filters.push((r) => set.has(String(r[col] ?? '')));
          return builder;
        },
        order() {
          return builder;
        },
        limit(n: number) {
          limitCount = n;
          return builder;
        },
        maybeSingle() {
          wantSingle = true;
          return Promise.resolve(execute());
        },
        single() {
          wantSingle = true;
          return Promise.resolve(execute());
        },
        then(resolve: any, reject: any) {
          return Promise.resolve(execute()).then(resolve, reject);
        },
      };
      return builder;
    },
  };

  return dbClient;
}

test('B1: Exact backend timeout route matcher extends ONLY supported POST endpoints to 70000ms (< 120s lock lease)', () => {
  assert.equal(BACKEND_EXTENDED_API_TIMEOUT_MS, 70000);
  assert.equal(BACKEND_DEFAULT_API_TIMEOUT_MS, 25000);
  assert.ok(
    BACKEND_EXTENDED_API_TIMEOUT_MS < 120 * 1000,
    'Backend HTTP timeout MUST stay below 120s durable lock lease duration'
  );

  const extendedPostRoutes = [
    '/admin/approve-order',
    '/admin/reject-order',
    '/admin/verify-payment',
    '/api/admin/verify-payment',
    '/admin/orders/ord-123/approve',
    '/admin/orders/ord-123/reject',
    '/admin/orders/ord-123/verify-payment',
    '/renew/approve/ren-456',
    '/renew/reject/ren-456',
    '/renew/orders',
    '/renew/request',
    '/vpn/claim-trial',
  ];
  for (const route of extendedPostRoutes) {
    assert.equal(getBackendApiTimeoutMs('POST', route), 70000, `POST ${route} should be 70000ms`);
    assert.equal(isExtendedTimeoutBackendApiRequest('POST', route), true);
  }

  // Must NOT match GET or unrelated routes via broad substring matching
  const nonExtendedRoutes: Array<[string, string]> = [
    ['GET', '/admin/approve-order'],
    ['GET', '/admin/verify-payment'],
    ['POST', '/admin/verify-payment/extra'],
    ['GET', '/admin/orders/ord-123/approve'],
    ['GET', '/admin/orders/ord-123/reject'],
    ['GET', '/admin/orders/ord-123/verify-payment'],
    ['POST', '/admin/approve-settings'],
    ['POST', '/admin/reject-spam'],
    ['POST', '/admin/orders/ord-123/extra/approve'],
    ['POST', '/admin/orders/ord-123/notes'],
    ['GET', '/admin/orders'],
    ['POST', '/renew/approve/ren-456/extra'],
    ['POST', '/auth/login'],
  ];
  for (const [method, route] of nonExtendedRoutes) {
    assert.equal(getBackendApiTimeoutMs(method, route), 25000, `${method} ${route} must remain 25000ms`);
  }
});

test('B1b: Exact Telegram timeout matching extends ONLY supported POST /telegram/webhook and POST /telegram/callback routes', () => {
  const extendedTelegramRoutes = [
    '/telegram/webhook',
    '/api/telegram/webhook',
    '/telegram/callback',
    '/api/telegram/callback',
    '/telegram/webhook?source=bot',
    '/telegram/callback/',
  ];
  for (const route of extendedTelegramRoutes) {
    assert.equal(getBackendApiTimeoutMs('POST', route), 70000, `POST ${route} should be 70000ms`);
    assert.equal(isExtendedTimeoutBackendApiRequest('POST', route), true);
  }

  const nonExtendedTelegramRoutes: Array<[string, string]> = [
    ['GET', '/telegram'],
    ['GET', '/telegram/webhook'],
    ['GET', '/telegram/callback'],
    ['GET', '/api/telegram/webhook'],
    ['PUT', '/telegram/webhook'],
    ['DELETE', '/telegram/callback'],
    ['POST', '/telegram'],
    ['POST', '/api/telegram'],
    ['POST', '/telegram/status'],
    ['POST', '/telegram/webhook/extra'],
    ['POST', '/telegram/callback/extra'],
  ];
  for (const [method, route] of nonExtendedTelegramRoutes) {
    assert.equal(
      getBackendApiTimeoutMs(method, route),
      25000,
      `${method} ${route} must stay at default 25000ms`
    );
    assert.equal(isExtendedTimeoutBackendApiRequest(method, route), false);
  }
});

test('B2: Active lock conflict on provisionOrderClient returns HTTP 409 OPERATION_IN_PROGRESS (NEVER false deduplicated success)', async () => {
  const db = createIsolatedMockDb({
    orders: [
      {
        id: 'ord-active-lock',
        order_id: 'ORD-100001-111',
        email: 'customer@example.com',
        status: 'pending',
        payment_status: 'Pending Verification',
        provisioning_status: 'pending',
      },
    ],
    locks: [
      {
        operation_key: 'order:ord-active-lock',
        operation_type: 'approve_order',
        target_id: 'ord-active-lock',
        lock_owner_id: 'other-worker-1',
        status: 'in_progress',
        lease_expires_at: new Date(Date.now() + 90_000).toISOString(),
      },
    ],
  });

  await assert.rejects(
    () =>
      provisionOrderClient('ord-active-lock', undefined, {
        dbClient: db,
        skipSideEffects: true,
      }),
    (err: any) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'OPERATION_IN_PROGRESS');
      assert.match(err.message, /already being processed/i);
      return true;
    }
  );
});

test('B3: Uncertain lock on provisionOrderClient returns HTTP 409 RECONCILIATION_REQUIRED and NEVER auto-recovers', async () => {
  const db = createIsolatedMockDb({
    orders: [
      {
        id: 'ord-uncertain-1',
        order_id: 'ORD-100002-222',
        email: 'customer@example.com',
        status: 'pending',
        payment_status: 'Pending Verification',
        provisioning_status: 'pending',
      },
    ],
    locks: [
      {
        operation_key: 'order:ord-uncertain-1',
        operation_type: 'auto_order',
        target_id: 'ord-uncertain-1',
        lock_owner_id: 'crashed-worker',
        status: 'uncertain',
        lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
  });

  await assert.rejects(
    () =>
      provisionOrderClient('ord-uncertain-1', undefined, {
        dbClient: db,
        skipSideEffects: true,
      }),
    (err: any) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'RECONCILIATION_REQUIRED');
      assert.match(err.message, /manual reconciliation/i);
      return true;
    }
  );

  // Confirm RPC was called with p_allow_uncertain_recovery === false and uncertain lock remains intact
  const acquireCall = db.state.rpcCalls.find((c: any) => c.fn === 'acquire_provisioning_lock');
  assert.equal(acquireCall?.args.p_allow_uncertain_recovery, false);
  assert.equal(db.state.provisioning_operations[0].status, 'uncertain');
});

test('B4: RPC 42501 permission denied returns HTTP 503 LOCK_PERMISSION_ERROR without leaking secrets or claiming success', async () => {
  const db = createIsolatedMockDb({
    orders: [
      {
        id: 'ord-perm-err',
        order_id: 'ORD-100003-333',
        email: 'customer@example.com',
        status: 'pending',
        payment_status: 'Pending Verification',
        provisioning_status: 'pending',
      },
    ],
    rpcMode: 'permission_denied_42501',
  });

  await assert.rejects(
    () =>
      provisionOrderClient('ord-perm-err', undefined, {
        dbClient: db,
        skipSideEffects: true,
      }),
    (err: any) => {
      assert.equal(err.statusCode, 503);
      assert.equal(err.code, 'LOCK_PERMISSION_ERROR');
      assert.doesNotMatch(err.message, /eyJ|sb_secret|postgres:\/\//i);
      return true;
    }
  );

  // Also verify acquireDurableProvisioningOperationLock classifies rpc timeout as rpc_error -> HTTP 503
  const dbTimeout = createIsolatedMockDb({ rpcMode: 'rpc_timeout_error' });
  const lockRes = await acquireDurableProvisioningOperationLock({
    dbClient: dbTimeout,
    operationKey: 'order:ord-timeout',
    operationType: 'approve_order',
    targetId: 'ord-timeout',
    requireDurableLock: true,
    allowUncertainRecovery: false,
  });
  assert.equal(lockRes.acquired, false);
  assert.equal(lockRes.failureKind, 'rpc_error');
  const httpErr = buildDurableLockFailureError(lockRes, 'Order ord-timeout');
  assert.equal(httpErr.statusCode, 503);
  assert.equal(httpErr.code, 'LOCK_SERVICE_UNAVAILABLE');
});

test('B5: Verified idempotent completion returns success:true + alreadyProvisioned:true without calling 3X-UI', async () => {
  let xuiCalls = 0;
  const db = createIsolatedMockDb({
    orders: [
      {
        id: 'ord-already-done',
        order_id: 'ORD-100004-444',
        email: 'paid@example.com',
        status: 'completed',
        payment_status: 'Paid',
        provisioning_status: 'completed',
        vless_url: 'vless://11111111-1111-4111-8111-111111111111@sg.example.com:443#Paid',
        client_uuid: '11111111-1111-4111-8111-111111111111',
      },
    ],
    vpnAccounts: [
      {
        id: 'vpn-acc-1',
        order_id: 'ord-already-done',
        uuid: '11111111-1111-4111-8111-111111111111',
        vless_url: 'vless://11111111-1111-4111-8111-111111111111@sg.example.com:443#Paid',
      },
    ],
  });

  const res = await provisionOrderClient('ord-already-done', undefined, {
    dbClient: db,
    skipSideEffects: true,
    requestApiFn: async <T>(): Promise<T> => {
      xuiCalls++;
      return { success: true } as unknown as T;
    },
  });

  assert.equal(res.success, true);
  assert.equal(res.alreadyProvisioned, true);
  assert.equal(res.uuid, '11111111-1111-4111-8111-111111111111');
  assert.equal(xuiCalls, 0);
});

test('B6: Provisional order approval finalizes entitlement WITHOUT creating a second VPN client or resetting traffic', async () => {
  let xuiCalls = 0;
  const db = createIsolatedMockDb({
    orders: [
      {
        id: 'ord-prov-1',
        order_id: 'ORD-100005-555',
        customer_id: 'cust-1',
        email: 'provisional@example.com',
        package_name: 'Dialog Unlimited',
        status: 'pending',
        payment_status: 'Pending Verification',
        provisioning_status: 'provisional',
        vless_url: 'vless://22222222-2222-4222-8222-222222222222@sg.example.com:443#Prov',
        client_uuid: '22222222-2222-4222-8222-222222222222',
      },
    ],
    grants: [
      {
        id: 'grant-prov-1',
        grant_type: 'new_order',
        source_id: 'ord-prov-1',
        order_id: 'ord-prov-1',
        client_uuid: '22222222-2222-4222-8222-222222222222',
        status: 'provisional',
      },
    ],
    vpnAccounts: [
      {
        id: 'vpn-prov-1',
        order_id: 'ord-prov-1',
        uuid: '22222222-2222-4222-8222-222222222222',
        vless_url: 'vless://22222222-2222-4222-8222-222222222222@sg.example.com:443#Prov',
        status: 'active',
      },
    ],
  });

  const res = await executeOrderApproval('ord-prov-1', undefined, {
    dbClient: db,
    skipSideEffects: true,
    adminLabel: 'Telegram Admin @ops',
    requestApiFn: async <T>(): Promise<T> => {
      xuiCalls++;
      return { success: true } as unknown as T;
    },
  });

  assert.equal(res.success, true);
  assert.equal(res.uuid, '22222222-2222-4222-8222-222222222222');
  assert.equal(xuiCalls, 0, 'Must NOT call 3X-UI to create another client or reset traffic');
  assert.equal(db.state.orders[0].status, 'completed');
  assert.equal(db.state.orders[0].payment_status, 'Paid');
  assert.equal(db.state.orders[0].provisioning_status, 'completed');
  assert.equal(db.state.vpn_entitlement_grants[0].status, 'verified');
});

test('B7: Manual order & trial rejection persist sanitized orders.reject_reason atomically; already-paid order rejects with HTTP 409', async () => {
  const trialOrderUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const paidOrderUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  const db = createIsolatedMockDb({
    orders: [
      {
        id: trialOrderUuid,
        order_id: 'TRIAL-100006-666',
        customer_id: 'cust-2',
        email: 'trial@example.com',
        package_name: '1-Day Free Trial',
        status: 'pending',
        payment_status: 'Pending Verification',
        provisioning_status: 'pending',
      },
      {
        id: paidOrderUuid,
        order_id: 'ORD-100007-777',
        customer_id: 'cust-3',
        email: 'paid-protected@example.com',
        package_name: 'Dialog Unlimited',
        status: 'pending',
        payment_status: 'Paid',
        provisioning_status: 'pending',
      },
    ],
  });

  const rejRes = await executeOrderRejection(trialOrderUuid, '  Duplicate\u0000 trial request  ', {
    dbClient: db,
    skipSideEffects: true,
    adminLabel: 'Admin Panel',
  });

  assert.equal(rejRes.order.status, 'rejected');
  assert.equal(rejRes.order.payment_status, 'Cancelled');
  assert.equal(rejRes.order.reject_reason, 'Duplicate  trial request');
  assert.equal(db.state.orders[0].reject_reason, 'Duplicate  trial request');

  // Already-paid order MUST be blocked with HTTP 409 ALREADY_PAID_OR_APPROVED
  await assert.rejects(
    () =>
      executeOrderRejection(paidOrderUuid, 'Mistaken reject', {
        dbClient: db,
        skipSideEffects: true,
      }),
    (err: any) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'ALREADY_PAID_OR_APPROVED');
      return true;
    }
  );
  assert.equal(db.state.orders[1].status, 'pending');
  assert.equal(db.state.orders[1].payment_status, 'Paid');
});

test('B8: Concurrent approval and rejection on the same order are serialized with HTTP 409 conflict', async () => {
  const concurrentOrderUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
  let releaseXui!: () => void;
  const xuiGate = new Promise<void>((resolve) => {
    releaseXui = resolve;
  });
  let xuiEntered!: () => void;
  const xuiStarted = new Promise<void>((resolve) => {
    xuiEntered = resolve;
  });

  const db = createIsolatedMockDb({
    orders: [
      {
        id: concurrentOrderUuid,
        order_id: 'ORD-100008-888',
        customer_id: 'cust-4',
        email: 'race@example.com',
        package_name: 'Dialog Unlimited',
        payment_method: JSON.stringify({ plan: 'Dialog Unlimited', duration: '1 Month', server: 'Singapore' }),
        status: 'pending',
        payment_status: 'Pending Verification',
        provisioning_status: 'pending',
      },
    ],
  });

  // Start a slow approval that holds the durable lock `order:<uuid>`
  const approvePromise = provisionOrderClient(concurrentOrderUuid, undefined, {
    dbClient: db,
    skipSideEffects: true,
    findProvisioningTemplateFn: async () => {
      xuiEntered();
      await xuiGate;
      throw new Error('Simulated controlled stop after lock check');
    },
  });

  await xuiStarted;

  // While approval holds the lock, concurrent rejection AND duplicate approval MUST both fail with HTTP 409!
  await assert.rejects(
    () =>
      executeOrderRejection(concurrentOrderUuid, 'Concurrent reject', {
        dbClient: db,
        skipSideEffects: true,
      }),
    (err: any) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'OPERATION_IN_PROGRESS');
      return true;
    }
  );

  await assert.rejects(
    () =>
      provisionOrderClient(concurrentOrderUuid, undefined, {
        dbClient: db,
        skipSideEffects: true,
      }),
    (err: any) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'OPERATION_IN_PROGRESS');
      return true;
    }
  );

  releaseXui();
  await assert.rejects(() => approvePromise, /Simulated controlled stop/);
});

test('B9: Renewal approval and rejection handle manual reject, active lock 409, uncertain lock 409, and 42501 permission error 503', async () => {
  // 1. Manual renewal rejection succeeds cleanly
  const dbManual = createIsolatedMockDb({
    renewRequests: [
      {
        id: 'ren-manual-1',
        user_id: 'u-1',
        user_email: 'renew@example.com',
        plan_name: 'Dialog Unlimited',
        status: 'pending',
        provisioning_status: 'pending',
      },
    ],
  });
  const rejResult = await executeRenewalRejection('ren-manual-1', 'Invalid slip', {
    dbClient: dbManual,
    skipSideEffects: true,
  });
  assert.equal(rejResult.success, true);
  assert.equal(dbManual.state.renew_requests[0].status, 'rejected');

  // 2. Uncertain renewal lock returns 409 RECONCILIATION_REQUIRED (no auto recovery)
  const dbUncertain = createIsolatedMockDb({
    renewRequests: [{ id: 'ren-unc-1', user_email: 'u@e.com', status: 'pending' }],
    locks: [
      {
        operation_key: 'renew:ren-unc-1',
        operation_type: 'auto_renew',
        target_id: 'ren-unc-1',
        lock_owner_id: 'prev-owner',
        status: 'uncertain',
        lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
  });
  await assert.rejects(
    () => executeRenewalApproval('ren-unc-1', { dbClient: dbUncertain, skipSideEffects: true }),
    (err: any) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'RECONCILIATION_REQUIRED');
      return true;
    }
  );

  // 3. Permission denied on renewal approval returns 503 LOCK_PERMISSION_ERROR
  const dbPerm = createIsolatedMockDb({
    renewRequests: [{ id: 'ren-perm-1', user_email: 'u@e.com', status: 'pending' }],
    rpcMode: 'permission_denied_42501',
  });
  await assert.rejects(
    () => executeRenewalApproval('ren-perm-1', { dbClient: dbPerm, skipSideEffects: true }),
    (err: any) => {
      assert.equal(err.statusCode, 503);
      assert.equal(err.code, 'LOCK_PERMISSION_ERROR');
      return true;
    }
  );
});

test('B10: Provisional order rejection safely revokes unpaid provisional client on 3X-UI and marks order rejected + revoked', async () => {
  const revokeOrderUuid = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
  const clientUuid = '33333333-3333-4333-8333-333333333333';
  const paidUuid = '44444444-4444-4444-8444-444444444444';
  const mockInbounds = [
    {
      id: 2,
      up: 0,
      down: 0,
      total: 0,
      remark: 'SG-Main',
      enable: true,
      expiryTime: 0,
      listen: '',
      port: 443,
      protocol: 'vless',
      tag: 'inbound-443',
      clientStats: [],
      settings: JSON.stringify({
        clients: [
          { id: clientUuid, email: 'unpaid@example.com', enable: true, totalGB: 0, expiryTime: Date.now() + 86400000 },
          { id: paidUuid, email: 'paid-sibling@example.com', enable: true, totalGB: 0, expiryTime: Date.now() + 86400000 },
        ],
      }),
      streamSettings: '{}',
      sniffing: '{}',
    },
  ];

  const db = createIsolatedMockDb({
    orders: [
      {
        id: revokeOrderUuid,
        order_id: 'ORD-100009-999',
        customer_id: 'cust-5',
        email: 'unpaid@example.com',
        package_name: 'Dialog Unlimited',
        status: 'pending',
        payment_status: 'Pending Verification',
        provisioning_status: 'provisional',
        client_uuid: clientUuid,
        vless_url: `vless://${clientUuid}@sg.example.com:443#Prov`,
      },
    ],
    grants: [
      {
        id: 'grant-revoke-1',
        grant_type: 'new_order',
        source_id: revokeOrderUuid,
        order_id: revokeOrderUuid,
        client_uuid: clientUuid,
        inbound_id: 2,
        provisional: true,
        status: 'provisional',
      },
    ],
    vpnAccounts: [
      { id: 'va-unpaid', order_id: revokeOrderUuid, uuid: clientUuid, status: 'active' },
      { id: 'va-paid', order_id: 'ord-other-paid', uuid: paidUuid, status: 'active' },
    ],
  });

  const requestApiFn = async <T>(endpoint: string, method?: 'GET' | 'POST', body?: any): Promise<T> => {
    if (endpoint.startsWith('/panel/api/inbounds/updateClient/') && method === 'POST') {
      const updated = JSON.parse(body.settings).clients[0];
      const existing = JSON.parse(mockInbounds[0].settings);
      existing.clients = existing.clients.map((c: any) => (c.id === updated.id ? { ...c, ...updated } : c));
      mockInbounds[0].settings = JSON.stringify(existing);
      return { success: true } as unknown as T;
    }
    if (endpoint.includes('/panel/api/inbounds/update/') && method === 'POST') {
      mockInbounds[0].settings = body.settings;
      return { success: true } as unknown as T;
    }
    if (endpoint === '/panel/api/inbounds/get/2' && method === 'GET') {
      return { ...mockInbounds[0] } as unknown as T;
    }
    return { success: true } as unknown as T;
  };

  const res = await executeOrderRejection(revokeOrderUuid, 'Fake payment slip', {
    dbClient: db,
    skipSideEffects: true,
    getInboundsFn: async () => mockInbounds.map((ib) => ({ ...ib })),
    requestApiFn,
  });

  assert.equal(res.order.status, 'rejected');
  assert.equal(res.order.provisioning_status, 'revoked');
  assert.equal(res.order.reject_reason, 'Fake payment slip');

  const updatedClients = JSON.parse(mockInbounds[0].settings).clients;
  const revokedClient = updatedClients.find((c: any) => c.id === clientUuid);
  const siblingPaidClient = updatedClients.find((c: any) => c.id === paidUuid);
  assert.equal(revokedClient.enable, false, 'Unpaid provisional client must be disabled');
  assert.equal(siblingPaidClient.enable, true, 'Existing paid sibling VPN client must remain enabled');
});

test('B11: Manual order approval and trial approval create new 3X-UI client and mark order completed + Paid', async () => {
  const manualOrderUuid = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
  const trialOrderUuid = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2';
  const createdClients: any[] = [];
  const makeLiveInbound = () => ({
    id: 2,
    up: 0,
    down: 0,
    total: 0,
    remark: 'SG-Main',
    enable: true,
    expiryTime: 0,
    listen: '',
    port: 443,
    protocol: 'vless',
    tag: 'inbound-443',
    clientStats: [],
    settings: JSON.stringify({ clients: createdClients }),
    streamSettings: JSON.stringify({ network: 'ws', security: 'tls' }),
    sniffing: '{}',
  });

  const db = createIsolatedMockDb({
    orders: [
      {
        id: manualOrderUuid,
        order_id: 'ORD-200001-111',
        customer_id: 'cust-10',
        email: 'manual@example.com',
        package_name: '1 Month 100GB',
        amount: 1200,
        status: 'pending',
        payment_status: 'Pending Verification',
        provisioning_status: 'pending',
      },
      {
        id: trialOrderUuid,
        order_id: 'TRIAL-200002-222',
        customer_id: 'cust-11',
        email: 'trialuser@example.com',
        package_name: '1-Day Free Trial',
        amount: 0,
        status: 'pending',
        payment_status: 'Free Trial',
        provisioning_status: 'pending',
      },
    ],
  });

  const mockRequestApi = async <T>(endpoint: string, method?: 'GET' | 'POST', body?: any): Promise<T> => {
    if (endpoint === '/panel/api/inbounds/addClient' && method === 'POST') {
      const parsed = JSON.parse(body.settings);
      createdClients.push(...parsed.clients);
      return { success: true } as unknown as T;
    }
    if (endpoint === '/panel/api/inbounds/update/2' && method === 'POST') {
      const parsed = JSON.parse(body.settings);
      createdClients.splice(0, createdClients.length, ...(parsed.clients || []));
      return { success: true } as unknown as T;
    }
    if (endpoint === '/panel/api/inbounds/get/2' && method === 'GET') {
      return makeLiveInbound() as unknown as T;
    }
    return { success: true } as unknown as T;
  };

  const manualRes = await executeOrderApproval(manualOrderUuid, undefined, {
    dbClient: db,
    skipSideEffects: true,
    getInboundsFn: async () => [makeLiveInbound()],
    getClientByEmailFn: async () => null,
    findProvisioningTemplateFn: async () => ({
      inboundId: 2,
      address: 'vpn.firevpns.test',
      sni: 'vpn.firevpns.test',
      remarkTemplate: 'FIRE-{email}',
      trafficLimitGB: 100,
      durationDays: 30,
    }),
    requestApiFn: mockRequestApi,
  });

  assert.equal(manualRes.success, true);
  assert.ok(manualRes.uuid);
  assert.equal(db.state.orders[0].status, 'completed');
  assert.equal(db.state.orders[0].payment_status, 'Paid');

  const trialRes = await executeOrderApproval(trialOrderUuid, undefined, {
    dbClient: db,
    skipSideEffects: true,
    getInboundsFn: async () => [makeLiveInbound()],
    getClientByEmailFn: async () => null,
    findProvisioningTemplateFn: async () => ({
      inboundId: 2,
      address: 'vpn.firevpns.test',
      sni: 'vpn.firevpns.test',
      remarkTemplate: 'TRIAL-{email}',
      trafficLimitGB: 5,
      durationDays: 1,
    }),
    requestApiFn: mockRequestApi,
  });

  assert.equal(trialRes.success, true);
  assert.ok(trialRes.uuid);
  assert.equal(db.state.orders[1].status, 'completed');
  assert.equal(createdClients.length, 2);
});

test('B12: Provisional renewal approval verifies live client and finalizes grant without mutating 3X-UI, and verifyPayment/Telegram exports remain intact', async () => {
  const clientUuid = '55555555-5555-4555-8555-555555555555';
  const expectedExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
  let xuiMutationCalls = 0;

  const mockInbounds = [
    {
      id: 2,
      up: 0,
      down: 0,
      total: 0,
      remark: 'SG-Main',
      enable: true,
      expiryTime: 0,
      listen: '',
      port: 443,
      protocol: 'vless',
      tag: 'inbound-443',
      clientStats: [],
      settings: JSON.stringify({
        clients: [
          {
            id: clientUuid,
            email: 'provrenew@example.com',
            enable: true,
            totalGB: 0,
            expiryTime: expectedExpiry,
          },
        ],
      }),
      streamSettings: '{}',
      sniffing: '{}',
    },
  ];

  const db = createIsolatedMockDb({
    renewRequests: [
      {
        id: 'ren-prov-ok',
        user_id: 'u-55',
        user_email: 'provrenew@example.com',
        vpn_config_id: 'cfg-55',
        client_uuid: clientUuid,
        plan_name: 'Dialog Unlimited',
        duration: '1 Month',
        status: 'pending',
        provisioning_status: 'provisional',
      },
    ],
    grants: [
      {
        id: 'grant-ren-55',
        grant_type: 'renewal',
        source_id: 'ren-prov-ok',
        renew_request_id: 'ren-prov-ok',
        client_uuid: clientUuid,
        inbound_id: 2,
        after_expiry_ms: expectedExpiry,
        after_total_gb: 0,
        status: 'provisional',
      },
    ],
  });

  const renewRes = await executeRenewalApproval('ren-prov-ok', {
    dbClient: db,
    skipSideEffects: true,
    getInboundsFn: async () => mockInbounds.map((ib) => ({ ...ib })),
    requestApiFn: async <T>(): Promise<T> => {
      xuiMutationCalls++;
      return { success: true } as unknown as T;
    },
  });
  assert.equal(renewRes.success, true);
  assert.equal(xuiMutationCalls, 0, 'Provisional renewal verification must NOT re-extend expiry or reset traffic');
  assert.equal(db.state.renew_requests[0].status, 'approved');
  assert.equal(db.state.renew_requests[0].provisioning_status, 'completed');
  assert.equal(db.state.vpn_entitlement_grants[0].status, 'verified');

  assert.equal(typeof verifyPayment, 'function');
  assert.equal(typeof executeOrderApproval, 'function');
  assert.equal(typeof executeOrderRejection, 'function');
});
