import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { supabase, supabaseAdmin, getAuthenticatedSupabase } from '../../lib/supabase.js';

export type DiscountStatus = 'Active' | 'Scheduled' | 'Expired' | 'Disabled';
export type DiscountType = 'fixed' | 'percentage';

export interface DiscountRecord {
  id: string;
  name: string;
  description: string;
  discount_type?: DiscountType;
  discount_amount: number; // Fixed LKR amount when discount_type === 'fixed', or percentage (1-100) when discount_type === 'percentage'
  discount_percentage?: number | null;
  package_ids: string[]; // Specific package IDs, or ['*'] / ['all'] for all packages
  start_date: string | null;
  end_date: string | null;
  is_active: boolean;
  banner_text?: string | null;
  badge_text?: string | null;
  created_at: string;
  updated_at: string;
}

export interface StorePackageDefinition {
  id: string;
  name: string;
  category: 'SIM' | 'ROUTER';
  packageType: 'SIM 100GB' | 'SIM Unlimited' | 'Router Unlimited';
  tierKey: 'sim100' | 'simUnlimited' | 'routerUnlimited';
  basePrice: number;
}

export interface PlanPricingConfig {
  sim100: number;
  simUnlimited: number;
  routerUnlimited: number;
  packagePrices?: Record<string, number>;
}

export const DEFAULT_PLAN_PRICING: PlanPricingConfig = {
  sim100: 200,
  simUnlimited: 400,
  routerUnlimited: 600,
  packagePrices: {},
};

export const DEFAULT_STORE_PACKAGES: StorePackageDefinition[] = [
  { id: 'dialog_router', name: 'DIALOG ROUTER PACKAGE', category: 'ROUTER', packageType: 'Router Unlimited', tierKey: 'routerUnlimited', basePrice: 600 },
  { id: 'hutch_zoom', name: 'HUTCH ZOOM PACKAGE', category: 'SIM', packageType: 'SIM 100GB', tierKey: 'sim100', basePrice: 200 },
  { id: 'dialog_zoom_224', name: 'DIALOG ZOOM 224', category: 'SIM', packageType: 'SIM 100GB', tierKey: 'sim100', basePrice: 200 },
  { id: 'airtel_tiktok', name: 'AIRTEL TIKTOK PACKAGE', category: 'SIM', packageType: 'SIM Unlimited', tierKey: 'simUnlimited', basePrice: 400 },
  { id: 'airtel_zoom', name: 'AIRTEL ZOOM 225', category: 'SIM', packageType: 'SIM Unlimited', tierKey: 'simUnlimited', basePrice: 400 },
  { id: 'hutch_tu_299', name: 'HUTCH TU 299', category: 'SIM', packageType: 'SIM Unlimited', tierKey: 'simUnlimited', basePrice: 400 },
  { id: 'hutch_gaming', name: 'HUTCH GAMING PACKAGE', category: 'SIM', packageType: 'SIM Unlimited', tierKey: 'simUnlimited', basePrice: 400 },
  { id: 'dialog_tiktok', name: 'DIALOG TIKTOK', category: 'SIM', packageType: 'SIM 100GB', tierKey: 'sim100', basePrice: 200 },
  { id: 'dialog_social', name: 'DIALOG SOCIAL MEDIA', category: 'SIM', packageType: 'SIM 100GB', tierKey: 'sim100', basePrice: 200 },
  { id: 'slt_zoom', name: 'SLT FIBER ZOOM', category: 'ROUTER', packageType: 'Router Unlimited', tierKey: 'routerUnlimited', basePrice: 600 },
  { id: 'slt_netflix', name: 'SLT FIBER NETFLIX', category: 'ROUTER', packageType: 'Router Unlimited', tierKey: 'routerUnlimited', basePrice: 600 },
  { id: 'mobitel_zoom', name: 'MOBITEL ZOOM 224', category: 'SIM', packageType: 'SIM Unlimited', tierKey: 'simUnlimited', basePrice: 400 },
  { id: 'hutch_social', name: 'HUTCH SOCIAL MEDIA', category: 'SIM', packageType: 'SIM Unlimited', tierKey: 'simUnlimited', basePrice: 400 },
];

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DISCOUNTS_FILE = path.join(DATA_DIR, 'discounts.json');
const SETTINGS_FALLBACK_ID = 'discounts_management';
const APP_SETTINGS_ID = 'app';

let cachedPlanPricing: { config: PlanPricingConfig; fetchedAt: number } | null = null;
const PRICING_CACHE_TTL_MS = 2000; // 2 seconds max cache to keep Store & Checkout responsive while always fresh

