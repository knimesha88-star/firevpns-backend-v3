import { supabase, supabaseAdmin, getSupabaseClient } from '../../lib/supabase.js';
import { getCachedInbounds, getLiveInbound, getInbounds, resetClientTraffic } from './xuiService.js';
import { createCustomerNotification } from './notificationService.js';
import crypto from 'crypto';

export type VpnObservedStatus =
  | 'Active'
  | 'Disabled'
  | 'Expired'
  | 'Data Limit Reached'
  | 'Status Unavailable';

export interface EvaluateVpnClientStatusInput {
  panelReachable: boolean;
  inboundFound: boolean;
  inboundEnable?: boolean | null;
  clientFound: boolean;
  clientEnable?: boolean | null;
  statEnable?: boolean | null;
  upBytes?: number;
  downBytes?: number;
  totalLimitBytes?: number;
  expiryTimeMs?: number | null;
  nowMs?: number;
}

export interface EvaluateVpnClientStatusResult {
  status: VpnObservedStatus;
  panelStatusVerified: boolean;
  effectiveEnable: boolean | null;
  enableStatus: boolean;
  isExpiredByTime: boolean;
  isDataLimitReached: boolean;
  isManuallyDisabled: boolean;
  isInboundDisabled: boolean;
  isUnlimited: boolean;
  statusReason: string;
}

/**
 * Pure deterministic evaluator for observed 3X-UI VPN client status.
 * Never lets stale clientStats.enable=true override settings.clients[].enable=false
 * or a disabled inbound, and never reports unverified/unreachable state as Active.
 */
export const evaluateVpnClientStatus = (
  input: EvaluateVpnClientStatusInput
): EvaluateVpnClientStatusResult => {
  const nowMs = input.nowMs ?? Date.now();
  const up = Math.max(0, Number(input.upBytes || 0) || 0);
  const down = Math.max(0, Number(input.downBytes || 0) || 0);
  const totalUsed = up + down;
  const totalLimit = Math.max(0, Number(input.totalLimitBytes || 0) || 0);
  const isUnlimited = totalLimit <= 0;
  const isDataLimitReached = !isUnlimited && totalUsed >= totalLimit;
  const expMs = input.expiryTimeMs ?? 0;
  const isExpiredByTime = (expMs > 0 && expMs <= nowMs) || expMs < 0;

  if (!input.panelReachable || !input.inboundFound || !input.clientFound) {
    return {
      status: 'Status Unavailable',
      panelStatusVerified: false,
      effectiveEnable: null,
      enableStatus: false,
      isExpiredByTime,
      isDataLimitReached,
      isManuallyDisabled: false,
      isInboundDisabled: false,
      isUnlimited,
      statusReason: !input.panelReachable
        ? 'panel_unreachable'
        : !input.inboundFound
          ? 'inbound_unavailable'
          : 'client_unverified',
    };
  }

  const isInboundDisabled = input.inboundEnable === false;
  const isClientSettingDisabled = input.clientEnable === false;
  const isStatDisabled = input.statEnable === false;
  const effectiveEnable = !isInboundDisabled && !isClientSettingDisabled && !isStatDisabled;
  const isManuallyDisabled = isInboundDisabled || isClientSettingDisabled || isStatDisabled;

  let status: VpnObservedStatus = 'Active';
  let statusReason = 'active';

  if (isExpiredByTime) {
    status = 'Expired';
    statusReason = 'expired';
  } else if (isDataLimitReached) {
    status = 'Data Limit Reached';
    statusReason = 'data_limit_reached';
  } else if (!effectiveEnable) {
    status = 'Disabled';
    statusReason = isInboundDisabled
      ? 'inbound_disabled'
      : isClientSettingDisabled
        ? 'client_disabled'
        : 'traffic_disabled';
  }

  return {
    status,
    panelStatusVerified: true,
    effectiveEnable,
    enableStatus: status === 'Active',
    isExpiredByTime,
    isDataLimitReached,
    isManuallyDisabled,
    isInboundDisabled,
    isUnlimited,
    statusReason,
  };
};

