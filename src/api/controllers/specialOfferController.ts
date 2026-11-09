import { Request, Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import {
  getAllSpecialOffers,
  getActiveStoreSpecialOffers,
  createSpecialOffer,
  updateSpecialOffer,
  toggleSpecialOfferState,
  deleteSpecialOffer,
  enrichSpecialOfferWithBreakdowns,
  verifySpecialOfferCheckoutPrice,
} from '../services/specialOfferService.js';
import {
  getAllAvailablePackages,
  getLivePlanPricing,
} from '../services/discountService.js';

function extractToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split('Bearer ')[1].trim();
  }
  return undefined;
}

/**
 * GET /api/vpn/special-offers/active
 * Public endpoint returning enabled, visible, and currently valid 3-month and 6-month Special Offers
 * along with live package breakdowns.
 */
export const getPublicActiveSpecialOffersHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const [offers, packages, plans] = await Promise.all([
      getActiveStoreSpecialOffers(),
      getAllAvailablePackages(undefined, true),
      getLivePlanPricing(true),
    ]);
    res.json({
      offers,
      packages,
      plans,
      serverTime: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[SpecialOfferController] Error fetching active special offers:', error?.message || error);
    res.status(500).json({ error: error?.message || 'Failed to fetch active special offers' });
  }
};

/**
 * POST /api/vpn/special-offers/validate-price
 * Server-side special offer validation and price verification before order creation.
 */
export const validateSpecialOfferPriceHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const {
      offerId,
      packageId,
      packageName,
      category,
      packageType,
      duration,
      submittedFinalPrice,
    } = req.body || {};

    if (!offerId) {
      res.status(400).json({ valid: false, error: 'Special offer ID is required.' });
      return;
    }

    const verified = await verifySpecialOfferCheckoutPrice({
      offerId: String(offerId),
      packageId,
      packageName,
      category,
      packageType,
      duration,
    });

    if (submittedFinalPrice !== undefined && submittedFinalPrice !== null) {
      const clientPrice = Math.round(Number(submittedFinalPrice));
      if (!Number.isFinite(clientPrice) || clientPrice <= 0 || clientPrice !== verified.finalPrice) {
        res.status(400).json({
          valid: false,
          priceChanged: true,
          error: `The promotional price for "${verified.offer.name}" is LKR ${verified.finalPrice}. Please review the updated total and confirm your order.`,
          submittedFinalPrice: clientPrice,
          verified,
        });
        return;
      }
    }

    res.json({
      valid: true,
      priceChanged: false,
      verified,
    });
  } catch (error: any) {
    console.error('[SpecialOfferController] Error validating special offer price:', error?.message || error);
    res.status(400).json({
      valid: false,
      priceChanged: false,
      error: error?.message || 'Failed to validate special offer price',
    });
  }
};

/**
 * GET /api/admin/special-offers
 * Admin endpoint returning all special offers with computed status and package breakdowns.
 */
export const getAdminSpecialOffersHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const token = extractToken(req);
    const [rawOffers, packages, plans] = await Promise.all([
      getAllSpecialOffers(token),
      getAllAvailablePackages(token, true),
      getLivePlanPricing(true, token),
    ]);

    const nowMs = Date.now();
    const offers = rawOffers.map((offer) =>
      enrichSpecialOfferWithBreakdowns(offer, packages, plans, nowMs)
    );

    res.json({
      offers,
      packages,
      plans,
    });
  } catch (error: any) {
    console.error('[SpecialOfferController] Error fetching admin special offers:', error?.message || error);
    res.status(500).json({ error: error?.message || 'Failed to fetch special offers' });
  }
};

/**
 * POST /api/admin/special-offers
 */