export function invalidatePricingCache(): void {
  cachedPlanPricing = null;
}

function getDbClient(authToken?: string) {
  if (supabaseAdmin) return supabaseAdmin;
  if (authToken) return getAuthenticatedSupabase(authToken);
  return supabase;
}

/**
 * Fetches the authoritative package pricing configuration from Supabase `settings` (id = 'app').
 * Always falls back safely to DEFAULT_PLAN_PRICING if a field is unset.
 */
export async function getLivePlanPricing(forceRefresh = false, authToken?: string): Promise<PlanPricingConfig> {
  if (!forceRefresh && cachedPlanPricing && Date.now() - cachedPlanPricing.fetchedAt < PRICING_CACHE_TTL_MS) {
    return cachedPlanPricing.config;
  }

  const client = getDbClient(authToken);
  try {
    const { data, error } = await client
      .from('settings')
      .select('data')
      .eq('id', APP_SETTINGS_ID)
      .maybeSingle();

    if (!error && data?.data) {
      const rawPlans = data.data.plans || {};
      const rawPackagePrices = data.data.packagePrices || {};

      const sim100 = Number(rawPlans.sim100);
      const simUnlimited = Number(rawPlans.simUnlimited);
      const routerUnlimited = Number(rawPlans.routerUnlimited);

      const packagePrices: Record<string, number> = {};
      if (rawPackagePrices && typeof rawPackagePrices === 'object') {
        for (const [k, v] of Object.entries(rawPackagePrices)) {
          const num = Number(v);
          if (Number.isFinite(num) && num > 0) {
            packagePrices[String(k).trim()] = Math.round(num);
          }
        }
      }

      const config: PlanPricingConfig = {
        sim100: Number.isFinite(sim100) && sim100 > 0 ? Math.round(sim100) : DEFAULT_PLAN_PRICING.sim100,
        simUnlimited: Number.isFinite(simUnlimited) && simUnlimited > 0 ? Math.round(simUnlimited) : DEFAULT_PLAN_PRICING.simUnlimited,
        routerUnlimited: Number.isFinite(routerUnlimited) && routerUnlimited > 0 ? Math.round(routerUnlimited) : DEFAULT_PLAN_PRICING.routerUnlimited,
        packagePrices,
      };

      cachedPlanPricing = { config, fetchedAt: Date.now() };
      return config;
    }
  } catch (err: any) {
    console.warn('[DiscountService] Failed to read settings(app) from Supabase, using defaults:', err?.message || err);
  }

  return cachedPlanPricing?.config || { ...DEFAULT_PLAN_PRICING };
}

/**
 * Persists updated package pricing into Supabase `settings` (id = 'app') and invalidates cache.
 */
