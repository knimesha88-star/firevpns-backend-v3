import crypto from 'crypto';
import { supabase, supabaseAdmin, getSupabaseClient } from '../../lib/supabase.js';

export const PAYMENT_SLIPS_BUCKET = 'payment-slips';
const FALLBACK_BUCKETS = ['payment-slips', 'payment_slips'];

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'application/pdf',
];

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB

let bucketEnsureAttempted = false;

export interface ParsedSlipReference {
  kind: 'data' | 'storage' | 'external' | 'empty';
  bucket: string;
  objectPath: string;
  rawInput: string;
  isPdf: boolean;
}

/**
 * Ensures the private `payment-slips` bucket exists when a service-role key is available.
 * Never sets the bucket to public.
 */
export async function ensurePaymentSlipsBucketExists(): Promise<void> {
  if (bucketEnsureAttempted) return;
  const hasServiceRoleKey = Boolean(
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );
  if (!hasServiceRoleKey) {
    return;
  }

  bucketEnsureAttempted = true;
  try {
    const { data: existingBucket, error: getErr } = await supabaseAdmin.storage.getBucket(
      PAYMENT_SLIPS_BUCKET
    );

    if (!existingBucket && getErr) {
      const { error: createErr } = await supabaseAdmin.storage.createBucket(
        PAYMENT_SLIPS_BUCKET,
        {
          public: false,
          fileSizeLimit: MAX_FILE_SIZE_BYTES,
          allowedMimeTypes: ALLOWED_MIME_TYPES,
        }
      );
      if (createErr && !String(createErr.message || '').toLowerCase().includes('already exists')) {
        console.warn('[PaymentSlipService] Could not auto-create payment-slips bucket:', createErr.message);
      } else {
        console.log('[PaymentSlipService] Verified private bucket:', PAYMENT_SLIPS_BUCKET);
      }
    } else if (existingBucket && existingBucket.public) {
      // Security requirement: keep payment slips private
      await supabaseAdmin.storage.updateBucket(PAYMENT_SLIPS_BUCKET, {
        public: false,
        fileSizeLimit: MAX_FILE_SIZE_BYTES,
        allowedMimeTypes: ALLOWED_MIME_TYPES,
      });
    }
  } catch (err: any) {
    console.warn('[PaymentSlipService] Bucket verification note:', err?.message || err);
  }
}

/**
 * Parses any stored `slip_url` or file path format into a normalized bucket + objectPath.
 * Supports:
 * - data:image/...;base64,... or data:application/pdf;base64,...
 * - https://<project>.supabase.co/storage/v1/object/public/payment-slips/<path>
 * - https://<project>.supabase.co/storage/v1/object/sign/payment-slips/<path>?token=...
 * - https://<project>.supabase.co/storage/v1/object/authenticated/payment-slips/<path>
 * - payment-slips/orders/... or orders/... or renewals/... or billing/...
 */
export function parsePaymentSlipReference(rawInput: string | null | undefined): ParsedSlipReference {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) {
    return {
      kind: 'empty',
      bucket: PAYMENT_SLIPS_BUCKET,
      objectPath: '',
      rawInput: '',
      isPdf: false,
    };
  }

  if (trimmed.startsWith('data:')) {
    const isPdf = trimmed.startsWith('data:application/pdf');
    return {
      kind: 'data',
      bucket: PAYMENT_SLIPS_BUCKET,
      objectPath: '',
      rawInput: trimmed,
      isPdf,
    };
  }

  const checkIsPdf = (val: string) => {
    const clean = val.split('?')[0].split('#')[0].toLowerCase();
    return clean.endsWith('.pdf');
  };

  // Match Supabase Storage URLs:
  // /storage/v1/object/(public|sign|authenticated)/<bucket>/<objectPath>
  const storageRegex = /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/?#]+)\/([^?#]+)/i;
  const storageMatch = trimmed.match(storageRegex);
  if (storageMatch) {
    const bucket = decodeURIComponent(storageMatch[1]);
    const objectPath = decodeURIComponent(storageMatch[2]).replace(/^\/+/, '');
    return {
      kind: 'storage',
      bucket: bucket || PAYMENT_SLIPS_BUCKET,
      objectPath,
      rawInput: trimmed,
      isPdf: checkIsPdf(objectPath),
    };
  }

  // Also match /storage/v1/render/image/(public|sign|authenticated)/<bucket>/<objectPath>
  const renderRegex = /\/storage\/v1\/render\/image\/(?:public|sign|authenticated)\/([^/?#]+)\/([^?#]+)/i;
  const renderMatch = trimmed.match(renderRegex);
  if (renderMatch) {
    const bucket = decodeURIComponent(renderMatch[1]);
    const objectPath = decodeURIComponent(renderMatch[2]).replace(/^\/+/, '');
    return {
      kind: 'storage',
      bucket: bucket || PAYMENT_SLIPS_BUCKET,
      objectPath,
      rawInput: trimmed,
      isPdf: checkIsPdf(objectPath),
    };
  }

  // If it's another http(s) URL that isn't a Supabase Storage object path
  if (/^https?:\/\//i.test(trimmed)) {
    return {
      kind: 'external',
      bucket: PAYMENT_SLIPS_BUCKET,
      objectPath: '',
      rawInput: trimmed,
      isPdf: checkIsPdf(trimmed),
    };
  }

  // Otherwise treat as a storage path: e.g. "payment-slips/orders/..." or "orders/..." or "renewals/..." or "billing/..."
  let normalizedPath = trimmed.replace(/^\/+/, '');
  let bucket = PAYMENT_SLIPS_BUCKET;

  for (const candidateBucket of FALLBACK_BUCKETS) {
    if (normalizedPath.startsWith(`${candidateBucket}/`)) {
      bucket = candidateBucket;
      normalizedPath = normalizedPath.slice(candidateBucket.length + 1);
      break;
    }
  }

  try {
    normalizedPath = decodeURIComponent(normalizedPath);
  } catch (_e) {
    // Keep as-is if already decoded
  }

  // Reject path traversal or null-byte sequences
  if (
    normalizedPath.includes('..') ||
    normalizedPath.includes('\\') ||
    normalizedPath.includes('\0')
  ) {
    return {
      kind: 'empty',
      bucket: PAYMENT_SLIPS_BUCKET,
      objectPath: '',
      rawInput: trimmed,
      isPdf: false,
    };
  }

  return {
    kind: 'storage',
    bucket,
    objectPath: normalizedPath,
    rawInput: trimmed,
    isPdf: checkIsPdf(normalizedPath),
  };
}

/**
 * Checks whether a user is an admin strictly via database role (`profiles`, `user_roles`, or `users`).
 */
export async function checkIsUserAdmin(userUid?: string, _userEmail?: string): Promise<boolean> {
  if (!userUid) return false;

  try {
    const { data: profileData } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userUid)
      .maybeSingle();

    if (profileData?.role === 'admin' || profileData?.role === 'super_admin') {
      return true;
    }

    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userUid)
      .maybeSingle();

    if (roleData?.role === 'admin' || roleData?.role === 'super_admin') {
      return true;
    }

    const { data: userData } = await supabase
      .from('users')
      .select('role')
      .or(`id.eq.${userUid},uid.eq.${userUid}`)
      .maybeSingle();

    if (userData?.role === 'admin' || userData?.role === 'super_admin') {
      return true;
    }
  } catch (err) {
    console.warn('[PaymentSlipService] Role check warning:', err);
  }

  return false;
}

