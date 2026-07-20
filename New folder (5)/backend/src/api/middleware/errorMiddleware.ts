import { Request, Response, NextFunction } from 'express';

export const errorMiddleware = (err: any, req: Request, res: Response, next: NextFunction): void => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
};
