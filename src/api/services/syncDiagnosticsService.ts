import crypto from 'crypto';
import { supabaseAdmin } from '../../lib/supabase.js';
import {
  computePanelIdentity,
  createDiagnosticIsolatedSessionState,
  fetchReadOnlyDiagnosticInboundsList,
  isPanelDeletionSyncFlagEnabled,
  getPanelDeletionSyncMaxDeletesPerCycle,
  getPanelDeletionSyncMaxMissingRatio,
  parseInboundSettingsClientsStrict,
  probeDirectLiveInboundReadOnly,
  verifyRecordPanelIdentity,
  type DiagnosticDirectInboundOutcome,
  type DiagnosticDirectInboundProbeResult,
  type DiagnosticIsolatedSessionState,
  type DiagnosticPanelErrorCode,
  type DiagnosticReadOnlyListResult,
  type XuiInbound,
} from './xuiService.js';

// ==============================================================================
// TYPES & CONSTANTS (STRICTLY READ-ONLY DIAGNOSTIC ENGINE)
// ==============================================================================

export const DEFAULT_DIAGNOSTIC_BUDGET_MS = 16_000;
export const MAX_DIAGNOSTIC_BUDGET_MS = 19_000;
export const DEFAULT_REREAD_DELAY_MS = 150;
export const MAX_DIRECT_PROBE_CONCURRENCY = 2;
export const MAX_DIRECT_PROBE_INBOUNDS = 12;
export const CUSTOMER_LIVE_INBOUND_BUDGET_MS = 4_000;
const RECENT_PROVISION_GRACE_MS = 60 * 1000;

export type DiagnosticAbortReason =
  | 'diagnostic_deadline_exceeded'
  | 'diagnostic_aborted'
  | 'db_client_unavailable'
  | 'db_vpn_accounts_query_failed'
  | 'db_vpn_configs_query_failed'
  | 'db_grants_query_failed'
  | 'db_orders_query_failed'
  | 'db_locks_query_failed'
  | 'db_xui_servers_query_failed'
  | 'panel_config_unavailable'
  | 'panel_auth_failed'
  | 'panel_snapshot1_failed'
  | 'panel_snapshot1_empty'
  | 'panel_snapshot1_malformed'
  | 'panel_snapshot2_failed'
  | 'panel_snapshot2_empty'
  | 'panel_snapshot2_malformed';

/**
 * Intentionally NEVER includes "permanently_deleted" or "confirmed_deleted".
 * Absent UUIDs are strictly labeled as unconfirmed candidates requiring audited review.
 */
export type DiagnosticClientClassification =
  | 'live_matched'
  | 'live_matched_status_conflict'
  | 'live_duplicate_uuid_ambiguous'
  | 'moved_client'
  | 'snapshot_inconsistent_appeared_in_snap2'
  | 'snapshot_inconsistent_disappeared_in_snap2'
  | 'snapshot_inconsistent_moved_between_snapshots'
  | 'absent_two_snapshots_unconfirmed'
  | 'already_marked_deleted_in_db'
  | 'orders_only_untracked'
  | 'untracked_live_panel_client';

export type DiagnosticLockStatus =
  | 'none'
  | 'uncertain_client_lock'
  | 'uncertain_inbound_lock'
  | 'in_progress_client_lock'
  | 'in_progress_inbound_lock';

export type DiagnosticCircuitBreakerReason =
  | 'unexpected_zero_live_clients'
  | 'max_deletes_per_cycle_exceeded'
  | 'max_missing_ratio_exceeded';

export interface DiagnosticLiveInboundSummary {
  inboundId: number;
  remark: string;
  port: number | null;
  liveClientCount: number;
  uniqueLiveUuidCount: number;
  dbReferencedUuidCount: number;
}

export interface DiagnosticHistoricalInboundSummary {
  inboundId: number;
  dbReferencedUuidCount: number;
  presentInLivePanel: false;
}

export interface DiagnosticUncertainLockSummary {
  operationKey: string;
  scope: 'client' | 'inbound' | 'other';
  status: 'uncertain' | 'in_progress';
  operationType: string;
  clientUuid: string | null;
  inboundId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  uncertainAt: string | null;
  leaseExpiresAt: string | null;
  blocksTrackedUuidsCount: number;
}

export interface DiagnosticDirectProbeEntry {
  inboundId: number;
  presentInFullList: boolean;
  fullListClientCount: number | null;
  directGetOutcome: DiagnosticDirectInboundOutcome | 'skipped_budget';
  directGetLatencyMs: number | null;
  httpStatus: number | null;
  directGetHasObj: boolean;
  directGetClientCount: number | null;
  matchesFullListClientCount: boolean | null;
  errorCode: DiagnosticPanelErrorCode | null;
}

export interface DiagnosticClientRow {
  clientUuid: string;
  classification: DiagnosticClientClassification;
  presentInSnap1: boolean;
  presentInSnap2: boolean | null;
  liveInboundIdsSnap1: number[];
  liveInboundIdsSnap2: number[];
  liveInboundRemark: string | null;
  liveClientEnabled: boolean | null;
  hasDuplicateLiveUuid: boolean;
  hasDuplicateAcrossDifferentInbounds: boolean;
  dbInboundIds: number[];
  referencesRemovedHistoricalInbound: boolean;
  vpnAccountStatuses: string[];
  vpnConfigStatuses: string[];
  orderStatuses: string[];
  hasConflictingDbStatuses: boolean;
  statusConflictReasons: string[];
  liveVsDbEnableMismatch: boolean;
  isHistoricalTrial: boolean;
  isExpiredAccount: boolean;
  isRejectedOrRevoked: boolean;
  ownerRef: string;
  distinctOwnerCount: number;
  hasConflictingOwnership: boolean;
  hasMissingOwnership: boolean;
  hasConflictingInboundIds: boolean;
  hasConflictingPanelIdentities: boolean;
  missingPanelIdentity: boolean;
  panelProvenanceUnverifiedLegacy: boolean;
  missingInboundId: boolean;
  panelIdentityCheckCode: string;
  lockStatus: DiagnosticLockStatus;
  blockingLockKeys: string[];
  wouldPassPreCircuitBreakerGates: boolean;
  primaryBlockReason: string;
  allBlockingReasons: string[];
  dbTablesPresent: string[];
  latestVpnCreatedAt: string | null;
  latestOrderCreatedAt: string | null;
  latestCreatedAt: string | null;
}

export interface SyncDiagnosticsReport {
  success: boolean;
  readOnly: true;
  aborted: boolean;
  abortReason: DiagnosticAbortReason | null;
  generatedAt: string;
  executionMs: number;
  budget: {
    totalBudgetMs: number;
    remainingBudgetMs: number;
    deadlineExceeded: boolean;
    cancelled: boolean;
  };
  runtimeLimits: {
    mutexScope: 'per_instance_in_memory';
    rateLimitScope: 'per_instance_in_memory';
    directProbeOptIn: boolean;
    maxDirectProbeConcurrency: number;
    note: string;
  };
  panel: {
    panelIdentity: string | null;
    connectionMode: 'env_single_panel' | 'configured_servers_present' | 'unknown';
    configuredXuiServersCount: number;
    panelProvenanceNote: string;
    panelDeletionSyncEnabled: boolean;
    snapshots: {
      snapshot1Ok: boolean;
      snapshot1LatencyMs: number | null;
      snapshot1InboundCount: number;
      snapshot1LiveOccurrences: number;
      snapshot1UniqueLiveUuids: number;
      snapshot1DuplicateLiveUuids: number;
      snapshot1UnparsedInboundIds: number[];
      snapshot1ErrorCode: DiagnosticPanelErrorCode | null;
      snapshot2Executed: boolean;
      snapshot2Ok: boolean;
      snapshot2LatencyMs: number | null;
      snapshot2InboundCount: number;
      snapshot2LiveOccurrences: number;
      snapshot2UniqueLiveUuids: number;
      snapshot2DuplicateLiveUuids: number;
      snapshot2UnparsedInboundIds: number[];
      snapshot2ErrorCode: DiagnosticPanelErrorCode | null;
    };
  };
  schemaCompatibility: {
    vpnConfigsOwnershipColumn: 'customer_uid';
    vpnAccountsHasInboundId: false;
    missingOptionalColumnsByTable: Record<string, string[]>;
    optionalTablesMissing: string[];
  };
  liveInbounds: DiagnosticLiveInboundSummary[];
  historicalMissingInbounds: DiagnosticHistoricalInboundSummary[];
  summary: {
    uniqueDbTrackedNonDeleted: number;
    uniqueDbAllIncludingDeletedAndOrders: number;
    livePanelUniqueClientsSnap1: number;
    livePanelUniqueClientsSnap2: number | null;
    liveMatchedHealthy: number;
    liveMatchedStatusConflict: number;
    liveDuplicateUuidAmbiguous: number;
    movedClients: number;
    snapshotInconsistentAppeared: number;
    snapshotInconsistentDisappeared: number;
    snapshotInconsistentMoved: number;
    rawAbsentFromSnap1: number;
    rawAbsentBothSnapshots: number;
    deletionWorkerEligibleCandidates: number;
    deletionWorkerBlockedBeforeCircuitBreaker: number;
    deletionWorkerBlockedByLocks: number;
    alreadyMarkedDeletedInDb: number;
    ordersOnlyUntracked: number;
    untrackedLivePanelClients: number;
    flags: {
      historicalTrials: number;
      expiredAccounts: number;
      rejectedOrRevokedAccounts: number;
      conflictingDbStatuses: number;
      liveVsDbEnableMismatch: number;
      conflictingOwnership: number;
      missingOwnership: number;
      conflictingInboundIds: number;
      conflictingPanelIdentities: number;
      missingPanelIdentity: number;
      panelProvenanceUnverifiedLegacy: number;
      missingInboundId: number;
      referencesRemovedHistoricalInbound: number;
      uncertainClientLocks: number;
      uncertainInboundLocks: number;
      activeInProgressLocks: number;
    };
    blockingReasonCounts: Record<string, number>;
  };
  circuitBreakerEvaluation: {
    evaluated: boolean;
    wouldTrigger: boolean;
    primaryReason: DiagnosticCircuitBreakerReason | null;
    allTriggeredReasons: DiagnosticCircuitBreakerReason[];
    eligibleCandidateCount: number;
    rawAbsentBothSnapshotsCount: number;
    totalTrackedNonDeleted: number;
    missingRatio: number;
    maxDeletesPerCycle: number;
    maxMissingRatio: number;
  };
  activeAndUncertainLocks: DiagnosticUncertainLockSummary[];
  directInboundVerificationProbe: {
    optInRequested: boolean;
    executed: boolean;
    skippedReason: string | null;
    maxConcurrency: number;
    customerBudgetMs: number;
    probedCount: number;
    directSucceededCount: number;
    directFailedOrEmptyCount: number;
    directTimedOutCount: number;
    directSkippedBudgetCount: number;
    wouldBreakCustomerPromiseAll: boolean | null;
    knownTelemetryNote: string;
    inbounds: DiagnosticDirectProbeEntry[];
  };
  clients: DiagnosticClientRow[];
}

export interface RunSyncDiagnosticsOptions {
  dbClient?: any;
  includeDirectProbe?: boolean;
  totalBudgetMs?: number;
  reReadDelayMs?: number;
  pageSize?: number;
  nowMs?: number;
  signal?: AbortSignal;
  panelDeletionSyncEnabled?: boolean;
  maxDeletesPerCycle?: number;
  maxMissingRatio?: number;
  fetchInboundsListFn?: (opts: {
    timeoutMs: number;
    signal?: AbortSignal;
    dbClient?: any;
    sessionState?: DiagnosticIsolatedSessionState;
  }) => Promise<DiagnosticReadOnlyListResult>;
  probeDirectInboundFn?: (
    inboundId: number,
    opts: {
      timeoutMs: number;
      signal?: AbortSignal;
      dbClient?: any;
      sessionState?: DiagnosticIsolatedSessionState;
    }
  ) => Promise<DiagnosticDirectInboundProbeResult>;
}

// ==============================================================================
// INTERNAL HELPERS — REDACTION, BUDGETING, PAGINATION & SNAPSHOT PARSING
// ==============================================================================

function redactOwnerUid(rawUid: string | null | undefined): string {
  const norm = String(rawUid || '').trim().toLowerCase();
  if (!norm) return 'missing';
  const digest = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 12);
  return `owner:${digest}`;
}