/**
 * Verifies whether a non-admin customer is authorized to view a specific payment slip.
 * Customers may only view slips whose path belongs to their email/UID or is attached to one of their orders/renewals.
 */
export async function canCustomerAccessSlip(
  parsed: ParsedSlipReference,
  userUid?: string,
  userEmail?: string
): Promise<boolean> {
  const cleanEmail = String(userEmail || '').trim().toLowerCase();
  const cleanUid = String(userUid || '').trim().toLowerCase();

  if (!cleanEmail && !cleanUid) return false;

  const lowerPath = parsed.objectPath.toLowerCase();
  const segments = lowerPath.split('/').map((s) => s.trim());

  // Path pattern: orders/<email_or_uid>/<filename>, renewals/<email_or_uid>/<filename>, billing/<email_or_uid>/<filename>
  if (cleanEmail && segments.includes(cleanEmail)) {
    return true;
  }
  if (cleanUid && segments.includes(cleanUid)) {
    return true;
  }

  // Also check if the customer owns an order or renew_request with this slip_url
  try {
    if (cleanUid || cleanEmail) {
      const { data: orderMatch } = await supabase
        .from('orders')
        .select('id, customer_id, email, slip_url')
        .ilike('slip_url', `%${parsed.objectPath}%`)
        .limit(5);

      if (
        Array.isArray(orderMatch) &&
        orderMatch.some(
          (row: any) =>
            (cleanUid && String(row.customer_id || '').toLowerCase() === cleanUid) ||
            (cleanEmail && String(row.email || '').toLowerCase() === cleanEmail)
        )
      ) {
        return true;
      }

      const { data: renewMatch } = await supabase
        .from('renew_requests')
        .select('id, user_id, user_email, slip_url')
        .ilike('slip_url', `%${parsed.objectPath}%`)
        .limit(5);

      if (
        Array.isArray(renewMatch) &&
        renewMatch.some(
          (row: any) =>
            (cleanUid && String(row.user_id || '').toLowerCase() === cleanUid) ||
            (cleanEmail && String(row.user_email || '').toLowerCase() === cleanEmail)
        )
      ) {
        return true;
      }
    }
  } catch (err) {
    console.warn('[PaymentSlipService] Ownership lookup warning:', err);
  }

  return false;
}

export interface SignedSlipResult {
  success: boolean;
  signedUrl?: string;
  bucket: string;
  objectPath: string;
  isPdf: boolean;
  expiresIn: number;
  error?: string;
  code?: 'SLIP_NOT_FOUND' | 'BUCKET_NOT_FOUND' | 'FORBIDDEN' | 'INVALID_INPUT';
}

/**
 * Generates a fresh signed URL for a payment slip stored in the private `payment-slips` bucket.
 */
