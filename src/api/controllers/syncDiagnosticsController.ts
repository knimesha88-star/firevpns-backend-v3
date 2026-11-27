import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import {
  DEFAULT_DIAGNOSTIC_BUDGET_MS,
  formatSyncDiagnosticsCsv,
  runReadOnlySyncDiagnostics,
  type RunSyncDiagnosticsOptions,
  type SyncDiagnosticsReport,
} from '../services/syncDiagnosticsService.js';

export interface SyncDiagnosticsControllerDeps {
  runDiagnosticsFn?: (options?: RunSyncDiagnosticsOptions) => Promise<SyncDiagnosticsReport>;
  defaultBudgetMs?: number;
}

function parseBooleanQueryParam(
  raw: unknown
): { ok: true; value: boolean } | { ok: false } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: false };
  }
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return { ok: true, value: true };
  }
  if (normalized === 'false' || normalized === '0') {
    return { ok: true, value: false };
  }
  return { ok: false };
}

function parseFormatQueryParam(
  raw: unknown,
  defaultFormat: 'json' | 'csv'
): { ok: true; value: 'json' | 'csv' } | { ok: false } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: defaultFormat };
  }
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'json' || normalized === 'csv') {
    return { ok: true, value: normalized };
  }
  return { ok: false };
}

function buildSafeCsvFilename(generatedAtIso: string): string {
  const safeStamp = String(generatedAtIso || new Date().toISOString())
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[^A-Za-z0-9TZ]/g, '');
  return `firevpns-sync-diagnostics-${safeStamp || 'report'}.csv`;
}

function setNoStoreDiagnosticHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Diagnostics-Read-Only', 'true');
}

/**
 * Factory creating per-instance single-flight read-only synchronization diagnostic handlers.
 * NOTE: The single-flight mutex is enforced in-memory per backend instance (not distributed).
 * The mutex is held until the underlying diagnostic promise completely settles, even if
 * the client disconnects or the HTTP timeout fires early.
 */
