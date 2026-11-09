import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import {
  resolvePaymentSlipSignedUrl,
  uploadPaymentSlipViaBackend,
} from '../services/paymentSlipService.js';

const extractBearerToken = (req: AuthRequest): string | undefined => {
  const authHeader =
    req.headers.authorization ||
    (req.headers as any).Authorization ||
    req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }
  return undefined;
};

/**
 * POST /api/vpn/payment-slips/signed-url
 * GET  /api/vpn/payment-slips/signed-url?slipUrl=...
 * POST /api/admin/payment-slips/signed-url
 *
 * Resolves any stored payment slip URL or storage path into a fresh signed URL
 * from the private `payment-slips` bucket.
 */
export const getPaymentSlipSignedUrlHandler = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const rawSlipUrl =
      req.body?.slipUrl ||
      req.body?.slip_url ||
      req.body?.path ||
      (req.query?.slipUrl as string) ||
      (req.query?.slip_url as string) ||
      (req.query?.path as string) ||
      '';

    const expiresInSeconds = Number(
      req.body?.expiresIn || req.query?.expiresIn || 3600
    );

    const result = await resolvePaymentSlipSignedUrl({
      slipUrlOrPath: String(rawSlipUrl),
      requesterUid: req.user?.uid,
      requesterEmail: req.user?.email,
      isAdmin: Boolean(req.admin),
      userToken: extractBearerToken(req),
      expiresInSeconds,
    });

    if (!result.success) {
      const status =
        result.code === 'FORBIDDEN'
          ? 403
          : result.code === 'INVALID_INPUT'
          ? 400
          : 404;
      res.status(status).json(result);
      return;
    }

    res.json(result);
  } catch (error: any) {
    console.error('[PaymentSlipController] Signed URL error:', error?.message || error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to generate signed URL for payment slip.',
    });
  }
};

/**
 * POST /api/vpn/payment-slips/upload
 * Authenticated fallback upload endpoint for storing payment slips in `payment-slips`.
 */
export const uploadPaymentSlipHandler = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { fileName, contentType, base64Data, folder } = req.body || {};
    if (!base64Data || typeof base64Data !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Missing base64Data payload for payment slip upload.',
      });
      return;
    }

    const userEmailOrId = req.user?.email || req.user?.uid || 'customer';
    const result = await uploadPaymentSlipViaBackend({
      fileName: fileName || 'receipt.png',
      contentType: contentType || 'image/png',
      base64Data,
      folder: folder || 'orders',
      userEmailOrId,
      userToken: extractBearerToken(req),
    });

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  } catch (error: any) {
    console.error('[PaymentSlipController] Upload error:', error?.message || error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to upload payment slip.',
    });
  }
};
