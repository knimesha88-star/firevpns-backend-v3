import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { supabase } from '../../lib/supabase.js';

export type DiscountStatus = 'Active' | 'Scheduled' | 'Expired' | 'Disabled';

export interface DiscountRecord {
  id: string;
  name: string;
  discount_amount: number;
  package_ids: string[];
  start_date: string;
  end_date: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  status?: DiscountStatus;
}

export interface VpnPackageCatalogItem {
  id: string;
  name: string;
  category: 'SIM' | 'ROUTER';
  defaultPackageType: '100GB' | 'Unlimited';
  basePrice: number;
}

export const BUILT_IN_VPN_PACKAGES: VpnPackageCatalogItem[] = [
  // SIM 100GB Packages (Base Price: LKR 200)
  { id: 'hutch_zoom', name: 'HUTCH ZOOM', category: 'SIM', defaultPackageType: '100GB', basePrice: 200 },
  { id: 'dialog_tiktok', name: 'DIALOG TIKTOK', category: 'SIM', defaultPackageType: '100GB', basePrice: 200 },
  { id: 'dialog_zoom_224', name: 'DIALOG ZOOM 224', category: 'SIM', defaultPackageType: '100GB', basePrice: 200 },
  { id: 'dialog_social', name: 'DIALOG SOCIAL', category: 'SIM', defaultPackageType: '100GB', basePrice: 200 },
  // SIM Unlimited Packages (Base Price: LKR 400)
  { id: 'mobitel_zoom', name: 'MOBITEL ZOOM', category: 'SIM', defaultPackageType: 'Unlimited', basePrice: 400 },
  { id: 'airtel_tiktok', name: 'AIRTEL TIKTOK', category: 'SIM', defaultPackageType: 'Unlimited', basePrice: 400 },
  { id: 'airtel_youtube', name: 'AIRTEL YOUTUBE', category: 'SIM', defaultPackageType: 'Unlimited', basePrice: 400 },
  { id: 'airtel_zoom', name: 'AIRTEL ZOOM', category: 'SIM', defaultPackageType: 'Unlimited', basePrice: 400 },
  // Router Unlimited Packages (Base Price: LKR 600)
  { id: 'dialog_zoom', name: 'DIALOG ZOOM', category: 'ROUTER', defaultPackageType: 'Unlimited', basePrice: 600 },
  { id: 'slt_fiber_zoom', name: 'SLT FIBER ZOOM', category: 'ROUTER', defaultPackageType: 'Unlimited', basePrice: 600 },
  { id: 'slt_fiber_netflix', name: 'SLT FIBER NETFLIX', category: 'ROUTER', defaultPackageType: 'Unlimited', basePrice: 600 },
  { id: 'slt_zoom', name: 'SLT ZOOM', category: 'ROUTER', defaultPackageType: 'Unlimited', basePrice: 600 },
];

const SETTINGS_FALLBACK_ID = 'discounts_management';
const LOCAL_STORE_PATH = path.join(process.cwd(), 'backend', 'data', 'discounts.json');

let inMemoryDiscounts: DiscountRecord[] | null = null;

function getAuthenticatedSupabase(authToken?: string) {
  if (!authToken) return supabase;
  const supabaseUrl =
    process.env.VITE_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    'https://pqjgtjiqxltymnbdgxwc.supabase.co';
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    'sb_publishable_yUbm1pnfUsJy0GeUHXtYGA_iu9XRdSb';

  return createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    },
  });
}

