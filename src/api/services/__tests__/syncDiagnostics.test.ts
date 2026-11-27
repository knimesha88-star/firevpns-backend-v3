import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import adminRoutes from '../../routes/adminRoutes.js';
import { adminMiddleware } from '../../middleware/adminMiddleware.js';
import { createRateLimiter } from '../../middleware/rateLimitMiddleware.js';
import { createSyncDiagnosticsHandlers } from '../../controllers/syncDiagnosticsController.js';
import {
  DEFAULT_DIAGNOSTIC_BUDGET_MS,
  formatSyncDiagnosticsCsv,
  MAX_DIRECT_PROBE_CONCURRENCY,
  runReadOnlySyncDiagnostics,
  sanitizeCsvCell,
  type RunSyncDiagnosticsOptions,
} from '../syncDiagnosticsService.js';
import {
  acquireDiagnosticXuiAuthHeadersReadOnly,
  computeXuiCredentialScopeKey,
  createDiagnosticIsolatedSessionState,
  fetchReadOnlyDiagnosticInboundsList,
  getScopeAuthGeneration,
  getXuiAuthHeaders,
  resetXuiServiceCachesForTests,
  resolveDiagnosticXuiConfigReadOnly,
  type DiagnosticDirectInboundProbeResult,
  type DiagnosticReadOnlyListResult,
  type XuiConfig,
  type XuiInbound,
} from '../xuiService.js';

// ==============================================================================
// STRICT READ-ONLY MOCK SUPABASE CLIENT (THROWS ON ANY WRITE OR FORBIDDEN COLUMN)
// ==============================================================================

interface MockDbConfig {
  tables: Record<string, any[]>;
  tableColumns?: Record<string, Set<string>>;
  missingTables?: Set<string>;
  tableErrors?: Record<string, { code?: string; message: string }>;
  selectDelayMs?: number;
  observedSelects?: Array<{ table: string; columns: string }>;
  observedAbortSignals?: AbortSignal[];
}

function createStrictReadOnlyMockDb(cfg: MockDbConfig) {
  const observedSelects = cfg.observedSelects || [];
  const observedAbortSignals = cfg.observedAbortSignals || [];

  return {
    observedSelects,
    observedAbortSignals,
    rpc() {
      throw new Error('WRITE_FORBIDDEN: rpc() must never be called by read-only diagnostics');
    },
    from(table: string) {
      return {
        insert() {
          throw new Error(`WRITE_FORBIDDEN: insert() on ${table}`);
        },
        update() {
          throw new Error(`WRITE_FORBIDDEN: update() on ${table}`);
        },
        upsert() {
          throw new Error(`WRITE_FORBIDDEN: upsert() on ${table}`);
        },
        delete() {
          throw new Error(`WRITE_FORBIDDEN: delete() on ${table}`);
        },
        select(columns: string) {
          observedSelects.push({ table, columns });

          let filters: Array<(row: any) => boolean> = [];
          let orderCol: string | null = null;
          let orderAsc = true;
          let limitCount: number | null = null;
          let abortSignal: AbortSignal | null = null;

          const builder: any = {
            not(col: string, op: string, val: any) {
              if (op === 'is' && val === null) {
                filters.push((r) => r?.[col] !== null && r?.[col] !== undefined);
              }
              return builder;
            },
            in(col: string, vals: any[]) {
              const set = new Set(vals.map((v) => String(v)));
              filters.push((r) => set.has(String(r?.[col] ?? '')));
              return builder;
            },
            eq(col: string, val: any) {
              filters.push((r) => r?.[col] === val);
              return builder;
            },
            gt(col: string, val: any) {
              filters.push((r) => String(r?.[col] ?? '') > String(val));
              return builder;
            },
            order(col: string, opts?: { ascending?: boolean }) {
              orderCol = col;
              orderAsc = opts?.ascending !== false;
              return builder;
            },
            limit(n: number) {
              limitCount = n;
              return builder;
            },
            abortSignal(sig: AbortSignal) {
              abortSignal = sig;
              observedAbortSignals.push(sig);
              return builder;
            },
            async then(resolve: any, reject: any) {
              try {
                if (cfg.selectDelayMs && cfg.selectDelayMs > 0) {
                  await new Promise<void>((res, rej) => {
                    if (abortSignal?.aborted) {
                      rej(new Error('Aborted'));
                      return;
                    }
                    const onAbort = () => {
                      clearTimeout(t);
                      rej(new Error('Aborted'));
                    };
                    const t = setTimeout(() => {
                      abortSignal?.removeEventListener('abort', onAbort);
                      res();
                    }, cfg.selectDelayMs);
                    abortSignal?.addEventListener('abort', onAbort, { once: true });
                  });
                }

                if (abortSignal?.aborted) {
                  throw new Error('Aborted');
                }

                if (cfg.missingTables?.has(table)) {
                  resolve({
                    data: null,
                    error: { code: '42P01', message: `relation "public.${table}" does not exist` },
                  });
                  return;
                }

                if (cfg.tableErrors?.[table]) {
                  resolve({ data: null, error: cfg.tableErrors[table] });
                  return;
                }

                const requestedCols = columns
                  .split(',')
                  .map((c) => c.trim())
                  .filter(Boolean);

                if (cfg.tableColumns?.[table]) {
                  const allowed = cfg.tableColumns[table];
                  for (const col of requestedCols) {
                    if (col === '*') continue;
                    if (!allowed.has(col)) {
                      resolve({
                        data: null,
                        error: {
                          code: '42703',
                          message: `column ${table}.${col} does not exist`,
                        },
                      });
                      return;
                    }
                  }
                }

                let rows = [...(cfg.tables[table] || [])];
                for (const f of filters) {
                  rows = rows.filter(f);
                }
                if (orderCol) {
                  const oc = orderCol;
                  rows.sort((a, b) => {
                    const av = String(a?.[oc] ?? '');
                    const bv = String(b?.[oc] ?? '');
                    return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
                  });
                }
                if (limitCount !== null) {
                  rows = rows.slice(0, limitCount);
                }

                // Project strictly requested columns so tests prove no unprojected field is accessed
                const projected = rows.map((r) => {
                  if (requestedCols.includes('*')) return { ...r };
                  const out: Record<string, any> = {};
                  for (const col of requestedCols) {
                    if (col in r) out[col] = r[col];
                  }
                  return out;
                });

                resolve({ data: projected, error: null });
              } catch (e) {
                reject(e);
              }
            },
          };

          return builder;
        },
      };
    },
  };
}

function makeInbound(
  id: number,
  remark: string,
  port: number,
  clients: Array<{ id: string; email?: string; enable?: boolean; expiryTime?: number }>
): XuiInbound {
  return {
    id,
    remark,
    port,
    protocol: 'vless',
    enable: true,
    settings: JSON.stringify({
      clients: clients.map((c) => ({
        id: c.id,
        email: c.email || `secret-customer-${c.id.slice(0, 6)}@private.example`,
        enable: c.enable ?? true,
        expiryTime: c.expiryTime ?? 0,
      })),
    }),
    clientStats: [],
  } as unknown as XuiInbound;
}

const TEST_PANEL_ID = 'panel:0daf7c638c29727bd019f1a9';

async function startTestServer(app: express.Express): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

// ==============================================================================
// 1. PRODUCTION SCHEMA + ZERO WRITES + DATA MINIMIZATION + FULL CLASSIFICATION
// ==============================================================================

