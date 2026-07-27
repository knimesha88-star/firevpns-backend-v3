import { supabase } from '../../lib/supabase.js';
import { getCachedInbounds, getLiveInbound } from './xuiService.js';

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
