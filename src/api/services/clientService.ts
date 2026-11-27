import { getClientByEmail } from './xuiService.js';
import * as vpnService from './vpnService.js';
import { getSupabaseClient } from '../../lib/supabase.js';
import dotenv from 'dotenv';

dotenv.config();

export interface GetClientStatusOptions {
  dbClient?: any;
  getMyConfigsOptions?: vpnService.GetMyConfigsOptions;
}

export const getClientStatus = async (
  email: string,
  targetUuid?: string,
  uid?: string,
  token?: string,
  options?: GetClientStatusOptions
): Promise<any | null> => {
  let activeUuid = targetUuid;
  const db = options?.dbClient || getSupabaseClient(token);

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
  const myConfigsRes = await vpnService.getMyConfigs(uid || '', email, token, options?.getMyConfigsOptions);
  const rawConfigs = Array.isArray(myConfigsRes) ? myConfigsRes : (myConfigsRes.configs || []);
  const deletedUuids: string[] = Array.isArray((myConfigsRes as any)?.deletedUuids)
    ? (myConfigsRes as any).deletedUuids.map((u: string) => String(u || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const deletedUuidSet = new Set<string>(deletedUuids);

  // If the caller explicitly requested a UUID that is confirmed permanently deleted in 3X-UI,
  // return an explicit deleted marker instead of silently falling back to another configuration.
  if (targetUuid && deletedUuidSet.has(String(targetUuid).trim().toLowerCase())) {
    return {
      _deleted: true,
      deletedUuid: String(targetUuid).trim(),
      deletedUuids,
    };
  }

  // Only include configurations that have a real UUID, configUrl, and are not pending/rejected/deleted/revoked
  const myConfigs = rawConfigs.filter((c: any) => {
    if (!c || c.isRejected === true || !c.uuid || !c.configUrl) return false;
    const normUuid = String(c.uuid || '').trim().toLowerCase();
    if (deletedUuidSet.has(normUuid)) return false;
    const st = String(c.status || '').toLowerCase().trim();
    const paySt = String(c.paymentStatus || '').toLowerCase().trim();
    const provSt = String(c.provisioningStatus || '').toLowerCase().trim();
    if (
      st === 'pending' ||
      st === 'rejected' ||
      st === 'deleted' ||
      st === 'cancelled' ||
      st === 'revoked' ||
      paySt === 'rejected' ||
      provSt === 'revoked' ||
      provSt === 'revoke_failed' ||
      provSt === 'rejected'
    ) {
      return false;
    }
    return true;
  });

  if (myConfigs.length > 0) {
    // Prefer verified active configs when selecting a default, while keeping disabled/expired/unavailable configs visible
    const now = Date.now();
    const activeOnly = myConfigs.filter((c: any) => {
      const st = String(c.status || '').toLowerCase().trim();
      if (
        st !== 'active' ||
        c.enableStatus !== true ||
        c.enable === false ||
        c.panelStatusVerified === false
      ) {
        return false;
      }
      if (c.expiryDate) {
        const expMs = new Date(c.expiryDate).getTime();
        if (!isNaN(expMs) && expMs > 0 && expMs <= now) return false;
      }
      return true;
    });

    let selectedConfig = null;

    if (activeUuid && !deletedUuidSet.has(String(activeUuid).trim().toLowerCase())) {
      selectedConfig = activeOnly.find((c: any) => c.uuid && String(c.uuid).toLowerCase() === String(activeUuid).toLowerCase())
        || myConfigs.find((c: any) => c.uuid && String(c.uuid).toLowerCase() === String(activeUuid).toLowerCase());
    }

    if (!selectedConfig) {
      selectedConfig = activeOnly[0] || myConfigs[0] || null;
    }

    if (selectedConfig) {
      return {
        email,
        uuid: selectedConfig.uuid,
        orderId: selectedConfig.orderId,
        inboundId: selectedConfig.inboundId,
        remark: selectedConfig.serverNode || 'FIREVPN Server',
        upload: selectedConfig.upload !== undefined ? selectedConfig.upload : (selectedConfig.upBytes || 0),
        download: selectedConfig.download !== undefined ? selectedConfig.download : (selectedConfig.downBytes || 0),
        upBytes: selectedConfig.upBytes !== undefined ? selectedConfig.upBytes : (selectedConfig.upload || 0),
        downBytes: selectedConfig.downBytes !== undefined ? selectedConfig.downBytes : (selectedConfig.download || 0),
        totalTraffic: selectedConfig.totalTrafficBytes !== undefined ? selectedConfig.totalTrafficBytes : (selectedConfig.totalTraffic || 0),
        totalTrafficBytes: selectedConfig.totalTrafficBytes !== undefined ? selectedConfig.totalTrafficBytes : (selectedConfig.totalTraffic || 0),
        remainingTraffic: selectedConfig.remainingTrafficBytes !== undefined ? selectedConfig.remainingTrafficBytes : (selectedConfig.remainingTraffic || 0),
        remainingTrafficBytes: selectedConfig.remainingTrafficBytes !== undefined ? selectedConfig.remainingTrafficBytes : (selectedConfig.remainingTraffic || 0),
        usedGB: selectedConfig.usedGB,
        remainingGB: selectedConfig.remainingGB,
        trafficLimit: selectedConfig.trafficLimit,
        liveUsageFound: selectedConfig.liveUsageFound === true,
        trafficVerified: selectedConfig.trafficVerified === true,
        trafficSource: selectedConfig.trafficSource || 'unknown',
        quotaVerified: selectedConfig.quotaVerified === true,
        usedTrafficKnown: selectedConfig.usedTrafficKnown === true,
        remainingTrafficKnown: selectedConfig.remainingTrafficKnown === true,
        expiryTime: selectedConfig.expiryDate || selectedConfig.expiryTime || 0,
        expiryDate: selectedConfig.expiryDate || selectedConfig.expiryTime || '',
        enable: selectedConfig.enable,
        enableStatus: selectedConfig.enableStatus,
        panelStatusVerified: selectedConfig.panelStatusVerified,
        statusReason: selectedConfig.statusReason,
        onlineStatus: selectedConfig.onlineStatus,
        lastOnline: selectedConfig.lastOnline || 0,
        subId: '',
        port: selectedConfig.port || 443,
        protocol: selectedConfig.protocol || 'vless',
        network: selectedConfig.network || 'tcp',
        security: selectedConfig.security || 'none',
        serverAddress: selectedConfig.serverAddress || 'singapore.firevpn.com',
        serverName: selectedConfig.serverNode || 'Singapore',
        serverNode: selectedConfig.serverNode || 'Singapore',
        subscriptionName: selectedConfig.packageName || 'FIREVPN Package',
        packageName: selectedConfig.packageName || 'FIREVPN Package',
        name: selectedConfig.packageName || 'FIREVPN Package',
        connectionUri: selectedConfig.configUrl,
        configUrl: selectedConfig.configUrl,
        uri: selectedConfig.configUrl,
        status: selectedConfig.status,
        paymentStatus: selectedConfig.paymentStatus || null,
        provisioningStatus: selectedConfig.provisioningStatus || null,
        isTrial: Boolean(selectedConfig.isTrial),
        trafficResetEligible: selectedConfig.trafficResetEligible === true,
        isUnlimitedPlan: selectedConfig.isUnlimitedPlan === true,
        deletedUuids,
      };
    }
  }

  // Do not fall back to unlinked 3X-UI email lookup; return null (with customer-scoped deletedUuids if any)
  // when customer has no real valid VPN configurations in Supabase.
  if (deletedUuids.length > 0) {
    return {
      _noActiveConfig: true,
      deletedUuids,
    };
  }
  return null;
};

export const getSubscriptionUri = async (email: string): Promise<string | null> => {
  const client = await getClientByEmail(email);
  if (client && client.subId) {
    return `${process.env.XUI_URL}/sub/${client.subId}`;
  }
  return null;
};