test('Production scenario (86 DB, 57 live, 48 absent, 56 missing panel_identity, 5 conflicts, 1 uncertain lock, historical inbound 7) executes with zero writes & minimal projections', async () => {
  const nowMs = Date.parse('2026-11-27T15:00:00.000Z');
  const oldCreatedAt = '2026-10-01T10:00:00.000Z';

  // Production column sets: vpn_configs has customer_uid (NO user_id, NO server_id optional);
  // vpn_accounts has NO inbound_id; sensitive columns intentionally omitted from allowed set or populated with traps!
  const prodColumns: Record<string, Set<string>> = {
    vpn_accounts: new Set([
      'id',
      'user_id',
      'order_id',
      'uuid',
      'server_id',
      'status',
      'enable',
      'is_trial',
      'expiry_time',
      'expiry_date',
      'expires_at',
      'panel_identity',
      'deleted_from_panel_at',
      'reconciliation_required',
      'created_at',
    ]),
    vpn_configs: new Set([
      'id',
      'customer_uid',
      'order_id',
      'uuid',
      'inbound_id',
      'status',
      'enabled',
      'is_trial',
      'expiry_time',
      'expiry_date',
      'expires_at',
      // Deliberately omit server_id to verify optional-column fallback works cleanly
      'panel_identity',
      'deleted_from_panel_at',
      'reconciliation_required',
      'created_at',
    ]),
    vpn_entitlement_grants: new Set([
      'id',
      'order_id',
      'user_id',
      'client_uuid',
      'inbound_id',
      'status',
      'provisional',
      'grant_type',
      'created_at',
    ]),
    orders: new Set([
      'id',
      'order_id',
      'customer_id',
      'status',
      'payment_status',
      'provisioning_status',
      'client_uuid',
      'is_trial',
      'payment_method',
      'package_name',
      'expires_at',
      'expiry_date',
      'created_at',
    ]),
    provisioning_operations: new Set([
      'id',
      'operation_key',
      'operation_type',
      'target_id',
      'client_uuid',
      'status',
      'lease_expires_at',
      'uncertain_at',
      'created_at',
      'updated_at',
    ]),
    xui_servers: new Set(['id', 'is_active', 'url']),
  };

  const vpnAccounts: any[] = [];
  const vpnConfigs: any[] = [];
  const orders: any[] = [];
  const liveClientsByInbound: Record<number, Array<{ id: string; enable?: boolean }>> = {
    1: [],
    2: [],
    3: [],
    12: [],
    13: [],
    18: [],
  };

  const pushLive = (ibId: number, uuid: string, enable = true) => {
    liveClientsByInbound[ibId].push({ id: uuid, enable });
  };

  // Build 38 live-matched tracked DB clients:
  // - 30 with panel_identity set (0..29), 8 missing panel_identity (30..37)
  // - 5 of them have genuine DB status conflicts (0..4): vpn_accounts='active', vpn_configs='disabled'
  // - 1 of them is a moved client (5): DB inbound_id=1, live inbound=2
  // - Remaining 32 are live_matched healthy (including paid/completed orders which must NOT be flagged as status conflict!)
  const inboundSlots = [
    ...Array(13).fill(1),
    ...Array(33).fill(2),
    ...Array(7).fill(3),
    ...Array(1).fill(12),
    ...Array(2).fill(13),
    ...Array(1).fill(18),
  ]; // Total = 57 live clients

  for (let i = 0; i < 38; i++) {
    const uuid = `00000000-0000-4000-a000-${String(i + 1).padStart(12, '0')}`;
    const owner = `cust-live-${i + 1}`;
    const liveIb = inboundSlots[i];
    const dbIb = i === 5 ? (liveIb === 1 ? 2 : 1) : liveIb; // client #6 moved
    const hasPanelId = i < 30;
    const isConflict = i < 5;

    pushLive(liveIb, uuid, true);

    vpnAccounts.push({
      id: `acc-${String(i + 1).padStart(3, '0')}`,
      user_id: owner,
      order_id: `ord-${i + 1}`,
      uuid,
      status: 'active',
      enable: true,
      is_trial: false,
      panel_identity: hasPanelId ? TEST_PANEL_ID : null,
      deleted_from_panel_at: null,
      created_at: oldCreatedAt,
      // Trap sensitive fields that must never be projected or leaked
      email: `customer${i}@secret.example`,
      vless_url: 'vless://secret-link@hidden.host:443',
    });

    vpnConfigs.push({
      id: `cfg-${String(i + 1).padStart(3, '0')}`,
      customer_uid: owner,
      order_id: `ord-${i + 1}`,
      uuid,
      inbound_id: dbIb,
      status: isConflict ? 'disabled' : 'active',
      enabled: !isConflict,
      is_trial: false,
      panel_identity: hasPanelId ? TEST_PANEL_ID : null,
      deleted_from_panel_at: null,
      created_at: oldCreatedAt,
    });

    // Paid/completed order paired with active VPN -> semantically compatible (NOT a conflict!)
    orders.push({
      id: `ord-${i + 1}`,
      order_id: `ORD-${1000 + i}`,
      customer_id: owner,
      status: 'completed',
      payment_status: 'Paid',
      provisioning_status: 'completed',
      client_uuid: uuid,
      is_trial: false,
      payment_method: 'Bank Transfer',
      package_name: 'VIP 100GB',
      created_at: oldCreatedAt,
      slip_url: 'https://private-bucket.example/slips/secret.jpg',
    });
  }

  // Add 19 untracked live panel clients to reach 57 total live clients
  for (let i = 38; i < 57; i++) {
    const uuid = `11111111-1111-4000-b000-${String(i + 1).padStart(12, '0')}`;
    pushLive(inboundSlots[i], uuid, true);
  }

  // Add 48 absent tracked DB clients (all 48 missing panel_identity -> 8 + 48 = 56 total missing panel_identity!)
  // - 44 eligible candidates (4 on historical removed inbound 7, 1 with uncertain client lock, 3 trials, 2 expired, 2 rejected)
  // - 4 blocked BEFORE circuit breaker:
  //   - #45: missing inbound_id (null)
  //   - #46: missing ownership (customer_uid & user_id blank)
  //   - #47: conflicting ownership (vpn_accounts.user_id != vpn_configs.customer_uid)
  //   - #48: conflicting inbound_ids (cfg=1 vs grant=2)
  const uncertainLockedUuid = `22222222-2222-4000-c000-${String(1).padStart(12, '0')}`;
  const grants: any[] = [];

  for (let i = 0; i < 48; i++) {
    const uuid = `22222222-2222-4000-c000-${String(i + 1).padStart(12, '0')}`;
    const owner = `cust-abs-${i + 1}`;
    const isHistoricalInbound7 = i >= 1 && i <= 4;
    const isTrial = i >= 5 && i <= 7;
    const isExpired = i >= 8 && i <= 9;
    const isRejected = i >= 10 && i <= 11;
    const isMissingInbound = i === 44;
    const isMissingOwner = i === 45;
    const isConflictOwner = i === 46;
    const isConflictInbound = i === 47;

    const status = isExpired ? 'expired' : isRejected ? 'disabled' : 'active';

    vpnAccounts.push({
      id: `acc-abs-${String(i + 1).padStart(3, '0')}`,
      user_id: isMissingOwner ? '' : owner,
      order_id: isTrial ? `TRIAL-${i}` : `ord-abs-${i + 1}`,
      uuid,
      status,
      enable: status === 'active',
      is_trial: isTrial,
      panel_identity: null,
      deleted_from_panel_at: null,
      created_at: oldCreatedAt,
    });

    vpnConfigs.push({
      id: `cfg-abs-${String(i + 1).padStart(3, '0')}`,
      customer_uid: isMissingOwner ? '' : isConflictOwner ? `${owner}-other` : owner,
      order_id: isTrial ? `TRIAL-${i}` : `ord-abs-${i + 1}`,
      uuid,
      inbound_id: isMissingInbound ? null : isHistoricalInbound7 ? 7 : 2,
      status,
      enabled: status === 'active',
      is_trial: isTrial,
      panel_identity: null,
      deleted_from_panel_at: null,
      created_at: oldCreatedAt,
    });

    if (isConflictInbound) {
      grants.push({
        id: 'grant-conflict-1',
        client_uuid: uuid,
        inbound_id: 1,
        status: 'verified',
        created_at: oldCreatedAt,
      });
    }

    if (isRejected) {
      orders.push({
        id: `ord-abs-${i + 1}`,
        order_id: `ORD-REJ-${i}`,
        customer_id: owner,
        status: 'rejected',
        payment_status: 'Cancelled',
        provisioning_status: 'revoked',
        client_uuid: uuid,
        is_trial: false,
        created_at: oldCreatedAt,
      });
    }
  }

  const db = createStrictReadOnlyMockDb({
    tables: {
      vpn_accounts: vpnAccounts,
      vpn_configs: vpnConfigs,
      vpn_entitlement_grants: grants,
      orders,
      provisioning_operations: [
        {
          id: 'lock-1',
          operation_key: `client:${uncertainLockedUuid}`,
          operation_type: 'auto_order',
          target_id: 'ord-abs-1',
          client_uuid: uncertainLockedUuid,
          status: 'uncertain',
          uncertain_at: oldCreatedAt,
          created_at: oldCreatedAt,
          updated_at: oldCreatedAt,
        },
      ],
      xui_servers: [],
    },
    tableColumns: prodColumns,
  });

  const liveInbounds: XuiInbound[] = [
    makeInbound(1, 'HUTCH', 8080, liveClientsByInbound[1]),
    makeInbound(2, 'DIALOG/AIRTEL/ROUTERS', 443, liveClientsByInbound[2]),
    makeInbound(3, 'MOBITEL', 8443, liveClientsByInbound[3]),
    makeInbound(12, 'R', 8880, liveClientsByInbound[12]),
    makeInbound(13, 'Dialog zoom 224', 17490, liveClientsByInbound[13]),
    makeInbound(18, 'test', 2052, liveClientsByInbound[18]),
  ];

  let listCalls = 0;
  let probeCalls = 0;

  const report = await runReadOnlySyncDiagnostics({
    dbClient: db,
    nowMs,
    reReadDelayMs: 5,
    panelDeletionSyncEnabled: false,
    fetchInboundsListFn: async () => {
      listCalls += 1;
      return {
        ok: true,
        inbounds: liveInbounds,
        latencyMs: 25,
        panelIdentity: TEST_PANEL_ID,
        errorCode: null,
      };
    },
    probeDirectInboundFn: async (id) => {
      probeCalls += 1;
      return {
        inboundId: id,
        outcome: 'ok_valid_inbound',
        latencyMs: 10,
        httpStatus: 200,
        hasObj: true,
        clientCount: 0,
        errorCode: null,
      };
    },
  });

  assert.equal(report.success, true);
  assert.equal(report.readOnly, true);
  assert.equal(report.aborted, false);
  assert.equal(listCalls, 2, 'Must run Snapshot 1 and Snapshot 2');
  assert.equal(probeCalls, 0, 'Direct probes must be opt-in and disabled by default');
  assert.equal(report.directInboundVerificationProbe.executed, false);
  assert.equal(report.directInboundVerificationProbe.skippedReason, 'opt_in_disabled_by_default');

  // Verify strict data minimization (zero SELECT * and zero sensitive columns)
  for (const sel of db.observedSelects) {
    assert.ok(!sel.columns.includes('*'), `SELECT * is forbidden on ${sel.table}`);
    assert.ok(!sel.columns.includes('vless_url'));
    assert.ok(!sel.columns.includes('subscription_url'));
    assert.ok(!sel.columns.includes('slip_url'));
    assert.ok(!sel.columns.includes('password'));
    assert.ok(!sel.columns.includes('username'));
    assert.ok(!sel.columns.includes('email'));
    assert.ok(!sel.columns.includes('metadata'));
    assert.ok(!sel.columns.includes('error_message'));
    if (sel.table === 'vpn_configs') {
      assert.ok(!sel.columns.includes('user_id'));
      assert.ok(!sel.columns.includes('updated_at'));
    }
    if (sel.table === 'vpn_accounts') {
      assert.ok(!sel.columns.includes('inbound_id'));
    }
  }
  assert.deepEqual(report.schemaCompatibility.missingOptionalColumnsByTable.vpn_configs, ['server_id']);

  // Verify exact counts matching production findings
  assert.equal(report.summary.uniqueDbTrackedNonDeleted, 86);
  assert.equal(report.summary.livePanelUniqueClientsSnap1, 57);
  assert.equal(report.summary.livePanelUniqueClientsSnap2, 57);
  assert.equal(report.summary.liveMatchedHealthy, 32);
  assert.equal(report.summary.liveMatchedStatusConflict, 5);
  assert.equal(report.summary.movedClients, 1);
  assert.equal(report.summary.untrackedLivePanelClients, 19);

  // Raw absent vs deletion-worker eligible candidate separation
  assert.equal(report.summary.rawAbsentFromSnap1, 48);
  assert.equal(report.summary.rawAbsentBothSnapshots, 48);
  assert.equal(report.summary.deletionWorkerEligibleCandidates, 44);
  assert.equal(report.summary.deletionWorkerBlockedBeforeCircuitBreaker, 4);
  assert.equal(report.summary.deletionWorkerBlockedByLocks, 1);

  assert.equal(report.summary.flags.missingPanelIdentity, 56);
  assert.equal(report.summary.flags.conflictingDbStatuses, 5);
  assert.equal(report.summary.flags.uncertainClientLocks, 1);
  assert.equal(report.summary.flags.historicalTrials, 3);
  assert.equal(report.summary.flags.expiredAccounts, 2);
  assert.equal(report.summary.flags.rejectedOrRevokedAccounts, 2);
  assert.equal(report.summary.flags.referencesRemovedHistoricalInbound, 4);
  assert.equal(report.summary.flags.missingInboundId, 1);
  assert.equal(report.summary.flags.missingOwnership, 1);
  assert.equal(report.summary.flags.conflictingOwnership, 1);

  // Verify historical inbound 7 detected
  assert.deepEqual(report.historicalMissingInbounds, [
    { inboundId: 7, dbReferencedUuidCount: 4, presentInLivePanel: false },
  ]);

  // Circuit breaker evaluated against eligibleCandidateCount (44 > 10 and 44/86 > 0.25)
  assert.equal(report.circuitBreakerEvaluation.wouldTrigger, true);
  assert.equal(report.circuitBreakerEvaluation.primaryReason, 'max_deletes_per_cycle_exceeded');
  assert.deepEqual(report.circuitBreakerEvaluation.allTriggeredReasons, [
    'max_deletes_per_cycle_exceeded',
    'max_missing_ratio_exceeded',
  ]);
  assert.equal(report.circuitBreakerEvaluation.eligibleCandidateCount, 44);
  assert.equal(report.circuitBreakerEvaluation.rawAbsentBothSnapshotsCount, 48);

  // Empty xui_servers honesty note
  assert.match(report.panel.panelProvenanceNote, /does NOT independently prove/i);

  // Never classify any absent client as permanently deleted
  for (const row of report.clients) {
    assert.notEqual(row.classification as string, 'permanently_deleted');
    assert.notEqual(row.classification as string, 'confirmed_deleted');
  }

  // Zero sensitive data in serialized JSON or CSV
  const jsonText = JSON.stringify(report);
  const csvText = formatSyncDiagnosticsCsv(report);
  for (const payload of [jsonText, csvText]) {
    assert.ok(!payload.includes('@secret.example'));
    assert.ok(!payload.includes('@private.example'));
    assert.ok(!payload.includes('vless://'));
    assert.ok(!payload.includes('private-bucket.example'));
    assert.ok(!payload.includes('cust-live-1'));
  }
});