export const getMyConfigs = async (uid: string, email?: string, _token?: string): Promise<{ configs: any[]; dbTime: number }> => {
  const dbStart = Date.now();
  const userEmail = email ? email.toLowerCase().trim() : '';
  const userUid = uid ? uid.trim() : '';
  const db = getSupabaseClient(_token);

  if (!userUid && !userEmail) {
    return { configs: [], dbTime: 0 };
  }

  // Query vpn_configs scoped strictly to this customer by customer_uid and user_id (no full-table scan)
  const vpnConfigsMap = new Map<string, any>();
  if (userUid) {
    try {
      const [byCustomerUidRes, byUserIdRes] = await Promise.all([
        db.from('vpn_configs').select('*').eq('customer_uid', userUid),
        db.from('vpn_configs').select('*').eq('user_id', userUid),
      ]);
      const combinedCfgs = [
        ...(Array.isArray(byCustomerUidRes.data) ? byCustomerUidRes.data : []),
        ...(Array.isArray(byUserIdRes.data) ? byUserIdRes.data : []),
      ];
      combinedCfgs.forEach((cfg: any) => {
        const key = String(cfg.id || cfg.uuid || cfg.order_id || Math.random());
        vpnConfigsMap.set(key, cfg);
      });
    } catch (_e) {}
  }
  const vpnConfigsData = Array.from(vpnConfigsMap.values());
  const inboundMap = new Map<string, number>();
  const deletedOrInactiveUuids = new Set<string>();
  vpnConfigsData.forEach(cfg => {
    const cfgStatus = String(cfg.status || '').toLowerCase().trim();
    if (
      cfgStatus === 'deleted' ||
      cfgStatus === 'rejected' ||
      cfgStatus === 'cancelled' ||
      cfgStatus === 'pending' ||
      cfgStatus === 'disabled' ||
      cfgStatus === 'revoked'
    ) {
      if (cfg.uuid) deletedOrInactiveUuids.add(String(cfg.uuid).trim().toLowerCase());
    }
    const ibId = Number(cfg.inbound_id);
    if (!isNaN(ibId) && ibId > 0) {
      if (cfg.order_id) inboundMap.set(String(cfg.order_id), ibId);
      if (cfg.uuid) inboundMap.set(String(cfg.uuid).toLowerCase(), ibId);
    }
  });

  // Query orders table scoped strictly to this customer (by customer_id and legacy email fallback)
  const ordersById = new Map<string, any>();
  if (userUid) {
    try {
      const { data: ordersByUid } = await db
        .from('orders')
        .select('*')
        .eq('customer_id', userUid);
      if (Array.isArray(ordersByUid)) {
        ordersByUid.forEach((ord: any) => {
          const key = String(ord.id || ord.order_id || Math.random());
          ordersById.set(key, ord);
        });
      }
    } catch (_e) {}
  }
  if (userEmail) {
    try {
      const { data: ordersByEmail } = await db
        .from('orders')
        .select('*')
        .ilike('email', userEmail);
      if (Array.isArray(ordersByEmail)) {
        ordersByEmail.forEach((ord: any) => {
          const docUid = String(ord.customer_id || ord.customerUid || ord.customerId || ord.uid || ord.userId || '').trim();
          // Only include email-matched rows when they belong to this UID or have no UID recorded
          if (!userUid || !docUid || docUid === userUid) {
            const key = String(ord.id || ord.order_id || Math.random());
            ordersById.set(key, ord);
          }
        });
      }
    } catch (_e) {}
  }
  const allOrders: any[] = Array.from(ordersById.values());

  const isOrderProvisionallyActive = (ord: any): boolean => {
    const rawStatus = String(ord.status || '').toLowerCase().trim();
    const rawPayStatus = String(ord.payment_status || '').toLowerCase().trim();
    if (
      rawStatus === 'rejected' ||
      rawStatus === 'cancelled' ||
      rawStatus === 'deleted' ||
      rawStatus === 'expired' ||
      rawPayStatus === 'cancelled' ||
      rawPayStatus === 'rejected'
    ) {
      return false;
    }
    const provStatus = String(ord.provisioning_status || '').toLowerCase().trim();
    if (provStatus === 'revoked' || provStatus === 'revoke_failed' || provStatus === 'rejected') {
      return false;
    }
    const cUuid = String(ord.client_uuid || '').trim().toLowerCase();
    if (cUuid && deletedOrInactiveUuids.has(cUuid)) {
      return false;
    }
    return (
      provStatus === 'provisional' &&
      Boolean(ord.vless_url) &&
      Boolean(ord.client_uuid)
    );
  };

  const nonApprovedOrderIds = new Set<string>();
  const nonApprovedOrderUuids = new Set<string>();

  // Defense-in-depth: also inspect vpn_entitlement_grants for this customer's orders
  // so revoked / revoke_failed grants are strictly excluded and authoritative inbound_id is available.
  const customerOrderRowIds = allOrders
    .map(ord => (ord?.id ? String(ord.id).trim() : ''))
    .filter(Boolean);
  if (customerOrderRowIds.length > 0 && supabaseAdmin) {
    try {
      const { data: grants } = await supabaseAdmin
        .from('vpn_entitlement_grants')
        .select('order_id, client_uuid, inbound_id, status')
        .in('order_id', customerOrderRowIds);
      if (Array.isArray(grants)) {
        grants.forEach((g: any) => {
          const gStatus = String(g.status || '').toLowerCase().trim();
          const gUuid = String(g.client_uuid || '').trim().toLowerCase();
          const gOrderId = String(g.order_id || '').trim();
          const gIbId = Number(g.inbound_id);
          if (!Number.isNaN(gIbId) && gIbId > 0) {
            if (gOrderId && !inboundMap.has(gOrderId)) inboundMap.set(gOrderId, gIbId);
            if (gUuid && !inboundMap.has(gUuid)) inboundMap.set(gUuid, gIbId);
          }
          if (
            gStatus === 'revoked' ||
            gStatus === 'revoke_failed' ||
            gStatus === 'rejected' ||
            gStatus === 'cancelled' ||
            gStatus === 'deleted'
          ) {
            if (gOrderId) nonApprovedOrderIds.add(gOrderId);
            if (gUuid) {
              nonApprovedOrderUuids.add(gUuid);
              deletedOrInactiveUuids.add(gUuid);
            }
          }
        });
      }
    } catch (_grantErr) {
      // Non-blocking if table or rows are absent
    }
  }

  allOrders.forEach(ord => {
    const rawStatus = String(ord.status || '').toLowerCase().trim();
    if (isOrderProvisionallyActive(ord)) {
      return;
    }
    const provStatus = String(ord.provisioning_status || '').toLowerCase().trim();
    if (
      rawStatus === 'pending' ||
      rawStatus === 'rejected' ||
      rawStatus === 'cancelled' ||
      rawStatus === 'deleted' ||
      rawStatus === 'expired' ||
      rawStatus === 'provisioning' ||
      provStatus === 'revoked' ||
      provStatus === 'revoke_failed' ||
      provStatus === 'rejected'
    ) {
      if (ord.id) nonApprovedOrderIds.add(String(ord.id).trim());
      if (ord.order_id) nonApprovedOrderIds.add(String(ord.order_id).trim());
      const cUuid = String(ord.client_uuid || ord.vpn_credentials?.password || ord.uuid || '').trim().toLowerCase();
      if (cUuid) nonApprovedOrderUuids.add(cUuid);
    }
  });

  const configs: any[] = [];

  // 1. Query vpn_accounts table using authenticated UID first
  try {
    let vpnAccs: any[] = [];
    if (userUid) {
      const { data: byUid } = await db.from('vpn_accounts').select('*').eq('user_id', userUid).order('created_at', { ascending: false });
      if (Array.isArray(byUid)) vpnAccs = byUid;
    }
    if (vpnAccs.length === 0 && userEmail) {
      const { data: byEmail } = await db.from('vpn_accounts').select('*').eq('email', userEmail).order('created_at', { ascending: false });
      if (Array.isArray(byEmail)) {
        // Only accept records that either match userUid or have no conflicting user_id
        vpnAccs = byEmail.filter(acc => {
          const docUserId = String(acc.user_id || '').trim();
          return !userUid || !docUserId || docUserId === userUid;
        });
      }
    }

    if (vpnAccs && Array.isArray(vpnAccs)) {
      vpnAccs.forEach(acc => {
        const docUserId = String(acc.user_id || '').trim();
        const docEmail = String(acc.email || '').toLowerCase().trim();
        const matchesUser = userUid
          ? (docUserId === userUid || (!docUserId && userEmail && docEmail === userEmail))
          : (userEmail && docEmail === userEmail);

        const accStatus = String(acc.status || 'active').toLowerCase().trim();
        const isApprovedStatus = accStatus === 'active' || accStatus === 'enabled' || accStatus === 'approved';
        const configUuid = String(acc.uuid || '').trim();
        const normUuid = configUuid.toLowerCase();
        const orderId = String(acc.order_id || acc.id || '').trim();

        const isBlockedByOrder =
          (orderId && nonApprovedOrderIds.has(orderId)) ||
          (normUuid && nonApprovedOrderUuids.has(normUuid)) ||
          (normUuid && deletedOrInactiveUuids.has(normUuid));

        if (matchesUser && isApprovedStatus && !isBlockedByOrder && configUuid && acc.vless_url) {
          const isTrialAcc = !!(acc.is_trial || orderId.startsWith('TRIAL-'));
          const inboundId = inboundMap.get(orderId) || inboundMap.get(normUuid) || null;

          configs.push({
            orderId: acc.order_id || acc.id,
            packageName: acc.remark || 'FIREVPN Package',
            configUrl: acc.vless_url,
            uuid: configUuid,
            expiryDate: acc.expiry_date || (acc.expiry_time ? new Date(acc.expiry_time).toISOString() : ''),
            inboundId,
            trafficLimit: isTrialAcc ? '1GB' : (acc.total_bytes > 0 ? `${acc.total_bytes / (1024 * 1024 * 1024)}GB` : 'Unlimited'),
            serverNode: acc.server_name || 'Singapore',
            _rawLimit: isTrialAcc ? 1 * 1024 * 1024 * 1024 : (acc.total_bytes || 0),
            isTrial: isTrialAcc,
            templateId: acc.template_id || null,
          });
        }
      });
    }
  } catch (err) {
  }

  // 2. Match approved or provisionally active orders for this authenticated user
  const matchedDocs = allOrders.filter(doc => {
    const data = doc;
    const docUid = String(data.customer_id || data.customerUid || data.customerId || data.uid || data.userId || '').trim();
    const docEmail = String(data.email || data.customerEmail || data.userEmail || '').toLowerCase().trim();
    const orderStatus = String(data.status || '').toLowerCase().trim();

    const matchesUser = userUid
      ? (docUid === userUid || (!docUid && userEmail && docEmail === userEmail))
      : (userEmail && docEmail === userEmail);

    const isApproved =
      orderStatus === 'approved' ||
      orderStatus === 'completed' ||
      orderStatus === 'active' ||
      isOrderProvisionallyActive(data);

    return matchesUser && isApproved;
  });

  matchedDocs.forEach(data => {
    const vlessUrl = String(data.vless_url || data.vpn_credentials?.configLink || data.vpn_credentials?.qrcodeData || data.configUrl || '').trim();
    const clientUuid = String(data.client_uuid || data.vpn_credentials?.password || data.uuid || '').trim();
    const normUuid = clientUuid.toLowerCase();

    if (vlessUrl && clientUuid && !deletedOrInactiveUuids.has(normUuid)) {
      let pmJson: any = {};
      try {
        pmJson = typeof data.payment_method === 'string' ? JSON.parse(data.payment_method) : (data.payment_method || {});
      } catch(e) {}

      const isProvisionalOrd = isOrderProvisionallyActive(data);
      const existingIdx = configs.findIndex(c => c.uuid && c.uuid.toLowerCase() === normUuid);
      if (existingIdx >= 0) {
        if ((!configs[existingIdx].serverNode || configs[existingIdx].serverNode === 'Singapore') && (data.server || pmJson.server)) {
          configs[existingIdx].serverNode = data.server || pmJson.server;
        }
        configs[existingIdx].paymentStatus = data.payment_status || (isProvisionalOrd ? 'Pending Verification' : 'Paid');
        configs[existingIdx].provisioningStatus = data.provisioning_status || pmJson.provisioning_status || (isProvisionalOrd ? 'provisional' : 'completed');
      } else {
        const isTrialOrd = !!(pmJson.is_trial || pmJson.isTrial || pmJson.paymentMethod === 'Free Trial' || String(data.order_id || data.id || '').startsWith('TRIAL-'));
        const tplId = data.template_id || pmJson.template_id || pmJson.templateId || null;
        const orderId = data.id || data.order_id;
        const inboundId = inboundMap.get(String(orderId)) || inboundMap.get(normUuid) || data.inbound_id || null;

        configs.push({
          orderId,
          packageName: data.package_name || data.plan || 'FIREVPN Package',
          configUrl: vlessUrl,
          uuid: clientUuid,
          expiryDate: data.expiry_date || data.expiryDate || '',
          inboundId,
          trafficLimit: isTrialOrd ? '1GB' : (data.traffic_limit || 'Unlimited'),
          serverNode: data.server || pmJson.server || 'Singapore',
          _rawLimit: isTrialOrd ? 1 * 1024 * 1024 * 1024 : (data.traffic_limit && String(data.traffic_limit).toLowerCase() !== 'unlimited' ? ((parseFloat(String(data.traffic_limit)) || 0) * 1024 * 1024 * 1024) : 0),
          isTrial: isTrialOrd,
          templateId: tplId,
          paymentStatus: data.payment_status || (isProvisionalOrd ? 'Pending Verification' : 'Paid'),
          provisioningStatus: data.provisioning_status || pmJson.provisioning_status || (isProvisionalOrd ? 'provisional' : 'completed'),
        });
      }
    }
  });

  // Use cached inbounds metadata ONLY to resolve missing inboundIds (never to claim Active status when 3X-UI is unreachable).
  const cached = await getCachedInbounds();
  const resolveMissingInboundIds = (inboundList: any[]) => {
    if (!Array.isArray(inboundList) || inboundList.length === 0) return;
    configs.forEach(config => {
      if (config.uuid && (config.inboundId === null || config.inboundId === undefined || Number(config.inboundId) <= 0)) {
        for (const ib of inboundList) {
          let settingsObj: any = {};
          try {
            if (ib.settings) {
              settingsObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings;
            }
          } catch (e) {}
          const clients = settingsObj.clients || [];
          const found = clients.some((c: any) => String(c.id || '').toLowerCase() === String(config.uuid).toLowerCase());
          if (found) {
            config.inboundId = Number(ib.id);
            console.log(`[Live Traffic Engine] Found missing inboundId ${ib.id} for UUID ${config.uuid} from inbound list.`);
            break;
          }
        }
      }
    });
  };
  resolveMissingInboundIds(cached);

  // Track ONLY live-verified inbounds fetched from 3X-UI (with short-TTL deduplicated cache in xuiService)
  const liveInboundsMap = new Map<number, any>();
  let liveFullListFetched = false;

  const hasMissingInboundId = configs.some(
    c => c.uuid && (c.inboundId === null || c.inboundId === undefined || Number(c.inboundId) <= 0)
  );

  // Cold-start recovery: if any config has no inboundId yet, fetch fresh inbounds once with timeout
  if (hasMissingInboundId && configs.length > 0) {
    try {
      const freshList = await Promise.race([
        getInbounds(true),
        new Promise<null>((resolve) =>
          setTimeout(() => {
            console.warn('[Live Traffic Engine] Fresh full inbound list fetch timed out after 5s.');
            resolve(null);
          }, 5000)
        )
      ]);
      if (Array.isArray(freshList) && freshList.length > 0) {
        liveFullListFetched = true;
        freshList.forEach(ib => {
          if (ib && ib.id) liveInboundsMap.set(Number(ib.id), ib);
        });
        resolveMissingInboundIds(freshList);
      }
    } catch (err: any) {
      console.warn('[Live Traffic Engine] Cold-start inbound lookup failed:', err?.message || err);
    }
  }

  const userInboundIds = Array.from(new Set(
    configs
      .map(c => c.inboundId)
      .filter(id => id !== null && id !== undefined && Number(id) > 0)
      .map(id => Number(id))
  )).filter(id => !liveInboundsMap.has(id));

  if (userInboundIds.length > 0) {
    try {
      console.log(`[Live Traffic Engine] Fetching ${userInboundIds.length} customer inbounds from 3X-UI...`);
      const liveResults = await Promise.race([
        Promise.all(userInboundIds.map(id => getLiveInbound(id))),
        new Promise<null[]>((resolve) =>
          setTimeout(() => {
            console.warn('[Live Traffic Engine] Live inbound fetch timed out after 5s; panel status unverified.');
            resolve([]);
          }, 5000)
        )
      ]);
      liveResults.forEach(ib => {
        if (ib && ib.id) {
          liveInboundsMap.set(Number(ib.id), ib);
        }
      });
    } catch (err: any) {
      console.warn(`[Live Traffic Engine] Error fetching live customer inbounds:`, err.message || err);
    }
  }

  const liveInbounds = Array.from(liveInboundsMap.values());

  const resultConfigs = configs.map(config => {
    let up = 0;
    let down = 0;
    let total = config._rawLimit || 0;
    let expiryTime = 0;
    let lastOnline = 0;
    let inboundId = config.inboundId ? Number(config.inboundId) : null;
    console.log(`[Provisioning Audit] Database inbound_id after reload: ${config.inboundId}`);
    console.log(`[Provisioning Audit] UUID to match: ${config.uuid}`);
    let clientEmail = userEmail;
    let matchedInbound: any = null;
    let stat: any = null;
    let foundClient: any = null;

    const checkedUuids: string[] = [];

    if (liveInbounds.length > 0 && config.uuid) {
      for (const ib of liveInbounds) {
        let settingsObj: any = {};
        try {
          if (ib.settings) {
            settingsObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings;
          }
        } catch (e) {}
        const clients = settingsObj.clients || [];
        for (const c of clients) {
          if (c.id) checkedUuids.push(c.id);
          if (String(c.id || '').toLowerCase() === String(config.uuid).toLowerCase()) {
            matchedInbound = ib;
            foundClient = c;
            break;
          }
        }
        if (matchedInbound) break;
      }
    }

    if (matchedInbound && foundClient) {
      if (!inboundId) {
        inboundId = Number(matchedInbound.id);
      }
      clientEmail = foundClient.email || userEmail;
      expiryTime = foundClient.expiryTime || 0;

      if (foundClient.totalGB !== undefined && Number(foundClient.totalGB) >= 0) {
        total = Number(foundClient.totalGB) || 0;
      } else if (foundClient.totalBytes !== undefined) {
        total = Number(foundClient.totalBytes) || 0;
      } else if (foundClient.total !== undefined) {
        total = Number(foundClient.total) || 0;
      }

      const clientStats = matchedInbound.clientStats || [];
      if (config.uuid) {
        stat = clientStats.find((s: any) => String(s.id || '').toLowerCase() === String(config.uuid).toLowerCase()) ||
               clientStats.find((s: any) => String(s.email || '').toLowerCase() === String(clientEmail).toLowerCase());
      }

      const extractTraffic = (obj: any, type: 'up' | 'down') => {
        if (!obj) return 0;
        const val = obj[type] || obj[`${type}load`] || 0;
        return typeof val === 'number' ? val : (parseFloat(val) || 0);
      };

      const clientUp = extractTraffic(foundClient, 'up');
      const clientDown = extractTraffic(foundClient, 'down');

      if (stat) {
        const statUp = extractTraffic(stat, 'up');
        const statDown = extractTraffic(stat, 'down');

        up = Math.max(statUp, clientUp, up);
        down = Math.max(statDown, clientDown, down);

        if (stat.total !== undefined && Number(stat.total) > 0) {
          total = Number(stat.total);
        }
        if (stat.expiryTime !== undefined && Number(stat.expiryTime) > 0) {
          expiryTime = Number(stat.expiryTime);
        }
        lastOnline = stat.lastOnline || stat.online || stat.time || 0;
      } else {
        up = Math.max(clientUp, up);
        down = Math.max(clientDown, down);
        lastOnline = foundClient.lastOnline || foundClient.online || foundClient.time || 0;
      }
    } else {
      console.log(`[Provisioning Audit] No live 3X-UI state verified for UUID: ${config.uuid}. Marking status unverified.`);
    }

    let lastOnlineMs = lastOnline;
    if (lastOnlineMs > 0 && lastOnlineMs < 10000000000) {
      lastOnlineMs = lastOnlineMs * 1000;
    }

    const totalUsed = up + down;
    const remainingTraffic = total > 0 ? Math.max(total - totalUsed, 0) : 0;

    const usedGB = parseFloat((totalUsed / (1024 * 1024 * 1024)).toFixed(2));
    const remainingGB = total > 0 ? parseFloat((remainingTraffic / (1024 * 1024 * 1024)).toFixed(2)) : 'Unlimited';

    const now = Date.now();
    let expTimeMs = expiryTime;
    if (expTimeMs > 0 && expTimeMs < 10000000000) {
      expTimeMs = expTimeMs * 1000;
    }
    if ((!expTimeMs || expTimeMs <= 0) && config.expiryDate) {
      const parsed = new Date(config.expiryDate).getTime();
      if (!isNaN(parsed)) expTimeMs = parsed;
    }

    const expectedInboundWasLive = Boolean(
      (inboundId && liveInboundsMap.has(Number(inboundId))) || liveFullListFetched
    );
    const evaluated = evaluateVpnClientStatus({
      panelReachable: expectedInboundWasLive || Boolean(matchedInbound),
      inboundFound: Boolean(matchedInbound),
      inboundEnable: matchedInbound ? matchedInbound.enable : null,
      clientFound: Boolean(foundClient),
      clientEnable: foundClient ? foundClient.enable : null,
      statEnable: stat ? stat.enable : undefined,
      upBytes: up,
      downBytes: down,
      totalLimitBytes: total,
      expiryTimeMs: expTimeMs,
      nowMs: now,
    });

    let currentExpiryDate = config.expiryDate;
    if (expTimeMs > 0) {
      currentExpiryDate = new Date(expTimeMs).toISOString();
    }

    let port = 443;
    let protocol = 'vless';
    let network = 'tcp';
    let security = 'none';
    let serverAddress = 'singapore.firevpn.com';

    if (config.configUrl) {
      try {
        const urlStr = config.configUrl.startsWith('vless://') ? config.configUrl.replace('vless://', 'http://') : config.configUrl;
        const urlObj = new URL(urlStr);
        if (urlObj.port) port = Number(urlObj.port);
        if (urlObj.hostname) serverAddress = urlObj.hostname;
        const typeParam = urlObj.searchParams.get('type');
        if (typeParam) network = typeParam;
        const secParam = urlObj.searchParams.get('security');
        if (secParam) security = secParam;
      } catch(e) {}
    }

    console.log(`[Provisioning Audit] API response inboundId: ${inboundId} | observedStatus: ${evaluated.status} (${evaluated.statusReason})`);
    return {
      orderId: config.orderId,
      packageName: config.packageName,
      uuid: config.uuid,
      configUrl: config.configUrl,
      inboundId,
      trafficLimit: total > 0 ? `${total / (1024 * 1024 * 1024)}GB` : 'Unlimited',
      usedGB,
      remainingGB,
      upBytes: up,
      downBytes: down,
      upload: up,
      download: down,
      liveUsageFound: !!matchedInbound && !!foundClient,
      panelStatusVerified: evaluated.panelStatusVerified,
      statusReason: evaluated.statusReason,
      totalTrafficBytes: total,
      remainingTrafficBytes: remainingTraffic,
      expiryDate: currentExpiryDate,
      expiryTime: currentExpiryDate,
      status: evaluated.status,
      enable: evaluated.effectiveEnable,
      enableStatus: evaluated.enableStatus,
      onlineStatus: evaluated.status === 'Active' && (lastOnline > 0 || up > 0 || down > 0),
      lastOnline: lastOnlineMs,
      serverNode: config.serverNode,
      port,
      protocol,
      network,
      security,
      serverAddress,
      subscriptionName: config.packageName,
      name: config.packageName,
      isTrial: !!config.isTrial,
      templateId: config.templateId || null,
      paymentStatus: config.paymentStatus || null,
      provisioningStatus: config.provisioningStatus || null,
      _expectedInboundWasLive: expectedInboundWasLive,
    };
  });

  const dbTime = Date.now() - dbStart;

  // Exclude clients confirmed deleted ONLY when their expected inbound (or full inbound list) was fetched live.
  // When 3X-UI is unreachable, never hide or delete customer configs — preserve them as Status Unavailable.
  const liveUuids = new Set<string>();
  for (const ib of liveInbounds) {
    let settingsObj: any = {};
    try {
      if (ib.settings) {
        settingsObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings;
      }
    } catch (e) {}
    const clients = settingsObj.clients || [];
    for (const c of clients) {
      if (c.id) liveUuids.add(String(c.id).trim().toLowerCase());
    }
    const clientStats = ib.clientStats || [];
    for (const s of clientStats) {
      if (s.id) liveUuids.add(String(s.id).trim().toLowerCase());
    }
  }

  const finalConfigs = resultConfigs
    .filter(cfg => {
      if (!cfg.uuid) return false;
      const normUuid = String(cfg.uuid).trim().toLowerCase();
      if (cfg._expectedInboundWasLive && liveInbounds.length > 0 && !liveUuids.has(normUuid)) {
        console.log(`[3X-UI Sync] Excluding deleted configuration (UUID: ${cfg.uuid}) confirmed absent from live 3X-UI inbound.`);
        return false;
      }
      return true;
    })
    .map(({ _expectedInboundWasLive, ...publicCfg }) => publicCfg);

  return { configs: finalConfigs, dbTime };
};

