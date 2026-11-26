import test from 'node:test';
import assert from 'node:assert/strict';
import {
  updateClientExpiry,
  revokeProvisionalOrderClient,
  revokeProvisionalRenewal,
  provisionOrderClient,
  requestApi,
  isDefinitiveNonAppliedMutationError,
  XuiInbound,
} from '../xuiService.js';
import { executeOrderRejection } from '../../controllers/adminController.js';
import { executeRenewalApproval, executeRenewalRejection } from '../../controllers/renewController.js';

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
  rpcErrorOnAcquire?: any;
  onRenewLock?: (key: string, ownerId: string, locks: Map<string, LockRecord>) => boolean | undefined;
}

function createLockSafeMockDb(opts: MockDbOptions = {}) {
  const tables: Record<string, any[]> = {
    orders: [],
    vpn_accounts: [],
    vpn_configs: [],
    vpn_entitlement_grants: [],
    renew_requests: [],
    settings: [],
    provisioning_templates: [],
    ...(opts.tables || {}),
  };

  const locks = new Map<string, LockRecord>();
  for (const [key, partial] of Object.entries(opts.initialLocks || {})) {
    locks.set(key, {
      operation_key: key,
      operation_type: partial.operation_type || 'inbound_write',
      target_id: partial.target_id || 'other-target',
      lock_owner_id: partial.lock_owner_id || 'other-worker',
      status: partial.status || 'in_progress',
      client_uuid: partial.client_uuid ?? null,
      error_message: partial.error_message ?? null,
    });
  }

  const rpcCalls: Array<{ fn: string; args: any; result?: any }> = [];
  const updateCalls: Array<{ table: string; payload: any; filters: Array<[string, string, any]> }> = [];

  const matchesFilters = (row: any, filters: Array<[string, string, any]>) =>
    filters.every(([op, col, val]) => {
      const rv = row?.[col];
      if (op === 'eq') return String(rv) === String(val);
      if (op === 'neq') return String(rv) !== String(val);
      if (op === 'ilike') return String(rv || '').toLowerCase() === String(val || '').toLowerCase();
      if (op === 'in') return Array.isArray(val) && val.includes(rv);
      return true;
    });

  const makeQuery = (table: string) => {
    const filters: Array<[string, string, any]> = [];
    let mode: 'select' | 'update' | 'insert' | 'upsert' = 'select';
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
      eq: (col: string, val: any) => {
        filters.push(['eq', col, val]);
        return q;
      },
      neq: (col: string, val: any) => {
        filters.push(['neq', col, val]);
        return q;
      },
      ilike: (col: string, val: any) => {
        filters.push(['ilike', col, val]);
        return q;
      },
      in: (col: string, val: any) => {
        filters.push(['in', col, val]);
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

  return {
    tables,
    locks,
    rpcCalls,
    updateCalls,
    from: (table: string) => makeQuery(table),
    rpc: async (fn: string, args: any) => {
      if (fn === 'acquire_provisioning_lock') {
        if (opts.rpcErrorOnAcquire) {
          rpcCalls.push({ fn, args, result: { error: opts.rpcErrorOnAcquire } });
          return { data: null, error: opts.rpcErrorOnAcquire };
        }
        const key = String(args.p_operation_key);
        const existing = locks.get(key);
        if (existing) {
          if (existing.status === 'in_progress') {
            const row = {
              acquired: false,
              stale_recovery: false,
              previous_status: existing.status,
              previous_operation_type: existing.operation_type,
              holder_owner_id: existing.lock_owner_id,
            };
            rpcCalls.push({ fn, args, result: row });
            return { data: [row], error: null };
          }
          if (existing.status === 'uncertain' && !args.p_allow_uncertain_recovery) {
            const row = {
              acquired: false,
              stale_recovery: false,
              previous_status: 'uncertain',
              previous_operation_type: existing.operation_type,
              holder_owner_id: existing.lock_owner_id,
            };
            rpcCalls.push({ fn, args, result: row });
            return { data: [row], error: null };
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
        const row = {
          acquired: true,
          stale_recovery: existing?.status === 'uncertain',
          previous_status: existing?.status ?? null,
          previous_operation_type: existing?.operation_type ?? null,
        };
        rpcCalls.push({ fn, args, result: row });
        return { data: [row], error: null };
      }

      if (fn === 'renew_provisioning_lock') {
        const key = String(args.p_operation_key);
        const ownerId = String(args.p_lock_owner_id);
        let ok: boolean;
        if (opts.onRenewLock) {
          const override = opts.onRenewLock(key, ownerId, locks);
          if (override !== undefined) {
            ok = override;
          } else {
            const cur = locks.get(key);
            ok = Boolean(cur && cur.status === 'in_progress' && cur.lock_owner_id === ownerId);
          }
        } else {
          const cur = locks.get(key);
          ok = Boolean(cur && cur.status === 'in_progress' && cur.lock_owner_id === ownerId);
        }
        rpcCalls.push({ fn, args, result: ok });
        return { data: ok, error: null };
      }

      if (fn === 'release_provisioning_lock') {
        const key = String(args.p_operation_key);
        const ownerId = String(args.p_lock_owner_id);
        const cur = locks.get(key);
        if (cur && cur.lock_owner_id === ownerId) {
          cur.status = args.p_status;
          cur.error_message = args.p_error_message ?? null;
          rpcCalls.push({ fn, args, result: true });
          return { data: true, error: null };
        }
        rpcCalls.push({ fn, args, result: false });
        return { data: false, error: null };
      }

      return { data: null, error: null };
    },
  };
}

function makeInbound(inboundId: number, client: any): XuiInbound {
  return {
    id: inboundId,
    up: 1000,
    down: 2000,
    total: 0,
    remark: 'SG-Main',
    enable: true,
    expiryTime: 0,
    tag: `inbound-${inboundId}`,
    port: 443,
    protocol: 'vless',
    settings: JSON.stringify({ clients: [client] }),
    streamSettings: JSON.stringify({ network: 'ws', security: 'tls' }),
    sniffing: JSON.stringify({ enabled: true }),
    clientStats: [
      {
        id: 1,
        inboundId,
        enable: client.enable !== false,
        email: client.email,
        up: 1000,
        down: 2000,
        expiryTime: Number(client.expiryTime || 0),
        total: Number(client.totalGB || 0),
        reset: 0,
      },
    ],
  };
}

// Scenario 1: Order lock loss immediately before provisional rejection
test('LOCK-FINAL-1: Order lock loss immediately before provisional rejection aborts BEFORE 3X-UI POST with zero external writes', async () => {
  const orderId = '11111111-1111-4111-8111-111111111101';
  const clientUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
  let postCalls = 0;

  const db = createLockSafeMockDb({
    tables: {
      orders: [
        {
          id: orderId,
          order_id: 'ORD-LOCK-1',
          status: 'pending',
          payment_status: 'Pending Verification',
          provisioning_status: 'provisional',
          client_uuid: clientUuid,
          email: 'user1@example.com',
        },
      ],
      vpn_entitlement_grants: [
        {
          id: 'grant-1',
          grant_type: 'new_order',
          source_id: orderId,
          order_id: orderId,
          client_uuid: clientUuid,
          inbound_id: 7,
          provisional: true,
          status: 'provisional',
        },
      ],
      vpn_accounts: [{ id: 'acc-1', order_id: orderId, uuid: clientUuid, status: 'active' }],
      vpn_configs: [{ id: 'cfg-1', order_id: orderId, uuid: clientUuid, enabled: true, status: 'active' }],
    },
    onRenewLock: (key) => {
      if (key === `order:${orderId}`) return false; // Simulate lost order lock before 3X-UI mutation
      return undefined;
    },
  });

  const inbound = makeInbound(7, { id: clientUuid, email: 'u1', enable: true, expiryTime: Date.now() + 86400000, totalGB: 0 });
  const requestApiFn: any = async (endpoint: string, method: string) => {
    if (method === 'GET') return { success: true, obj: inbound };
    postCalls++;
    return { success: true };
  };

  await assert.rejects(
    () =>
      revokeProvisionalOrderClient(orderId, 'Invalid slip', {
        dbClient: db,
        requestApiFn,
        getInboundsFn: async () => [inbound],
      }),
    (err: any) => err.statusCode === 409 && err.code === 'ORDER_LOCK_LOST' && err.beforeExternalWrite === true
  );

  assert.equal(postCalls, 0, 'Must dispatch ZERO 3X-UI POSTs when order lock is lost');
  assert.equal(db.tables.vpn_entitlement_grants[0].status, 'provisional', 'Must NOT overwrite grant with revoke_failed on lock loss');
  assert.equal(db.locks.get('inbound:7')?.status, 'failed', 'Inbound lock must release cleanly as failed (not uncertain)');
});

// Scenario 2: Renewal lock loss before external mutation (manual approval & provisional rejection)
test('LOCK-FINAL-2: Renewal lock loss before external mutation aborts BOTH executeRenewalApproval and revokeProvisionalRenewal with zero 3X-UI POSTs', async () => {
  const reqApproveId = 'ren-lock-loss-approve';
  const reqRejectId = 'ren-lock-loss-reject';
  const clientUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02';
  const now = Date.now();
  let postCalls = 0;

  const dbApprove = createLockSafeMockDb({
    tables: {
      renew_requests: [
        {
          id: reqApproveId,
          status: 'pending',
          user_email: 'user2@example.com',
          plan_name: 'SIM Unlimited',
          durationMonths: 1,
          uuid: clientUuid,
        },
      ],
      vpn_accounts: [{ id: 'acc-2', uuid: clientUuid, email: 'user2@example.com', expiry_time: now - 3600000 }],
      vpn_entitlement_grants: [],
    },
    onRenewLock: (key) => (key === `renew:${reqApproveId}` ? false : undefined),
  });

  const inbound = makeInbound(9, { id: clientUuid, email: 'u2', enable: false, expiryTime: now - 3600000, totalGB: 0 });
  const requestApiFn: any = async (endpoint: string, method: string) => {
    if (method === 'GET') return { success: true, obj: inbound };
    postCalls++;
    return { success: true };
  };

  await assert.rejects(
    () =>
      executeRenewalApproval(reqApproveId, {
        dbClient: dbApprove,
        requestApiFn,
        getInboundsFn: async () => [inbound],
        getClientExpiryFn: async () => now - 3600000,
        skipSideEffects: true,
      }),
    (err: any) => err.statusCode === 409 && err.code === 'RENEW_LOCK_LOST'
  );
  assert.equal(postCalls, 0, 'Manual renewal approval must dispatch ZERO 3X-UI POSTs after renew lock loss');

  const grantedExpiry = now + 30 * 86400000;
  const prevExpiry = now + 5 * 86400000;
  const inboundProv = makeInbound(9, { id: clientUuid, email: 'u2', enable: true, expiryTime: grantedExpiry, totalGB: 0 });
  const dbReject = createLockSafeMockDb({
    tables: {
      renew_requests: [{ id: reqRejectId, status: 'pending', user_email: 'user2@example.com', plan_name: 'SIM Unlimited' }],
      vpn_entitlement_grants: [
        {
          id: 'rgrant-2',
          grant_type: 'renewal',
          source_id: reqRejectId,
          client_uuid: clientUuid,
          inbound_id: 9,
          status: 'provisional',
          previous_expiry_ms: prevExpiry,
          previous_total_bytes: 0,
          previous_enable: true,
          granted_expiry_ms: grantedExpiry,
          granted_total_bytes: 0,
          pre_renewal_db_snapshot: { vpn_account: { id: 'acc-2' }, vpn_config: { exists: false }, parent_order: {} },
        },
      ],
    },
    onRenewLock: (key) => (key === `renew:${reqRejectId}` ? false : undefined),
  });

  await assert.rejects(
    () =>
      executeRenewalRejection(reqRejectId, 'Fake receipt', {
        dbClient: dbReject,
        requestApiFn: async (_ep: string, method: string) => {
          if (method === 'GET') return { success: true, obj: inboundProv };
          postCalls++;
          return { success: true };
        },
        getInboundsFn: async () => [inboundProv],
        skipSideEffects: true,
      }),
    (err: any) => err.statusCode === 409 && err.code === 'RENEW_LOCK_LOST'
  );
  assert.equal(postCalls, 0, 'Provisional renewal rejection must dispatch ZERO 3X-UI POSTs after renew lock loss');
});

// Scenario 3: Client lock loss before external mutation
test('LOCK-FINAL-3: Client lock loss before external mutation aborts manual renewal approval AND provisional renewal rejection with zero 3X-UI POSTs', async () => {
  const clientUuid = 'cccccccc-cccc-4ccc-8ccc-cccccccccc03';
  const now = Date.now();
  let postCalls = 0;
  const inbound = makeInbound(11, { id: clientUuid, email: 'u3', enable: false, expiryTime: now - 10000, totalGB: 0 });

  const dbApprove = createLockSafeMockDb({
    tables: {
      renew_requests: [{ id: 'ren-cli-1', status: 'pending', user_email: 'u3@example.com', plan_name: 'SIM Unlimited', durationMonths: 1, uuid: clientUuid }],
      vpn_accounts: [{ id: 'acc-3', uuid: clientUuid, email: 'u3@example.com', expiry_time: now - 10000 }],
    },
    onRenewLock: (key) => (key === `client:${clientUuid}` ? false : undefined),
  });

  await assert.rejects(
    () =>
      executeRenewalApproval('ren-cli-1', {
        dbClient: dbApprove,
        requestApiFn: async (_ep: string, method: string) => {
          if (method === 'GET') return { success: true, obj: inbound };
          postCalls++;
          return { success: true };
        },
        getInboundsFn: async () => [inbound],
        getClientExpiryFn: async () => now - 10000,
        skipSideEffects: true,
      }),
    (err: any) => err.statusCode === 409 && err.code === 'CLIENT_LOCK_LOST'
  );
  assert.equal(postCalls, 0);

  const grantedExpiry = now + 30 * 86400000;
  const inboundProv = makeInbound(11, { id: clientUuid, email: 'u3', enable: true, expiryTime: grantedExpiry, totalGB: 0 });
  const dbReject = createLockSafeMockDb({
    tables: {
      vpn_entitlement_grants: [
        {
          id: 'rgrant-3',
          grant_type: 'renewal',
          source_id: 'ren-cli-2',
          client_uuid: clientUuid,
          inbound_id: 11,
          status: 'provisional',
          previous_expiry_ms: now + 50000,
          previous_total_bytes: 0,
          previous_enable: true,
          granted_expiry_ms: grantedExpiry,
          granted_total_bytes: 0,
          pre_renewal_db_snapshot: { vpn_account: { id: 'acc-3' }, vpn_config: { exists: false }, parent_order: {} },
        },
      ],
    },
    onRenewLock: (key) => (key === `client:${clientUuid}` ? false : undefined),
  });

  await assert.rejects(
    () =>
      revokeProvisionalRenewal('ren-cli-2', 'Invalid slip', {
        dbClient: dbReject,
        requestApiFn: (async (_ep: string, method: string) => {
          if (method === 'GET') return { success: true, obj: inboundProv };
          postCalls++;
          return { success: true };
        }) as any,
        getInboundsFn: async () => [inboundProv],
      }),
    (err: any) => err.statusCode === 409 && err.code === 'CLIENT_LOCK_LOST'
  );
  assert.equal(postCalls, 0);
});

// Scenario 4: Inbound lock loss before external mutation
test('LOCK-FINAL-4: Inbound lock loss before external mutation aborts updateClientExpiry, revokeProvisionalOrderClient, and revokeProvisionalRenewal with zero POSTs', async () => {
  const clientUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddd04';
  const orderId = '44444444-4444-4444-8444-444444444404';
  const now = Date.now();
  let postCalls = 0;

  const inbound = makeInbound(12, { id: clientUuid, email: 'u4', enable: true, expiryTime: now + 86400000, totalGB: 0 });
  const db = createLockSafeMockDb({
    tables: {
      orders: [{ id: orderId, order_id: 'ORD-4', status: 'pending', payment_status: 'Pending Verification', provisioning_status: 'provisional', client_uuid: clientUuid }],
      vpn_entitlement_grants: [
        {
          id: 'g-4',
          grant_type: 'new_order',
          source_id: orderId,
          order_id: orderId,
          client_uuid: clientUuid,
          inbound_id: 12,
          provisional: true,
          status: 'provisional',
        },
      ],
    },
    onRenewLock: (key) => (key === 'inbound:12' ? false : undefined),
  });

  const requestApiFn: any = async (_ep: string, method: string) => {
    if (method === 'GET') return { success: true, obj: inbound };
    postCalls++;
    return { success: true };
  };

  await assert.rejects(
    () => updateClientExpiry(clientUuid, 1, 'SIM Unlimited', now, { dbClient: db, getInboundsFn: async () => [inbound], requestApiFn }),
    (err: any) => err.statusCode === 409 && err.code === 'INBOUND_LOCK_LOST'
  );
  await assert.rejects(
    () => revokeProvisionalOrderClient(orderId, 'Bad slip', { dbClient: db, getInboundsFn: async () => [inbound], requestApiFn }),
    (err: any) => err.statusCode === 409 && err.code === 'INBOUND_LOCK_LOST'
  );
  assert.equal(postCalls, 0);
});

// Scenario 5: Lock ownership changes during slow 3X-UI authentication / re-authentication
test('LOCK-FINAL-5: requestApi revalidates lock ownership via beforeSend AFTER slow auth and AFTER 401 re-auth, aborting BEFORE POST dispatch', async () => {
  let authCalls = 0;
  let updatePostCalls = 0;
  let lockOwned = true;
  let mode: 'lose_during_initial_auth' | 'lose_during_reauth' = 'lose_during_initial_auth';

  const isolatedConfig = {
    panelUrl: 'https://panel.isolated-unit-test.invalid:2053',
    username: 'admin',
    password: 'secret',
  };

  const authHeadersFn = async (_cfg: any, forceRefresh: boolean) => {
    authCalls++;
    if (mode === 'lose_during_initial_auth') {
      lockOwned = false; // Lock expires/transfers while initial 3X-UI auth is in flight!
    } else if (mode === 'lose_during_reauth' && forceRefresh) {
      lockOwned = false; // Lock expires/transfers while 401 re-authentication is in flight!
    }
    return { Cookie: `3x-ui=session-${authCalls}` };
  };

  const httpRequestFn = async () => {
    updatePostCalls++;
    if (mode === 'lose_during_reauth' && updatePostCalls === 1) {
      return { status: 401, statusText: 'Unauthorized', data: 'Unauthorized' };
    }
    return { status: 200, statusText: 'OK', data: { success: true, obj: { ok: true } } };
  };

  // Part A: Lock lost during initial authentication -> ZERO POST requests reach 3X-UI
  await assert.rejects(
    () =>
      requestApi('/panel/api/inbounds/update/99', 'POST', { id: 99 }, {
        configOverride: isolatedConfig,
        authHeadersFn,
        httpRequestFn,
        beforeSend: async () => {
          if (!lockOwned) {
            const e: any = new Error('Lost lock during auth');
            e.statusCode = 409;
            e.code = 'LOCK_LOST_DURING_AUTH';
            e.beforeExternalWrite = true;
            e.xuiUncertain = false;
            throw e;
          }
        },
      }),
    (err: any) => err.code === 'LOCK_LOST_DURING_AUTH'
  );
  assert.equal(authCalls, 1);
  assert.equal(updatePostCalls, 0, 'Must abort before dispatching POST when lock is lost during initial auth');

  // Part B: Lock valid initially, 1st POST gets 401 -> re-auth runs -> lock lost during re-auth -> 2nd POST NOT sent
  mode = 'lose_during_reauth';
  lockOwned = true;
  await assert.rejects(
    () =>
      requestApi('/panel/api/inbounds/update/99', 'POST', { id: 99 }, {
        configOverride: isolatedConfig,
        authHeadersFn,
        httpRequestFn,
        beforeSend: async () => {
          if (!lockOwned) {
            const e: any = new Error('Lost lock during re-auth');
            e.statusCode = 409;
            e.code = 'LOCK_LOST_DURING_REAUTH';
            e.beforeExternalWrite = true;
            e.xuiUncertain = false;
            throw e;
          }
        },
      }),
    (err: any) => err.code === 'LOCK_LOST_DURING_REAUTH'
  );
  assert.equal(authCalls, 3, 'Initial auth + re-auth after 401 should have executed');
  assert.equal(updatePostCalls, 1, 'Must NOT dispatch retry POST after lock is lost during 401 re-auth');
});

// Scenario 6: Both AUTO_ACTIVATE flags false while manual renewal approval remains durably locked
test('LOCK-FINAL-6: Manual renewal approval remains durably locked (fail-closed) when BOTH AUTO_ACTIVATE_NEW_ORDERS_ENABLED=false and AUTO_ACTIVATE_RENEWALS_ENABLED=false', async () => {
  const prevNew = process.env.AUTO_ACTIVATE_NEW_ORDERS_ENABLED;
  const prevRen = process.env.AUTO_ACTIVATE_RENEWALS_ENABLED;
  process.env.AUTO_ACTIVATE_NEW_ORDERS_ENABLED = 'false';
  process.env.AUTO_ACTIVATE_RENEWALS_ENABLED = 'false';

  try {
    let postCalls = 0;
    const dbPermDenied = createLockSafeMockDb({
      tables: {
        renew_requests: [{ id: 'ren-flags-off', status: 'pending', user_email: 'u6@example.com', plan_name: 'SIM Unlimited', durationMonths: 1, uuid: 'uuid-6' }],
      },
      rpcErrorOnAcquire: { code: '42501', message: 'permission denied for function acquire_provisioning_lock' },
    });

    await assert.rejects(
      () =>
        executeRenewalApproval('ren-flags-off', {
          dbClient: dbPermDenied,
          requestApiFn: async () => {
            postCalls++;
            return { success: true };
          },
          skipSideEffects: true,
        }),
      (err: any) => err.statusCode === 503 && err.code === 'LOCK_PERMISSION_ERROR'
    );
    assert.equal(postCalls, 0);

    // Also verify missing RPC / unavailable client fails closed (no silent bypass!)
    const dbMissingRpc = createLockSafeMockDb({
      tables: {
        renew_requests: [{ id: 'ren-flags-off-2', status: 'pending', user_email: 'u6@example.com', plan_name: 'SIM Unlimited', durationMonths: 1, uuid: 'uuid-6' }],
      },
      rpcErrorOnAcquire: { code: 'PGRST202', message: 'Could not find the function acquire_provisioning_lock' },
    });
    await assert.rejects(
      () => executeRenewalApproval('ren-flags-off-2', { dbClient: dbMissingRpc, skipSideEffects: true }),
      (err: any) => err.statusCode === 503
    );
  } finally {
    if (prevNew === undefined) delete process.env.AUTO_ACTIVATE_NEW_ORDERS_ENABLED;
    else process.env.AUTO_ACTIVATE_NEW_ORDERS_ENABLED = prevNew;
    if (prevRen === undefined) delete process.env.AUTO_ACTIVATE_RENEWALS_ENABLED;
    else process.env.AUTO_ACTIVATE_RENEWALS_ENABLED = prevRen;
  }
});

// Scenario 7: Uncertain inbound lock rejection (allowUncertainRecovery: false)
test('LOCK-FINAL-7: Uncertain inbound lock is rejected (409 INBOUND_LOCK_UNCERTAIN) with zero 3X-UI writes across updateClientExpiry, revokeProvisionalOrderClient, and revokeProvisionalRenewal', async () => {
  const clientUuid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee07';
  const orderId = '77777777-7777-4777-8777-777777777707';
  const now = Date.now();
  const grantedExpiry = now + 30 * 86400000;
  let postCalls = 0;

  const inbound = makeInbound(15, { id: clientUuid, email: 'u7', enable: true, expiryTime: grantedExpiry, totalGB: 0 });
  const requestApiFn: any = async (_ep: string, method: string) => {
    if (method === 'GET') return { success: true, obj: inbound };
    postCalls++;
    return { success: true };
  };

  const db = createLockSafeMockDb({
    initialLocks: {
      'inbound:15': { status: 'uncertain', operation_type: 'inbound_write', lock_owner_id: 'crashed-worker' },
    },
    tables: {
      orders: [{ id: orderId, order_id: 'ORD-7', status: 'pending', payment_status: 'Pending Verification', provisioning_status: 'provisional', client_uuid: clientUuid }],
      vpn_entitlement_grants: [
        {
          id: 'g-order-7',
          grant_type: 'new_order',
          source_id: orderId,
          order_id: orderId,
          client_uuid: clientUuid,
          inbound_id: 15,
          provisional: true,
          status: 'provisional',
        },
        {
          id: 'g-renew-7',
          grant_type: 'renewal',
          source_id: 'ren-unc-ib-7',
          client_uuid: clientUuid,
          inbound_id: 15,
          status: 'provisional',
          previous_expiry_ms: now + 50000,
          previous_total_bytes: 0,
          previous_enable: true,
          granted_expiry_ms: grantedExpiry,
          granted_total_bytes: 0,
          pre_renewal_db_snapshot: { vpn_account: { id: 'acc-7' }, vpn_config: { exists: false }, parent_order: {} },
        },
      ],
    },
  });

  await assert.rejects(
    () => updateClientExpiry(clientUuid, 1, 'SIM Unlimited', now, { dbClient: db, getInboundsFn: async () => [inbound], requestApiFn }),
    (err: any) => err.statusCode === 409 && err.code === 'INBOUND_LOCK_UNCERTAIN'
  );
  await assert.rejects(
    () => revokeProvisionalOrderClient(orderId, 'Bad slip', { dbClient: db, getInboundsFn: async () => [inbound], requestApiFn }),
    (err: any) => err.statusCode === 409 && err.code === 'INBOUND_LOCK_UNCERTAIN'
  );
  await assert.rejects(
    () => revokeProvisionalRenewal('ren-unc-ib-7', 'Bad slip', { dbClient: db, getInboundsFn: async () => [inbound], requestApiFn }),
    (err: any) => err.statusCode === 409 && err.code === 'INBOUND_LOCK_UNCERTAIN'
  );
  assert.equal(postCalls, 0);
  assert.equal(db.locks.get('inbound:15')?.status, 'uncertain', 'Uncertain inbound lock must remain preserved as uncertain');
});

// Scenario 8: Lease loss between alternate endpoint attempts in updateClientExpiry
test('LOCK-FINAL-8: Lease loss between alternate endpoint attempts in updateClientExpiry stops before dispatching 2nd endpoint', async () => {
  const clientUuid = 'ffffffff-ffff-4fff-8fff-ffffffffff08';
  const now = Date.now();
  let renewChecks = 0;
  const postEndpoints: string[] = [];

  const inbound = makeInbound(18, { id: clientUuid, email: 'u8', enable: false, expiryTime: now - 10000, totalGB: 0 });
  const db = createLockSafeMockDb({
    onRenewLock: (key) => {
      if (key === 'inbound:18') {
        renewChecks++;
        return renewChecks === 1; // 1st check passes, 2nd check (before 2nd endpoint) fails!
      }
      return undefined;
    },
  });

  const requestApiFn: any = async (endpoint: string, method: string) => {
    if (method === 'POST') {
      postEndpoints.push(endpoint);
      const notFoundErr: any = new Error('Request failed with status code 404');
      notFoundErr.statusCode = 404;
      throw notFoundErr;
    }
    return { success: true, obj: inbound };
  };

  await assert.rejects(
    () => updateClientExpiry(clientUuid, 1, 'SIM Unlimited', now - 10000, { dbClient: db, getInboundsFn: async () => [inbound], requestApiFn }),
    (err: any) => err.statusCode === 409 && err.code === 'INBOUND_LOCK_LOST'
  );
  assert.equal(postEndpoints.length, 1, 'Must NOT attempt 2nd endpoint after lock is lost between attempts');
});

// Scenario 9: Ambiguous external mutation response without duplicate writes
test('LOCK-FINAL-9: Ambiguous external mutation error (ETIMEDOUT/504) in updateClientExpiry refuses alternate endpoint retry and marks RECONCILIATION_REQUIRED', async () => {
  const clientUuid = '12121212-1212-4121-8121-121212121209';
  const now = Date.now();
  const postEndpoints: string[] = [];
  const inbound = makeInbound(19, { id: clientUuid, email: 'u9', enable: false, expiryTime: now - 10000, totalGB: 0 });
  const db = createLockSafeMockDb();

  const requestApiFn: any = async (endpoint: string, method: string) => {
    if (method === 'POST') {
      postEndpoints.push(endpoint);
      const timeoutErr: any = new Error('connect ETIMEDOUT 1.2.3.4:443');
      timeoutErr.code = 'ETIMEDOUT';
      throw timeoutErr;
    }
    return { success: true, obj: inbound };
  };

  await assert.rejects(
    () => updateClientExpiry(clientUuid, 1, 'SIM Unlimited', now - 10000, { dbClient: db, getInboundsFn: async () => [inbound], requestApiFn }),
    (err: any) =>
      err.statusCode === 409 &&
      err.code === 'RECONCILIATION_REQUIRED' &&
      err.xuiUncertain === true &&
      err.markLockUncertain === true
  );
  assert.equal(postEndpoints.length, 1, 'Must NEVER replay an ambiguous mutation to an alternate endpoint or fallback');
  assert.equal(db.locks.get('inbound:19')?.status, 'uncertain', 'Inbound lock must be marked uncertain after ambiguous external write');
});

// Scenario 10: HTTP timeout before external mutation dispatch
test('LOCK-FINAL-10: HTTP timeout (AbortSignal) fired BEFORE external mutation aborts cleanly with 504, zero 3X-UI writes, and failed (non-uncertain) lock', async () => {
  const clientUuid = '13131313-1313-4131-8131-131313131310';
  const orderId = '10101010-1010-4101-8101-101010101010';
  const now = Date.now();
  let postCalls = 0;

  const inbound = makeInbound(20, { id: clientUuid, email: 'u10', enable: true, expiryTime: now + 86400000, totalGB: 0 });
  const db = createLockSafeMockDb({
    tables: {
      orders: [{ id: orderId, order_id: 'ORD-10', status: 'pending', payment_status: 'Pending Verification', provisioning_status: 'provisional', client_uuid: clientUuid }],
      vpn_entitlement_grants: [
        { id: 'g-10', grant_type: 'new_order', source_id: orderId, order_id: orderId, client_uuid: clientUuid, inbound_id: 20, provisional: true, status: 'provisional' },
      ],
    },
  });

  const controller = new AbortController();
  controller.abort(); // Timeout fired BEFORE external mutation dispatch

  const requestApiFn: any = async (_ep: string, method: string) => {
    if (method === 'GET') return { success: true, obj: inbound };
    postCalls++;
    return { success: true };
  };

  // Part A: Signal already aborted before updateClientExpiry even acquires inbound lock
  await assert.rejects(
    () =>
      updateClientExpiry(clientUuid, 1, 'SIM Unlimited', now, {
        dbClient: db,
        getInboundsFn: async () => [inbound],
        requestApiFn,
        signal: controller.signal,
      }),
    (err: any) => err.statusCode === 504 && err.code === 'REQUEST_TIMEOUT_BEFORE_MUTATION' && err.beforeExternalWrite === true
  );
  assert.equal(db.locks.get('inbound:20'), undefined, 'Pre-lock timeout should not acquire inbound lock');

  // Part B: Signal fires AFTER inbound lock is acquired (during inbound refresh) but BEFORE POST dispatch
  const midController = new AbortController();
  let getCalls = 0;
  await assert.rejects(
    () =>
      updateClientExpiry(clientUuid, 1, 'SIM Unlimited', now, {
        dbClient: db,
        getInboundsFn: async () => {
          getCalls++;
          if (getCalls >= 2) midController.abort(); // Fires inside withInboundWriteLock before POST
          return [inbound];
        },
        requestApiFn,
        signal: midController.signal,
      }),
    (err: any) => err.statusCode === 504 && err.code === 'REQUEST_TIMEOUT_BEFORE_MUTATION' && err.beforeExternalWrite === true
  );
  assert.equal(db.locks.get('inbound:20')?.status, 'failed', 'Inbound lock must release cleanly as failed (not uncertain)');

  await assert.rejects(
    () =>
      revokeProvisionalOrderClient(orderId, 'Bad slip', {
        dbClient: db,
        getInboundsFn: async () => [inbound],
        requestApiFn,
        signal: controller.signal,
      }),
    (err: any) => err.statusCode === 504 && err.code === 'REQUEST_TIMEOUT_BEFORE_MUTATION' && err.beforeExternalWrite === true
  );
  assert.equal(postCalls, 0);
  assert.equal(db.locks.get(`order:${orderId}`)?.status, 'failed');
  assert.equal(db.tables.vpn_entitlement_grants[0].status, 'provisional');
});

// Scenario 11: HTTP timeout after external mutation dispatch
test('LOCK-FINAL-11: HTTP timeout AFTER external mutation allows safe read-back + owned DB finalization and blocks any 2nd external mutation', async () => {
  const clientUuid = '14141414-1414-4141-8141-141414141411';
  const orderId = '11111111-1111-4111-8111-111111111111';
  const now = Date.now();

  // Part A: Order rejection where HTTP timeout fires DURING the 3X-UI POST -> read-back & owned DB finalization complete safely!
  let clientEnabled = true;
  let postCountA = 0;
  const controllerA = new AbortController();
  const makeIbA = () => makeInbound(21, { id: clientUuid, email: 'u11', enable: clientEnabled, expiryTime: now + 86400000, totalGB: 0 });
  const dbA = createLockSafeMockDb({
    tables: {
      orders: [{ id: orderId, order_id: 'ORD-11', status: 'pending', payment_status: 'Pending Verification', provisioning_status: 'provisional', client_uuid: clientUuid }],
      vpn_entitlement_grants: [
        { id: 'g-11', grant_type: 'new_order', source_id: orderId, order_id: orderId, client_uuid: clientUuid, inbound_id: 21, provisional: true, status: 'provisional' },
      ],
      vpn_accounts: [{ id: 'acc-11', order_id: orderId, uuid: clientUuid, status: 'active' }],
      vpn_configs: [{ id: 'cfg-11', order_id: orderId, uuid: clientUuid, enabled: true, status: 'active' }],
    },
  });

  const resA = await executeOrderRejection(orderId, 'Bad receipt', {
    dbClient: dbA,
    signal: controllerA.signal,
    skipSideEffects: true,
    getInboundsFn: async () => [makeIbA()],
    requestApiFn: async (_ep: string, method: string) => {
      if (method === 'POST') {
        postCountA++;
        clientEnabled = false;
        controllerA.abort(); // HTTP deadline fires right after 3X-UI write was dispatched!
        return { success: true };
      }
      return { success: true, obj: makeIbA() };
    },
  });

  assert.equal(postCountA, 1);
  assert.equal(resA.order.status, 'rejected');
  assert.equal(dbA.tables.vpn_entitlement_grants[0].status, 'revoked');
  assert.equal(dbA.locks.get(`order:${orderId}`)?.status, 'completed');

  // Part B: updateClientExpiry where HTTP timeout fires after 1st POST and read-back shows client not yet updated -> MUST NOT send 2nd fallback POST!
  const controllerB = new AbortController();
  let postCountB = 0;
  const staleInbound = makeInbound(22, { id: clientUuid, email: 'u11b', enable: false, expiryTime: now - 10000, totalGB: 0 });
  const dbB = createLockSafeMockDb();

  await assert.rejects(
    () =>
      updateClientExpiry(clientUuid, 1, 'SIM Unlimited', now - 10000, {
        dbClient: dbB,
        signal: controllerB.signal,
        getInboundsFn: async () => [staleInbound],
        requestApiFn: (async (_ep: string, method: string) => {
          if (method === 'POST') {
            postCountB++;
            controllerB.abort(); // Deadline elapsed after 1st write!
            return { success: true };
          }
          return { success: true, obj: staleInbound };
        }) as any,
      }),
    (err: any) => err.statusCode === 409 && err.code === 'RECONCILIATION_REQUIRED' && err.xuiUncertain === true
  );
  assert.equal(postCountB, 1, 'Must NOT dispatch a 2nd external fallback write after HTTP deadline has elapsed');
  assert.equal(dbB.locks.get('inbound:22')?.status, 'uncertain');
});

// Scenario 12: Safe post-write reconciliation on ambiguous 3X-UI error
test('LOCK-FINAL-12: Ambiguous network failure during revocation POST marks lock & grant uncertain / RECONCILIATION_REQUIRED instead of revoke_failed', async () => {
  const clientUuid = '15151515-1515-4151-8151-151515151512';
  const orderId = '12121212-1212-4121-8121-121212121212';
  const now = Date.now();
  const inbound = makeInbound(23, { id: clientUuid, email: 'u12', enable: true, expiryTime: now + 86400000, totalGB: 0 });

  const db = createLockSafeMockDb({
    tables: {
      orders: [{ id: orderId, order_id: 'ORD-12', status: 'pending', payment_status: 'Pending Verification', provisioning_status: 'provisional', client_uuid: clientUuid }],
      vpn_entitlement_grants: [
        { id: 'g-12', grant_type: 'new_order', source_id: orderId, order_id: orderId, client_uuid: clientUuid, inbound_id: 23, provisional: true, status: 'provisional' },
      ],
    },
  });

  await assert.rejects(
    () =>
      executeOrderRejection(orderId, 'Bad slip', {
        dbClient: db,
        skipSideEffects: true,
        getInboundsFn: async () => [inbound],
        requestApiFn: async (_ep: string, method: string) => {
          if (method === 'POST') {
            const err: any = new Error('socket hang up');
            err.code = 'ECONNRESET';
            throw err;
          }
          return { success: true, obj: inbound };
        },
      }),
    (err: any) => err.statusCode === 409 && err.code === 'RECONCILIATION_REQUIRED' && err.markLockUncertain === true
  );

  assert.equal(db.tables.vpn_entitlement_grants[0].status, 'uncertain');
  assert.equal(db.tables.orders[0].provisioning_status, 'uncertain');
  assert.equal(db.locks.get(`order:${orderId}`)?.status, 'uncertain');
  assert.equal(db.locks.get('inbound:23')?.status, 'uncertain');
});

// Scenario 13: Stale worker database finalization prevention
test('LOCK-FINAL-13: Stale worker whose lock transfers AFTER 3X-UI write refuses to mutate DB tables and throws 409 RECONCILIATION_REQUIRED', async () => {
  const clientUuid = '16161616-1616-4161-8161-161616161613';
  const orderId = '13131313-1313-4131-8131-131313131313';
  const renewId = 'ren-stale-worker-13';
  const now = Date.now();

  // Part A: Provisional order rejection — lock transfers to another worker AFTER 3X-UI disable succeeds
  let clientEnabledA = true;
  const makeIbA = () => makeInbound(24, { id: clientUuid, email: 'u13a', enable: clientEnabledA, expiryTime: now + 86400000, totalGB: 0 });
  const dbA = createLockSafeMockDb({
    tables: {
      orders: [{ id: orderId, order_id: 'ORD-13', status: 'pending', payment_status: 'Pending Verification', provisioning_status: 'provisional', client_uuid: clientUuid }],
      vpn_entitlement_grants: [
        { id: 'g-13', grant_type: 'new_order', source_id: orderId, order_id: orderId, client_uuid: clientUuid, inbound_id: 24, provisional: true, status: 'provisional' },
      ],
      vpn_accounts: [{ id: 'acc-13', order_id: orderId, uuid: clientUuid, status: 'active' }],
      vpn_configs: [{ id: 'cfg-13', order_id: orderId, uuid: clientUuid, enabled: true, status: 'active' }],
    },
  });

  await assert.rejects(
    () =>
      executeOrderRejection(orderId, 'Bad slip', {
        dbClient: dbA,
        skipSideEffects: true,
        getInboundsFn: async () => [makeIbA()],
        requestApiFn: async (_ep: string, method: string) => {
          if (method === 'POST') {
            clientEnabledA = false;
            // Simulate lock lease expiring and transferring to worker-B AFTER 3X-UI write!
            const rec = dbA.locks.get(`order:${orderId}`);
            if (rec) rec.lock_owner_id = 'worker-B-new-owner';
            return { success: true };
          }
          return { success: true, obj: makeIbA() };
        },
      }),
    (err: any) => err.statusCode === 409 && err.code === 'RECONCILIATION_REQUIRED'
  );

  assert.equal(dbA.updateCalls.length, 0, 'Stale worker MUST NOT execute any DB updates on orders/grants/accounts/configs');
  assert.equal(dbA.tables.orders[0].status, 'pending');
  assert.equal(dbA.tables.vpn_entitlement_grants[0].status, 'provisional');
  assert.equal(dbA.locks.get(`order:${orderId}`)?.lock_owner_id, 'worker-B-new-owner', 'Must NOT release or overwrite another worker lock');

  // Part B: Manual renewal approval — renew lock transfers to worker-B AFTER 3X-UI update succeeds
  let expiryB = now - 3600000;
  let enableB = false;
  const makeIbB = () => makeInbound(25, { id: clientUuid, email: 'u13b', enable: enableB, expiryTime: expiryB, totalGB: 0 });
  const dbB = createLockSafeMockDb({
    tables: {
      renew_requests: [{ id: renewId, status: 'pending', user_email: 'u13b@example.com', plan_name: 'SIM Unlimited', durationMonths: 1, uuid: clientUuid }],
      vpn_accounts: [{ id: 'acc-13b', uuid: clientUuid, email: 'u13b@example.com', expiry_time: now - 3600000, status: 'expired' }],
      vpn_configs: [{ id: 'cfg-13b', uuid: clientUuid, enabled: false, status: 'expired' }],
      vpn_entitlement_grants: [],
    },
  });

  await assert.rejects(
    () =>
      executeRenewalApproval(renewId, {
        dbClient: dbB,
        skipSideEffects: true,
        getClientExpiryFn: async () => now - 3600000,
        getInboundsFn: async () => [makeIbB()],
        requestApiFn: async (_ep: string, method: string, body: any) => {
          if (method === 'POST') {
            const parsed = JSON.parse(body.settings);
            expiryB = parsed.clients[0].expiryTime;
            enableB = parsed.clients[0].enable;
            const rec = dbB.locks.get(`renew:${renewId}`);
            if (rec) rec.lock_owner_id = 'worker-B-renew-owner';
            return { success: true };
          }
          return { success: true, obj: makeIbB() };
        },
      }),
    (err: any) => err.statusCode === 409 && err.code === 'RECONCILIATION_REQUIRED'
  );

  assert.equal(dbB.updateCalls.length, 0, 'Stale renewal worker MUST NOT finalize renew_requests/vpn_accounts/vpn_configs');
  assert.equal(dbB.tables.renew_requests[0].status, 'pending');
  assert.equal(dbB.locks.get(`renew:${renewId}`)?.lock_owner_id, 'worker-B-renew-owner', 'Must preserve new worker ownership on lock');
});

// Scenario 14 (Finding 1): Generic 3X-UI { success: false } / xuiExplicitRejection MUST NOT assume non-applied without panel verification
test('LOCK-FINAL-14: Generic xuiExplicitRejection requires live panel verification before retrying or failing', async () => {
  // Part A: isDefinitiveNonAppliedMutationError rejects generic xuiExplicitRejection
  assert.equal(isDefinitiveNonAppliedMutationError({ xuiExplicitRejection: true }), false);
  assert.equal(isDefinitiveNonAppliedMutationError({ statusCode: 404 }), true);
  assert.equal(isDefinitiveNonAppliedMutationError({ code: 'ECONNREFUSED' }), true);

  const clientUuid = '17171717-1717-4171-8171-171717171714';
  const now = Date.now();
  const pastExpiry = now - 60_000;

  // Part B: 1st POST throws xuiExplicitRejection=true AFTER actually applying state on 3X-UI -> read-back confirms applied, ZERO 2nd POST
  let appliedClient = { id: clientUuid, email: 'u14b', enable: false, expiryTime: pastExpiry, totalGB: 0 };
  const makeIbB = () => makeInbound(31, appliedClient);
  const dbB = createLockSafeMockDb();
  let postCountB = 0;

  const resB = await updateClientExpiry(clientUuid, 1, 'SIM Unlimited', pastExpiry, {
    dbClient: dbB,
    nowMs: now,
    getInboundsFn: async () => [makeIbB()],
    requestApiFn: (async (_ep: string, method: string, body: any) => {
      if (method === 'POST') {
        postCountB++;
        const parsed = body?.settings ? JSON.parse(body.settings).clients[0] : body;
        appliedClient = { ...appliedClient, enable: true, expiryTime: parsed.expiryTime };
        const rejectErr: any = new Error('3X-UI API Error: false success message after write');
        rejectErr.xuiExplicitRejection = true;
        throw rejectErr;
      }
      return { success: true, obj: makeIbB() };
    }) as any,
  });
  assert.equal(resB.verifiedEnable, true);
  assert.equal(postCountB, 1, 'Must NOT dispatch a 2nd POST when read-back proves mutation actually persisted');
  assert.equal(dbB.locks.get('inbound:31')?.status, 'completed');

  // Part C: 1st POST throws xuiExplicitRejection=true AND live panel read-back proves strictly unchanged -> safe to try next endpoint
  let cClient = { id: clientUuid, email: 'u14c', enable: false, expiryTime: pastExpiry, totalGB: 0 };
  const makeIbC = () => makeInbound(32, cClient);
  const dbC = createLockSafeMockDb();
  let postCountC = 0;

  const resC = await updateClientExpiry(clientUuid, 1, 'SIM Unlimited', pastExpiry, {
    dbClient: dbC,
    nowMs: now,
    getInboundsFn: async () => [makeIbC()],
    requestApiFn: (async (_ep: string, method: string, body: any) => {
      if (method === 'POST') {
        postCountC++;
        if (postCountC === 1) {
          const rejectErr: any = new Error('3X-UI API Error: Invalid format');
          rejectErr.xuiExplicitRejection = true;
          throw rejectErr;
        }
        cClient = { ...cClient, enable: true, expiryTime: body.expiryTime };
        return { success: true };
      }
      return { success: true, obj: makeIbC() };
    }) as any,
  });
  assert.equal(resC.verifiedEnable, true);
  assert.equal(postCountC, 2, 'Proceeds to 2nd endpoint only after read-back confirms strictly unchanged panel state');
  assert.equal(dbC.locks.get('inbound:32')?.status, 'completed');

  // Part D: 1st POST throws xuiExplicitRejection=true AND read-back fails (or shows partial change) -> 409 RECONCILIATION_REQUIRED, ZERO 2nd POST
  let dClient = { id: clientUuid, email: 'u14d', enable: false, expiryTime: pastExpiry, totalGB: 0 };
  const makeIbD = () => makeInbound(33, dClient);
  const dbD = createLockSafeMockDb();
  let postCountD = 0;

  await assert.rejects(
    () =>
      updateClientExpiry(clientUuid, 1, 'SIM Unlimited', pastExpiry, {
        dbClient: dbD,
        nowMs: now,
        getInboundsFn: async () => {
          if (postCountD === 0) return [makeIbD()];
          throw new Error('Read-back unreachable after generic rejection');
        },
        requestApiFn: (async (_ep: string, method: string) => {
          if (method === 'POST') {
            postCountD++;
            const rejectErr: any = new Error('3X-UI API Error: Unknown error');
            rejectErr.xuiExplicitRejection = true;
            throw rejectErr;
          }
          return { success: true, obj: makeIbD() };
        }) as any,
      }),
    (err: any) => err.statusCode === 409 && err.code === 'RECONCILIATION_REQUIRED' && err.xuiUncertain === true && err.markLockUncertain === true
  );
  assert.equal(postCountD, 1, 'Must refuse alternate endpoint when read-back cannot prove state unchanged');
  assert.equal(dbD.locks.get('inbound:33')?.status, 'uncertain');

  // Part E: revokeProvisionalOrderClient with generic rejection + failed read-back marks order/grant/lock uncertain (NOT revoke_failed)
  const orderIdE = '14141414-1414-4141-8141-141414141414';
  const ibE = makeInbound(34, { id: clientUuid, email: 'u14e', enable: true, expiryTime: now + 86400000, totalGB: 0 });
  const dbE = createLockSafeMockDb({
    tables: {
      orders: [{ id: orderIdE, order_id: 'ORD-14E', status: 'pending', payment_status: 'Pending Verification', provisioning_status: 'provisional', client_uuid: clientUuid }],
      vpn_entitlement_grants: [{ id: 'g-14e', grant_type: 'new_order', source_id: orderIdE, order_id: orderIdE, client_uuid: clientUuid, inbound_id: 34, provisional: true, status: 'provisional' }],
    },
  });
  let getCallsE = 0;
  await assert.rejects(
    () =>
      revokeProvisionalOrderClient(orderIdE, 'Bad slip', {
        dbClient: dbE,
        getInboundsFn: async () => {
          getCallsE++;
          if (getCallsE === 1) return [ibE];
          throw new Error('3X-UI unreachable on read-back');
        },
        requestApiFn: (async (_ep: string, method: string) => {
          if (method === 'GET') {
            getCallsE++;
            if (getCallsE === 1) return { obj: ibE };
            throw new Error('3X-UI unreachable on GET');
          }
          const rejectErr: any = new Error('3X-UI API Error: false');
          rejectErr.xuiExplicitRejection = true;
          throw rejectErr;
        }) as any,
      }),
    (err: any) => err.statusCode === 409 && err.code === 'RECONCILIATION_REQUIRED' && err.markLockUncertain === true
  );
  assert.equal(dbE.tables.vpn_entitlement_grants[0].status, 'uncertain');
  assert.equal(dbE.tables.orders[0].provisioning_status, 'uncertain');
  assert.equal(dbE.locks.get('inbound:34')?.status, 'uncertain');
  assert.equal(dbE.locks.get(`order:${orderIdE}`)?.status, 'uncertain');
});

// Scenario 15 (Finding 2): requestApi synchronous deadline check AFTER beforeSend completes (initial & 401 re-auth) + safe redirect check
test('LOCK-FINAL-15: requestApi rejects with 504 BEFORE HTTP POST dispatch if AbortSignal fires during async beforeSend (initial & re-auth)', async () => {
  const isolatedConfig = {
    panelUrl: 'https://panel.isolated-unit-test.invalid:2053',
    username: 'admin',
    password: 'secret',
  };

  // Part A: Abort fires INSIDE beforeSend on initial POST
  const ctrlA = new AbortController();
  let postDispatchedA = 0;
  await assert.rejects(
    () =>
      requestApi('/panel/api/inbounds/update/41', 'POST', { id: 41 }, {
        configOverride: isolatedConfig,
        signal: ctrlA.signal,
        authHeadersFn: async () => ({ Cookie: '3x-ui=ok' }),
        beforeSend: async () => {
          await new Promise((r) => setTimeout(r, 5));
          ctrlA.abort(); // Expires while lock-renewal RPC inside beforeSend was awaiting!
        },
        httpRequestFn: async () => {
          postDispatchedA++;
          return { status: 200, statusText: 'OK', data: { success: true, obj: {} } };
        },
      }),
    (err: any) => err.statusCode === 504 && err.code === 'REQUEST_TIMEOUT_BEFORE_MUTATION' && err.beforeExternalWrite === true
  );
  assert.equal(postDispatchedA, 0, 'Must abort synchronously AFTER beforeSend and BEFORE dispatching initial POST');

  // Part B: 1st POST gets 401 -> re-auth succeeds -> Abort fires INSIDE re-auth beforeSend -> retry POST NOT dispatched
  const ctrlB = new AbortController();
  let postDispatchedB = 0;
  let beforeSendCountB = 0;
  await assert.rejects(
    () =>
      requestApi('/panel/api/inbounds/update/42', 'POST', { id: 42 }, {
        configOverride: isolatedConfig,
        signal: ctrlB.signal,
        authHeadersFn: async () => ({ Cookie: '3x-ui=ok' }),
        beforeSend: async () => {
          beforeSendCountB++;
          if (beforeSendCountB === 2) {
            await new Promise((r) => setTimeout(r, 5));
            ctrlB.abort(); // Expires during post-reauth beforeSend!
          }
        },
        httpRequestFn: async () => {
          postDispatchedB++;
          return { status: 401, statusText: 'Unauthorized', data: 'Unauthorized' };
        },
      }),
    (err: any) => err.statusCode === 504 && err.code === 'REQUEST_TIMEOUT_BEFORE_MUTATION' && err.beforeExternalWrite === true
  );
  assert.equal(beforeSendCountB, 2);
  assert.equal(postDispatchedB, 1, 'Must NOT dispatch retry POST after AbortSignal fires during re-auth beforeSend');

  // Part C: POST receiving 302 redirect to non-login path MUST NOT blindly re-auth and replay POST
  let postDispatchedC = 0;
  let authCallsC = 0;
  await assert.rejects(
    () =>
      requestApi('/panel/api/inbounds/update/43', 'POST', { id: 43 }, {
        configOverride: isolatedConfig,
        authHeadersFn: async () => {
          authCallsC++;
          return { Cookie: '3x-ui=ok' };
        },
        httpRequestFn: async () => {
          postDispatchedC++;
          return { status: 302, statusText: 'Found', headers: { location: '/panel/inbounds' }, data: '' } as any;
        },
      }),
    (err: any) => err.statusCode === 302
  );
  assert.equal(authCallsC, 1, 'Non-login 302 on POST must not trigger blind re-auth');
  assert.equal(postDispatchedC, 1, 'Non-login 302 on POST must not replay POST');
});

// Scenario 16: Post-dispatch lock loss / auth retry classification safety
test('LOCK-FINAL-16: Post-dispatch lock loss classifies as RECONCILIATION_REQUIRED (uncertain), while post-401 reauth login failure stays beforeExternalWrite', async () => {
  // Part A: updateClientExpiry 1st POST returns 200 (client stays disabled), then inbound lock is lost before fallback POST -> RECONCILIATION_REQUIRED + uncertain lock
  const clientUuid = '18181818-1818-4181-8181-181818181816';
  const now = Date.now();
  const pastExpiry = now - 60_000;
  const staleInbound = makeInbound(44, { id: clientUuid, email: 'u16a', enable: false, expiryTime: pastExpiry, totalGB: 0 });
  let renewCalls = 0;
  let postCount = 0;
  const dbA = createLockSafeMockDb({
    onRenewLock: (key) => {
      if (key === 'inbound:44') {
        renewCalls++;
        // Allow initial pre-POST checks (calls 1-2), fail lock check right before fallback POST!
        return renewCalls <= 2;
      }
      return undefined;
    },
  });

  await assert.rejects(
    () =>
      updateClientExpiry(clientUuid, 1, 'SIM Unlimited', pastExpiry, {
        dbClient: dbA,
        nowMs: now,
        getInboundsFn: async () => [staleInbound],
        requestApiFn: (async (_ep: string, method: string, _body?: any, opts?: any) => {
          if (opts?.beforeSend) await opts.beforeSend();
          if (method === 'POST') {
            postCount++;
            return { success: true };
          }
          return { success: true, obj: staleInbound };
        }) as any,
      }),
    (err: any) =>
      err.statusCode === 409 &&
      err.code === 'RECONCILIATION_REQUIRED' &&
      err.beforeExternalWrite === false &&
      err.xuiUncertain === true &&
      err.markLockUncertain === true
  );
  assert.equal(postCount, 1, 'Must abort fallback POST when lock lost');
  assert.equal(dbA.locks.get('inbound:44')?.status, 'uncertain', 'Must mark inbound lock uncertain after earlier 200 POST');

  // Part B: 1st POST gets 401 -> /login reauth times out -> error tagged beforeExternalWrite=true, xuiUncertain=false
  await assert.rejects(
    () =>
      requestApi('/panel/api/inbounds/update/45', 'POST', { id: 45 }, {
        configOverride: { panelUrl: 'https://panel.isolated-unit-test.invalid:2053', username: 'a', password: 'b' },
        authHeadersFn: async (_cfg, forceRefresh) => {
          if (forceRefresh) {
            const loginTimeout: any = new Error('connect ETIMEDOUT during /login');
            loginTimeout.code = 'ETIMEDOUT';
            throw loginTimeout;
          }
          return { Cookie: '3x-ui=expired' };
        },
        httpRequestFn: async () => ({ status: 401, statusText: 'Unauthorized', data: 'Unauthorized' }),
      }),
    (err: any) => err.code === 'ETIMEDOUT' && err.beforeExternalWrite === true && err.xuiUncertain === false
  );
});

// Scenario 17: HTTP 400/422 MUST NOT bypass live panel verification or allow unsafe duplicate writes
test('LOCK-FINAL-17: HTTP 400/422 requires live panel read-back verification before retry, handles applied/ambiguous/lock-loss/deadline-expiry safely', async () => {
  // Part A: isDefinitiveNonAppliedMutationError refuses unconditional 400/422 (numeric & message regex) while keeping 404/405/ECONNREFUSED
  assert.equal(isDefinitiveNonAppliedMutationError({ statusCode: 400 }), false);
  assert.equal(isDefinitiveNonAppliedMutationError({ status: 422 }), false);
  assert.equal(isDefinitiveNonAppliedMutationError({ response: { status: 400 } }), false);
  assert.equal(isDefinitiveNonAppliedMutationError({ response: { status: 422 } }), false);
  assert.equal(isDefinitiveNonAppliedMutationError(new Error('3X-UI API Error: 400 Bad Request')), false);
  assert.equal(isDefinitiveNonAppliedMutationError(new Error('3X-UI API Error: 422 Unprocessable Entity')), false);
  assert.equal(isDefinitiveNonAppliedMutationError({ statusCode: 404 }), true);
  assert.equal(isDefinitiveNonAppliedMutationError({ statusCode: 405 }), true);

  const clientUuid = '19191919-1919-4191-8191-191919191917';
  const now = Date.now();
  const pastExpiry = now - 60_000;

  const extractExpiryFromBody = (body: any): number => {
    if (body?.expiryTime !== undefined) return Number(body.expiryTime);
    const parsed = typeof body?.settings === 'string' ? JSON.parse(body.settings) : body?.settings;
    return Number(parsed?.clients?.[0]?.expiryTime || 0);
  };

  // Part B: HTTP 400 with unchanged live panel state allows safe fallback only while locks & deadline hold
  let bClient = { id: clientUuid, email: 'u17b', enable: false, expiryTime: pastExpiry, totalGB: 0 };
  const makeIbB = () => makeInbound(50, bClient);
  const dbB = createLockSafeMockDb();
  const epsB: string[] = [];
  const resB = await updateClientExpiry(clientUuid, 1, 'SIM Unlimited', pastExpiry, {
    dbClient: dbB,
    nowMs: now,
    getInboundsFn: async () => [makeIbB()],
    requestApiFn: (async (ep: string, method: string, body: any, opts?: any) => {
      if (opts?.beforeSend) await opts.beforeSend();
      if (method === 'POST') {
        epsB.push(ep);
        if (epsB.length === 1) {
          const err400: any = new Error('3X-UI API Error: 400 Bad Request');
          err400.statusCode = 400;
          throw err400;
        }
        bClient = { ...bClient, enable: true, expiryTime: extractExpiryFromBody(body) };
        return { success: true };
      }
      return { success: true, obj: makeIbB() };
    }) as any,
  });
  assert.equal(resB.verifiedEnable, true);
  assert.equal(epsB.length, 2, 'Safe fallback allowed after HTTP 400 verified strictly unchanged');
  assert.equal(dbB.locks.get('inbound:50')?.status, 'completed');

  // Part C: HTTP 422 with unchanged live panel state allows safe fallback only while locks & deadline hold
  let cClient = { id: clientUuid, email: 'u17c', enable: false, expiryTime: pastExpiry, totalGB: 0 };
  const makeIbC = () => makeInbound(51, cClient);
  const dbC = createLockSafeMockDb();
  const epsC: string[] = [];
  const resC = await updateClientExpiry(clientUuid, 1, 'SIM Unlimited', pastExpiry, {
    dbClient: dbC,
    nowMs: now,
    getInboundsFn: async () => [makeIbC()],
    requestApiFn: (async (ep: string, method: string, body: any, opts?: any) => {
      if (opts?.beforeSend) await opts.beforeSend();
      if (method === 'POST') {
        epsC.push(ep);
        if (epsC.length === 1) {
          const err422: any = new Error('3X-UI API Error: 422 Unprocessable Entity');
          err422.statusCode = 422;
          throw err422;
        }
        cClient = { ...cClient, enable: true, expiryTime: extractExpiryFromBody(body) };
        return { success: true };
      }
      return { success: true, obj: makeIbC() };
    }) as any,
  });
  assert.equal(resC.verifiedEnable, true);
  assert.equal(epsC.length, 2, 'Safe fallback allowed after HTTP 422 verified strictly unchanged');
  assert.equal(dbC.locks.get('inbound:51')?.status, 'completed');

  // Part D: HTTP 400/422 where mutation WAS actually applied succeeds cleanly with ZERO duplicate POST
  let dClient = { id: clientUuid, email: 'u17d', enable: false, expiryTime: pastExpiry, totalGB: 0 };
  const makeIbD = () => makeInbound(52, dClient);
  const dbD = createLockSafeMockDb();
  let postCountD = 0;
  const resD = await updateClientExpiry(clientUuid, 1, 'SIM Unlimited', pastExpiry, {
    dbClient: dbD,
    nowMs: now,
    getInboundsFn: async () => [makeIbD()],
    requestApiFn: (async (_ep: string, method: string, body: any, opts?: any) => {
      if (opts?.beforeSend) await opts.beforeSend();
      if (method === 'POST') {
        postCountD++;
        dClient = { ...dClient, enable: true, expiryTime: extractExpiryFromBody(body) };
        const err422: any = new Error('3X-UI API Error: 422 Unprocessable Entity');
        err422.statusCode = 422;
        throw err422;
      }
      return { success: true, obj: makeIbD() };
    }) as any,
  });
  assert.equal(resD.verifiedEnable, true);
  assert.equal(postCountD, 1, 'Must NOT dispatch duplicate POST when read-back shows HTTP 422 applied the mutation');
  assert.equal(dbD.locks.get('inbound:52')?.status, 'completed');

  // Part E: HTTP 400/422 with unavailable or partially-changed read-back -> 409 RECONCILIATION_REQUIRED, ZERO 2nd POST
  const eClient = { id: clientUuid, email: 'u17e', enable: false, expiryTime: pastExpiry, totalGB: 0 };
  const makeIbE = () => makeInbound(53, eClient);
  const dbE = createLockSafeMockDb();
  let postCountE = 0;
  await assert.rejects(
    () =>
      updateClientExpiry(clientUuid, 1, 'SIM Unlimited', pastExpiry, {
        dbClient: dbE,
        nowMs: now,
        getInboundsFn: async () => {
          if (postCountE === 0) return [makeIbE()];
          throw new Error('Read-back unreachable after 400');
        },
        requestApiFn: (async (_ep: string, method: string) => {
          if (method === 'POST') {
            postCountE++;
            const err400: any = new Error('3X-UI API Error: 400 Bad Request');
            err400.statusCode = 400;
            throw err400;
          }
          return { success: true, obj: makeIbE() };
        }) as any,
      }),
    (err: any) => err.statusCode === 409 && err.code === 'RECONCILIATION_REQUIRED' && err.markLockUncertain === true
  );
  assert.equal(postCountE, 1, 'Must refuse duplicate POST when read-back fails after HTTP 400');
  assert.equal(dbE.locks.get('inbound:53')?.status, 'uncertain');

  // Part F: Lock loss during read-back after HTTP 400 unchanged aborts BEFORE fallback POST
  const fClient = { id: clientUuid, email: 'u17f', enable: false, expiryTime: pastExpiry, totalGB: 0 };
  const makeIbF = () => makeInbound(54, fClient);
  let renewCallsF = 0;
  let postCountF = 0;
  const dbF = createLockSafeMockDb({
    onRenewLock: (key) => {
      if (key === 'inbound:54') {
        renewCallsF++;
        return renewCallsF <= 2; // Lose lock during read-back before 2nd endpoint!
      }
      return undefined;
    },
  });
  await assert.rejects(
    () =>
      updateClientExpiry(clientUuid, 1, 'SIM Unlimited', pastExpiry, {
        dbClient: dbF,
        nowMs: now,
        getInboundsFn: async () => [makeIbF()],
        requestApiFn: (async (_ep: string, method: string, _body?: any, opts?: any) => {
          if (opts?.beforeSend) await opts.beforeSend();
          if (method === 'POST') {
            postCountF++;
            const err400: any = new Error('3X-UI API Error: 400 Bad Request');
            err400.statusCode = 400;
            throw err400;
          }
          return { success: true, obj: makeIbF() };
        }) as any,
      }),
    (err: any) => err.statusCode === 409 && err.code === 'INBOUND_LOCK_LOST' && err.beforeExternalWrite === true
  );
  assert.equal(postCountF, 1, 'Must abort 2nd POST when lock is lost during read-back');

  // Part G: Deadline expiry during read-back after HTTP 422 unchanged aborts BEFORE fallback POST
  const gClient = { id: clientUuid, email: 'u17g', enable: false, expiryTime: pastExpiry, totalGB: 0 };
  const makeIbG = () => makeInbound(55, gClient);
  const dbG = createLockSafeMockDb();
  const ctrlG = new AbortController();
  let postCountG = 0;
  await assert.rejects(
    () =>
      updateClientExpiry(clientUuid, 1, 'SIM Unlimited', pastExpiry, {
        dbClient: dbG,
        nowMs: now,
        signal: ctrlG.signal,
        getInboundsFn: async () => {
          if (postCountG > 0) ctrlG.abort(); // Deadline expires during read-back!
          return [makeIbG()];
        },
        requestApiFn: (async (_ep: string, method: string, _body?: any, opts?: any) => {
          if (opts?.beforeSend) await opts.beforeSend();
          if (method === 'POST') {
            postCountG++;
            const err422: any = new Error('3X-UI API Error: 422 Unprocessable Entity');
            err422.statusCode = 422;
            throw err422;
          }
          return { success: true, obj: makeIbG() };
        }) as any,
      }),
    (err: any) => err.statusCode === 504 && err.code === 'REQUEST_TIMEOUT_BEFORE_MUTATION' && err.beforeExternalWrite === true
  );
  assert.equal(postCountG, 1, 'Must abort 2nd POST when HTTP deadline expires during read-back');
  assert.equal(dbG.locks.get('inbound:55')?.status, 'failed');
});

// Scenario 18: Authentication retry classification safety
test('LOCK-FINAL-18: HTTP 403 after authenticated POST retry is NEVER marked beforeExternalWrite=true; pre-dispatch auth failures & legitimate renewal work properly', async () => {
  const isolatedConfig = {
    panelUrl: 'https://panel.isolated-unit-test.invalid:2053',
    username: 'admin',
    password: 'secret',
  };

  // Part A: 1st POST gets 401 -> re-auth succeeds -> 2nd authenticated POST is dispatched and gets 403 -> beforeExternalWrite MUST be false
  let postAttemptsA = 0;
  await assert.rejects(
    () =>
      requestApi('/panel/api/inbounds/update/60', 'POST', { id: 60 }, {
        configOverride: isolatedConfig,
        authHeadersFn: async (_cfg, forceRefresh) => ({ Cookie: forceRefresh ? '3x-ui=refreshed' : '3x-ui=expired' }),
        httpRequestFn: async () => {
          postAttemptsA++;
          if (postAttemptsA === 1) {
            return { status: 401, statusText: 'Unauthorized', data: 'Unauthorized' };
          }
          return { status: 403, statusText: 'Forbidden', data: 'Forbidden' };
        },
      }),
    (err: any) => err.statusCode === 403 && err.beforeExternalWrite === false && err.xuiUncertain !== false
  );
  assert.equal(postAttemptsA, 2);

  // Part B: Inside updateClientExpiry, HTTP 403 after authenticated POST retry refuses duplicate write and marks uncertain / RECONCILIATION_REQUIRED
  const clientUuid = '20202020-2020-4202-8202-202020202018';
  const now = Date.now();
  const pastExpiry = now - 60_000;
  const ibB = makeInbound(61, { id: clientUuid, email: 'u18b', enable: false, expiryTime: pastExpiry, totalGB: 0 });
  const dbB = createLockSafeMockDb();
  let expiryPostCalls = 0;
  await assert.rejects(
    () =>
      updateClientExpiry(clientUuid, 1, 'SIM Unlimited', pastExpiry, {
        dbClient: dbB,
        nowMs: now,
        getInboundsFn: async () => [ibB],
        requestApiFn: (async (ep: string, method: string, data?: any, opts?: any) => {
          if (method === 'GET') return { success: true, obj: ibB };
          expiryPostCalls++;
          let httpCalls = 0;
          return requestApi(ep, 'POST', data, {
            ...opts,
            configOverride: isolatedConfig,
            authHeadersFn: async (_cfg, forceRefresh) => ({ Cookie: forceRefresh ? '3x-ui=fresh' : '3x-ui=old' }),
            httpRequestFn: async () => {
              httpCalls++;
              return httpCalls === 1
                ? { status: 401, statusText: 'Unauthorized', data: 'Unauthorized' }
                : { status: 403, statusText: 'Forbidden', data: 'Forbidden' };
            },
          });
        }) as any,
      }),
    (err: any) => err.statusCode === 409 && err.code === 'RECONCILIATION_REQUIRED' && err.markLockUncertain === true
  );
  assert.equal(expiryPostCalls, 1, 'Must NOT dispatch a second mutation endpoint after post-retry 403');
  assert.equal(dbB.locks.get('inbound:61')?.status, 'uncertain');

  // Part C: Genuine initial auth failure BEFORE any POST dispatch keeps beforeExternalWrite=true & xuiUncertain=false
  let postAttemptsC = 0;
  await assert.rejects(
    () =>
      requestApi('/panel/api/inbounds/update/62', 'POST', { id: 62 }, {
        configOverride: isolatedConfig,
        authHeadersFn: async () => {
          const authErr: any = new Error('3X-UI initial login rejected (invalid credentials)');
          throw authErr;
        },
        httpRequestFn: async () => {
          postAttemptsC++;
          return { status: 200, statusText: 'OK', data: { success: true, obj: {} } };
        },
      }),
    (err: any) => err.beforeExternalWrite === true && err.xuiUncertain === false
  );
  assert.equal(postAttemptsC, 0, 'Zero POST dispatches allowed when initial auth fails');

  // Part D: Legitimate session renewal (401 -> /login succeeds -> retried POST returns 200) still succeeds
  let postAttemptsD = 0;
  let refreshCountD = 0;
  const okObj = await requestApi('/panel/api/inbounds/update/63', 'POST', { id: 63 }, {
    configOverride: isolatedConfig,
    authHeadersFn: async (_cfg, forceRefresh) => {
      if (forceRefresh) refreshCountD++;
      return { Cookie: forceRefresh ? '3x-ui=fresh' : '3x-ui=expired' };
    },
    httpRequestFn: async (req) => {
      postAttemptsD++;
      if (req.headers.Cookie === '3x-ui=expired') {
        return { status: 401, statusText: 'Unauthorized', data: 'Unauthorized' };
      }
      return { status: 200, statusText: 'OK', data: { success: true, obj: { renewed: true } } };
    },
  });
  assert.equal(refreshCountD, 1);
  assert.equal(postAttemptsD, 2);
  assert.deepEqual(okObj, { renewed: true });
});


