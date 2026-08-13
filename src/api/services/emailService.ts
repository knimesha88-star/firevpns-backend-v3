import { Resend } from 'resend';
import { supabaseAdmin } from '../../lib/supabase.js';

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  eventType: string;
  referenceId?: string;
  userId?: string;
}

// Global cached settings
let cachedEmailSettings: any = null;
let lastSettingsFetch = 0;

export const getEmailSettings = async () => {
  const now = Date.now();
  if (cachedEmailSettings && now - lastSettingsFetch < 30000) {
    return cachedEmailSettings;
  }
  try {
    const { data } = await supabaseAdmin.from('settings').select('*').eq('id', 'email').maybeSingle();
    if (data && data.data) {
      cachedEmailSettings = data.data;
      lastSettingsFetch = now;
      return cachedEmailSettings;
    }
  } catch (err) {
    console.warn('[EmailService] Could not fetch email settings from DB:', err);
  }
  return {
    enabled: true,
    apiKey: process.env.EMAIL_PROVIDER_API_KEY || process.env.RESEND_API_KEY || '',
    fromAddress: process.env.EMAIL_FROM_ADDRESS || 'onboarding@resend.dev',
    fromName: process.env.EMAIL_FROM_NAME || 'FIREVPNs Support',
    events: {
      order_received: true,
      payment_approved: true,
      payment_rejected: true,
      renewal_approved: true,
      renewal_rejected: true,
      trial_approved: true,
      trial_rejected: true,
      vpn_expiring: true,
      vpn_expired: true,
      support_reply: true,
      livechat_reply: true,
      maintenance_announcement: true
    }
  };
};

const getResendClient = async () => {
  const settings = await getEmailSettings();
  const apiKey = settings.apiKey || process.env.EMAIL_PROVIDER_API_KEY || process.env.RESEND_API_KEY;
  if (!apiKey) {
    return null;
  }
  return new Resend(apiKey);
};