export interface TrafficResetPolicy {
  enabled: boolean;
  cooldownHours: number;
  maxResetsPerBillingPeriod: number;
  allowTrialReset: boolean;
}

export const DEFAULT_RESET_POLICY: TrafficResetPolicy = {
  enabled: true,
  cooldownHours: 24,
  maxResetsPerBillingPeriod: 1,
  allowTrialReset: false
};

export interface TrafficResetLog {
  id: string;
  userId: string;
  userEmail: string;
  configUuid: string;
  orderId?: string;
  inboundId?: number;
  clientEmail?: string;
  resetTimestamp: string;
  resetTimestampMs: number;
  upBytesBefore: number;
  downBytesBefore: number;
  totalBytesBefore: number;
  status: 'success' | 'failed';
}

export interface ResetTrafficStatus {
  canReset: boolean;
  reason?: string;
  cooldownHours: number;
  cooldownRemainingHours: number;
  resetsUsedInPeriod: number;
  maxResetsPerPeriod: number;
  lastResetTimestamp: string | null;
  nextAvailableReset: string | null;
}

let inMemoryTrafficResetPolicy: TrafficResetPolicy = { ...DEFAULT_RESET_POLICY };
let inMemoryTrafficResetLogs: TrafficResetLog[] = [];

export const getTrafficResetPolicy = async (): Promise<TrafficResetPolicy> => {
  try {
    const { data: doc } = await supabase.from('settings').select('*').eq('id', 'traffic_reset_policy').maybeSingle();
    if (doc && doc.data) {
      inMemoryTrafficResetPolicy = {
        enabled: doc.data.enabled !== false,
        cooldownHours: Number(doc.data.cooldownHours) || DEFAULT_RESET_POLICY.cooldownHours,
        maxResetsPerBillingPeriod: Number(doc.data.maxResetsPerBillingPeriod) || DEFAULT_RESET_POLICY.maxResetsPerBillingPeriod,
        allowTrialReset: Boolean(doc.data.allowTrialReset)
      };
      return inMemoryTrafficResetPolicy;
    }
  } catch (err) {
    console.warn('[vpnService] Error reading traffic_reset_policy:', err);
  }
  return inMemoryTrafficResetPolicy;
};

