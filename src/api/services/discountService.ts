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
  templateId?: string;
  aliases?: string[];
  enabled?: boolean;
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
  // SIM 100GB Packages
  {
    id: 'hutch_zoom',
    name: 'HUTCH ZOOM',
    category: 'SIM',
    packageType: 'SIM 100GB',
    tierKey: 'sim100',
    basePrice: 200,
    templateId: '4ad3ae7e-5568-475b-8423-5275319bc76e',
    aliases: [
      'hutch_zoom',
      'hutch zoom',
      'hutch zoom package',
      'hutch_zoom_package',
      '4ad3ae7e-5568-475b-8423-5275319bc76e',
    ],
  },
  {
    id: 'dialog_tiktok',
    name: 'DIALOG TIKTOK',
    category: 'SIM',
    packageType: 'SIM 100GB',
    tierKey: 'sim100',
    basePrice: 200,
    templateId: '056e852b-a813-4655-95de-eac6899c606a',
    aliases: [
      'dialog_tiktok',
      'dialog tiktok',
      'dialog tiktok package',
      'dialog_tiktok_package',
      '056e852b-a813-4655-95de-eac6899c606a',
    ],
  },
  {
    id: 'dialog_zoom_224',
    name: 'DIALOG ZOOM 224',
    category: 'SIM',
    packageType: 'SIM 100GB',
    tierKey: 'sim100',
    basePrice: 200,
    templateId: '3085ff4c-3c00-4cf0-946c-d04245a29f21',
    aliases: [
      'dialog_zoom_224',
      'dialog zoom 224',
      'dialog zoom 224 package',
      'dialog_zoom_224_package',
      '3085ff4c-3c00-4cf0-946c-d04245a29f21',
    ],
  },
  {
    id: 'dialog_social',
    name: 'DIALOG SOCIAL',
    category: 'SIM',
    packageType: 'SIM 100GB',
    tierKey: 'sim100',
    basePrice: 200,
    templateId: 'a5f6bd79-7e70-4bf9-bc61-2ae4d8dc90bb',
    aliases: [
      'dialog_social',
      'dialog social',
      'dialog social media',
      'dialog_social_media',
      'dialog social package',
      'a5f6bd79-7e70-4bf9-bc61-2ae4d8dc90bb',
    ],
  },
  // SIM Unlimited Packages
  {
    id: 'mobitel_zoom',
    name: 'MOBITEL ZOOM',
    category: 'SIM',
    packageType: 'SIM Unlimited',
    tierKey: 'simUnlimited',
    basePrice: 400,
    templateId: 'b642373f-a4a1-4cb6-8a9b-b64eda3bba6d',
    aliases: [
      'mobitel_zoom',
      'mobitel zoom',
      'mobitel zoom 224',
      'mobitel_zoom_224',
      'mobitel zoom package',
      'b642373f-a4a1-4cb6-8a9b-b64eda3bba6d',
    ],
  },
  {
    id: 'airtel_tiktok',
    name: 'AIRTEL TIKTOK',
    category: 'SIM',
    packageType: 'SIM Unlimited',
    tierKey: 'simUnlimited',
    basePrice: 400,
    templateId: 'fe0dc35d-d565-48a3-9b80-a51487e71602',
    aliases: [
      'airtel_tiktok',
      'airtel tiktok',
      'airtel tiktok package',
      'airtel_tiktok_package',
      'fe0dc35d-d565-48a3-9b80-a51487e71602',
    ],
  },
  {
    id: 'airtel_youtube',
    name: 'AIRTEL YOUTUBE',
    category: 'SIM',
    packageType: 'SIM Unlimited',
    tierKey: 'simUnlimited',
    basePrice: 400,
    templateId: 'c99a78da-38c1-4170-8dd8-1a08e2a07603',
    aliases: [
      'airtel_youtube',
      'airtel youtube',
      'airtel youtube package',
      'airtel_youtube_package',
      'c99a78da-38c1-4170-8dd8-1a08e2a07603',
    ],
  },
  {
    id: 'airtel_zoom',
    name: 'AIRTEL ZOOM',
    category: 'SIM',
    packageType: 'SIM Unlimited',
    tierKey: 'simUnlimited',
    basePrice: 400,
    templateId: 'dc98d60e-6d25-452c-8115-611acd0621ce',
    aliases: [
      'airtel_zoom',
      'airtel zoom',
      'airtel zoom 225',
      'airtel_zoom_225',
      'airtel zoom package',
      'dc98d60e-6d25-452c-8115-611acd0621ce',
    ],
  },
  {
    id: 'hutch_tu_299',
    name: 'HUTCH TU 299',
    category: 'SIM',
    packageType: 'SIM Unlimited',
    tierKey: 'simUnlimited',
    basePrice: 400,
    aliases: ['hutch_tu_299', 'hutch tu 299', 'hutch tu 299 package'],
  },
  {
    id: 'hutch_gaming',
    name: 'HUTCH GAMING PACKAGE',
    category: 'SIM',
    packageType: 'SIM Unlimited',
    tierKey: 'simUnlimited',
    basePrice: 400,
    aliases: ['hutch_gaming', 'hutch gaming', 'hutch gaming package', 'hutch_gaming_package'],
  },
  {
    id: 'hutch_social',
    name: 'HUTCH SOCIAL MEDIA',
    category: 'SIM',
    packageType: 'SIM Unlimited',
    tierKey: 'simUnlimited',
    basePrice: 400,
    aliases: ['hutch_social', 'hutch social', 'hutch social media', 'hutch_social_media'],
  },
  // Router Unlimited Packages
  {
    id: 'dialog_zoom',
    name: 'DIALOG ZOOM',
    category: 'ROUTER',
    packageType: 'Router Unlimited',
    tierKey: 'routerUnlimited',
    basePrice: 600,
    templateId: '6545fdc3-f703-4173-b1d0-3dc3672ee12f',
    aliases: [
      'dialog_zoom',
      'dialog zoom',
      'dialog_router',
      'dialog router',
      'dialog router package',
      'dialog_router_package',
      'dialog zoom router',
      '6545fdc3-f703-4173-b1d0-3dc3672ee12f',
    ],
  },
  {
    id: 'slt_fiber_zoom',
    name: 'SLT FIBER ZOOM',
    category: 'ROUTER',
    packageType: 'Router Unlimited',
    tierKey: 'routerUnlimited',
    basePrice: 600,
    templateId: 'd27e7c88-0c74-4c99-b15a-07bd57a17bc1',
    aliases: [
      'slt_fiber_zoom',
      'slt fiber zoom',
      'slt fiber zoom package',
      'slt_fiber_zoom_package',
      'd27e7c88-0c74-4c99-b15a-07bd57a17bc1',
    ],
  },
  {
    id: 'slt_fiber_netflix',
    name: 'SLT FIBER NETFLIX',
    category: 'ROUTER',
    packageType: 'Router Unlimited',
    tierKey: 'routerUnlimited',
    basePrice: 600,
    templateId: '88775c59-c659-4c1b-8e3a-f5959f5afd16',
    aliases: [
      'slt_fiber_netflix',
      'slt_netflix',
      'slt fiber netflix',
      'slt netflix',
      'slt fiber netflix package',
      '88775c59-c659-4c1b-8e3a-f5959f5afd16',
    ],
  },
  {
    id: 'slt_zoom',
    name: 'SLT ZOOM',
    category: 'ROUTER',
    packageType: 'Router Unlimited',
    tierKey: 'routerUnlimited',
    basePrice: 600,
    templateId: 'ffb81e1f-9d7c-430e-a63f-ba8f2b43f53a',
    aliases: [
      'slt_zoom',
      'slt zoom',
      'slt zoom package',
      'slt_zoom_package',
      'ffb81e1f-9d7c-430e-a63f-ba8f2b43f53a',
    ],
  },
];

