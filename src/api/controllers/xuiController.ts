import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as xuiService from '../services/xuiService.js';
import { supabaseAdmin } from '../../lib/supabase.js';

const MASKED_PASSWORD_SENTINEL = '********';

export const getSettings = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const settings = await xuiService.getMaskedXuiSettings();
    res.json({ success: true, settings });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load 3X-UI settings.' });
  }
};

export const getServerStatus = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const status = await xuiService.getSystemStatus();
    res.json({ success: true, status });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch 3X-UI status.' });
  }
};

export const getInbounds = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const inbounds = await xuiService.getInbounds();
    res.json({ success: true, inbounds });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch 3X-UI inbounds.' });
  }
};

const resolveStoredXuiSecret = async (): Promise<string> => {
  const { data: doc } = await supabaseAdmin
    .from('settings')
    .select('data')
    .eq('id', 'xui')
    .maybeSingle();
  const existing = (doc?.data || {}) as Record<string, any>;
  return String(
    existing.password ||
      existing.apiToken ||
      process.env.XUI_PASSWORD ||
      process.env.XUI_API_TOKEN ||
      ''
  ).trim();
};

export const testConnection = async (req: AuthRequest, res: Response): Promise<void> => {
  console.log(`[XUI Controller] testConnection called by admin: ${req.user?.email}`);
  try {
    const { panelUrl, username, password } = req.body || {};
    const validatedUrl = xuiService.validateXuiPanelUrl(panelUrl);

    let effectivePassword = String(password || '').trim();
    if (!effectivePassword || effectivePassword === MASKED_PASSWORD_SENTINEL) {
      effectivePassword = await resolveStoredXuiSecret();
    }

    if (!effectivePassword) {
      res.status(400).json({ error: 'API token or password is required to test connection.' });
      return;
    }

    await xuiService.testApiConnection({
      panelUrl: validatedUrl,
      apiToken: effectivePassword,
      password: effectivePassword,
      username: String(username || 'admin').trim(),
    });

    res.json({ success: true, connected: true });
  } catch (error: any) {
    console.error(`[XUI Controller] testConnection failed:`, error?.message || error);
    res.status(400).json({ error: error?.message || 'Connection test failed.' });
  }
};

export const saveSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { panelUrl, username, password, panelName } = req.body || {};
    const validatedUrl = xuiService.validateXuiPanelUrl(panelUrl);
    const cleanUsername = String(username || 'admin').trim();
    const cleanPanelName = String(panelName || 'Primary Node').trim().slice(0, 120);

    let effectivePassword = String(password || '').trim();
    if (!effectivePassword || effectivePassword === MASKED_PASSWORD_SENTINEL) {
      effectivePassword = await resolveStoredXuiSecret();
    }

    if (!effectivePassword) {
      res.status(400).json({ error: 'API token or password is required.' });
      return;
    }

    let connected = false;
    try {
      await xuiService.testApiConnection({
        panelUrl: validatedUrl,
        apiToken: effectivePassword,
        password: effectivePassword,
        username: cleanUsername,
      });
      connected = true;
    } catch (testErr: any) {
      console.warn('[XUI Controller] Saved settings connection check failed:', testErr?.message || testErr);
    }

    await supabaseAdmin.from('settings').upsert(
      {
        id: 'xui',
        data: {
          panelUrl: validatedUrl,
          apiToken: effectivePassword,
          username: cleanUsername,
          panelName: cleanPanelName,
          status: connected ? 'connected' : 'disconnected',
          lastSync: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );

    xuiService.invalidateXuiConfigCache();

    res.json({ success: true, connected });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Failed to save 3X-UI settings.' });
  }
};

export const deleteSettings = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    await supabaseAdmin.from('settings').delete().eq('id', 'xui');
    xuiService.invalidateXuiConfigCache();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to remove 3X-UI settings.' });
  }
};

export const syncClients = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await xuiService.syncDeleted3XUiClients();
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || 'Synchronization failed' });
  }
};