export const saveTrafficResetPolicy = async (policy: Partial<TrafficResetPolicy>): Promise<TrafficResetPolicy> => {
  const current = await getTrafficResetPolicy();
  const updated: TrafficResetPolicy = {
    enabled: policy.enabled !== undefined ? Boolean(policy.enabled) : current.enabled,
    cooldownHours: policy.cooldownHours !== undefined ? Math.max(1, Number(policy.cooldownHours)) : current.cooldownHours,
    maxResetsPerBillingPeriod: policy.maxResetsPerBillingPeriod !== undefined ? Math.max(1, Number(policy.maxResetsPerBillingPeriod)) : current.maxResetsPerBillingPeriod,
    allowTrialReset: policy.allowTrialReset !== undefined ? Boolean(policy.allowTrialReset) : current.allowTrialReset
  };
  inMemoryTrafficResetPolicy = updated;

  try {
    await supabase.from('settings').upsert({
      id: 'traffic_reset_policy',
      data: updated,
      updated_at: new Date().toISOString()
    });
  } catch (e) {
    console.warn('[vpnService] Note: Settings table upsert blocked or restricted by RLS; in-memory policy updated.');
  }

  return updated;
};

export const getTrafficResetLogs = async (): Promise<TrafficResetLog[]> => {
  try {
    const { data: doc } = await supabase.from('settings').select('*').eq('id', 'traffic_reset_logs').maybeSingle();
    if (doc && doc.data) {
      const dbLogs: TrafficResetLog[] = Array.isArray(doc.data) ? doc.data : (Array.isArray(doc.data.logs) ? doc.data.logs : []);
      const combined = [...inMemoryTrafficResetLogs];
      for (const d of dbLogs) {
        if (!combined.some(l => l.id === d.id)) {
          combined.push(d);
        }
      }
      combined.sort((a, b) => b.resetTimestampMs - a.resetTimestampMs);
      return combined;
    }
  } catch (err) {
    console.warn('[vpnService] Error reading traffic_reset_logs from Supabase:', err);
  }
  return [...inMemoryTrafficResetLogs].sort((a, b) => b.resetTimestampMs - a.resetTimestampMs);
};