function sanitizeInboundRemark(rawRemark: unknown): string {
  const cleaned = String(rawRemark ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.slice(0, 64);
}

/**
 * Protects CSV cells against RFC-4180 breaking and spreadsheet formula injection,
 * including leading whitespace, BOM, and control characters before =, +, -, @, |.
 */
export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '""';
  }
  const raw = String(value);
  // Normalize line breaks and strip unsafe ASCII control characters (0x00-0x1F, 0x7F)
  let normalized = raw
    .replace(/\r\n|\r|\n|\t/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '');

  // Detect formula trigger characters even after arbitrary leading whitespace or BOM
  const trimmedLeading = normalized.replace(/^[\s\uFEFF\u200B-\u200D]+/, '');
  if (
    trimmedLeading.length > 0 &&
    /^[=+\-@|]/.test(trimmedLeading)
  ) {
    normalized = `'${normalized}`;
  }

  const escaped = normalized.replace(/"/g, '""');
  return `"${escaped}"`;
}

function isConfirmedMissingColumnError(err: any): { missing: boolean; columnName: string | null } {
  if (!err) return { missing: false, columnName: null };
  const code = String(err?.code || '').toUpperCase();
  const msg = String(err?.message || '');
  const details = String(err?.details || '');
  const combined = `${msg} ${details}`;

  const isCodeMatch = code === '42703' || code === 'PGRST204';
  const pgMatch = combined.match(
    /column\s+(?:[a-zA-Z0-9_."]+\.)?"?([a-zA-Z0-9_]+)"?(?:\s+of\s+relation\s+"?[a-zA-Z0-9_.]+"?)?\s+does\s+not\s+exist/i
  );
  const pgrstMatch = combined.match(/could\s+not\s+find\s+the\s+'([a-zA-Z0-9_]+)'\s+column/i);

  if (pgMatch?.[1]) {
    return { missing: true, columnName: pgMatch[1].toLowerCase() };
  }
  if (pgrstMatch?.[1]) {
    return { missing: true, columnName: pgrstMatch[1].toLowerCase() };
  }
  if (isCodeMatch) {
    return { missing: true, columnName: null };
  }
  return { missing: false, columnName: null };
}

function isMissingTableError(err: any): boolean {
  if (!err) return false;
  const code = String(err?.code || '').toUpperCase();
  const msg = String(err?.message || '').toLowerCase();
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    (msg.includes('relation') && msg.includes('does not exist')) ||
    (msg.includes('could not find the table') && msg.includes('schema cache'))
  );
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!signal?.aborted);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function runBoundedConcurrency<T, R>(
  items: T[],
  maxConcurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const limit = Math.max(1, Math.min(Math.floor(maxConcurrency), items.length));
  let nextIndex = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const current = nextIndex;
      if (current >= items.length) break;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.allSettled(workers);
  return results;
}

interface TableReadResult<T = any> {
  ok: boolean;
  rows: T[];
  missingTable: boolean;
  missingOptionalColumns: string[];
  aborted: boolean;
  deadlineExceeded: boolean;
}

/**
 * Strictly read-only, AbortSignal-aware, deterministic primary-key cursor paginator
 * with explicit column projections (NEVER SELECT *) and safe optional-column fallback.
 */
async function fetchDiagnosticTablePaginated<T = any>(params: {
  dbClient: any;
  table: string;
  requiredColumns: string[];
  optionalColumns: string[];
  primaryKeyColumn?: string;
  optionalTable?: boolean;
  pageSize: number;
  deadlineMs: number;
  signal: AbortSignal;
  applyFilters?: (query: any) => any;
}): Promise<TableReadResult<T>> {
  const {
    dbClient,
    table,
    requiredColumns,
    optionalColumns,
    optionalTable = false,
    pageSize,
    deadlineMs,
    signal,
    applyFilters,
  } = params;
  const pkCol = params.primaryKeyColumn || 'id';

  if (!dbClient || typeof dbClient.from !== 'function') {
    return {
      ok: false,
      rows: [],
      missingTable: false,
      missingOptionalColumns: [],
      aborted: false,
      deadlineExceeded: false,
    };
  }

  let activeOptional = [...optionalColumns];
  const droppedOptional: string[] = [];

  while (true) {
    if (signal.aborted || Date.now() >= deadlineMs) {
      const reasonMsg = String((signal as any)?.reason?.message || '').toLowerCase();
      return {
        ok: false,
        rows: [],
        missingTable: false,
        missingOptionalColumns: droppedOptional,
        aborted: true,
        deadlineExceeded: reasonMsg.includes('deadline') || Date.now() >= deadlineMs,
      };
    }

    const selectCols = [...requiredColumns, ...activeOptional].join(', ');
    const allRows: T[] = [];
    const seenIds = new Set<string>();
    let lastCursorId: string | number | null = null;
    let pagesFetched = 0;
    const maxPages = 1000;
    let retryWithReducedColumns = false;

    while (pagesFetched < maxPages) {
      if (signal.aborted || Date.now() >= deadlineMs) {
        const reasonMsg = String((signal as any)?.reason?.message || '').toLowerCase();
        return {
          ok: false,
          rows: [],
          missingTable: false,
          missingOptionalColumns: droppedOptional,
          aborted: true,
          deadlineExceeded: reasonMsg.includes('deadline') || Date.now() >= deadlineMs,
        };
      }

      try {
        let query: any = dbClient.from(table).select(selectCols);
        if (applyFilters) {
          query = applyFilters(query);
        }
        if (typeof query.order === 'function') {
          query = query.order(pkCol, { ascending: true });
        }
        const supportsGtCursor = typeof query.gt === 'function';
        if (lastCursorId !== null && supportsGtCursor) {
          query = query.gt(pkCol, lastCursorId);
        }
        if (typeof query.limit === 'function') {
          query = query.limit(pageSize);
        } else if (typeof query.range === 'function') {
          const offset = pagesFetched * pageSize;
          query = query.range(offset, offset + pageSize - 1);
        }
        if (typeof query.abortSignal === 'function') {
          query = query.abortSignal(signal);
        }

        const res: any = await query;
        if (res?.error) {
          if (optionalTable && isMissingTableError(res.error)) {
            return {
              ok: true,
              rows: [],
              missingTable: true,
              missingOptionalColumns: droppedOptional,
              aborted: false,
              deadlineExceeded: false,
            };
          }

          const missingCol = isConfirmedMissingColumnError(res.error);
          if (missingCol.missing && activeOptional.length > 0 && pagesFetched === 0) {
            if (!missingCol.columnName) {
              // Ambiguous missing-column error with no identified column name -> fail CLOSED!
              // Never drop all optional columns based on ambiguous or unrelated errors.
              return {
                ok: false,
                rows: [],
                missingTable: false,
                missingOptionalColumns: droppedOptional,
                aborted: false,
                deadlineExceeded: false,
              };
            }
            const lowerRequired = new Set(requiredColumns.map((c) => c.toLowerCase()));
            if (lowerRequired.has(missingCol.columnName)) {
              // Required column missing -> fail CLOSED immediately!
              return {
                ok: false,
                rows: [],
                missingTable: false,
                missingOptionalColumns: droppedOptional,
                aborted: false,
                deadlineExceeded: false,
              };
            }
            const beforeLen = activeOptional.length;
            activeOptional = activeOptional.filter((c) => c.toLowerCase() !== missingCol.columnName);
            if (activeOptional.length < beforeLen) {
              // Confirmed missing explicitly optional column -> drop ONLY that column and retry
              droppedOptional.push(missingCol.columnName);
              retryWithReducedColumns = true;
              break;
            }
            // Identified column is neither required nor explicitly optional -> fail CLOSED immediately!
            return {
              ok: false,
              rows: [],
              missingTable: false,
              missingOptionalColumns: droppedOptional,
              aborted: false,
              deadlineExceeded: false,
            };
          }

          return {
            ok: false,
            rows: [],
            missingTable: false,
            missingOptionalColumns: droppedOptional,
            aborted: signal.aborted,
            deadlineExceeded: Date.now() >= deadlineMs,
          };
        }

        if (!Array.isArray(res?.data)) {
          return {
            ok: false,
            rows: [],
            missingTable: false,
            missingOptionalColumns: droppedOptional,
            aborted: false,
            deadlineExceeded: false,
          };
        }

        const pageRows: any[] = res.data;
        pagesFetched += 1;

        if (pageRows.length === 0) {
          return {
            ok: true,
            rows: allRows,
            missingTable: false,
            missingOptionalColumns: droppedOptional,
            aborted: false,
            deadlineExceeded: false,
          };
        }

        if (!supportsGtCursor) {
          for (const r of pageRows) allRows.push(r as T);
          return {
            ok: true,
            rows: allRows,
            missingTable: false,
            missingOptionalColumns: droppedOptional,
            aborted: false,
            deadlineExceeded: false,
          };
        }

        let advancedInPage = 0;
        let nextCursorCandidate: string | number | null = lastCursorId;

        for (const r of pageRows) {
          const rawPk = r?.[pkCol];
          if (rawPk === null || rawPk === undefined || String(rawPk).trim() === '') {
            return {
              ok: false,
              rows: [],
              missingTable: false,
              missingOptionalColumns: droppedOptional,
              aborted: false,
              deadlineExceeded: false,
            };
          }
          const pkKey = String(rawPk);
          if (seenIds.has(pkKey)) continue;
          seenIds.add(pkKey);
          allRows.push(r as T);
          nextCursorCandidate = rawPk;
          advancedInPage += 1;
        }

        if (advancedInPage === 0) {
          return {
            ok: true,
            rows: allRows,
            missingTable: false,
            missingOptionalColumns: droppedOptional,
            aborted: false,
            deadlineExceeded: false,
          };
        }
        if (nextCursorCandidate === lastCursorId) {
          return {
            ok: false,
            rows: [],
            missingTable: false,
            missingOptionalColumns: droppedOptional,
            aborted: false,
            deadlineExceeded: false,
          };
        }
        lastCursorId = nextCursorCandidate;
      } catch {
        const reasonMsg = String((signal as any)?.reason?.message || '').toLowerCase();
        return {
          ok: false,
          rows: [],
          missingTable: false,
          missingOptionalColumns: droppedOptional,
          aborted: signal.aborted,
          deadlineExceeded: reasonMsg.includes('deadline') || Date.now() >= deadlineMs,
        };
      }
    }

    if (!retryWithReducedColumns) {
      // Exceeded maxPages without reaching empty page -> fail closed
      return {
        ok: false,
        rows: [],
        missingTable: false,
        missingOptionalColumns: droppedOptional,
        aborted: false,
        deadlineExceeded: false,
      };
    }
  }
}

interface ParsedSnapshotOccurrence {
  inboundId: number;
  remark: string;
  port: number | null;
  enabled: boolean;
  expiryTime: number;
}

interface ParsedDiagnosticSnapshot {
  ok: boolean;
  allInboundsCleanlyParsed: boolean;
  unparsedInboundIds: number[];
  inboundCount: number;
  totalLiveOccurrences: number;
  uniqueLiveUuidCount: number;
  duplicateLiveUuids: Set<string>;
  duplicateAcrossDifferentInbounds: Set<string>;
  occurrencesByUuid: Map<string, ParsedSnapshotOccurrence[]>;
  inboundsById: Map<
    number,
    {
      inboundId: number;
      remark: string;
      port: number | null;
      liveClientCount: number;
      uniqueLiveUuidCount: number;
    }
  >;
}

function parseDiagnosticSnapshot(inbounds: XuiInbound[]): ParsedDiagnosticSnapshot {
  const unparsedInboundIds: number[] = [];
  const occurrencesByUuid = new Map<string, ParsedSnapshotOccurrence[]>();
  const duplicateLiveUuids = new Set<string>();
  const duplicateAcrossDifferentInbounds = new Set<string>();
  const inboundsById = new Map<
    number,
    {
      inboundId: number;
      remark: string;
      port: number | null;
      liveClientCount: number;
      uniqueLiveUuidCount: number;
    }
  >();

  let totalLiveOccurrences = 0;

  for (const ib of inbounds) {
    const parsed = parseInboundSettingsClientsStrict(ib);
    if (!parsed.ok) {
      const rawId = Number((ib as any)?.id);
      unparsedInboundIds.push(Number.isInteger(rawId) && rawId > 0 ? rawId : -1);
      continue;
    }

    const remark = sanitizeInboundRemark((ib as any)?.remark);
    const rawPort = Number((ib as any)?.port);
    const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : null;
    const uniqueInThisInbound = new Set<string>();

    for (const c of parsed.clients) {
      const normUuid = String(c?.id || '').trim().toLowerCase();
      if (!normUuid) continue;
      totalLiveOccurrences += 1;
      uniqueInThisInbound.add(normUuid);

      const occ: ParsedSnapshotOccurrence = {
        inboundId: parsed.inboundId,
        remark,
        port,
        enabled: c.enable !== false,
        expiryTime: Number(c.expiryTime) || 0,
      };

      const existing = occurrencesByUuid.get(normUuid);
      if (existing) {
        duplicateLiveUuids.add(normUuid);
        if (existing.some((e) => e.inboundId !== parsed.inboundId)) {
          duplicateAcrossDifferentInbounds.add(normUuid);
        }
        existing.push(occ);
      } else {
        occurrencesByUuid.set(normUuid, [occ]);
      }
    }

    inboundsById.set(parsed.inboundId, {
      inboundId: parsed.inboundId,
      remark,
      port,
      liveClientCount: parsed.clients.length,
      uniqueLiveUuidCount: uniqueInThisInbound.size,
    });
  }

  return {
    ok: inbounds.length > 0 && unparsedInboundIds.length === 0,
    allInboundsCleanlyParsed: unparsedInboundIds.length === 0,
    unparsedInboundIds,
    inboundCount: inbounds.length,
    totalLiveOccurrences,
    uniqueLiveUuidCount: occurrencesByUuid.size,
    duplicateLiveUuids,
    duplicateAcrossDifferentInbounds,
    occurrencesByUuid,
    inboundsById,
  };
}

function normalizeVpnLifecycleStatus(rawStatus: unknown, deletedFromPanelAt?: unknown): string {
  if (deletedFromPanelAt) return 'deleted';
  const st = String(rawStatus || '').trim().toLowerCase();
  if (!st) return 'unknown';
  if (st === 'canceled') return 'cancelled';
  if (st === 'cancelled' || st === 'rejected' || st === 'revoked') return 'revoked';
  if (st === 'active' || st === 'enabled') return 'active';
  if (st === 'disabled' || st === 'inactive' || st === 'suspended') return 'disabled';
  if (st === 'expired') return 'expired';
  if (st === 'deleted') return 'deleted';
  return st;
}

function detectTrialOrder(ord: any): boolean {
  if (!ord || typeof ord !== 'object') return false;
  if (ord.is_trial === true) return true;
  const orderId = String(ord.order_id || ord.id || '').trim().toUpperCase();
  if (orderId.startsWith('TRIAL-')) return true;
  const pkg = String(ord.package_name || '').toLowerCase();
  if (/\bfree\s*trial\b/.test(pkg) || pkg.includes('trial')) return true;
  const pmRaw = ord.payment_method;
  if (typeof pmRaw === 'string') {
    const pmLower = pmRaw.toLowerCase();
    if (pmLower.includes('trial')) return true;
    if (pmRaw.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(pmRaw);
        if (parsed?.is_trial === true || parsed?.isTrial === true) return true;
        if (String(parsed?.paymentMethod || '').toLowerCase().includes('trial')) return true;
      } catch {
        // ignore invalid JSON
      }
    }
  } else if (pmRaw && typeof pmRaw === 'object') {
    if (pmRaw.is_trial === true || pmRaw.isTrial === true) return true;
    if (String(pmRaw.paymentMethod || '').toLowerCase().includes('trial')) return true;
  }
  return false;
}