// HTML Layout Template generator with FIREVPNs Dark/Blue branding
const renderEmailTemplate = (title: string, bodyContent: string): string => {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #0f172a;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #e2e8f0;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      width: 100%;
      background-color: #0f172a;
      padding: 40px 10px;
      box-sizing: border-box;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #1e293b;
      border: 1px solid #334155;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    }
    .header {
      background: linear-gradient(135deg, #0284c7 0%, #2563eb 50%, #1d4ed8 100%);
      padding: 28px 32px;
      text-align: center;
    }
    .logo {
      max-width: 180px;
      height: auto;
    }
    .brand-title {
      font-size: 24px;
      font-weight: 800;
      color: #ffffff;
      margin: 0;
      letter-spacing: -0.5px;
    }
    .content {
      padding: 32px;
      line-height: 1.6;
    }
    h1, h2, h3 {
      color: #f8fafc;
      margin-top: 0;
    }
    .badge {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 16px;
    }
    .badge-success { background-color: rgba(34, 197, 94, 0.2); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
    .badge-danger { background-color: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
    .badge-warning { background-color: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-info { background-color: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }
    .info-box {
      background-color: #0f172a;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 20px;
      margin: 20px 0;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #1e293b;
    }
    .info-row:last-child {
      border-bottom: none;
    }
    .info-label {
      color: #94a3b8;
      font-size: 14px;
    }
    .info-value {
      color: #f8fafc;
      font-weight: 600;
      font-size: 14px;
      word-break: break-all;
    }
    .btn {
      display: inline-block;
      background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%);
      color: #ffffff !important;
      text-decoration: none;
      padding: 14px 28px;
      border-radius: 10px;
      font-weight: 700;
      font-size: 15px;
      text-align: center;
      margin: 20px 0;
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
    }
    .code-box {
      background-color: #0f172a;
      border: 1px dashed #38bdf8;
      border-radius: 8px;
      padding: 14px;
      font-family: monospace;
      font-size: 13px;
      color: #38bdf8;
      word-break: break-all;
      margin: 16px 0;
    }
    .footer {
      background-color: #0f172a;
      padding: 24px 32px;
      text-align: center;
      border-top: 1px solid #334155;
      color: #64748b;
      font-size: 13px;
    }
    .footer a {
      color: #38bdf8;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <div class="brand-title">🔥 FIREVPNs</div>
      </div>
      <div class="content">
        ${bodyContent}
      </div>
      <div class="footer">
        <p>&copy; ${new Date().getFullYear()} FIREVPNs. All rights reserved.</p>
        <p>This is an automated operational email regarding your account activity.</p>
      </div>
    </div>
  </div>
</body>
</html>
  `;
};

// Log email event safely to Supabase email_notifications table
const logEmailStatus = async (data: {
  userId?: string | null;
  email: string;
  eventType: string;
  referenceId?: string | null;
  subject: string;
  status: 'sent' | 'failed' | 'skipped';
  errorMessage?: string | null;
}) => {
  try {
    const payload = {
      user_id: data.userId || null,
      email: data.email,
      event_type: data.eventType,
      reference_id: data.referenceId || null,
      subject: data.subject,
      status: data.status,
      error_message: data.errorMessage || null,
      sent_at: data.status === 'sent' ? new Date().toISOString() : null,
      created_at: new Date().toISOString()
    };

    const { error } = await supabaseAdmin.from('email_notifications').insert(payload);
    if (error) {
      if (error.code !== 'PGRST205') {
        console.warn('[EmailService] Error inserting email log into DB:', error.message || error);
      }
    }
  } catch (err: any) {
    // Ignore database logging exceptions so main app stays 100% stable
    console.warn('[EmailService] Exception during email logging:', err.message || err);
  }
};

// Check if email event was already sent to prevent duplicate emails
export const checkEmailAlreadySent = async (eventType: string, referenceId: string): Promise<boolean> => {
  if (!referenceId) return false;
  try {
    const { data, error } = await supabaseAdmin
      .from('email_notifications')
      .select('id')
      .eq('event_type', eventType)
      .eq('reference_id', referenceId)
      .eq('status', 'sent')
      .maybeSingle();

    if (!error && data) {
      return true;
    }
  } catch (e) {
    // Ignore error
  }
  return false;
};

// Primary email dispatch routine
export const sendEmail = async (params: SendEmailParams): Promise<{ success: boolean; messageId?: string; error?: string }> => {
  const { to, subject, html, text, eventType, referenceId, userId } = params;

  if (!to || !to.includes('@')) {
    console.warn(`[EmailService] Invalid recipient email '${to}'. Skipping send.`);
    return { success: false, error: 'Invalid recipient email address' };
  }

  const settings = await getEmailSettings();

  // Check if email system is disabled globally or for this specific event
  if (settings.enabled === false) {
    console.log(`[EmailService] Email system globally disabled in settings. Skipping event '${eventType}'.`);
    await logEmailStatus({ userId, email: to, eventType, referenceId, subject, status: 'skipped', errorMessage: 'Email system globally disabled' });
    return { success: false, error: 'Email service disabled' };
  }

  const eventKey = eventType.toLowerCase();
  if (settings.events && settings.events[eventKey] === false) {
    console.log(`[EmailService] Event '${eventType}' disabled in settings. Skipping.`);
    await logEmailStatus({ userId, email: to, eventType, referenceId, subject, status: 'skipped', errorMessage: `Event ${eventType} disabled in settings` });
    return { success: false, error: `Event ${eventType} disabled` };
  }

  // Idempotency check for reference ID
  if (referenceId) {
    const alreadySent = await checkEmailAlreadySent(eventType, referenceId);
    if (alreadySent) {
      console.log(`[EmailService] Duplicate send prevented for event '${eventType}' and referenceId '${referenceId}'.`);
      return { success: true, error: 'Duplicate email prevented' };
    }
  }

  const resend = await getResendClient();
  if (!resend) {
    console.warn(`[EmailService] Resend API key missing. Cannot send email to ${to} for event ${eventType}.`);
    await logEmailStatus({ userId, email: to, eventType, referenceId, subject, status: 'failed', errorMessage: 'Resend API key missing' });
    return { success: false, error: 'Email provider API key not configured' };
  }

  const fromName = settings.fromName || process.env.EMAIL_FROM_NAME || 'FIREVPNs Support';
  const fromAddress = settings.fromAddress || process.env.EMAIL_FROM_ADDRESS || 'onboarding@resend.dev';
  const senderFormatted = `${fromName} <${fromAddress}>`;

  try {
    console.log(`[EmailService] Sending email [${eventType}] to ${to} via ${fromAddress}...`);
    const result = await resend.emails.send({
      from: senderFormatted,
      to,
      subject,
      html,
      text: text || subject
    });

    if (result.error) {
      console.error(`[EmailService] Resend provider error [${eventType}]:`, result.error);
      await logEmailStatus({ userId, email: to, eventType, referenceId, subject, status: 'failed', errorMessage: JSON.stringify(result.error) });
      return { success: false, error: result.error.message };
    }

    console.log(`[EmailService] Email sent successfully! Message ID: ${result.data?.id}`);
    await logEmailStatus({ userId, email: to, eventType, referenceId, subject, status: 'sent' });
    return { success: true, messageId: result.data?.id };
  } catch (err: any) {
    console.error(`[EmailService] Exception during email dispatch [${eventType}]:`, err.message || err);
    await logEmailStatus({ userId, email: to, eventType, referenceId, subject, status: 'failed', errorMessage: err.message || String(err) });
    return { success: false, error: err.message || String(err) };
  }
};

// ================= CUSTOMER EMAIL EVENT HANDLERS ================= //

// 1. New Order Email
export const sendOrderReceivedEmail = async (data: {
  userEmail: string;
  customerName?: string;
  orderId: string;
  packageName: string;
  amount: number;
  paymentMethod?: string;
  userId?: string;
}) => {
  const subject = `Order Confirmation #${data.orderId} - FIREVPNs`;
  const body = `
    <span class="badge badge-info">Order Received</span>
    <h1>Thank You for Your Order!</h1>
    <p>Hello ${data.customerName || 'Valued Customer'},</p>
    <p>We have successfully received your order for <strong>${data.packageName}</strong>. Our system is processing your payment verification.</p>
    
    <div class="info-box">
      <div class="info-row">
        <span class="info-label">Order Reference:</span>
        <span class="info-value">#${data.orderId}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Package:</span>
        <span class="info-value">${data.packageName}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Amount:</span>
        <span class="info-value">LKR ${data.amount}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Payment Method:</span>
        <span class="info-value">${data.paymentMethod || 'Bank Transfer / Manual Slip'}</span>
      </div>
    </div>

    <p>You will receive another email with your VPN access credentials as soon as your payment is verified by our team.</p>
  `;
  return sendEmail({
    to: data.userEmail,
    subject,
    html: renderEmailTemplate(subject, body),
    eventType: 'order_received',
    referenceId: data.orderId,
    userId: data.userId
  });
};

// 2. Payment Approved Email
export const sendPaymentApprovedEmail = async (data: {
  userEmail: string;
  customerName?: string;
  orderId: string;
  packageName: string;
  vlessUrl?: string;
  expiryDate?: string;
  userId?: string;
}) => {
  const subject = `Payment Approved! Your ${data.packageName} VPN is Ready - FIREVPNs`;
  const formattedExpiry = data.expiryDate ? new Date(data.expiryDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A';
  const body = `
    <span class="badge badge-success">Payment Approved</span>
    <h1>Your VPN is Activated!</h1>
    <p>Hello ${data.customerName || 'Valued Customer'},</p>
    <p>Great news! Your payment for <strong>${data.packageName}</strong> (Order #${data.orderId}) has been verified and approved.</p>
    
    <div class="info-box">
      <div class="info-row">
        <span class="info-label">Order ID:</span>
        <span class="info-value">#${data.orderId}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Package:</span>
        <span class="info-value">${data.packageName}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Expiry Date:</span>
        <span class="info-value">${formattedExpiry}</span>
      </div>
    </div>

    ${data.vlessUrl ? `
      <h3>Your VLESS Connection Link</h3>
      <p>Import this link directly into v2rayNG, v2rayN, Shadowrocket, or Streisand:</p>
      <div class="code-box">${data.vlessUrl}</div>
    ` : ''}

    <p>You can also access and manage all your active configurations directly from your customer dashboard.</p>
  `;
  return sendEmail({
    to: data.userEmail,
    subject,
    html: renderEmailTemplate(subject, body),
    eventType: 'payment_approved',
    referenceId: data.orderId,
    userId: data.userId
  });
};

// 3. Payment Rejected Email
export const sendPaymentRejectedEmail = async (data: {
  userEmail: string;
  customerName?: string;
  orderId: string;
  packageName: string;
  reason?: string;
  userId?: string;
}) => {
  const subject = `Order #${data.orderId} Update - Action Required - FIREVPNs`;
  const body = `
    <span class="badge badge-danger">Payment Rejected</span>
    <h1>Payment Verification Issue</h1>
    <p>Hello ${data.customerName || 'Valued Customer'},</p>
    <p>We were unable to verify your payment for order <strong>#${data.orderId}</strong> (${data.packageName}).</p>
    
    <div class="info-box">
      <div class="info-row">
        <span class="info-label">Order ID:</span>
        <span class="info-value">#${data.orderId}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Reason:</span>
        <span class="info-value" style="color: #f87171;">${data.reason || 'Invalid or unreadable payment slip uploaded.'}</span>
      </div>
    </div>

    <p>If you believe this is an error, please reach out via live chat or submit a support ticket in your customer dashboard.</p>
  `;
  return sendEmail({
    to: data.userEmail,
    subject,
    html: renderEmailTemplate(subject, body),
    eventType: 'payment_rejected',
    referenceId: data.orderId,
    userId: data.userId
  });
};

// 4. Renewal Approved Email
export const sendRenewalApprovedEmail = async (data: {
  userEmail: string;
  customerName?: string;
  renewalId?: string;
  packageName: string;
  vlessUrl?: string;
  expiryDate?: string;
  userId?: string;
}) => {
  const subject = `Renewal Approved! ${data.packageName} Extended - FIREVPNs`;
  const formattedExpiry = data.expiryDate ? new Date(data.expiryDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A';
  const refId = data.renewalId || `renew_${Date.now()}`;
  const body = `
    <span class="badge badge-success">Renewal Approved</span>
    <h1>Your Subscription Has Been Extended!</h1>
    <p>Hello ${data.customerName || 'Valued Customer'},</p>
    <p>Your renewal request for <strong>${data.packageName}</strong> has been verified and approved successfully.</p>
    
    <div class="info-box">
      <div class="info-row">
        <span class="info-label">Package:</span>
        <span class="info-value">${data.packageName}</span>
      </div>
      <div class="info-row">
        <span class="info-label">New Expiry Date:</span>
        <span class="info-value">${formattedExpiry}</span>
      </div>
    </div>

    ${data.vlessUrl ? `
      <h3>Updated VLESS Connection Link</h3>
      <div class="code-box">${data.vlessUrl}</div>
    ` : ''}

    <p>Thank you for continuing to trust FIREVPNs for your online security and high-speed access!</p>
  `;
  return sendEmail({
    to: data.userEmail,
    subject,
    html: renderEmailTemplate(subject, body),
    eventType: 'renewal_approved',
    referenceId: refId,
    userId: data.userId
  });
};

// 5. Renewal Rejected Email
export const sendRenewalRejectedEmail = async (data: {
  userEmail: string;
  customerName?: string;
  renewalId?: string;
  packageName: string;
  reason?: string;
  userId?: string;
}) => {
  const subject = `Renewal Request Update - FIREVPNs`;
  const refId = data.renewalId || `renew_rej_${Date.now()}`;
  const body = `
    <span class="badge badge-danger">Renewal Rejected</span>
    <h1>Renewal Verification Issue</h1>
    <p>Hello ${data.customerName || 'Valued Customer'},</p>
    <p>We could not process your renewal request for <strong>${data.packageName}</strong>.</p>
    
    <div class="info-box">
      <div class="info-row">
        <span class="info-label">Reason:</span>
        <span class="info-value" style="color: #f87171;">${data.reason || 'Payment verification failed or invalid transfer slip.'}</span>
      </div>
    </div>

    <p>Please log in to your account and re-submit your payment slip or contact our support team.</p>
  `;
  return sendEmail({
    to: data.userEmail,
    subject,
    html: renderEmailTemplate(subject, body),
    eventType: 'renewal_rejected',
    referenceId: refId,
    userId: data.userId
  });
};

// 6. Trial Approved Email
export const sendTrialApprovedEmail = async (data: {
  userEmail: string;
  customerName?: string;
  trialId?: string;
  orderId?: string;
  packageName: string;
  vlessUrl?: string;
  expiryDate?: string;
  userId?: string;
}) => {
  const subject = `Free Trial Approved! Your ${data.packageName} is Ready - FIREVPNs`;
  const refId = data.trialId || data.orderId || `trial_${Date.now()}`;
  const body = `
    <span class="badge badge-success">Free Trial Active</span>
    <h1>Welcome to Your Free Trial!</h1>
    <p>Hello ${data.customerName || 'Valued Customer'},</p>
    <p>Your request for a free trial of <strong>${data.packageName}</strong> has been approved!</p>
    
    ${data.vlessUrl ? `
      <h3>Your Free Trial VLESS Link</h3>
      <p>Import this link into your V2Ray client:</p>
      <div class="code-box">${data.vlessUrl}</div>
    ` : ''}

    <p>Enjoy blazing fast speeds and unlimited protection during your trial period!</p>
  `;
  return sendEmail({
    to: data.userEmail,
    subject,
    html: renderEmailTemplate(subject, body),
    eventType: 'trial_approved',
    referenceId: refId,
    userId: data.userId
  });
};

// 7. Trial Rejected Email
export const sendTrialRejectedEmail = async (data: {
  userEmail: string;
  customerName?: string;
  trialId?: string;
  orderId?: string;
  packageName: string;
  reason?: string;
  userId?: string;
}) => {
  const subject = `Free Trial Request Update - FIREVPNs`;
  const refId = data.trialId || data.orderId || `trial_rej_${Date.now()}`;
  const body = `
    <span class="badge badge-danger">Trial Request Declined</span>
    <h1>Free Trial Request Update</h1>
    <p>Hello ${data.customerName || 'Valued Customer'},</p>
    <p>We were unable to approve your free trial request for <strong>${data.packageName}</strong>.</p>
    
    <div class="info-box">
      <div class="info-row">
        <span class="info-label">Reason:</span>
        <span class="info-value" style="color: #f87171;">${data.reason || 'A free trial was already claimed for this device or account.'}</span>
      </div>
    </div>

    <p>You can still purchase our regular high-speed plans anytime from the portal!</p>
  `;
  return sendEmail({
    to: data.userEmail,
    subject,
    html: renderEmailTemplate(subject, body),
    eventType: 'trial_rejected',
    referenceId: refId,
    userId: data.userId
  });
};

// 8. VPN Expiring Email (3 days / 1 day)
export const sendExpiryReminderEmail = async (data: {
  userEmail: string;
  customerName?: string;
  vpnAccountId?: string;
  packageName: string;
  daysLeft: number;
  expiryDate?: string;
  userId?: string;
}) => {
  const daysText = data.daysLeft === 1 ? 'Tomorrow' : `in ${data.daysLeft} Days`;
  const subject = `Reminder: Your VPN Expires ${daysText} - FIREVPNs`;
  const refId = `${data.vpnAccountId || data.userEmail}_expiring_${data.daysLeft}d`;
  const body = `
    <span class="badge badge-warning">Expiry Warning</span>
    <h1>Your VPN Subscription Expires Soon</h1>
    <p>Hello ${data.customerName || 'Valued Customer'},</p>
    <p>Your VPN configuration <strong>${data.packageName}</strong> is set to expire <strong>${daysText}</strong>.</p>
    
    <div class="info-box">
      <div class="info-row">
        <span class="info-label">Package:</span>
        <span class="info-value">${data.packageName}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Days Remaining:</span>
        <span class="info-value">${data.daysLeft} Day(s)</span>
      </div>
    </div>

    <p>To avoid service disruption, please renew your subscription from your customer portal today.</p>
  `;
  return sendEmail({
    to: data.userEmail,
    subject,
    html: renderEmailTemplate(subject, body),
    eventType: `vpn_expiring_${data.daysLeft}d`,
    referenceId: refId,
    userId: data.userId
  });
};

// 9. VPN Expired Email
export const sendVpnExpiredEmail = async (data: {
  userEmail: string;
  customerName?: string;
  vpnAccountId?: string;
  packageName: string;
  expiryDate?: string;
  userId?: string;
}) => {
  const subject = `Your VPN Subscription Has Expired - FIREVPNs`;
  const refId = `${data.vpnAccountId || data.userEmail}_expired_${Date.now()}`;
  const body = `
    <span class="badge badge-danger">Subscription Expired</span>
    <h1>Your VPN Has Been Deactivated</h1>
    <p>Hello ${data.customerName || 'Valued Customer'},</p>
    <p>Your VPN configuration <strong>${data.packageName}</strong> has expired and is now inactive.</p>

    <p>Renew your plan now to immediately restore high-speed unlimited access!</p>
  `;
  return sendEmail({
    to: data.userEmail,
    subject,
    html: renderEmailTemplate(subject, body),
    eventType: 'vpn_expired',
    referenceId: refId,
    userId: data.userId
  });
};

// 10. Support Ticket Reply Email
export const sendSupportReplyEmail = async (data: {
  userEmail: string;
  customerName?: string;
  ticketId: string;
  subject: string;
  replyMessage: string;
  userId?: string;
}) => {
  const emailSubject = `New Reply on Support Ticket #${data.ticketId} - FIREVPNs`;
  const body = `
    <span class="badge badge-info">Support Ticket Reply</span>
    <h1>Support Response Received</h1>
    <p>Hello ${data.customerName || 'Valued Customer'},</p>
    <p>Our support team has posted a reply to your ticket <strong>#${data.ticketId}</strong> ("${data.subject}"):</p>
    
    <div class="info-box">
      <div style="color: #e2e8f0; font-size: 15px; white-space: pre-wrap;">${data.replyMessage}</div>
    </div>

    <p>You can respond directly to this ticket by logging into your dashboard.</p>
  `;
  return sendEmail({
    to: data.userEmail,
    subject: emailSubject,
    html: renderEmailTemplate(emailSubject, body),
    eventType: 'support_reply',
    referenceId: `reply_${data.ticketId}_${Date.now()}`,
    userId: data.userId
  });
};

// 11. Live Chat Reply Email
export const sendLiveChatReplyEmail = async (data: {
  userEmail: string;
  customerName?: string;
  chatMessage: string;
  userId?: string;
}) => {
  const subject = `New Message from FIREVPNs Support`;
  const body = `
    <span class="badge badge-info">Live Chat Message</span>
    <h1>New Live Chat Message</h1>
    <p>Hello ${data.customerName || 'Valued Customer'},</p>
    <p>You have received a message from our live chat team:</p>
    
    <div class="info-box">
      <div style="color: #e2e8f0; font-size: 15px; white-space: pre-wrap;">${data.chatMessage}</div>
    </div>

    <p>Open the live chat widget on our website to continue the conversation.</p>
  `;
  return sendEmail({
    to: data.userEmail,
    subject,
    html: renderEmailTemplate(subject, body),
    eventType: 'livechat_reply',
    referenceId: `chat_${Date.now()}`,
    userId: data.userId
  });
};

// 12. Maintenance / News Announcement Email
export const sendMaintenanceAnnouncementEmail = async (data: {
  userEmail: string;
  customerName?: string;
  announcementTitle: string;
  announcementBody: string;
  userId?: string;
}) => {
  const subject = `[Announcement] ${data.announcementTitle} - FIREVPNs`;
  const body = `
    <span class="badge badge-warning">System Announcement</span>
    <h1>${data.announcementTitle}</h1>
    <p>Hello ${data.customerName || 'Valued Customer'},</p>
    
    <div class="info-box">
      <div style="color: #e2e8f0; font-size: 15px; line-height: 1.6; white-space: pre-wrap;">${data.announcementBody}</div>
    </div>

    <p>If you have any questions regarding this announcement, please reach out to our 24/7 support team.</p>
  `;
  return sendEmail({
    to: data.userEmail,
    subject,
    html: renderEmailTemplate(subject, body),
    eventType: 'maintenance_announcement',
    referenceId: `announcement_${Date.now()}`,
    userId: data.userId
  });
};