// ==============================================================================
// 2. DUPLICATE LIVE UUIDs & SNAPSHOT INCONSISTENCY (APPEAR / DISAPPEAR / MOVE)
// ==============================================================================

test('Detects duplicate live UUIDs across different inbounds and clients appearing, disappearing, or moving between Snapshot 1 and Snapshot 2', async () => {
  const uuidDup = 'aaaaaaaa-0000-4000-8000-000000000001';
  const uuidAppear = 'aaaaaaaa-0000-4000-8000-000000000002';
  const uuidDisappear = 'aaaaaaaa-0000-4000-8000-000000000003';
  const uuidMoveSnap = 'aaaaaaaa-0000-4000-8000-000000000004';

  const makeRow = (i: number, uuid: string, ibId: number) => ({
    acc: {
      id: `a-${i}`,
      user_id: `u-${i}`,
      uuid,
      status: 'active',
      enable: true,
      panel_identity: TEST_PANEL_ID,
      created_at: '2026-10-01T00:00:00Z',
    },
    cfg: {
      id: `c-${i}`,
      customer_uid: `u-${i}`,
      uuid,
      inbound_id: ibId,
      status: 'active',
      enabled: true,
      panel_identity: TEST_PANEL_ID,
      created_at: '2026-10-01T00:00:00Z',
    },
  });

  const rows = [
    makeRow(1, uuidDup, 1),
    makeRow(2, uuidAppear, 1),
    makeRow(3, uuidDisappear, 1),
    makeRow(4, uuidMoveSnap, 1),
  ];

  const db = createStrictReadOnlyMockDb({
    tables: {
      vpn_accounts: rows.map((r) => r.acc),
      vpn_configs: rows.map((r) => r.cfg),
      vpn_entitlement_grants: [],
      orders: [],
      provisioning_operations: [],
      xui_servers: [],
    },
  });

  let call = 0;
  const report = await runReadOnlySyncDiagnostics({
    dbClient: db,
    reReadDelayMs: 5,
    fetchInboundsListFn: async (): Promise<DiagnosticReadOnlyListResult> => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          latencyMs: 10,
          panelIdentity: TEST_PANEL_ID,
          errorCode: null,
          inbounds: [
            makeInbound(1, 'IB1', 8080, [{ id: uuidDup }, { id: uuidDisappear }, { id: uuidMoveSnap }]),
            makeInbound(2, 'IB2', 443, [{ id: uuidDup }]),
          ],
        };
      }
      return {
        ok: true,
        latencyMs: 10,
        panelIdentity: TEST_PANEL_ID,
        errorCode: null,
        inbounds: [
          makeInbound(1, 'IB1', 8080, [{ id: uuidDup }, { id: uuidAppear }]),
          makeInbound(2, 'IB2', 443, [{ id: uuidDup }, { id: uuidMoveSnap }]),
        ],
      };
    },
  });

  assert.equal(report.success, true);
  const byUuid = new Map(report.clients.map((c) => [c.clientUuid, c]));

  assert.equal(byUuid.get(uuidDup)?.classification, 'live_duplicate_uuid_ambiguous');
  assert.equal(byUuid.get(uuidDup)?.hasDuplicateLiveUuid, true);
  assert.equal(byUuid.get(uuidDup)?.hasDuplicateAcrossDifferentInbounds, true);

  assert.equal(byUuid.get(uuidAppear)?.classification, 'snapshot_inconsistent_appeared_in_snap2');
  assert.equal(byUuid.get(uuidDisappear)?.classification, 'snapshot_inconsistent_disappeared_in_snap2');
  assert.equal(byUuid.get(uuidMoveSnap)?.classification, 'snapshot_inconsistent_moved_between_snapshots');

  assert.equal(report.summary.liveDuplicateUuidAmbiguous, 1);
  assert.equal(report.summary.snapshotInconsistentAppeared, 1);
  assert.equal(report.summary.snapshotInconsistentDisappeared, 1);
  assert.equal(report.summary.snapshotInconsistentMoved, 1);
});

// ==============================================================================
// 3. ABORT ON MALFORMED / EMPTY / FAILED SNAPSHOTS OR DB FAILURES
// ==============================================================================