export const clearTrafficResetLogsForTest = (userId?: string) => {
  if (userId) {
    inMemoryTrafficResetLogs = inMemoryTrafficResetLogs.filter(l => l.userId !== userId);
  } else {
    inMemoryTrafficResetLogs = [];
  }
};

export const recordTrafficResetLog = async (log: TrafficResetLog): Promise<void> => {
  // Always update in-memory cache immediately
  inMemoryTrafficResetLogs = [log, ...inMemoryTrafficResetLogs.filter(l => l.id !== log.id).slice(0, 499)];

  try {
    const existingLogs = await getTrafficResetLogs();
    const updatedLogs = [log, ...existingLogs.filter(l => l.id !== log.id).slice(0, 499)];
    await supabase.from('settings').upsert({
      id: 'traffic_reset_logs',
      data: { logs: updatedLogs },
      updated_at: new Date().toISOString()
    });
  } catch (err) {
    console.warn('[vpnService] Error saving traffic_reset_logs to settings:', err);
  }

  // Also attempt insert into traffic_resets table if it exists
  try {
    await supabase.from('traffic_resets').insert({
      user_id: log.userId,
      config_uuid: log.configUuid,
      order_id: log.orderId || null,
      inbound_id: log.inboundId || null,
      client_email: log.clientEmail || null,
      up_bytes_before: log.upBytesBefore,
      down_bytes_before: log.downBytesBefore,
      total_bytes_before: log.totalBytesBefore,
      status: log.status,
      created_at: log.resetTimestamp
    });
  } catch (e) {
    // Non-fatal if table not created
  }
};

