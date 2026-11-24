import { getClientByEmail } from './xuiService.js';
import * as vpnService from './vpnService.js';
import { getSupabaseClient } from '../../lib/supabase.js';
import dotenv from 'dotenv';

dotenv.config();

export const getClientStatus = async (email: string, targetUuid?: string, uid?: string, token?: string): Promise<any | null> => {
  let activeUuid = targetUuid;
  const db = getSupabaseClient(token);

  if (!activeUuid && uid) {
    try {
      const { data: profile } = await db.from('profiles').select('active_vpn_uuid, uuid').eq('id', uid).maybeSingle();
      if (profile?.active_vpn_uuid) {
        activeUuid = profile.active_vpn_uuid;
      } else if (profile?.uuid) {
        activeUuid = profile.uuid;
      }
    } catch (e) {
      console.warn('[clientService] Error reading active_vpn_uuid from profile:', e);
    }
  }

  // Fetch all real user configs from Supabase
  const myConfigsRes = await vpnService.getMyConfigs(uid || '', email, token);
  const rawConfigs = Array.isArray(myConfigsRes) ? myConfigsRes : (myConfigsRes.configs || []);

  // Only include configurations that have a real UUID, configUrl, and are not pending/rejected/deleted
  const myConfigs = rawConfigs.filter((c: any) => {
    if (!c || !c.uuid || !c.configUrl) return false;
    const st = String(c.status || '').toLowerCase();
    if (st === 'pending' || st === 'rejected' || st === 'deleted' || st === 'cancelled') return false;
    return true;
  });

  if (myConfigs.length > 0) {
    // Prefer active (non-expired) configs when selecting a default
    const now = Date.now();
    const activeOnly = myConfigs.filter((c: any) => {
      const st = String(c.status || '').toLowerCase();
      if (st === 'expired' || st === 'disabled' || c.enableStatus === false) return false;
      if (c.expiryDate) {
        const expMs = new Date(c.expiryDate).getTime();
        if (!isNaN(expMs) && expMs > 0 && expMs <= now) return false;
      }
      return true;
    });

    let activeConfig = null;

    if (activeUuid) {
      activeConfig = activeOnly.find((c: any) => c.uuid && String(c.uuid).toLowerCase() === String(activeUuid).toLowerCase())
        || myConfigs.find((c: any) => c.uuid && String(c.uuid).toLowerCase() === String(activeUuid).toLowerCase());
    }

    if (!activeConfig) {
      activeConfig = activeOnly[0] || null;
    }

    if (activeConfig) {
      return {
        email,
        uuid: activeConfig.uuid,
        inboundId: activeConfig.inboundId,
        remark: activeConfig.serverNode || 'FIREVPN Server',
        upload: activeConfig.upload !== undefined ? activeConfig.upload : (activeConfig.upBytes || 0),
        download: activeConfig.download !== undefined ? activeConfig.download : (activeConfig.downBytes || 0),
        upBytes: activeConfig.upBytes !== undefined ? activeConfig.upBytes : (activeConfig.upload || 0),
        downBytes: activeConfig.downBytes !== undefined ? activeConfig.downBytes : (activeConfig.download || 0),
        totalTraffic: activeConfig.totalTrafficBytes !== undefined ? activeConfig.totalTrafficBytes : (activeConfig.totalTraffic || 0),
        remainingTraffic: activeConfig.remainingTrafficBytes !== undefined ? activeConfig.remainingTrafficBytes : (activeConfig.remainingTraffic || 0),
        usedGB: activeConfig.usedGB,
        remainingGB: activeConfig.remainingGB,
        trafficLimit: activeConfig.trafficLimit,
        expiryTime: activeConfig.expiryDate || activeConfig.expiryTime || 0,
        expiryDate: activeConfig.expiryDate || activeConfig.expiryTime || '',
        enableStatus: activeConfig.enableStatus,
        onlineStatus: activeConfig.onlineStatus,
        lastOnline: activeConfig.lastOnline || 0,
        subId: '',
        port: activeConfig.port || 443,
        protocol: activeConfig.protocol || 'vless',
        network: activeConfig.network || 'tcp',
        security: activeConfig.security || 'none',
        serverAddress: activeConfig.serverAddress || 'singapore.firevpn.com',
        serverName: activeConfig.serverNode || 'Singapore',
        subscriptionName: activeConfig.packageName || 'FIREVPN Package',
        packageName: activeConfig.packageName || 'FIREVPN Package',
        name: activeConfig.packageName || 'FIREVPN Package',
        connectionUri: activeConfig.configUrl,
        configUrl: activeConfig.configUrl,
        uri: activeConfig.configUrl,
        status: activeConfig.status
      };
    }
  }

  // Do not fall back to unlinked 3X-UI email lookup; return null when customer has no real active VPN configurations in Supabase
  return null;
};

export const getSubscriptionUri = async (email: string): Promise<string | null> => {
  const client = await getClientByEmail(email);
  if (client && client.subId) {
    return `${process.env.XUI_URL}/sub/${client.subId}`;
  }
  return null;
};
