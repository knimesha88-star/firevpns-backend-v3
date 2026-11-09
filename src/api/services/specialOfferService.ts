import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { supabase, supabaseAdmin, getAuthenticatedSupabase } from '../../lib/supabase.js';
import {
  PlanPricingConfig,
  StorePackageDefinition,
  getLivePlanPricing,
  getAllAvailablePackages,
  getBaseOriginalPriceWithConfig,
  findCanonicalPackage,
  resolveCanonicalPackageId,
  getAllIdentifiersForPackage,
  normalizeDiscountPackageIds,
} from './discountService.js';

export type SpecialOfferDurationMonths = 3 | 6;
export type SpecialOfferStatus = 'Active' | 'Hidden' | 'Scheduled' | 'Expired' | 'Disabled';

export interface SpecialOfferPackageBreakdown {
  package_id: string;
  package_name: string;
  category: 'SIM' | 'ROUTER';
  package_type: 'SIM 100GB' | 'SIM Unlimited' | 'Router Unlimited';
  monthly_price: number;
  original_total_price: number;
  promotional_price: number;
  amount_saved: number;
  discount_percentage: number;
  provider_logo?: string;
  template_id?: string;
}

export interface SpecialOfferRecord {
  id: string;
  name: string;
  description: string;
  duration_months: SpecialOfferDurationMonths;
  duration_days: 90 | 180;
  duration_label: '3 Months' | '6 Months';
  package_ids: string[];
  promotional_price: number;
  is_enabled: boolean;
  is_visible: boolean;
  start_date: string | null;
  end_date: string | null;
  banner_text: string | null;
  badge_text: string | null;
  created_at: string;
  updated_at: string;
  status?: SpecialOfferStatus;
  package_breakdowns?: SpecialOfferPackageBreakdown[];
  eligible_packages?: SpecialOfferPackageBreakdown[];
}