/**
 * Verify VPN configuration ownership strictly using Supabase
 */
export const verifyVpnOwnership = async (
  userId: string,
  userEmail: string,
  configUuid: string
): Promise<{
  owned: boolean;
  source: 'vpn_accounts' | 'orders' | 'vpn_configs' | null;
  record: any;
}> => {
  const normUuid = (configUuid || '').trim().toLowerCase();
  const normUid = (userId || '').trim();
  const normEmail = (userEmail || '').trim().toLowerCase();

  if (!normUuid) return { owned: false, source: null, record: null };

  const matchesOwner = (recUid: string, recEmail: string): boolean => {
    const cleanUid = (recUid || '').trim();
    const cleanEmail = (recEmail || '').trim().toLowerCase();
    if (normUid) {
      if (cleanUid) return cleanUid === normUid;
      return Boolean(normEmail && cleanEmail && cleanEmail === normEmail);
    }
    return Boolean(normEmail && cleanEmail && cleanEmail === normEmail);
  };

  // 1. Check vpn_accounts table filtered directly by UUID
  try {
    const { data: vpnAccs } = await supabase
      .from('vpn_accounts')
      .select('*')
      .ilike('uuid', normUuid);
    if (vpnAccs && Array.isArray(vpnAccs) && vpnAccs.length > 0) {
      for (const acc of vpnAccs) {
        const accUuid = String(acc.uuid || '').trim().toLowerCase();
        if (accUuid === normUuid) {
          if (matchesOwner(String(acc.user_id || ''), String(acc.email || ''))) {
            return { owned: true, source: 'vpn_accounts', record: acc };
          }
          // UUID exists in vpn_accounts but belongs to another user
          return { owned: false, source: 'vpn_accounts', record: null };
        }
      }
    }
  } catch (_e) {}

  // 2. Check orders table filtered directly by client_uuid
  try {
    const { data: orders } = await supabase
      .from('orders')
      .select('*')
      .ilike('client_uuid', normUuid);
    if (orders && Array.isArray(orders) && orders.length > 0) {
      for (const ord of orders) {
        const clientUuid = String(ord.client_uuid || ord.uuid || ord.vpn_credentials?.password || '').trim().toLowerCase();
        if (clientUuid === normUuid) {
          const ordUid = String(ord.customer_id || ord.customerUid || ord.customerId || '').trim();
          const ordEmail = String(ord.email || ord.customerEmail || '').trim().toLowerCase();
          if (matchesOwner(ordUid, ordEmail)) {
            return { owned: true, source: 'orders', record: ord };
          }
          // UUID exists in orders but belongs to another user
          return { owned: false, source: 'orders', record: null };
        }
      }
    }
  } catch (_e) {}

  // 3. Check vpn_configs table filtered directly by UUID
  try {
    const { data: vpnCfgs } = await supabase
      .from('vpn_configs')
      .select('*')
      .ilike('uuid', normUuid);
    if (vpnCfgs && Array.isArray(vpnCfgs) && vpnCfgs.length > 0) {
      for (const cfg of vpnCfgs) {
        const cfgUuid = String(cfg.uuid || '').trim().toLowerCase();
        if (cfgUuid === normUuid) {
          const cfgUid = String(cfg.customer_uid || cfg.user_id || cfg.userId || '').trim();
          const cfgEmail = String(cfg.customer_email || cfg.user_email || cfg.email || '').trim().toLowerCase();
          if (matchesOwner(cfgUid, cfgEmail)) {
            return { owned: true, source: 'vpn_configs', record: cfg };
          }
          return { owned: false, source: 'vpn_configs', record: null };
        }
      }
    }
  } catch (_e) {}

  // 4. Check 3X-UI panel clients directly as fallback (strict exact email match only; never substring)
  try {
    const cached = await getCachedInbounds();
    if (Array.isArray(cached)) {
      for (const ib of cached) {
        let settingsObj: any = {};
        try {
          if (ib.settings) settingsObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings;
        } catch (_e) {}
        const clients = settingsObj.clients || [];
        for (const c of clients) {
          const cUuid = String(c.id || '').trim().toLowerCase();
          const cEmail = String(c.email || '').trim().toLowerCase();
          if (cUuid === normUuid) {
            if (normEmail && cEmail === normEmail) {
              return {
                owned: true,
                source: '3xui' as any,
                record: {
                  uuid: c.id,
                  email: c.email,
                  inbound_id: ib.id,
                  status: c.enable ? 'active' : 'disabled',
                  expiry_date: c.expiryTime && c.expiryTime > 0 ? new Date(c.expiryTime).toISOString() : null,
                  package_name: ib.remark || 'FIREVPN Package'
                }
              };
            }
            // UUID exists in 3X-UI but does not belong to this user
            return { owned: false, source: '3xui' as any, record: null };
          }
        }
      }
    }
  } catch (_e) {}

  return { owned: false, source: null, record: null };
};

/**
 * Check whether a customer can reset traffic right now, including cooldown and limit status
 */
