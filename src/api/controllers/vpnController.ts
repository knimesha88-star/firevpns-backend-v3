import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as vpnService from '../services/vpnService.js';
import * as xuiService from '../services/xuiService.js';
import { supabase } from '../../lib/supabase.js';
import { sendTrialRequestNotification } from '../services/telegramService.js';
import { createCustomerNotification } from '../services/notificationService.js';

export const getMyConfigs = async (req: AuthRequest, res: Response): Promise<void> => {
  const reqStart = Date.now();
  console.log(`[API Performance] [GET /api/vpn/my-configs] Request started for UID: ${req.user?.uid || 'none'}`);
  try {
    const uid = req.user?.uid;
    const email = req.user?.email;
    const authHeader = req.headers.authorization || (req.headers as any)?.Authorization;
    const token = authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined;

    if (!uid) {
      const totalTime = Date.now() - reqStart;
      console.log(`[API Performance] [GET /api/vpn/my-configs] Request finished (401) | Total Execution: ${totalTime}ms | Database Time: 0ms | 3X-UI Time: 0ms`);
      res.status(401).json({ success: false, error: 'Unauthorized: No UID found' });
      return;
    }

    const { configs, dbTime } = await vpnService.getMyConfigs(uid, email, token);
    const totalTime = Date.now() - reqStart;
    console.log(`[API Performance] [GET /api/vpn/my-configs] Request finished | Total Execution: ${totalTime}ms | Database Time: ${dbTime}ms | 3X-UI Time: 0ms`);
    res.json({ success: true, configs });
  } catch (error: any) {
    const totalTime = Date.now() - reqStart;
    console.error(`[API Performance] [GET /api/vpn/my-configs] Request failed after ${totalTime}ms:`, error);
    res.status(500).json({ success: false, error: error.message || 'Internal Server Error' });
  }
};

export const getClaimedTrials = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    const email = req.user?.email;

    if (!uid && !email) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { data: snapshot } = await supabase.from('orders').select('*');
    const allOrders: any[] = snapshot || [];

    const claimedPackages: string[] = [];
    const claimedTemplates: string[] = [];
    const pendingPackages: string[] = [];
    const pendingTemplates: string[] = [];
    const approvedPackages: string[] = [];
    const approvedTemplates: string[] = [];

    allOrders.forEach((data) => {
      const docUid = String(data.customer_id || data.customerUid || data.customerId || '').trim();
      const docEmail = String(data.email || data.customerEmail || '').toLowerCase().trim();
      const matchesUser = (uid && docUid === uid) || (email && docEmail === email.toLowerCase().trim());

      if (matchesUser) {
        let pmJson: any = {};
        try {
          pmJson = typeof data.payment_method === 'string' ? JSON.parse(data.payment_method) : (data.payment_method || {});
        } catch (e) {}

        const isTrial = !!(
          pmJson.is_trial || 
          pmJson.isTrial || 
          pmJson.paymentMethod === 'Free Trial' || 
          String(data.order_id || data.id || '').startsWith('TRIAL-')
        );

        if (isTrial) {
          const pkgName = String(data.package_name || pmJson.packageName || pmJson.package_name || pmJson.plan || '').trim().toLowerCase();
          const tplId = String(data.template_id || pmJson.template_id || pmJson.templateId || '').trim().toLowerCase();
          const status = String(data.status || '').toLowerCase();
          const payStatus = String(data.payment_status || '').toLowerCase();
          const isPending = status === 'pending' || payStatus === 'pending trial approval' || payStatus === 'pending verification' || payStatus === 'pending';

          if (pkgName) claimedPackages.push(pkgName);
          if (tplId) claimedTemplates.push(tplId);

          if (isPending) {
            if (pkgName) pendingPackages.push(pkgName);
            if (tplId) pendingTemplates.push(tplId);
          } else if (status !== 'rejected') {
            if (pkgName) approvedPackages.push(pkgName);
            if (tplId) approvedTemplates.push(tplId);
          }
        }
      }
    });

    res.json({
      success: true,
      claimedPackages,
      claimedTemplates,
      pendingPackages,
      pendingTemplates,
      approvedPackages,
      approvedTemplates
    });
  } catch (error: any) {
    console.error('[vpnController] Error fetching claimed trials:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal Server Error' });
  }
};

