import { Request, Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import {
  getAllDiscounts,
  getActiveDiscounts,
  getAllAvailablePackages,
  createDiscount,
  updateDiscount,
  deleteDiscount,
  calculateVerifiedOrderPrice,
} from '../services/discountService.js';

function extractBearerToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization || (req.headers as any)?.Authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return undefined;
}

export const getAdminDiscountsHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const token = extractBearerToken(req);
    const [discounts, packages] = await Promise.all([
      getAllDiscounts(token),
      getAllAvailablePackages(),
    ]);
    res.json({
      success: true,
      discounts,
      packages,
    });
  } catch (err: any) {
    console.error('[DiscountController] Error fetching admin discounts:', err);
    res.status(500).json({ error: err.message || 'Failed to load discounts.' });
  }
};

export const createAdminDiscountHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const token = extractBearerToken(req);
    const { name, discount_amount, package_ids, start_date, end_date, is_active } = req.body || {};
    const created = await createDiscount(
      {
        name,
        discount_amount: Number(discount_amount),
        package_ids: Array.isArray(package_ids) ? package_ids : [],
        start_date,
        end_date,
        is_active: is_active !== undefined ? Boolean(is_active) : true,
      },
      token
    );
    res.status(201).json({
      success: true,
      discount: created,
    });
  } catch (err: any) {
    console.warn('[DiscountController] Validation/creation error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to create discount.' });
  }
};

export const updateAdminDiscountHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const token = extractBearerToken(req);
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Discount ID is required.' });
      return;
    }
    const { name, discount_amount, package_ids, start_date, end_date, is_active } = req.body || {};
    const updated = await updateDiscount(
      id,
      {
        ...(name !== undefined ? { name } : {}),
        ...(discount_amount !== undefined ? { discount_amount: Number(discount_amount) } : {}),
        ...(package_ids !== undefined ? { package_ids } : {}),
        ...(start_date !== undefined ? { start_date } : {}),
        ...(end_date !== undefined ? { end_date } : {}),
        ...(is_active !== undefined ? { is_active: Boolean(is_active) } : {}),
      },
      token
    );
    res.json({
      success: true,
      discount: updated,
    });
  } catch (err: any) {
    console.warn('[DiscountController] Update error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to update discount.' });
  }
};

export const toggleAdminDiscountHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const token = extractBearerToken(req);
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Discount ID is required.' });
      return;
    }
    const { is_active } = req.body || {};
    if (typeof is_active !== 'boolean') {
      res.status(400).json({ error: 'is_active boolean is required.' });
      return;
    }
    const updated = await updateDiscount(id, { is_active }, token);
    res.json({
      success: true,
      discount: updated,
    });
  } catch (err: any) {
    console.warn('[DiscountController] Toggle error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to update discount status.' });
  }
};

export const deleteAdminDiscountHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const token = extractBearerToken(req);
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Discount ID is required.' });
      return;
    }
    await deleteDiscount(id, token);
    res.json({
      success: true,
      message: 'Discount deleted successfully.',
    });
  } catch (err: any) {
    console.warn('[DiscountController] Delete error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to delete discount.' });
  }
};

export const getPublicActiveDiscountsHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    const discounts = await getActiveDiscounts(new Date());
    res.json({
      success: true,
      discounts,
      serverTime: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[DiscountController] Error fetching active discounts:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch active discounts.' });
  }
};

export const validateOrderPriceHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      packageId,
      packageName,
      category,
      packageType,
      duration,
      submittedOriginalPrice,
      submittedDiscountAmount,
      submittedFinalPrice,
    } = req.body || {};

    const verified = await calculateVerifiedOrderPrice({
      packageId,
      packageName,
      category,
      packageType,
      duration,
    });

    // Check if the client attempted to tamper with discount amount or final price
    if (
      submittedDiscountAmount !== undefined &&
      submittedDiscountAmount !== null &&
      Number(submittedDiscountAmount) !== verified.discountAmount
    ) {
      res.status(400).json({
        success: false,
        tampered: true,
        error: `Invalid discount amount (LKR ${submittedDiscountAmount}). Server verified discount for this package is LKR ${verified.discountAmount}.`,
        verified,
      });
      return;
    }

    if (
      submittedFinalPrice !== undefined &&
      submittedFinalPrice !== null &&
      Number(submittedFinalPrice) !== verified.finalPrice
    ) {
      res.status(400).json({
        success: false,
        tampered: true,
        error: `Invalid order total (LKR ${submittedFinalPrice}). Server verified final price for this package is LKR ${verified.finalPrice}.`,
        verified,
      });
      return;
    }

    if (
      submittedOriginalPrice !== undefined &&
      submittedOriginalPrice !== null &&
      Number(submittedOriginalPrice) !== verified.originalPrice
    ) {
      res.status(400).json({
        success: false,
        tampered: true,
        error: `Invalid original package price (LKR ${submittedOriginalPrice}). Server verified original price is LKR ${verified.originalPrice}.`,
        verified,
      });
      return;
    }

    res.json({
      success: true,
      verified,
    });
  } catch (err: any) {
    console.error('[DiscountController] Error validating order price:', err);
    res.status(500).json({ error: err.message || 'Failed to validate order price.' });
  }
};
