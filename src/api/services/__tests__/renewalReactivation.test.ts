import test from 'node:test';
import assert from 'node:assert/strict';
import { updateClientExpiry, addCalendarMonths, XuiInbound } from '../xuiService.js';

function createIsolatedLockMockDb(options?: { failAcquireError?: string; busyLock?: boolean }) {
  const heldLocks = new Map<string, string>();
  const rpcCalls: Array<{ fn: string; args: Record<string, any> }> = [];

  const dbClient = {
    rpcCalls,
    heldLocks,
    async rpc(fn: string, args: Record<string, any>) {
      rpcCalls.push({ fn, args });

      if (fn === 'acquire_provisioning_lock') {
        if (options?.failAcquireError) {
          return {
            data: null,
            error: { message: options.failAcquireError, code: '42501' },
          };
        }
        const key = String(args.p_operation_key);
        if (options?.busyLock || heldLocks.has(key)) {
          return {
            data: [
              {
                acquired: false,
                stale_recovery: false,
                previous_status: 'in_progress',
                holder_owner_id: heldLocks.get(key) || 'other-worker',
              },
            ],
            error: null,
          };
        }
        heldLocks.set(key, String(args.p_lock_owner_id));
        return {
          data: [
            {
              acquired: true,
              stale_recovery: false,
              previous_status: null,
              holder_owner_id: args.p_lock_owner_id,
            },
          ],
          error: null,
        };
      }

      if (fn === 'renew_provisioning_lock') {
        const key = String(args.p_operation_key);
        return {
          data: heldLocks.get(key) === String(args.p_lock_owner_id),
          error: null,
        };
      }

      if (fn === 'release_provisioning_lock') {
        const key = String(args.p_operation_key);
        if (heldLocks.get(key) === String(args.p_lock_owner_id)) {
          heldLocks.delete(key);
        }
        return { data: true, error: null };
      }

      return { data: null, error: { message: `Unexpected RPC in isolated lock mock: ${fn}` } };
    },
  };

  return dbClient;
}

test('updateClientExpiry re-enables an expired client (enable: false -> true), extends expiry, preserves all existing properties, and leaves unrelated clients untouched', async () => {
  const fixedNow = Date.UTC(2026, 10, 12, 12, 0, 0); // 2026-11-12T12:00:00Z
  const expiredTime = Date.UTC(2026, 10, 5, 12, 0, 0); // 2026-11-05T12:00:00Z (in the past)

  const targetUuid = '5b0d4b42-e220-4595-8aff-fccff382f2c8';
  const unrelatedExpiredUuid = 'ea7b8372-f26b-4d3d-a22a-d6b755985439';

  let liveClientsState: any[] = [
    {
      id: targetUuid,
      email: 'customer_renew_test',
      password: 'custom-secret-password',
      flow: 'xtls-rprx-vision',
      security: 'reality',
      auth: 'none',
      comment: 'VIP customer',
      limitIp: 2,
      totalGB: 100 * 1024 * 1024 * 1024,
      expiryTime: expiredTime,
      enable: false, // 3X-UI automatically disabled this client on expiry
      tgId: 12345,
      subId: 'sub_existing_abc123',
      reset: 0,
      created_at: 1790000000000,
    },
    {
      id: unrelatedExpiredUuid,
      email: 'unrelated_expired_user',
      flow: '',
      limitIp: 0,
      totalGB: 0,
      expiryTime: expiredTime,
      enable: false, // Must remain false!
      tgId: 0,
      subId: 'sub_unrelated_999',
      reset: 0,
    },
  ];

  const buildMockInbounds = (): XuiInbound[] => [
    {
      id: 2,
      up: 1024,
      down: 2048,
      total: 0,
      remark: 'DIALOG/ AIRTEL/ ROUTERS',
      enable: true,
      expiryTime: 0,
      clientStats: null,
      port: 443,
      protocol: 'vless',
      settings: JSON.stringify({ clients: liveClientsState }),
      streamSettings: JSON.stringify({ network: 'tcp', security: 'tls' }),
      tag: 'inbound-443',
      sniffing: '{}',
    },
  ];

  const mockLockDb = createIsolatedLockMockDb();
  const capturedApiCalls: Array<{ endpoint: string; method?: string; data?: any }> = [];

  const result = await updateClientExpiry(
    targetUuid,
    1, // 1 Month renewal
    'SIM 100GB',
    expiredTime,
    {
      nowMs: fixedNow,
      dbClient: mockLockDb,
      getInboundsFn: async () => buildMockInbounds(),
      requestApiFn: async <T>(endpoint: string, method?: 'GET' | 'POST', data?: any): Promise<T> => {
        capturedApiCalls.push({ endpoint, method, data });

        if (endpoint === `/panel/api/inbounds/updateClient/${targetUuid}` && data?.settings) {
          const parsedSettings = JSON.parse(data.settings);
          const updatedClient = parsedSettings.clients[0];
          liveClientsState = liveClientsState.map((cl) =>
            cl.id === targetUuid ? { ...cl, ...updatedClient } : cl
          );
          return { success: true } as unknown as T;
        }

        throw new Error(`Unexpected endpoint: ${endpoint}`);
      },
    }
  );

  const expectedExpiryMs = addCalendarMonths(fixedNow, 1);

  assert.equal(result.verifiedEnable, true);
  assert.equal(result.inboundId, 2);
  assert.equal(result.new_expiryMs, expectedExpiryMs);
  assert.equal(result.newTotalBytes, 200 * 1024 * 1024 * 1024);

  // Verify durable inbound lock was acquired, renewed before mutation, and released cleanly
  assert.ok(mockLockDb.rpcCalls.some((c) => c.fn === 'acquire_provisioning_lock' && c.args.p_operation_key === 'inbound:2'));
  assert.ok(mockLockDb.rpcCalls.some((c) => c.fn === 'renew_provisioning_lock' && c.args.p_operation_key === 'inbound:2'));
  assert.ok(mockLockDb.rpcCalls.some((c) => c.fn === 'release_provisioning_lock' && c.args.p_operation_key === 'inbound:2'));
  assert.equal(mockLockDb.heldLocks.size, 0, 'Inbound lock must be released after renewal');

  // Verify the updated client in 3X-UI state has enable: true and all original properties preserved
  const renewedClient = liveClientsState.find((c) => c.id === targetUuid);
  assert.ok(renewedClient, 'Renewed client must still exist');
  assert.equal(renewedClient.enable, true, 'Renewed client enable must be true');
  assert.equal(renewedClient.expiryTime, expectedExpiryMs, 'Renewed client expiryTime must be extended');
  assert.equal(renewedClient.id, targetUuid, 'UUID must be preserved');
  assert.equal(renewedClient.email, 'customer_renew_test', 'Email/identifier must be preserved');
  assert.equal(renewedClient.password, 'custom-secret-password', 'Password must be preserved');
  assert.equal(renewedClient.flow, 'xtls-rprx-vision', 'Flow must be preserved');
  assert.equal(renewedClient.security, 'reality', 'Security must be preserved');
  assert.equal(renewedClient.subId, 'sub_existing_abc123', 'Subscription subId must be preserved');
  assert.equal(renewedClient.limitIp, 2, 'limitIp must be preserved');
  assert.equal(renewedClient.tgId, 12345, 'tgId must be preserved');

  // Verify unrelated expired client was NOT enabled
  const unrelatedClient = liveClientsState.find((c) => c.id === unrelatedExpiredUuid);
  assert.equal(unrelatedClient?.enable, false, 'Unrelated expired client must remain disabled');
});

