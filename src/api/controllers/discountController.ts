import { Request, Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import {
  getAllDiscounts,
  getActiveDiscounts,
  getAllAvailablePackages,
  createDiscount,
  updateDiscount,
  toggleDiscountStatus,
  deleteDiscount,
  computeDiscountStatus,
  calculateVerifiedOrderPrice,
  getLivePlanPricing,
  saveLivePlanPricing,
  invalidatePricingCache,
} from '../services/discountService.js';

function extractToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split('Bearer ')[1].trim();
  }
  return undefined;
}

/**
 * GET /api/vpn/discounts/active
 * Public endpoint returning currently active discounts, available packages, and live package pricing for the Store UI.
 */
export const getPublicActiveDiscountsHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const [activeDiscounts, packages, plans] = await Promise.all([
      getActiveDiscounts(),
      getAllAvailablePackages(undefined, true),
      getLivePlanPricing(true),
    ]);
    res.json({
      discounts: activeDiscounts,
      packages,
      plans,
      serverTime: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[DiscountController] Error fetching active discounts:', error?.message || error);
    res.status(500).json({ error: error?.message || 'Failed to fetch active discounts' });
  }
};

/**
 * POST /api/vpn/validate-order-price
 * Server-side price, discount & special offer calculation and validation before order creation.
 */
export const validateOrderPriceHandler = async (req: Request, res: Response): Promise<void> => {
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

    if (offerId) {
      const { verifySpecialOfferCheckoutPrice } = await import('../services/specialOfferService.js');
      const offerVerified = await verifySpecialOfferCheckoutPrice({
        offerId: String(offerId),
        packageId,
        packageName,
        category,
        packageType,
        duration,
      });

      const verifiedPayload = {
        packageId: offerVerified.packageId,
        packageName: offerVerified.packageName,
        originalPrice: offerVerified.originalPrice,
        discountAmount: offerVerified.discountAmount,
        discountPercentage: offerVerified.discountPercentage,
        finalPrice: offerVerified.finalPrice,
        appliedDiscount: null,
        appliedOffer: offerVerified.offer,
        durationMonths: offerVerified.durationMonths,
        durationLabel: offerVerified.durationLabel,
        plans: offerVerified.plans,
      };

      if (submittedFinalPrice !== undefined && submittedFinalPrice !== null) {
        const clientPrice = Math.round(Number(submittedFinalPrice));
        if (!Number.isFinite(clientPrice) || clientPrice <= 0 || clientPrice !== offerVerified.finalPrice) {
          res.status(400).json({
            valid: false,
            priceChanged: true,
            error: `The promotional price for "${offerVerified.offer.name}" is LKR ${offerVerified.finalPrice}. Please review the updated total and confirm your order again.`,
            submittedFinalPrice: clientPrice,
            verified: verifiedPayload,
          });
          return;
        }
      }

      res.json({
        valid: true,
        priceChanged: false,
        verified: verifiedPayload,
      });
      return;
    }

    const verified = await calculateVerifiedOrderPrice({
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
          error: `The price for this package has been updated to LKR ${verified.finalPrice}. Please review the updated total and confirm your order again.`,
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
    console.error('[DiscountController] Error validating order price:', error?.message || error);
    const msg = String(error?.message || '').toLowerCase();
    const isClientErr =
      msg.includes('inactive or unavailable') ||
      msg.includes('special offer') ||
      msg.includes('not eligible') ||
      msg.includes('invalid duration') ||
      msg.includes('expired') ||
      msg.includes('disabled');
    res.status(isClientErr ? 400 : 500).json({
      valid: false,
      priceChanged: false,
      error: error?.message || 'Failed to validate order price',
    });
  }
};

/**
 * GET /api/admin/discounts
 * Admin endpoint returning all discounts with computed status, available packages, and live plan pricing.
 */
export const getAdminDiscountsHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const token = extractToken(req);
    const [discounts, packages, plans] = await Promise.all([
      getAllDiscounts(token),
      getAllAvailablePackages(token, true),
      getLivePlanPricing(true, token),
    ]);

    const nowMs = Date.now();
    const enriched = discounts.map((d) => ({
      ...d,
      status: computeDiscountStatus(d, nowMs),
    }));

    res.json({
      discounts: enriched,
      packages,
      plans,
    });
  } catch (error: any) {
    console.error('[DiscountController] Error fetching admin discounts:', error?.message || error);
    res.status(500).json({ error: error?.message || 'Failed to fetch discounts' });
  }
};

/**
 * POST /api/admin/pricing
 * Admin endpoint to save package prices in Supabase `settings` (id = 'app') and invalidate pricing cache.
 */
