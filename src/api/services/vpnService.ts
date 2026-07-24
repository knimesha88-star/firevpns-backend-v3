import { supabase } from '../../lib/supabase.js';
import { getInbounds } from './xuiService.js';

export const getMyConfigs = async (uid: string, email?: string, _token?: string) => {
  console.log("Current UID:", uid);
  console.log("Current Email:", email);

  const userEmail = email ? email.toLowerCase().trim() : '';
  const userUid = uid ? uid.trim() : '';

  const { data: snapshot, error } = await supabase.from('orders').select('*');
  const allOrders: any[] = snapshot || [];

  const matchedDocs = allOrders.filter(doc => {
    const data = doc;
    const docUid = String(data.customerUid || data.customerId || data.uid || data.userId || '').trim();
    const docEmail = String(data.customerEmail || data.email || data.userEmail || '').toLowerCase().trim();
    const statusVal = String(data.status || data.payment_status || data.provisioning_status || '').toLowerCase();

    const matchesUser = (userUid && docUid === userUid) || (userEmail && docEmail === userEmail);
    const isApproved = statusVal === 'approved' || statusVal === 'completed' || statusVal === 'paid' || statusVal === 'active';

    return matchesUser && isApproved;
  });

  console.log("Orders Found:", matchedDocs.length);

  const configs: any[] = [];
  matchedDocs.forEach(data => {
    console.log({
      orderId: data.id || data.orderId,
      customerUid: data.customerUid || data.customerId || data.uid,
      customerEmail: data.customerEmail || data.email,
      status: data.status || data.payment_status
    });
    configs.push({
      orderId: data.id || data.orderId,
      packageName: data.plan || data.packageName || data.packageType || 'Unknown',
      configUrl: data.vpn_credentials?.configLink || data.vpn_credentials?.qrcodeData || data.configUrl || '',
      uuid: data.vpn_credentials?.password || data.uuid || '',
      expiryDate: data.expiryDate || data.expiryTime || '',
      inboundId: data.vpn_credentials?.inboundId || data.inboundId || null,
      trafficLimit: data.trafficLimit || data.traffic || 'Unlimited',
      serverNode: data.server || data.serverNode || 'Default',
      _rawLimit: data.totalBytes || 0,
    });
  });

  let inbounds: any[] = [];
  try {
    inbounds = await getInbounds();
  } catch (error) {
    console.error('[vpnService] Failed to fetch inbounds from 3X-UI:', error);
  }

  const resultConfigs = configs.map(config => {
    let usedGB = 0;
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
    if (!isNaN(inboundIdNum) && inbounds.length > 0) {
      const inbound = inbounds.find(i => Number(i.id) === inboundIdNum);
      if (inbound) {
        let settingsObj: any = {};
        try {
          if (inbound.settings) {
            settingsObj = typeof inbound.settings === 'string' ? JSON.parse(inbound.settings) : inbound.settings;
          }
        } catch (e) {}

        const clients = settingsObj.clients || [];
        const c = clients.find((client: any) => String(client.id).toLowerCase() === String(config.uuid).toLowerCase());
        
        if (c) {
          const emailStr = c.email || '';
          const clientStats = inbound.clientStats || [];
          const stat = clientStats.find((s: any) => s.email === emailStr);
          
          const enable = c.enable !== false;
          const expiryTime = c.expiryTime || 0;
          
          const up = stat?.up || 0;
          const down = stat?.down || 0;
          
          usedGB = (up + down) / 1024 / 1024 / 1024;
          
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
        }
      }
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
      expiryDate: currentExpiryDate,
      status,
      serverNode: config.serverNode
    };
  });

  return resultConfigs;
};
