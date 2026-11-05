import { supabase } from '../../lib/supabase.js';
import { getCachedInbounds, getLiveInbound, getInbounds, resetClientTraffic } from './xuiService.js';
import { createCustomerNotification } from './notificationService.js';
import crypto from 'crypto';

export const getMyConfigs = async (uid: string, email?: string, _token?: string): Promise<{ configs: any[]; dbTime: number }> => {
  const dbStart = Date.now();
  const userEmail = email ? email.toLowerCase().trim() : '';
  const userUid = uid ? uid.trim() : '';

  // Query vpn_configs to obtain inbound_id correctly
  const { data: vpnConfigsData } = await supabase.from('vpn_configs').select('*');
  const inboundMap = new Map<string, number>();
  if (vpnConfigsData && Array.isArray(vpnConfigsData)) {
    vpnConfigsData.forEach(cfg => {
      const ibId = Number(cfg.inbound_id);
      if (!isNaN(ibId) && ibId > 0) {
        if (cfg.order_id) inboundMap.set(String(cfg.order_id), ibId);
        if (cfg.uuid) inboundMap.set(String(cfg.uuid).toLowerCase(), ibId);
      }
    });
  }

  const configs: any[] = [];

  // 1. Query vpn_accounts table
  try {
    let query = supabase.from('vpn_accounts').select('*');
    if (userEmail) {
      query = query.eq('email', userEmail);
    } else if (userUid) {
      query = query.eq('user_id', userUid);
    }
    
    const { data: vpnAccs } = await query.order('created_at', { ascending: false });

    if (vpnAccs && Array.isArray(vpnAccs)) {
      vpnAccs.forEach(acc => {
        const docUserId = String(acc.user_id || '').trim();
        const docEmail = String(acc.email || '').toLowerCase().trim();
        const matchesUser = (userUid && docUserId === userUid) || (userEmail && docEmail === userEmail);
        const isActive = !acc.status || acc.status === 'active' || acc.status === 'enabled';
        
        if (matchesUser && isActive && acc.vless_url) {
          const isTrialAcc = !!(acc.is_trial || String(acc.order_id || '').startsWith('TRIAL-'));
          const orderId = acc.order_id || acc.id;
          const configUuid = acc.uuid;
          const inboundId = inboundMap.get(String(orderId)) || (configUuid ? inboundMap.get(String(configUuid).toLowerCase()) : null) || null;

          configs.push({
            orderId,
            packageName: acc.remark || 'FIREVPN Package',
            configUrl: acc.vless_url,
            uuid: acc.uuid,
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

  // 2. Query orders table
  const { data: snapshot } = await supabase.from('orders').select('*');
  const allOrders: any[] = snapshot || [];

  const matchedDocs = allOrders.filter(doc => {
    const data = doc;
    const docUid = String(data.customer_id || data.customerUid || data.customerId || data.uid || data.userId || '').trim();
    const docEmail = String(data.email || data.customerEmail || data.userEmail || '').toLowerCase().trim();
    const statusVal = String(data.status || data.payment_status || '').toLowerCase();

    const matchesUser = (userUid && docUid === userUid) || (userEmail && docEmail === userEmail);
    const isApproved = statusVal === 'approved' || statusVal === 'completed' || statusVal === 'paid' || statusVal === 'active';

    return matchesUser && isApproved;
  });

  matchedDocs.forEach(data => {
    const vlessUrl = data.vless_url || data.vpn_credentials?.configLink || data.vpn_credentials?.qrcodeData || data.configUrl || '';
    const clientUuid = data.client_uuid || data.vpn_credentials?.password || data.uuid || '';

    if (vlessUrl) {
      const exists = configs.some(c => c.uuid && clientUuid && c.uuid.toLowerCase() === clientUuid.toLowerCase());
      if (!exists) {
        let pmJson: any = {};
        try {
          pmJson = typeof data.payment_method === 'string' ? JSON.parse(data.payment_method) : (data.payment_method || {});
        } catch(e) {}

        const isTrialOrd = !!(pmJson.is_trial || pmJson.isTrial || pmJson.paymentMethod === 'Free Trial' || String(data.order_id || data.id || '').startsWith('TRIAL-'));
        const tplId = data.template_id || pmJson.template_id || pmJson.templateId || null;
        const orderId = data.id || data.order_id;
        const inboundId = inboundMap.get(String(orderId)) || (clientUuid ? inboundMap.get(String(clientUuid).toLowerCase()) : null) || data.inbound_id || null;

        configs.push({
          orderId,
          packageName: data.package_name || data.plan || 'FIREVPN Package',
          configUrl: vlessUrl,
          uuid: clientUuid,
          expiryDate: data.expiry_date || data.expiryDate || '',
          inboundId,
          trafficLimit: isTrialOrd ? '1GB' : (data.traffic_limit || 'Unlimited'),
          serverNode: data.server || 'Singapore',
          _rawLimit: isTrialOrd ? 1 * 1024 * 1024 * 1024 : (data.traffic_limit && String(data.traffic_limit).toLowerCase() !== 'unlimited' ? ((parseFloat(String(data.traffic_limit)) || 0) * 1024 * 1024 * 1024) : 0),
          isTrial: isTrialOrd,
          templateId: tplId,
        });
      }
    }
  });

  // Retrieve fast in-memory cached inbounds metadata from background worker if available
  // To restore TRUE live traffic without cached delays, fetch the customer's specific inbounds directly from 3X-UI in parallel.
  const cached = await getCachedInbounds();
  const inboundsMap = new Map<number, any>();
  if (Array.isArray(cached)) {
    cached.forEach(ib => {
      if (ib && ib.id) inboundsMap.set(Number(ib.id), ib);
    });

    // Resolve any missing inboundId from cached inbounds list in memory for faster lookups
    configs.forEach(config => {
      if (config.uuid && (config.inboundId === null || config.inboundId === undefined || Number(config.inboundId) <= 0)) {
        for (const ib of cached) {
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
            console.log(`[Live Traffic Engine] Found missing inboundId ${ib.id} for UUID ${config.uuid} from cached list.`);
            break;
          }
        }
      }
    });
  }

  const userInboundIds = Array.from(new Set(
    configs
      .map(c => c.inboundId)
      .filter(id => id !== null && id !== undefined && Number(id) > 0)
  ));

  if (userInboundIds.length > 0) {
    try {
      console.log(`[Live Traffic Engine] Fetching ${userInboundIds.length} customer inbounds directly from 3X-UI...`);
      const liveResults = await Promise.all(
        userInboundIds.map(id => getLiveInbound(Number(id)))
      );
      liveResults.forEach(ib => {
        if (ib && ib.id) {
          inboundsMap.set(Number(ib.id), ib);
        }
      });
    } catch (err: any) {
      console.warn(`[Live Traffic Engine] Error fetching live customer inbounds:`, err.message || err);
    }
  }

  const inbounds = Array.from(inboundsMap.values());

  const resultConfigs = configs.map(config => {
    let up = 0;
    let down = 0;
    let total = config._rawLimit || 0;
    let expiryTime = 0;
    let lastOnline = 0;
    let enable = true;
    let inboundId = config.inboundId;
    console.log(`[Provisioning Audit] Database inbound_id after reload: ${config.inboundId}`);
    console.log(`[Provisioning Audit] UUID to match: ${config.uuid}`);
    let clientEmail = userEmail;
    let matchedInbound: any = null;
    let stat: any = null;
    let foundClient: any = null;

    const checkedUuids: string[] = [];

    if (inbounds.length > 0 && config.uuid) {
      for (const ib of inbounds) {
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
            console.log(`[Provisioning Audit] Matched Inbound ID: ${ib.id}, Raw Client JSON: ${JSON.stringify(c)}`);
            break;
          }
        }
        if (matchedInbound) break;
      }
    }

    if (matchedInbound && foundClient) {
      if (!inboundId) {
        inboundId = matchedInbound.id;
      }
      clientEmail = foundClient.email || userEmail;
      enable = foundClient.enable !== false;
      expiryTime = foundClient.expiryTime || 0;
      if (foundClient.totalBytes !== undefined) {
        total = foundClient.totalBytes;
      } else if (foundClient.total !== undefined) {
        total = foundClient.total;
      }

      const clientStats = matchedInbound.clientStats || [];
      if (config.uuid) {
        stat = clientStats.find((s: any) => String(s.id || '').toLowerCase() === String(config.uuid).toLowerCase()) ||
               clientStats.find((s: any) => String(s.email || '').toLowerCase() === String(clientEmail).toLowerCase());
        console.log(`[Provisioning Audit] Raw Client Stats JSON: ${JSON.stringify(stat)}`);
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
        
        if (stat.total !== undefined && stat.total > 0) {
          total = stat.total;
        }
        if (stat.expiryTime !== undefined && stat.expiryTime > 0) {
          expiryTime = stat.expiryTime;
        }
        if (stat.enable !== undefined) {
          enable = stat.enable;
        }
        lastOnline = stat.lastOnline || stat.online || stat.time || 0;
      } else {
        up = Math.max(clientUp, up);
        down = Math.max(clientDown, down);
        lastOnline = foundClient.lastOnline || foundClient.online || foundClient.time || 0;
      }
    } else {
      console.log(`[Provisioning Audit] No live stats found for UUID: ${config.uuid}. Using DB values.`);
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

    const isExpiredByTime = (expTimeMs > 0 && expTimeMs <= now) || (expTimeMs < 0);
    const isClientDisabled = enable === false;

    let status = 'Active';
    if (isClientDisabled || isExpiredByTime) {
      status = 'Expired';
    }

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

    console.log(`[Provisioning Audit] API response inboundId: ${inboundId}`);
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
      totalTrafficBytes: total,
      remainingTrafficBytes: remainingTraffic,
      expiryDate: currentExpiryDate,
      expiryTime: currentExpiryDate,
      status,
      enableStatus: status === 'Active',
      onlineStatus: status === 'Active' && (lastOnline > 0 || up > 0 || down > 0),
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
    };
  });

  const dbTime = Date.now() - dbStart;

  if (inbounds && inbounds.length > 0) {
    const liveUuids = new Set<string>();
    for (const ib of inbounds) {
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

    const filtered = resultConfigs.filter(cfg => {
      if (!cfg.uuid) return false;
      const isLive = liveUuids.has(String(cfg.uuid).trim().toLowerCase());
      if (!isLive) {
        console.log(`[3X-UI Sync] Excluding deleted configuration (UUID: ${cfg.uuid}) from user response.`);
      }
      return isLive;
    });

    return { configs: filtered, dbTime };
  }

  return { configs: resultConfigs, dbTime };
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

  // 1. Check vpn_accounts table
  try {
    const { data: vpnAccs } = await supabase.from('vpn_accounts').select('*');
    if (vpnAccs && Array.isArray(vpnAccs)) {
      for (const acc of vpnAccs) {
        const accUuid = String(acc.uuid || '').trim().toLowerCase();
        if (accUuid === normUuid) {
          const accUid = String(acc.user_id || '').trim();
          const accEmail = String(acc.email || '').trim().toLowerCase();
          if ((normUid && accUid === normUid) || (normEmail && accEmail === normEmail)) {
            return { owned: true, source: 'vpn_accounts', record: acc };
          }
          // UUID exists in vpn_accounts but belongs to another user
          return { owned: false, source: 'vpn_accounts', record: null };
        }
      }
    }
  } catch (e) {}

  // 2. Check orders table
  try {
    const { data: orders } = await supabase.from('orders').select('*');
    if (orders && Array.isArray(orders)) {
      for (const ord of orders) {
        const clientUuid = String(ord.client_uuid || ord.uuid || ord.vpn_credentials?.password || '').trim().toLowerCase();
        if (clientUuid === normUuid) {
          const ordUid = String(ord.customer_id || ord.customerUid || ord.customerId || '').trim();
          const ordEmail = String(ord.email || ord.customerEmail || '').trim().toLowerCase();
          if ((normUid && ordUid === normUid) || (normEmail && ordEmail === normEmail)) {
            return { owned: true, source: 'orders', record: ord };
          }
          // UUID exists in orders but belongs to another user
          return { owned: false, source: 'orders', record: null };
        }
      }
    }
  } catch (e) {}

  // 3. Check vpn_configs table
  try {
    const { data: vpnCfgs } = await supabase.from('vpn_configs').select('*');
    if (vpnCfgs && Array.isArray(vpnCfgs)) {
      for (const cfg of vpnCfgs) {
        const cfgUuid = String(cfg.uuid || '').trim().toLowerCase();
        if (cfgUuid === normUuid) {
          const cfgUid = String(cfg.customer_uid || cfg.user_id || cfg.userId || '').trim();
          const cfgEmail = String(cfg.customer_email || cfg.user_email || cfg.email || '').trim().toLowerCase();
          if ((normUid && cfgUid === normUid) || (normEmail && cfgEmail === normEmail)) {
            return { owned: true, source: 'vpn_configs', record: cfg };
          }
          return { owned: false, source: 'vpn_configs', record: null };
        }
      }
    }
  } catch (e) {}

  // 4. Check 3X-UI panel clients directly as authoritative fallback
  try {
    const cached = await getCachedInbounds();
    if (Array.isArray(cached)) {
      for (const ib of cached) {
        let settingsObj: any = {};
        try {
          if (ib.settings) settingsObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings;
        } catch (e) {}
        const clients = settingsObj.clients || [];
        for (const c of clients) {
          const cUuid = String(c.id || '').trim().toLowerCase();
          const cEmail = String(c.email || '').trim().toLowerCase();
          if (cUuid === normUuid) {
            // Check if email matches customer email or user identifier
            if (normEmail && (cEmail === normEmail || cEmail.includes(normEmail) || normEmail.includes(cEmail))) {
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
  } catch (e) {}

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

