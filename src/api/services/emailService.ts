import { supabaseAdmin } from '../../lib/supabase.js';
import {
  renderEmailLayout,
  renderBrandedEmail,
  buildCustomerRegistrationTemplate,
  buildOrderReceivedTemplate,
  buildPaymentApprovedTemplate,
  buildOrderCompletedTemplate,
  buildPaymentRejectedTemplate,
  buildRenewalRequestReceivedTemplate,
  buildRenewalApprovedTemplate,
  buildRenewalRejectedTemplate,
  buildTrialApprovedTemplate,
  buildTrialRejectedTemplate,
  buildExpiryReminderTemplate,
  buildVpnExpiredTemplate,
  buildSupportReplyTemplate,
  buildLiveChatReplyTemplate,
  buildMaintenanceAnnouncementTemplate,
  buildSystemTestEmailTemplate
} from './emailTemplates.js';

export {
  renderEmailLayout,
  renderBrandedEmail,
  buildCustomerRegistrationTemplate,
  buildOrderReceivedTemplate,
  buildPaymentApprovedTemplate,
  buildOrderCompletedTemplate,
  buildPaymentRejectedTemplate,
  buildRenewalRequestReceivedTemplate,
  buildRenewalApprovedTemplate,
  buildRenewalRejectedTemplate,
  buildTrialApprovedTemplate,
  buildTrialRejectedTemplate,
  buildExpiryReminderTemplate,
  buildVpnExpiredTemplate,
  buildSupportReplyTemplate,
  buildLiveChatReplyTemplate,
  buildMaintenanceAnnouncementTemplate,
  buildSystemTestEmailTemplate
};

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  eventType: string;
  referenceId?: string;
  userId?: string;
}

export interface SendEmailResult {
  success: boolean;
  accepted?: boolean;
  messageId?: string;
  from?: string;
  to?: string;
  statusCode?: number;
  duplicatePrevented?: boolean;
  error?: string;
}

const DEFAULT_FROM_NAME = 'FIREVPNs Support';
const DEFAULT_FROM_ADDRESS = 'support@firevpnsteam.qd.je';
const DEFAULT_SENDER_FORMATTED = `${DEFAULT_FROM_NAME} <${DEFAULT_FROM_ADDRESS}>`;