function parseTimestampMs(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw <= 0) return null;
    // Handle Unix seconds vs milliseconds
    return raw < 1e12 ? raw * 1000 : raw;
  }
  const parsed = Date.parse(String(raw));
  return Number.isNaN(parsed) ? null : parsed;
}

function pickLatestIso(a: string | null, b: unknown): string | null {
  if (!b) return a;
  const bStr = String(b);
  const bMs = Date.parse(bStr);
  if (Number.isNaN(bMs)) return a;
  if (!a) return bStr;
  const aMs = Date.parse(a);
  if (Number.isNaN(aMs)) return bStr;
  return bMs > aMs ? bStr : a;
}

function mapPanelErrorToAbortReason(
  stage: 'snapshot1' | 'snapshot2',
  errorCode: DiagnosticPanelErrorCode | null
): DiagnosticAbortReason {
  if (errorCode === 'diagnostic_deadline_exceeded') return 'diagnostic_deadline_exceeded';
  if (errorCode === 'diagnostic_aborted') return 'diagnostic_aborted';
  if (errorCode === 'panel_config_unavailable') return 'panel_config_unavailable';
  if (errorCode === 'panel_auth_failed') return 'panel_auth_failed';
  if (errorCode === 'panel_empty_inbounds') {
    return stage === 'snapshot1' ? 'panel_snapshot1_empty' : 'panel_snapshot2_empty';
  }
  if (errorCode === 'panel_malformed_inbound' || errorCode === 'panel_non_array_response') {
    return stage === 'snapshot1' ? 'panel_snapshot1_malformed' : 'panel_snapshot2_malformed';
  }
  return stage === 'snapshot1' ? 'panel_snapshot1_failed' : 'panel_snapshot2_failed';
}

function setsEqualNumbers(a: number[], b: number[]): boolean {
  const setA = Array.from(new Set(a)).sort((x, y) => x - y);
  const setB = Array.from(new Set(b)).sort((x, y) => x - y);
  if (setA.length !== setB.length) return false;
  for (let i = 0; i < setA.length; i++) {
    if (setA[i] !== setB[i]) return false;
  }
  return true;
}

// ==============================================================================
// MAIN READ-ONLY DIAGNOSTIC RUNNER
// ==============================================================================