export async function saveLivePlanPricing(
  updates: Partial<PlanPricingConfig>,
  authToken?: string
): Promise<PlanPricingConfig> {
  const client = getDbClient(authToken);
  const { data: existingRow } = await client
    .from('settings')
    .select('data')
    .eq('id', APP_SETTINGS_ID)
    .maybeSingle();

  const existingData = existingRow?.data && typeof existingRow.data === 'object' ? existingRow.data : {};
  const existingPlans = existingData.plans && typeof existingData.plans === 'object' ? existingData.plans : {};
  const existingPackagePrices =
    existingData.packagePrices && typeof existingData.packagePrices === 'object' ? existingData.packagePrices : {};

  const sim100 = Number(updates.sim100 ?? existingPlans.sim100 ?? DEFAULT_PLAN_PRICING.sim100);
  const simUnlimited = Number(updates.simUnlimited ?? existingPlans.simUnlimited ?? DEFAULT_PLAN_PRICING.simUnlimited);
  const routerUnlimited = Number(
    updates.routerUnlimited ?? existingPlans.routerUnlimited ?? DEFAULT_PLAN_PRICING.routerUnlimited
  );

  if (!Number.isFinite(sim100) || sim100 <= 0) {
    throw new Error('SIM 100GB price must be greater than 0.');
  }
  if (!Number.isFinite(simUnlimited) || simUnlimited <= 0) {
    throw new Error('SIM Unlimited price must be greater than 0.');
  }
  if (!Number.isFinite(routerUnlimited) || routerUnlimited <= 0) {
    throw new Error('Router Unlimited price must be greater than 0.');
  }

  const mergedPackagePrices: Record<string, number> = { ...existingPackagePrices };
  if (updates.packagePrices && typeof updates.packagePrices === 'object') {
    for (const [k, v] of Object.entries(updates.packagePrices)) {
      const num = Number(v);
      if (Number.isFinite(num) && num > 0) {
        mergedPackagePrices[String(k).trim()] = Math.round(num);
      } else {
        delete mergedPackagePrices[String(k).trim()];
      }
    }
  }

  const nextPlans = {
    ...existingPlans,
    sim100: Math.round(sim100),
    simUnlimited: Math.round(simUnlimited),
    routerUnlimited: Math.round(routerUnlimited),
  };

  const nextData = {
    ...existingData,
    plans: nextPlans,
    packagePrices: mergedPackagePrices,
  };

  const { error } = await client.from('settings').upsert(
    {
      id: APP_SETTINGS_ID,
      data: nextData,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );

  if (error) {
    throw new Error(`Failed to save package prices in Supabase: ${error.message}`);
  }

  invalidatePricingCache();
  return getLivePlanPricing(true, authToken);
}

function getTierBasePrice(tierKey: 'sim100' | 'simUnlimited' | 'routerUnlimited', pricing: PlanPricingConfig, pkgId?: string): number {
  if (pkgId && pricing.packagePrices && Number(pricing.packagePrices[pkgId]) > 0) {
    return Math.round(Number(pricing.packagePrices[pkgId]));
  }
  if (tierKey === 'routerUnlimited') return pricing.routerUnlimited;
  if (tierKey === 'simUnlimited') return pricing.simUnlimited;
  return pricing.sim100;
}

function readLocalDiscounts(): DiscountRecord[] {
  try {
    if (!fs.existsSync(DISCOUNTS_FILE)) return [];
    const raw = fs.readFileSync(DISCOUNTS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(normalizeDiscountRow);
    return [];
  } catch (err) {
    console.warn('[DiscountService] Failed to read local discounts.json:', err);
    return [];
  }
}

function writeLocalDiscounts(records: DiscountRecord[]): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DISCOUNTS_FILE, JSON.stringify(records, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[DiscountService] Failed to write local discounts.json:', err);
  }
}

async function readSettingsFallbackDiscounts(authToken?: string): Promise<DiscountRecord[] | null> {
  try {
    const client = getDbClient(authToken);
    const { data, error } = await client
      .from('settings')
      .select('data')
      .eq('id', SETTINGS_FALLBACK_ID)
      .maybeSingle();

    if (!error && data?.data && Array.isArray(data.data.discounts)) {
      return data.data.discounts.map(normalizeDiscountRow);
    }
    return null;
  } catch (_err) {
    return null;
  }
}

async function writeSettingsFallbackDiscounts(records: DiscountRecord[], authToken?: string): Promise<boolean> {
  try {
    const client = getDbClient(authToken);
    const { error } = await client
      .from('settings')
      .upsert(
        {
          id: SETTINGS_FALLBACK_ID,
          data: { discounts: records },
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      );
    if (error) {
      console.warn('[DiscountService] Supabase settings upsert error:', error.message);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn('[DiscountService] Supabase settings upsert exception:', err?.message || err);
    return false;
  }
}

export function normalizeDiscountRow(row: any): DiscountRecord {
  let pkgIds: string[] = [];
  if (Array.isArray(row.package_ids)) {
    pkgIds = row.package_ids.map((id: any) => String(id).trim()).filter(Boolean);
  } else if (typeof row.package_ids === 'string') {
    try {
      const parsed = JSON.parse(row.package_ids);
      if (Array.isArray(parsed)) {
        pkgIds = parsed.map((id: any) => String(id).trim()).filter(Boolean);
      }
    } catch {
      pkgIds = row.package_ids
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
    }
  } else if (row.package_id) {
    pkgIds = [String(row.package_id).trim()];
  }

  const rawType = String(row.discount_type || 'fixed').toLowerCase().trim();
  const discountType: DiscountType = rawType === 'percentage' || rawType === 'percent' ? 'percentage' : 'fixed';
  const rawAmount = Number(row.discount_amount ?? row.discount_value ?? row.discount_percentage) || 0;
  const discountPercentage =
    discountType === 'percentage'
      ? Math.min(100, Math.max(0, rawAmount))
      : row.discount_percentage != null
      ? Number(row.discount_percentage)
      : null;

  return {
    id: String(row.id || crypto.randomUUID()),
    name: String(row.name || 'Special Offer').trim(),
    description: String(row.description || '').trim(),
    discount_type: discountType,
    discount_amount: rawAmount,
    discount_percentage: discountPercentage,
    package_ids: pkgIds,
    start_date: row.start_date ? String(row.start_date) : null,
    end_date: row.end_date ? String(row.end_date) : null,
    is_active: Boolean(row.is_active ?? true),
    banner_text: row.banner_text ? String(row.banner_text).trim() : null,
    badge_text: row.badge_text ? String(row.badge_text).trim() : null,
    created_at: row.created_at ? String(row.created_at) : new Date().toISOString(),
    updated_at: row.updated_at ? String(row.updated_at) : new Date().toISOString(),
  };
}

export function computeDiscountStatus(discount: DiscountRecord, nowMs: number = Date.now()): DiscountStatus {
  if (!discount.is_active) {
    return 'Disabled';
  }
  if (discount.start_date) {
    const startMs = new Date(discount.start_date).getTime();
    if (!isNaN(startMs) && nowMs < startMs) {
      return 'Scheduled';
    }
  }
  if (discount.end_date) {
    const endMs = new Date(discount.end_date).getTime();
    if (!isNaN(endMs) && nowMs > endMs) {
      return 'Expired';
    }
  }
  return 'Active';
}

export function isDiscountCurrentlyActive(discount: DiscountRecord, nowMs: number = Date.now()): boolean {
  return computeDiscountStatus(discount, nowMs) === 'Active';
}

export function isAllPackagesDiscount(discount: DiscountRecord): boolean {
  return discount.package_ids.some((id) => {
    const clean = id.trim().toLowerCase();
    return clean === '*' || clean === 'all' || clean === 'all_packages';
  });
}

export function discountAppliesToPackage(
  discount: DiscountRecord,
  packageId?: string | null,
  packageName?: string | null
): boolean {
  if (isAllPackagesDiscount(discount)) {
    return true;
  }

  const targetIds: string[] = [];
  if (packageId) targetIds.push(String(packageId).trim().toLowerCase());

  if (packageName) {
    const cleanName = String(packageName).trim().toLowerCase();
    targetIds.push(cleanName);
    const matchedPkg = DEFAULT_STORE_PACKAGES.find(
      (p) => p.name.toLowerCase() === cleanName || p.id.toLowerCase() === cleanName
    );
    if (matchedPkg) {
      targetIds.push(matchedPkg.id.toLowerCase());
    }
  }

  if (targetIds.length === 0) return false;

  return discount.package_ids.some((id) => targetIds.includes(String(id).trim().toLowerCase()));
}

export async function getAllAvailablePackages(authToken?: string, forceRefreshPricing = false): Promise<StorePackageDefinition[]> {
  const pricing = await getLivePlanPricing(forceRefreshPricing, authToken);
  const packagesMap = new Map<string, StorePackageDefinition>();

  for (const pkg of DEFAULT_STORE_PACKAGES) {
    packagesMap.set(pkg.id, {
      ...pkg,
      basePrice: getTierBasePrice(pkg.tierKey, pricing, pkg.id),
    });
  }

  try {
    const client = getDbClient(authToken);
    const { data, error } = await client.from('provision_templates').select('id, package_name, category');
    if (!error && Array.isArray(data)) {
      for (const row of data) {
        const rawName = String(row.package_name || '').trim();
        if (!rawName) continue;
        const matchedExisting = Array.from(packagesMap.values()).find(
          (p) => p.name.toLowerCase() === rawName.toLowerCase() || p.id.toLowerCase() === String(row.id).toLowerCase()
        );
        if (!matchedExisting) {
          const cat = String(row.category || 'SIM').toUpperCase() === 'ROUTER' ? 'ROUTER' : 'SIM';
          const tierKey = cat === 'ROUTER' ? 'routerUnlimited' : 'simUnlimited';
          const pkgId = String(row.id);
          packagesMap.set(pkgId, {
            id: pkgId,
            name: rawName,
            category: cat,
            packageType: cat === 'ROUTER' ? 'Router Unlimited' : 'SIM Unlimited',
            tierKey,
            basePrice: getTierBasePrice(tierKey, pricing, pkgId),
          });
        }
      }
    }
  } catch (_err) {
    // Ignore provision_templates query errors safely
  }

  return Array.from(packagesMap.values());
}

export async function getAllDiscounts(authToken?: string): Promise<DiscountRecord[]> {
  const client = getDbClient(authToken);
  let records: DiscountRecord[] | null = null;

  // 1. Read from settings('discounts_management') first as primary cross-environment store
  const settingsRecords = await readSettingsFallbackDiscounts(authToken);

  // 2. Also check dedicated 'discounts' table if it exists in Supabase
  try {
    const { data, error } = await client
      .from('discounts')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && Array.isArray(data) && data.length > 0) {
      records = data.map(normalizeDiscountRow);
    }
  } catch (_err) {
    // Fallback to settings table
  }

  // Prefer settings('discounts_management') whenever present (or when discounts table doesn't exist / is empty)
  if (!records || (settingsRecords && settingsRecords.length > 0)) {
    records = settingsRecords;
  }

  // 3. Fallback to local file storage
  if (!records) {
    records = readLocalDiscounts();
  } else {
    writeLocalDiscounts(records);
  }

  return records.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export async function getActiveDiscounts(): Promise<DiscountRecord[]> {
  const all = await getAllDiscounts();
  const nowMs = Date.now();
  return all.filter((d) => isDiscountCurrentlyActive(d, nowMs));
}

async function persistAllDiscounts(records: DiscountRecord[], authToken?: string): Promise<void> {
  writeLocalDiscounts(records);
  await writeSettingsFallbackDiscounts(records, authToken);
}

export interface DiscountInputPayload {
  name: string;
  description?: string;
  discount_type?: DiscountType;
  discount_amount: number;
  discount_percentage?: number | null;
  package_ids: string[];
  start_date?: string | null;
  end_date?: string | null;
  is_active?: boolean;
  banner_text?: string | null;
  badge_text?: string | null;
}

export async function validateDiscountPayload(
  payload: DiscountInputPayload,
  existingDiscounts: DiscountRecord[],
  excludeDiscountId?: string,
  authToken?: string
): Promise<{ valid: boolean; error?: string; sanitized?: Omit<DiscountRecord, 'id' | 'created_at' | 'updated_at'> }> {
  const name = String(payload.name || '').trim();
  if (!name) {
    return { valid: false, error: 'Discount name / title is required.' };
  }

  const rawType = String(payload.discount_type || 'fixed').toLowerCase().trim();
  const discountType: DiscountType = rawType === 'percentage' || rawType === 'percent' ? 'percentage' : 'fixed';

  const amount = Number(payload.discount_amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      valid: false,
      error:
        discountType === 'percentage'
          ? 'Discount percentage must be greater than 0%.'
          : 'Discount amount (LKR) must be greater than 0.',
    };
  }

  if (discountType === 'percentage' && amount >= 100) {
    return {
      valid: false,
      error: 'Discount percentage must be less than 100% so the final package price remains greater than LKR 0.',
    };
  }

  const rawPackageIds = Array.isArray(payload.package_ids)
    ? Array.from(new Set(payload.package_ids.map((id) => String(id).trim()).filter(Boolean)))
    : [];

  if (rawPackageIds.length === 0) {
    return { valid: false, error: 'Please select at least one target package (or All Packages) for this discount.' };
  }

  const isAllTarget = rawPackageIds.some((id) => id === '*' || id.toLowerCase() === 'all');
  const packageIds = isAllTarget ? ['*'] : rawPackageIds;

  let startMs: number | null = null;
  let endMs: number | null = null;

  if (payload.start_date) {
    startMs = new Date(payload.start_date).getTime();
    if (isNaN(startMs)) {
      return { valid: false, error: 'Invalid start date format.' };
    }
  }

  if (payload.end_date) {
    endMs = new Date(payload.end_date).getTime();
    if (isNaN(endMs)) {
      return { valid: false, error: 'Invalid end date format.' };
    }
  }

  if (startMs !== null && endMs !== null && endMs <= startMs) {
    return { valid: false, error: 'End date must be after start date.' };
  }

  const availablePackages = await getAllAvailablePackages(authToken, true);
  const packagesToValidate = isAllTarget
    ? availablePackages
    : availablePackages.filter((p) => packageIds.includes(p.id));

  for (const pkg of packagesToValidate) {
    if (discountType === 'fixed' && amount >= pkg.basePrice) {
      return {
        valid: false,
        error: `Discount amount (LKR ${amount}) cannot be equal to or greater than the base price of "${pkg.name}" (LKR ${pkg.basePrice}). Final price must be greater than LKR 0.`,
      };
    }
  }

  const isActive = Boolean(payload.is_active ?? true);

  // Prevent multiple overlapping active discounts on the same package
  if (isActive) {
    const nowMs = Date.now();
    const candidateRecord: DiscountRecord = {
      id: excludeDiscountId || 'candidate',
      name,
      description: String(payload.description || '').trim(),
      discount_type: discountType,
      discount_amount: discountType === 'percentage' ? Number(amount) : Math.round(amount),
      discount_percentage: discountType === 'percentage' ? Number(amount) : null,
      package_ids: packageIds,
      start_date: payload.start_date ? new Date(payload.start_date).toISOString() : null,
      end_date: payload.end_date ? new Date(payload.end_date).toISOString() : null,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const candidateIsCurrentlyOrFutureActive = computeDiscountStatus(candidateRecord, nowMs) !== 'Expired';

    if (candidateIsCurrentlyOrFutureActive) {
      for (const existing of existingDiscounts) {
        if (excludeDiscountId && existing.id === excludeDiscountId) continue;
        if (!existing.is_active) continue;
        const existingStatus = computeDiscountStatus(existing, nowMs);
        if (existingStatus === 'Expired' || existingStatus === 'Disabled') continue;

        const existingIsAll = isAllPackagesDiscount(existing);
        const hasOverlap =
          isAllTarget ||
          existingIsAll ||
          packageIds.some((pkgId) => existing.package_ids.includes(pkgId));

        if (!hasOverlap) continue;

        const candStart = startMs ?? -Infinity;
        const candEnd = endMs ?? Infinity;
        const existStart = existing.start_date ? new Date(existing.start_date).getTime() : -Infinity;
        const existEnd = existing.end_date ? new Date(existing.end_date).getTime() : Infinity;

        if (candStart <= existEnd && existStart <= candEnd) {
          const overlapPkgId = isAllTarget
            ? existing.package_ids[0]
            : existingIsAll
            ? packageIds[0]
            : packageIds.find((id) => existing.package_ids.includes(id));
          const pkgName =
            overlapPkgId === '*'
              ? 'All Packages'
              : availablePackages.find((p) => p.id === overlapPkgId)?.name || overlapPkgId || 'selected package';
          return {
            valid: false,
            error: `Package "${pkgName}" already has an active or scheduled discount ("${existing.name}"). Only one active discount is allowed per package at a time.`,
          };
        }
      }
    }
  }

  return {
    valid: true,
    sanitized: {
      name,
      description: String(payload.description || '').trim(),
      discount_type: discountType,
      discount_amount: discountType === 'percentage' ? Number(amount) : Math.round(amount),
      discount_percentage: discountType === 'percentage' ? Number(amount) : null,
      package_ids: packageIds,
      start_date: payload.start_date ? new Date(payload.start_date).toISOString() : null,
      end_date: payload.end_date ? new Date(payload.end_date).toISOString() : null,
      is_active: isActive,
      banner_text: payload.banner_text ? String(payload.banner_text).trim() : null,
      badge_text: payload.badge_text ? String(payload.badge_text).trim() : null,
    },
  };
}

export async function createDiscount(payload: DiscountInputPayload, authToken?: string): Promise<DiscountRecord> {
  const existing = await getAllDiscounts(authToken);
  const validation = await validateDiscountPayload(payload, existing, undefined, authToken);
  if (!validation.valid || !validation.sanitized) {
    throw new Error(validation.error || 'Invalid discount payload');
  }

  const nowIso = new Date().toISOString();
  const newRecord: DiscountRecord = {
    id: crypto.randomUUID(),
    ...validation.sanitized,
    created_at: nowIso,
    updated_at: nowIso,
  };

  const client = getDbClient(authToken);
  try {
    await client.from('discounts').insert([newRecord]);
  } catch (_err) {
    // Fallback handled by persistAllDiscounts
  }

  const updatedList = [newRecord, ...existing];
  await persistAllDiscounts(updatedList, authToken);
  return newRecord;
}

export async function updateDiscount(
  id: string,
  payload: DiscountInputPayload,
  authToken?: string
): Promise<DiscountRecord> {
  const existing = await getAllDiscounts(authToken);
  const targetIdx = existing.findIndex((d) => d.id === id);
  if (targetIdx === -1) {
    throw new Error('Discount not found.');
  }

  const validation = await validateDiscountPayload(payload, existing, id, authToken);
  if (!validation.valid || !validation.sanitized) {
    throw new Error(validation.error || 'Invalid discount payload');
  }

  const updatedRecord: DiscountRecord = {
    ...existing[targetIdx],
    ...validation.sanitized,
    id,
    updated_at: new Date().toISOString(),
  };

  const client = getDbClient(authToken);
  try {
    await client.from('discounts').update(updatedRecord).eq('id', id);
  } catch (_err) {
    // Fallback handled by persistAllDiscounts
  }

  const updatedList = [...existing];
  updatedList[targetIdx] = updatedRecord;
  await persistAllDiscounts(updatedList, authToken);
  return updatedRecord;
}

export async function toggleDiscountStatus(
  id: string,
  isActive: boolean,
  authToken?: string
): Promise<DiscountRecord> {
  const existing = await getAllDiscounts(authToken);
  const target = existing.find((d) => d.id === id);
  if (!target) {
    throw new Error('Discount not found.');
  }

  return updateDiscount(
    id,
    {
      name: target.name,
      description: target.description,
      discount_type: target.discount_type || 'fixed',
      discount_amount: target.discount_amount,
      discount_percentage: target.discount_percentage,
      package_ids: target.package_ids,
      start_date: target.start_date,
      end_date: target.end_date,
      is_active: isActive,
      banner_text: target.banner_text,
      badge_text: target.badge_text,
    },
    authToken
  );
}

export async function deleteDiscount(id: string, authToken?: string): Promise<void> {
  const existing = await getAllDiscounts(authToken);
  const filtered = existing.filter((d) => d.id !== id);

  const client = getDbClient(authToken);
  try {
    await client.from('discounts').delete().eq('id', id);
  } catch (_err) {
    // Ignore if table doesn't exist
  }

  await persistAllDiscounts(filtered, authToken);
}

function parseDurationMonths(duration?: string): number {
  const norm = String(duration || '1 Month').trim();
  const durationMap: Record<string, number> = {
    '1 Month': 1,
    '3 Months': 3,
    '6 Months': 6,
    '12 Months': 12,
  };
  if (durationMap[norm]) return durationMap[norm];
  const parsedInt = parseInt(norm, 10);
  if (Number.isFinite(parsedInt) && parsedInt > 0) return parsedInt;
  return 1;
}

/**
 * Authoritative base price calculation using live Supabase settings('app') pricing.
 */
export function getBaseOriginalPriceWithConfig(
  pricing: PlanPricingConfig,
  params: {
    packageId?: string;
    packageName?: string;
    category?: string;
    packageType?: string;
    duration?: string;
  }
): { originalPrice: number; matchedPackage?: StorePackageDefinition; resolvedTier: 'sim100' | 'simUnlimited' | 'routerUnlimited' } {
  const normCategory = String(params.category || '').toUpperCase().trim();
  const normPkgType = String(params.packageType || '').toLowerCase().trim();
  const normPkgId = String(params.packageId || '').toLowerCase().trim();
  const normPkgName = String(params.packageName || '').toLowerCase().trim();

  const matchedPkg = DEFAULT_STORE_PACKAGES.find(
    (p) =>
      (normPkgId && p.id.toLowerCase() === normPkgId) ||
      (normPkgName && p.name.toLowerCase() === normPkgName)
  );

  // Determine the tier key ('sim100' | 'simUnlimited' | 'routerUnlimited')
  let resolvedTier: 'sim100' | 'simUnlimited' | 'routerUnlimited' = matchedPkg?.tierKey || 'sim100';

  if (normCategory === 'ROUTER' || normPkgType.includes('router')) {
    resolvedTier = 'routerUnlimited';
  } else if (normPkgType.includes('100gb') || normPkgType.includes('100 gb')) {
    resolvedTier = 'sim100';
  } else if (normPkgType.includes('unlimited')) {
    resolvedTier = 'simUnlimited';
  } else if (matchedPkg) {
    resolvedTier = matchedPkg.tierKey;
  }

  // If a per-package custom price override exists AND the customer is using the package's default tier, use it;
  // otherwise use the tier price from Supabase settings('app').plans
  let baseMonthly: number;
  const hasCustomOverride =
    matchedPkg &&
    pricing.packagePrices &&
    Number(pricing.packagePrices[matchedPkg.id]) > 0 &&
    resolvedTier === matchedPkg.tierKey;

  if (hasCustomOverride && matchedPkg && pricing.packagePrices) {
    baseMonthly = Math.round(Number(pricing.packagePrices[matchedPkg.id]));
  } else if (resolvedTier === 'routerUnlimited') {
    baseMonthly = pricing.routerUnlimited;
  } else if (resolvedTier === 'simUnlimited') {
    baseMonthly = pricing.simUnlimited;
  } else {
    baseMonthly = pricing.sim100;
  }

  const months = parseDurationMonths(params.duration);
  return {
    originalPrice: Math.round(baseMonthly * months),
    matchedPackage: matchedPkg,
    resolvedTier,
  };
}

/**
 * Synchronous helper for callers that already have PlanPricingConfig (defaults to DEFAULT_PLAN_PRICING).
 */
export function getBaseOriginalPrice(
  category?: string,
  packageType?: string,
  duration?: string,
  packageId?: string,
  pricing: PlanPricingConfig = DEFAULT_PLAN_PRICING
): number {
  return getBaseOriginalPriceWithConfig(pricing, {
    packageId,
    category,
    packageType,
    duration,
  }).originalPrice;
}

export interface PriceVerificationResult {
  packageId: string;
  packageName: string;
  originalPrice: number;
  discountAmount: number;
  discountPercentage: number;
  finalPrice: number;
  appliedDiscount: DiscountRecord | null;
  plans: PlanPricingConfig;
}

/**
 * Pure helper to calculate discounted price given an original price and an active discount record.
 * Ensures Fixed and Percentage discounts are never applied twice and finalPrice >= 0.
 */
export function applySingleDiscount(
  originalPrice: number,
  matchedDiscount: DiscountRecord | null
): {
  originalPrice: number;
  discountAmount: number;
  discountPercentage: number;
  finalPrice: number;
} {
  const safeOriginal = Math.max(0, Math.round(Number(originalPrice) || 0));
  if (!matchedDiscount) {
    return {
      originalPrice: safeOriginal,
      discountAmount: 0,
      discountPercentage: 0,
      finalPrice: safeOriginal,
    };
  }

  const discountType: DiscountType =
    matchedDiscount.discount_type === 'percentage' ? 'percentage' : 'fixed';

  let rawDiscount = 0;
  if (discountType === 'percentage') {
    const pct = Math.min(100, Math.max(0, Number(matchedDiscount.discount_amount) || 0));
    rawDiscount = Math.round((safeOriginal * pct) / 100);
  } else {
    rawDiscount = Math.max(0, Math.round(Number(matchedDiscount.discount_amount) || 0));
  }

  const discountAmount = Math.min(safeOriginal, rawDiscount);
  const finalPrice = Math.max(0, safeOriginal - discountAmount);
  const discountPercentage =
    discountType === 'percentage'
      ? Math.min(100, Math.max(0, Math.round(Number(matchedDiscount.discount_amount) || 0)))
      : safeOriginal > 0
      ? Math.round((discountAmount / safeOriginal) * 100)
      : 0;

  return {
    originalPrice: safeOriginal,
    discountAmount,
    discountPercentage,
    finalPrice,
  };
}

/**
 * Server-side authoritative order price calculation.
 * Always reads fresh package pricing from Supabase `settings` (id = 'app') and active discounts.
 */
export async function calculateVerifiedOrderPrice(params: {
  packageId?: string;
  packageName?: string;
  category?: string;
  packageType?: string;
  duration?: string;
  customPlans?: PlanPricingConfig;
  customDiscounts?: DiscountRecord[];
}): Promise<PriceVerificationResult> {
  const livePlans = params.customPlans || (await getLivePlanPricing(true));
  const { originalPrice, matchedPackage } = getBaseOriginalPriceWithConfig(livePlans, params);

  const resolvedPkgId = matchedPackage?.id || String(params.packageId || '').trim();
  const resolvedPkgName = matchedPackage?.name || String(params.packageName || '').trim();

  const activeDiscounts = params.customDiscounts
    ? params.customDiscounts.filter((d) => isDiscountCurrentlyActive(d))
    : await getActiveDiscounts();

  // Prefer a package-specific active discount first, otherwise an all-packages ('*') active discount
  const specificDiscount =
    activeDiscounts.find(
      (d) => !isAllPackagesDiscount(d) && discountAppliesToPackage(d, resolvedPkgId, resolvedPkgName)
    ) || null;
  const globalDiscount =
    activeDiscounts.find(
      (d) => isAllPackagesDiscount(d) && discountAppliesToPackage(d, resolvedPkgId, resolvedPkgName)
    ) || null;

  const matchedDiscount = specificDiscount || globalDiscount;
  const calc = applySingleDiscount(originalPrice, matchedDiscount);

  return {
    packageId: resolvedPkgId,
    packageName: resolvedPkgName,
    originalPrice: calc.originalPrice,
    discountAmount: calc.discountAmount,
    discountPercentage: calc.discountPercentage,
    finalPrice: calc.finalPrice,
    appliedDiscount: matchedDiscount,
    plans: livePlans,
  };
}
