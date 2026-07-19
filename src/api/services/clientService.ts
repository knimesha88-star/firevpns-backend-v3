import { getClientByEmail } from './xuiService.js';
import { VPNClient } from '../../types/models.js';
import dotenv from 'dotenv';

dotenv.config();

export const getClientStatus = async (email: string): Promise<VPNClient | null> => {
  return await getClientByEmail(email);
};

export const getSubscriptionUri = async (email: string): Promise<string | null> => {
  const client = await getClientByEmail(email);
  if (client && client.subId) {
    return `${process.env.XUI_URL}/sub/${client.subId}`;
  }
  return null;
};
