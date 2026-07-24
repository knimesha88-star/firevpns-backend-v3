import { supabase } from '../../lib/supabase.js';
import { getInbounds } from './xuiService.js';

export const getMyConfigs = async (uid: string, email?: string, _token?: string) => {
  console.log("Current UID:", uid);
  console.log("Current Email:", email);

  const userEmail = email ? email.toLowerCase().trim() : '';
  const userUid = uid ? uid.trim() : '';

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
      console.log(`[VPN Lookup] Found ${vpnAccs.length} vpn_accounts for user.`);
      vpnAccs.forEach((acc, index) => {
        console.log(`[VPN Lookup] Row ${index + 1}: id=${acc.id}, email=${acc.email}, uuid=${acc.uuid}, remark=${acc.remark}, server_id=${acc.server_id}, created_at=${acc.created_at}, status=${acc.status}`);
      });
      const latestAccs: Record<string, any> = {};
      vpnAccs.forEach(acc => {
        const docUserId = String(acc.user_id || '').trim();
        const docEmail = String(acc.email || '').toLowerCase().trim();
        const matchesUser = (userUid && docUserId === userUid) || (userEmail && docEmail === userEmail);
        
        if (matchesUser && acc.vless_url) {
          configs.push({
            orderId: acc.order_id || acc.id,
            packageName: acc.remark || 'FIREVPN Package',
            configUrl: acc.vless_url,
            uuid: acc.uuid,
            expiryDate: acc.expiry_date || (acc.expiry_time ? new Date(acc.expiry_time).toISOString() : ''),
            inboundId: null,
            trafficLimit: acc.total_bytes > 0 ? `${acc.total_bytes / (1024 * 1024 * 1024)}GB` : 'Unlimited',
            serverNode: acc.server_name || 'Singapore',
            _rawLimit: acc.total_bytes || 0,
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

  console.log("Orders Found:", matchedDocs.length);

  matchedDocs.forEach(data => {
    const vlessUrl = data.vless_url || data.vpn_credentials?.configLink || data.vpn_credentials?.qrcodeData || data.configUrl || '';
    const clientUuid = data.client_uuid || data.vpn_credentials?.password || data.uuid || '';

    if (vlessUrl) {
      const exists = configs.some(c => c.uuid && clientUuid && c.uuid.toLowerCase() === clientUuid.toLowerCase());
      if (!exists) {
        configs.push({
          orderId: data.id || data.order_id,
          packageName: data.package_name || data.plan || 'FIREVPN Package',
          configUrl: vlessUrl,
          uuid: clientUuid,
          expiryDate: data.expiry_date || data.expiryDate || '',
          inboundId: data.inbound_id || null,
          trafficLimit: data.traffic_limit || 'Unlimited',
          serverNode: data.server || 'Singapore',
          _rawLimit: 0,
        });
      }
    }
  });

  let inbounds: any[] = [];
  try {
    inbounds = await getInbounds();
  } catch (error) {
  }

  const resultConfigs = configs.map(config => {
    
    let usedGB = 0;
    let upBytes = 0;
    let downBytes = 0;
    let remainingGB: string | number = 'Unlimited';
    let status = 'Disabled';
    let currentExpiryDate = config.expiryDate;
    
    let trafficLimitNum = 0;
    if (String(config.trafficLimit).toLowerCase() !== 'unlimited') {
      const match = String(config.trafficLimit).match(/(\d+(\.\d+)?)/);
      if (match) {
        trafficLimitNum = parseFloat(match[1]);
        remainingGB = trafficLimitNum;
      }
    }

    const inboundIdNum = Number(config.inboundId);
    let matchedInbound: any = null;
    let stat: any = null;

    if (!isNaN(inboundIdNum) && inboundIdNum > 0 && inbounds.length > 0) {
      matchedInbound = inbounds.find(i => Number(i.id) === inboundIdNum);
    }

    // If no inbound matched by ID, try searching all inbounds for client matching uuid
    if (!matchedInbound && inbounds.length > 0 && config.uuid) {
      for (const ib of inbounds) {
        let settingsObj: any = {};
        try {
          if (ib.settings) {
            settingsObj = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings;
          }
        } catch (e) {}
        const clients = settingsObj.clients || [];
        
        const foundClient = clients.find((client: any) => String(client.id || '').toLowerCase() === String(config.uuid).toLowerCase());
        if (foundClient) {
          matchedInbound = ib;
          break;
        }
      }
    }

    if (matchedInbound) {
      let settingsObj: any = {};
      try {
        if (matchedInbound.settings) {
          settingsObj = typeof matchedInbound.settings === 'string' ? JSON.parse(matchedInbound.settings) : matchedInbound.settings;
        }
      } catch (e) {}

      const clients = settingsObj.clients || [];
      const c = clients.find((client: any) => String(client.id || '').toLowerCase() === String(config.uuid).toLowerCase());
      
      if (c) {
        const clientStats = matchedInbound.clientStats || [];
        
        // Match stat by UUID, not email.
        if (config.uuid) {
          stat = clientStats.find((s: any) => String(s.id || '').toLowerCase() === String(config.uuid).toLowerCase());
        }
        
        const enable = c.enable !== false;
        const expiryTime = c.expiryTime || 0;
        
        upBytes = stat?.up || 0;
        downBytes = stat?.down || 0;
        
        usedGB = (upBytes + downBytes) / 1024 / 1024 / 1024;
        
        if (trafficLimitNum > 0) {
          let remain = trafficLimitNum - usedGB;
          remainingGB = remain > 0 ? parseFloat(remain.toFixed(2)) : 0;
        } else {
          remainingGB = 'Unlimited';
        }
        
        usedGB = parseFloat(usedGB.toFixed(2));
        
        const now = Date.now();
        if (!enable) {
          status = 'Disabled';
        } else if (expiryTime > 0 && expiryTime < now) {
          status = 'Expired';
        } else {
          status = 'Active';
        }
        
        if (expiryTime > 0) {
          currentExpiryDate = new Date(expiryTime).toISOString();
        }
      } else {
        status = 'Active';
      }
    } else {
      status = 'Active';
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

    return {
      orderId: config.orderId,
      packageName: config.packageName,
      uuid: config.uuid,
      configUrl: config.configUrl,
      inboundId: config.inboundId,
      trafficLimit: config.trafficLimit,
      usedGB,
      remainingGB,
      upBytes,
      downBytes,
      upload: upBytes,
      download: downBytes,
      liveUsageFound: !!matchedInbound && (typeof stat !== 'undefined' ? !!stat : false), // Added flag
      totalTrafficBytes: trafficLimitNum > 0 ? trafficLimitNum * 1024 * 1024 * 1024 : 0,
      remainingTrafficBytes: typeof remainingGB === 'number' ? remainingGB * 1024 * 1024 * 1024 : 0,
      expiryDate: currentExpiryDate,
      expiryTime: currentExpiryDate,
      status,
      enableStatus: status !== 'Disabled',
      onlineStatus: status === 'Active',
      serverNode: config.serverNode,
      port,
      protocol,
      network,
      security,
      serverAddress,
      subscriptionName: config.packageName,
      name: config.packageName
    };
  });

  return resultConfigs;
};
