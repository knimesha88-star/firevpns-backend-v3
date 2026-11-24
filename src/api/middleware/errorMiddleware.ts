import { Request, Response, NextFunction } from 'express';

export const errorMiddleware = (err: any, _req: Request, res: Response, _next: NextFunction): void => {
  console.error('[ErrorMiddleware] Unhandled API error:', err?.message || err);
  if (process.env.NODE_ENV !== 'production' && err?.stack) {
    console.error(err.stack);
  }

  const rawStatus = typeof err?.statusCode === 'number' ? err.statusCode : typeof err?.status === 'number' ? err.status : 500;
  const statusCode = rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;

  const isProd = process.env.NODE_ENV === 'production';
  res.status(statusCode).json({
    success: false,
    error: isProd && statusCode >= 500 ? 'Internal Server Error' : (err?.message || 'Internal Server Error'),
  });
};