function readLocalStoreDiscounts(): DiscountRecord[] {
  try {
    if (fs.existsSync(LOCAL_STORE_PATH)) {
      const raw = fs.readFileSync(LOCAL_STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        inMemoryDiscounts = parsed;
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[DiscountService] Local store read warning:', err);
  }
  return inMemoryDiscounts || [];
}

function writeLocalStoreDiscounts(discounts: DiscountRecord[]): void {
  const clean = discounts.map(({ status, ...rest }) => rest);
  inMemoryDiscounts = clean;
  try {
    const dir = path.dirname(LOCAL_STORE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(LOCAL_STORE_PATH, JSON.stringify(clean, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[DiscountService] Local store write warning:', err);
  }
}

export function computeDiscountStatus(
  discount: Pick<DiscountRecord, 'is_active' | 'start_date' | 'end_date'>,
  now: Date = new Date()
): DiscountStatus {
  if (!discount.is_active) {
    return 'Disabled';
  }
  const nowMs = now.getTime();
  const startMs = new Date(discount.start_date).getTime();
  const endMs = new Date(discount.end_date).getTime();

  if (nowMs < startMs) {
    return 'Scheduled';
  }
  if (nowMs > endMs) {
    return 'Expired';
  }
  return 'Active';
}

export function withDiscountStatus(discount: DiscountRecord, now: Date = new Date()): DiscountRecord {
  return {
    ...discount,
    discount_amount: Number(discount.discount_amount),
    package_ids: Array.isArray(discount.package_ids) ? discount.package_ids : [],
    status: computeDiscountStatus(discount, now),
  };
}

export async function getAllAvailablePackages(): Promise<VpnPackageCatalogItem[]> {
  const packagesMap = new Map<string, VpnPackageCatalogItem>();
  for (const pkg of BUILT_IN_VPN_PACKAGES) {
    packagesMap.set(pkg.id, pkg);
  }

  try {
    const { data: templates } = await supabase.from('provision_templates').select('*');
    if (Array.isArray(templates)) {
      for (const tpl of templates) {
        const rawName = String(tpl.package_name || tpl.name || '').trim();
        if (!rawName) continue;
        const normalizedId = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        const existingByName = Array.from(packagesMap.values()).find(
          (p) => p.name.toLowerCase() === rawName.toLowerCase() || p.id === normalizedId
        );
        if (!existingByName) {
          const isRouter =
            rawName.toUpperCase().includes('ROUTER') ||
            rawName.toUpperCase().includes('SLT') ||
            String(tpl.category || '').toUpperCase() === 'ROUTER';
          packagesMap.set(normalizedId, {
            id: normalizedId,
            name: rawName.toUpperCase(),
            category: isRouter ? 'ROUTER' : 'SIM',
            defaultPackageType: isRouter ? 'Unlimited' : '100GB',
            basePrice: isRouter ? 600 : 200,
          });
        }
      }
    }
  } catch (err) {
    console.warn('[DiscountService] Could not fetch provision_templates for package catalog:', err);
  }

  return Array.from(packagesMap.values());
}

async function readSettingsFallbackDiscounts(authToken?: string): Promise<DiscountRecord[] | null> {
  const client = getAuthenticatedSupabase(authToken);
  try {
    const { data, error } = await client
      .from('settings')
      .select('data')
      .eq('id', SETTINGS_FALLBACK_ID)
      .maybeSingle();

    if (!error && data?.data && Array.isArray(data.data.discounts)) {
      return data.data.discounts as DiscountRecord[];
    }
  } catch (_err) {
    // ignore
  }
  return null;
}

async function writeSettingsFallbackDiscounts(discounts: DiscountRecord[], authToken?: string): Promise<void> {
  const clean = discounts.map(({ status, ...rest }) => rest);
  writeLocalStoreDiscounts(clean);

  const client = getAuthenticatedSupabase(authToken);
  try {
    await client.from('settings').upsert(
      {
        id: SETTINGS_FALLBACK_ID,
        data: { discounts: clean },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );
  } catch (_err) {
    // ignore if RLS blocks unauthenticated write
  }
}

export async function getAllDiscounts(authToken?: string): Promise<DiscountRecord[]> {
  const client = getAuthenticatedSupabase(authToken);
  let records: DiscountRecord[] | null = null;

  try {
    const { data, error } = await client
      .from('discounts')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && Array.isArray(data)) {
      records = data.map((row: any) => ({
        id: String(row.id),
        name: String(row.name || ''),
        discount_amount: Number(row.discount_amount || 0),
        package_ids: Array.isArray(row.package_ids) ? row.package_ids.map(String) : [],
        start_date: String(row.start_date),
        end_date: String(row.end_date),
        is_active: Boolean(row.is_active),
        created_at: String(row.created_at || new Date().toISOString()),
        updated_at: String(row.updated_at || new Date().toISOString()),
      }));
      writeLocalStoreDiscounts(records);
    }
  } catch (_err) {
    // Table may not exist yet in remote schema cache
  }

  if (records === null) {
    const settingsDiscounts = await readSettingsFallbackDiscounts(authToken);
    if (settingsDiscounts !== null) {
      records = settingsDiscounts;
      writeLocalStoreDiscounts(records);
    } else {
      records = readLocalStoreDiscounts();
    }
  }

  const now = new Date();
  return records
    .map((r) => withDiscountStatus(r, now))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export async function getActiveDiscounts(now: Date = new Date()): Promise<DiscountRecord[]> {
  const all = await getAllDiscounts();
  return all.filter((d) => computeDiscountStatus(d, now) === 'Active');
}

export interface DiscountInput {
  name: string;
  discount_amount: number;
  package_ids: string[];
  start_date: string;
  end_date: string;
  is_active: boolean;
}

export async function validateDiscountInput(
  input: DiscountInput,
  existingDiscounts: DiscountRecord[],
  editingDiscountId?: string
): Promise<{ valid: boolean; error?: string; sanitized?: DiscountInput }> {
  const name = String(input.name || '').trim();
  if (!name) {
    return { valid: false, error: 'Discount name is required.' };
  }

  const discountAmount = Number(input.discount_amount);
  if (!Number.isFinite(discountAmount) || discountAmount <= 0) {
    return { valid: false, error: 'Discount amount must be a positive fixed LKR amount greater than 0.' };
  }

  const packageIds = Array.isArray(input.package_ids)
    ? Array.from(new Set(input.package_ids.map((id) => String(id).trim()).filter(Boolean)))
    : [];

  if (packageIds.length === 0) {
    return { valid: false, error: 'Please select at least one VPN package for this discount.' };
  }

  const startDate = new Date(input.start_date);
  const endDate = new Date(input.end_date);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return { valid: false, error: 'Valid start date and expiry date are required.' };
  }

  if (endDate.getTime() <= startDate.getTime()) {
    return { valid: false, error: 'Expiry date must be after the start date.' };
  }

  // Validate package IDs and ensure discount does not exceed any selected package's original price
  const catalog = await getAllAvailablePackages();
  const catalogById = new Map(catalog.map((p) => [p.id, p]));

  for (const pkgId of packageIds) {
    const pkg = catalogById.get(pkgId);
    if (!pkg) {
      return { valid: false, error: `Selected package "${pkgId}" does not exist.` };
    }
    if (discountAmount > pkg.basePrice) {
      return {
        valid: false,
        error: `Discount amount (LKR ${discountAmount}) cannot exceed the original price of "${pkg.name}" (LKR ${pkg.basePrice}).`,
      };
    }
    if (pkg.basePrice - discountAmount < 0) {
      return {
        valid: false,
        error: `Discount cannot reduce the price of "${pkg.name}" below LKR 0.`,
      };
    }
  }

  const isActive = Boolean(input.is_active);

  // Prevent conflicting active discounts on the same package during overlapping date windows
  if (isActive) {
    const nowMs = Date.now();
    for (const other of existingDiscounts) {
      if (editingDiscountId && other.id === editingDiscountId) continue;
      if (!other.is_active) continue;

      const otherStartMs = new Date(other.start_date).getTime();
      const otherEndMs = new Date(other.end_date).getTime();

      // Ignore already expired discounts
      if (otherEndMs < nowMs) continue;

      // Check date overlap: startA <= endB && endA >= startB
      const overlapsInTime =
        startDate.getTime() <= otherEndMs && endDate.getTime() >= otherStartMs;

      if (overlapsInTime) {
        const overlappingPackages = packageIds.filter((pid) =>
          other.package_ids.includes(pid)
        );
        if (overlappingPackages.length > 0) {
          const overlappingNames = overlappingPackages
            .map((pid) => catalogById.get(pid)?.name || pid)
            .join(', ');
          return {
            valid: false,
            error: `Conflicting discount detected: Package(s) [${overlappingNames}] already have an active or scheduled discount ("${other.name}") during this period. Only one active discount can apply to a package at a time.`,
          };
        }
      }
    }
  }

  return {
    valid: true,
    sanitized: {
      name,
      discount_amount: Math.round(discountAmount * 100) / 100,
      package_ids: packageIds,
      start_date: startDate.toISOString(),
      end_date: endDate.toISOString(),
      is_active: isActive,
    },
  };
}

export async function createDiscount(input: DiscountInput, authToken?: string): Promise<DiscountRecord> {
  const existing = await getAllDiscounts(authToken);
  const validation = await validateDiscountInput(input, existing);
  if (!validation.valid || !validation.sanitized) {
    throw new Error(validation.error || 'Invalid discount parameters.');
  }

  const nowIso = new Date().toISOString();
  const newRecord: DiscountRecord = {
    id: crypto.randomUUID(),
    ...validation.sanitized,
    created_at: nowIso,
    updated_at: nowIso,
  };

  const client = getAuthenticatedSupabase(authToken);
  try {
    const { data, error } = await client
      .from('discounts')
      .insert([
        {
          id: newRecord.id,
          name: newRecord.name,
          discount_amount: newRecord.discount_amount,
          package_ids: newRecord.package_ids,
          start_date: newRecord.start_date,
          end_date: newRecord.end_date,
          is_active: newRecord.is_active,
          created_at: newRecord.created_at,
          updated_at: newRecord.updated_at,
        },
      ])
      .select()
      .maybeSingle();

    if (!error && data) {
      newRecord.id = String(data.id);
    }
  } catch (_err) {
    // Table may not exist yet; handled by fallback store
  }

  const updatedList = [
    newRecord,
    ...existing.filter((d) => d.id !== newRecord.id).map(({ status, ...rest }) => rest),
  ];
  await writeSettingsFallbackDiscounts(updatedList, authToken);

  return withDiscountStatus(newRecord);
}

export async function updateDiscount(
  id: string,
  input: Partial<DiscountInput>,
  authToken?: string
): Promise<DiscountRecord> {
  const existing = await getAllDiscounts(authToken);
  const target = existing.find((d) => d.id === id);
  if (!target) {
    throw new Error('Discount not found.');
  }

  const mergedInput: DiscountInput = {
    name: input.name !== undefined ? input.name : target.name,
    discount_amount: input.discount_amount !== undefined ? Number(input.discount_amount) : target.discount_amount,
    package_ids: input.package_ids !== undefined ? input.package_ids : target.package_ids,
    start_date: input.start_date !== undefined ? input.start_date : target.start_date,
    end_date: input.end_date !== undefined ? input.end_date : target.end_date,
    is_active: input.is_active !== undefined ? Boolean(input.is_active) : target.is_active,
  };

  const validation = await validateDiscountInput(mergedInput, existing, id);
  if (!validation.valid || !validation.sanitized) {
    throw new Error(validation.error || 'Invalid discount update parameters.');
  }

  const nowIso = new Date().toISOString();
  const updatedRecord: DiscountRecord = {
    id: target.id,
    ...validation.sanitized,
    created_at: target.created_at,
    updated_at: nowIso,
  };

  const client = getAuthenticatedSupabase(authToken);
  try {
    await client
      .from('discounts')
      .update({
        name: updatedRecord.name,
        discount_amount: updatedRecord.discount_amount,
        package_ids: updatedRecord.package_ids,
        start_date: updatedRecord.start_date,
        end_date: updatedRecord.end_date,
        is_active: updatedRecord.is_active,
        updated_at: updatedRecord.updated_at,
      })
      .eq('id', id);
  } catch (_err) {
    // ignore
  }

  const updatedList = existing.map((d) => {
    const { status, ...rest } = d;
    return d.id === id ? updatedRecord : rest;
  });
  await writeSettingsFallbackDiscounts(updatedList, authToken);

  return withDiscountStatus(updatedRecord);
}

export async function deleteDiscount(id: string, authToken?: string): Promise<void> {
  const existing = await getAllDiscounts(authToken);
  const target = existing.find((d) => d.id === id);
  if (!target) {
    throw new Error('Discount not found.');
  }

  const client = getAuthenticatedSupabase(authToken);
  try {
    await client.from('discounts').delete().eq('id', id);
  } catch (_err) {
    // ignore
  }

  const remaining = existing
    .filter((d) => d.id !== id)
    .map(({ status, ...rest }) => rest);
  await writeSettingsFallbackDiscounts(remaining, authToken);
}

/**
 * Resolves package ID from either packageId or packageName
 */
export async function resolvePackageId(packageId?: string, packageName?: string): Promise<string | null> {
  const catalog = await getAllAvailablePackages();
  if (packageId) {
    const cleanId = String(packageId).trim();
    const matchById = catalog.find((p) => p.id.toLowerCase() === cleanId.toLowerCase());
    if (matchById) return matchById.id;
  }
  if (packageName) {
    const cleanName = String(packageName).trim().toLowerCase();
    const matchByName = catalog.find(
      (p) => p.name.toLowerCase() === cleanName || p.id.toLowerCase() === cleanName.replace(/[^a-z0-9]+/g, '_')
    );
    if (matchByName) return matchByName.id;
  }
  return packageId ? String(packageId).trim() : null;
}

export function getBaseOriginalPrice(
  category: 'SIM' | 'ROUTER' | string,
  packageType: '100GB' | 'Unlimited' | string,
  duration: string | number
): number {
  const normCategory = String(category || 'SIM').toUpperCase();
  const normPkgType = String(packageType || '100GB');

  let baseMonthly = 200;
  if (normCategory === 'ROUTER') {
    baseMonthly = 600;
  } else if (normPkgType.toLowerCase().includes('unlimited')) {
    baseMonthly = 400;
  } else {
    baseMonthly = 200;
  }

  const durationStr = String(duration || '1 Month');
  let months = 1;
  if (durationStr.includes('12')) months = 12;
  else if (durationStr.includes('6')) months = 6;
  else if (durationStr.includes('3')) months = 3;
  else {
    const parsed = parseInt(durationStr, 10);
    if (!isNaN(parsed) && parsed > 0) months = parsed;
  }

  return baseMonthly * months;
}

export interface VerifiedPriceResult {
  packageId: string | null;
  originalPrice: number;
  discountAmount: number;
  finalPrice: number;
  appliedDiscount: {
    id: string;
    name: string;
    discount_amount: number;
  } | null;
}

export async function calculateVerifiedOrderPrice(params: {
  packageId?: string;
  packageName?: string;
  category?: string;
  packageType?: string;
  duration?: string | number;
  overrideOriginalPrice?: number;
}): Promise<VerifiedPriceResult> {
  const resolvedPkgId = await resolvePackageId(params.packageId, params.packageName);
  const catalog = await getAllAvailablePackages();
  const pkgInfo = resolvedPkgId ? catalog.find((p) => p.id === resolvedPkgId) : undefined;

  const effectiveCategory = params.category || pkgInfo?.category || 'SIM';
  const effectivePackageType = params.packageType || pkgInfo?.defaultPackageType || '100GB';
  const originalPrice =
    typeof params.overrideOriginalPrice === 'number' && params.overrideOriginalPrice > 0
      ? params.overrideOriginalPrice
      : getBaseOriginalPrice(effectiveCategory, effectivePackageType, params.duration || '1 Month');

  if (!resolvedPkgId) {
    return {
      packageId: null,
      originalPrice,
      discountAmount: 0,
      finalPrice: originalPrice,
      appliedDiscount: null,
    };
  }

  const activeDiscounts = await getActiveDiscounts(new Date());
  // Find the single active discount that includes this packageId
  const matchingDiscount = activeDiscounts.find((d) => d.package_ids.includes(resolvedPkgId)) || null;

  if (!matchingDiscount) {
    return {
      packageId: resolvedPkgId,
      originalPrice,
      discountAmount: 0,
      finalPrice: originalPrice,
      appliedDiscount: null,
    };
  }

  const rawDiscount = Number(matchingDiscount.discount_amount || 0);
  // Enforce rules: never negative, never exceed originalPrice, never reduce finalPrice below 0
  if (rawDiscount <= 0 || rawDiscount > originalPrice) {
    return {
      packageId: resolvedPkgId,
      originalPrice,
      discountAmount: 0,
      finalPrice: originalPrice,
      appliedDiscount: null,
    };
  }

  const discountAmount = Math.min(rawDiscount, originalPrice);
  const finalPrice = Math.max(0, originalPrice - discountAmount);

  return {
    packageId: resolvedPkgId,
    originalPrice,
    discountAmount,
    finalPrice,
    appliedDiscount: {
      id: matchingDiscount.id,
      name: matchingDiscount.name,
      discount_amount: discountAmount,
    },
  };
}
