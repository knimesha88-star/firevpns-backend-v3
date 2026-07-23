import { adminDb } from '../../config/firebaseAdmin.js';
import { getInbounds } from './xuiService.js';

export const getMyConfigs = async (uid: string) => {
  const snapshot = await adminDb.collection('orders')
    .where('customerUid', '==', uid)
    .where('status', '==', 'Approved')
    .get();

  const configs: any[] = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    configs.push({
      orderId: doc.id,
      packageName: data.plan || data.packageName || data.packageType || 'Unknown',
      configUrl: data.vpnCredentials?.configLink || data.vpnCredentials?.qrcodeData || '',
      uuid: data.vpnCredentials?.password || data.uuid || '',
      expiryDate: data.expiryDate || data.expiryTime || '',
      inboundId: data.vpnCredentials?.inboundId || data.inboundId || null,
      trafficLimit: data.trafficLimit || data.traffic || 'Unlimited',
      serverNode: data.server || data.serverNode || 'Default',
      // Internal fields, stripped before return
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
    
    // Convert trafficLimit string to numeric value for math (or rely on calculation)
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
