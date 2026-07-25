import { Response } from 'express';
import { AuthRequest } from '../../types/interfaces.js';
import * as vpnService from '../services/vpnService.js';
import { supabase } from '../../lib/supabase.js';
import { sendTrialRequestNotification } from '../services/telegramService.js';
import { createCustomerNotification } from '../services/notificationService.js';

export const getMyConfigs = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    const email = req.user?.email;
    const authHeader = req.headers.authorization || (req.headers as any)?.Authorization;
    const token = authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined;

    if (!uid) {
      res.status(401).json({ success: false, error: 'Unauthorized: No UID found' });
      return;
    }

    const configs = await vpnService.getMyConfigs(uid, email, token);
    res.json({ success: true, configs });
  } catch (error: any) {
    console.error('[vpnController] Error fetching configs:', error);
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

    line = 119;
    // 1. Check if user already submitted a trial request for this package/template
    console.log('[vpnController] Fetching user orders to validate duplicate trial claims');
    const { data: userOrders, error: fetchOrdersErr } = await supabase.from('orders').select('*');
    if (fetchOrdersErr) {
      console.error('[vpnController] Database error while fetching orders:', fetchOrdersErr);
      res.status(500).json({
        success: false,
        error: `Database Fetch Error: ${fetchOrdersErr.message || 'Failed to fetch orders'}`,
        databaseError: fetchOrdersErr,
        file,
        line
      });
      return;
    }

    line = 122;
    const allOrders: any[] = userOrders || [];
    const existingTrial = allOrders.find((data) => {
      const docUid = String(data.customer_id || data.customerUid || data.customerId || '').trim();
      const docEmail = String(data.email || data.customerEmail || '').toLowerCase().trim();
      const matchesUser = (uid && docUid === uid) || (email && docEmail === email.toLowerCase().trim());

      if (!matchesUser) return false;

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

      if (!isTrial) return false;

      const pName = String(data.package_name || pmJson.packageName || pmJson.package_name || pmJson.plan || '').trim().toLowerCase();
      const tId = String(data.template_id || pmJson.template_id || pmJson.templateId || '').trim().toLowerCase();

      const reqPName = String(packageName || '').trim().toLowerCase();
      const reqTId = String(templateId || '').trim().toLowerCase();

      return (reqPName && pName === reqPName) || (reqTId && tId === reqTId) || (reqPName && tId === reqPName);
    });

    line = 152;
    if (existingTrial) {
      const status = String(existingTrial.status || '').toLowerCase();
      const payStatus = String(existingTrial.payment_status || '').toLowerCase();
      if (status === 'pending' || payStatus === 'pending trial approval' || payStatus === 'pending verification' || payStatus === 'pending') {
        const errText = 'Request Pending: You already have a pending trial request for this package. Please wait for administrator approval.';
        console.warn(`[vpnController] ${errText} at ${file}:${line}`);
        res.status(400).json({
          success: false,
          error: errText,
          file,
          line
        });
        return;
      }
      if (status !== 'rejected') {
        const errText = 'Trial Already Used: You have already claimed or been approved for a free trial for this package.';
        console.warn(`[vpnController] ${errText} at ${file}:${line}`);
        res.status(400).json({
          success: false,
          error: errText,
          file,
          line
        });
        return;
      }
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
    // 3. Create the pending trial request (Order status = 'pending')
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

    const orderPayload: any = {
      order_id: orderId,
      customer_id: uid,
      email: email,
      package_name: matchedTemplate.package_name,
      amount: 0,
      payment_method: notesJson,
      payment_status: 'Pending',
      status: 'pending',
      created_at: new Date().toISOString()
    };

    console.log('[vpnController] Creating pending trial request payload in database:', JSON.stringify(orderPayload, null, 2));

    line = 233;
    let { data: resData, error: insertErr } = await supabase
      .from('orders')
      .insert(orderPayload)
      .select()
      .maybeSingle();

    if (insertErr && (insertErr.message?.includes('payment_status') || insertErr.code === '23514')) {
      console.warn('[vpnController] Insert with payment_status Pending failed, retrying with Pending Verification:', insertErr);
      const { data: resData2, error: retryErr } = await supabase
        .from('orders')
        .insert({ ...orderPayload, payment_status: 'Pending Verification' })
        .select()
        .maybeSingle();
      if (!retryErr) {
        insertErr = null;
        resData = resData2;
      } else {
        insertErr = retryErr;
      }
    }

    if (insertErr) {
      console.error('[vpnController] Database Trial insert error:', insertErr);
      res.status(500).json({
        success: false,
        error: `Database Insert Error: ${insertErr.message || 'Constraint violation'}`,
        databaseError: insertErr,
        file,
        line
      });
      return;
    }

    line = 260;
    // 4. Create customer notification in DB
    try {
      await createCustomerNotification({
        userId: uid,
        userEmail: email,
        title: 'Free Trial Submitted',
        message: `Your 1-Day Free Trial request for ${matchedTemplate.package_name || 'VPN Package'} has been submitted and is pending administrator approval.`,
        type: 'trial_submitted',
        orderId: orderId,
        vpnName: matchedTemplate.package_name
      });
    } catch (notifErr: any) {
      console.error('[vpnController] Customer notification creation error:', notifErr);
    }

    line = 274;
    // 5. Send Telegram notification to Administrator
    let telegramRes: any = null;
    try {
      telegramRes = await sendTrialRequestNotification({
        customerName: finalCustomerName,
        email: email,
        packageName: matchedTemplate.package_name,
        templateName: matchedTemplate.package_name || matchedTemplate.name,
        trialLimits: '1 GB / 1 Day (24 Hours)',
        requestTime: new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' }),
        requestId: orderId
      });
    } catch (tgErr: any) {
      console.error('[vpnController] Telegram notification error:', tgErr);
      res.status(502).json({
        success: false,
        error: `Telegram Notification Error: ${tgErr.message || 'Failed to send admin alert'}`,
        telegramError: tgErr.message || tgErr,
        file,
        line
      });
      return;
    }

    // Success response
    console.log('[vpnController] Free Trial submission completed successfully. Request ID:', orderId);
    res.json({
      success: true,
      orderId: orderId,
      status: 'pending',
      telegramResponse: telegramRes,
      message: 'Your 1 GB • 1 Day Free Trial request has been submitted successfully and is pending administrator approval!'
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