export const claimTrial = async (req: AuthRequest, res: Response): Promise<void> => {
  const reqPayload = req.body;
  const file = 'backend/src/api/controllers/vpnController.ts';
  let line = 102;
  console.log('[vpnController] Incoming claimTrial request payload:', JSON.stringify(reqPayload, null, 2));

  try {
    line = 106;
    const uid = req.user?.uid;
    const email = req.user?.email;

    if (!uid || !email) {
      const errText = 'Please log in with a verified email to request your free trial.';
      console.warn(`[vpnController] ${errText} at ${file}:${line}`);
      res.status(401).json({
        success: false,
        error: errText,
        file,
        line
      });
      return;
    }

    line = 112;
    const { packageName, templateId, configurationName, customerName } = req.body;
    if (!packageName && !templateId) {
      const errText = 'Package Name or Template ID is required.';
      console.warn(`[vpnController] ${errText} at ${file}:${line}`);
      res.status(400).json({
        success: false,
        error: errText,
        file,
        line
      });
      return;
    }

    line = 172;
    // 2. Fetch templates to match the selected package
    console.log('[vpnController] Fetching provision templates');
    const { data: tpls, error: fetchTemplatesErr } = await supabase.from('provision_templates').select('*');
    if (fetchTemplatesErr) {
      console.error('[vpnController] Database error while fetching templates:', fetchTemplatesErr);
      res.status(500).json({
        success: false,
        error: `Database Fetch Error (Templates): ${fetchTemplatesErr.message}`,
        databaseError: fetchTemplatesErr,
        file,
        line
      });
      return;
    }

    line = 175;
    const templates: any[] = tpls || [];
    const matchedTemplate = templates.find((t: any) => {
      const tId = String(t.id || '').trim().toLowerCase();
      const tName = String(t.package_name || t.name || '').trim().toLowerCase();
      const reqPName = String(packageName || '').trim().toLowerCase();
      const reqTId = String(templateId || '').trim().toLowerCase();

      return (
        (reqTId && tId === reqTId) ||
        (reqPName && tName === reqPName) ||
        (reqPName && tName.replace(/_/g, ' ') === reqPName.replace(/_/g, ' ')) ||
        (reqPName && tId === reqPName)
      );
    });

    if (!matchedTemplate) {
      const errText = 'No matching VPN template found for this package.';
      console.warn(`[vpnController] ${errText} at ${file}:${line}`);
      res.status(400).json({
        success: false,
        error: errText,
        file,
        line
      });
      return;
    }

    line = 195;
    // 2.5. Before requesting a new trial, check any existing expired provisioning orders for this user and verify via 3X-UI
    try {
      const { data: staleOrders } = await supabase
        .from('orders')
        .select('*')
        .eq('customer_id', uid)
        .eq('status', 'provisioning');

      if (staleOrders && staleOrders.length > 0) {
        const now = Date.now();
        for (const stale of staleOrders) {
          let pm: any = {};
          try {
            pm = typeof stale.payment_method === 'string' ? JSON.parse(stale.payment_method) : (stale.payment_method || {});
          } catch {}

          const startedAt = pm.provisioning_started_at ? new Date(pm.provisioning_started_at).getTime() : new Date(stale.created_at).getTime();
          const isExpired = (now - startedAt) > (30 * 60 * 1000); // 30 minutes

          if (isExpired) {
            // Requirement 4: Before releasing an expired provisioning reservation, verify the corresponding client in 3X-UI using the existing backend service.
            // Requirement 3: Never treat a non-empty vless_url alone as proof that a VPN client exists in 3X-UI.
            const xuiClient = await xuiService.getClientByEmail(stale.email || email);
            if (xuiClient) {
              // Client exists in 3X-UI! Complete the order instead of cancelling.
              await supabase.from('orders').update({ status: 'completed', payment_status: 'paid' }).eq('order_id', stale.order_id);
            } else {
              // Client does NOT exist in 3X-UI. Safe to cancel/fail to release reservation.
              await supabase.from('orders').update({ status: 'cancelled', payment_status: 'failed' }).eq('order_id', stale.order_id);
            }
          }
        }
      }
    } catch (recoveryErr) {
      console.warn('[vpnController] Stale provisioning recovery check warning:', recoveryErr);
    }

    // 3. Atomically check 2-trial limit and insert trial order via Supabase RPC function
    const orderId = `TRIAL-${Math.floor(100000 + Math.random() * 900000)}`;
    const trimmedConfigName = (configurationName || `Trial-${matchedTemplate.package_name}`).trim();
    const finalCustomerName = (customerName || (email ? email.split('@')[0] : 'Customer')).trim();

    const notesJson = JSON.stringify({
      paymentMethod: 'Free Trial',
      is_trial: true,
      isTrial: true,
      trial: true,
      duration: '1 Day',
      packageType: '1GB',
      traffic: '1GB',
      configurationName: trimmedConfigName,
      customerName: finalCustomerName,
      plan: matchedTemplate.package_name,
      packageName: matchedTemplate.package_name,
      package_name: matchedTemplate.package_name,
      templateId: matchedTemplate.id,
      template_id: matchedTemplate.id,
      price: 0,
      requestedAt: new Date().toISOString()
    });

    console.log('[vpnController] Calling atomic claim_free_trial RPC function for order:', orderId);
    const { data: rpcData, error: rpcErr } = await supabase.rpc('claim_free_trial', {
      p_customer_id: uid,
      p_order_id: orderId,
      p_email: email,
      p_package_name: matchedTemplate.package_name,
      p_payment_method: JSON.parse(notesJson)
    });

    if (rpcErr || !rpcData || !rpcData.success) {
      const errText = rpcData?.error || rpcErr?.message || 'You have used all 2 free trials available for your account.';
      console.warn(`[vpnController] Atomic trial claim rejected at ${file}:${line}:`, errText);
      res.status(400).json({
        success: false,
        error: errText,
        file,
        line
      });
      return;
    }

    // 3.5. Set explicit provisioning lease timestamp in payment_method JSONB and atomically transition status from 'pending' to 'provisioning'
    console.log(`[vpnController] Fetching newly created trial order ${orderId} for customer ${uid}`);
    const { data: currentOrder, error: fetchErr } = await supabase
      .from('orders')
      .select('payment_method, status, customer_id')
      .eq('order_id', orderId)
      .maybeSingle();

    console.log(`[vpnController] Current order lookup result for ${orderId}:`, { currentOrder, fetchErr });

    if (fetchErr || !currentOrder) {
      console.error(`[vpnController] Failed to fetch trial order ${orderId} (Customer: ${uid}) | DB Error:`, fetchErr);
      res.status(400).json({ success: false, error: `Order state transition failed: Order not found (DB Error: ${fetchErr?.message || 'Not found'})` });
      return;
    }

    if (currentOrder.status !== 'pending') {
      console.warn(`[vpnController] Order ${orderId} expected 'pending' status but found '${currentOrder.status}'`);
      res.status(400).json({ success: false, error: `Order is no longer pending (Current status: ${currentOrder.status})` });
      return;
    }

    let currentPm: any = {};
    try {
      currentPm = typeof currentOrder?.payment_method === 'string' ? JSON.parse(currentOrder.payment_method) : (currentOrder?.payment_method || {});
    } catch {}
    currentPm.provisioning_started_at = new Date().toISOString();

    console.log(`[vpnController] Attempting atomic state transition for order ${orderId} (Customer: ${uid}) from 'pending' to 'provisioning'`);
    const { data: updatedProvisioningOrder, error: provTransErr } = await supabase
      .from('orders')
      .update({
        status: 'provisioning',
        payment_method: JSON.stringify(currentPm)
      })
      .eq('order_id', orderId)
      .eq('customer_id', uid)
      .eq('status', 'pending')
      .select('order_id, status')
      .maybeSingle();

    console.log(`[vpnController] Atomic update result for ${orderId}:`, { updatedProvisioningOrder, provTransErr });

    if (provTransErr || !updatedProvisioningOrder) {
      console.error(`[vpnController] State transition FAILED for order ${orderId} (Customer: ${uid}) | Attempted: pending -> provisioning | DB Error:`, provTransErr);
      res.status(400).json({
        success: false,
        error: `Order state transition failed or order was cleaned up. (Details: ${provTransErr?.message || 'Atomic update matched 0 rows'})`
      });
      return;
    }

    // 4. Automatically provision through 3X-UI integration
    console.log(`[vpnController] Auto-provisioning trial order ${orderId} via 3X-UI`);
    let provResult: any = null;
    try {
      provResult = await xuiService.provisionOrderClient(orderId);
    } catch (provErr: any) {
      console.error(`[vpnController] Free trial auto-provisioning exception for order ${orderId}:`, provErr);
      provResult = { success: false, error: provErr.message || 'Provisioning exception' };
    }

    // Ensure final activation updates only an order whose status is still provisioning. Never reactivate a cancelled order from a late provisioning response.
    const { data: latestOrder } = await supabase.from('orders').select('status').eq('order_id', orderId).maybeSingle();
    if (!latestOrder || latestOrder.status !== 'provisioning') {
      console.warn(`[vpnController] Trial order ${orderId} status is '${latestOrder?.status || 'unknown'}', not provisioning. Aborting activation.`);
      res.status(400).json({
        success: false,
        error: 'Provisioning timed out or order was cancelled. Please try again.',
        file,
        line
      });
      return;
    }

    if (!provResult || !provResult.success) {
      console.warn(`[vpnController] Provisioning failed for trial order ${orderId}, marking order as cancelled to release trial reservation while preserving history.`);
      await supabase.from('orders').update({ status: 'cancelled', payment_status: 'failed' }).eq('order_id', orderId).eq('status', 'provisioning');

      res.status(400).json({
        success: false,
        error: provResult?.error || 'Free Trial auto-provisioning failed. Please try again.',
        file,
        line
      });
      return;
    }

    // Mark order completed conditionally if status is still provisioning
    const { data: completedOrder, error: completeErr } = await supabase.from('orders').update({
      status: 'completed',
      payment_status: 'paid',
      vless_url: provResult.vlessUrl
    }).eq('order_id', orderId).eq('status', 'provisioning').select('order_id').maybeSingle();

    if (completeErr || !completedOrder) {
      console.warn(`[vpnController] Failed to complete trial order ${orderId} because status changed from provisioning.`);
      res.status(400).json({ success: false, error: 'Order was cancelled or modified during provisioning.' });
      return;
    }

    // 5. Create customer notification in DB
    try {
      await createCustomerNotification({
        userId: uid,
        userEmail: email,
        title: 'Free Trial Activated!',
        message: 'Your free trial is now active. You can now connect to your VPN. Enjoy your 1 GB allowance for 1 day.',
        type: 'trial_approved',
        orderId: orderId,
        vpnName: matchedTemplate.package_name
      });
    } catch (notifErr: any) {
      console.error('[vpnController] Customer notification creation error:', notifErr);
    }

    // 6. Send Telegram notification to Administrator
    try {
      await sendTrialRequestNotification({
        customerName: finalCustomerName,
        email: email,
        packageName: matchedTemplate.package_name,
        templateName: matchedTemplate.package_name || matchedTemplate.name,
        trialLimits: '1 GB / 1 Day (24 Hours) [Auto-Activated]',
        requestTime: new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' }),
        requestId: orderId
      });
    } catch (tgErr: any) {
      console.error('[vpnController] Telegram notification error:', tgErr);
    }

    const { count: successfulCount } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('customer_id', uid)
      .in('status', ['completed', 'active']);

    const remainingTrials = Math.max(0, 2 - (successfulCount || 1));

    // Success response
    console.log('[vpnController] Free Trial auto-activation completed successfully. Order ID:', orderId);
    res.json({
      success: true,
      orderId: orderId,
      status: 'completed',
      vlessUrl: provResult.vlessUrl,
      remainingTrials: remainingTrials,
      message: `Free Trial Activated Successfully! You have ${remainingTrials} of 2 trials remaining.`
    });

  } catch (error: any) {
    console.error(`[vpnController] Unhandled claimTrial Exception at ${file}:${line}:`, error);
    res.status(500).json({
      success: false,
      error: error.message || 'An unhandled exception occurred.',
      stack: error.stack,
      file,
      line
    });
  }
};