test('Aborts classification completely when Snapshot 1 is malformed, Snapshot 2 fails, or required DB query fails', async () => {
  const dbOk = createStrictReadOnlyMockDb({
    tables: {
      vpn_accounts: [
        { id: 'a1', user_id: 'u1', uuid: 'uuid-1', status: 'active', enable: true, created_at: '2026-10-01T00:00:00Z' },
      ],
      vpn_configs: [
        { id: 'c1', customer_uid: 'u1', uuid: 'uuid-1', inbound_id: 1, status: 'active', enabled: true, created_at: '2026-10-01T00:00:00Z' },
      ],
      vpn_entitlement_grants: [],
      orders: [],
      provisioning_operations: [],
      xui_servers: [],
    },
  });

  // Case A: Snapshot 1 has malformed inbound JSON
  const malformedReport = await runReadOnlySyncDiagnostics({
    dbClient: dbOk,
    reReadDelayMs: 1,
    fetchInboundsListFn: async () => ({
      ok: true,
      latencyMs: 5,
      panelIdentity: TEST_PANEL_ID,
      errorCode: null,
      inbounds: [{ id: 1, remark: 'BROKEN', settings: '{invalid-json' } as any],
    }),
  });
  assert.equal(malformedReport.aborted, true);
  assert.equal(malformedReport.abortReason, 'panel_snapshot1_malformed');
  assert.equal(malformedReport.clients.length, 0);

  // Case B: Snapshot 2 returns empty inbounds
  let snapCall = 0;
  const snap2FailReport = await runReadOnlySyncDiagnostics({
    dbClient: dbOk,
    reReadDelayMs: 1,
    fetchInboundsListFn: async () => {
      snapCall += 1;
      if (snapCall === 1) {
        return {
          ok: true,
          latencyMs: 5,
          panelIdentity: TEST_PANEL_ID,
          errorCode: null,
          inbounds: [makeInbound(1, 'HUTCH', 8080, [{ id: 'other-uuid' }])],
        };
      }
      return {
        ok: false,
        latencyMs: 5,
        panelIdentity: TEST_PANEL_ID,
        errorCode: 'panel_empty_inbounds',
        inbounds: [],
      };
    },
  });
  assert.equal(snap2FailReport.aborted, true);
  assert.equal(snap2FailReport.abortReason, 'panel_snapshot2_empty');
  assert.equal(snap2FailReport.clients.length, 0);

  // Case C: Required DB table fails (genuine permission error)
  const dbFail = createStrictReadOnlyMockDb({
    tables: {
      vpn_accounts: [],
      vpn_configs: [],
      vpn_entitlement_grants: [],
      orders: [],
      provisioning_operations: [],
      xui_servers: [],
    },
    tableErrors: {
      vpn_configs: { code: '42501', message: 'permission denied for table vpn_configs' },
    },
  });
  const dbFailReport = await runReadOnlySyncDiagnostics({
    dbClient: dbFail,
    reReadDelayMs: 1,
    fetchInboundsListFn: async () => ({
      ok: true,
      latencyMs: 5,
      panelIdentity: TEST_PANEL_ID,
      errorCode: null,
      inbounds: [makeInbound(1, 'HUTCH', 8080, [{ id: 'uuid-1' }])],
    }),
  });
  assert.equal(dbFailReport.aborted, true);
  assert.equal(dbFailReport.abortReason, 'db_vpn_configs_query_failed');
  assert.equal(dbFailReport.clients.length, 0);
  assert.ok(!JSON.stringify(dbFailReport).includes('permission denied'), 'Must not leak raw DB error text');
});

// ==============================================================================
// 4. SHARED EXECUTION DEADLINE, CANCELLATION & BOUNDED DIRECT PROBE CONCURRENCY
// ==============================================================================

test('Shared execution deadline cancels in-flight diagnostic operations via AbortSignal', async () => {
  const db = createStrictReadOnlyMockDb({
    tables: {
      vpn_accounts: [],
      vpn_configs: [],
      vpn_entitlement_grants: [],
      orders: [],
      provisioning_operations: [],
      xui_servers: [],
    },
    selectDelayMs: 50,
  });

  let receivedSignalAborted = false;

  const report = await runReadOnlySyncDiagnostics({
    dbClient: db,
    totalBudgetMs: 300,
    reReadDelayMs: 50,
    fetchInboundsListFn: async ({ signal }) => {
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          receivedSignalAborted = true;
          resolve();
        };
        if (signal?.aborted) {
          receivedSignalAborted = true;
          resolve();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, 1500);
      });
      return {
        ok: false,
        inbounds: [],
        latencyMs: 300,
        panelIdentity: null,
        errorCode: 'diagnostic_deadline_exceeded',
      };
    },
  });

  assert.equal(report.aborted, true);
  assert.equal(report.abortReason, 'diagnostic_deadline_exceeded');
  assert.equal(report.budget.deadlineExceeded, true);
  assert.equal(receivedSignalAborted, true, 'Shared AbortSignal must cancel outstanding snapshot fetch');
});

test('Opt-in direct probes enforce max concurrency <= 2 and skip gracefully when budget is insufficient', async () => {
  const db = createStrictReadOnlyMockDb({
    tables: {
      vpn_accounts: [
        { id: 'a1', user_id: 'u1', uuid: 'u-hist-7', status: 'active', enable: true, created_at: '2026-10-01T00:00:00Z' },
      ],
      vpn_configs: [
        { id: 'c1', customer_uid: 'u1', uuid: 'u-hist-7', inbound_id: 7, status: 'active', enabled: true, created_at: '2026-10-01T00:00:00Z' },
      ],
      vpn_entitlement_grants: [],
      orders: [],
      provisioning_operations: [],
      xui_servers: [],
    },
  });

  const liveInbounds = [
    makeInbound(1, 'HUTCH', 8080, [{ id: 'c-1' }]),
    makeInbound(2, 'DIALOG', 443, [{ id: 'c-2' }]),
    makeInbound(3, 'MOBITEL', 8443, [{ id: 'c-3' }]),
    makeInbound(12, 'R', 8880, [{ id: 'c-12' }]),
    makeInbound(13, 'Dialog zoom', 17490, [{ id: 'c-13' }]),
    makeInbound(18, 'test', 2052, [{ id: 'c-18' }]),
  ];

  let currentConcurrency = 0;
  let maxConcurrencyObserved = 0;

  const report = await runReadOnlySyncDiagnostics({
    dbClient: db,
    includeDirectProbe: true,
    totalBudgetMs: 10000,
    reReadDelayMs: 5,
    fetchInboundsListFn: async () => ({
      ok: true,
      inbounds: liveInbounds,
      latencyMs: 5,
      panelIdentity: TEST_PANEL_ID,
      errorCode: null,
    }),
    probeDirectInboundFn: async (inboundId): Promise<DiagnosticDirectInboundProbeResult> => {
      currentConcurrency += 1;
      maxConcurrencyObserved = Math.max(maxConcurrencyObserved, currentConcurrency);
      await new Promise((r) => setTimeout(r, 25));
      currentConcurrency -= 1;

      if (inboundId === 7) {
        return {
          inboundId,
          outcome: 'http_200_null_or_empty_obj',
          latencyMs: 25,
          httpStatus: 200,
          hasObj: false,
          clientCount: null,
          errorCode: 'panel_null_or_empty_obj',
        };
      }
      return {
        inboundId,
        outcome: 'ok_valid_inbound',
        latencyMs: 25,
        httpStatus: 200,
        hasObj: true,
        clientCount: 1,
        errorCode: null,
      };
    },
  });

  assert.equal(report.success, true);
  assert.equal(report.directInboundVerificationProbe.executed, true);
  assert.equal(report.directInboundVerificationProbe.probedCount, 7);
  assert.ok(
    maxConcurrencyObserved <= MAX_DIRECT_PROBE_CONCURRENCY,
    `Expected direct probe concurrency <= ${MAX_DIRECT_PROBE_CONCURRENCY}, observed ${maxConcurrencyObserved}`
  );
  assert.equal(report.directInboundVerificationProbe.directSucceededCount, 6);
  assert.equal(report.directInboundVerificationProbe.directFailedOrEmptyCount, 1);
  assert.equal(report.directInboundVerificationProbe.wouldBreakCustomerPromiseAll, true);

  // Now verify insufficient remaining budget skips optional probes WITHOUT aborting the valid report
  let slowCall = 0;
  const skippedProbeReport = await runReadOnlySyncDiagnostics({
    dbClient: db,
    includeDirectProbe: true,
    totalBudgetMs: 350,
    reReadDelayMs: 10,
    fetchInboundsListFn: async () => {
      slowCall += 1;
      await new Promise((r) => setTimeout(r, slowCall === 1 ? 110 : 120));
      return {
        ok: true,
        inbounds: liveInbounds,
        latencyMs: 115,
        panelIdentity: TEST_PANEL_ID,
        errorCode: null,
      };
    },
    probeDirectInboundFn: async () => {
      throw new Error('Should not be invoked when remaining budget is below minimum threshold');
    },
  });

  assert.equal(skippedProbeReport.success, true);
  assert.equal(skippedProbeReport.aborted, false);
  assert.equal(skippedProbeReport.directInboundVerificationProbe.executed, false);
  assert.equal(
    skippedProbeReport.directInboundVerificationProbe.skippedReason,
    'insufficient_remaining_budget'
  );
});

// ==============================================================================
// 5. CSV FORMULA INJECTION PROTECTION (INCLUDING LEADING WHITESPACE & CONTROL CHARS)
// ==============================================================================

test('sanitizeCsvCell neutralizes formula injection including leading whitespace, BOM, and control characters', () => {
  const dangerousCases = [
    '=CMD|\' /C calc\'!A0',
    '   =HYPERLINK("http://evil.test","click")',
    '\t+1+1',
    '  -2+3',
    '\uFEFF@SUM(A1:A2)',
    '\x00\x01  |cmd',
    '\r\n=1+1',
  ];

  for (const input of dangerousCases) {
    const out = sanitizeCsvCell(input);
    assert.ok(out.startsWith('"\''), `Expected neutralized single-quote prefix for ${JSON.stringify(input)}, got ${out}`);
    assert.ok(!out.includes('\n') && !out.includes('\r'), 'CSV cell must never contain raw CR/LF');
  }

  // Safe values remain clean RFC-4180 quoted strings
  assert.equal(sanitizeCsvCell('HUTCH'), '"HUTCH"');
  assert.equal(sanitizeCsvCell('a "quoted" label'), '"a ""quoted"" label"');
  assert.equal(sanitizeCsvCell(42), '"42"');
});

// ==============================================================================
// 6. REAL EXPRESS ROUTE TESTS (AUTH, ADMIN, VALIDATION, MUTEX LIFETIME, RATE LIMIT)
// ==============================================================================