export async function resolvePaymentSlipSignedUrl(params: {
  slipUrlOrPath: string;
  requesterUid?: string;
  requesterEmail?: string;
  isAdmin?: boolean;
  userToken?: string;
  expiresInSeconds?: number;
}): Promise<SignedSlipResult> {
  const expiresIn = Math.min(Math.max(Number(params.expiresInSeconds) || 3600, 60), 86400);
  const parsed = parsePaymentSlipReference(params.slipUrlOrPath);

  if (parsed.kind === 'empty') {
    return {
      success: false,
      bucket: PAYMENT_SLIPS_BUCKET,
      objectPath: '',
      isPdf: false,
      expiresIn: 0,
      error: 'No payment slip URL or file path was provided.',
      code: 'INVALID_INPUT',
    };
  }

  // Inline data URLs (e.g., fallback base64 receipts) can be returned directly
  if (parsed.kind === 'data' || parsed.kind === 'external') {
    return {
      success: true,
      signedUrl: parsed.rawInput,
      bucket: parsed.bucket,
      objectPath: parsed.objectPath,
      isPdf: parsed.isPdf,
      expiresIn,
    };
  }

  // Enforce access control: only admins or the owning customer can view a slip
  const isAdmin =
    params.isAdmin === true ||
    (await checkIsUserAdmin(params.requesterUid, params.requesterEmail));

  if (!isAdmin) {
    const isOwner = await canCustomerAccessSlip(
      parsed,
      params.requesterUid,
      params.requesterEmail
    );
    if (!isOwner) {
      return {
        success: false,
        bucket: parsed.bucket,
        objectPath: parsed.objectPath,
        isPdf: parsed.isPdf,
        expiresIn: 0,
        error: 'You do not have permission to view this payment slip.',
        code: 'FORBIDDEN',
      };
    }
  }

  await ensurePaymentSlipsBucketExists();

  // Candidate buckets to try: the parsed bucket first, then canonical 'payment-slips'
  const bucketsToTry = Array.from(new Set([parsed.bucket, ...FALLBACK_BUCKETS]));
  const clientsToTry = [supabaseAdmin];
  if (params.userToken) {
    clientsToTry.push(getSupabaseClient(params.userToken));
  }

  let lastErrorMsg = '';

  for (const bucketName of bucketsToTry) {
    for (const client of clientsToTry) {
      try {
        const { data, error } = await client.storage
          .from(bucketName)
          .createSignedUrl(parsed.objectPath, expiresIn);

        if (!error && data?.signedUrl) {
          return {
            success: true,
            signedUrl: data.signedUrl,
            bucket: bucketName,
            objectPath: parsed.objectPath,
            isPdf: parsed.isPdf,
            expiresIn,
          };
        }

        if (error) {
          lastErrorMsg = error.message || String(error);
        }
      } catch (err: any) {
        lastErrorMsg = err?.message || String(err);
      }
    }
  }

  const lowerErr = lastErrorMsg.toLowerCase();
  const isBucketMissing =
    lowerErr.includes('bucket not found') || lowerErr.includes('nosuchbucket');

  return {
    success: false,
    bucket: parsed.bucket,
    objectPath: parsed.objectPath,
    isPdf: parsed.isPdf,
    expiresIn: 0,
    code: isBucketMissing ? 'BUCKET_NOT_FOUND' : 'SLIP_NOT_FOUND',
    error: isBucketMissing
      ? `Storage bucket "${PAYMENT_SLIPS_BUCKET}" was not found. Please run the supabase_payment_slips_storage.sql migration in your Supabase SQL Editor.`
      : `Payment slip file "${parsed.objectPath}" could not be found in storage (${lastErrorMsg || 'Object not found'}).`,
  };
}

/**
 * Uploads a payment slip via the backend to the private `payment-slips` bucket and returns a fresh signed URL.
 */
export async function uploadPaymentSlipViaBackend(params: {
  fileName: string;
  contentType: string;
  base64Data: string;
  folder: 'orders' | 'renewals' | 'billing';
  userEmailOrId: string;
  userToken?: string;
}): Promise<{
  success: boolean;
  bucket: string;
  filePath: string;
  storedUrl: string;
  signedUrl: string;
  error?: string;
}> {
  const folder = ['orders', 'renewals', 'billing'].includes(params.folder)
    ? params.folder
    : 'orders';

  const normalizedContentType = String(params.contentType || '')
    .trim()
    .toLowerCase()
    .split(';')[0];

  const MIME_TO_EXTENSION: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
  };

  if (!ALLOWED_MIME_TYPES.includes(normalizedContentType) || !MIME_TO_EXTENSION[normalizedContentType]) {
    return {
      success: false,
      bucket: PAYMENT_SLIPS_BUCKET,
      filePath: '',
      storedUrl: '',
      signedUrl: '',
      error: 'Unsupported payment slip file type. Only JPG, PNG, WEBP, and PDF files are allowed.',
    };
  }

  const expectedExt = MIME_TO_EXTENSION[normalizedContentType];
  const rawBaseName = String(params.fileName || 'receipt')
    .replace(/^.*[\\/]/, '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 64) || 'receipt';
  const cleanFileName = `${rawBaseName}${expectedExt}`;

  const safeUserFolder = String(params.userEmailOrId || 'customer')
    .trim()
    .replace(/\.\./g, '_')
    .replace(/[^a-zA-Z0-9@._-]/g, '_');
  const filePath = `${folder}/${safeUserFolder}/${Date.now()}_${cleanFileName}`;

  const cleanBase64 = params.base64Data.includes(',')
    ? params.base64Data.split(',')[1]
    : params.base64Data;
  const fileBuffer = Buffer.from(cleanBase64, 'base64');

  if (fileBuffer.byteLength === 0) {
    return {
      success: false,
      bucket: PAYMENT_SLIPS_BUCKET,
      filePath: '',
      storedUrl: '',
      signedUrl: '',
      error: 'Payment slip file is empty or invalid.',
    };
  }

  if (fileBuffer.byteLength > MAX_FILE_SIZE_BYTES) {
    return {
      success: false,
      bucket: PAYMENT_SLIPS_BUCKET,
      filePath,
      storedUrl: '',
      signedUrl: '',
      error: 'File size exceeds the 15 MB limit.',
    };
  }

  await ensurePaymentSlipsBucketExists();

  const clientsToTry = [supabaseAdmin];
  if (params.userToken) {
    clientsToTry.unshift(getSupabaseClient(params.userToken));
  }

  let uploadErrorMsg = '';
  for (const client of clientsToTry) {
    const { data, error } = await client.storage
      .from(PAYMENT_SLIPS_BUCKET)
      .upload(filePath, fileBuffer, {
        contentType: normalizedContentType,
        cacheControl: '3600',
        upsert: true,
      });

    if (!error && data) {
      const { data: signedData } = await client.storage
        .from(PAYMENT_SLIPS_BUCKET)
        .createSignedUrl(filePath, 3600);

      const canonicalStoredRef = `${PAYMENT_SLIPS_BUCKET}/${filePath}`;
      return {
        success: true,
        bucket: PAYMENT_SLIPS_BUCKET,
        filePath,
        storedUrl: canonicalStoredRef,
        signedUrl: signedData?.signedUrl || canonicalStoredRef,
      };
    }

    if (error) {
      uploadErrorMsg = error.message || String(error);
    }
  }

  return {
    success: false,
    bucket: PAYMENT_SLIPS_BUCKET,
    filePath,
    storedUrl: '',
    signedUrl: '',
    error: uploadErrorMsg || 'Failed to upload payment slip to storage.',
  };
}