test('updateClientExpiry throws a clear error if 3X-UI fails to reactivate the client (enable remains false)', async () => {
  const fixedNow = Date.UTC(2026, 10, 12, 12, 0, 0);
  const expiredTime = Date.UTC(2026, 10, 1, 12, 0, 0);
  const targetUuid = 'c22f72f4-77f6-4cb1-8c7d-ed86ea0353e5';

  const stubbornDisabledClient = {
    id: targetUuid,
    email: 'stubborn_client',
    limitIp: 0,
    totalGB: 0,
    expiryTime: expiredTime,
    enable: false,
    subId: 'sub_stubborn',
    reset: 0,
  };

  const mockInbounds: XuiInbound[] = [
    {
      id: 2,
      up: 0,
      down: 0,
      total: 0,
      remark: 'DIALOG/ AIRTEL/ ROUTERS',
      enable: true,
      expiryTime: 0,
      clientStats: null,
      port: 443,
      protocol: 'vless',
      settings: JSON.stringify({ clients: [stubbornDisabledClient] }),
      streamSettings: '{}',
      tag: 'inbound-443',
      sniffing: '{}',
    },
  ];

  const mockLockDb = createIsolatedLockMockDb();

  await assert.rejects(
    async () => {
      await updateClientExpiry(targetUuid, 1, 'SIM Unlimited', expiredTime, {
        nowMs: fixedNow,
        dbClient: mockLockDb,
        getInboundsFn: async () => mockInbounds, // Simulates 3X-UI still returning enable: false after update
        requestApiFn: async <T>(): Promise<T> => ({ success: true } as unknown as T),
      });
    },
    /Failed to verify 3X-UI client reactivation/
  );

  // Verify lock was released as failed even when reactivation verification threw
  assert.equal(mockLockDb.heldLocks.size, 0, 'Inbound lock must be released on failure');
  assert.ok(
    mockLockDb.rpcCalls.some((c) => c.fn === 'release_provisioning_lock' && c.args.p_status === 'failed'),
    'Lock release must record failed status'
  );
});