export const getResetTrafficStatus = async (
  userId: string,
  userEmail: string,
  configUuid: string
): Promise<ResetTrafficStatus> => {
  const policy = await getTrafficResetPolicy();

  if (!policy.enabled) {
    return {
      canReset: false,
      reason: 'Traffic reset feature is currently disabled by administrator',
      cooldownHours: policy.cooldownHours,
      cooldownRemainingHours: 0,
      resetsUsedInPeriod: 0,
      maxResetsPerPeriod: policy.maxResetsPerBillingPeriod,
      lastResetTimestamp: null,
      nextAvailableReset: null
    };
  }

  // 1. Verify ownership
  const ownership = await verifyVpnOwnership(userId, userEmail, configUuid);
  if (!ownership.owned) {
    return {
      canReset: false,
      reason: 'Forbidden: You do not have ownership of this VPN configuration',
      cooldownHours: policy.cooldownHours,
      cooldownRemainingHours: 0,
      resetsUsedInPeriod: 0,
      maxResetsPerPeriod: policy.maxResetsPerBillingPeriod,
      lastResetTimestamp: null,
      nextAvailableReset: null
    };
  }

  const rec = ownership.record;
  const isTrial = !!(rec.is_trial || String(rec.order_id || '').startsWith('TRIAL-'));
  if (isTrial && !policy.allowTrialReset) {
    return {
      canReset: false,
      reason: 'Traffic reset is not allowed for free trial configurations',
      cooldownHours: policy.cooldownHours,
      cooldownRemainingHours: 0,
      resetsUsedInPeriod: 0,
      maxResetsPerPeriod: policy.maxResetsPerBillingPeriod,
      lastResetTimestamp: null,
      nextAvailableReset: null
    };
  }

  const st = String(rec.status || '').toLowerCase();
  if (st === 'expired' || st === 'disabled' || rec.enable === false) {
    return {
      canReset: false,
      reason: 'Cannot reset traffic for an expired or disabled configuration. Please renew your plan.',
      cooldownHours: policy.cooldownHours,
      cooldownRemainingHours: 0,
      resetsUsedInPeriod: 0,
      maxResetsPerPeriod: policy.maxResetsPerBillingPeriod,
      lastResetTimestamp: null,
      nextAvailableReset: null
    };
  }

  const expDate = rec.expiry_date || rec.expires_at || rec.expiryDate;
  if (expDate && new Date(expDate).getTime() <= Date.now()) {
    return {
      canReset: false,
      reason: 'Cannot reset traffic for an expired configuration',
      cooldownHours: policy.cooldownHours,
      cooldownRemainingHours: 0,
      resetsUsedInPeriod: 0,
      maxResetsPerPeriod: policy.maxResetsPerBillingPeriod,
      lastResetTimestamp: null,
      nextAvailableReset: null
    };
  }

  // Check cooldown and frequency
  const allLogs = await getTrafficResetLogs();
  const normUuid = configUuid.trim().toLowerCase();
  const userLogs = allLogs.filter(
    l => (l.userId === userId || (userEmail && l.userEmail && l.userEmail.toLowerCase() === userEmail.toLowerCase())) &&
         l.configUuid.toLowerCase() === normUuid &&
         l.status === 'success'
  );

  const lastLog = userLogs[0];
  const now = Date.now();
  const cooldownMs = policy.cooldownHours * 60 * 60 * 1000;

  let cooldownRemainingHours = 0;
  let nextAvailableReset: string | null = null;

  if (lastLog) {
    const elapsedMs = now - lastLog.resetTimestampMs;
    if (elapsedMs < cooldownMs) {
      cooldownRemainingHours = Math.ceil((cooldownMs - elapsedMs) / (1000 * 60 * 60));
      nextAvailableReset = new Date(lastLog.resetTimestampMs + cooldownMs).toISOString();
      return {
        canReset: false,
        reason: `Cooldown active. Please wait ${cooldownRemainingHours} hour(s) before resetting again.`,
        cooldownHours: policy.cooldownHours,
        cooldownRemainingHours,
        resetsUsedInPeriod: userLogs.length,
        maxResetsPerPeriod: policy.maxResetsPerBillingPeriod,
        lastResetTimestamp: lastLog.resetTimestamp,
        nextAvailableReset
      };
    }
  }

  // Check billing period resets (default 30-day window)
  const periodWindowMs = 30 * 24 * 60 * 60 * 1000;
  const resetsInPeriod = userLogs.filter(l => (now - l.resetTimestampMs) < periodWindowMs).length;

  if (resetsInPeriod >= policy.maxResetsPerBillingPeriod) {
    const oldestInPeriod = userLogs[resetsInPeriod - 1];
    nextAvailableReset = oldestInPeriod ? new Date(oldestInPeriod.resetTimestampMs + periodWindowMs).toISOString() : null;
    return {
      canReset: false,
      reason: `Maximum resets reached (${policy.maxResetsPerBillingPeriod}) for this billing period.`,
      cooldownHours: policy.cooldownHours,
      cooldownRemainingHours: 0,
      resetsUsedInPeriod: resetsInPeriod,
      maxResetsPerPeriod: policy.maxResetsPerBillingPeriod,
      lastResetTimestamp: lastLog ? lastLog.resetTimestamp : null,
      nextAvailableReset
    };
  }

  return {
    canReset: true,
    cooldownHours: policy.cooldownHours,
    cooldownRemainingHours: 0,
    resetsUsedInPeriod: resetsInPeriod,
    maxResetsPerPeriod: policy.maxResetsPerBillingPeriod,
    lastResetTimestamp: lastLog ? lastLog.resetTimestamp : null,
    nextAvailableReset: null
  };
};

/**
 * Execute real customer self-service traffic reset in 3X-UI
 */
