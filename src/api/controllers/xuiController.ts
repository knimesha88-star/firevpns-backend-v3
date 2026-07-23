import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as xuiService from '../services/xuiService.js';
import { supabase } from '../../lib/supabase.js';

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
    
    await xuiService.testApiConnection({ panelUrl, apiToken: password, username });
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
    await supabase.from('settings').upsert({
      id: 'xui',
      data: {
        panelUrl,
        apiToken: password, // Store password as apiToken
        username,
        panelName,
        status: 'connected',
        lastSync: new Date().toISOString()
      },
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });
    res.json({ success: true, connected: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const deleteSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await supabase.from('settings').delete().eq('id', 'xui');
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