// Parse EMAIL_FROM env variable such as "FIREVPNs Support <support@firevpnsteam.qd.je>" or "support@firevpnsteam.qd.je"
export const parseSenderConfig = (
  rawEmailFrom?: string,
  fallbackName?: string,
  fallbackAddress?: string
): { fromName: string; fromAddress: string; formatted: string } => {
  const cleanRaw = (rawEmailFrom || '').replace(/^['"]+|['"]+$/g, '').trim();

  if (cleanRaw) {
    const angleMatch = cleanRaw.match(/^([^<]+)<([^>]+)>$/);
    if (angleMatch) {
      const parsedName = angleMatch[1].trim() || fallbackName || DEFAULT_FROM_NAME;
      const parsedAddress = angleMatch[2].trim() || fallbackAddress || DEFAULT_FROM_ADDRESS;
      return {
        fromName: parsedName,
        fromAddress: parsedAddress,
        formatted: `${parsedName} <${parsedAddress}>`
      };
    }
    if (cleanRaw.includes('@')) {
      const nameToUse = (fallbackName || DEFAULT_FROM_NAME).trim();
      return {
        fromName: nameToUse,
        fromAddress: cleanRaw,
        formatted: `${nameToUse} <${cleanRaw}>`
      };
    }
  }

  const finalName = (fallbackName || process.env.EMAIL_FROM_NAME || DEFAULT_FROM_NAME).replace(/^['"]+|['"]+$/g, '').trim() || DEFAULT_FROM_NAME;
  const rawAddress = (fallbackAddress || process.env.EMAIL_FROM_ADDRESS || DEFAULT_FROM_ADDRESS).replace(/^['"]+|['"]+$/g, '').trim();
  const finalAddress = (!rawAddress || rawAddress === 'onboarding@resend.dev') ? DEFAULT_FROM_ADDRESS : rawAddress;

  return {
    fromName: finalName,
    fromAddress: finalAddress,
    formatted: `${finalName} <${finalAddress}>`
  };
};

// Global cached settings
let cachedEmailSettings: any = null;
let lastSettingsFetch = 0;

// In-memory deduplication locks to prevent concurrent or rapid retry duplicate emails
const inFlightEmailKeys = new Set<string>();
const recentSentEmailKeys = new Map<string, number>();
const RECENT_SENT_TTL_MS = 10 * 60 * 1000; // 10 minutes in-memory cache in addition to DB check

const getDefaultEventsConfig = () => ({
  customer_registered: true,
  order_received: true,
  payment_approved: true,
  order_completed: true,
  payment_rejected: true,
  renewal_requested: true,
  renewal_approved: true,
  renewal_rejected: true,
  trial_approved: true,
  trial_rejected: true,
  vpn_expiring: true,
  vpn_expired: true,
  support_reply: true,
  livechat_reply: true,
  maintenance_announcement: true
});

const fetchRawDbEmailSettings = async (): Promise<any | null> => {
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
  return null;
};

export const invalidateEmailSettingsCache = () => {
  cachedEmailSettings = null;
  lastSettingsFetch = 0;
};

/**
 * Returns sanitized email settings safe for controller/admin inspection.
 * Never exposes RESEND_API_KEY or raw secret keys in browser responses.
 */
export const getEmailSettings = async () => {
  const rawDb = await fetchRawDbEmailSettings();
  const envSender = parseSenderConfig(
    process.env.EMAIL_FROM,
    process.env.EMAIL_FROM_NAME,
    process.env.EMAIL_FROM_ADDRESS
  );

  const dbFromAddress = rawDb?.fromAddress && rawDb.fromAddress !== 'onboarding@resend.dev'
    ? String(rawDb.fromAddress).trim()
    : envSender.fromAddress;

  const dbFromName = rawDb?.fromName
    ? String(rawDb.fromName).trim()
    : envSender.fromName;

  const hasConfiguredApiKey = Boolean(
    (process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim()) ||
    (process.env.EMAIL_PROVIDER_API_KEY && process.env.EMAIL_PROVIDER_API_KEY.trim()) ||
    (rawDb?.apiKey && String(rawDb.apiKey).trim())
  );

  return {
    enabled: rawDb?.enabled !== undefined ? Boolean(rawDb.enabled) : true,
    apiKey: '', // Never expose secret API key to frontend/browser
    hasConfiguredApiKey,
    fromAddress: dbFromAddress || DEFAULT_FROM_ADDRESS,
    fromName: dbFromName || DEFAULT_FROM_NAME,
    events: {
      ...getDefaultEventsConfig(),
      ...(rawDb?.events || {})
    }
  };
};

const getResendApiKey = async (): Promise<string | null> => {
  const envKey = (process.env.RESEND_API_KEY || process.env.EMAIL_PROVIDER_API_KEY || '')
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
  if (envKey) {
    return envKey;
  }

  const rawDb = await fetchRawDbEmailSettings();
  const dbKey = (rawDb?.apiKey || '').replace(/^['"]+|['"]+$/g, '').trim();
  if (dbKey) {
    return dbKey;
  }

  return null;
};

const resolveVerifiedSender = async (): Promise<{ fromName: string; fromAddress: string; formatted: string }> => {
  if (process.env.EMAIL_FROM && process.env.EMAIL_FROM.trim()) {
    return parseSenderConfig(process.env.EMAIL_FROM);
  }
  const settings = await getEmailSettings();
  return parseSenderConfig(undefined, settings.fromName, settings.fromAddress);
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
    const cleanUserId =
      data.userId && !['N/A', 'null', 'undefined', ''].includes(String(data.userId).trim())
        ? String(data.userId).trim()
        : null;

    const payload = {
      user_id: cleanUserId,
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
export const checkEmailAlreadySent = async (eventType: string, referenceId: string, recipientEmail?: string): Promise<boolean> => {
  if (!referenceId) return false;

  const dedupKey = `${eventType.toLowerCase()}:${referenceId}`;
  const recentTs = recentSentEmailKeys.get(dedupKey);
  if (recentTs && Date.now() - recentTs < RECENT_SENT_TTL_MS) {
    return true;
  }

  try {
    let query = supabaseAdmin
      .from('email_notifications')
      .select('id')
      .eq('event_type', eventType)
      .eq('reference_id', referenceId)
      .eq('status', 'sent')
      .limit(1);

    if (recipientEmail) {
      query = query.eq('email', recipientEmail);
    }

    const { data, error } = await query.maybeSingle();

    if (!error && data) {
      recentSentEmailKeys.set(dedupKey, Date.now());
      return true;
    }
  } catch (_e) {
    // Ignore DB lookup error so email flow does not crash
  }
  return false;
};

// Primary email dispatch routine
export const sendEmail = async (params: SendEmailParams): Promise<SendEmailResult> => {
  const { to, subject, html, text, eventType, referenceId, userId } = params;
  const cleanRecipient = (to || '').trim();

  if (!cleanRecipient || !cleanRecipient.includes('@') || cleanRecipient === 'N/A') {
    console.warn(`[EmailService] Invalid recipient email '${to}'. Skipping send.`);
    return { success: false, accepted: false, error: 'Invalid recipient email address' };
  }

  const settings = await getEmailSettings();

  // Check if email system is disabled globally or for this specific event
  if (settings.enabled === false && eventType !== 'test_email') {
    console.log(`[EmailService] Email system globally disabled in settings. Skipping event '${eventType}'.`);
    await logEmailStatus({ userId, email: cleanRecipient, eventType, referenceId, subject, status: 'skipped', errorMessage: 'Email system globally disabled' });
    return { success: false, accepted: false, error: 'Email service disabled' };
  }

  const eventKey = eventType.toLowerCase();
  const baseEventKey = eventKey.startsWith('vpn_expiring') ? 'vpn_expiring' : eventKey;
  if (
    eventType !== 'test_email' &&
    settings.events &&
    (settings.events[eventKey] === false || settings.events[baseEventKey] === false)
  ) {
    console.log(`[EmailService] Event '${eventType}' disabled in settings. Skipping.`);
    await logEmailStatus({ userId, email: cleanRecipient, eventType, referenceId, subject, status: 'skipped', errorMessage: `Event ${eventType} disabled in settings` });
    return { success: false, accepted: false, error: `Event ${eventType} disabled` };
  }

  const dedupKey = referenceId ? `${eventKey}:${referenceId}` : `${eventKey}:${cleanRecipient.toLowerCase()}:${subject}`;

  // Prevent concurrent in-flight duplicate calls
  if (inFlightEmailKeys.has(dedupKey)) {
    console.log(`[EmailService] In-flight duplicate send prevented for key '${dedupKey}'.`);
    return { success: true, accepted: false, duplicatePrevented: true, error: 'Duplicate email prevented (in-flight)' };
  }

  // Idempotency check for reference ID in memory + Supabase email_notifications
  if (referenceId && eventType !== 'test_email') {
    const alreadySent = await checkEmailAlreadySent(eventType, referenceId, cleanRecipient);
    if (alreadySent) {
      console.log(`[EmailService] Duplicate send prevented for event '${eventType}' and referenceId '${referenceId}'.`);
      return { success: true, accepted: false, duplicatePrevented: true, error: 'Duplicate email prevented' };
    }
  }

  const apiKey = await getResendApiKey();
  if (!apiKey) {
    console.warn(`[EmailService] Resend API key (RESEND_API_KEY) missing. Cannot send email to ${cleanRecipient} for event ${eventType}.`);
    await logEmailStatus({ userId, email: cleanRecipient, eventType, referenceId, subject, status: 'failed', errorMessage: 'RESEND_API_KEY not configured' });
    return { success: false, accepted: false, error: 'RESEND_API_KEY is not configured in environment variables' };
  }

  const sender = await resolveVerifiedSender();
  const senderFormatted = sender.formatted || DEFAULT_SENDER_FORMATTED;

  inFlightEmailKeys.add(dedupKey);

  try {
    console.log(`[EmailService] Sending email [${eventType}] to ${cleanRecipient} from ${senderFormatted}...`);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    };

    if (referenceId) {
      const safeIdempotencyKey = `${eventKey}-${referenceId}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 250);
      headers['Idempotency-Key'] = safeIdempotencyKey;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        from: senderFormatted,
        to: [cleanRecipient],
        subject,
        html,
        text: text || subject
      })
    });

    const resData: any = await response.json().catch(() => null);

    if (!response.ok || !resData?.id) {
      const errMsg =
        resData?.message ||
        resData?.error?.message ||
        resData?.name ||
        (!resData?.id && response.ok ? 'Resend API returned HTTP 200 without a message ID' : `HTTP ${response.status} ${response.statusText}`);
      console.error(`[EmailService] Resend API error [${eventType}] (HTTP ${response.status}):`, errMsg);
      await logEmailStatus({
        userId,
        email: cleanRecipient,
        eventType,
        referenceId,
        subject,
        status: 'failed',
        errorMessage: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)
      });
      return {
        success: false,
        accepted: false,
        from: senderFormatted,
        to: cleanRecipient,
        statusCode: response.status,
        error: typeof errMsg === 'string' ? errMsg : 'Resend API request failed'
      };
    }

    const messageId = String(resData.id);
    recentSentEmailKeys.set(dedupKey, Date.now());
    console.log(`[EmailService] Email accepted by Resend! Event: ${eventType} | To: ${cleanRecipient} | Message ID: ${messageId}`);
    await logEmailStatus({ userId, email: cleanRecipient, eventType, referenceId, subject, status: 'sent' });
    return {
      success: true,
      accepted: true,
      messageId,
      from: senderFormatted,
      to: cleanRecipient,
      statusCode: response.status
    };
  } catch (err: any) {
    console.error(`[EmailService] Exception during email dispatch [${eventType}]:`, err.message || err);
    await logEmailStatus({ userId, email: cleanRecipient, eventType, referenceId, subject, status: 'failed', errorMessage: err.message || String(err) });
    return {
      success: false,
      accepted: false,
      from: senderFormatted,
      to: cleanRecipient,
      error: err.message || String(err)
    };
  } finally {
    inFlightEmailKeys.delete(dedupKey);
  }
};

// ================= CUSTOMER EMAIL EVENT HANDLERS ================= //

// 0. Customer Registration Welcome Email
export const sendCustomerRegistrationEmail = async (data: {
  userEmail: string;
  customerName?: string;
  userId?: string;
}) => {
  const refId = `welcome_${data.userId || data.userEmail.trim().toLowerCase()}`;
  const rendered = buildCustomerRegistrationTemplate({
    userEmail: data.userEmail,
    customerName: data.customerName
  });

  return sendEmail({
    to: data.userEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    eventType: 'customer_registered',
    referenceId: refId,
    userId: data.userId
  });
};

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
  const rendered = buildOrderReceivedTemplate(data);
  return sendEmail({
    to: data.userEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
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
  const rendered = buildPaymentApprovedTemplate(data);
  return sendEmail({
    to: data.userEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    eventType: 'payment_approved',
    referenceId: data.orderId,
    userId: data.userId
  });
};

// 2.5 Order Completed Email
export const sendOrderCompletedEmail = async (data: {
  userEmail: string;
  customerName?: string;
  orderId: string;
  packageName: string;
  vlessUrl?: string;
  expiryDate?: string;
  userId?: string;
}) => {
  const rendered = buildOrderCompletedTemplate(data);
  return sendEmail({
    to: data.userEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    eventType: 'order_completed',
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
  const rendered = buildPaymentRejectedTemplate(data);
  return sendEmail({
    to: data.userEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    eventType: 'payment_rejected',
    referenceId: data.orderId,
    userId: data.userId
  });
};

// 3.5 Renewal Request Received Email (Status: Pending)
export const sendRenewalRequestReceivedEmail = async (data: {
  userEmail: string;
  customerName?: string;
  renewalId?: string;
  receiptNumber?: string;
  vpnAccountId?: string;
  packageName: string;
  durationMonths?: number;
  amount?: number;
  userId?: string;
}) => {
  const refId =
    data.renewalId ||
    `renew_req_${data.receiptNumber || data.vpnAccountId || data.userEmail.trim().toLowerCase()}`;
  const rendered = buildRenewalRequestReceivedTemplate(data);

  return sendEmail({
    to: data.userEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    eventType: 'renewal_requested',
    referenceId: refId,
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
  const formattedExpiry = data.expiryDate ? new Date(data.expiryDate).toLocaleDateString('en-US') : 'N/A';
  const refId = data.renewalId || `renew_approved_${data.userEmail.trim().toLowerCase()}_${formattedExpiry}`;
  const rendered = buildRenewalApprovedTemplate(data);

  return sendEmail({
    to: data.userEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
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
  const refId = data.renewalId || `renew_rejected_${data.userEmail.trim().toLowerCase()}_${data.packageName}`;
  const rendered = buildRenewalRejectedTemplate(data);

  return sendEmail({
    to: data.userEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
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
  const refId = data.orderId || data.trialId || `trial_approved_${data.userEmail.trim().toLowerCase()}`;
  const rendered = buildTrialApprovedTemplate(data);

  return sendEmail({
    to: data.userEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
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
  const refId = data.orderId || data.trialId || `trial_rejected_${data.userEmail.trim().toLowerCase()}`;
  const rendered = buildTrialRejectedTemplate(data);

  return sendEmail({
    to: data.userEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    eventType: 'trial_rejected',
    referenceId: refId,
    userId: data.userId
  });
};

// 8. VPN Expiring Email (3 days / 2 days / 1 day)
export const sendExpiryReminderEmail = async (data: {
  userEmail: string;
  customerName?: string;
  vpnAccountId?: string;
  packageName: string;
  daysLeft: number;
  expiryDate?: string;
  userId?: string;
}) => {
  const expiryKey = data.expiryDate ? new Date(data.expiryDate).toISOString().slice(0, 10) : 'cycle';
  const refId = `${data.vpnAccountId || data.userEmail}_expiring_${data.daysLeft}d_${expiryKey}`;
  const rendered = buildExpiryReminderTemplate(data);

  return sendEmail({
    to: data.userEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
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
  const expiryKey = data.expiryDate ? new Date(data.expiryDate).toISOString().slice(0, 10) : 'current';
  const refId = `${data.vpnAccountId || data.userEmail}_expired_${expiryKey}`;
  const rendered = buildVpnExpiredTemplate(data);

  return sendEmail({
    to: data.userEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
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
  replyId?: string;
  userId?: string;
}) => {
  const refId = data.replyId ? `reply_${data.ticketId}_${data.replyId}` : `reply_${data.ticketId}_${Buffer.from(data.replyMessage.slice(0, 48)).toString('base64')}`;
  const rendered = buildSupportReplyTemplate(data);

  return sendEmail({
    to: data.userEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    eventType: 'support_reply',
    referenceId: refId,
    userId: data.userId
  });
};

// 11. Live Chat Reply Email
export const sendLiveChatReplyEmail = async (data: {
  userEmail: string;
  customerName?: string;
  chatMessage: string;
  messageId?: string;
  userId?: string;
}) => {
  const refId = data.messageId || `chat_${data.userEmail.trim().toLowerCase()}_${Buffer.from(data.chatMessage.slice(0, 48)).toString('base64')}`;
  const rendered = buildLiveChatReplyTemplate(data);

  return sendEmail({
    to: data.userEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    eventType: 'livechat_reply',
    referenceId: refId,
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
  const refId = `announcement_${data.userEmail.trim().toLowerCase()}_${Buffer.from(data.announcementTitle.slice(0, 32)).toString('base64')}`;
  const rendered = buildMaintenanceAnnouncementTemplate(data);

  return sendEmail({
    to: data.userEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    eventType: 'maintenance_announcement',
    referenceId: refId,
    userId: data.userId
  });
};

// Safe backend-only single-recipient test email function (never sends to all customers)
export const sendSingleTestEmail = async (recipientEmail: string, userId?: string): Promise<SendEmailResult> => {
  const cleanRecipient = (recipientEmail || '').trim();
  if (!cleanRecipient || !cleanRecipient.includes('@') || cleanRecipient.includes(',')) {
    return {
      success: false,
      accepted: false,
      error: 'A single valid test recipient email address is required.'
    };
  }

  const sender = await resolveVerifiedSender();
  const rendered = buildSystemTestEmailTemplate({
    recipientEmail: cleanRecipient,
    senderFormatted: sender.formatted || DEFAULT_SENDER_FORMATTED
  });

  return sendEmail({
    to: cleanRecipient,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    eventType: 'test_email',
    referenceId: `test_${Date.now()}`,
    userId
  });
};