export const resetVpnTraffic = async (
  userId: string,
  userEmail: string,
  configUuid: string
): Promise<{
  success: boolean;
  message: string;
  data: {
    configUuid: string;
    clientEmail: string;
    inboundId: number;
    previousUsedBytes: number;
    currentUsedGB: number;
    resetTimestamp: string;
    cooldownHours: number;
    nextAvailableReset: string;
  };
}> => {
  const normUuid = (configUuid || '').trim().toLowerCase();
  console.log(`[vpnService] Processing customer traffic reset request - User UID: '${userId}', Email: '${userEmail}', Config UUID: '${normUuid}'`);

  if (!userId) {
    const err: any = new Error('Unauthorized: Authentication required');
    err.status = 401;
    throw err;
  }

  if (!normUuid) {
    const err: any = new Error('Invalid request: VPN configuration UUID is required');
    err.status = 400;
    throw err;
  }

  // 1. Check reset policy
  const policy = await getTrafficResetPolicy();
  if (!policy.enabled) {
    const err: any = new Error('Traffic reset feature is currently disabled by administrator');
    err.status = 403;
    throw err;
  }

  // 2. Strict ownership verification against Supabase
  const ownership = await verifyVpnOwnership(userId, userEmail, normUuid);
  if (!ownership.owned) {
    console.warn(`[Security Alert] User '${userId}' attempted to reset configuration '${normUuid}' which they do not own!`);
    const err: any = new Error('Forbidden: You do not own this VPN configuration');
    err.status = 403;
    throw err;
  }

  const rec = ownership.record;
  const isTrial = !!(rec.is_trial || String(rec.order_id || '').startsWith('TRIAL-'));
  if (isTrial && !policy.allowTrialReset) {
    const err: any = new Error('Traffic reset is not allowed for free trial configurations');
    err.status = 400;
    throw err;
  }

  // 3. Verify status: Must NOT be expired or disabled
  const st = String(rec.status || '').toLowerCase();
  if (st === 'expired' || st === 'disabled' || rec.enable === false) {
    const err: any = new Error('Cannot reset traffic for an expired or disabled configuration. Please renew your plan.');
    err.status = 400;
    throw err;
  }

  const expDate = rec.expiry_date || rec.expires_at || rec.expiryDate;
  if (expDate && new Date(expDate).getTime() <= Date.now()) {
    const err: any = new Error('Cannot reset traffic for an expired configuration');
    err.status = 400;
    throw err;
  }

  // 4. Check cooldown & frequency rate limits
  const allLogs = await getTrafficResetLogs();
  const userLogs = allLogs.filter(
    l => (l.userId === userId || (userEmail && l.userEmail && l.userEmail.toLowerCase() === userEmail.toLowerCase())) &&
         l.configUuid.toLowerCase() === normUuid &&
         l.status === 'success'
  );

  const lastLog = userLogs[0];
  const now = Date.now();
  const cooldownMs = policy.cooldownHours * 60 * 60 * 1000;

  if (lastLog) {
    const elapsedMs = now - lastLog.resetTimestampMs;
    if (elapsedMs < cooldownMs) {
      const hoursLeft = Math.ceil((cooldownMs - elapsedMs) / (1000 * 60 * 60));
      const err: any = new Error(`Reset cooldown active. Please wait ${hoursLeft} hour(s) before resetting again.`);
      err.status = 429;
      throw err;
    }
  }

  const periodWindowMs = 30 * 24 * 60 * 60 * 1000;
  const resetsInPeriod = userLogs.filter(l => (now - l.resetTimestampMs) < periodWindowMs).length;
  if (resetsInPeriod >= policy.maxResetsPerBillingPeriod) {
    const err: any = new Error(`Maximum traffic resets (${policy.maxResetsPerBillingPeriod}) reached for this billing period.`);
    err.status = 429;
    throw err;
  }

  // 5. Look up live client & inbound on 3X-UI server
  const inbounds = await getInbounds(false);
  let matchedInbound: any = null;
  let matchedClient: any = null;
  let matchedStat: any = null;

  for (const ib of inbounds) {
    let settingsObj: any = {};
    try {
      if (ib.settings) {
        settingsObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings;
      }
    } catch (e) {}
    const clients = settingsObj.clients || [];
    for (const c of clients) {
      if (String(c.id || '').trim().toLowerCase() === normUuid) {
        matchedInbound = ib;
        matchedClient = c;
        break;
      }
    }
    if (matchedInbound) {
      const stats = ib.clientStats || [];
      matchedStat = stats.find((s: any) => 
        (s.id && String(s.id).toLowerCase() === normUuid) ||
        (s.email && matchedClient.email && String(s.email).toLowerCase() === String(matchedClient.email).toLowerCase())
      );
      break;
    }
  }

  if (!matchedInbound || !matchedClient) {
    const err: any = new Error('VPN configuration was not found on the active VPN server');
    err.status = 404;
    throw err;
  }

  if (matchedClient.enable === false) {
    const err: any = new Error('Cannot reset traffic: Configuration is disabled on the VPN server');
    err.status = 400;
    throw err;
  }

  let clientExpMs = matchedClient.expiryTime || 0;
  if (clientExpMs > 0 && clientExpMs < 10000000000) clientExpMs = clientExpMs * 1000;
  if (clientExpMs > 0 && clientExpMs <= Date.now()) {
    const err: any = new Error('Cannot reset traffic: Configuration has expired on the VPN server');
    err.status = 400;
    throw err;
  }

  const verifiedInboundId = Number(matchedInbound.id);
  const verifiedClientEmail = String(matchedClient.email || userEmail || '').trim();
  const upBytes = Number(matchedStat?.up || matchedClient.up || 0);
  const downBytes = Number(matchedStat?.down || matchedClient.down || 0);
  const totalBefore = upBytes + downBytes;

  console.log(`[vpnService] Executing 3X-UI traffic reset for client '${verifiedClientEmail}' in inbound ${verifiedInboundId}...`);

  // 6. Execute REAL reset in 3X-UI
  try {
    await resetClientTraffic(verifiedClientEmail, verifiedInboundId, normUuid);
  } catch (xuiErr: any) {
    console.error('[vpnService] 3X-UI reset failed:', xuiErr.message || xuiErr);
    // Record failed reset attempt
    await recordTrafficResetLog({
      id: crypto.randomUUID(),
      userId,
      userEmail,
      configUuid: normUuid,
      orderId: String(rec.order_id || rec.id || ''),
      inboundId: verifiedInboundId,
      clientEmail: verifiedClientEmail,
      resetTimestamp: new Date().toISOString(),
      resetTimestampMs: now,
      upBytesBefore: upBytes,
      downBytesBefore: downBytes,
      totalBytesBefore: totalBefore,
      status: 'failed'
    });
    const err: any = new Error(`Failed to reset traffic counter on 3X-UI server: ${xuiErr.message || 'Server error'}`);
    err.status = 502;
    throw err;
  }

  // 7. Record successful reset
  const resetTimestampStr = new Date().toISOString();
  await recordTrafficResetLog({
    id: crypto.randomUUID(),
    userId,
    userEmail,
    configUuid: normUuid,
    orderId: String(rec.order_id || rec.id || ''),
    inboundId: verifiedInboundId,
    clientEmail: verifiedClientEmail,
    resetTimestamp: resetTimestampStr,
    resetTimestampMs: now,
    upBytesBefore: upBytes,
    downBytesBefore: downBytes,
    totalBytesBefore: totalBefore,
    status: 'success'
  });

  // 8. Update vpn_accounts used_bytes to 0 without touching expiry, package limit, or price
  try {
    await supabase.from('vpn_accounts')
      .update({ used_bytes: 0, updated_at: resetTimestampStr })
      .eq('uuid', normUuid);
  } catch (dbErr) {
    console.warn('[vpnService] vpn_accounts used_bytes update warning:', dbErr);
  }

  // 9. Send in-app notification
  try {
    const configName = rec.remark || rec.package_name || 'FIREVPN Package';
    await createCustomerNotification({
      userId,
      userEmail: userEmail || rec.email || 'customer@firevpn.com',
      title: 'VPN Traffic Reset Successful',
      message: `Your VPN configuration "${configName}" traffic counter has been reset to 0 MB. Your full data allowance is restored.`,
      type: 'traffic_reset',
      vpnName: configName,
      vpnUuid: normUuid
    });
  } catch (notifErr) {
    console.warn('[vpnService] Customer notification warning:', notifErr);
  }

  const nextAvailableResetDate = new Date(now + cooldownMs).toISOString();

  return {
    success: true,
    message: 'Traffic counter successfully reset in 3X-UI. Your full package data allowance has been restored.',
    data: {
      configUuid: normUuid,
      clientEmail: verifiedClientEmail,
      inboundId: verifiedInboundId,
      previousUsedBytes: totalBefore,
      currentUsedGB: 0,
      resetTimestamp: resetTimestampStr,
      cooldownHours: policy.cooldownHours,
      nextAvailableReset: nextAvailableResetDate
    }
  };
};

