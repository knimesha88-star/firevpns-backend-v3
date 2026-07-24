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
    let up = 0;
    let down = 0;
    let total = config._rawLimit || 0;
    let expiryTime = 0;
    let lastOnline = 0;
    let enable = true;
    let inboundId = config.inboundId;
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
            break;
          }
        }
        if (matchedInbound) break;
      }
    }

    if (matchedInbound && foundClient) {
      inboundId = matchedInbound.id;
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
      }

      if (stat) {
        up = stat.up || 0;
        down = stat.down || 0;
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
        up = foundClient.up || 0;
        down = foundClient.down || 0;
        lastOnline = foundClient.lastOnline || foundClient.online || foundClient.time || 0;
      }
    } else {
      console.log(`Stored UUID: ${config.uuid}`);
      console.log(`3X-UI UUIDs checked: ${JSON.stringify(checkedUuids)}`);
      console.log("No matching UUID found.");
    }

    const totalUsed = up + down;
    const remainingTraffic = total > 0 ? Math.max(total - totalUsed, 0) : 0;

    console.log(`[VPN Audit] User email: ${userEmail}`);
    console.log(`[VPN Audit] UUID: ${config.uuid}`);
    console.log(`[VPN Audit] Inbound ID: ${inboundId}`);
    console.log(`[VPN Audit] Client email: ${clientEmail}`);
    console.log(`[VPN Audit] Upload: ${up}`);
    console.log(`[VPN Audit] Download: ${down}`);
    console.log(`[VPN Audit] Total: ${total}`);
    console.log(`[VPN Audit] Remaining: ${remainingTraffic}`);
    console.log(`[VPN Audit] Last online: ${lastOnline}`);

    const usedGB = parseFloat((totalUsed / (1024 * 1024 * 1024)).toFixed(2));
    const remainingGB = total > 0 ? parseFloat((remainingTraffic / (1024 * 1024 * 1024)).toFixed(2)) : 'Unlimited';

    const now = Date.now();
    let status = 'Active';
    if (!enable) {
      status = 'Disabled';
    } else if (expiryTime > 0 && expiryTime < now) {
      status = 'Expired';
    }

    let currentExpiryDate = config.expiryDate;
    if (expiryTime > 0) {
      currentExpiryDate = new Date(expiryTime).toISOString();
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