export const createAdminSpecialOfferHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const token = extractToken(req);
    const created = await createSpecialOffer(
      {
        name: req.body?.name,
        description: req.body?.description,
        duration_months: Number(req.body?.duration_months ?? req.body?.duration),
        package_ids: Array.isArray(req.body?.package_ids) ? req.body.package_ids : [],
        promotional_price: Number(req.body?.promotional_price),
        is_enabled: req.body?.is_enabled ?? true,
        is_visible: req.body?.is_visible ?? true,
        start_date: req.body?.start_date || null,
        end_date: req.body?.end_date || null,
        banner_text: req.body?.banner_text || null,
        badge_text: req.body?.badge_text || null,
      },
      token
    );

    const [rawOffers, packages, plans] = await Promise.all([
      getAllSpecialOffers(token),
      getAllAvailablePackages(token, false),
      getLivePlanPricing(false, token),
    ]);

    const nowMs = Date.now();
    res.status(201).json({
      success: true,
      offer: enrichSpecialOfferWithBreakdowns(created, packages, plans, nowMs),
      offers: rawOffers.map((o) => enrichSpecialOfferWithBreakdowns(o, packages, plans, nowMs)),
    });
  } catch (error: any) {
    const safeMessage = error?.message || 'Failed to create special offer';
    console.error('[SpecialOfferController] Error creating special offer:', {
      adminEmail: req.user?.email || 'unknown',
      name: req.body?.name,
      duration_months: req.body?.duration_months ?? req.body?.duration,
      package_ids: req.body?.package_ids,
      promotional_price: req.body?.promotional_price,
      error: safeMessage,
    });
    res.status(400).json({ error: safeMessage });
  }
};

/**
 * PUT /api/admin/special-offers/:id
 */
export const updateAdminSpecialOfferHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Special offer ID is required' });
      return;
    }

    const token = extractToken(req);
    const updated = await updateSpecialOffer(
      id,
      {
        name: req.body?.name,
        description: req.body?.description,
        duration_months: Number(req.body?.duration_months ?? req.body?.duration),
        package_ids: Array.isArray(req.body?.package_ids) ? req.body.package_ids : [],
        promotional_price: Number(req.body?.promotional_price),
        is_enabled: req.body?.is_enabled ?? true,
        is_visible: req.body?.is_visible ?? true,
        start_date: req.body?.start_date || null,
        end_date: req.body?.end_date || null,
        banner_text: req.body?.banner_text || null,
        badge_text: req.body?.badge_text || null,
      },
      token
    );

    const [rawOffers, packages, plans] = await Promise.all([
      getAllSpecialOffers(token),
      getAllAvailablePackages(token, false),
      getLivePlanPricing(false, token),
    ]);

    const nowMs = Date.now();
    res.json({
      success: true,
      offer: enrichSpecialOfferWithBreakdowns(updated, packages, plans, nowMs),
      offers: rawOffers.map((o) => enrichSpecialOfferWithBreakdowns(o, packages, plans, nowMs)),
    });
  } catch (error: any) {
    const safeMessage = error?.message || 'Failed to update special offer';
    console.error('[SpecialOfferController] Error updating special offer:', {
      id: req.params?.id,
      adminEmail: req.user?.email || 'unknown',
      error: safeMessage,
    });
    res.status(400).json({ error: safeMessage });
  }
};

/**
 * PATCH / PUT / POST /api/admin/special-offers/:id/status
 */
export const toggleAdminSpecialOfferHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Special offer ID is required' });
      return;
    }

    const token = extractToken(req);
    const updated = await toggleSpecialOfferState(
      id,
      {
        is_enabled: req.body?.is_enabled !== undefined ? Boolean(req.body.is_enabled) : undefined,
        is_visible: req.body?.is_visible !== undefined ? Boolean(req.body.is_visible) : undefined,
      },
      token
    );

    const [packages, plans] = await Promise.all([
      getAllAvailablePackages(token, false),
      getLivePlanPricing(false, token),
    ]);

    res.json({
      success: true,
      offer: enrichSpecialOfferWithBreakdowns(updated, packages, plans),
    });
  } catch (error: any) {
    const safeMessage = error?.message || 'Failed to update special offer state';
    console.error('[SpecialOfferController] Error toggling special offer state:', {
      id: req.params?.id,
      adminEmail: req.user?.email || 'unknown',
      error: safeMessage,
    });
    res.status(400).json({ error: safeMessage });
  }
};

/**
 * DELETE /api/admin/special-offers/:id
 */
export const deleteAdminSpecialOfferHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Special offer ID is required' });
      return;
    }

    const token = extractToken(req);
    await deleteSpecialOffer(id, token);

    res.json({
      success: true,
      message: 'Special offer deleted successfully',
    });
  } catch (error: any) {
    const safeMessage = error?.message || 'Failed to delete special offer';
    console.error('[SpecialOfferController] Error deleting special offer:', {
      id: req.params?.id,
      adminEmail: req.user?.email || 'unknown',
      error: safeMessage,
    });
    res.status(400).json({ error: safeMessage });
  }
};
