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
  console.log(`[XUI Controller] testConnection called by user: ${req.user?.email}`);
  try {
    const { panelUrl, username, password } = req.body;
    console.log(`[XUI Controller] Testing connection to panel URL: ${panelUrl}`);
    
    // Test authentication
    const cookie = await xuiService.authenticate({ panelUrl, username, password });
    console.log(`[XUI Controller] Authentication successful.`);
    
    res.json({ success: true, connected: true });
  } catch (error: any) {
    console.error(`[XUI Controller] testConnection failed:`, error.message);
    if (error.stack) {
       console.error(`[XUI Controller] Stack trace:`, error.stack);
    }
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