export const resetTraffic = async (req: AuthRequest, res: Response): Promise<void> => {
  const reqStart = Date.now();
  try {
    const uid = req.user?.uid;
    const email = req.user?.email || '';
    const configUuid = req.body?.configUuid || req.body?.uuid || req.body?.configId;

    console.log(`[POST /api/vpn/reset-traffic] Request from user UID: '${uid}', UUID: '${configUuid}'`);

    if (!uid) {
      res.status(401).json({ success: false, error: 'Unauthorized: Authentication required' });
      return;
    }

    if (!configUuid) {
      res.status(400).json({ success: false, error: 'Missing required field: configUuid' });
      return;
    }

    const result = await vpnService.resetVpnTraffic(uid, email, configUuid);
    const duration = Date.now() - reqStart;
    console.log(`[POST /api/vpn/reset-traffic] Succeeded in ${duration}ms:`, result);
    res.json(result);
  } catch (error: any) {
    const duration = Date.now() - reqStart;
    const status = error.status || (error.message?.includes('Forbidden') ? 403 : error.message?.includes('cooldown') || error.message?.includes('maximum') ? 429 : error.message?.includes('not found') ? 404 : 400);
    console.warn(`[POST /api/vpn/reset-traffic] Failed (${status}) after ${duration}ms:`, error.message);
    res.status(status).json({
      success: false,
      error: error.message || 'Failed to reset VPN traffic'
    });
  }
};

