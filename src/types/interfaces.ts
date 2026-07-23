import { Request } from 'express';

export interface AuthUser {
  uid: string;
  email?: string;
  role?: string;
  [key: string]: any;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
  admin?: boolean;
}
