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

  return {
    kind: 'storage',
    bucket,
    objectPath: normalizedPath,
    rawInput: trimmed,
    isPdf: checkIsPdf(normalizedPath),
  };
}

/**
 * Checks whether a user is an admin in `profiles` or `users`, or is the primary admin email.
 */
export async function checkIsUserAdmin(userUid?: string, userEmail?: string): Promise<boolean> {
  if (!userUid && !userEmail) return false;
  if (userEmail && userEmail.toLowerCase().trim() === 'madushannimesha16@gmail.com') {
    return true;
  }
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

  const cleanFileName = String(params.fileName || 'receipt.png').replace(/[^a-zA-Z0-9.-]/g, '_');
  const safeUserFolder = String(params.userEmailOrId || 'customer')
    .trim()
    .replace(/[^a-zA-Z0-9@._-]/g, '_');
  const filePath = `${folder}/${safeUserFolder}/${Date.now()}_${cleanFileName}`;

  const cleanBase64 = params.base64Data.includes(',')
    ? params.base64Data.split(',')[1]
    : params.base64Data;
  const fileBuffer = Buffer.from(cleanBase64, 'base64');

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
        contentType: params.contentType || 'image/png',
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