export const saveAdminPricingHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const token = extractToken(req);
    const { sim100, simUnlimited, routerUnlimited, packagePrices, plans } = req.body || {};

    const updatedPlans = await saveLivePlanPricing(
      {
        sim100: sim100 ?? plans?.sim100,
        simUnlimited: simUnlimited ?? plans?.simUnlimited,
        routerUnlimited: routerUnlimited ?? plans?.routerUnlimited,
        packagePrices: packagePrices ?? plans?.packagePrices,
      },
      token
    );

    const packages = await getAllAvailablePackages(token, true);

    res.json({
      success: true,
      plans: updatedPlans,
      packages,
    });
  } catch (error: any) {
    console.error('[DiscountController] Error saving admin pricing:', error?.message || error);
    res.status(400).json({ error: error?.message || 'Failed to save package prices' });
  }
};

/**
 * POST /api/admin/pricing/invalidate
 * Admin endpoint to immediately invalidate backend cached pricing after settings update.
 */
export const invalidateAdminPricingHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const token = extractToken(req);
    invalidatePricingCache();
    const [plans, packages] = await Promise.all([
      getLivePlanPricing(true, token),
      getAllAvailablePackages(token, true),
    ]);
    res.json({
      success: true,
      plans,
      packages,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to refresh pricing cache' });
  }
};

/**
 * POST /api/admin/discounts
 */
export const createAdminDiscountHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const token = extractToken(req);
    const created = await createDiscount(
      {
        name: req.body?.name,
        description: req.body?.description,
        discount_type: req.body?.discount_type,
        discount_amount: Number(req.body?.discount_amount),
        discount_percentage:
          req.body?.discount_percentage !== undefined ? Number(req.body?.discount_percentage) : null,
        package_ids: Array.isArray(req.body?.package_ids) ? req.body.package_ids : [],
        start_date: req.body?.start_date || null,
        end_date: req.body?.end_date || null,
        is_active: req.body?.is_active ?? true,
        banner_text: req.body?.banner_text || null,
        badge_text: req.body?.badge_text || null,
      },
      token
    );

    res.status(201).json({
      success: true,
      discount: {
        ...created,
        status: computeDiscountStatus(created),
      },
    });
  } catch (error: any) {
    console.error('[DiscountController] Error creating discount:', error?.message || error);
    res.status(400).json({ error: error?.message || 'Failed to create discount' });
  }
};

/**
 * PUT /api/admin/discounts/:id
 */
export const updateAdminDiscountHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Discount ID is required' });
      return;
    }

    const token = extractToken(req);
    const updated = await updateDiscount(
      id,
      {
        name: req.body?.name,
        description: req.body?.description,
        discount_type: req.body?.discount_type,
        discount_amount: Number(req.body?.discount_amount),
        discount_percentage:
          req.body?.discount_percentage !== undefined ? Number(req.body?.discount_percentage) : null,
        package_ids: Array.isArray(req.body?.package_ids) ? req.body.package_ids : [],
        start_date: req.body?.start_date || null,
        end_date: req.body?.end_date || null,
        is_active: req.body?.is_active ?? true,
        banner_text: req.body?.banner_text || null,
        badge_text: req.body?.badge_text || null,
      },
      token
    );

    res.json({
      success: true,
      discount: {
        ...updated,
        status: computeDiscountStatus(updated),
      },
    });
  } catch (error: any) {
    console.error('[DiscountController] Error updating discount:', error?.message || error);
    res.status(400).json({ error: error?.message || 'Failed to update discount' });
  }
};

/**
 * PATCH / PUT / POST /api/admin/discounts/:id/status
 */
export const toggleAdminDiscountHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Discount ID is required' });
      return;
    }

    const token = extractToken(req);
    const isActive = Boolean(req.body?.is_active);
    const updated = await toggleDiscountStatus(id, isActive, token);

    res.json({
      success: true,
      discount: {
        ...updated,
        status: computeDiscountStatus(updated),
      },
    });
  } catch (error: any) {
    console.error('[DiscountController] Error toggling discount status:', error?.message || error);
    res.status(400).json({ error: error?.message || 'Failed to update discount status' });
  }
};

/**
 * DELETE /api/admin/discounts/:id
 */
export const deleteAdminDiscountHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Discount ID is required' });
      return;
    }

    const token = extractToken(req);
    await deleteDiscount(id, token);

    res.json({
      success: true,
      message: 'Discount deleted successfully',
    });
  } catch (error: any) {
    console.error('[DiscountController] Error deleting discount:', error?.message || error);
    res.status(400).json({ error: error?.message || 'Failed to delete discount' });
  }
};