// Dynamic runtime registry for newly created provision_templates
const dynamicPackageRegistry = new Map<string, StorePackageDefinition>();

export function normalizePackageSlug(input?: string | null): string {
  if (!input) return '';
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

export function stripPackageSuffix(slug: string): string {
  return slug.replace(/_(package|media)$/i, '');
}

export function findCanonicalPackage(
  idOrName?: string | null,
  customPackages?: StorePackageDefinition[]
): StorePackageDefinition | undefined {
  if (!idOrName) return undefined;
  const raw = String(idOrName).trim().toLowerCase();
  if (!raw || raw === '*' || raw === 'all' || raw === 'all_packages') return undefined;

  const slug = normalizePackageSlug(raw);
  const strippedSlug = stripPackageSuffix(slug);

  const searchList: StorePackageDefinition[] = [
    ...DEFAULT_STORE_PACKAGES,
    ...Array.from(dynamicPackageRegistry.values()),
    ...(customPackages || []),
  ];

  // 1. Direct match on id, templateId, name, or explicit aliases
  for (const pkg of searchList) {
    if (pkg.id.toLowerCase() === raw || pkg.id.toLowerCase() === slug) return pkg;
    if (pkg.templateId && pkg.templateId.toLowerCase() === raw) return pkg;
    if (pkg.name.toLowerCase() === raw || normalizePackageSlug(pkg.name) === slug) return pkg;
    if (
      pkg.aliases?.some(
        (a) => a.toLowerCase() === raw || normalizePackageSlug(a) === slug
      )
    ) {
      return pkg;
    }
  }

  // 2. Stripped suffix match (e.g. "hutch_zoom_package" -> "hutch_zoom")
  if (strippedSlug) {
    for (const pkg of searchList) {
      if (
        pkg.id.toLowerCase() === strippedSlug ||
        stripPackageSuffix(normalizePackageSlug(pkg.name)) === strippedSlug
      ) {
        return pkg;
      }
    }
  }

  return undefined;
}

export function resolveCanonicalPackageId(idOrName?: string | null): string {
  if (!idOrName) return '';
  const raw = String(idOrName).trim();
  const lower = raw.toLowerCase();
  if (lower === '*' || lower === 'all' || lower === 'all_packages') return '*';

  const matched = findCanonicalPackage(raw);
  if (matched) return matched.id;
  return raw;
}

export function getAllIdentifiersForPackage(
  packageId?: string | null,
  packageName?: string | null,
  extraIds?: (string | null | undefined)[]
): Set<string> {
  const identifiers = new Set<string>();

  const addCandidate = (val?: string | null) => {
    if (!val) return;
    const raw = String(val).trim().toLowerCase();
    if (!raw) return;
    identifiers.add(raw);
    const slug = normalizePackageSlug(raw);
    if (slug) {
      identifiers.add(slug);
      identifiers.add(slug.replace(/_/g, ' '));
      const stripped = stripPackageSuffix(slug);
      if (stripped) {
        identifiers.add(stripped);
        identifiers.add(stripped.replace(/_/g, ' '));
      }
    }
    const matched = findCanonicalPackage(raw);
    if (matched) {
      identifiers.add(matched.id.toLowerCase());
      identifiers.add(matched.name.toLowerCase());
      identifiers.add(normalizePackageSlug(matched.name));
      if (matched.templateId) {
        identifiers.add(matched.templateId.toLowerCase());
      }
      if (matched.aliases) {
        for (const alias of matched.aliases) {
          identifiers.add(alias.toLowerCase());
          identifiers.add(normalizePackageSlug(alias));
        }
      }
    }
  };

  addCandidate(packageId);
  addCandidate(packageName);
  if (Array.isArray(extraIds)) {
    for (const extra of extraIds) {
      addCandidate(extra);
    }
  }

  return identifiers;
}

export function registerDynamicPackage(pkg: StorePackageDefinition): void {
  dynamicPackageRegistry.set(pkg.id, pkg);
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DISCOUNTS_FILE = path.join(DATA_DIR, 'discounts.json');
const SETTINGS_FALLBACK_ID = 'discounts_management';
const APP_SETTINGS_ID = 'app';

let cachedPlanPricing: { config: PlanPricingConfig; fetchedAt: number } | null = null;
const PRICING_CACHE_TTL_MS = 1500;

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
      const rawPackagePrices = data.data.packagePrices || rawPlans.packagePrices || {};

      const sim100 = Number(rawPlans.sim100);
      const simUnlimited = Number(rawPlans.simUnlimited);
      const routerUnlimited = Number(rawPlans.routerUnlimited);

      const packagePrices: Record<string, number> = {};
      if (rawPackagePrices && typeof rawPackagePrices === 'object') {
        for (const [k, v] of Object.entries(rawPackagePrices)) {
          const num = Number(v);
          if (Number.isFinite(num) && num > 0) {
            const cleanKey = String(k).trim();
            packagePrices[cleanKey] = Math.round(num);
            const canonicalId = resolveCanonicalPackageId(cleanKey);
            if (canonicalId && canonicalId !== '*') {
              packagePrices[canonicalId] = Math.round(num);
            }
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
      const cleanKey = String(k).trim();
      const canonicalId = resolveCanonicalPackageId(cleanKey);
      if (Number.isFinite(num) && num > 0) {
        mergedPackagePrices[cleanKey] = Math.round(num);
        if (canonicalId && canonicalId !== '*') {
          mergedPackagePrices[canonicalId] = Math.round(num);
        }
      } else {
        delete mergedPackagePrices[cleanKey];
        if (canonicalId && canonicalId !== '*') {
          delete mergedPackagePrices[canonicalId];
        }
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
  if (pkgId && pricing.packagePrices) {
    const direct = Number(pricing.packagePrices[pkgId]);
    if (Number.isFinite(direct) && direct > 0) {
      return Math.round(direct);
    }
    const canonical = resolveCanonicalPackageId(pkgId);
    if (canonical && Number(pricing.packagePrices[canonical]) > 0) {
      return Math.round(Number(pricing.packagePrices[canonical]));
    }
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

export function normalizeDiscountPackageIds(rawInput: any, fallbackSingleId?: any): string[] {
  let rawIds: string[] = [];
  if (Array.isArray(rawInput)) {
    rawIds = rawInput.map((id: any) => String(id).trim()).filter(Boolean);
  } else if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          rawIds = parsed.map((id: any) => String(id).trim()).filter(Boolean);
        }
      } catch {
        rawIds = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
      }
    } else if (trimmed) {
      rawIds = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    }
  } else if (fallbackSingleId) {
    rawIds = [String(fallbackSingleId).trim()].filter(Boolean);
  }

  if (rawIds.some((id) => ['*', 'all', 'all_packages'].includes(id.trim().toLowerCase()))) {
    return ['*'];
  }

  const lowerSet = new Set(rawIds.map((id) => id.toLowerCase()));
  // Handle historical ambiguity where 'slt_zoom' was the ID for 'SLT FIBER ZOOM' and 'ffb81e1f-...' was 'SLT ZOOM'
  const hasLegacySltZoomAndTemplateUuid =
    lowerSet.has('slt_zoom') && lowerSet.has('ffb81e1f-9d7c-430e-a63f-ba8f2b43f53a');

  const normalizedSet = new Set<string>();
  for (const id of rawIds) {
    if (hasLegacySltZoomAndTemplateUuid && id.toLowerCase() === 'slt_zoom') {
      normalizedSet.add('slt_fiber_zoom');
      normalizedSet.add('slt_zoom');
      continue;
    }
    const canonical = resolveCanonicalPackageId(id);
    if (canonical) {
      normalizedSet.add(canonical);
    }
  }

  return Array.from(normalizedSet);
}

export function normalizeDiscountRow(row: any): DiscountRecord {
  const pkgIds = normalizeDiscountPackageIds(row.package_ids, row.package_id);

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
  packageName?: string | null,
  extraIds?: (string | null | undefined)[]
): boolean {
  if (!discount || !Array.isArray(discount.package_ids) || discount.package_ids.length === 0) {
    return false;
  }
  if (isAllPackagesDiscount(discount)) {
    return true;
  }

  const targetIdentifiers = getAllIdentifiersForPackage(packageId, packageName, extraIds);
  if (targetIdentifiers.size === 0) return false;

  const normalizedDiscountIds = normalizeDiscountPackageIds(discount.package_ids);

  for (const rawDiscountPkgId of [...discount.package_ids, ...normalizedDiscountIds]) {
    const discountIdentifiers = getAllIdentifiersForPackage(rawDiscountPkgId, rawDiscountPkgId);
    for (const dId of discountIdentifiers) {
      if (targetIdentifiers.has(dId)) {
        return true;
      }
    }
  }

  return false;
}

export async function getAllAvailablePackages(authToken?: string, forceRefreshPricing = false): Promise<StorePackageDefinition[]> {
  const pricing = await getLivePlanPricing(forceRefreshPricing, authToken);
  const packagesMap = new Map<string, StorePackageDefinition>();

  for (const pkg of DEFAULT_STORE_PACKAGES) {
    packagesMap.set(pkg.id, {
      ...pkg,
      basePrice: getTierBasePrice(pkg.tierKey, pricing, pkg.id),
      enabled: true,
    });
  }

  try {
    const client = getDbClient(authToken);
    const { data, error } = await client.from('provision_templates').select('*');
    if (!error && Array.isArray(data)) {
      for (const row of data) {
        const rawName = String(row.package_name || row.name || '').trim();
        if (!rawName) continue;
        const rowId = String(row.id || '').trim();
        const isEnabled = row.enabled !== false && row.is_active !== false;

        const matchedCanonical =
          findCanonicalPackage(rowId) || findCanonicalPackage(rawName);

        if (matchedCanonical && packagesMap.has(matchedCanonical.id)) {
          const existing = packagesMap.get(matchedCanonical.id)!;
          const mergedAliases = Array.from(
            new Set([
              ...(existing.aliases || []),
              rowId.toLowerCase(),
              rawName.toLowerCase(),
              normalizePackageSlug(rawName),
            ])
          );
          if (!isEnabled) {
            // Exclude disabled packages from active customer packages list
            packagesMap.delete(matchedCanonical.id);
          } else {
            const updatedPkg: StorePackageDefinition = {
              ...existing,
              templateId: rowId || existing.templateId,
              aliases: mergedAliases,
              enabled: true,
            };
            packagesMap.set(matchedCanonical.id, updatedPkg);
            registerDynamicPackage(updatedPkg);
          }
        } else if (isEnabled) {
          const catRaw = String(row.category || '').toUpperCase().trim();
          const isRouter =
            catRaw === 'ROUTER' ||
            rawName.toLowerCase().includes('slt') ||
            rawName.toLowerCase().includes('fiber') ||
            rawName.toLowerCase().includes('router');
          const is100GB = rawName.toLowerCase().includes('100gb') || rawName.toLowerCase().includes('100 gb');
          const cat: 'SIM' | 'ROUTER' = isRouter ? 'ROUTER' : 'SIM';
          const tierKey: 'sim100' | 'simUnlimited' | 'routerUnlimited' = isRouter
            ? 'routerUnlimited'
            : is100GB
            ? 'sim100'
            : 'simUnlimited';
          const packageType: 'SIM 100GB' | 'SIM Unlimited' | 'Router Unlimited' = isRouter
            ? 'Router Unlimited'
            : is100GB
            ? 'SIM 100GB'
            : 'SIM Unlimited';
          const pkgId = rowId || normalizePackageSlug(rawName);
          const customPrice = Number(row.price);
          const basePrice =
            Number.isFinite(customPrice) && customPrice > 0
              ? Math.round(customPrice)
              : getTierBasePrice(tierKey, pricing, pkgId);

          const newPkg: StorePackageDefinition = {
            id: pkgId,
            name: rawName.toUpperCase(),
            category: cat,
            packageType,
            tierKey,
            basePrice,
            templateId: rowId || undefined,
            aliases: [
              pkgId.toLowerCase(),
              rawName.toLowerCase(),
              normalizePackageSlug(rawName),
            ],
            enabled: true,
          };
          packagesMap.set(pkgId, newPkg);
          registerDynamicPackage(newPkg);
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
  invalidatePricingCache();
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

  const availablePackages = await getAllAvailablePackages(authToken, true);
  const rawPackageIds = normalizeDiscountPackageIds(payload.package_ids);

  if (rawPackageIds.length === 0) {
    return { valid: false, error: 'Please select at least one target package (or All Packages) for this discount.' };
  }

  const isAllTarget = rawPackageIds.includes('*');
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

  const packagesToValidate = isAllTarget
    ? availablePackages
    : availablePackages.filter((p) =>
        packageIds.some((pid) => {
          const pkgIds = getAllIdentifiersForPackage(p.id, p.name, [p.templateId, ...(p.aliases || [])]);
          return pkgIds.has(pid.toLowerCase());
        })
      );

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
        const overlappingPkgId = isAllTarget
          ? existing.package_ids[0]
          : existingIsAll
          ? packageIds[0]
          : packageIds.find((pkgId) => discountAppliesToPackage(existing, pkgId, pkgId));

        if (!overlappingPkgId) continue;

        const candStart = startMs ?? -Infinity;
        const candEnd = endMs ?? Infinity;
        const existStart = existing.start_date ? new Date(existing.start_date).getTime() : -Infinity;
        const existEnd = existing.end_date ? new Date(existing.end_date).getTime() : Infinity;

        if (candStart <= existEnd && existStart <= candEnd) {
          const pkgName =
            overlappingPkgId === '*'
              ? 'All Packages'
              : availablePackages.find((p) => p.id === overlappingPkgId)?.name ||
                findCanonicalPackage(overlappingPkgId)?.name ||
                overlappingPkgId;
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

  const matchedPkg =
    findCanonicalPackage(params.packageId) || findCanonicalPackage(params.packageName);

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

  const candidatePkgIds = [
    matchedPkg?.id,
    params.packageId ? String(params.packageId).trim() : undefined,
    params.packageName ? normalizePackageSlug(params.packageName) : undefined,
  ].filter(Boolean) as string[];

  let customOverridePrice: number | null = null;
  if (pricing.packagePrices) {
    for (const cid of candidatePkgIds) {
      const val = Number(pricing.packagePrices[cid]);
      if (Number.isFinite(val) && val > 0) {
        if (!matchedPkg || resolvedTier === matchedPkg.tierKey) {
          customOverridePrice = Math.round(val);
          break;
        }
      }
    }
  }

  let baseMonthly: number;
  if (customOverridePrice !== null) {
    baseMonthly = customOverridePrice;
  } else if (matchedPkg && !DEFAULT_STORE_PACKAGES.some((d) => d.id === matchedPkg.id) && matchedPkg.basePrice > 0 && resolvedTier === matchedPkg.tierKey) {
    baseMonthly = matchedPkg.basePrice;
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
  customPackages?: StorePackageDefinition[];
}): Promise<PriceVerificationResult> {
  const livePlans = params.customPlans || (await getLivePlanPricing(true));

  if (params.customPackages) {
    for (const cp of params.customPackages) {
      if (cp.enabled === false) {
        const targetIds = getAllIdentifiersForPackage(params.packageId, params.packageName);
        if (targetIds.has(cp.id.toLowerCase()) || targetIds.has(cp.name.toLowerCase())) {
          throw new Error(`Package "${cp.name}" is currently inactive or unavailable for purchase.`);
        }
      } else {
        registerDynamicPackage(cp);
      }
    }
  } else if (!params.customPlans && !params.customDiscounts) {
    // Refresh dynamic packages and check if requested package is disabled in provision_templates
    try {
      const client = getDbClient();
      const { data: tplRows } = await client.from('provision_templates').select('*');
      if (Array.isArray(tplRows)) {
        const reqIdentifiers = getAllIdentifiersForPackage(params.packageId, params.packageName);
        for (const row of tplRows) {
          const rId = String(row.id || '').trim().toLowerCase();
          const rName = String(row.package_name || row.name || '').trim().toLowerCase();
          const isEnabled = row.enabled !== false && row.is_active !== false;
          if (!isEnabled && ((rId && reqIdentifiers.has(rId)) || (rName && reqIdentifiers.has(rName)))) {
            throw new Error(`Package "${row.package_name || row.name}" is currently inactive or unavailable for purchase.`);
          }
        }
      }
      await getAllAvailablePackages(undefined, false);
    } catch (err: any) {
      if (err?.message?.includes('inactive or unavailable')) {
        throw err;
      }
    }
  }

  const { originalPrice, matchedPackage } = getBaseOriginalPriceWithConfig(livePlans, params);

  const resolvedPkgId = matchedPackage?.id || String(params.packageId || '').trim();
  const resolvedPkgName = matchedPackage?.name || String(params.packageName || '').trim();

  const activeDiscounts = params.customDiscounts
    ? params.customDiscounts.filter((d) => isDiscountCurrentlyActive(d))
    : await getActiveDiscounts();

  const extraIds = [
    params.packageId,
    params.packageName,
    matchedPackage?.id,
    matchedPackage?.name,
    matchedPackage?.templateId,
    ...(matchedPackage?.aliases || []),
  ];

  // Prefer a package-specific active discount first, otherwise an all-packages ('*') active discount
  const specificDiscount =
    activeDiscounts.find(
      (d) => !isAllPackagesDiscount(d) && discountAppliesToPackage(d, resolvedPkgId, resolvedPkgName, extraIds)
    ) || null;
  const globalDiscount =
    activeDiscounts.find(
      (d) => isAllPackagesDiscount(d) && discountAppliesToPackage(d, resolvedPkgId, resolvedPkgName, extraIds)
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
