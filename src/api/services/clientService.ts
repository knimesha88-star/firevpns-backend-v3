import { getClientByEmail } from './xuiService.js';
import * as vpnService from './vpnService.js';
import { supabase } from '../../lib/supabase.js';
import dotenv from 'dotenv';

dotenv.config();

export const getClientStatus = async (email: string, targetUuid?: string, uid?: string): Promise<any | null> => {
  let activeUuid = targetUuid;

  if (!activeUuid && uid) {
    try {
      const { data: profile } = await supabase.from('profiles').select('active_vpn_uuid, uuid').eq('id', uid).maybeSingle();
      if (profile?.active_vpn_uuid) {
        activeUuid = profile.active_vpn_uuid;
      } else if (profile?.uuid) {
        activeUuid = profile.uuid;
      }
    } catch (e) {
      console.warn('[clientService] Error reading active_vpn_uuid from profile:', e);
    }
  }

  // Fetch all user configs
  const myConfigs = await vpnService.getMyConfigs(uid || '', email);

  if (myConfigs && myConfigs.length > 0) {
    let activeConfig = null;

    if (activeUuid) {
      activeConfig = myConfigs.find((c: any) => c.uuid && String(c.uuid).toLowerCase() === String(activeUuid).toLowerCase());
    }

    if (!activeConfig) {
      activeConfig = myConfigs[0];
    }

    if (activeConfig) {
      console.log(`[clientService] Found active config: UUID: ${activeConfig.uuid}, ServerNode: ${activeConfig.serverNode}, Upload: ${activeConfig.upload}, Download: ${activeConfig.download}`);
      return {
        email,
        uuid: activeConfig.uuid,
        inboundId: activeConfig.inboundId,
        remark: activeConfig.serverNode || 'FIREVPN Server',
        upload: activeConfig.upload || 0,
        download: activeConfig.download || 0,
        totalTraffic: activeConfig.totalTrafficBytes || 0,
        remainingTraffic: activeConfig.remainingTrafficBytes || 0,
        expiryTime: activeConfig.expiryDate || activeConfig.expiryTime || 0,
        enableStatus: activeConfig.enableStatus,
        onlineStatus: activeConfig.onlineStatus,
        subId: '',
        port: activeConfig.port || 443,
        protocol: activeConfig.protocol || 'vless',
        network: activeConfig.network || 'tcp',
        security: activeConfig.security || 'none',
        serverAddress: activeConfig.serverAddress || 'singapore.firevpn.com',
        serverName: activeConfig.serverNode || 'Singapore',
        subscriptionName: activeConfig.packageName || 'Active Plan',
        name: activeConfig.packageName || 'Active Plan',
        connectionUri: activeConfig.configUrl,
        uri: activeConfig.configUrl,
        status: activeConfig.status
      };
    } else {
      console.warn(`[clientService] Active config not found for email: ${email}, targetUuid: ${targetUuid}, uid: ${uid}`);
    }
  }

  // Fallback to legacy lookup
  const legacyClient = await getClientByEmail(email);
  if (!legacyClient) {
    throw new Error(`VPN client not found for user: ${email}`);
  }
  return legacyClient;
};

export const getSubscriptionUri = async (email: string): Promise<string | null> => {
  const client = await getClientByEmail(email);
  if (client && client.subId) {
    return `${process.env.XUI_URL}/sub/${client.subId}`;
  }
  return null;
};
