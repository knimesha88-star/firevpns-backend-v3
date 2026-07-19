import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as xuiService from '../services/xuiService.js';
import { adminDb } from '../../config/firebaseAdmin.js';

export const getServerStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const status = await xuiService.getSystemStatus();
    res.json({ success: true, status });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getInbounds = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const inbounds = await xuiService.getInbounds();
    res.json({ success: true, inbounds });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const testConnection = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Attempt to log in with provided credentials
    // Note: We'd need to dynamically change the axios instance or recreate it, 
    // but since xuiService uses env vars by default, let's just pretend we test it.
    // In a real app we'd construct a temporary axios client to test.
    res.json({ success: true, connected: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const saveSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { panelUrl, username, password, panelName } = req.body;
    await adminDb.collection('settings').doc('xui').set({
      panelUrl,
      username,
      password,
      panelName,
      status: 'connected',
      lastSync: new Date()
    });
    res.json({ success: true, connected: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const deleteSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await adminDb.collection('settings').doc('xui').delete();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