export interface PaymentSlipValidationResult {
  valid: boolean;
  canonicalSlipUrl: string;
  bucket: string;
  objectPath: string;
  error?: string;
  code?: 'INVALID_SLIP' | 'UNAUTHORIZED_LOCATION' | 'OWNERSHIP_MISMATCH' | 'STORAGE_NOT_FOUND' | 'DUPLICATE_SLIP';
}

/**
 * Validates payment slip ownership, authorized storage location, storage existence,
 * and duplicate receipt submission prevention on the backend before creating/activating an order.
 */
export async function validatePaymentSlipForOrderSubmission(params: {
  slipUrl: string;
  userUid: string;
  userEmail: string;
  allowedFolders?: Array<'orders' | 'renewals' | 'billing'>;
  excludeOrderId?: string;
  dbClient?: any;
  storageClient?: any;
}): Promise<PaymentSlipValidationResult> {
  const rawSlip = String(params.slipUrl || '').trim();
  const cleanUid = String(params.userUid || '').trim();
  const cleanEmail = String(params.userEmail || '').trim().toLowerCase();
  const allowedFolders = params.allowedFolders || ['orders', 'billing'];
  const db = params.dbClient || supabaseAdmin || supabase;
  const storage = params.storageClient || params.dbClient?.storage || supabaseAdmin?.storage || supabase.storage;

  if (!rawSlip) {
    return {
      valid: false,
      canonicalSlipUrl: '',
      bucket: PAYMENT_SLIPS_BUCKET,
      objectPath: '',
      error: 'Payment slip receipt is required.',
      code: 'INVALID_SLIP',
    };
  }

  const parsed = parsePaymentSlipReference(rawSlip);

  if (parsed.kind === 'empty' || parsed.kind === 'external') {
    return {
      valid: false,
      canonicalSlipUrl: '',
      bucket: parsed.bucket,
      objectPath: parsed.objectPath,
      error: 'Unauthorized payment slip storage location. Receipts must be uploaded through FIREVPNs.',
      code: 'UNAUTHORIZED_LOCATION',
    };
  }

  if (parsed.kind === 'data') {
    const dataHeaderMatch = rawSlip.match(/^data:(image\/(?:jpeg|jpg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!dataHeaderMatch) {
      return {
        valid: false,
        canonicalSlipUrl: '',
        bucket: PAYMENT_SLIPS_BUCKET,
        objectPath: '',
        error: 'Invalid inline payment slip format. Only JPG, PNG, WEBP, and PDF receipts are accepted.',
        code: 'INVALID_SLIP',
      };
    }
    const b64Payload = dataHeaderMatch[2].replace(/\s+/g, '');
    const byteLen = Buffer.from(b64Payload, 'base64').byteLength;
    if (byteLen < 32 || byteLen > MAX_FILE_SIZE_BYTES) {
      return {
        valid: false,
        canonicalSlipUrl: '',
        bucket: PAYMENT_SLIPS_BUCKET,
        objectPath: '',
        error: 'Payment slip file size is invalid.',
        code: 'INVALID_SLIP',
      };
    }
  } else if (parsed.kind === 'storage') {
    if (!FALLBACK_BUCKETS.includes(parsed.bucket)) {
      return {
        valid: false,
        canonicalSlipUrl: '',
        bucket: parsed.bucket,
        objectPath: parsed.objectPath,
        error: `Unauthorized storage bucket '${parsed.bucket}'.`,
        code: 'UNAUTHORIZED_LOCATION',
      };
    }

    const segments = parsed.objectPath.split('/').filter(Boolean);
    if (segments.length < 3) {
      return {
        valid: false,
        canonicalSlipUrl: '',
        bucket: parsed.bucket,
        objectPath: parsed.objectPath,
        error: 'Invalid payment slip storage path structure.',
        code: 'UNAUTHORIZED_LOCATION',
      };
    }

    const folderSegment = segments[0].toLowerCase() as 'orders' | 'renewals' | 'billing';
    if (!allowedFolders.includes(folderSegment)) {
      return {
        valid: false,
        canonicalSlipUrl: '',
        bucket: parsed.bucket,
        objectPath: parsed.objectPath,
        error: `Invalid payment slip folder '${segments[0]}'.`,
        code: 'UNAUTHORIZED_LOCATION',
      };
    }

    // Verify ownership: second path segment must match user's sanitized email or UID
    const ownerSegment = segments[1].toLowerCase();
    const safeEmailSeg = cleanEmail.replace(/[^a-zA-Z0-9@._-]/g, '_').toLowerCase();
    const safeUidSeg = cleanUid.replace(/[^a-zA-Z0-9@._-]/g, '_').toLowerCase();

    const matchesOwner =
      (cleanEmail && (ownerSegment === cleanEmail || ownerSegment === safeEmailSeg)) ||
      (cleanUid && (ownerSegment === cleanUid.toLowerCase() || ownerSegment === safeUidSeg));

    if (!matchesOwner) {
      return {
        valid: false,
        canonicalSlipUrl: '',
        bucket: parsed.bucket,
        objectPath: parsed.objectPath,
        error: 'Forbidden: Payment slip ownership does not match the authenticated account.',
        code: 'OWNERSHIP_MISMATCH',
      };
    }

    // Verify existence in Supabase Storage
    let fileExistsInStorage = false;
    let storageVerifyErr = '';
    try {
      const { data: signedData, error: signErr } = await storage
        .from(parsed.bucket)
        .createSignedUrl(parsed.objectPath, 60);
      if (!signErr && signedData?.signedUrl) {
        fileExistsInStorage = true;
      } else if (signErr) {
        storageVerifyErr = signErr.message || String(signErr);
      }
    } catch (sErr: any) {
      storageVerifyErr = sErr?.message || String(sErr);
    }

    if (!fileExistsInStorage) {
      return {
        valid: false,
        canonicalSlipUrl: '',
        bucket: parsed.bucket,
        objectPath: parsed.objectPath,
        error: `Uploaded payment slip was not found in storage (${storageVerifyErr || 'Object missing'}). Please re-upload your payment slip.`,
        code: 'STORAGE_NOT_FOUND',
      };
    }
  }

  // Prevent duplicate receipt reuse across already-provisioned, completed, or rejected orders
  try {
    const slipCandidates = Array.from(
      new Set(
        [
          rawSlip,
          parsed.objectPath ? `${parsed.bucket}/${parsed.objectPath}` : '',
          parsed.objectPath || '',
        ].filter(Boolean)
      )
    );

    for (const candidate of slipCandidates) {
      const { data: existingOrdersWithSlip } = await db
        .from('orders')
        .select('id, order_id, customer_id, status, payment_status, provisioning_status, client_uuid, vless_url')
        .eq('slip_url', candidate)
        .limit(5);

      if (Array.isArray(existingOrdersWithSlip) && existingOrdersWithSlip.length > 0) {
        const reusedOrder = existingOrdersWithSlip.find((ord: any) => {
          if (params.excludeOrderId && String(ord.id) === String(params.excludeOrderId)) {
            return false;
          }
          const ordOwner = String(ord.customer_id || '').trim();
          const st = String(ord.status || '').toLowerCase();
          const paySt = String(ord.payment_status || '').toLowerCase();
          const provSt = String(ord.provisioning_status || '').toLowerCase();
          // If used by another customer, or already approved/completed/rejected/provisioned
          if (ordOwner && cleanUid && ordOwner !== cleanUid) return true;
          if (
            st === 'completed' ||
            st === 'active' ||
            st === 'rejected' ||
            paySt === 'paid' ||
            paySt === 'cancelled' ||
            paySt === 'rejected' ||
            provSt === 'provisional' ||
            provSt === 'completed' ||
            provSt === 'revoked' ||
            Boolean(ord.vless_url)
          ) {
            return true;
          }
          return false;
        });

        if (reusedOrder) {
          return {
            valid: false,
            canonicalSlipUrl: '',
            bucket: parsed.bucket,
            objectPath: parsed.objectPath,
            error: 'This payment slip has already been submitted on a processed or active order. Please upload a fresh payment receipt.',
            code: 'DUPLICATE_SLIP',
          };
        }
      }
    }
  } catch (dupErr) {
    console.warn('[PaymentSlipService] Duplicate slip check notice:', dupErr);
  }

  const canonicalSlipUrl =
    parsed.kind === 'storage' && parsed.objectPath
      ? `${parsed.bucket}/${parsed.objectPath}`
      : rawSlip;

  return {
    valid: true,
    canonicalSlipUrl,
    bucket: parsed.bucket,
    objectPath: parsed.objectPath,
  };
}

export interface PaymentSlipContentVerificationResult {
  valid: boolean;
  canonicalSlipUrl: string;
  bucket: string;
  objectPath: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  error?: string;
  code?:
    | 'INVALID_SLIP'
    | 'UNAUTHORIZED_LOCATION'
    | 'OWNERSHIP_MISMATCH'
    | 'STORAGE_NOT_FOUND'
    | 'STORAGE_READ_FAILED';
}

/**
 * Verifies payment slip ownership and storage existence, reads the actual uploaded
 * bytes (from Supabase Storage or inline data URI), and computes a SHA-256 digest.
 * NOTE: SHA-256 detects exact duplicate file re-submissions (including renamed re-uploads),
 * but does not prove payment authenticity or detect edited/re-encoded images.
 */
export async function computePaymentSlipSha256AndVerifyStorage(params: {
  slipUrl: string;
  userUid: string;
  userEmail: string;
  allowedFolders?: Array<'orders' | 'renewals' | 'billing'>;
  storageClient?: any;
}): Promise<PaymentSlipContentVerificationResult> {
  const rawSlip = String(params.slipUrl || '').trim();
  const cleanUid = String(params.userUid || '').trim();
  const cleanEmail = String(params.userEmail || '').trim().toLowerCase();
  const allowedFolders = params.allowedFolders || ['orders', 'billing'];
  const storage = params.storageClient || supabaseAdmin?.storage || supabase.storage;

  if (!rawSlip) {
    return {
      valid: false,
      canonicalSlipUrl: '',
      bucket: PAYMENT_SLIPS_BUCKET,
      objectPath: '',
      sha256: '',
      byteSize: 0,
      contentType: '',
      error: 'Payment slip receipt is required.',
      code: 'INVALID_SLIP',
    };
  }

  const parsed = parsePaymentSlipReference(rawSlip);

  if (parsed.kind === 'empty' || parsed.kind === 'external') {
    return {
      valid: false,
      canonicalSlipUrl: '',
      bucket: parsed.bucket,
      objectPath: parsed.objectPath,
      sha256: '',
      byteSize: 0,
      contentType: '',
      error: 'Unauthorized payment slip storage location. Receipts must be uploaded through FIREVPNs.',
      code: 'UNAUTHORIZED_LOCATION',
    };
  }

  if (parsed.kind === 'data') {
    const dataHeaderMatch = rawSlip.match(
      /^data:(image\/(?:jpeg|jpg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=\s]+)$/i
    );
    if (!dataHeaderMatch) {
      return {
        valid: false,
        canonicalSlipUrl: '',
        bucket: PAYMENT_SLIPS_BUCKET,
        objectPath: '',
        sha256: '',
        byteSize: 0,
        contentType: '',
        error: 'Invalid inline payment slip format. Only JPG, PNG, WEBP, and PDF receipts are accepted.',
        code: 'INVALID_SLIP',
      };
    }

    const contentType = dataHeaderMatch[1].toLowerCase();
    const buf = Buffer.from(dataHeaderMatch[2].replace(/\s+/g, ''), 'base64');
    if (buf.byteLength < 32 || buf.byteLength > MAX_FILE_SIZE_BYTES) {
      return {
        valid: false,
        canonicalSlipUrl: '',
        bucket: PAYMENT_SLIPS_BUCKET,
        objectPath: '',
        sha256: '',
        byteSize: buf.byteLength,
        contentType,
        error: 'Payment slip file size is invalid.',
        code: 'INVALID_SLIP',
      };
    }

    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    return {
      valid: true,
      canonicalSlipUrl: `inline-sha256:${sha256}`,
      bucket: PAYMENT_SLIPS_BUCKET,
      objectPath: '',
      sha256,
      byteSize: buf.byteLength,
      contentType,
    };
  }

  // parsed.kind === 'storage'
  if (!FALLBACK_BUCKETS.includes(parsed.bucket)) {
    return {
      valid: false,
      canonicalSlipUrl: '',
      bucket: parsed.bucket,
      objectPath: parsed.objectPath,
      sha256: '',
      byteSize: 0,
      contentType: '',
      error: `Unauthorized storage bucket '${parsed.bucket}'.`,
      code: 'UNAUTHORIZED_LOCATION',
    };
  }

  const segments = parsed.objectPath.split('/').filter(Boolean);
  if (segments.length < 3) {
    return {
      valid: false,
      canonicalSlipUrl: '',
      bucket: parsed.bucket,
      objectPath: parsed.objectPath,
      sha256: '',
      byteSize: 0,
      contentType: '',
      error: 'Invalid payment slip storage path structure.',
      code: 'UNAUTHORIZED_LOCATION',
    };
  }

  const folderSegment = segments[0].toLowerCase() as 'orders' | 'renewals' | 'billing';
  if (!allowedFolders.includes(folderSegment)) {
    return {
      valid: false,
      canonicalSlipUrl: '',
      bucket: parsed.bucket,
      objectPath: parsed.objectPath,
      sha256: '',
      byteSize: 0,
      contentType: '',
      error: `Invalid payment slip folder '${segments[0]}'.`,
      code: 'UNAUTHORIZED_LOCATION',
    };
  }

  const ownerSegment = segments[1].toLowerCase();
  const safeEmailSeg = cleanEmail.replace(/[^a-zA-Z0-9@._-]/g, '_').toLowerCase();
  const safeUidSeg = cleanUid.replace(/[^a-zA-Z0-9@._-]/g, '_').toLowerCase();
  const matchesOwner =
    (cleanEmail && (ownerSegment === cleanEmail || ownerSegment === safeEmailSeg)) ||
    (cleanUid && (ownerSegment === cleanUid.toLowerCase() || ownerSegment === safeUidSeg));

  if (!matchesOwner) {
    return {
      valid: false,
      canonicalSlipUrl: '',
      bucket: parsed.bucket,
      objectPath: parsed.objectPath,
      sha256: '',
      byteSize: 0,
      contentType: '',
      error: 'Forbidden: Payment slip ownership does not match the authenticated account.',
      code: 'OWNERSHIP_MISMATCH',
    };
  }

  // Download actual object bytes from private storage to confirm existence and compute SHA-256
  try {
    const { data: blobOrBuf, error: downloadErr } = await storage
      .from(parsed.bucket)
      .download(parsed.objectPath);

    if (downloadErr || !blobOrBuf) {
      return {
        valid: false,
        canonicalSlipUrl: '',
        bucket: parsed.bucket,
        objectPath: parsed.objectPath,
        sha256: '',
        byteSize: 0,
        contentType: '',
        error: `Uploaded payment slip could not be verified in storage (${downloadErr?.message || 'Object not found'}).`,
        code: 'STORAGE_NOT_FOUND',
      };
    }

    let fileBuffer: Buffer;
    let detectedType = parsed.isPdf ? 'application/pdf' : 'image/jpeg';

    if (Buffer.isBuffer(blobOrBuf)) {
      fileBuffer = blobOrBuf;
    } else if (blobOrBuf instanceof Uint8Array) {
      fileBuffer = Buffer.from(blobOrBuf);
    } else if (typeof blobOrBuf.arrayBuffer === 'function') {
      const ab = await blobOrBuf.arrayBuffer();
      fileBuffer = Buffer.from(ab);
      if (typeof blobOrBuf.type === 'string' && blobOrBuf.type) {
        detectedType = blobOrBuf.type;
      }
    } else {
      return {
        valid: false,
        canonicalSlipUrl: '',
        bucket: parsed.bucket,
        objectPath: parsed.objectPath,
        sha256: '',
        byteSize: 0,
        contentType: '',
        error: 'Unable to read payment slip bytes from storage.',
        code: 'STORAGE_READ_FAILED',
      };
    }

    if (fileBuffer.byteLength < 32 || fileBuffer.byteLength > MAX_FILE_SIZE_BYTES) {
      return {
        valid: false,
        canonicalSlipUrl: '',
        bucket: parsed.bucket,
        objectPath: parsed.objectPath,
        sha256: '',
        byteSize: fileBuffer.byteLength,
        contentType: detectedType,
        error: 'Payment slip file size is invalid.',
        code: 'INVALID_SLIP',
      };
    }

    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    return {
      valid: true,
      canonicalSlipUrl: `${parsed.bucket}/${parsed.objectPath}`,
      bucket: parsed.bucket,
      objectPath: parsed.objectPath,
      sha256,
      byteSize: fileBuffer.byteLength,
      contentType: detectedType,
    };
  } catch (err: any) {
    return {
      valid: false,
      canonicalSlipUrl: '',
      bucket: parsed.bucket,
      objectPath: parsed.objectPath,
      sha256: '',
      byteSize: 0,
      contentType: '',
      error: `Storage verification failed: ${err?.message || String(err)}`,
      code: 'STORAGE_READ_FAILED',
    };
  }
}

export interface PaymentReceiptClaimResult {
  claimed: boolean;
  existingOrderId?: string | null;
  existingUserId?: string | null;
  conflictReason?: string | null;
  code?: 'CLAIMED' | 'DUPLICATE_SLIP' | 'CLAIM_UNAVAILABLE';
  error?: string;
}

/**
 * Atomically claims a payment receipt SHA-256 and canonical path in PostgreSQL
 * via public.claim_payment_receipt(). Fails CLOSED if the atomic claim RPC is
 * unavailable or errors, so duplicate receipts cannot trigger multiple auto-activations.
 */
export async function claimPaymentReceiptForAutoActivation(params: {
  sha256: string;
  canonicalSlipUrl: string;
  orderId: string;
  userId: string;
  userEmail: string;
  byteSize: number;
  contentType?: string;
  dbClient?: any;
}): Promise<PaymentReceiptClaimResult> {
  const db = params.dbClient || supabaseAdmin;
  if (!db || typeof db.rpc !== 'function') {
    return {
      claimed: false,
      code: 'CLAIM_UNAVAILABLE',
      error: 'Database RPC client unavailable for atomic payment receipt claiming.',
    };
  }

  try {
    const { data, error } = await db.rpc('claim_payment_receipt', {
      p_receipt_sha256: params.sha256,
      p_canonical_slip_url: params.canonicalSlipUrl || null,
      p_order_id: params.orderId,
      p_user_id: params.userId,
      p_user_email: params.userEmail || '',
      p_byte_size: params.byteSize || 0,
      p_content_type: params.contentType || null,
    });

    if (error) {
      return {
        claimed: false,
        code: 'CLAIM_UNAVAILABLE',
        error: error.message || 'Atomic payment receipt claim RPC failed.',
      };
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.claimed !== 'boolean') {
      return {
        claimed: false,
        code: 'CLAIM_UNAVAILABLE',
        error: 'Unexpected response from claim_payment_receipt RPC.',
      };
    }

    if (!row.claimed) {
      return {
        claimed: false,
        code: 'DUPLICATE_SLIP',
        existingOrderId: row.existing_order_id || null,
        existingUserId: row.existing_user_id || null,
        conflictReason: row.conflict_reason || 'duplicate_receipt_sha256',
        error: 'Duplicate payment receipt detected; automatic activation blocked pending manual admin verification.',
      };
    }

    return {
      claimed: true,
      code: 'CLAIMED',
      existingOrderId: row.existing_order_id || params.orderId,
      existingUserId: row.existing_user_id || params.userId,
    };
  } catch (err: any) {
    return {
      claimed: false,
      code: 'CLAIM_UNAVAILABLE',
      error: err?.message || 'Atomic payment receipt claim failed.',
    };
  }
}

/**
 * Verifies whether a payment slip storage path belongs to the authenticated user
 * for renewal submissions (allowing 'renewals', 'orders', and 'billing' folders).
 */
export function isRenewalPaymentSlipStoragePathOwnedByUser(
  paramsOrSlipUrl:
    | { slipUrl: string; uid?: string | null; email?: string | null }
    | string
    | null
    | undefined,
  userIdArg?: string | null,
  userEmailArg?: string | null
): {
  valid: boolean;
  owned: boolean;
  reason?:
    | 'PATH_TRAVERSAL_OR_INVALID'
    | 'UNAUTHORIZED_BUCKET'
    | 'MALFORMED_STORAGE_PATH'
    | 'INVALID_FOLDER'
    | 'OWNERSHIP_MISMATCH';
} {
  const isObj = typeof paramsOrSlipUrl === 'object' && paramsOrSlipUrl !== null;
  const rawSlip = String(isObj ? paramsOrSlipUrl.slipUrl : paramsOrSlipUrl || '').trim();
  const userId = isObj ? paramsOrSlipUrl.uid : userIdArg;
  const userEmail = isObj ? paramsOrSlipUrl.email : userEmailArg;

  let decodedOnce = rawSlip;
  let decodedTwice = rawSlip;
  try {
    decodedOnce = decodeURIComponent(rawSlip);
    decodedTwice = decodeURIComponent(decodedOnce);
  } catch {
    // Keep last decoded string
  }

  if (
    !rawSlip ||
    rawSlip.includes('..') ||
    rawSlip.includes('\0') ||
    rawSlip.includes('\\') ||
    decodedOnce.includes('..') ||
    decodedOnce.includes('\0') ||
    decodedOnce.includes('\\') ||
    decodedTwice.includes('..') ||
    decodedTwice.includes('\0') ||
    decodedTwice.includes('\\')
  ) {
    return { valid: false, owned: false, reason: 'PATH_TRAVERSAL_OR_INVALID' };
  }

  const parsed = parsePaymentSlipReference(rawSlip);
  if (parsed.kind === 'data') {
    const ok = /^data:(image\/(?:jpeg|jpg|png|webp)|application\/pdf);base64,[A-Za-z0-9+/=\s]+$/i.test(rawSlip);
    return ok
      ? { valid: true, owned: true }
      : { valid: false, owned: false, reason: 'PATH_TRAVERSAL_OR_INVALID' };
  }
  if (parsed.kind === 'empty') {
    return { valid: false, owned: false, reason: 'PATH_TRAVERSAL_OR_INVALID' };
  }
  if (parsed.kind !== 'storage' || !parsed.objectPath) {
    return { valid: false, owned: false, reason: 'MALFORMED_STORAGE_PATH' };
  }
  if (!FALLBACK_BUCKETS.includes(parsed.bucket)) {
    return { valid: false, owned: false, reason: 'UNAUTHORIZED_BUCKET' };
  }

  const objectPath = String(parsed.objectPath || '').trim();
  let doubleDecodedPath = objectPath;
  try {
    doubleDecodedPath = decodeURIComponent(objectPath);
  } catch {
    // Keep objectPath as-is
  }

  if (
    !objectPath ||
    objectPath.includes('..') ||
    objectPath.includes('\0') ||
    objectPath.includes('\\') ||
    doubleDecodedPath.includes('..') ||
    doubleDecodedPath.includes('\0') ||
    doubleDecodedPath.includes('\\')
  ) {
    return { valid: false, owned: false, reason: 'PATH_TRAVERSAL_OR_INVALID' };
  }

  const segments = objectPath.split('/').filter(Boolean);
  if (segments.length < 3) {
    return { valid: false, owned: false, reason: 'MALFORMED_STORAGE_PATH' };
  }
  if (segments.some((seg) => seg === '.' || seg === '..')) {
    return { valid: false, owned: false, reason: 'PATH_TRAVERSAL_OR_INVALID' };
  }

  const folderSegment = segments[0].toLowerCase();
  if (!['renewals', 'orders', 'billing'].includes(folderSegment)) {
    return { valid: false, owned: false, reason: 'INVALID_FOLDER' };
  }

  const ownerSegment = segments[1].toLowerCase();
  const fileSegment = segments.slice(2).join('/').trim();
  if (!ownerSegment || !fileSegment) {
    return { valid: false, owned: false, reason: 'MALFORMED_STORAGE_PATH' };
  }

  const cleanEmail = String(userEmail || '').trim().toLowerCase();
  const cleanUid = String(userId || '').trim().toLowerCase();
  const allowedOwners = new Set<string>();
  if (cleanUid) {
    allowedOwners.add(cleanUid);
    allowedOwners.add(cleanUid.replace(/[^a-zA-Z0-9@._-]/g, '_'));
    allowedOwners.add(cleanUid.replace(/[^a-zA-Z0-9_-]/g, '_'));
  }
  if (cleanEmail) {
    allowedOwners.add(cleanEmail);
    allowedOwners.add(cleanEmail.replace(/[^a-zA-Z0-9@._-]/g, '_'));
    allowedOwners.add(cleanEmail.replace(/[^a-zA-Z0-9_-]/g, '_'));
  }

  if (allowedOwners.size === 0 || !allowedOwners.has(ownerSegment)) {
    return { valid: false, owned: false, reason: 'OWNERSHIP_MISMATCH' };
  }

  return { valid: true, owned: true };
}

export interface PaymentReceiptRenewalClaimResult {
  claimed: boolean;
  existingOrderId?: string | null;
  existingRenewRequestId?: string | null;
  existingUserId?: string | null;
  conflictReason?: string | null;
  code?:
    | 'CLAIMED'
    | 'DUPLICATE_SLIP'
    | 'CLAIM_UNAVAILABLE'
    | 'SOURCE_OWNERSHIP_MISMATCH';
  error?: string;
}

/**
 * Atomically claims a payment receipt SHA-256 and canonical storage path for a renewal
 * request via public.claim_renewal_payment_receipt().
 * Preserves public.claim_payment_receipt() and claimPaymentReceiptForAutoActivation() 100%.
 * Fails CLOSED if the RPC is unavailable or errors.
 */
export async function claimPaymentReceiptForRenewal(params: {
  sha256: string;
  canonicalSlipUrl: string;
  renewRequestId: string;
  userId: string;
  userEmail: string;
  byteSize: number;
  contentType?: string;
  dbClient?: any;
}): Promise<PaymentReceiptRenewalClaimResult> {
  const db = params.dbClient || supabaseAdmin;
  if (!db || typeof db.rpc !== 'function') {
    return {
      claimed: false,
      code: 'CLAIM_UNAVAILABLE',
      error: 'Database RPC client unavailable for atomic renewal payment receipt claiming.',
    };
  }

  try {
    // Exact 7-argument signature matching public.claim_renewal_payment_receipt in supabase_migration_auto_renewals.sql
    const { data, error } = await db.rpc('claim_renewal_payment_receipt', {
      p_receipt_sha256: params.sha256,
      p_canonical_slip_url: params.canonicalSlipUrl || null,
      p_renew_request_id: String(params.renewRequestId),
      p_user_id: params.userId,
      p_user_email: params.userEmail || '',
      p_byte_size: params.byteSize || 0,
      p_content_type: params.contentType || null,
    });

    if (error) {
      return {
        claimed: false,
        code: 'CLAIM_UNAVAILABLE',
        error: error.message || 'Atomic renewal payment receipt claim RPC failed.',
      };
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.claimed !== 'boolean') {
      return {
        claimed: false,
        code: 'CLAIM_UNAVAILABLE',
        error: 'Unexpected response from claim_renewal_payment_receipt RPC.',
      };
    }

    if (!row.claimed) {
      const conflictReason = String(row.conflict_reason || 'duplicate_receipt_sha256');
      const isOwnershipErr =
        conflictReason === 'source_owner_mismatch' ||
        conflictReason === 'claim_owner_mismatch' ||
        conflictReason === 'source_renewal_not_found' ||
        conflictReason === 'invalid_claim_owner' ||
        conflictReason === 'invalid_claim_identity' ||
        conflictReason === 'invalid_renewal_claim_identity';
      const isInvalidHash = conflictReason === 'invalid_receipt_sha256';
      return {
        claimed: false,
        code: isOwnershipErr
          ? 'SOURCE_OWNERSHIP_MISMATCH'
          : isInvalidHash
          ? 'CLAIM_UNAVAILABLE'
          : 'DUPLICATE_SLIP',
        existingOrderId: row.existing_order_id || null,
        existingRenewRequestId: row.existing_renew_request_id || null,
        existingUserId: row.existing_user_id || null,
        conflictReason,
        error: isOwnershipErr
          ? 'Renewal request ownership verification failed.'
          : isInvalidHash
          ? 'Invalid payment receipt SHA-256 format.'
          : 'Duplicate payment receipt detected; automatic renewal blocked pending manual admin verification.',
      };
    }

    return {
      claimed: true,
      code: 'CLAIMED',
      existingOrderId: row.existing_order_id || null,
      existingRenewRequestId: row.existing_renew_request_id || String(params.renewRequestId),
      existingUserId: row.existing_user_id || params.userId,
      conflictReason: null,
    };
  } catch (err: any) {
    return {
      claimed: false,
      code: 'CLAIM_UNAVAILABLE',
      error: err?.message || 'Atomic renewal payment receipt claim failed.',
    };
  }
}