export const getResetTrafficStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    const email = req.user?.email || '';
    const configUuid = req.params?.uuid || req.query?.uuid;

    if (!uid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    if (!configUuid) {
      res.status(400).json({ success: false, error: 'Missing UUID parameter' });
      return;
    }

    const status = await vpnService.getResetTrafficStatus(uid, email, String(configUuid));
    res.json({ success: true, ...status });
  } catch (error: any) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to retrieve reset traffic status'
    });
  }
};

export const getTrafficResetPolicyHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const policy = await vpnService.getTrafficResetPolicy();
    res.json({ success: true, policy });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const saveTrafficResetPolicyHandler = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const policy = req.body?.policy || req.body;
    const updated = await vpnService.saveTrafficResetPolicy(policy);
    res.json({ success: true, policy: updated });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const trackOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    const email = (req.user?.email || '').toLowerCase().trim();
    const role = req.user?.role || 'customer';
    const orderIdParam = String(req.params?.orderId || req.query?.orderId || '').trim();

    if (!uid && !email) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    if (!orderIdParam) {
      res.status(400).json({ success: false, error: 'Order ID is required' });
      return;
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderIdParam);

    let orderRecord: any = null;
    if (isUuid) {
      const { data } = await supabase
        .from('orders')
        .select('*')
        .or(`id.eq.${orderIdParam},order_id.eq.${orderIdParam}`)
        .maybeSingle();
      orderRecord = data;
    } else {
      const { data } = await supabase
        .from('orders')
        .select('*')
        .eq('order_id', orderIdParam)
        .maybeSingle();
      orderRecord = data;
    }

    if (!orderRecord) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }

    const ownerUid = String(orderRecord.customer_id || '').trim();
    const ownerEmail = String(orderRecord.email || '').toLowerCase().trim();
    const isOwner =
      role === 'admin' ||
      (uid && ownerUid === uid) ||
      (email && ownerEmail === email);

    if (!isOwner) {
      res.status(403).json({ success: false, error: 'Forbidden: You do not have access to this order' });
      return;
    }

    // Also fetch associated VPN configuration if provisioned
    let vpnConfig: any = null;
    try {
      const { data: cfgByOrder } = await supabase
        .from('vpn_configs')
        .select('*')
        .eq('order_id', orderRecord.id)
        .maybeSingle();

      if (cfgByOrder) {
        vpnConfig = cfgByOrder;
      } else if (orderRecord.client_uuid) {
        const { data: cfgByUuid } = await supabase
          .from('vpn_configs')
          .select('*')
          .eq('uuid', orderRecord.client_uuid)
          .maybeSingle();
        vpnConfig = cfgByUuid;
      }
    } catch {}

    let extra: any = {};
    if (orderRecord.payment_method && typeof orderRecord.payment_method === 'string' && orderRecord.payment_method.startsWith('{')) {
      try {
        extra = JSON.parse(orderRecord.payment_method);
      } catch {}
    }

    const rawStatus = String(orderRecord.status || '').toLowerCase();
    const rawProv = String(orderRecord.provisioning_status || '').toLowerCase();
    const rawPay = String(orderRecord.payment_status || '').toLowerCase();
    const hasVpnCredentials = Boolean(
      orderRecord.vless_url ||
      orderRecord.client_uuid ||
      vpnConfig?.vless_link ||
      vpnConfig?.vless_url ||
      vpnConfig?.uuid
    );

    let normalizedStage: 'Pending' | 'Verified' | 'Provisioning' | 'Active' | 'Rejected' | 'Failed' = 'Pending';
    if (rawStatus === 'rejected' || rawPay === 'cancelled' || rawPay === 'rejected' || orderRecord.reject_reason) {
      normalizedStage = 'Rejected';
    } else if (rawProv === 'failed' || rawPay === 'failed') {
      normalizedStage = 'Failed';
    } else if (
      rawStatus === 'completed' ||
      rawStatus === 'active' ||
      rawProv === 'completed' ||
      rawProv === 'active' ||
      hasVpnCredentials
    ) {
      normalizedStage = 'Active';
    } else if (rawProv === 'provisioning' || rawProv === 'creating' || rawStatus === 'provisioning') {
      normalizedStage = 'Provisioning';
    } else if (rawPay === 'paid' || rawPay === 'approved') {
      normalizedStage = 'Verified';
    } else {
      normalizedStage = 'Pending';
    }

    res.json({
      success: true,
      order: {
        ...orderRecord,
        orderId: orderRecord.order_id || orderRecord.id,
        customerId: orderRecord.customer_id,
        plan: extra.plan || orderRecord.package_name,
        packageType: extra.packageType || 'Unlimited',
        server: vpnConfig?.server_name || extra.server || 'Singapore',
        duration: extra.duration || '1 Month',
        payment_status: orderRecord.payment_status || 'Pending Verification',
        provisioning_status: normalizedStage,
        createdAt: orderRecord.created_at,
        activatedAt: orderRecord.activated_at || vpnConfig?.activated_at || null,
        expiryDate: orderRecord.expiry_date || orderRecord.expires_at || vpnConfig?.expiry_date || vpnConfig?.expires_at || null,
        inboundId: vpnConfig?.inbound_id || null,
        clientUuid: orderRecord.client_uuid || vpnConfig?.uuid || null,
        vlessUrl: orderRecord.vless_url || vpnConfig?.vless_link || vpnConfig?.vless_url || null,
        subscriptionUrl: orderRecord.subscription_url || vpnConfig?.subscription_url || null,
        dataLimit: vpnConfig?.data_limit || extra.dataLimit || null,
        reject_reason: orderRecord.reject_reason || null
      }
    });
  } catch (error: any) {
    console.error('[vpnController] Error in trackOrder:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal Server Error' });
  }
};