export interface SpecialOfferInputPayload {
  name: string;
  description?: string;
  duration_months: number;
  package_ids: string[];
  promotional_price: number;
  is_enabled?: boolean;
  is_visible?: boolean;
  start_date?: string | null;
  end_date?: string | null;
  banner_text?: string | null;
  badge_text?: string | null;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SPECIAL_OFFERS_FILE = path.join(DATA_DIR, 'special_offers.json');
const SETTINGS_SPECIAL_OFFERS_ID = 'special_offers_management';

function getDbClient(authToken?: string) {
  if (authToken) return getAuthenticatedSupabase(authToken);
  if (supabaseAdmin) return supabaseAdmin;
  return supabase;
}

export function normalizeSpecialOfferDuration(raw: any): SpecialOfferDurationMonths {
  const num = Number(raw);
  if (num === 6 || String(raw || '').toLowerCase().includes('6')) {
    return 6;
  }
  return 3;
}

export function normalizeSpecialOfferRow(row: any): SpecialOfferRecord {
  const durationMonths = normalizeSpecialOfferDuration(row.duration_months ?? row.duration);
  const pkgIds = normalizeDiscountPackageIds(row.package_ids, row.package_id).filter((id) => id !== '*');
  const promoPrice = Math.max(0, Math.round(Number(row.promotional_price ?? row.promo_price ?? 0)));

  return {
    id: String(row.id || crypto.randomUUID()),
    name: String(row.name || 'Special Offer').trim(),
    description: String(row.description || '').trim(),
    duration_months: durationMonths,
    duration_days: durationMonths === 6 ? 180 : 90,
    duration_label: durationMonths === 6 ? '6 Months' : '3 Months',
    package_ids: pkgIds,
    promotional_price: promoPrice,
    is_enabled: Boolean(row.is_enabled ?? row.is_active ?? true),
    is_visible: Boolean(row.is_visible ?? true),
    start_date: row.start_date ? String(row.start_date) : null,
    end_date: row.end_date ? String(row.end_date) : null,
    banner_text: row.banner_text ? String(row.banner_text).trim() : null,
    badge_text: row.badge_text ? String(row.badge_text).trim() : null,
    created_at: row.created_at ? String(row.created_at) : new Date().toISOString(),
    updated_at: row.updated_at ? String(row.updated_at) : new Date().toISOString(),
  };
}

export function computeSpecialOfferStatus(
  offer: SpecialOfferRecord,
  nowMs: number = Date.now()
): SpecialOfferStatus {
  if (!offer.is_enabled) {
    return 'Disabled';
  }
  if (offer.start_date) {
    const startMs = new Date(offer.start_date).getTime();
    if (!isNaN(startMs) && nowMs < startMs) {
      return 'Scheduled';
    }
  }
  if (offer.end_date) {
    const endMs = new Date(offer.end_date).getTime();
    if (!isNaN(endMs) && nowMs > endMs) {
      return 'Expired';
    }
  }
  if (!offer.is_visible) {
    return 'Hidden';
  }
  return 'Active';
}

export function isSpecialOfferActiveAndVisible(
  offer: SpecialOfferRecord,
  nowMs: number = Date.now()
): boolean {
  return computeSpecialOfferStatus(offer, nowMs) === 'Active';
}

export function resolveVpnAccountPackage(
  input: {
    packageId?: string | null;
    packageName?: string | null;
    configName?: string | null;
    remark?: string | null;
    dataLimit?: string | null;
    planId?: string | null;
    planName?: string | null;
    category?: string | null;
    packageType?: string | null;
  },
  availablePackages?: StorePackageDefinition[]
): {
  matchedPackage: StorePackageDefinition | null;
  canonicalPackageId: string;
  canonicalPackageName: string;
  category: 'SIM' | 'ROUTER';
  packageType: 'SIM 100GB' | 'SIM Unlimited' | 'Router Unlimited';
  planId: 'sim_100' | 'sim_unlimited' | 'router_unlimited';
  hasSpecificPackage: boolean;
} {
  const pkgList = availablePackages && availablePackages.length > 0 ? availablePackages : [];
  const candidateStrings = [
    input.packageId,
    input.packageName,
    input.configName,
    input.remark,
    input.planName,
  ]
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  let matchedPackage: StorePackageDefinition | null = null;

  for (const cand of candidateStrings) {
    const lowerCand = cand.toLowerCase();
    // Skip generic tier labels when searching for a specific ISP package first
    if (
      lowerCand === 'sim 100gb' ||
      lowerCand === 'sim_100' ||
      lowerCand === 'sim unlimited' ||
      lowerCand === 'sim_unlimited' ||
      lowerCand === 'router unlimited' ||
      lowerCand === 'router_unlimited'
    ) {
      continue;
    }

    const fromList = pkgList.find((p) => {
      const ids = getAllIdentifiersForPackage(p.id, p.name, [p.templateId, ...(p.aliases || [])]);
      return ids.has(lowerCand);
    });
    if (fromList) {
      matchedPackage = fromList;
      break;
    }

    const canonical = findCanonicalPackage(cand);
    if (canonical) {
      matchedPackage = canonical;
      break;
    }
  }

  // Fallback substring scan for remarks like "user_DIALOG_TIKTOK_100GB" or "HUTCH ZOOM - Unlimited"
  if (!matchedPackage) {
    const searchPool = pkgList.length > 0 ? pkgList : [];
    for (const cand of candidateStrings) {
      const normalizedCand = cand.toLowerCase().replace(/[_-]+/g, ' ');
      for (const pkg of searchPool) {
        const pkgNameLower = pkg.name.toLowerCase();
        const pkgIdSpaced = pkg.id.toLowerCase().replace(/[_-]+/g, ' ');
        if (
          (pkgNameLower.length >= 4 && normalizedCand.includes(pkgNameLower)) ||
          (pkgIdSpaced.length >= 4 && normalizedCand.includes(pkgIdSpaced))
        ) {
          matchedPackage = pkg;
          break;
        }
      }
      if (matchedPackage) break;
    }
  }

  // Determine tier / planId
  const rawPlanHint = [
    input.planId,
    input.packageType,
    input.planName,
    input.dataLimit,
    input.packageName,
    input.configName,
    input.remark,
  ]
    .map((s) => String(s || '').toLowerCase())
    .join(' ');

  let planId = 'sim_100' as 'sim_100' | 'sim_unlimited' | 'router_unlimited';
  if (
    input.planId === 'router_unlimited' ||
    String(input.category || '').toUpperCase() === 'ROUTER' ||
    matchedPackage?.category === 'ROUTER' ||
    rawPlanHint.includes('router') ||
    rawPlanHint.includes('fiber') ||
    rawPlanHint.includes('slt')
  ) {
    planId = 'router_unlimited';
  } else if (
    input.planId === 'sim_100' ||
    rawPlanHint.includes('100gb') ||
    rawPlanHint.includes('100 gb') ||
    rawPlanHint.includes('sim_100')
  ) {
    planId = 'sim_100';
  } else if (
    input.planId === 'sim_unlimited' ||
    rawPlanHint.includes('unlimited') ||
    rawPlanHint.includes('sim_unlimited')
  ) {
    planId = 'sim_unlimited';
  } else if (matchedPackage) {
    planId =
      String(matchedPackage.category) === 'ROUTER'
        ? 'router_unlimited'
        : matchedPackage.packageType === 'SIM Unlimited'
        ? 'sim_unlimited'
        : 'sim_100';
  }

  const category: 'SIM' | 'ROUTER' = planId === 'router_unlimited' ? 'ROUTER' : 'SIM';
  const packageType: 'SIM 100GB' | 'SIM Unlimited' | 'Router Unlimited' =
    planId === 'router_unlimited'
      ? 'Router Unlimited'
      : planId === 'sim_unlimited'
      ? 'SIM Unlimited'
      : 'SIM 100GB';

  return {
    matchedPackage,
    canonicalPackageId: matchedPackage?.id || planId,
    canonicalPackageName: matchedPackage?.name || packageType,
    category,
    packageType,
    planId,
    hasSpecificPackage: Boolean(matchedPackage),
  };
}

export function specialOfferAppliesToPackage(
  offer: SpecialOfferRecord,
  packageId?: string | null,
  packageName?: string | null,
  extraIds?: (string | null | undefined)[],
  availablePackages?: StorePackageDefinition[]
): boolean {
  if (!offer || !Array.isArray(offer.package_ids) || offer.package_ids.length === 0) {
    return false;
  }
  const normalizedOfferPkgIds = normalizeDiscountPackageIds(offer.package_ids);
  if (offer.package_ids.includes('*') || normalizedOfferPkgIds.includes('*')) {
    return true;
  }

  const targetIdentifiers = getAllIdentifiersForPackage(packageId, packageName, extraIds);
  if (targetIdentifiers.size === 0) return false;

  const offerIdSet = new Set<string>();
  for (const rawOfferPkgId of [...offer.package_ids, ...normalizedOfferPkgIds]) {
    const offerIdentifiers = getAllIdentifiersForPackage(rawOfferPkgId, rawOfferPkgId);
    for (const oId of offerIdentifiers) {
      offerIdSet.add(oId);
      if (targetIdentifiers.has(oId)) {
        return true;
      }
    }
  }

  // If the target is only identified by a generic tier (e.g. 'sim_100', 'sim_unlimited', 'router_unlimited')
  // and has no specific ISP package, check if the offer covers ALL enabled packages in that category.
  const resolved = resolveVpnAccountPackage(
    {
      packageId,
      packageName,
      configName: extraIds?.[0] || undefined,
      remark: extraIds?.[1] || undefined,
    },
    availablePackages
  );

  if (resolved.hasSpecificPackage && resolved.matchedPackage) {
    const specificIds = getAllIdentifiersForPackage(
      resolved.matchedPackage.id,
      resolved.matchedPackage.name,
      [resolved.matchedPackage.templateId, ...(resolved.matchedPackage.aliases || [])]
    );
    for (const sId of specificIds) {
      if (offerIdSet.has(sId)) {
        return true;
      }
    }
    return false;
  }

  // Generic tier-only account: eligible only if offer includes all enabled packages of that category
  if (availablePackages && availablePackages.length > 0) {
    const categoryPackages = availablePackages.filter(
      (p) => p.enabled !== false && p.category === resolved.category
    );
    if (
      categoryPackages.length > 0 &&
      categoryPackages.every((p) => offerIdSet.has(p.id.toLowerCase()))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Calculates the normal total price (`monthlyPrice * duration_months`), promotional price,
 * amount saved, and discount percentage for a given package under a Special Offer.
 * NEVER applies existing 1-month discounts twice; always uses the raw live monthly package price.
 * Does NOT silently alter the admin-defined `offer.promotional_price`.
 */
export function calculateSpecialOfferPackageBreakdown(
  offer: SpecialOfferRecord,
  pkg: StorePackageDefinition | { packageId: string; packageName: string; monthlyPrice: number; category?: 'SIM' | 'ROUTER'; packageType?: 'SIM 100GB' | 'SIM Unlimited' | 'Router Unlimited'; templateId?: string },
  pricing?: PlanPricingConfig
): SpecialOfferPackageBreakdown {
  const pkgId = 'id' in pkg ? pkg.id : pkg.packageId;
  const pkgName = 'name' in pkg ? pkg.name : pkg.packageName;
  const category: 'SIM' | 'ROUTER' = pkg.category || 'SIM';
  const packageType: 'SIM 100GB' | 'SIM Unlimited' | 'Router Unlimited' =
    pkg.packageType || (category === 'ROUTER' ? 'Router Unlimited' : 'SIM 100GB');

  let monthlyPrice = 0;
  if ('monthlyPrice' in pkg && typeof pkg.monthlyPrice === 'number' && pkg.monthlyPrice > 0) {
    monthlyPrice = Math.round(pkg.monthlyPrice);
  } else if (pricing) {
    const res = getBaseOriginalPriceWithConfig(pricing, {
      packageId: pkgId,
      packageName: pkgName,
      category,
      packageType,
      duration: '1 Month',
    });
    monthlyPrice = res.originalPrice;
  } else if ('basePrice' in pkg && typeof pkg.basePrice === 'number') {
    monthlyPrice = Math.round(pkg.basePrice);
  }

  const originalTotalPrice = Math.round(monthlyPrice * offer.duration_months);
  const promotionalPrice = Math.max(0, Math.round(offer.promotional_price));
  const amountSaved = Math.max(0, originalTotalPrice - promotionalPrice);
  const discountPercentage =
    originalTotalPrice > 0 ? Math.min(99, Math.max(0, Math.round((amountSaved / originalTotalPrice) * 100))) : 0;

  return {
    package_id: pkgId,
    package_name: pkgName,
    category,
    package_type: packageType,
    monthly_price: monthlyPrice,
    original_total_price: originalTotalPrice,
    promotional_price: promotionalPrice,
    amount_saved: amountSaved,
    discount_percentage: discountPercentage,
    template_id: pkg.templateId || pkgId,
  };
}

export function enrichSpecialOfferWithBreakdowns(
  offer: SpecialOfferRecord,
  availablePackages: StorePackageDefinition[],
  pricing: PlanPricingConfig,
  nowMs: number = Date.now()
): SpecialOfferRecord {
  const matchedPackages: StorePackageDefinition[] = [];
  for (const pkg of availablePackages) {
    if (pkg.enabled === false) continue;
    if (specialOfferAppliesToPackage(offer, pkg.id, pkg.name, [pkg.templateId, ...(pkg.aliases || [])])) {
      matchedPackages.push(pkg);
    }
  }

  const breakdowns = matchedPackages.map((pkg) =>
    calculateSpecialOfferPackageBreakdown(offer, pkg, pricing)
  );

  return {
    ...offer,
    duration_days: offer.duration_months === 6 ? 180 : 90,
    status: computeSpecialOfferStatus(offer, nowMs),
    package_breakdowns: breakdowns,
    eligible_packages: breakdowns,
  };
}

function readLocalSpecialOffers(): SpecialOfferRecord[] {
  try {
    if (!fs.existsSync(SPECIAL_OFFERS_FILE)) return [];
    const raw = fs.readFileSync(SPECIAL_OFFERS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(normalizeSpecialOfferRow);
    return [];
  } catch (err) {
    console.warn('[SpecialOfferService] Failed to read local special_offers.json:', err);
    return [];
  }
}

function writeLocalSpecialOffers(records: SpecialOfferRecord[]): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(SPECIAL_OFFERS_FILE, JSON.stringify(records, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[SpecialOfferService] Failed to write local special_offers.json:', err);
  }
}

function toSpecialOffersTableRow(record: SpecialOfferRecord) {
  return {
    id: record.id,
    name: record.name,
    description: record.description || '',
    duration_months: Number(record.duration_months) === 6 ? 6 : 3,
    package_ids: Array.isArray(record.package_ids) ? record.package_ids : [],
    promotional_price: Math.round(Number(record.promotional_price)),
    is_enabled: Boolean(record.is_enabled),
    is_visible: Boolean(record.is_visible),
    start_date: record.start_date || null,
    end_date: record.end_date || null,
    banner_text: record.banner_text || null,
    badge_text: record.badge_text || null,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function toCleanPersistedRecord(record: SpecialOfferRecord): Omit<SpecialOfferRecord, 'status' | 'package_breakdowns' | 'eligible_packages'> {
  const { status, package_breakdowns, eligible_packages, ...clean } = record;
  return clean;
}

/**
 * Ensures each package maintains its own independent 3-month and 6-month promotional offers.
 * Saving an offer for Package A (e.g., HUTCH ZOOM 3-month) never overwrites Package A's 6-month offer
 * or Package B's 3-month / 6-month offers. If an existing offer for the same duration already
 * included Package A, Package A is cleanly detached from that same-duration offer (or replaced if it was single-package).
 */
export function reconcilePackageDurationOffers(
  existingOffers: SpecialOfferRecord[],
  savedOffer: SpecialOfferRecord
): { reconciledList: SpecialOfferRecord[]; removedIds: string[]; updatedOffers: SpecialOfferRecord[] } {
  const targetDuration = normalizeSpecialOfferDuration(savedOffer.duration_months);
  const targetPkgSet = new Set(
    (savedOffer.package_ids || []).map((pid) => resolveCanonicalPackageId(pid).toLowerCase()).filter(Boolean)
  );

  const reconciledList: SpecialOfferRecord[] = [savedOffer];
  const removedIds: string[] = [];
  const updatedOffers: SpecialOfferRecord[] = [];

  for (const existing of existingOffers) {
    if (existing.id === savedOffer.id) {
      continue;
    }

    const existingDuration = normalizeSpecialOfferDuration(existing.duration_months);
    if (existingDuration !== targetDuration) {
      // Different duration (e.g., 6-month vs 3-month) -> preserve completely untouched
      reconciledList.push(existing);
      continue;
    }

    const existingPkgIds = Array.isArray(existing.package_ids) ? existing.package_ids : [];
    const remainingPkgIds = existingPkgIds.filter((pid) => {
      const canonical = resolveCanonicalPackageId(pid).toLowerCase();
      return !targetPkgSet.has(canonical);
    });

    if (remainingPkgIds.length === existingPkgIds.length) {
      // No overlapping packages -> preserve completely untouched
      reconciledList.push(existing);
    } else if (remainingPkgIds.length > 0) {
      // Detach only the overlapping package(s) so other packages keep their own promotional price
      const detachedOffer: SpecialOfferRecord = {
        ...existing,
        package_ids: remainingPkgIds,
        updated_at: new Date().toISOString(),
      };
      reconciledList.push(detachedOffer);
      updatedOffers.push(detachedOffer);
    } else {
      // Existing offer was exclusively for the same package(s) and same duration -> replaced by savedOffer
      removedIds.push(existing.id);
    }
  }

  return { reconciledList, removedIds, updatedOffers };
}

async function readSettingsSpecialOffers(authToken?: string): Promise<SpecialOfferRecord[] | null> {
  const clientsToTry = [
    ...(authToken ? [getAuthenticatedSupabase(authToken)] : []),
    ...(supabaseAdmin ? [supabaseAdmin] : []),
    supabase,
  ];

  for (const client of clientsToTry) {
    try {
      const { data, error } = await client
        .from('settings')
        .select('data')
        .eq('id', SETTINGS_SPECIAL_OFFERS_ID)
        .maybeSingle();

      if (!error && data?.data && Array.isArray(data.data.offers)) {
        return data.data.offers.map(normalizeSpecialOfferRow);
      }
    } catch (_err) {
      // Try next client
    }
  }
  return null;
}

async function writeSettingsSpecialOffers(
  records: SpecialOfferRecord[],
  authToken?: string
): Promise<{ ok: boolean; error?: string }> {
  const cleanRecords = records.map(toCleanPersistedRecord);
  const payload = {
    id: SETTINGS_SPECIAL_OFFERS_ID,
    data: { offers: cleanRecords },
    updated_at: new Date().toISOString(),
  };

  const clientsToTry: Array<{ label: string; client: any }> = [];
  if (authToken) {
    clientsToTry.push({ label: 'authenticated-user', client: getAuthenticatedSupabase(authToken) });
  }
  if (supabaseAdmin) {
    clientsToTry.push({ label: 'service-role-admin', client: supabaseAdmin });
  }
  if (clientsToTry.length === 0) {
    clientsToTry.push({ label: 'anon-client', client: supabase });
  }

  let lastErrorMsg = '';
  for (const { label, client } of clientsToTry) {
    try {
      const { error } = await client.from('settings').upsert(payload, { onConflict: 'id' });
      if (!error) {
        return { ok: true };
      }
      lastErrorMsg = `[${label}] ${error.code || 'DB_ERR'}: ${error.message}`;
      console.warn(`[SpecialOfferService] Settings upsert warning (${label}):`, {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
    } catch (err: any) {
      lastErrorMsg = `[${label}] ${err?.message || String(err)}`;
      console.warn(`[SpecialOfferService] Settings upsert exception (${label}):`, err?.message || err);
    }
  }

  return { ok: false, error: lastErrorMsg || 'Failed to persist special offers in Supabase settings.' };
}

/**
 * Deduplicates a list of SpecialOfferRecord items ordered from newest (updated_at DESC) to oldest
 * so that each (package_id, duration_months) pair has at most one authoritative offer, while
 * preserving every distinct package's 3-month and 6-month offers independently.
 */
export function deduplicateSpecialOffersByPackageAndDuration(
  offers: SpecialOfferRecord[]
): SpecialOfferRecord[] {
  const sortedNewestFirst = [...offers].sort(
    (a, b) =>
      new Date(b.updated_at || b.created_at || 0).getTime() -
      new Date(a.updated_at || a.created_at || 0).getTime()
  );

  const claimedByDuration: Record<3 | 6, Set<string>> = {
    3: new Set<string>(),
    6: new Set<string>(),
  };

  const result: SpecialOfferRecord[] = [];
  for (const offer of sortedNewestFirst) {
    const duration = normalizeSpecialOfferDuration(offer.duration_months);
    const claimedSet = claimedByDuration[duration];
    const pkgIds = Array.isArray(offer.package_ids) ? offer.package_ids : [];

    const unclaimedPkgIds = pkgIds.filter((pid) => {
      const canonical = resolveCanonicalPackageId(pid).toLowerCase();
      return Boolean(canonical) && !claimedSet.has(canonical);
    });

    if (unclaimedPkgIds.length === 0) {
      continue;
    }

    for (const pid of unclaimedPkgIds) {
      const canonical = resolveCanonicalPackageId(pid).toLowerCase();
      if (canonical) claimedSet.add(canonical);
    }

    result.push({
      ...offer,
      duration_months: duration,
      duration_days: duration === 6 ? 180 : 90,
      duration_label: duration === 6 ? '6 Months' : '3 Months',
      package_ids: unclaimedPkgIds.map((pid) => resolveCanonicalPackageId(pid)),
    });
  }

  return result.sort(
    (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
  );
}

export async function getAllSpecialOffers(authToken?: string): Promise<SpecialOfferRecord[]> {
  const client = getDbClient(authToken);
  let tableRecords: SpecialOfferRecord[] | null = null;

  const settingsRecords = await readSettingsSpecialOffers(authToken);
  const localRecords = readLocalSpecialOffers();

  try {
    const { data, error } = await client
      .from('special_offers')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && Array.isArray(data) && data.length > 0) {
      tableRecords = data.map(normalizeSpecialOfferRow);
    }
  } catch (_err) {
    // Fallback to settings & local cache
  }

  const mergedMap = new Map<string, SpecialOfferRecord>();
  const sourceLists =
    settingsRecords !== null || tableRecords !== null
      ? [settingsRecords || [], tableRecords || [], localRecords]
      : [localRecords];

  for (const list of sourceLists) {
    for (const item of list) {
      const existing = mergedMap.get(item.id);
      if (
        !existing ||
        new Date(item.updated_at || 0).getTime() >= new Date(existing.updated_at || 0).getTime()
      ) {
        mergedMap.set(item.id, item);
      }
    }
  }

  const records = deduplicateSpecialOffersByPackageAndDuration(Array.from(mergedMap.values()));
  if (records.length > 0) {
    writeLocalSpecialOffers(records);
  }

  return records;
}

export async function getActiveStoreSpecialOffers(): Promise<SpecialOfferRecord[]> {
  const [allOffers, availablePackages, pricing] = await Promise.all([
    getAllSpecialOffers(),
    getAllAvailablePackages(undefined, true),
    getLivePlanPricing(true),
  ]);

  const nowMs = Date.now();
  return allOffers
    .filter((offer) => isSpecialOfferActiveAndVisible(offer, nowMs))
    .map((offer) => enrichSpecialOfferWithBreakdowns(offer, availablePackages, pricing, nowMs))
    .filter((offer) => (offer.package_breakdowns?.length || 0) > 0);
}

async function persistAllSpecialOffers(records: SpecialOfferRecord[], authToken?: string): Promise<void> {
  const cleanRecords = records.map(toCleanPersistedRecord);
  writeLocalSpecialOffers(cleanRecords);
  const res = await writeSettingsSpecialOffers(cleanRecords, authToken);
  if (!res.ok) {
    console.warn('[SpecialOfferService] Supabase settings persistence fell back to local storage:', res.error);
  }
}

export async function validateSpecialOfferPayload(
  payload: SpecialOfferInputPayload,
  authToken?: string,
  customPlans?: PlanPricingConfig,
  customPackages?: StorePackageDefinition[]
): Promise<{
  valid: boolean;
  error?: string;
  sanitized?: Omit<SpecialOfferRecord, 'id' | 'created_at' | 'updated_at' | 'status' | 'package_breakdowns' | 'eligible_packages'>;
}> {
  const name = String(payload.name || '').trim();
  if (!name) {
    return { valid: false, error: 'Offer name is required.' };
  }

  const rawDuration = Number(payload.duration_months);
  if (rawDuration !== 3 && rawDuration !== 6) {
    return { valid: false, error: 'Offer duration must be either 3 months or 6 months.' };
  }
  const durationMonths: SpecialOfferDurationMonths = rawDuration === 6 ? 6 : 3;

  const promoPrice = Math.round(Number(payload.promotional_price));
  if (!Number.isFinite(promoPrice) || promoPrice <= 0) {
    return { valid: false, error: 'Promotional price (LKR) must be greater than 0.' };
  }

  const [availablePackages, pricing] = await Promise.all([
    customPackages ? Promise.resolve(customPackages) : getAllAvailablePackages(authToken, true),
    customPlans ? Promise.resolve(customPlans) : getLivePlanPricing(true, authToken),
  ]);

  const rawPackageIds = normalizeDiscountPackageIds(payload.package_ids);
  const expandedPackageIds = rawPackageIds.includes('*')
    ? availablePackages.filter((p) => p.enabled !== false).map((p) => p.id)
    : rawPackageIds.map((pid) => resolveCanonicalPackageId(pid)).filter(Boolean);

  if (expandedPackageIds.length === 0) {
    return { valid: false, error: 'Please select at least one VPN package for this special offer.' };
  }

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

  // Validate package eligibility & ensure promotional price is strictly below normal total price
  const matchedPackages = availablePackages.filter((p) =>
    expandedPackageIds.some((pid) => {
      const pkgIds = getAllIdentifiersForPackage(p.id, p.name, [p.templateId, ...(p.aliases || [])]);
      return pkgIds.has(pid.toLowerCase());
    })
  );

  if (matchedPackages.length === 0) {
    return { valid: false, error: 'None of the selected packages match active VPN packages.' };
  }

  for (const pkg of matchedPackages) {
    const { originalPrice: monthlyPrice } = getBaseOriginalPriceWithConfig(pricing, {
      packageId: pkg.id,
      packageName: pkg.name,
      category: pkg.category,
      packageType: pkg.packageType,
      duration: '1 Month',
    });
    const normalTotal = Math.round(monthlyPrice * durationMonths);
    if (promoPrice >= normalTotal) {
      return {
        valid: false,
        error: `Promotional price (LKR ${promoPrice}) must be less than the ${durationMonths}-month normal total of "${pkg.name}" (LKR ${normalTotal} = LKR ${monthlyPrice}/mo × ${durationMonths} months).`,
      };
    }
  }

  const canonicalIds = Array.from(new Set(matchedPackages.map((p) => p.id)));

  return {
    valid: true,
    sanitized: {
      name,
      description: String(payload.description || '').trim(),
      duration_months: durationMonths,
      duration_days: durationMonths === 6 ? 180 : 90,
      duration_label: durationMonths === 6 ? '6 Months' : '3 Months',
      package_ids: canonicalIds,
      promotional_price: promoPrice,
      is_enabled: Boolean(payload.is_enabled ?? true),
      is_visible: Boolean(payload.is_visible ?? true),
      start_date: payload.start_date ? new Date(payload.start_date).toISOString() : null,
      end_date: payload.end_date ? new Date(payload.end_date).toISOString() : null,
      banner_text: payload.banner_text ? String(payload.banner_text).trim() : null,
      badge_text: payload.badge_text ? String(payload.badge_text).trim() : null,
    },
  };
}

export async function createSpecialOffer(
  payload: SpecialOfferInputPayload,
  authToken?: string,
  customPlans?: PlanPricingConfig,
  customPackages?: StorePackageDefinition[]
): Promise<SpecialOfferRecord> {
  const existing = await getAllSpecialOffers(authToken);
  const validation = await validateSpecialOfferPayload(payload, authToken, customPlans, customPackages);
  if (!validation.valid || !validation.sanitized) {
    throw new Error(validation.error || 'Invalid special offer payload');
  }

  const nowIso = new Date().toISOString();

  // Check if an offer for the exact same package set and duration already exists so we can update its ID cleanly
  const targetDuration = validation.sanitized.duration_months;
  const targetKey = [...validation.sanitized.package_ids].sort().join(',');
  const exactExisting = existing.find((o) => {
    const oDuration = normalizeSpecialOfferDuration(o.duration_months);
    const oKey = [...(o.package_ids || []).map((pid) => resolveCanonicalPackageId(pid))].sort().join(',');
    return oDuration === targetDuration && oKey === targetKey;
  });

  const newRecord: SpecialOfferRecord = {
    id: exactExisting ? exactExisting.id : crypto.randomUUID(),
    ...validation.sanitized,
    created_at: exactExisting ? exactExisting.created_at : nowIso,
    updated_at: nowIso,
  };

  const { reconciledList, removedIds, updatedOffers } = reconcilePackageDurationOffers(existing, newRecord);

  const client = getDbClient(authToken);
  try {
    const dbRow = toSpecialOffersTableRow(newRecord);
    const { error: upsertErr } = await client.from('special_offers').upsert([dbRow], { onConflict: 'id' });
    if (upsertErr && upsertErr.code !== 'PGRST205' && upsertErr.code !== '42P01') {
      console.warn('[SpecialOfferService] special_offers table upsert notice:', {
        code: upsertErr.code,
        message: upsertErr.message,
      });
    }
    for (const detached of updatedOffers) {
      await client
        .from('special_offers')
        .update(toSpecialOffersTableRow(detached))
        .eq('id', detached.id);
    }
    if (removedIds.length > 0) {
      await client.from('special_offers').delete().in('id', removedIds);
    }
  } catch (err: any) {
    console.warn('[SpecialOfferService] Optional special_offers table sync skipped:', err?.message || err);
  }

  await persistAllSpecialOffers(reconciledList, authToken);
  return newRecord;
}

export async function updateSpecialOffer(
  id: string,
  payload: Partial<SpecialOfferInputPayload>,
  authToken?: string,
  customPlans?: PlanPricingConfig,
  customPackages?: StorePackageDefinition[]
): Promise<SpecialOfferRecord> {
  const existing = await getAllSpecialOffers(authToken);
  const targetIdx = existing.findIndex((o) => o.id === id);
  if (targetIdx === -1) {
    throw new Error('Special offer not found.');
  }

  const current = existing[targetIdx];
  const mergedPayload: SpecialOfferInputPayload = {
    name: payload.name !== undefined ? payload.name : current.name,
    description: payload.description !== undefined ? payload.description : current.description,
    duration_months: payload.duration_months !== undefined ? payload.duration_months : current.duration_months,
    package_ids: payload.package_ids !== undefined ? payload.package_ids : current.package_ids,
    promotional_price: payload.promotional_price !== undefined ? payload.promotional_price : current.promotional_price,
    is_enabled: payload.is_enabled !== undefined ? payload.is_enabled : current.is_enabled,
    is_visible: payload.is_visible !== undefined ? payload.is_visible : current.is_visible,
    start_date: payload.start_date !== undefined ? payload.start_date : current.start_date,
    end_date: payload.end_date !== undefined ? payload.end_date : current.end_date,
    banner_text: payload.banner_text !== undefined ? payload.banner_text : current.banner_text,
    badge_text: payload.badge_text !== undefined ? payload.badge_text : current.badge_text,
  };

  const validation = await validateSpecialOfferPayload(mergedPayload, authToken, customPlans, customPackages);
  if (!validation.valid || !validation.sanitized) {
    throw new Error(validation.error || 'Invalid special offer payload');
  }

  const updatedRecord: SpecialOfferRecord = {
    ...current,
    ...validation.sanitized,
    id,
    updated_at: new Date().toISOString(),
  };

  const { reconciledList, removedIds, updatedOffers } = reconcilePackageDurationOffers(existing, updatedRecord);

  const client = getDbClient(authToken);
  try {
    const dbRow = toSpecialOffersTableRow(updatedRecord);
    const { error: updateErr } = await client.from('special_offers').upsert([dbRow], { onConflict: 'id' });
    if (updateErr && updateErr.code !== 'PGRST205' && updateErr.code !== '42P01') {
      console.warn('[SpecialOfferService] special_offers table update notice:', {
        code: updateErr.code,
        message: updateErr.message,
      });
    }
    for (const detached of updatedOffers) {
      await client
        .from('special_offers')
        .update(toSpecialOffersTableRow(detached))
        .eq('id', detached.id);
    }
    if (removedIds.length > 0) {
      await client.from('special_offers').delete().in('id', removedIds);
    }
  } catch (err: any) {
    console.warn('[SpecialOfferService] Optional special_offers table update skipped:', err?.message || err);
  }

  await persistAllSpecialOffers(reconciledList, authToken);
  return updatedRecord;
}

export async function toggleSpecialOfferState(
  id: string,
  updates: { is_enabled?: boolean; is_visible?: boolean },
  authToken?: string
): Promise<SpecialOfferRecord> {
  const existing = await getAllSpecialOffers(authToken);
  const targetIdx = existing.findIndex((o) => o.id === id);
  if (targetIdx === -1) {
    throw new Error('Special offer not found.');
  }

  const current = existing[targetIdx];
  const updatedRecord: SpecialOfferRecord = {
    ...current,
    is_enabled: updates.is_enabled !== undefined ? Boolean(updates.is_enabled) : current.is_enabled,
    is_visible: updates.is_visible !== undefined ? Boolean(updates.is_visible) : current.is_visible,
    updated_at: new Date().toISOString(),
  };

  const client = getDbClient(authToken);
  try {
    await client
      .from('special_offers')
      .update({
        is_enabled: updatedRecord.is_enabled,
        is_visible: updatedRecord.is_visible,
        updated_at: updatedRecord.updated_at,
      })
      .eq('id', id);
  } catch (_err) {
    // Fallback handled by persistAllSpecialOffers
  }

  const updatedList = [...existing];
  updatedList[targetIdx] = updatedRecord;
  await persistAllSpecialOffers(updatedList, authToken);
  return updatedRecord;
}

export async function deleteSpecialOffer(id: string, authToken?: string): Promise<void> {
  const existing = await getAllSpecialOffers(authToken);
  const filtered = existing.filter((o) => o.id !== id);

  const client = getDbClient(authToken);
  try {
    await client.from('special_offers').delete().eq('id', id);
  } catch (_err) {
    // Ignore if table doesn't exist
  }

  await persistAllSpecialOffers(filtered, authToken);
}

/**
 * Independently validates a Special Offer during customer checkout.
 * Checks offer existence, enabled status, visibility, start/end dates, package eligibility,
 * duration match (3 Months or 6 Months), and calculates the authoritative normal total and promotional price.
 * Never trusts client-submitted promotional prices and never applies an existing discount twice.
 */
export async function verifySpecialOfferCheckoutPrice(params: {
  offerId: string;
  packageId?: string;
  packageName?: string;
  category?: string;
  packageType?: string;
  duration?: string;
  customPlans?: PlanPricingConfig;
  customOffers?: SpecialOfferRecord[];
  customPackages?: StorePackageDefinition[];
}): Promise<{
  offer: SpecialOfferRecord;
  packageId: string;
  packageName: string;
  durationMonths: SpecialOfferDurationMonths;
  durationLabel: '3 Months' | '6 Months';
  monthlyPrice: number;
  originalPrice: number;
  discountAmount: number;
  discountPercentage: number;
  finalPrice: number;
  plans: PlanPricingConfig;
}> {
  const livePlans = params.customPlans || (await getLivePlanPricing(true));
  const allOffers = params.customOffers || (await getAllSpecialOffers());
  const availablePackages = params.customPackages || (await getAllAvailablePackages(undefined, false));

  const offer = allOffers.find((o) => o.id === params.offerId);
  if (!offer) {
    throw new Error('The selected special offer does not exist or is no longer available.');
  }

  const nowMs = Date.now();
  const status = computeSpecialOfferStatus(offer, nowMs);
  if (status === 'Disabled') {
    throw new Error(`Special offer "${offer.name}" is currently disabled.`);
  }
  if (status === 'Hidden') {
    throw new Error(`Special offer "${offer.name}" is no longer available in the Store.`);
  }
  if (status === 'Scheduled') {
    throw new Error(`Special offer "${offer.name}" has not started yet.`);
  }
  if (status === 'Expired') {
    throw new Error(`Special offer "${offer.name}" has expired.`);
  }

  // Validate duration matches offer duration (3 Months or 6 Months)
  if (params.duration) {
    const reqDurationNorm = String(params.duration).trim().toLowerCase();
    const expectedNum = offer.duration_months;
    if (
      !reqDurationNorm.includes(String(expectedNum))
    ) {
      throw new Error(
        `Invalid duration "${params.duration}" for special offer "${offer.name}". This offer requires a ${offer.duration_months}-month duration.`
      );
    }
  }

  // Check package eligibility and active status
  const matchedPkg =
    availablePackages.find((p) => {
      const ids = getAllIdentifiersForPackage(p.id, p.name, [p.templateId, ...(p.aliases || [])]);
      return (
        (params.packageId && ids.has(String(params.packageId).trim().toLowerCase())) ||
        (params.packageName && ids.has(String(params.packageName).trim().toLowerCase()))
      );
    }) ||
    findCanonicalPackage(params.packageId) ||
    findCanonicalPackage(params.packageName);

  if (!matchedPkg || matchedPkg.enabled === false) {
    throw new Error('The selected VPN package is inactive or unavailable for this special offer.');
  }

  if (
    !specialOfferAppliesToPackage(offer, matchedPkg.id, matchedPkg.name, [
      params.packageId,
      params.packageName,
      matchedPkg.templateId,
      ...(matchedPkg.aliases || []),
    ])
  ) {
    throw new Error(
      `Package "${matchedPkg.name}" is not eligible for special offer "${offer.name}".`
    );
  }

  // Calculate normal total using the package's current monthly price multiplied by offer duration (3 or 6).
  // Never apply an existing 1-month discount twice.
  const { originalPrice: monthlyPrice } = getBaseOriginalPriceWithConfig(livePlans, {
    packageId: matchedPkg.id,
    packageName: matchedPkg.name,
    category: params.category || matchedPkg.category,
    packageType: params.packageType || matchedPkg.packageType,
    duration: '1 Month',
  });

  const originalTotalPrice = Math.round(monthlyPrice * offer.duration_months);
  const promotionalPrice = Math.max(0, Math.round(offer.promotional_price));
  const discountAmount = Math.max(0, originalTotalPrice - promotionalPrice);
  const discountPercentage =
    originalTotalPrice > 0
      ? Math.min(99, Math.max(0, Math.round((discountAmount / originalTotalPrice) * 100)))
      : 0;

  return {
    offer,
    packageId: matchedPkg.id,
    packageName: matchedPkg.name,
    durationMonths: offer.duration_months,
    durationLabel: offer.duration_months === 6 ? '6 Months' : '3 Months',
    monthlyPrice,
    originalPrice: originalTotalPrice,
    discountAmount,
    discountPercentage,
    finalPrice: promotionalPrice,
    plans: livePlans,
  };
}

/**
 * Authoritatively validates VPN renewal pricing and duration (1 Month, 3-Month Offer, or 6-Month Offer).
 * - Retrieves the latest active offer price and package prices from Supabase.
 * - Validates selected duration (1, 3, or 6 months) and VPN package/account eligibility.
 * - Prevents frontend price manipulation and duplicate discounts (never applies 1-month discounts to 3/6 month offers).
 */
export async function verifyRenewalCheckoutPrice(params: {
  durationMonths: number;
  offerId?: string | null;
  packageId?: string | null;
  packageName?: string | null;
  configName?: string | null;
  remark?: string | null;
  dataLimit?: string | null;
  planId?: string | null;
  planName?: string | null;
  category?: string | null;
  packageType?: string | null;
  vpnAccountUuid?: string | null;
  vpnAccountId?: string | null;
  customPlans?: PlanPricingConfig;
  customOffers?: SpecialOfferRecord[];
  customPackages?: StorePackageDefinition[];
  customDiscounts?: any[];
}): Promise<{
  durationMonths: 1 | 3 | 6;
  durationLabel: '1 Month' | '3 Months' | '6 Months';
  packageId: string;
  packageName: string;
  planId: 'sim_100' | 'sim_unlimited' | 'router_unlimited';
  planName: string;
  category: 'SIM' | 'ROUTER';
  packageType: 'SIM 100GB' | 'SIM Unlimited' | 'Router Unlimited';
  monthlyPrice: number;
  originalPrice: number;
  discountAmount: number;
  discountPercentage: number;
  finalPrice: number;
  isSpecialOffer: boolean;
  appliedOffer: SpecialOfferRecord | null;
  appliedDiscount: any | null;
  plans: PlanPricingConfig;
}> {
  const rawDuration = Number(params.durationMonths || 1);
  if (rawDuration !== 1 && rawDuration !== 3 && rawDuration !== 6) {
    throw new Error(
      `Invalid renewal duration (${params.durationMonths} months). Available renewal durations are 1 Month, 3-Month Offer, and 6-Month Offer.`
    );
  }
  const durationMonths = rawDuration as 1 | 3 | 6;

  const [livePlans, availablePackages] = await Promise.all([
    params.customPlans ? Promise.resolve(params.customPlans) : getLivePlanPricing(true),
    params.customPackages ? Promise.resolve(params.customPackages) : getAllAvailablePackages(undefined, false),
  ]);

  let dbPackageName: string | null = null;
  let dbRemark: string | null = null;
  let dbDataLimit: string | null = null;

  // If vpnAccountUuid or vpnAccountId is provided, inspect Supabase records so we know the account's real VPN package
  if ((params.vpnAccountUuid || params.vpnAccountId) && !params.customPackages) {
    try {
      const db = getDbClient();
      if (params.vpnAccountUuid) {
        const [{ data: cfgRow }, { data: accRow }, { data: ordRow }] = await Promise.all([
          db.from('vpn_configs').select('package_name, data_limit, order_id').eq('uuid', params.vpnAccountUuid).maybeSingle(),
          db.from('vpn_accounts').select('remark, data_limit, order_id').eq('uuid', params.vpnAccountUuid).maybeSingle(),
          db.from('orders').select('package_name, payment_method').eq('client_uuid', params.vpnAccountUuid).maybeSingle(),
        ]);
        dbPackageName = cfgRow?.package_name || ordRow?.package_name || null;
        dbRemark = accRow?.remark || null;
        dbDataLimit = cfgRow?.data_limit || accRow?.data_limit || null;

        if (!dbPackageName && (cfgRow?.order_id || accRow?.order_id)) {
          const orderLookupId = cfgRow?.order_id || accRow?.order_id;
          const { data: linkedOrder } = await db
            .from('orders')
            .select('package_name')
            .eq('id', orderLookupId)
            .maybeSingle();
          if (linkedOrder?.package_name) {
            dbPackageName = linkedOrder.package_name;
          }
        }
      } else if (params.vpnAccountId) {
        const { data: accRow } = await db
          .from('vpn_accounts')
          .select('uuid, remark, data_limit, order_id')
          .eq('id', params.vpnAccountId)
          .maybeSingle();
        if (accRow) {
          dbRemark = accRow.remark || null;
          dbDataLimit = accRow.data_limit || null;
          if (accRow.order_id) {
            const { data: linkedOrder } = await db
              .from('orders')
              .select('package_name')
              .eq('id', accRow.order_id)
              .maybeSingle();
            if (linkedOrder?.package_name) {
              dbPackageName = linkedOrder.package_name;
            }
          }
        }
      }
    } catch (_err) {
      // Non-blocking fallback to passed parameters
    }
  }

  const resolved = resolveVpnAccountPackage(
    {
      packageId: params.packageId,
      packageName: params.packageName || dbPackageName,
      configName: params.configName || dbPackageName,
      remark: params.remark || dbRemark,
      dataLimit: params.dataLimit || dbDataLimit,
      planId: params.planId,
      planName: params.planName,
      category: params.category,
      packageType: params.packageType,
    },
    availablePackages
  );

  // 1-Month Standard Renewal: use authoritative 1-month pricing + active 1-month discount (never Special Offers)
  if (durationMonths === 1) {
    const { calculateVerifiedOrderPrice } = await import('./discountService.js');
    const verified1Mo = await calculateVerifiedOrderPrice({
      packageId: resolved.canonicalPackageId,
      packageName: resolved.canonicalPackageName,
      category: resolved.category,
      packageType: resolved.packageType,
      duration: '1 Month',
      customPlans: livePlans,
      customDiscounts: params.customDiscounts,
    });

    return {
      durationMonths: 1,
      durationLabel: '1 Month',
      packageId: resolved.canonicalPackageId,
      packageName: resolved.canonicalPackageName,
      planId: resolved.planId,
      planName: resolved.packageType,
      category: resolved.category,
      packageType: resolved.packageType,
      monthlyPrice: verified1Mo.originalPrice,
      originalPrice: verified1Mo.originalPrice,
      discountAmount: verified1Mo.discountAmount,
      discountPercentage: verified1Mo.discountPercentage,
      finalPrice: verified1Mo.finalPrice,
      isSpecialOffer: false,
      appliedOffer: null,
      appliedDiscount: verified1Mo.appliedDiscount,
      plans: livePlans,
    };
  }

  // 3-Month or 6-Month Special Offer Renewal
  const allOffers = params.customOffers || (await getAllSpecialOffers());
  const nowMs = Date.now();

  let targetOffer: SpecialOfferRecord | undefined;

  if (params.offerId) {
    targetOffer = allOffers.find((o) => o.id === params.offerId);
    if (!targetOffer) {
      throw new Error('The selected special offer does not exist or has been removed.');
    }
    const status = computeSpecialOfferStatus(targetOffer, nowMs);
    if (status === 'Disabled') {
      throw new Error(`Special offer "${targetOffer.name}" is currently disabled and cannot be used for renewal.`);
    }
    if (status === 'Hidden') {
      throw new Error(`Special offer "${targetOffer.name}" is hidden and no longer available for renewal.`);
    }
    if (status === 'Scheduled') {
      throw new Error(`Special offer "${targetOffer.name}" has not started yet.`);
    }
    if (status === 'Expired') {
      throw new Error(`Special offer "${targetOffer.name}" has expired and cannot be used for renewal.`);
    }
    if (targetOffer.duration_months !== durationMonths) {
      throw new Error(
        `Duration mismatch: Special offer "${targetOffer.name}" is for ${targetOffer.duration_months} months, not ${durationMonths} months.`
      );
    }
  } else {
    // Find best matching active & visible offer for this duration and package
    const matchingOffers = allOffers.filter(
      (o) =>
        isSpecialOfferActiveAndVisible(o, nowMs) &&
        o.duration_months === durationMonths &&
        specialOfferAppliesToPackage(
          o,
          resolved.canonicalPackageId,
          resolved.canonicalPackageName,
          [
            params.packageId,
            params.packageName,
            dbPackageName,
            resolved.matchedPackage?.templateId,
            ...(resolved.matchedPackage?.aliases || []),
          ],
          availablePackages
        )
    );
    if (matchingOffers.length === 0) {
      throw new Error(
        `No active ${durationMonths}-month special offer is available for "${resolved.canonicalPackageName}".`
      );
    }
    matchingOffers.sort((a, b) => a.promotional_price - b.promotional_price);
    targetOffer = matchingOffers[0];
  }

  // Verify package & account eligibility against targetOffer
  if (
    !specialOfferAppliesToPackage(
      targetOffer,
      resolved.canonicalPackageId,
      resolved.canonicalPackageName,
      [
        params.packageId,
        params.packageName,
        dbPackageName,
        resolved.matchedPackage?.templateId,
        ...(resolved.matchedPackage?.aliases || []),
      ],
      availablePackages
    )
  ) {
    throw new Error(
      `VPN package "${resolved.canonicalPackageName}" is not eligible for special offer "${targetOffer.name}".`
    );
  }

  if (resolved.matchedPackage && resolved.matchedPackage.enabled === false) {
    throw new Error(`VPN package "${resolved.matchedPackage.name}" is currently disabled.`);
  }

  // Calculate normal total using authoritative 1-month base price * durationMonths.
  // Never apply an existing 1-month discount twice on top of a Special Offer.
  const { originalPrice: monthlyPrice } = getBaseOriginalPriceWithConfig(livePlans, {
    packageId: resolved.canonicalPackageId,
    packageName: resolved.canonicalPackageName,
    category: resolved.category,
    packageType: resolved.packageType,
    duration: '1 Month',
  });

  const originalTotalPrice = Math.round(monthlyPrice * durationMonths);
  const promotionalPrice = Math.max(0, Math.round(targetOffer.promotional_price));
  const discountAmount = Math.max(0, originalTotalPrice - promotionalPrice);
  const discountPercentage =
    originalTotalPrice > 0
      ? Math.min(99, Math.max(0, Math.round((discountAmount / originalTotalPrice) * 100)))
      : 0;

  return {
    durationMonths,
    durationLabel: durationMonths === 6 ? '6 Months' : '3 Months',
    packageId: resolved.canonicalPackageId,
    packageName: resolved.canonicalPackageName,
    planId: resolved.planId,
    planName: resolved.packageType,
    category: resolved.category,
    packageType: resolved.packageType,
    monthlyPrice,
    originalPrice: originalTotalPrice,
    discountAmount,
    discountPercentage,
    finalPrice: promotionalPrice,
    isSpecialOffer: true,
    appliedOffer: targetOffer,
    appliedDiscount: null,
    plans: livePlans,
  };
}