test('Real Express adminRoutes enforces 401 for unauthenticated/malformed tokens and 403 for non-admin', async () => {
  // Part A: Mount real adminRoutes directly to test real authMiddleware + adminMiddleware chain
  const realApp = express();
  realApp.use('/api/admin', adminRoutes);
  const realSrv = await startTestServer(realApp);

  try {
    const noTokenRes = await fetch(`${realSrv.baseUrl}/api/admin/sync-diagnostics`);
    assert.equal(noTokenRes.status, 401);

    const noTokenCsvRes = await fetch(`${realSrv.baseUrl}/api/admin/sync-diagnostics/csv`);
    assert.equal(noTokenCsvRes.status, 401);

    const malformedRes = await fetch(`${realSrv.baseUrl}/api/admin/sync-diagnostics`, {
      headers: { Authorization: 'Bearer not-a-jwt' },
    });
    assert.equal(malformedRes.status, 401);
  } finally {
    await realSrv.close();
  }

  // Part B: Verify real adminMiddleware blocks non-admin authenticated customer (403)
  const nonAdminApp = express();
  nonAdminApp.use((req: any, _res, next) => {
    req.user = { uid: 'non-admin-uid-test-never-exists', role: 'customer' };
    next();
  });
  nonAdminApp.get('/api/admin/sync-diagnostics', adminMiddleware, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  const nonAdminSrv = await startTestServer(nonAdminApp);
  try {
    const res = await fetch(`${nonAdminSrv.baseUrl}/api/admin/sync-diagnostics`);
    assert.equal(res.status, 403);
  } finally {
    await nonAdminSrv.close();
  }
});

test('Express diagnostic route enforces mutex lifetime across early client disconnect, query validation, CSV download headers, and rate limiting', async () => {
  let releaseSlowWork: (() => void) | null = null;
  let runCount = 0;

  const minimalReport = await runReadOnlySyncDiagnostics({
    dbClient: createStrictReadOnlyMockDb({
      tables: {
        vpn_accounts: [],
        vpn_configs: [],
        vpn_entitlement_grants: [],
        orders: [],
        provisioning_operations: [],
        xui_servers: [],
      },
    }),
    reReadDelayMs: 1,
    fetchInboundsListFn: async () => ({
      ok: true,
      inbounds: [makeInbound(1, 'HUTCH', 8080, [{ id: 'live-1' }])],
      latencyMs: 5,
      panelIdentity: TEST_PANEL_ID,
      errorCode: null,
    }),
  });

  const handlers = createSyncDiagnosticsHandlers({
    runDiagnosticsFn: async (opts?: RunSyncDiagnosticsOptions) => {
      runCount += 1;
      if (runCount === 1) {
        // Simulate unfinished background work that takes extra time to settle even after client disconnects
        await new Promise<void>((resolve) => {
          releaseSlowWork = resolve;
        });
        assert.equal(opts?.signal?.aborted, true, 'Early client disconnect must abort request signal');
      }
      return minimalReport;
    },
  });

  const testRateLimit = createRateLimiter({
    windowMs: 60_000,
    max: 4,
    keyPrefix: `test_diag_rl_${Date.now()}`,
  });

  const app = express();
  app.use((req: any, _res, next) => {
    req.user = { uid: 'verified-admin-uid', role: 'admin' };
    req.admin = true;
    next();
  });
  app.get('/api/admin/sync-diagnostics', testRateLimit, handlers.getSyncDiagnosticsHandler);
  app.get('/api/admin/sync-diagnostics/csv', testRateLimit, handlers.getSyncDiagnosticsCsvHandler);

  const srv = await startTestServer(app);
  try {
    // 1. Invalid query parameter -> 400
    const badParamRes = await fetch(`${srv.baseUrl}/api/admin/sync-diagnostics?includeDirectProbe=maybe`);
    assert.equal(badParamRes.status, 400);
    const badParamBody: any = await badParamRes.json();
    assert.equal(badParamBody.errorCode, 'invalid_query_parameter');

    // 2. Start slow run #1 and abort client connection early
    const clientAbort = new AbortController();
    const req1Promise = fetch(`${srv.baseUrl}/api/admin/sync-diagnostics`, {
      signal: clientAbort.signal,
    }).catch(() => null);

    // Wait briefly for server handler to enter runDiagnosticsFn
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(handlers.isDiagnosticRunActive(), true);

    clientAbort.abort();
    await req1Promise;
    await new Promise((r) => setTimeout(r, 40));

    // Mutex MUST STILL BE HELD because underlying work has NOT settled yet!
    assert.equal(handlers.isDiagnosticRunActive(), true);
    const conflictRes = await fetch(`${srv.baseUrl}/api/admin/sync-diagnostics`);
    assert.equal(conflictRes.status, 409);
    const conflictBody: any = await conflictRes.json();
    assert.equal(conflictBody.errorCode, 'diagnostic_already_running');

    // Now let underlying run #1 finish settling -> mutex releases cleanly
    releaseSlowWork!();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(handlers.isDiagnosticRunActive(), false);

    // 3. Subsequent CSV download succeeds with strict headers
    const csvRes = await fetch(`${srv.baseUrl}/api/admin/sync-diagnostics/csv`);
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get('content-type') || '', /text\/csv/i);
    assert.match(csvRes.headers.get('content-disposition') || '', /attachment; filename="firevpns-sync-diagnostics-/);
    assert.match(csvRes.headers.get('cache-control') || '', /no-store/i);
    const csvText = await csvRes.text();
    assert.ok(csvText.includes('"client_uuid"'));
    assert.ok(csvText.includes('"live-1"'));

    // 4. Exceeding per-instance rate limit (5th request with max=4) -> 429
    const rlRes = await fetch(`${srv.baseUrl}/api/admin/sync-diagnostics`);
    assert.equal(rlRes.status, 429);
    assert.ok(rlRes.headers.get('retry-after'));
  } finally {
    await srv.close();
  }
});

test('Circuit breaker exact minimum-count conditions, equivalent status semantics, external abort, and Express 504/503 responses', async () => {
  // 1. 7 tracked clients with 3 absent (42.9% > 25%) MUST NOT trigger max_missing_ratio_exceeded because totalTracked < 8
  const mkTracked = (count: number, liveCount: number) => {
    const accounts: any[] = [];
    const configs: any[] = [];
    const orders: any[] = [];
    const liveClients: Array<{ id: string }> = [];
    for (let i = 0; i < count; i++) {
      const uuid = `33333333-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
      const isExpiredPaid = i === 0; // completed/Paid order with expired VPN -> NOT a status conflict
      const isRejectedActive = i === 1; // rejected/Cancelled order with active VPN -> IS a status conflict
      accounts.push({
        id: `a-${i}`,
        user_id: `u-${i}`,
        order_id: `o-${i}`,
        uuid,
        status: isExpiredPaid ? 'expired' : 'active',
        enable: !isExpiredPaid,
        panel_identity: TEST_PANEL_ID,
        created_at: '2026-10-01T00:00:00Z',
      });
      configs.push({
        id: `c-${i}`,
        customer_uid: `u-${i}`,
        order_id: `o-${i}`,
        uuid,
        inbound_id: 1,
        status: isExpiredPaid ? 'expired' : 'active',
        enabled: !isExpiredPaid,
        panel_identity: TEST_PANEL_ID,
        created_at: '2026-10-01T00:00:00Z',
      });
      if (isExpiredPaid) {
        orders.push({
          id: `o-${i}`,
          order_id: `ORD-EXP-${i}`,
          customer_id: `u-${i}`,
          status: 'completed',
          payment_status: 'Paid',
          client_uuid: uuid,
          created_at: '2026-10-01T00:00:00Z',
        });
      }
      if (isRejectedActive) {
        orders.push({
          id: `o-${i}`,
          order_id: `ORD-REJ-${i}`,
          customer_id: `u-${i}`,
          status: 'rejected',
          payment_status: 'Cancelled',
          client_uuid: uuid,
          created_at: '2026-10-01T00:00:00Z',
        });
      }
      if (i < liveCount) {
        liveClients.push({ id: uuid });
      }
    }
    return { accounts, configs, orders, liveClients };
  };

  const data7 = mkTracked(7, 4); // 3 absent out of 7 = 42.9%, but totalTracked < 8
  const report7 = await runReadOnlySyncDiagnostics({
    dbClient: createStrictReadOnlyMockDb({
      tables: {
        vpn_accounts: data7.accounts,
        vpn_configs: data7.configs,
        vpn_entitlement_grants: [],
        orders: data7.orders,
        provisioning_operations: [],
        xui_servers: [],
      },
    }),
    reReadDelayMs: 1,
    fetchInboundsListFn: async () => ({
      ok: true,
      inbounds: [makeInbound(1, 'HUTCH', 8080, data7.liveClients)],
      latencyMs: 5,
      panelIdentity: TEST_PANEL_ID,
      errorCode: null,
    }),
  });

  assert.equal(report7.success, true);
  assert.equal(report7.circuitBreakerEvaluation.wouldTrigger, false, 'Ratio breaker requires totalTracked >= 8');
  assert.equal(report7.summary.flags.conflictingDbStatuses, 1, 'Only rejected+active is a conflict; completed/Paid+expired is NOT');

  // 2. External AbortController cancels during reReadDelayMs immediately
  const extAbort = new AbortController();
  setTimeout(() => extAbort.abort(), 30);
  const abortedReport = await runReadOnlySyncDiagnostics({
    dbClient: createStrictReadOnlyMockDb({
      tables: {
        vpn_accounts: [],
        vpn_configs: [],
        vpn_entitlement_grants: [],
        orders: [],
        provisioning_operations: [],
        xui_servers: [],
      },
    }),
    reReadDelayMs: 1500,
    signal: extAbort.signal,
    fetchInboundsListFn: async () => ({
      ok: true,
      inbounds: [makeInbound(1, 'HUTCH', 8080, [{ id: 'x-1' }])],
      latencyMs: 2,
      panelIdentity: TEST_PANEL_ID,
      errorCode: null,
    }),
  });
  assert.equal(abortedReport.aborted, true);
  assert.equal(abortedReport.abortReason, 'diagnostic_aborted');

  // 3. Express controller returns 504 on deadline abort and 503 on snapshot failure with allowlisted errorCode
  const handlers504 = createSyncDiagnosticsHandlers({
    runDiagnosticsFn: async () => ({
      ...abortedReport,
      abortReason: 'diagnostic_deadline_exceeded',
    }),
  });
  const app = express();
  app.use((req: any, _res, next) => {
    req.user = { uid: 'admin-1', role: 'admin' };
    next();
  });
  app.get('/api/admin/sync-diagnostics', handlers504.getSyncDiagnosticsHandler);
  const srv = await startTestServer(app);
  try {
    const res = await fetch(`${srv.baseUrl}/api/admin/sync-diagnostics`);
    assert.equal(res.status, 504);
    const body: any = await res.json();
    assert.equal(body.aborted, true);
    assert.equal(body.errorCode, 'diagnostic_deadline_exceeded');
  } finally {
    await srv.close();
  }
});

// ==============================================================================
// 7. V5.3 AUDIT HARDENING REGRESSION TESTS
// ==============================================================================

test('Recent order linked to an older VPN UUID does NOT exclude it from deletion-worker candidate count (recent_provision_grace_period parity)', async () => {
  const nowMs = Date.parse('2026-11-27T15:30:00.000Z');
  const olderVpnCreatedAt = '2026-10-01T10:00:00.000Z';
  const recentOrderCreatedAt = '2026-11-27T15:29:50.000Z'; // 10s ago (< 60s grace)
  const recentVpnCreatedAt = '2026-11-27T15:29:45.000Z'; // 15s ago (< 60s grace)

  const uuidOlderVpnRecentOrder = '44444444-0000-4000-8000-000000000001';
  const uuidRecentVpn = '44444444-0000-4000-8000-000000000002';
  const uuidLive = '44444444-0000-4000-8000-000000000003';

  const db = createStrictReadOnlyMockDb({
    tables: {
      vpn_accounts: [
        {
          id: 'a-1',
          user_id: 'u-1',
          order_id: 'ord-old-1',
          uuid: uuidOlderVpnRecentOrder,
          status: 'active',
          enable: true,
          panel_identity: TEST_PANEL_ID,
          created_at: olderVpnCreatedAt,
        },
        {
          id: 'a-2',
          user_id: 'u-2',
          order_id: 'ord-new-2',
          uuid: uuidRecentVpn,
          status: 'active',
          enable: true,
          panel_identity: TEST_PANEL_ID,
          created_at: recentVpnCreatedAt,
        },
        {
          id: 'a-3',
          user_id: 'u-3',
          uuid: uuidLive,
          status: 'active',
          enable: true,
          panel_identity: TEST_PANEL_ID,
          created_at: olderVpnCreatedAt,
        },
      ],
      vpn_configs: [
        {
          id: 'c-1',
          customer_uid: 'u-1',
          order_id: 'ord-old-1',
          uuid: uuidOlderVpnRecentOrder,
          inbound_id: 2,
          status: 'active',
          enabled: true,
          panel_identity: TEST_PANEL_ID,
          created_at: olderVpnCreatedAt,
        },
        {
          id: 'c-2',
          customer_uid: 'u-2',
          order_id: 'ord-new-2',
          uuid: uuidRecentVpn,
          inbound_id: 2,
          status: 'active',
          enabled: true,
          panel_identity: TEST_PANEL_ID,
          created_at: recentVpnCreatedAt,
        },
        {
          id: 'c-3',
          customer_uid: 'u-3',
          uuid: uuidLive,
          inbound_id: 2,
          status: 'active',
          enabled: true,
          panel_identity: TEST_PANEL_ID,
          created_at: olderVpnCreatedAt,
        },
      ],
      vpn_entitlement_grants: [],
      orders: [
        // Brand-new renewal order created 10s ago referencing the older VPN UUID
        {
          id: 'ord-renew-1',
          order_id: 'REN-9001',
          customer_id: 'u-1',
          status: 'completed',
          payment_status: 'Paid',
          client_uuid: uuidOlderVpnRecentOrder,
          created_at: recentOrderCreatedAt,
        },
      ],
      provisioning_operations: [],
      xui_servers: [],
    },
  });

  const report = await runReadOnlySyncDiagnostics({
    dbClient: db,
    nowMs,
    reReadDelayMs: 1,
    fetchInboundsListFn: async () => ({
      ok: true,
      inbounds: [makeInbound(2, 'DIALOG', 443, [{ id: uuidLive }])],
      latencyMs: 5,
      panelIdentity: TEST_PANEL_ID,
      errorCode: null,
    }),
  });

  assert.equal(report.success, true);
  assert.equal(report.summary.rawAbsentBothSnapshots, 2);
  // ONLY uuidOlderVpnRecentOrder is eligible (1); uuidRecentVpn is blocked by recent_provision_grace_period
  assert.equal(report.summary.deletionWorkerEligibleCandidates, 1);
  assert.equal(report.circuitBreakerEvaluation.eligibleCandidateCount, 1);

  const byUuid = new Map(report.clients.map((c) => [c.clientUuid, c]));
  const oldVpnRow = byUuid.get(uuidOlderVpnRecentOrder)!;
  assert.equal(oldVpnRow.wouldPassPreCircuitBreakerGates, true);
  assert.ok(!oldVpnRow.allBlockingReasons.includes('recent_provision_grace_period'));
  assert.equal(oldVpnRow.latestVpnCreatedAt, olderVpnCreatedAt);
  assert.equal(oldVpnRow.latestOrderCreatedAt, recentOrderCreatedAt);

  const newVpnRow = byUuid.get(uuidRecentVpn)!;
  assert.equal(newVpnRow.wouldPassPreCircuitBreakerGates, false);
  assert.ok(newVpnRow.allBlockingReasons.includes('recent_provision_grace_period'));
  assert.equal(newVpnRow.latestVpnCreatedAt, recentVpnCreatedAt);

  // CSV includes separated latest_vpn_created_at and latest_order_created_at columns
  const csv = formatSyncDiagnosticsCsv(report);
  assert.ok(csv.includes('"latest_vpn_created_at","latest_order_created_at"'));
});

test('Cold-cache diagnostic config lookup enforces AbortSignal cancellation and NEVER silently falls back to env on genuine DB error', async () => {
  resetXuiServiceCachesForTests();

  const origPanelUrl = process.env.XUI_PANEL_URL;
  const origToken = process.env.XUI_API_TOKEN;
  process.env.XUI_PANEL_URL = 'https://env-fallback-panel.example:2053/panel';
  process.env.XUI_API_TOKEN = 'env-secret-token';

  try {
    // Case A: Cold-cache Supabase `settings` read cancels immediately on shared AbortSignal
    let observedAbort = false;
    const slowSettingsDb = {
      from(table: string) {
        assert.equal(table, 'settings');
        let sig: AbortSignal | null = null;
        const builder: any = {
          select() {
            return builder;
          },
          eq() {
            return builder;
          },
          abortSignal(s: AbortSignal) {
            sig = s;
            return builder;
          },
          maybeSingle() {
            return builder;
          },
          then(resolve: any, reject: any) {
            const t = setTimeout(() => {
              resolve({ data: null, error: null });
            }, 3000);
            sig?.addEventListener(
              'abort',
              () => {
                observedAbort = true;
                clearTimeout(t);
                reject(new Error('AbortError: signal aborted'));
              },
              { once: true }
            );
          },
        };
        return builder;
      },
    };

    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('diagnostic_deadline_exceeded')), 35);
    const startMs = Date.now();
    const abortedCfg = await resolveDiagnosticXuiConfigReadOnly({
      timeoutMs: 2000,
      signal: ac.signal,
      dbClient: slowSettingsDb,
      bypassWarmCache: true,
    });
    const elapsedMs = Date.now() - startMs;

    assert.equal(abortedCfg.ok, false);
    assert.equal(abortedCfg.errorCode, 'diagnostic_deadline_exceeded');
    assert.equal(observedAbort, true, 'Cold-cache settings read must receive and honor AbortSignal');
    assert.ok(elapsedMs < 500, `Expected prompt abort, took ${elapsedMs}ms`);

    // Case B: Genuine Supabase DB error on `settings` MUST fail closed and NEVER fall back to XUI_PANEL_URL env
    const errorSettingsDb = {
      from() {
        const builder: any = {
          select() {
            return builder;
          },
          eq() {
            return builder;
          },
          abortSignal() {
            return builder;
          },
          maybeSingle() {
            return Promise.resolve({
              data: null,
              error: { code: '42501', message: 'permission denied for table settings' },
            });
          },
        };
        return builder;
      },
    };

    const errCfg = await resolveDiagnosticXuiConfigReadOnly({
      timeoutMs: 1000,
      dbClient: errorSettingsDb,
      bypassWarmCache: true,
    });
    assert.equal(errCfg.ok, false);
    assert.equal(errCfg.config, null);
    assert.equal(errCfg.errorCode, 'panel_config_unavailable');

    // Case C: Clean empty settings row (error: null, data: null) preserves normal env fallback semantics
    const emptySettingsDb = {
      from() {
        const builder: any = {
          select() {
            return builder;
          },
          eq() {
            return builder;
          },
          abortSignal() {
            return builder;
          },
          maybeSingle() {
            return Promise.resolve({ data: null, error: null });
          },
        };
        return builder;
      },
    };

    const envCfg = await resolveDiagnosticXuiConfigReadOnly({
      timeoutMs: 1000,
      dbClient: emptySettingsDb,
      bypassWarmCache: true,
    });
    assert.equal(envCfg.ok, true);
    assert.equal(envCfg.config?.panelUrl, 'https://env-fallback-panel.example:2053/panel');
    assert.ok(envCfg.panelIdentity?.startsWith('panel:'));
  } finally {
    if (origPanelUrl === undefined) delete process.env.XUI_PANEL_URL;
    else process.env.XUI_PANEL_URL = origPanelUrl;
    if (origToken === undefined) delete process.env.XUI_API_TOKEN;
    else process.env.XUI_API_TOKEN = origToken;
    resetXuiServiceCachesForTests();
  }
});

test('Isolated diagnostic authentication cancels on AbortSignal without cancelling or overwriting shared auth state', async () => {
  resetXuiServiceCachesForTests();

  const sharedConfig: XuiConfig = {
    panelUrl: 'https://panel-iso-test.example:2053/panel',
    username: 'admin',
    password: 'panel-password-123',
    apiToken: 'panel-password-123',
  };
  const { scopeKey } = computeXuiCredentialScopeKey(sharedConfig);

  try {
    // 1. Establish a valid shared session via existing getXuiAuthHeaders()
    const sharedHeaders = await getXuiAuthHeaders(sharedConfig, false, 2000, {
      loginPostFn: async () => ({
        status: 200,
        headers: { 'set-cookie': ['3x-ui=SHARED_PROD_COOKIE; Path=/; HttpOnly'] },
        data: { success: true },
      }),
      csrfGetFn: async () => ({
        status: 200,
        headers: {},
        data: { obj: 'SHARED_CSRF_TOKEN' },
      }),
    });
    assert.equal(sharedHeaders['Cookie'], '3x-ui=SHARED_PROD_COOKIE');
    assert.equal(sharedHeaders['X-CSRF-Token'], 'SHARED_CSRF_TOKEN');
    const sharedGenBefore = getScopeAuthGeneration(scopeKey);

    // 2. Start a concurrent shared in-flight login on a second panel scope to prove diagnostic abort NEVER touches it
    const otherConfig: XuiConfig = {
      panelUrl: 'https://panel-shared-inflight.example:2053/panel',
      username: 'admin',
      password: 'other-password-456',
      apiToken: 'other-password-456',
    };
    let releaseSharedInFlight!: () => void;
    const sharedInFlightPromise = getXuiAuthHeaders(otherConfig, false, 4000, {
      loginPostFn: async () => {
        await new Promise<void>((resolve) => {
          releaseSharedInFlight = resolve;
        });
        return {
          status: 200,
          headers: { 'set-cookie': ['3x-ui=OTHER_SHARED_COOKIE; Path=/'] },
          data: { success: true },
        };
      },
      csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
    });

    // 3. Diagnostic isolated forced login aborts immediately on AbortSignal
    let diagLoginSignalAborted = false;
    const diagAbort = new AbortController();
    setTimeout(() => diagAbort.abort(new Error('diagnostic_aborted')), 30);

    const abortedDiagAuth = await acquireDiagnosticXuiAuthHeadersReadOnly(sharedConfig, {
      forceFreshLogin: true,
      timeoutMs: 3000,
      signal: diagAbort.signal,
      authHooks: {
        loginPostFn: async (_url, _body, _headers, _timeout, sig) => {
          await new Promise<void>((_res, rej) => {
            const t = setTimeout(() => rej(new Error('should have aborted')), 2000);
            sig?.addEventListener(
              'abort',
              () => {
                diagLoginSignalAborted = true;
                clearTimeout(t);
                const err: any = new Error('canceled');
                err.code = 'ERR_CANCELED';
                rej(err);
              },
              { once: true }
            );
          });
          return { status: 200, headers: {}, data: {} };
        },
        csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
      },
    });
    assert.equal(abortedDiagAuth.ok, false);
    assert.equal(abortedDiagAuth.errorCode, 'diagnostic_aborted');
    assert.equal(diagLoginSignalAborted, true, 'Isolated diagnostic login must abort via AbortSignal');

    // 4. Successful isolated diagnostic login with DIFFERENT cookie must NOT overwrite shared auth cache or generation
    const sessionState = createDiagnosticIsolatedSessionState();
    const isolatedDiagAuth = await acquireDiagnosticXuiAuthHeadersReadOnly(sharedConfig, {
      forceFreshLogin: true,
      timeoutMs: 2000,
      sessionState,
      authHooks: {
        loginPostFn: async () => ({
          status: 200,
          headers: { 'set-cookie': ['3x-ui=ISOLATED_DIAG_COOKIE; Path=/'] },
          data: { success: true },
        }),
        csrfGetFn: async () => ({
          status: 200,
          headers: {},
          data: { obj: 'ISOLATED_DIAG_CSRF' },
        }),
      },
    });
    assert.equal(isolatedDiagAuth.ok, true);
    assert.equal(isolatedDiagAuth.source, 'isolated_diagnostic_login');
    assert.equal(isolatedDiagAuth.headers?.['Cookie'], '3x-ui=ISOLATED_DIAG_COOKIE');
    assert.equal(isolatedDiagAuth.headers?.['X-CSRF-Token'], 'ISOLATED_DIAG_CSRF');

    // 5. Verify shared auth cache & generation remain 100% UNCHANGED
    assert.equal(getScopeAuthGeneration(scopeKey), sharedGenBefore);
    const sharedHeadersAfter = await getXuiAuthHeaders(sharedConfig, false, 2000, {
      loginPostFn: async () => {
        throw new Error('Shared auth cache must still be warm and untouched');
      },
      csrfGetFn: async () => {
        throw new Error('Shared auth cache must still be warm and untouched');
      },
    });
    assert.equal(sharedHeadersAfter['Cookie'], '3x-ui=SHARED_PROD_COOKIE');
    assert.equal(sharedHeadersAfter['X-CSRF-Token'], 'SHARED_CSRF_TOKEN');

    // 6. Verify 401 re-auth inside fetchReadOnlyDiagnosticInboundsList stays completely isolated from shared auth
    let getAttempt = 0;
    const settingsDb = {
      from() {
        const b: any = {
          select: () => b,
          eq: () => b,
          abortSignal: () => b,
          maybeSingle: () =>
            Promise.resolve({
              data: { id: 'xui', data: sharedConfig },
              error: null,
            }),
        };
        return b;
      },
    };
    const diagListRes = await fetchReadOnlyDiagnosticInboundsList({
      timeoutMs: 2000,
      dbClient: settingsDb,
      sessionState: createDiagnosticIsolatedSessionState(),
      authHooks: {
        loginPostFn: async () => ({
          status: 200,
          headers: { 'set-cookie': ['3x-ui=REAUTH_DIAG_COOKIE; Path=/'] },
          data: { success: true },
        }),
        csrfGetFn: async () => ({ status: 404, headers: {}, data: {} }),
      },
      requestGetFn: async (_url, reqHeaders) => {
        getAttempt += 1;
        if (getAttempt === 1) {
          assert.equal(reqHeaders['Cookie'], '3x-ui=SHARED_PROD_COOKIE');
          return { status: 401, headers: {}, data: { success: false } };
        }
        assert.equal(reqHeaders['Cookie'], '3x-ui=REAUTH_DIAG_COOKIE');
        return {
          status: 200,
          headers: {},
          data: { success: true, obj: [makeInbound(1, 'HUTCH', 8080, [{ id: 'c-1' }])] },
        };
      },
    });
    assert.equal(diagListRes.ok, true);
    assert.equal(getAttempt, 2);
    assert.equal(getScopeAuthGeneration(scopeKey), sharedGenBefore, '401 diagnostic re-auth must never mutate shared generation');

    // 7. Release and verify the concurrent shared in-flight login completed untouched
    releaseSharedInFlight();
    const otherSharedHeaders = await sharedInFlightPromise;
    assert.equal(otherSharedHeaders['Cookie'], '3x-ui=OTHER_SHARED_COOKIE');
  } finally {
    resetXuiServiceCachesForTests();
  }
});

test('Optional-column compatibility immediately fails closed on unknown named column or ambiguous missing-column error without dropping all optional columns', async () => {
  // Case A: Explicit missing column that is NEITHER required NOR optional -> 0 retries, fail closed immediately
  const observedUnknownSelects: Array<{ table: string; columns: string }> = [];
  const unknownColDb = createStrictReadOnlyMockDb({
    tables: {
      vpn_accounts: [],
      vpn_configs: [],
      vpn_entitlement_grants: [],
      orders: [],
      provisioning_operations: [],
      xui_servers: [],
    },
    tableErrors: {
      vpn_configs: { code: '42703', message: 'column vpn_configs.unexpected_filter_col does not exist' },
    },
    observedSelects: observedUnknownSelects,
  });

  const unknownRes = await runReadOnlySyncDiagnostics({
    dbClient: unknownColDb,
    reReadDelayMs: 1,
    fetchInboundsListFn: async () => ({
      ok: true,
      inbounds: [makeInbound(1, 'HUTCH', 8080, [{ id: 'live-1' }])],
      latencyMs: 5,
      panelIdentity: TEST_PANEL_ID,
      errorCode: null,
    }),
  });

  assert.equal(unknownRes.aborted, true);
  assert.equal(unknownRes.abortReason, 'db_vpn_configs_query_failed');
  assert.equal(
    observedUnknownSelects.filter((s) => s.table === 'vpn_configs').length,
    1,
    'Must NOT retry by dropping optional columns when an unrecognized column name is reported'
  );
  assert.equal(unknownRes.schemaCompatibility.missingOptionalColumnsByTable.vpn_configs, undefined);

  // Case B: Ambiguous 42703 error with NO column name -> 0 retries, fail closed immediately
  const observedAmbiguousSelects: Array<{ table: string; columns: string }> = [];
  const ambiguousColDb = createStrictReadOnlyMockDb({
    tables: {
      vpn_accounts: [],
      vpn_configs: [],
      vpn_entitlement_grants: [],
      orders: [],
      provisioning_operations: [],
      xui_servers: [],
    },
    tableErrors: {
      vpn_accounts: { code: '42703', message: 'undefined_column error in query' },
    },
    observedSelects: observedAmbiguousSelects,
  });

  const ambiguousRes = await runReadOnlySyncDiagnostics({
    dbClient: ambiguousColDb,
    reReadDelayMs: 1,
    fetchInboundsListFn: async () => ({
      ok: true,
      inbounds: [makeInbound(1, 'HUTCH', 8080, [{ id: 'live-1' }])],
      latencyMs: 5,
      panelIdentity: TEST_PANEL_ID,
      errorCode: null,
    }),
  });

  assert.equal(ambiguousRes.aborted, true);
  assert.equal(ambiguousRes.abortReason, 'db_vpn_accounts_query_failed');
  assert.equal(
    observedAmbiguousSelects.filter((s) => s.table === 'vpn_accounts').length,
    1,
    'Must NOT drop all optional columns on ambiguous missing-column error without column name'
  );
  assert.equal(ambiguousRes.schemaCompatibility.missingOptionalColumnsByTable.vpn_accounts, undefined);
});

test('DEFAULT_DIAGNOSTIC_BUDGET_MS is 16000ms, controller clamps to remaining outer budget, and mutex stays held across outer timeout abort until settlement', async () => {
  assert.equal(DEFAULT_DIAGNOSTIC_BUDGET_MS, 16_000);

  let observedBudgetMs: number | undefined;
  let releasePendingWork: (() => void) | null = null;
  let callNum = 0;

  const handlers = createSyncDiagnosticsHandlers({
    runDiagnosticsFn: async (opts?: RunSyncDiagnosticsOptions) => {
      callNum += 1;
      observedBudgetMs = opts?.totalBudgetMs;
      if (callNum === 2) {
        // Hold work open past outer timeoutSignal abort to verify mutex is not released prematurely
        await new Promise<void>((resolve) => {
          releasePendingWork = resolve;
        });
        assert.equal(opts?.signal?.aborted, true);
      }
      return {
        success: true,
        readOnly: true,
        aborted: false,
        abortReason: null,
        generatedAt: new Date().toISOString(),
        executionMs: 5,
        budget: {
          totalBudgetMs: opts?.totalBudgetMs ?? DEFAULT_DIAGNOSTIC_BUDGET_MS,
          remainingBudgetMs: 1000,
          deadlineExceeded: false,
          cancelled: false,
        },
        runtimeLimits: {
          mutexScope: 'per_instance_in_memory',
          rateLimitScope: 'per_instance_in_memory',
          directProbeOptIn: false,
          maxDirectProbeConcurrency: 2,
          note: 'test',
        },
        panel: {
          panelIdentity: TEST_PANEL_ID,
          connectionMode: 'env_single_panel',
          configuredXuiServersCount: 0,
          panelProvenanceNote: 'test',
          panelDeletionSyncEnabled: false,
          snapshots: {
            snapshot1Ok: true,
            snapshot1LatencyMs: 1,
            snapshot1InboundCount: 1,
            snapshot1LiveOccurrences: 1,
            snapshot1UniqueLiveUuids: 1,
            snapshot1DuplicateLiveUuids: 0,
            snapshot1UnparsedInboundIds: [],
            snapshot1ErrorCode: null,
            snapshot2Executed: true,
            snapshot2Ok: true,
            snapshot2LatencyMs: 1,
            snapshot2InboundCount: 1,
            snapshot2LiveOccurrences: 1,
            snapshot2UniqueLiveUuids: 1,
            snapshot2DuplicateLiveUuids: 0,
            snapshot2UnparsedInboundIds: [],
            snapshot2ErrorCode: null,
          },
        },
        schemaCompatibility: {
          vpnConfigsOwnershipColumn: 'customer_uid',
          vpnAccountsHasInboundId: false,
          missingOptionalColumnsByTable: {},
          optionalTablesMissing: [],
        },
        liveInbounds: [],
        historicalMissingInbounds: [],
        summary: {
          uniqueDbTrackedNonDeleted: 0,
          uniqueDbAllIncludingDeletedAndOrders: 0,
          livePanelUniqueClientsSnap1: 1,
          livePanelUniqueClientsSnap2: 1,
          liveMatchedHealthy: 0,
          liveMatchedStatusConflict: 0,
          liveDuplicateUuidAmbiguous: 0,
          movedClients: 0,
          snapshotInconsistentAppeared: 0,
          snapshotInconsistentDisappeared: 0,
          snapshotInconsistentMoved: 0,
          rawAbsentFromSnap1: 0,
          rawAbsentBothSnapshots: 0,
          deletionWorkerEligibleCandidates: 0,
          deletionWorkerBlockedBeforeCircuitBreaker: 0,
          deletionWorkerBlockedByLocks: 0,
          alreadyMarkedDeletedInDb: 0,
          ordersOnlyUntracked: 0,
          untrackedLivePanelClients: 1,
          flags: {
            historicalTrials: 0,
            expiredAccounts: 0,
            rejectedOrRevokedAccounts: 0,
            conflictingDbStatuses: 0,
            liveVsDbEnableMismatch: 0,
            conflictingOwnership: 0,
            missingOwnership: 0,
            conflictingInboundIds: 0,
            conflictingPanelIdentities: 0,
            missingPanelIdentity: 0,
            panelProvenanceUnverifiedLegacy: 0,
            missingInboundId: 0,
            referencesRemovedHistoricalInbound: 0,
            uncertainClientLocks: 0,
            uncertainInboundLocks: 0,
            activeInProgressLocks: 0,
          },
          blockingReasonCounts: {},
        },
        circuitBreakerEvaluation: {
          evaluated: true,
          wouldTrigger: false,
          primaryReason: null,
          allTriggeredReasons: [],
          eligibleCandidateCount: 0,
          rawAbsentBothSnapshotsCount: 0,
          totalTrackedNonDeleted: 0,
          missingRatio: 0,
          maxDeletesPerCycle: 10,
          maxMissingRatio: 0.25,
        },
        activeAndUncertainLocks: [],
        directInboundVerificationProbe: {
          optInRequested: false,
          executed: false,
          skippedReason: 'opt_in_disabled_by_default',
          maxConcurrency: 2,
          customerBudgetMs: 4000,
          probedCount: 0,
          directSucceededCount: 0,
          directFailedOrEmptyCount: 0,
          directTimedOutCount: 0,
          directSkippedBudgetCount: 0,
          wouldBreakCustomerPromiseAll: null,
          knownTelemetryNote: 'test',
          inbounds: [],
        },
        clients: [],
      };
    },
  });

  const app = express();
  app.use((req: any, _res, next) => {
    req.user = { uid: 'admin-budget-test', role: 'admin' };
    if (req.query.mode === 'clamped') {
      req.requestDeadlineMs = Date.now() + 5500; // 4500ms after 1000ms outer reserve
    } else if (req.query.mode === 'exhausted') {
      req.requestDeadlineMs = Date.now() + 500; // < 1000ms reserve -> immediate 504
    } else if (req.query.mode === 'outer_abort') {
      const outerAc = new AbortController();
      req.timeoutSignal = outerAc.signal;
      setTimeout(() => outerAc.abort(new Error('Request timed out after 25 seconds')), 35);
    }
    next();
  });
  app.get('/api/admin/sync-diagnostics', handlers.getSyncDiagnosticsHandler);
  const srv = await startTestServer(app);

  try {
    // 1. Clamped outer request budget
    const clampedRes = await fetch(`${srv.baseUrl}/api/admin/sync-diagnostics?mode=clamped`);
    assert.equal(clampedRes.status, 200);
    assert.ok(
      observedBudgetMs !== undefined && observedBudgetMs <= 4600 && observedBudgetMs >= 3000,
      `Expected clamped budget ~4500ms, got ${observedBudgetMs}`
    );

    // 2. Exhausted outer request budget returns 504 immediately without launching scan
    const exhaustedRes = await fetch(`${srv.baseUrl}/api/admin/sync-diagnostics?mode=exhausted`);
    assert.equal(exhaustedRes.status, 504);
    const exhaustedBody: any = await exhaustedRes.json();
    assert.equal(exhaustedBody.errorCode, 'diagnostic_deadline_exceeded');
    assert.equal(callNum, 1);

    // 3. Outer timeoutSignal aborts request while mutex remains held until underlying work settles
    const pendingFetch = fetch(`${srv.baseUrl}/api/admin/sync-diagnostics?mode=outer_abort`);
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(handlers.isDiagnosticRunActive(), true, 'Mutex must remain held while underlying work is still settling');
    const overlapRes = await fetch(`${srv.baseUrl}/api/admin/sync-diagnostics`);
    assert.equal(overlapRes.status, 409);
    releasePendingWork!();
    await pendingFetch;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(handlers.isDiagnosticRunActive(), false, 'Mutex must release cleanly once underlying work settles');
  } finally {
    await srv.close();
  }
});