export function createSyncDiagnosticsHandlers(deps?: SyncDiagnosticsControllerDeps) {
  const runDiagnostics = deps?.runDiagnosticsFn ?? runReadOnlySyncDiagnostics;
  const defaultBudgetMs = deps?.defaultBudgetMs ?? DEFAULT_DIAGNOSTIC_BUDGET_MS;

  let activeDiagnosticPromise: Promise<SyncDiagnosticsReport> | null = null;

  const isDiagnosticRunActive = (): boolean => activeDiagnosticPromise !== null;

  const handleRequest = async (
    req: AuthRequest,
    res: Response,
    defaultFormat: 'json' | 'csv'
  ): Promise<void> => {
    setNoStoreDiagnosticHeaders(res);

    const directProbeParam = parseBooleanQueryParam(req.query?.includeDirectProbe);
    if (!directProbeParam.ok) {
      res.status(400).json({
        success: false,
        readOnly: true,
        aborted: true,
        errorCode: 'invalid_query_parameter',
        error: 'Invalid includeDirectProbe parameter. Expected true or false.',
      });
      return;
    }

    const formatParam = parseFormatQueryParam(req.query?.format, defaultFormat);
    if (!formatParam.ok) {
      res.status(400).json({
        success: false,
        readOnly: true,
        aborted: true,
        errorCode: 'invalid_query_parameter',
        error: 'Invalid format parameter. Expected json or csv.',
      });
      return;
    }

    if (activeDiagnosticPromise !== null) {
      res.status(409).json({
        success: false,
        readOnly: true,
        aborted: true,
        errorCode: 'diagnostic_already_running',
        error:
          'A read-only synchronization diagnostic scan is already running on this backend instance. Please retry after it completes.',
      });
      return;
    }

    const requestAbortController = new AbortController();
    const serverTimeoutSignal: AbortSignal | undefined = (req as any).timeoutSignal;

    // Respect remaining outer request budget when outer request timing metadata is present,
    // without modifying server.ts. Also always subscribe to server.ts's req.timeoutSignal.
    const OUTER_SERIALIZATION_SAFETY_MARGIN_MS = 1000;
    const DEFAULT_OUTER_API_TIMEOUT_MS = 25_000;
    let effectiveBudgetMs = defaultBudgetMs;
    const rawDeadlineMs = Number((req as any).requestDeadlineMs);
    const rawStartedAtMs = Number((req as any).requestStartedAt);
    if (Number.isFinite(rawDeadlineMs) && rawDeadlineMs > 0) {
      const remainingOuterMs = rawDeadlineMs - Date.now() - OUTER_SERIALIZATION_SAFETY_MARGIN_MS;
      if (remainingOuterMs <= 0) {
        res.status(504).json({
          success: false,
          readOnly: true,
          aborted: true,
          errorCode: 'diagnostic_deadline_exceeded',
          error: 'Insufficient remaining request budget to execute read-only synchronization diagnostics.',
        });
        return;
      }
      effectiveBudgetMs = Math.min(defaultBudgetMs, Math.max(300, Math.floor(remainingOuterMs)));
    } else if (Number.isFinite(rawStartedAtMs) && rawStartedAtMs > 0) {
      const remainingOuterMs =
        rawStartedAtMs + DEFAULT_OUTER_API_TIMEOUT_MS - Date.now() - OUTER_SERIALIZATION_SAFETY_MARGIN_MS;
      if (remainingOuterMs <= 0) {
        res.status(504).json({
          success: false,
          readOnly: true,
          aborted: true,
          errorCode: 'diagnostic_deadline_exceeded',
          error: 'Insufficient remaining request budget to execute read-only synchronization diagnostics.',
        });
        return;
      }
      effectiveBudgetMs = Math.min(defaultBudgetMs, Math.max(300, Math.floor(remainingOuterMs)));
    }

    const onServerTimeoutAbort = () => {
      if (!requestAbortController.signal.aborted) {
        requestAbortController.abort(new Error('diagnostic_deadline_exceeded'));
      }
    };

    const onResponseClose = () => {
      if (!res.writableEnded && !requestAbortController.signal.aborted) {
        requestAbortController.abort(new Error('diagnostic_aborted'));
      }
    };

    if (serverTimeoutSignal) {
      if (serverTimeoutSignal.aborted) {
        onServerTimeoutAbort();
      } else {
        serverTimeoutSignal.addEventListener('abort', onServerTimeoutAbort, { once: true });
      }
    }
    res.on('close', onResponseClose);

    const runPromise = runDiagnostics({
      includeDirectProbe: directProbeParam.value,
      totalBudgetMs: effectiveBudgetMs,
      signal: requestAbortController.signal,
    });

    activeDiagnosticPromise = runPromise;

    // Guarantee the mutex is released ONLY after the underlying diagnostic work fully settles
    runPromise
      .catch(() => {
        // Handled below; prevent unhandled rejection if caller disconnected early
      })
      .finally(() => {
        if (activeDiagnosticPromise === runPromise) {
          activeDiagnosticPromise = null;
        }
        if (serverTimeoutSignal) {
          serverTimeoutSignal.removeEventListener('abort', onServerTimeoutAbort);
        }
        res.removeListener('close', onResponseClose);
      });

    try {
      const report = await runPromise;

      if (res.headersSent || res.writableEnded) {
        return;
      }

      if (report.aborted || !report.success) {
        const statusCode =
          report.abortReason === 'diagnostic_deadline_exceeded' ? 504 : 503;
        res.status(statusCode).json({
          success: false,
          readOnly: true,
          aborted: true,
          errorCode: report.abortReason || 'diagnostic_aborted',
          report,
        });
        return;
      }

      if (formatParam.value === 'csv') {
        const csvBody = formatSyncDiagnosticsCsv(report);
        if (res.headersSent || res.writableEnded) {
          return;
        }
        const filename = buildSafeCsvFilename(report.generatedAt);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.status(200).send(csvBody);
        return;
      }

      res.status(200).json(report);
    } catch {
      if (!res.headersSent && !res.writableEnded) {
        res.status(503).json({
          success: false,
          readOnly: true,
          aborted: true,
          errorCode: 'diagnostic_execution_failed',
          error: 'Read-only synchronization diagnostics failed safely with zero modifications.',
        });
      }
    }
  };

  return {
    getSyncDiagnosticsHandler: (req: AuthRequest, res: Response) =>
      handleRequest(req, res, 'json'),
    getSyncDiagnosticsCsvHandler: (req: AuthRequest, res: Response) =>
      handleRequest(req, res, 'csv'),
    isDiagnosticRunActive,
  };
}

const defaultHandlers = createSyncDiagnosticsHandlers();

export const getSyncDiagnosticsHandler = defaultHandlers.getSyncDiagnosticsHandler;
export const getSyncDiagnosticsCsvHandler = defaultHandlers.getSyncDiagnosticsCsvHandler;
export const isSyncDiagnosticsRunActive = defaultHandlers.isDiagnosticRunActive;