export async function runReadOnlySyncDiagnostics(
  options?: RunSyncDiagnosticsOptions
): Promise<SyncDiagnosticsReport> {
  const startedAtMs = Date.now();
  const nowMs = options?.nowMs ?? startedAtMs;
  const generatedAt = new Date(nowMs).toISOString();
  const totalBudgetMs = Math.max(
    300,
    Math.min(
      Math.floor(options?.totalBudgetMs ?? DEFAULT_DIAGNOSTIC_BUDGET_MS),
      MAX_DIAGNOSTIC_BUDGET_MS
    )
  );
  const serializationReserveMs = Math.min(1000, Math.floor(totalBudgetMs * 0.15));
  const deadlineMs = startedAtMs + totalBudgetMs;
  const reReadDelayMs = Math.max(0, Math.min(Math.floor(options?.reReadDelayMs ?? DEFAULT_REREAD_DELAY_MS), 2000));
  const pageSize = Math.max(1, Math.min(Math.floor(options?.pageSize ?? 1000), 5000));
  const includeDirectProbe = options?.includeDirectProbe === true; // Opt-in, disabled by default!

  const dbClient = options?.dbClient ?? supabaseAdmin;
  const fetchListFn = options?.fetchInboundsListFn ?? fetchReadOnlyDiagnosticInboundsList;
  const probeInboundFn = options?.probeDirectInboundFn ?? probeDirectLiveInboundReadOnly;
  const diagnosticSessionState = createDiagnosticIsolatedSessionState();
  const panelDeletionSyncEnabled =
    options?.panelDeletionSyncEnabled ?? isPanelDeletionSyncFlagEnabled();
  const maxDeletesPerCycle =
    options?.maxDeletesPerCycle ?? getPanelDeletionSyncMaxDeletesPerCycle();
  const maxMissingRatio =
    options?.maxMissingRatio ?? getPanelDeletionSyncMaxMissingRatio();

  // Shared AbortController bound to ONE absolute execution deadline + external request cancellation
  const controller = new AbortController();
  let deadlineExceeded = false;
  let externallyCancelled = false;

  const deadlineTimer = setTimeout(() => {
    deadlineExceeded = true;
    if (!controller.signal.aborted) {
      controller.abort(new Error('diagnostic_deadline_exceeded'));
    }
  }, totalBudgetMs);

  const onExternalAbort = () => {
    externallyCancelled = true;
    if (!controller.signal.aborted) {
      controller.abort(new Error('diagnostic_aborted'));
    }
  };

  if (options?.signal) {
    if (options.signal.aborted) {
      onExternalAbort();
    } else {
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const getRemainingWorkBudgetMs = (minRequiredMs = 80): number | null => {
    if (controller.signal.aborted) return null;
    const remaining = deadlineMs - Date.now() - serializationReserveMs;
    if (remaining < minRequiredMs) {
      deadlineExceeded = true;
      if (!controller.signal.aborted) {
        controller.abort(new Error('diagnostic_deadline_exceeded'));
      }
      return null;
    }
    return remaining;
  };

  const missingOptionalColumnsByTable: Record<string, string[]> = {};
  const optionalTablesMissing: string[] = [];

  let resolvedPanelIdentity: string | null = null;
  let configuredServersCount = 0;

  // Snapshot telemetry defaults
  const snapshotMeta: SyncDiagnosticsReport['panel']['snapshots'] = {
    snapshot1Ok: false,
    snapshot1LatencyMs: null,
    snapshot1InboundCount: 0,
    snapshot1LiveOccurrences: 0,
    snapshot1UniqueLiveUuids: 0,
    snapshot1DuplicateLiveUuids: 0,
    snapshot1UnparsedInboundIds: [],
    snapshot1ErrorCode: null,
    snapshot2Executed: false,
    snapshot2Ok: false,
    snapshot2LatencyMs: null,
    snapshot2InboundCount: 0,
    snapshot2LiveOccurrences: 0,
    snapshot2UniqueLiveUuids: 0,
    snapshot2DuplicateLiveUuids: 0,
    snapshot2UnparsedInboundIds: [],
    snapshot2ErrorCode: null,
  };

  const buildAbortedReport = (abortReason: DiagnosticAbortReason): SyncDiagnosticsReport => {
    const elapsed = Math.max(0, Date.now() - startedAtMs);
    return {
      success: false,
      readOnly: true,
      aborted: true,
      abortReason,
      generatedAt,
      executionMs: elapsed,
      budget: {
        totalBudgetMs,
        remainingBudgetMs: Math.max(0, deadlineMs - Date.now()),
        deadlineExceeded: deadlineExceeded || abortReason === 'diagnostic_deadline_exceeded',
        cancelled: externallyCancelled || abortReason === 'diagnostic_aborted',
      },
      runtimeLimits: {
        mutexScope: 'per_instance_in_memory',
        rateLimitScope: 'per_instance_in_memory',
        directProbeOptIn: includeDirectProbe,
        maxDirectProbeConcurrency: MAX_DIRECT_PROBE_CONCURRENCY,
        note: 'In-process mutex and rate limiting are enforced per backend instance and are not distributed across multiple replicas.',
      },
      panel: {
        panelIdentity: resolvedPanelIdentity,
        connectionMode:
          configuredServersCount > 0
            ? 'configured_servers_present'
            : resolvedPanelIdentity
              ? 'env_single_panel'
              : 'unknown',
        configuredXuiServersCount: configuredServersCount,
        panelProvenanceNote:
          'Classification aborted before completion; no client absence or deletion conclusions were produced.',
        panelDeletionSyncEnabled,
        snapshots: snapshotMeta,
      },
      schemaCompatibility: {
        vpnConfigsOwnershipColumn: 'customer_uid',
        vpnAccountsHasInboundId: false,
        missingOptionalColumnsByTable,
        optionalTablesMissing,
      },
      liveInbounds: [],
      historicalMissingInbounds: [],
      summary: {
        uniqueDbTrackedNonDeleted: 0,
        uniqueDbAllIncludingDeletedAndOrders: 0,
        livePanelUniqueClientsSnap1: snapshotMeta.snapshot1UniqueLiveUuids,
        livePanelUniqueClientsSnap2: snapshotMeta.snapshot2Executed
          ? snapshotMeta.snapshot2UniqueLiveUuids
          : null,
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
        untrackedLivePanelClients: 0,
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
        evaluated: false,
        wouldTrigger: false,
        primaryReason: null,
        allTriggeredReasons: [],
        eligibleCandidateCount: 0,
        rawAbsentBothSnapshotsCount: 0,
        totalTrackedNonDeleted: 0,
        missingRatio: 0,
        maxDeletesPerCycle,
        maxMissingRatio,
      },
      activeAndUncertainLocks: [],
      directInboundVerificationProbe: {
        optInRequested: includeDirectProbe,
        executed: false,
        skippedReason: `aborted:${abortReason}`,
        maxConcurrency: MAX_DIRECT_PROBE_CONCURRENCY,
        customerBudgetMs: CUSTOMER_LIVE_INBOUND_BUDGET_MS,
        probedCount: 0,
        directSucceededCount: 0,
        directFailedOrEmptyCount: 0,
        directTimedOutCount: 0,
        directSkippedBudgetCount: 0,
        wouldBreakCustomerPromiseAll: null,
        knownTelemetryNote:
          "vpnController.ts:29 and clientController.ts:30 hardcode '3X-UI Time: 0ms'; actual 3X-UI latency is included inside Database Time.",
        inbounds: [],
      },
      clients: [],
    };
  };

  try {
    if (!dbClient || typeof dbClient.from !== 'function') {
      return buildAbortedReport('db_client_unavailable');
    }

    const initialBudget = getRemainingWorkBudgetMs(120);
    if (initialBudget === null) {
      return buildAbortedReport(externallyCancelled ? 'diagnostic_aborted' : 'diagnostic_deadline_exceeded');
    }

    // --------------------------------------------------------------------------
    // STEP 1: Launch Snapshot 1 AND Read-Only Minimized Supabase Pagination
    //         in parallel under the single shared execution deadline & signal.
    // --------------------------------------------------------------------------
    const snap1TimeoutMs = Math.min(7000, Math.max(200, Math.floor(initialBudget * 0.55)));
    const dbDeadlineMs = deadlineMs - serializationReserveMs;

    const [
      snap1Settled,
      accSettled,
      cfgSettled,
      grantsSettled,
      ordersSettled,
      locksSettled,
      serversSettled,
    ] = await Promise.allSettled([
      fetchListFn({
        timeoutMs: snap1TimeoutMs,
        signal: controller.signal,
        dbClient,
        sessionState: diagnosticSessionState,
      }),
      fetchDiagnosticTablePaginated({
        dbClient,
        table: 'vpn_accounts',
        requiredColumns: ['id', 'user_id', 'uuid', 'status', 'enable', 'created_at'],
        optionalColumns: [
          'order_id',
          'server_id',
          'is_trial',
          'expiry_time',
          'expiry_date',
          'expires_at',
          'panel_identity',
          'deleted_from_panel_at',
          'reconciliation_required',
        ],
        primaryKeyColumn: 'id',
        pageSize,
        deadlineMs: dbDeadlineMs,
        signal: controller.signal,
      }),
      fetchDiagnosticTablePaginated({
        dbClient,
        table: 'vpn_configs',
        // Production vpn_configs uses customer_uid (never user_id) and does not depend on updated_at
        requiredColumns: ['id', 'customer_uid', 'uuid', 'inbound_id', 'status', 'enabled', 'created_at'],
        optionalColumns: [
          'order_id',
          'is_trial',
          'expiry_time',
          'expiry_date',
          'expires_at',
          'server_id',
          'panel_identity',
          'deleted_from_panel_at',
          'reconciliation_required',
        ],
        primaryKeyColumn: 'id',
        pageSize,
        deadlineMs: dbDeadlineMs,
        signal: controller.signal,
      }),
      fetchDiagnosticTablePaginated({
        dbClient,
        table: 'vpn_entitlement_grants',
        requiredColumns: ['id', 'client_uuid', 'inbound_id'],
        optionalColumns: ['order_id', 'user_id', 'status', 'provisional', 'grant_type', 'created_at'],
        primaryKeyColumn: 'id',
        optionalTable: true,
        pageSize,
        deadlineMs: dbDeadlineMs,
        signal: controller.signal,
        applyFilters: (q) => q.not('inbound_id', 'is', null),
      }),
      fetchDiagnosticTablePaginated({
        dbClient,
        table: 'orders',
        requiredColumns: ['id', 'status', 'created_at'],
        optionalColumns: [
          'order_id',
          'customer_id',
          'payment_status',
          'provisioning_status',
          'client_uuid',
          'is_trial',
          'payment_method',
          'package_name',
          'expires_at',
          'expiry_date',
        ],
        primaryKeyColumn: 'id',
        pageSize,
        deadlineMs: dbDeadlineMs,
        signal: controller.signal,
      }),
      fetchDiagnosticTablePaginated({
        dbClient,
        table: 'provisioning_operations',
        requiredColumns: ['operation_key', 'status'],
        optionalColumns: [
          'id',
          'operation_type',
          'target_id',
          'client_uuid',
          'lease_expires_at',
          'uncertain_at',
          'created_at',
          'updated_at',
        ],
        primaryKeyColumn: 'operation_key',
        optionalTable: true,
        pageSize,
        deadlineMs: dbDeadlineMs,
        signal: controller.signal,
        applyFilters: (q) => q.in('status', ['in_progress', 'uncertain']),
      }),
      fetchDiagnosticTablePaginated({
        dbClient,
        table: 'xui_servers',
        requiredColumns: ['id', 'is_active'],
        optionalColumns: ['panel_url', 'url'],
        primaryKeyColumn: 'id',
        optionalTable: true,
        pageSize,
        deadlineMs: dbDeadlineMs,
        signal: controller.signal,
      }),
    ]);

    // Check abort / deadline first
    if (controller.signal.aborted) {
      return buildAbortedReport(
        externallyCancelled ? 'diagnostic_aborted' : 'diagnostic_deadline_exceeded'
      );
    }

    // Validate Snapshot 1 result strictly
    if (snap1Settled.status !== 'fulfilled') {
      return buildAbortedReport('panel_snapshot1_failed');
    }
    const snap1Raw = snap1Settled.value;
    snapshotMeta.snapshot1LatencyMs = snap1Raw.latencyMs;
    snapshotMeta.snapshot1ErrorCode = snap1Raw.errorCode;
    if (snap1Raw.panelIdentity) {
      resolvedPanelIdentity = snap1Raw.panelIdentity;
    }

    if (!snap1Raw.ok || !Array.isArray(snap1Raw.inbounds) || snap1Raw.inbounds.length === 0) {
      return buildAbortedReport(mapPanelErrorToAbortReason('snapshot1', snap1Raw.errorCode));
    }

    const snap1Parsed = parseDiagnosticSnapshot(snap1Raw.inbounds);
    snapshotMeta.snapshot1InboundCount = snap1Parsed.inboundCount;
    snapshotMeta.snapshot1LiveOccurrences = snap1Parsed.totalLiveOccurrences;
    snapshotMeta.snapshot1UniqueLiveUuids = snap1Parsed.uniqueLiveUuidCount;
    snapshotMeta.snapshot1DuplicateLiveUuids = snap1Parsed.duplicateLiveUuids.size;
    snapshotMeta.snapshot1UnparsedInboundIds = snap1Parsed.unparsedInboundIds;
    snapshotMeta.snapshot1Ok = snap1Parsed.ok;

    if (!snap1Parsed.ok || !snap1Parsed.allInboundsCleanlyParsed) {
      snapshotMeta.snapshot1ErrorCode = 'panel_malformed_inbound';
      return buildAbortedReport('panel_snapshot1_malformed');
    }

    if (!resolvedPanelIdentity) {
      return buildAbortedReport('panel_config_unavailable');
    }

    // Validate all required DB reads (fail closed on any DB failure)
    const checkTable = (
      settled: PromiseSettledResult<TableReadResult>,
      tableName: string,
      failReason: DiagnosticAbortReason
    ): { ok: boolean; rows: any[]; abortReason: DiagnosticAbortReason | null } => {
      if (settled.status !== 'fulfilled') {
        return { ok: false, rows: [], abortReason: failReason };
      }
      const val = settled.value;
      if (val.missingOptionalColumns.length > 0) {
        missingOptionalColumnsByTable[tableName] = Array.from(new Set(val.missingOptionalColumns));
      }
      if (val.missingTable) {
        optionalTablesMissing.push(tableName);
      }
      if (!val.ok) {
        if (val.deadlineExceeded) return { ok: false, rows: [], abortReason: 'diagnostic_deadline_exceeded' };
        if (val.aborted) return { ok: false, rows: [], abortReason: 'diagnostic_aborted' };
        return { ok: false, rows: [], abortReason: failReason };
      }
      return { ok: true, rows: val.rows, abortReason: null };
    };

    const accCheck = checkTable(accSettled, 'vpn_accounts', 'db_vpn_accounts_query_failed');
    if (!accCheck.ok) return buildAbortedReport(accCheck.abortReason || 'db_vpn_accounts_query_failed');

    const cfgCheck = checkTable(cfgSettled, 'vpn_configs', 'db_vpn_configs_query_failed');
    if (!cfgCheck.ok) return buildAbortedReport(cfgCheck.abortReason || 'db_vpn_configs_query_failed');

    const grantsCheck = checkTable(grantsSettled, 'vpn_entitlement_grants', 'db_grants_query_failed');
    if (!grantsCheck.ok) return buildAbortedReport(grantsCheck.abortReason || 'db_grants_query_failed');

    const ordersCheck = checkTable(ordersSettled, 'orders', 'db_orders_query_failed');
    if (!ordersCheck.ok) return buildAbortedReport(ordersCheck.abortReason || 'db_orders_query_failed');

    const locksCheck = checkTable(locksSettled, 'provisioning_operations', 'db_locks_query_failed');
    if (!locksCheck.ok) return buildAbortedReport(locksCheck.abortReason || 'db_locks_query_failed');

    const serversCheck = checkTable(serversSettled, 'xui_servers', 'db_xui_servers_query_failed');
    if (!serversCheck.ok) return buildAbortedReport(serversCheck.abortReason || 'db_xui_servers_query_failed');

    const accounts = accCheck.rows;
    const configs = cfgCheck.rows;
    const grants = grantsCheck.rows;
    const orders = ordersCheck.rows;
    const activeLocks = locksCheck.rows;
    const configuredServers = serversCheck.rows.map((s: any) => ({
      id: String(s?.id || ''),
      panel_url: s?.panel_url ?? s?.url ?? null,
      is_active: s?.is_active ?? true,
    }));
    configuredServersCount = configuredServers.length;

    // --------------------------------------------------------------------------
    // STEP 2: Wait reReadDelayMs (cancellable) and fetch mandatory Snapshot 2
    //         so we detect appearing, disappearing, moving, and two-snapshot absent UUIDs.
    // --------------------------------------------------------------------------
    const budgetBeforeWait = getRemainingWorkBudgetMs(reReadDelayMs + 150);
    if (budgetBeforeWait === null) {
      return buildAbortedReport(externallyCancelled ? 'diagnostic_aborted' : 'diagnostic_deadline_exceeded');
    }

    const sleptOk = await sleepWithAbort(reReadDelayMs, controller.signal);
    if (!sleptOk || controller.signal.aborted) {
      return buildAbortedReport(externallyCancelled ? 'diagnostic_aborted' : 'diagnostic_deadline_exceeded');
    }

    const budgetForSnap2 = getRemainingWorkBudgetMs(150);
    if (budgetForSnap2 === null) {
      return buildAbortedReport(externallyCancelled ? 'diagnostic_aborted' : 'diagnostic_deadline_exceeded');
    }

    snapshotMeta.snapshot2Executed = true;
    const snap2TimeoutMs = Math.min(7000, Math.max(200, budgetForSnap2));
    let snap2Raw: DiagnosticReadOnlyListResult;
    try {
      snap2Raw = await fetchListFn({
        timeoutMs: snap2TimeoutMs,
        signal: controller.signal,
        dbClient,
        sessionState: diagnosticSessionState,
      });
    } catch {
      return buildAbortedReport(
        controller.signal.aborted
          ? externallyCancelled
            ? 'diagnostic_aborted'
            : 'diagnostic_deadline_exceeded'
          : 'panel_snapshot2_failed'
      );
    }

    snapshotMeta.snapshot2LatencyMs = snap2Raw.latencyMs;
    snapshotMeta.snapshot2ErrorCode = snap2Raw.errorCode;

    if (controller.signal.aborted) {
      return buildAbortedReport(externallyCancelled ? 'diagnostic_aborted' : 'diagnostic_deadline_exceeded');
    }
    if (!snap2Raw.ok || !Array.isArray(snap2Raw.inbounds) || snap2Raw.inbounds.length === 0) {
      return buildAbortedReport(mapPanelErrorToAbortReason('snapshot2', snap2Raw.errorCode));
    }

    const snap2Parsed = parseDiagnosticSnapshot(snap2Raw.inbounds);
    snapshotMeta.snapshot2InboundCount = snap2Parsed.inboundCount;
    snapshotMeta.snapshot2LiveOccurrences = snap2Parsed.totalLiveOccurrences;
    snapshotMeta.snapshot2UniqueLiveUuids = snap2Parsed.uniqueLiveUuidCount;
    snapshotMeta.snapshot2DuplicateLiveUuids = snap2Parsed.duplicateLiveUuids.size;
    snapshotMeta.snapshot2UnparsedInboundIds = snap2Parsed.unparsedInboundIds;
    snapshotMeta.snapshot2Ok = snap2Parsed.ok;

    if (!snap2Parsed.ok || !snap2Parsed.allInboundsCleanlyParsed) {
      snapshotMeta.snapshot2ErrorCode = 'panel_malformed_inbound';
      return buildAbortedReport('panel_snapshot2_malformed');
    }

    // --------------------------------------------------------------------------
    // STEP 3: Group DB records by normalized UUID (strictly in memory)
    // --------------------------------------------------------------------------
    interface DbClientGroup {
      clientUuid: string;
      accounts: any[];
      configs: any[];
      grants: any[];
      orders: any[];
      distinctInboundIds: Set<number>;
      primaryInboundId: number | null;
      primaryOwnerUid: string | null;
      distinctOwners: Set<string>;
      hasConflictingOwnership: boolean;
      hasMissingOwnership: boolean;
      distinctPanelIdentities: Set<string>;
      primaryPanelIdentity: string | null;
      distinctServerIds: Set<string>;
      primaryServerId: string | null;
      latestVpnCreatedAt: string | null;
      latestOrderCreatedAt: string | null;
      latestCreatedAt: string | null;
      anyNonDeletedInVpnTables: boolean;
      allDeletedInVpnTables: boolean;
      hasVpnTableRows: boolean;
    }

    const groups = new Map<string, DbClientGroup>();
    const ensureGroup = (rawUuid: unknown): DbClientGroup | null => {
      const norm = String(rawUuid || '').trim().toLowerCase();
      if (!norm) return null;
      let g = groups.get(norm);
      if (!g) {
        g = {
          clientUuid: norm,
          accounts: [],
          configs: [],
          grants: [],
          orders: [],
          distinctInboundIds: new Set<number>(),
          primaryInboundId: null,
          primaryOwnerUid: null,
          distinctOwners: new Set<string>(),
          hasConflictingOwnership: false,
          hasMissingOwnership: false,
          distinctPanelIdentities: new Set<string>(),
          primaryPanelIdentity: null,
          distinctServerIds: new Set<string>(),
          primaryServerId: null,
          latestVpnCreatedAt: null,
          latestOrderCreatedAt: null,
          latestCreatedAt: null,
          anyNonDeletedInVpnTables: false,
          allDeletedInVpnTables: true,
          hasVpnTableRows: false,
        };
        groups.set(norm, g);
      }
      return g;
    };

    // Index orders by id/order_id so vpn_accounts/vpn_configs referencing order_id can link order context
    const ordersById = new Map<string, any>();
    for (const ord of orders) {
      if (ord?.id) ordersById.set(String(ord.id).trim(), ord);
      if (ord?.order_id) ordersById.set(String(ord.order_id).trim(), ord);
      const ordUuid = String(ord?.client_uuid || '').trim().toLowerCase();
      if (ordUuid) {
        const g = ensureGroup(ordUuid);
        if (g) {
          g.orders.push(ord);
          // Keep orders.created_at strictly separate from latestVpnCreatedAt used for deletion-worker grace period
          g.latestOrderCreatedAt = pickLatestIso(g.latestOrderCreatedAt, ord.created_at);
          g.latestCreatedAt = pickLatestIso(g.latestCreatedAt, ord.created_at);
        }
      }
    }

    for (const gr of grants) {
      const g = ensureGroup(gr?.client_uuid);
      if (!g) continue;
      g.grants.push(gr);
      const gib = Number(gr?.inbound_id);
      if (Number.isInteger(gib) && gib > 0) {
        g.distinctInboundIds.add(gib);
        if (g.primaryInboundId === null) g.primaryInboundId = gib;
      }
    }

    for (const acc of accounts) {
      const g = ensureGroup(acc?.uuid);
      if (!g) continue;
      g.accounts.push(acc);
      g.hasVpnTableRows = true;

      const accOwner = String(acc?.user_id || '').trim();
      if (accOwner) {
        g.distinctOwners.add(accOwner.toLowerCase());
        if (!g.primaryOwnerUid) g.primaryOwnerUid = accOwner;
      } else {
        g.hasMissingOwnership = true;
      }

      if (acc?.panel_identity) {
        const pid = String(acc.panel_identity).trim();
        if (pid) {
          g.distinctPanelIdentities.add(pid);
          if (!g.primaryPanelIdentity) g.primaryPanelIdentity = pid;
        }
      }
      if (acc?.server_id) {
        const sid = String(acc.server_id).trim();
        if (sid) {
          g.distinctServerIds.add(sid);
          if (!g.primaryServerId) g.primaryServerId = sid;
        }
      }
      g.latestVpnCreatedAt = pickLatestIso(g.latestVpnCreatedAt, acc?.created_at);
      g.latestCreatedAt = pickLatestIso(g.latestCreatedAt, acc?.created_at);

      const st = String(acc?.status || '').trim().toLowerCase();
      if (st !== 'deleted' && !acc?.deleted_from_panel_at) {
        g.anyNonDeletedInVpnTables = true;
        g.allDeletedInVpnTables = false;
      }

      if (acc?.order_id) {
        const linkedOrd = ordersById.get(String(acc.order_id).trim());
        if (linkedOrd && !g.orders.includes(linkedOrd)) {
          g.orders.push(linkedOrd);
          g.latestOrderCreatedAt = pickLatestIso(g.latestOrderCreatedAt, linkedOrd?.created_at);
        }
      }
    }

    for (const cfg of configs) {
      const g = ensureGroup(cfg?.uuid);
      if (!g) continue;
      g.configs.push(cfg);
      g.hasVpnTableRows = true;

      const ibId = Number(cfg?.inbound_id);
      if (Number.isInteger(ibId) && ibId > 0) {
        g.distinctInboundIds.add(ibId);
        g.primaryInboundId = ibId;
      }

      const cfgCustUid = String(cfg?.customer_uid || '').trim();
      if (cfgCustUid) {
        g.distinctOwners.add(cfgCustUid.toLowerCase());
        if (!g.primaryOwnerUid) g.primaryOwnerUid = cfgCustUid;
      } else {
        g.hasMissingOwnership = true;
      }

      if (cfg?.panel_identity) {
        const pid = String(cfg.panel_identity).trim();
        if (pid) {
          g.distinctPanelIdentities.add(pid);
          if (!g.primaryPanelIdentity) g.primaryPanelIdentity = pid;
        }
      }
      if (cfg?.server_id) {
        const sid = String(cfg.server_id).trim();
        if (sid) {
          g.distinctServerIds.add(sid);
          if (!g.primaryServerId) g.primaryServerId = sid;
        }
      }
      g.latestVpnCreatedAt = pickLatestIso(g.latestVpnCreatedAt, cfg?.created_at);
      g.latestCreatedAt = pickLatestIso(g.latestCreatedAt, cfg?.created_at);

      const st = String(cfg?.status || '').trim().toLowerCase();
      if (st !== 'deleted' && !cfg?.deleted_from_panel_at) {
        g.anyNonDeletedInVpnTables = true;
        g.allDeletedInVpnTables = false;
      }

      if (cfg?.order_id) {
        const linkedOrd = ordersById.get(String(cfg.order_id).trim());
        if (linkedOrd && !g.orders.includes(linkedOrd)) {
          g.orders.push(linkedOrd);
          g.latestOrderCreatedAt = pickLatestIso(g.latestOrderCreatedAt, linkedOrd?.created_at);
        }
      }
    }

    for (const g of groups.values()) {
      if (g.distinctOwners.size > 1) {
        g.hasConflictingOwnership = true;
      }
      if (g.distinctInboundIds.size === 1) {
        g.primaryInboundId = Array.from(g.distinctInboundIds)[0];
      } else if (g.distinctInboundIds.size > 1) {
        g.primaryInboundId = null;
      }
    }

    // Index active & uncertain provisioning locks by operation_key
    const lockByKey = new Map<string, any>();
    for (const lk of activeLocks) {
      const key = String(lk?.operation_key || '').trim().toLowerCase();
      if (key) lockByKey.set(key, lk);
    }

    // --------------------------------------------------------------------------
    // STEP 4: Pre-compute Deletion-Worker Eligible Candidates & Circuit Breaker
    //         using the EXACT rules from syncDeleted3XUiClients (read-only mirror)
    // --------------------------------------------------------------------------
    let totalTrackedNonDeleted = 0;
    let rawAbsentFromSnap1 = 0;
    let rawAbsentBothSnapshots = 0;
    const eligibleCandidateUuids = new Set<string>();
    const preCircuitBreakerEvaluations = new Map<
      string,
      {
        wouldPassPreCb: boolean;
        panelIdentityCheckCode: string;
        preCbBlockReasons: string[];
      }
    >();

    for (const g of groups.values()) {
      if (!g.hasVpnTableRows || !g.anyNonDeletedInVpnTables || g.allDeletedInVpnTables) {
        continue;
      }
      totalTrackedNonDeleted += 1;

      const inSnap1 = snap1Parsed.occurrencesByUuid.has(g.clientUuid);
      const inSnap2 = snap2Parsed.occurrencesByUuid.has(g.clientUuid);

      const identityCheck = verifyRecordPanelIdentity({
        currentPanelIdentity: resolvedPanelIdentity,
        recordPanelIdentity: g.primaryPanelIdentity,
        recordServerId: g.primaryServerId,
        recordInboundId: g.primaryInboundId,
        recordOwnerUid: g.primaryOwnerUid,
        configuredServers,
      });

      const preCbBlockReasons: string[] = [];
      if (g.hasConflictingOwnership || g.distinctOwners.size > 1) {
        preCbBlockReasons.push('conflicting_or_duplicate_ownership');
      }
      if (g.hasMissingOwnership || !g.primaryOwnerUid) {
        preCbBlockReasons.push('missing_customer_ownership');
      }
      if (g.distinctInboundIds.size > 1) {
        preCbBlockReasons.push('conflicting_inbound_id');
      }
      if (g.distinctPanelIdentities.size > 1) {
        preCbBlockReasons.push('conflicting_panel_identity');
      }
      // Exact parity with syncDeleted3XUiClients: recent_provision_grace_period uses ONLY vpn_accounts/vpn_configs created_at
      if (g.latestVpnCreatedAt) {
        const createdMs = Date.parse(g.latestVpnCreatedAt);
        if (!Number.isNaN(createdMs) && nowMs - createdMs < RECENT_PROVISION_GRACE_MS) {
          preCbBlockReasons.push('recent_provision_grace_period');
        }
      }
      if (!identityCheck.ok && !preCbBlockReasons.includes(identityCheck.code)) {
        preCbBlockReasons.push(identityCheck.code);
      }

      if (!inSnap1) {
        rawAbsentFromSnap1 += 1;
        if (!inSnap2) {
          rawAbsentBothSnapshots += 1;
        }
      }

      const wouldPassPreCb = !inSnap1 && !inSnap2 && preCbBlockReasons.length === 0;
      if (wouldPassPreCb) {
        eligibleCandidateUuids.add(g.clientUuid);
      }

      preCircuitBreakerEvaluations.set(g.clientUuid, {
        wouldPassPreCb,
        panelIdentityCheckCode: identityCheck.code,
        preCbBlockReasons,
      });
    }

    // Exact circuit breaker rules mirrored from syncDeleted3XUiClients (xuiService.ts:9117-9128)
    const eligibleCandidateCount = eligibleCandidateUuids.size;
    const allTriggeredCbReasons: DiagnosticCircuitBreakerReason[] = [];
    if (
      (snap1Parsed.uniqueLiveUuidCount === 0 || snap2Parsed.uniqueLiveUuidCount === 0) &&
      totalTrackedNonDeleted >= 3
    ) {
      allTriggeredCbReasons.push('unexpected_zero_live_clients');
    }
    if (eligibleCandidateCount > maxDeletesPerCycle) {
      allTriggeredCbReasons.push('max_deletes_per_cycle_exceeded');
    }
    if (
      totalTrackedNonDeleted >= 8 &&
      eligibleCandidateCount >= 3 &&
      eligibleCandidateCount / totalTrackedNonDeleted > maxMissingRatio
    ) {
      allTriggeredCbReasons.push('max_missing_ratio_exceeded');
    }
    const primaryCbReason = allTriggeredCbReasons.length > 0 ? allTriggeredCbReasons[0] : null;
    const circuitBreakerWouldTrigger = allTriggeredCbReasons.length > 0;
    const missingRatio =
      totalTrackedNonDeleted > 0
        ? Number((eligibleCandidateCount / totalTrackedNonDeleted).toFixed(4))
        : 0;

    // --------------------------------------------------------------------------
    // STEP 5: Classify Every Unique UUID (DB + Untracked Live 3X-UI Clients)
    // --------------------------------------------------------------------------
    const allUuids = new Set<string>([
      ...groups.keys(),
      ...snap1Parsed.occurrencesByUuid.keys(),
      ...snap2Parsed.occurrencesByUuid.keys(),
    ]);

    const liveInboundIdsSet = new Set<number>(snap1Parsed.inboundsById.keys());
    const dbRefCountByInboundId = new Map<number, number>();
    const lockBlocksCountByKey = new Map<string, number>();

    const clientRows: DiagnosticClientRow[] = [];
    const blockingReasonCounts: Record<string, number> = {};
    const bumpBlockCount = (reason: string) => {
      blockingReasonCounts[reason] = (blockingReasonCounts[reason] || 0) + 1;
    };

    const summaryCounts = {
      liveMatchedHealthy: 0,
      liveMatchedStatusConflict: 0,
      liveDuplicateUuidAmbiguous: 0,
      movedClients: 0,
      snapshotInconsistentAppeared: 0,
      snapshotInconsistentDisappeared: 0,
      snapshotInconsistentMoved: 0,
      deletionWorkerBlockedBeforeCircuitBreaker: 0,
      deletionWorkerBlockedByLocks: 0,
      alreadyMarkedDeletedInDb: 0,
      ordersOnlyUntracked: 0,
      untrackedLivePanelClients: 0,
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
    };

    for (const uuid of allUuids) {
      const g = groups.get(uuid) || null;
      const occ1 = snap1Parsed.occurrencesByUuid.get(uuid) || [];
      const occ2 = snap2Parsed.occurrencesByUuid.get(uuid) || [];
      const presentInSnap1 = occ1.length > 0;
      const presentInSnap2 = occ2.length > 0;

      const liveInboundIdsSnap1 = Array.from(new Set(occ1.map((o) => o.inboundId))).sort((a, b) => a - b);
      const liveInboundIdsSnap2 = Array.from(new Set(occ2.map((o) => o.inboundId))).sort((a, b) => a - b);
      const hasDuplicateLiveUuid =
        occ1.length > 1 ||
        occ2.length > 1 ||
        snap1Parsed.duplicateLiveUuids.has(uuid) ||
        snap2Parsed.duplicateLiveUuids.has(uuid);
      const hasDuplicateAcrossDifferentInbounds =
        liveInboundIdsSnap1.length > 1 ||
        liveInboundIdsSnap2.length > 1 ||
        snap1Parsed.duplicateAcrossDifferentInbounds.has(uuid) ||
        snap2Parsed.duplicateAcrossDifferentInbounds.has(uuid);

      const primaryLiveOcc = occ1.length === 1 ? occ1[0] : occ2.length === 1 ? occ2[0] : occ1[0] || occ2[0] || null;
      const liveInboundRemark = primaryLiveOcc ? primaryLiveOcc.remark || null : null;
      const liveClientEnabled =
        !hasDuplicateLiveUuid && primaryLiveOcc ? primaryLiveOcc.enabled : null;

      // Untracked live panel client (present in live 3X-UI, no DB record at all)
      if (!g) {
        let classification: DiagnosticClientClassification = 'untracked_live_panel_client';
        if (hasDuplicateLiveUuid) {
          classification = 'live_duplicate_uuid_ambiguous';
          summaryCounts.liveDuplicateUuidAmbiguous += 1;
        } else if (!presentInSnap1 && presentInSnap2) {
          classification = 'snapshot_inconsistent_appeared_in_snap2';
          summaryCounts.snapshotInconsistentAppeared += 1;
        } else if (presentInSnap1 && !presentInSnap2) {
          classification = 'snapshot_inconsistent_disappeared_in_snap2';
          summaryCounts.snapshotInconsistentDisappeared += 1;
        } else if (!setsEqualNumbers(liveInboundIdsSnap1, liveInboundIdsSnap2)) {
          classification = 'snapshot_inconsistent_moved_between_snapshots';
          summaryCounts.snapshotInconsistentMoved += 1;
        } else {
          summaryCounts.untrackedLivePanelClients += 1;
        }

        clientRows.push({
          clientUuid: uuid,
          classification,
          presentInSnap1,
          presentInSnap2,
          liveInboundIdsSnap1,
          liveInboundIdsSnap2,
          liveInboundRemark,
          liveClientEnabled,
          hasDuplicateLiveUuid,
          hasDuplicateAcrossDifferentInbounds,
          dbInboundIds: [],
          referencesRemovedHistoricalInbound: false,
          vpnAccountStatuses: [],
          vpnConfigStatuses: [],
          orderStatuses: [],
          hasConflictingDbStatuses: false,
          statusConflictReasons: [],
          liveVsDbEnableMismatch: false,
          isHistoricalTrial: false,
          isExpiredAccount: false,
          isRejectedOrRevoked: false,
          ownerRef: 'missing',
          distinctOwnerCount: 0,
          hasConflictingOwnership: false,
          hasMissingOwnership: false,
          hasConflictingInboundIds: false,
          hasConflictingPanelIdentities: false,
          missingPanelIdentity: false,
          panelProvenanceUnverifiedLegacy: false,
          missingInboundId: false,
          panelIdentityCheckCode: 'not_in_db',
          lockStatus: 'none',
          blockingLockKeys: [],
          wouldPassPreCircuitBreakerGates: false,
          primaryBlockReason: 'not_tracked_in_db',
          allBlockingReasons: ['not_tracked_in_db'],
          dbTablesPresent: [],
          latestVpnCreatedAt: null,
          latestOrderCreatedAt: null,
          latestCreatedAt: null,
        });
        continue;
      }

      const dbInboundIds = Array.from(g.distinctInboundIds).sort((a, b) => a - b);
      for (const ibId of dbInboundIds) {
        if (g.anyNonDeletedInVpnTables) {
          dbRefCountByInboundId.set(ibId, (dbRefCountByInboundId.get(ibId) || 0) + 1);
        }
      }

      const referencesRemovedHistoricalInbound = dbInboundIds.some(
        (id) => !liveInboundIdsSet.has(id)
      );

      const vpnAccountStatuses = Array.from(
        new Set(g.accounts.map((a) => normalizeVpnLifecycleStatus(a?.status, a?.deleted_from_panel_at)))
      ).sort();
      const vpnConfigStatuses = Array.from(
        new Set(g.configs.map((c) => normalizeVpnLifecycleStatus(c?.status, c?.deleted_from_panel_at)))
      ).sort();
      const orderStatuses = Array.from(
        new Set(
          g.orders.map((o) => {
            const st = String(o?.status || '').trim().toLowerCase() || 'unknown';
            const pst = String(o?.payment_status || '').trim().toLowerCase();
            return pst ? `${st}/${pst}` : st;
          })
        )
      ).sort();

      // Equivalent status semantics comparison (avoids false positives across order/payment/VPN tables)
      const statusConflictReasons: string[] = [];
      if (vpnAccountStatuses.length > 1) {
        statusConflictReasons.push('vpn_accounts_internal_status_conflict');
      }
      if (vpnConfigStatuses.length > 1) {
        statusConflictReasons.push('vpn_configs_internal_status_conflict');
      }
      if (
        vpnAccountStatuses.length === 1 &&
        vpnConfigStatuses.length === 1 &&
        vpnAccountStatuses[0] !== vpnConfigStatuses[0]
      ) {
        statusConflictReasons.push('vpn_accounts_vs_vpn_configs_status_mismatch');
      }
      const hasActiveAccountWithDisabledFlag = g.accounts.some(
        (a) =>
          normalizeVpnLifecycleStatus(a?.status, a?.deleted_from_panel_at) === 'active' &&
          a?.enable === false
      );
      const hasActiveConfigWithDisabledFlag = g.configs.some(
        (c) =>
          normalizeVpnLifecycleStatus(c?.status, c?.deleted_from_panel_at) === 'active' &&
          c?.enabled === false
      );
      if (hasActiveAccountWithDisabledFlag || hasActiveConfigWithDisabledFlag) {
        statusConflictReasons.push('active_status_with_disabled_boolean_flag');
      }

      // Check semantic conflict between orders and active VPN tables ONLY when all linked orders are rejected/cancelled/failed
      const anyVpnActive =
        vpnAccountStatuses.includes('active') || vpnConfigStatuses.includes('active');
      const hasAnyOrderApprovedOrActive = g.orders.some((o) => {
        const st = String(o?.status || '').trim().toLowerCase();
        const pst = String(o?.payment_status || '').trim().toLowerCase();
        return st === 'active' || st === 'completed' || pst === 'paid';
      });
      const hasRejectedOrCancelledOrder = g.orders.some((o) => {
        const st = String(o?.status || '').trim().toLowerCase();
        const pst = String(o?.payment_status || '').trim().toLowerCase();
        return (
          st === 'rejected' ||
          st === 'cancelled' ||
          st === 'canceled' ||
          pst === 'failed' ||
          pst === 'cancelled' ||
          pst === 'canceled'
        );
      });
      if (anyVpnActive && hasRejectedOrCancelledOrder && !hasAnyOrderApprovedOrActive) {
        statusConflictReasons.push('active_vpn_with_rejected_or_cancelled_order');
      }

      const hasConflictingDbStatuses = statusConflictReasons.length > 0;

      // Live vs DB enable mismatch (reported separately from DB-internal status conflict)
      const liveVsDbEnableMismatch = Boolean(
        presentInSnap1 &&
          presentInSnap2 &&
          !hasDuplicateLiveUuid &&
          liveClientEnabled !== null &&
          ((anyVpnActive && liveClientEnabled === false) ||
            (!anyVpnActive && g.anyNonDeletedInVpnTables && liveClientEnabled === true))
      );

      // Historical trial / expired / rejected flags
      const isHistoricalTrial =
        g.accounts.some((a) => a?.is_trial === true || String(a?.order_id || '').toUpperCase().startsWith('TRIAL-')) ||
        g.configs.some((c) => c?.is_trial === true || String(c?.order_id || '').toUpperCase().startsWith('TRIAL-')) ||
        g.orders.some((o) => detectTrialOrder(o));

      const isExpiredAccount =
        vpnAccountStatuses.includes('expired') ||
        vpnConfigStatuses.includes('expired') ||
        g.accounts.some((a) => {
          const exp = parseTimestampMs(a?.expires_at ?? a?.expiry_date ?? a?.expiry_time);
          return exp !== null && exp < nowMs;
        }) ||
        g.configs.some((c) => {
          const exp = parseTimestampMs(c?.expires_at ?? c?.expiry_date ?? c?.expiry_time);
          return exp !== null && exp < nowMs;
        });

      const isRejectedOrRevoked =
        vpnAccountStatuses.includes('revoked') ||
        vpnConfigStatuses.includes('revoked') ||
        g.grants.some((gr) => {
          const gst = String(gr?.status || '').trim().toLowerCase();
          return gst === 'revoked' || gst === 'revoke_failed';
        }) ||
        (hasRejectedOrCancelledOrder && !hasAnyOrderApprovedOrActive);

      const missingPanelIdentity =
        g.hasVpnTableRows &&
        g.anyNonDeletedInVpnTables &&
        (g.accounts.some((a) => !a?.deleted_from_panel_at && String(a?.status || '').toLowerCase() !== 'deleted' && !String(a?.panel_identity || '').trim()) ||
          g.configs.some((c) => !c?.deleted_from_panel_at && String(c?.status || '').toLowerCase() !== 'deleted' && !String(c?.panel_identity || '').trim()));

      const panelProvenanceUnverifiedLegacy =
        g.hasVpnTableRows &&
        g.anyNonDeletedInVpnTables &&
        !g.primaryPanelIdentity &&
        !g.primaryServerId;

      const missingInboundId = g.hasVpnTableRows && g.anyNonDeletedInVpnTables && dbInboundIds.length === 0;
      const hasConflictingInboundIds =
        g.distinctInboundIds.size > 1 ||
        (presentInSnap1 &&
          !hasDuplicateLiveUuid &&
          liveInboundIdsSnap1.length === 1 &&
          dbInboundIds.some((id) => id !== liveInboundIdsSnap1[0]));
      const hasConflictingPanelIdentities = g.distinctPanelIdentities.size > 1;

      // Inspect read-only locks for client:<uuid> and every DB inbound:<id>
      const blockingLockKeys: string[] = [];
      let lockStatus: DiagnosticLockStatus = 'none';
      const clientLockKey = `client:${uuid}`;
      const clientLock = lockByKey.get(clientLockKey);
      if (clientLock) {
        const lStatus = String(clientLock.status || '').toLowerCase();
        blockingLockKeys.push(clientLockKey);
        if (lStatus === 'uncertain') {
          lockStatus = 'uncertain_client_lock';
        } else if (lStatus === 'in_progress') {
          lockStatus = 'in_progress_client_lock';
        }
        lockBlocksCountByKey.set(clientLockKey, (lockBlocksCountByKey.get(clientLockKey) || 0) + 1);
      }
      for (const ibId of dbInboundIds) {
        const inboundLockKey = `inbound:${ibId}`;
        const inboundLock = lockByKey.get(inboundLockKey);
        if (inboundLock) {
          const lStatus = String(inboundLock.status || '').toLowerCase();
          blockingLockKeys.push(inboundLockKey);
          if (lockStatus === 'none') {
            lockStatus = lStatus === 'uncertain' ? 'uncertain_inbound_lock' : 'in_progress_inbound_lock';
          }
          lockBlocksCountByKey.set(inboundLockKey, (lockBlocksCountByKey.get(inboundLockKey) || 0) + 1);
        }
      }

      const dbTablesPresent: string[] = [];
      if (g.accounts.length > 0) dbTablesPresent.push('vpn_accounts');
      if (g.configs.length > 0) dbTablesPresent.push('vpn_configs');
      if (g.grants.length > 0) dbTablesPresent.push('vpn_entitlement_grants');
      if (g.orders.length > 0) dbTablesPresent.push('orders');

      const ownerRef =
        g.distinctOwners.size === 1
          ? redactOwnerUid(g.primaryOwnerUid)
          : g.distinctOwners.size > 1
            ? 'conflicting_multiple_owners'
            : 'missing';

      // Determine classification & blocking reasons
      const preCb = preCircuitBreakerEvaluations.get(uuid);
      const allBlockingReasons: string[] = [];
      let classification: DiagnosticClientClassification;

      if (!g.hasVpnTableRows) {
        classification = 'orders_only_untracked';
        summaryCounts.ordersOnlyUntracked += 1;
        allBlockingReasons.push('orders_only_not_in_vpn_tables');
      } else if (!g.anyNonDeletedInVpnTables || g.allDeletedInVpnTables) {
        if (presentInSnap1 || presentInSnap2) {
          // Present live even though DB rows are already marked deleted -> surface as untracked_live_panel_client
          classification = hasDuplicateLiveUuid ? 'live_duplicate_uuid_ambiguous' : 'untracked_live_panel_client';
          if (hasDuplicateLiveUuid) summaryCounts.liveDuplicateUuidAmbiguous += 1;
          else summaryCounts.untrackedLivePanelClients += 1;
          allBlockingReasons.push('already_marked_deleted_in_db_but_present_live');
        } else {
          classification = 'already_marked_deleted_in_db';
          summaryCounts.alreadyMarkedDeletedInDb += 1;
          allBlockingReasons.push('already_marked_deleted_in_db');
        }
      } else if (hasDuplicateLiveUuid) {
        classification = 'live_duplicate_uuid_ambiguous';
        summaryCounts.liveDuplicateUuidAmbiguous += 1;
        allBlockingReasons.push('duplicate_live_uuid_in_panel');
      } else if (!presentInSnap1 && presentInSnap2) {
        classification = 'snapshot_inconsistent_appeared_in_snap2';
        summaryCounts.snapshotInconsistentAppeared += 1;
        allBlockingReasons.push('reappeared_in_snapshot2');
      } else if (presentInSnap1 && !presentInSnap2) {
        classification = 'snapshot_inconsistent_disappeared_in_snap2';
        summaryCounts.snapshotInconsistentDisappeared += 1;
        allBlockingReasons.push('disappeared_between_snapshot1_and_snapshot2');
      } else if (presentInSnap1 && presentInSnap2) {
        if (!setsEqualNumbers(liveInboundIdsSnap1, liveInboundIdsSnap2)) {
          classification = 'snapshot_inconsistent_moved_between_snapshots';
          summaryCounts.snapshotInconsistentMoved += 1;
          allBlockingReasons.push('moved_between_snapshot1_and_snapshot2');
        } else if (
          liveInboundIdsSnap1.length === 1 &&
          dbInboundIds.some((id) => id !== liveInboundIdsSnap1[0])
        ) {
          classification = 'moved_client';
          summaryCounts.movedClients += 1;
          allBlockingReasons.push('live_client_inbound_mismatch');
        } else if (hasConflictingDbStatuses) {
          classification = 'live_matched_status_conflict';
          summaryCounts.liveMatchedStatusConflict += 1;
          allBlockingReasons.push('present_in_live_panel');
        } else {
          classification = 'live_matched';
          summaryCounts.liveMatchedHealthy += 1;
          allBlockingReasons.push('present_in_live_panel');
        }
      } else {
        // Absent in BOTH clean Snapshot 1 and clean Snapshot 2 (NEVER labeled permanently deleted!)
        classification = 'absent_two_snapshots_unconfirmed';

        if (!panelDeletionSyncEnabled) {
          allBlockingReasons.push('feature_flag_disabled');
        }
        if (preCb) {
          for (const r of preCb.preCbBlockReasons) {
            if (!allBlockingReasons.includes(r)) allBlockingReasons.push(r);
          }
        }
        if (referencesRemovedHistoricalInbound) {
          allBlockingReasons.push('historical_inbound_absent_from_panel');
        }
        if (preCb?.wouldPassPreCb) {
          for (const cbReason of allTriggeredCbReasons) {
            allBlockingReasons.push(`circuit_breaker:${cbReason}`);
          }
          if (lockStatus !== 'none') {
            allBlockingReasons.push(lockStatus);
            summaryCounts.deletionWorkerBlockedByLocks += 1;
          }
        } else {
          summaryCounts.deletionWorkerBlockedBeforeCircuitBreaker += 1;
          if (lockStatus !== 'none') {
            allBlockingReasons.push(lockStatus);
          }
        }

        for (const r of allBlockingReasons) {
          bumpBlockCount(r);
        }
      }

      // Accumulate diagnostic flag totals across tracked non-deleted DB records
      if (g.hasVpnTableRows && g.anyNonDeletedInVpnTables) {
        if (isHistoricalTrial) summaryCounts.flags.historicalTrials += 1;
        if (isExpiredAccount) summaryCounts.flags.expiredAccounts += 1;
        if (isRejectedOrRevoked) summaryCounts.flags.rejectedOrRevokedAccounts += 1;
        if (hasConflictingDbStatuses) summaryCounts.flags.conflictingDbStatuses += 1;
        if (liveVsDbEnableMismatch) summaryCounts.flags.liveVsDbEnableMismatch += 1;
        if (g.hasConflictingOwnership) summaryCounts.flags.conflictingOwnership += 1;
        if (g.hasMissingOwnership) summaryCounts.flags.missingOwnership += 1;
        if (hasConflictingInboundIds) summaryCounts.flags.conflictingInboundIds += 1;
        if (hasConflictingPanelIdentities) summaryCounts.flags.conflictingPanelIdentities += 1;
        if (missingPanelIdentity) summaryCounts.flags.missingPanelIdentity += 1;
        if (panelProvenanceUnverifiedLegacy) summaryCounts.flags.panelProvenanceUnverifiedLegacy += 1;
        if (missingInboundId) summaryCounts.flags.missingInboundId += 1;
        if (referencesRemovedHistoricalInbound) summaryCounts.flags.referencesRemovedHistoricalInbound += 1;
        if (lockStatus === 'uncertain_client_lock') summaryCounts.flags.uncertainClientLocks += 1;
        if (lockStatus === 'uncertain_inbound_lock') summaryCounts.flags.uncertainInboundLocks += 1;
        if (lockStatus === 'in_progress_client_lock' || lockStatus === 'in_progress_inbound_lock') {
          summaryCounts.flags.activeInProgressLocks += 1;
        }
      }

      // Determine primary deterministic block reason for absent candidates
      let primaryBlockReason = allBlockingReasons[0] || 'none';
      if (classification === 'absent_two_snapshots_unconfirmed') {
        if (preCb && !preCb.wouldPassPreCb && preCb.preCbBlockReasons.length > 0) {
          primaryBlockReason = preCb.preCbBlockReasons[0];
        } else if (primaryCbReason) {
          primaryBlockReason = `circuit_breaker:${primaryCbReason}`;
        } else if (lockStatus !== 'none') {
          primaryBlockReason = lockStatus;
        } else if (!panelDeletionSyncEnabled) {
          primaryBlockReason = 'feature_flag_disabled';
        } else {
          primaryBlockReason = 'eligible_pending_audited_review';
        }
      }

      clientRows.push({
        clientUuid: uuid,
        classification,
        presentInSnap1,
        presentInSnap2,
        liveInboundIdsSnap1,
        liveInboundIdsSnap2,
        liveInboundRemark,
        liveClientEnabled,
        hasDuplicateLiveUuid,
        hasDuplicateAcrossDifferentInbounds,
        dbInboundIds,
        referencesRemovedHistoricalInbound,
        vpnAccountStatuses,
        vpnConfigStatuses,
        orderStatuses,
        hasConflictingDbStatuses,
        statusConflictReasons,
        liveVsDbEnableMismatch,
        isHistoricalTrial,
        isExpiredAccount,
        isRejectedOrRevoked,
        ownerRef,
        distinctOwnerCount: g.distinctOwners.size,
        hasConflictingOwnership: g.hasConflictingOwnership,
        hasMissingOwnership: g.hasMissingOwnership,
        hasConflictingInboundIds,
        hasConflictingPanelIdentities,
        missingPanelIdentity,
        panelProvenanceUnverifiedLegacy,
        missingInboundId,
        panelIdentityCheckCode: preCb?.panelIdentityCheckCode || 'not_evaluated',
        lockStatus,
        blockingLockKeys,
        wouldPassPreCircuitBreakerGates: Boolean(preCb?.wouldPassPreCb),
        primaryBlockReason,
        allBlockingReasons,
        dbTablesPresent,
        latestVpnCreatedAt: g.latestVpnCreatedAt,
        latestOrderCreatedAt: g.latestOrderCreatedAt,
        latestCreatedAt: g.latestCreatedAt,
      });
    }

    // Sort client rows deterministically
    clientRows.sort((a, b) => {
      if (a.classification !== b.classification) {
        return a.classification.localeCompare(b.classification);
      }
      return a.clientUuid.localeCompare(b.clientUuid);
    });

    // Build live & historical missing inbound summaries
    const liveInbounds: DiagnosticLiveInboundSummary[] = Array.from(snap1Parsed.inboundsById.values())
      .sort((a, b) => a.inboundId - b.inboundId)
      .map((ib) => ({
        inboundId: ib.inboundId,
        remark: ib.remark,
        port: ib.port,
        liveClientCount: ib.liveClientCount,
        uniqueLiveUuidCount: ib.uniqueLiveUuidCount,
        dbReferencedUuidCount: dbRefCountByInboundId.get(ib.inboundId) || 0,
      }));

    const historicalMissingInbounds: DiagnosticHistoricalInboundSummary[] = Array.from(
      dbRefCountByInboundId.entries()
    )
      .filter(([ibId]) => !liveInboundIdsSet.has(ibId))
      .sort((a, b) => a[0] - b[0])
      .map(([inboundId, dbReferencedUuidCount]) => ({
        inboundId,
        dbReferencedUuidCount,
        presentInLivePanel: false,
      }));

    // Build active & uncertain locks summary (redacted — zero metadata/error_message)
    const activeAndUncertainLocks: DiagnosticUncertainLockSummary[] = activeLocks
      .map((lk) => {
        const opKey = String(lk?.operation_key || '').trim();
        const opKeyLower = opKey.toLowerCase();
        const scope: 'client' | 'inbound' | 'other' = opKeyLower.startsWith('client:')
          ? 'client'
          : opKeyLower.startsWith('inbound:')
            ? 'inbound'
            : 'other';
        const clientUuid =
          scope === 'client'
            ? opKeyLower.slice('client:'.length)
            : lk?.client_uuid
              ? String(lk.client_uuid).trim().toLowerCase()
              : null;
        const parsedIb =
          scope === 'inbound' ? Number(opKeyLower.slice('inbound:'.length)) : NaN;
        const inboundId = Number.isInteger(parsedIb) && parsedIb > 0 ? parsedIb : null;
        const st =
          String(lk?.status || '').toLowerCase() === 'uncertain' ? 'uncertain' : 'in_progress';
        return {
          operationKey: opKey,
          scope,
          status: st as 'uncertain' | 'in_progress',
          operationType: String(lk?.operation_type || 'unknown'),
          clientUuid,
          inboundId,
          createdAt: lk?.created_at ? String(lk.created_at) : null,
          updatedAt: lk?.updated_at ? String(lk.updated_at) : null,
          uncertainAt: lk?.uncertain_at ? String(lk.uncertain_at) : null,
          leaseExpiresAt: lk?.lease_expires_at ? String(lk.lease_expires_at) : null,
          blocksTrackedUuidsCount: lockBlocksCountByKey.get(opKeyLower) || 0,
        };
      })
      .sort((a, b) => a.operationKey.localeCompare(b.operationKey));

    // --------------------------------------------------------------------------
    // STEP 6: Optional, Opt-In Direct Inbound Probes (max concurrency = 2)
    //         Skipped automatically if not requested or insufficient budget remains.
    // --------------------------------------------------------------------------
    const directProbeSection: SyncDiagnosticsReport['directInboundVerificationProbe'] = {
      optInRequested: includeDirectProbe,
      executed: false,
      skippedReason: includeDirectProbe ? null : 'opt_in_disabled_by_default',
      maxConcurrency: MAX_DIRECT_PROBE_CONCURRENCY,
      customerBudgetMs: CUSTOMER_LIVE_INBOUND_BUDGET_MS,
      probedCount: 0,
      directSucceededCount: 0,
      directFailedOrEmptyCount: 0,
      directTimedOutCount: 0,
      directSkippedBudgetCount: 0,
      wouldBreakCustomerPromiseAll: null,
      knownTelemetryNote:
        "vpnController.ts:29 and clientController.ts:30 hardcode '3X-UI Time: 0ms'; actual 3X-UI latency is included inside Database Time.",
      inbounds: [],
    };

    if (includeDirectProbe) {
      const minBudgetForDirectProbesMs = Math.min(2000, Math.floor(totalBudgetMs * 0.25));
      const remainingBeforeProbes = deadlineMs - Date.now() - serializationReserveMs;

      if (controller.signal.aborted || remainingBeforeProbes < minBudgetForDirectProbesMs) {
        directProbeSection.skippedReason = externallyCancelled
          ? 'diagnostic_aborted'
          : 'insufficient_remaining_budget';
      } else {
        // Prioritize historical missing inbounds (e.g. ID 7) + live inbounds, capped at MAX_DIRECT_PROBE_INBOUNDS
        const targetInboundIds: number[] = [];
        for (const hist of historicalMissingInbounds) {
          if (targetInboundIds.length < MAX_DIRECT_PROBE_INBOUNDS) {
            targetInboundIds.push(hist.inboundId);
          }
        }
        for (const live of liveInbounds) {
          if (
            targetInboundIds.length < MAX_DIRECT_PROBE_INBOUNDS &&
            !targetInboundIds.includes(live.inboundId)
          ) {
            targetInboundIds.push(live.inboundId);
          }
        }

        directProbeSection.executed = true;
        directProbeSection.skippedReason = null;

        const probeEntries = await runBoundedConcurrency<number, DiagnosticDirectProbeEntry>(
          targetInboundIds,
          MAX_DIRECT_PROBE_CONCURRENCY,
          async (inboundId) => {
            const fullListInfo = snap1Parsed.inboundsById.get(inboundId);
            const presentInFullList = Boolean(fullListInfo);
            const fullListClientCount = fullListInfo ? fullListInfo.liveClientCount : null;

            const remainingNow = deadlineMs - Date.now() - serializationReserveMs;
            if (controller.signal.aborted || remainingNow < 200) {
              return {
                inboundId,
                presentInFullList,
                fullListClientCount,
                directGetOutcome: 'skipped_budget',
                directGetLatencyMs: null,
                httpStatus: null,
                directGetHasObj: false,
                directGetClientCount: null,
                matchesFullListClientCount: null,
                errorCode: null,
              };
            }

            const probeTimeoutMs = Math.min(CUSTOMER_LIVE_INBOUND_BUDGET_MS, Math.max(200, remainingNow));
            try {
              const probeRes = await probeInboundFn(inboundId, {
                timeoutMs: probeTimeoutMs,
                signal: controller.signal,
                dbClient,
                sessionState: diagnosticSessionState,
              });
              const matchesCount =
                presentInFullList &&
                probeRes.outcome === 'ok_valid_inbound' &&
                probeRes.clientCount !== null
                  ? probeRes.clientCount === fullListClientCount
                  : null;
              return {
                inboundId,
                presentInFullList,
                fullListClientCount,
                directGetOutcome: probeRes.outcome,
                directGetLatencyMs: probeRes.latencyMs,
                httpStatus: probeRes.httpStatus,
                directGetHasObj: probeRes.hasObj,
                directGetClientCount: probeRes.clientCount,
                matchesFullListClientCount: matchesCount,
                errorCode: probeRes.errorCode,
              };
            } catch {
              return {
                inboundId,
                presentInFullList,
                fullListClientCount,
                directGetOutcome: controller.signal.aborted ? 'aborted' : 'network_error',
                directGetLatencyMs: null,
                httpStatus: null,
                directGetHasObj: false,
                directGetClientCount: null,
                matchesFullListClientCount: null,
                errorCode: controller.signal.aborted ? 'diagnostic_aborted' : 'panel_network_error',
              };
            }
          }
        );

        probeEntries.sort((a, b) => a.inboundId - b.inboundId);
        directProbeSection.inbounds = probeEntries;
        directProbeSection.probedCount = probeEntries.filter(
          (e) => e.directGetOutcome !== 'skipped_budget'
        ).length;
        directProbeSection.directSucceededCount = probeEntries.filter(
          (e) => e.directGetOutcome === 'ok_valid_inbound'
        ).length;
        directProbeSection.directTimedOutCount = probeEntries.filter(
          (e) => e.directGetOutcome === 'timeout'
        ).length;
        directProbeSection.directSkippedBudgetCount = probeEntries.filter(
          (e) => e.directGetOutcome === 'skipped_budget'
        ).length;
        directProbeSection.directFailedOrEmptyCount = probeEntries.filter(
          (e) =>
            e.directGetOutcome !== 'ok_valid_inbound' &&
            e.directGetOutcome !== 'skipped_budget'
        ).length;
        directProbeSection.wouldBreakCustomerPromiseAll = probeEntries.some(
          (e) =>
            e.directGetOutcome === 'timeout' ||
            e.directGetOutcome === 'http_200_null_or_empty_obj' ||
            e.directGetOutcome === 'malformed_settings_clients' ||
            e.directGetOutcome === 'http_4xx' ||
            e.directGetOutcome === 'http_5xx' ||
            e.directGetOutcome === 'network_error' ||
            (e.directGetLatencyMs !== null && e.directGetLatencyMs >= CUSTOMER_LIVE_INBOUND_BUDGET_MS)
        );
      }
    }

    if (controller.signal.aborted) {
      return buildAbortedReport(
        externallyCancelled ? 'diagnostic_aborted' : 'diagnostic_deadline_exceeded'
      );
    }

    const executionMs = Math.max(0, Date.now() - startedAtMs);

    return {
      success: true,
      readOnly: true,
      aborted: false,
      abortReason: null,
      generatedAt,
      executionMs,
      budget: {
        totalBudgetMs,
        remainingBudgetMs: Math.max(0, deadlineMs - Date.now()),
        deadlineExceeded,
        cancelled: externallyCancelled,
      },
      runtimeLimits: {
        mutexScope: 'per_instance_in_memory',
        rateLimitScope: 'per_instance_in_memory',
        directProbeOptIn: includeDirectProbe,
        maxDirectProbeConcurrency: MAX_DIRECT_PROBE_CONCURRENCY,
        note: 'In-process mutex and rate limiting are enforced per backend instance and are not distributed across multiple replicas.',
      },
      panel: {
        panelIdentity: resolvedPanelIdentity,
        connectionMode:
          configuredServersCount > 0 ? 'configured_servers_present' : 'env_single_panel',
        configuredXuiServersCount: configuredServersCount,
        panelProvenanceNote:
          configuredServersCount === 0
            ? 'xui_servers is empty; verifyRecordPanelIdentity permits legacy rows without panel_identity under single-panel fallback (matched_single_panel_legacy), which does NOT independently prove historical records originated on the current panel.'
            : `${configuredServersCount} xui_servers record(s) configured; legacy rows without panel_identity require manual panel provenance verification.`,
        panelDeletionSyncEnabled,
        snapshots: snapshotMeta,
      },
      schemaCompatibility: {
        vpnConfigsOwnershipColumn: 'customer_uid',
        vpnAccountsHasInboundId: false,
        missingOptionalColumnsByTable,
        optionalTablesMissing,
      },
      liveInbounds,
      historicalMissingInbounds,
      summary: {
        uniqueDbTrackedNonDeleted: totalTrackedNonDeleted,
        uniqueDbAllIncludingDeletedAndOrders: groups.size,
        livePanelUniqueClientsSnap1: snap1Parsed.uniqueLiveUuidCount,
        livePanelUniqueClientsSnap2: snap2Parsed.uniqueLiveUuidCount,
        liveMatchedHealthy: summaryCounts.liveMatchedHealthy,
        liveMatchedStatusConflict: summaryCounts.liveMatchedStatusConflict,
        liveDuplicateUuidAmbiguous: summaryCounts.liveDuplicateUuidAmbiguous,
        movedClients: summaryCounts.movedClients,
        snapshotInconsistentAppeared: summaryCounts.snapshotInconsistentAppeared,
        snapshotInconsistentDisappeared: summaryCounts.snapshotInconsistentDisappeared,
        snapshotInconsistentMoved: summaryCounts.snapshotInconsistentMoved,
        rawAbsentFromSnap1,
        rawAbsentBothSnapshots,
        deletionWorkerEligibleCandidates: eligibleCandidateCount,
        deletionWorkerBlockedBeforeCircuitBreaker: summaryCounts.deletionWorkerBlockedBeforeCircuitBreaker,
        deletionWorkerBlockedByLocks: summaryCounts.deletionWorkerBlockedByLocks,
        alreadyMarkedDeletedInDb: summaryCounts.alreadyMarkedDeletedInDb,
        ordersOnlyUntracked: summaryCounts.ordersOnlyUntracked,
        untrackedLivePanelClients: summaryCounts.untrackedLivePanelClients,
        flags: summaryCounts.flags,
        blockingReasonCounts,
      },
      circuitBreakerEvaluation: {
        evaluated: true,
        wouldTrigger: circuitBreakerWouldTrigger,
        primaryReason: primaryCbReason,
        allTriggeredReasons: allTriggeredCbReasons,
        eligibleCandidateCount,
        rawAbsentBothSnapshotsCount: rawAbsentBothSnapshots,
        totalTrackedNonDeleted,
        missingRatio,
        maxDeletesPerCycle,
        maxMissingRatio,
      },
      activeAndUncertainLocks,
      directInboundVerificationProbe: directProbeSection,
      clients: clientRows,
    };
  } finally {
    clearTimeout(deadlineTimer);
    if (options?.signal) {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

// ==============================================================================
// CSV SERIALIZER (RFC-4180 + FORMULA INJECTION SAFE, ZERO PII / SECRETS)
// ==============================================================================

export const SYNC_DIAGNOSTICS_CSV_HEADERS = [
  'client_uuid',
  'classification',
  'present_in_snap1',
  'present_in_snap2',
  'live_inbound_ids_snap1',
  'live_inbound_ids_snap2',
  'live_inbound_remark',
  'live_client_enabled',
  'has_duplicate_live_uuid',
  'has_duplicate_across_different_inbounds',
  'db_inbound_ids',
  'references_removed_historical_inbound',
  'vpn_account_statuses',
  'vpn_config_statuses',
  'order_statuses',
  'has_conflicting_db_statuses',
  'status_conflict_reasons',
  'live_vs_db_enable_mismatch',
  'is_historical_trial',
  'is_expired_account',
  'is_rejected_or_revoked',
  'owner_ref',
  'distinct_owner_count',
  'has_conflicting_ownership',
  'has_missing_ownership',
  'has_conflicting_inbound_ids',
  'has_conflicting_panel_identities',
  'missing_panel_identity',
  'panel_provenance_unverified_legacy',
  'missing_inbound_id',
  'panel_identity_check_code',
  'lock_status',
  'blocking_lock_keys',
  'would_pass_pre_circuit_breaker_gates',
  'primary_block_reason',
  'all_blocking_reasons',
  'db_tables_present',
  'latest_vpn_created_at',
  'latest_order_created_at',
  'latest_created_at',
] as const;

export function formatSyncDiagnosticsCsv(report: SyncDiagnosticsReport): string {
  const lines: string[] = [];
  lines.push(SYNC_DIAGNOSTICS_CSV_HEADERS.map((h) => sanitizeCsvCell(h)).join(','));

  for (const row of report.clients) {
    const cells: unknown[] = [
      row.clientUuid,
      row.classification,
      row.presentInSnap1,
      row.presentInSnap2 === null ? 'not_run' : row.presentInSnap2,
      row.liveInboundIdsSnap1.join('|'),
      row.liveInboundIdsSnap2.join('|'),
      row.liveInboundRemark ?? '',
      row.liveClientEnabled === null ? '' : row.liveClientEnabled,
      row.hasDuplicateLiveUuid,
      row.hasDuplicateAcrossDifferentInbounds,
      row.dbInboundIds.join('|'),
      row.referencesRemovedHistoricalInbound,
      row.vpnAccountStatuses.join('|'),
      row.vpnConfigStatuses.join('|'),
      row.orderStatuses.join('|'),
      row.hasConflictingDbStatuses,
      row.statusConflictReasons.join('|'),
      row.liveVsDbEnableMismatch,
      row.isHistoricalTrial,
      row.isExpiredAccount,
      row.isRejectedOrRevoked,
      row.ownerRef,
      row.distinctOwnerCount,
      row.hasConflictingOwnership,
      row.hasMissingOwnership,
      row.hasConflictingInboundIds,
      row.hasConflictingPanelIdentities,
      row.missingPanelIdentity,
      row.panelProvenanceUnverifiedLegacy,
      row.missingInboundId,
      row.panelIdentityCheckCode,
      row.lockStatus,
      row.blockingLockKeys.join('|'),
      row.wouldPassPreCircuitBreakerGates,
      row.primaryBlockReason,
      row.allBlockingReasons.join('|'),
      row.dbTablesPresent.join('|'),
      row.latestVpnCreatedAt ?? '',
      row.latestOrderCreatedAt ?? '',
      row.latestCreatedAt ?? '',
    ];
    lines.push(cells.map((c) => sanitizeCsvCell(c)).join(','));
  }

  return `${lines.join('\r\n')}\r\n`;
}
