import { supabaseAdmin } from '../../lib/supabase.js';

export interface RenewNotificationData {
  email?: string;
  userEmail?: string;
  planName?: string;
  plan?: string;
  durationMonths?: number | string;
  duration?: number | string;
  amount?: number | string;
  receiptNumber?: string;
  message?: string;
  paymentDate?: string;
}

export interface RenewApprovedNotificationData {
  email?: string;
  userEmail?: string;
  planName?: string;
  plan?: string;
  durationMonths?: number | string;
  duration?: number | string;
  new_expiry?: string | number | Date;
  approved_at?: string | number | Date;
}

const formatDateTime = (val: any): string => {
  if (!val) return 'N/A';
  if (val instanceof Date) {
    return val.toISOString().replace('T', ' ').substring(0, 19);
  }
  const num = Number(val);
  if (!isNaN(num) && num > 1000000000) {
    return new Date(num).toISOString().replace('T', ' ').substring(0, 19);
  }
  const dateObj = new Date(String(val));
  if (!isNaN(dateObj.getTime())) {
    return dateObj.toISOString().replace('T', ' ').substring(0, 19);
  }
  return String(val);
};

export const sendRenewNotification = async (data: RenewNotificationData): Promise<void> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.warn('[TelegramService] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing. Skipping Telegram notification.');
    return;
  }

  const email = data.email || data.userEmail || 'N/A';
  const planName = data.planName || data.plan || 'N/A';
  const durationMonths = data.durationMonths || data.duration || 1;
  const amount = data.amount !== undefined && data.amount !== null ? data.amount : '0';
  const receiptNumber = data.receiptNumber || 'N/A';
  const message = data.message && data.message.trim() ? data.message.trim() : 'None';
  const paymentDate = data.paymentDate || 'N/A';

  const text = `🔔 FIREVPNs

New Renewal Request

👤 Customer:
${email}

📦 Plan:
${planName}

📅 Duration:
${durationMonths} Month(s)

💰 Amount:
LKR ${amount}

🧾 Receipt:
${receiptNumber}

💬 Message:
${message}

🕒 Date:
${paymentDate}`;

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[TelegramService] Telegram API error (${response.status}):`, errText);
    } else {
    }
  } catch (err: any) {
    console.error('[TelegramService] Failed to send Telegram notification:', err?.message || err);
  }
};

export const sendRenewApprovedNotification = async (data: RenewApprovedNotificationData): Promise<void> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.warn('[TelegramService] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing. Skipping Telegram approved notification.');
    return;
  }

  const email = data.email || data.userEmail || 'N/A';
  const planName = data.planName || data.plan || 'N/A';
  const durationMonths = data.durationMonths || data.duration || 1;
  const new_expiry = formatDateTime(data.new_expiry);
  const approved_at = formatDateTime(data.approved_at);

  const text = `✅ FIREVPNs

Renewal Approved

👤 Customer:
${email}

📦 Plan:
${planName}

📅 Duration:
${durationMonths} Month(s)

📆 New Expiry:
${new_expiry}

🕒 Approved:
${approved_at}

✅ 3X-UI Updated Successfully`;

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[TelegramService] Telegram API error (${response.status}):`, errText);
    } else {
    }
  } catch (err: any) {
    console.error('[TelegramService] Failed to send Telegram approved notification:', err?.message || err);
  }
};

export interface SupportTicketNotificationData {
  ticketId?: string;
  customerName?: string;
  email?: string;
  category?: string;
  priority?: string;
  subject?: string;
  message?: string;
  time?: string;
}

export const sendNewSupportTicketNotification = async (data: SupportTicketNotificationData): Promise<void> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.warn('[TelegramService] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing. Skipping Telegram new support ticket notification.');
    return;
  }

  const ticketId = data.ticketId || 'N/A';
  const customer = data.customerName || 'N/A';
  const email = data.email || 'N/A';
  const category = data.category || 'N/A';
  const priority = data.priority || 'N/A';
  const subject = data.subject || 'N/A';
  const message = data.message || 'N/A';
  
  let currentDateTime = data.time;
  if (!currentDateTime) {
    try {
      currentDateTime = new Date().toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
    } catch (e) {
      currentDateTime = 'N/A';
    }
  }

  const text = `🎫 New Support Ticket

Ticket ID: ${ticketId}
Customer: ${customer}
Email: ${email}
Category: ${category}
Priority: ${priority}
Subject: ${subject}

Message:
${message}

Time:
${currentDateTime}

🔗 Admin Support Page: https://firevpns.com/admin/support`;

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[TelegramService] Telegram API error (${response.status}):`, errText);
    } else {
    }
  } catch (err: any) {
    console.error('[TelegramService] Failed to send Telegram new support ticket notification:', err?.message || err);
  }
};

export interface OrderNotificationData {
  orderId?: string;
  orderDocId?: string;
  customerName?: string;
  email?: string;
  plan?: string;
  server?: string;
  duration?: string;
  packageType?: string;
  amount?: number | string;
  originalPrice?: number | string;
  discountAmount?: number | string;
  finalPrice?: number | string;
  paymentMethod?: string;
  transactionRef?: string;
  paymentDate?: string;
  paymentTime?: string;
  slipUrl?: string;
  slipName?: string;
  notes?: string;
  status?: string;
}

interface StoredTelegramOrderMessage {
  chatId: string;
  messageId: number;
  text: string;
}

const orderTelegramMessageCache = new Map<string, StoredTelegramOrderMessage>();
const inFlightTelegramOrderActions = new Set<string>();

const formatColomboTimestamp = (): string => {
  try {
    return new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Colombo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  } catch {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
  }
};

const resolvePaymentSlipSummaryForTelegram = async (data: OrderNotificationData): Promise<string> => {
  const lines: string[] = [];
  const rawSlip = String(data.slipUrl || '').trim();
  const txRef = String(data.transactionRef || '').trim();
  const payDate = String(data.paymentDate || '').trim();
  const payTime = String(data.paymentTime || '').trim();
  const notes = String(data.notes || '').trim();

  if (rawSlip) {
    if (rawSlip.startsWith('data:')) {
      lines.push('Receipt: Uploaded (Inline Receipt Attached)');
    } else if (/^https?:\/\//i.test(rawSlip) && rawSlip.length <= 600) {
      lines.push('Receipt: Uploaded');
      lines.push(`Slip Link: ${rawSlip}`);
    } else {
      // Storage path like "payment-slips/orders/..."
      let bucket = 'payment-slips';
      let objectPath = rawSlip.replace(/^\/+/, '');
      if (objectPath.startsWith('payment-slips/')) {
        objectPath = objectPath.slice('payment-slips/'.length);
      } else if (objectPath.startsWith('payment_slips/')) {
        bucket = 'payment_slips';
        objectPath = objectPath.slice('payment_slips/'.length);
      }
      let signedLink = '';
      try {
        const { data: signedData } = await supabaseAdmin.storage
          .from(bucket)
          .createSignedUrl(objectPath, 86400);
        if (signedData?.signedUrl && signedData.signedUrl.length <= 600) {
          signedLink = signedData.signedUrl;
        }
      } catch {
        // Fallback to path summary
      }
      if (signedLink) {
        lines.push('Receipt: Uploaded');
        lines.push(`Slip Link: ${signedLink}`);
      } else {
        lines.push(`Receipt: Uploaded (${data.slipName || objectPath || 'Attached'})`);
      }
    }
  } else {
    lines.push('Receipt: Not Uploaded');
  }

  if (txRef && txRef !== 'N/A') {
    lines.push(`Reference: ${txRef}`);
  }
  if (payDate && payDate !== 'N/A') {
    lines.push(`Payment Date: ${payDate}${payTime ? ` ${payTime}` : ''}`);
  }
  if (notes) {
    lines.push(`Notes: ${notes}`);
  }

  return lines.join('\n');
};

export const sendNewOrderNotification = async (data: OrderNotificationData): Promise<void> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.warn('[TelegramService] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing. Skipping Telegram new order notification.');
    return;
  }

  const email = data.email || 'N/A';
  const customerName =
    (data.customerName && data.customerName.trim()) ||
    (email !== 'N/A' && email.includes('@') ? email.split('@')[0] : 'Customer');
  const plan = data.plan || 'N/A';
  const server = data.server || 'N/A';
  const duration = data.duration || 'N/A';
  const packageType = data.packageType || 'N/A';
  const amount = data.amount !== undefined && data.amount !== null ? data.amount : '0';
  const orderId = data.orderId || data.orderDocId || 'N/A';
  const paymentMethod =
    (data.paymentMethod && data.paymentMethod.trim()) ||
    'Bank Transfer (Commercial Bank - G.K Nimesha, Ganemulla)';
  const currentStatus =
    (data.status && data.status.trim()) || 'Pending Verification';

  const priceStr =
    typeof amount === 'number'
      ? amount.toLocaleString()
      : Number(amount).toLocaleString();

  const currentDateTime = formatColomboTimestamp();
  const slipInfoBlock = await resolvePaymentSlipSummaryForTelegram(data);

  const text = `🛒 NEW FIREVPNs ORDER

━━━━━━━━━━━━━━━━━━

🆔 Order ID
${orderId}

👤 Customer
Name: ${customerName}
Email: ${email}

📦 Package
Package Name: ${plan}
Package Type: ${packageType}
Server: ${server}
Duration: ${duration}

💰 Package Price
LKR ${priceStr}

💳 Payment Method
${paymentMethod}

🧾 Payment Slip Info
${slipInfoBlock}

━━━━━━━━━━━━━━━━━━

🕒 Order Time
${currentDateTime}

Status:
🟡 ${currentStatus}`;

  const callbackOrderId = String(
    data.orderId && data.orderId !== 'N/A'
      ? data.orderId
      : data.orderDocId || ''
  ).trim();

  // Telegram callback_data must be <= 64 bytes
  const canAttachInlineButtons =
    Boolean(callbackOrderId) &&
    callbackOrderId !== 'N/A' &&
    Buffer.byteLength(`approve_order:${callbackOrderId}`, 'utf8') <= 64 &&
    Buffer.byteLength(`reject_order:${callbackOrderId}`, 'utf8') <= 64;

  const replyMarkup = canAttachInlineButtons
    ? {
        inline_keyboard: [
          [
            {
              text: '✓ Approve Order',
              callback_data: `approve_order:${callbackOrderId}`,
            },
            {
              text: '✕ Reject Order',
              callback_data: `reject_order:${callbackOrderId}`,
            },
          ],
        ],
      }
    : undefined;

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const payload: Record<string, any> = {
      chat_id: chatId,
      text: text,
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[TelegramService] Telegram API error (${response.status}):`, errText);
      return;
    }

    const resJson: any = await response.json().catch(() => null);
    const sentMsg = resJson?.result;
    if (sentMsg?.message_id && sentMsg?.chat?.id) {
      const storedMsg: StoredTelegramOrderMessage = {
        chatId: String(sentMsg.chat.id),
        messageId: Number(sentMsg.message_id),
        text,
      };
      if (data.orderId && data.orderId !== 'N/A') {
        orderTelegramMessageCache.set(String(data.orderId).trim(), storedMsg);
      }
      if (data.orderDocId) {
        orderTelegramMessageCache.set(String(data.orderDocId).trim(), storedMsg);
      }

      // Persist tg_chat_id and tg_message_id into order.payment_method JSON metadata so website approvals can also edit the Telegram message
      const lookupCol = data.orderDocId ? 'id' : 'order_id';
      const lookupVal = data.orderDocId || data.orderId;
      if (lookupVal && lookupVal !== 'N/A') {
        try {
          const { data: ordRow } = await supabaseAdmin
            .from('orders')
            .select('id, order_id, payment_method')
            .eq(lookupCol, lookupVal)
            .maybeSingle();
          if (ordRow) {
            if (ordRow.id) orderTelegramMessageCache.set(String(ordRow.id), storedMsg);
            if (ordRow.order_id) orderTelegramMessageCache.set(String(ordRow.order_id), storedMsg);
            let extra: any = {};
            if (typeof ordRow.payment_method === 'string' && ordRow.payment_method.startsWith('{')) {
              try {
                extra = JSON.parse(ordRow.payment_method);
              } catch {
                extra = {};
              }
            }
            extra.tg_chat_id = storedMsg.chatId;
            extra.tg_message_id = storedMsg.messageId;
            await supabaseAdmin
              .from('orders')
              .update({ payment_method: JSON.stringify(extra) })
              .eq('id', ordRow.id);
          }
        } catch {
          // Non-critical metadata update
        }
      }
    }
  } catch (err: any) {
    console.error('[TelegramService] Failed to send Telegram new order notification:', err?.message || err);
  }
};

export interface OrderApprovedNotificationData {
  customerEmail?: string;
  email?: string;
  packageName?: string;
  package?: string;
  plan?: string;
  packageType?: string;
  server?: string;
  duration?: string;
  price?: number | string;
  amount?: number | string;
  uuid?: string;
  orderId?: string;
  status?: string;
}

export const sendOrderApprovedNotification = async (data: OrderApprovedNotificationData): Promise<void> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.warn('[TelegramService] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing. Skipping Telegram order approved notification.');
    return;
  }

  const customerEmail = data.customerEmail || data.email || 'N/A';
  const packageName = data.packageName || data.package || data.plan || 'N/A';
  const packageType = data.packageType || 'SIM Unlimited';
  const server = data.server || 'N/A';
  const duration = data.duration || 'N/A';
  const rawPrice = data.price !== undefined ? data.price : (data.amount !== undefined ? data.amount : 0);
  const priceStr = typeof rawPrice === 'number' ? rawPrice.toLocaleString() : Number(rawPrice).toLocaleString();
  const uuid = data.uuid || 'N/A';
  const orderId = data.orderId || 'N/A';

  const text = `✅ FIREVPNs ORDER APPROVED

━━━━━━━━━━━━━━━━━━━━

👤 Customer
${customerEmail}

📦 Package
${packageName}

📡 Package Type
${packageType}

🌍 Server
${server}

📅 Duration
${duration}

💰 Amount
LKR ${priceStr}

━━━━━━━━━━━━━━━━━━━━

🔑 VPN Created Successfully

UUID:
${uuid}

━━━━━━━━━━━━━━━━━━━━

Order ID:
${orderId}

Status:
🟢 COMPLETED

VPN has been generated successfully.`;

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[TelegramService] Telegram API error (${response.status}):`, errText);
    } else {
    }
  } catch (err: any) {
    console.error('[TelegramService] Failed to send Telegram order approved notification:', err?.message || err);
  }
};

export interface TrialRequestNotificationData {
  customerName?: string;
  email?: string;
  packageName?: string;
  templateName?: string;
  trialLimits?: string;
  requestTime?: string;
  requestId?: string;
}

export const sendTrialRequestNotification = async (data: TrialRequestNotificationData): Promise<any> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    const errorMsg = 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing from backend environment variables.';
    console.warn(`[TelegramService] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  const customerName = data.customerName || 'N/A';
  const email = data.email || 'N/A';
  const packageName = data.packageName || 'N/A';
  const templateName = data.templateName || 'N/A';
  const trialLimits = data.trialLimits || '1 GB / 1 Day';
  const requestId = data.requestId || 'N/A';

  let currentDateTime = data.requestTime;
  if (!currentDateTime) {
    try {
      currentDateTime = new Date().toLocaleString('en-US', {
        timeZone: 'Asia/Colombo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });
    } catch (e) {
      currentDateTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
    }
  }

  const text = `🎁 NEW FREE TRIAL REQUEST

━━━━━━━━━━━━━━━━━━━━

👤 Customer Name
${customerName}

✉️ Customer Email
${email}

📦 Package Name
${packageName}

📑 Template Name
${templateName}

⚡ Trial Limits
${trialLimits}

🕒 Request Time
${currentDateTime}

🆔 Request ID
${requestId}

━━━━━━━━━━━━━━━━━━━━

Status:
🟡 Pending Admin Approval`;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
  };

  console.log('[TelegramService] Sending Free Trial Telegram notification for request:', requestId);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify(payload),
    });

    const resBody = await response.text();

    if (!response.ok) {
      const errText = `Telegram API Error (Status ${response.status}): ${resBody}`;
      console.error(`[TelegramService] ${redactTelegramSecrets(errText)}`);
      throw new Error(`Telegram API Error (Status ${response.status})`);
    }

    return { status: response.status, body: resBody };
  } catch (err: any) {
    console.error(
      '[TelegramService] Exception occurred in sendTrialRequestNotification:',
      redactTelegramSecrets(err?.message || err)
    );
    throw err;
  }
};

export interface OrderRejectedNotificationData {
  customerEmail?: string;
  email?: string;
  reason?: string;
}

export const sendOrderRejectedNotification = async (data: OrderRejectedNotificationData): Promise<void> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.warn('[TelegramService] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing. Skipping Telegram order rejected notification.');
    return;
  }

  const email = data.customerEmail || data.email || 'N/A';
  const reason = data.reason || 'Payment verification failed.';

  const text = `❌ Order Rejected

Customer:
${email}

Reason:
${reason}`;

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[TelegramService] Telegram API error (${response.status}):`, errText);
    } else {
    }
  } catch (err: any) {
    console.error('[TelegramService] Failed to send Telegram order rejected notification:', err?.message || err);
  }
};



export const escapeTelegramHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const redactTelegramSecrets = (value: unknown): string =>
  String(value ?? '').replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]');

export interface LiveChatNotificationData {
  customerEmail: string;
  customerName?: string;
  message: string;
}

export const sendLiveChatNotification = async (data: LiveChatNotificationData): Promise<void> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.warn('[TelegramService] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing. Skipping Telegram live chat notification.');
    return;
  }

  const customer = escapeTelegramHtml(data.customerName || data.customerEmail.split('@')[0] || 'Unknown');
  const email = escapeTelegramHtml(data.customerEmail || 'N/A');
  const msg = escapeTelegramHtml(data.message || '');

  const telegramMessage = `🔥 <b>FIREVPNs — New Live Chat</b>

👤 <b>Customer:</b> ${customer} (${email})

💬 <b>Message:</b>
"${msg}"

<i>Open the Admin Panel to reply.</i>`;

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        chat_id: chatId,
        text: telegramMessage,
        parse_mode: 'HTML',
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[TelegramService] Telegram API error (${response.status}):`, errText);
    }
  } catch (err: any) {
    console.error('[TelegramService] Failed to send Telegram live chat notification:', err?.message || err);
  }
};

// ============================================================================
// TELEGRAM INLINE BUTTON CALLBACK HANDLING, SECURITY & POLLING
// ============================================================================

export interface TelegramAdminAuditLogEntry {
  adminId: string | number;
  adminUsername?: string;
  orderId: string;
  action: 'APPROVE_ORDER' | 'REJECT_ORDER' | 'UNAUTHORIZED_ATTEMPT' | 'INVALID_CALLBACK';
  outcome: string;
  timestamp: string;
}

const logTelegramAdminAction = (entry: TelegramAdminAuditLogEntry): void => {
  console.log(
    `[TelegramAdminAudit] timestamp="${entry.timestamp}" adminId="${entry.adminId}" adminUsername="${entry.adminUsername || 'N/A'}" orderId="${entry.orderId}" action="${entry.action}" outcome="${entry.outcome}"`
  );
};

export const answerTelegramCallbackQuery = async (
  callbackQueryId: string,
  text?: string,
  showAlert = false
): Promise<void> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !callbackQueryId) return;

  try {
    const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(6000),
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text ? String(text).slice(0, 195) : undefined,
        show_alert: showAlert,
      }),
    });
  } catch (err: any) {
    console.warn('[TelegramService] Failed to answerCallbackQuery:', err?.message || err);
  }
};

const removeTelegramMessageInlineKeyboard = async (
  chatId: string | number,
  messageId: number
): Promise<void> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !chatId || !messageId) return;

  try {
    const url = `https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(6000),
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }),
    });
  } catch {
    // Ignore if already removed
  }
};

const buildUpdatedOrderTelegramText = (
  originalText: string | undefined,
  order: any,
  finalStatus: 'APPROVED' | 'REJECTED',
  meta?: { adminLabel?: string; uuid?: string; reason?: string; timestamp?: string }
): string => {
  const timestamp = meta?.timestamp || formatColomboTimestamp();
  const adminLabel = meta?.adminLabel || 'Authorized Admin';
  const statusSection =
    finalStatus === 'APPROVED'
      ? `Status:\n🟢 APPROVED\n✅ Processed By: ${adminLabel}${meta?.uuid ? `\n🔑 VPN UUID: ${meta.uuid}` : ''}\n🕒 Updated At: ${timestamp}`
      : `Status:\n🔴 REJECTED\n❌ Processed By: ${adminLabel}${meta?.reason ? `\n📝 Reason: ${meta.reason}` : ''}\n🕒 Updated At: ${timestamp}`;

  if (originalText && originalText.trim()) {
    const statusIndex = originalText.lastIndexOf('Status:');
    if (statusIndex !== -1) {
      return `${originalText.substring(0, statusIndex).trimEnd()}\n\n${statusSection}`;
    }
    return `${originalText.trimEnd()}\n\n━━━━━━━━━━━━━━━━━━\n\n${statusSection}`;
  }

  // Fallback reconstruction if original message text wasn't cached
  let extra: any = {};
  if (typeof order?.payment_method === 'string' && order.payment_method.startsWith('{')) {
    try {
      extra = JSON.parse(order.payment_method);
    } catch {
      extra = {};
    }
  }
  const orderId = order?.order_id || order?.id || 'N/A';
  const email = order?.email || 'N/A';
  const customerName =
    extra?.configurationName ||
    extra?.customerName ||
    (email !== 'N/A' && email.includes('@') ? email.split('@')[0] : 'Customer');
  const plan = extra?.plan || order?.package_name || 'VPN Plan';
  const priceStr = Number(order?.amount || 0).toLocaleString();

  return `🛒 FIREVPNs ORDER

━━━━━━━━━━━━━━━━━━

🆔 Order ID
${orderId}

👤 Customer
Name: ${customerName}
Email: ${email}

📦 Package
Package Name: ${plan}

💰 Package Price
LKR ${priceStr}

━━━━━━━━━━━━━━━━━━

${statusSection}`;
};

export const editTelegramOrderMessage = async (params: {
  chatId: string | number;
  messageId: number;
  originalText?: string;
  order?: any;
  finalStatus: 'APPROVED' | 'REJECTED';
  adminLabel?: string;
  uuid?: string;
  reason?: string;
}): Promise<void> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !params.chatId || !params.messageId) return;

  const updatedText = buildUpdatedOrderTelegramText(
    params.originalText,
    params.order,
    params.finalStatus,
    {
      adminLabel: params.adminLabel,
      uuid: params.uuid,
      reason: params.reason,
      timestamp: formatColomboTimestamp(),
    }
  );

  try {
    const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        chat_id: params.chatId,
        message_id: params.messageId,
        text: updatedText,
        reply_markup: { inline_keyboard: [] },
      }),
    });

    if (!response.ok) {
      // Ensure inline buttons are still removed even if editMessageText had a minor warning
      await removeTelegramMessageInlineKeyboard(params.chatId, params.messageId);
    }
  } catch (err: any) {
    console.warn('[TelegramService] Failed to editTelegramOrderMessage:', err?.message || err);
    await removeTelegramMessageInlineKeyboard(params.chatId, params.messageId);
  }
};

export const syncOrderTelegramInlineMessage = async (
  orderIdentifier: string,
  finalStatus: 'APPROVED' | 'REJECTED',
  meta?: { adminLabel?: string; uuid?: string; reason?: string }
): Promise<void> => {
  if (!orderIdentifier) return;
  const cleanId = String(orderIdentifier).trim();
  let cached = orderTelegramMessageCache.get(cleanId);
  let orderRow: any = null;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId);
  try {
    if (isUuid) {
      const { data } = await supabaseAdmin
        .from('orders')
        .select('*')
        .or(`id.eq.${cleanId},order_id.eq.${cleanId}`)
        .maybeSingle();
      orderRow = data;
    } else {
      const { data } = await supabaseAdmin
        .from('orders')
        .select('*')
        .eq('order_id', cleanId)
        .maybeSingle();
      orderRow = data;
    }
  } catch {
    // Ignore DB lookup failure during sync
  }

  if (!cached && orderRow) {
    cached =
      orderTelegramMessageCache.get(String(orderRow.id || '')) ||
      orderTelegramMessageCache.get(String(orderRow.order_id || ''));

    if (!cached && typeof orderRow.payment_method === 'string' && orderRow.payment_method.startsWith('{')) {
      try {
        const extra = JSON.parse(orderRow.payment_method);
        if (extra?.tg_chat_id && extra?.tg_message_id) {
          cached = {
            chatId: String(extra.tg_chat_id),
            messageId: Number(extra.tg_message_id),
            text: '',
          };
        }
      } catch {
        // Ignore parse error
      }
    }
  }

  if (!cached || !cached.chatId || !cached.messageId) return;

  await editTelegramOrderMessage({
    chatId: cached.chatId,
    messageId: cached.messageId,
    originalText: cached.text || undefined,
    order: orderRow,
    finalStatus,
    adminLabel: meta?.adminLabel,
    uuid: meta?.uuid || orderRow?.client_uuid,
    reason: meta?.reason,
  });
};

/**
 * Verifies whether a Telegram user ID is an authorized FIREVPNs administrator.
 * Checks TELEGRAM_ADMIN_IDS, TELEGRAM_ADMIN_ID, and TELEGRAM_CHAT_ID.
 * If TELEGRAM_CHAT_ID is a group/supergroup chat (negative ID) and no explicit TELEGRAM_ADMIN_IDS
 * list is provided, verifies that the callback came from that group chat AND that the user is
 * a 'creator' or 'administrator' of that chat via Telegram's getChatMember API.
 */
export const verifyTelegramAdminAuthorization = async (
  fromUserId: string | number | undefined,
  messageChatId?: string | number | undefined
): Promise<{ authorized: boolean; reason?: string }> => {
  if (fromUserId === undefined || fromUserId === null || String(fromUserId).trim() === '') {
    return { authorized: false, reason: 'Missing Telegram user ID' };
  }

  const normalizedUserId = String(fromUserId).trim();
  const normalizedMessageChatId = messageChatId !== undefined && messageChatId !== null ? String(messageChatId).trim() : '';
  const configuredChatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  const rawAdminIdsEnv = [
    process.env.TELEGRAM_ADMIN_IDS || '',
    process.env.TELEGRAM_ADMIN_ID || '',
  ]
    .join(',')
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);

  const allowedUserIds = new Set<string>(rawAdminIdsEnv);

  // If TELEGRAM_CHAT_ID is a positive integer, it represents the admin's direct Telegram user ID
  if (configuredChatId && !configuredChatId.startsWith('-')) {
    allowedUserIds.add(configuredChatId);
  }

  if (allowedUserIds.has(normalizedUserId)) {
    return { authorized: true };
  }

  // If explicit TELEGRAM_ADMIN_IDS were configured and user is not in them, deny immediately
  if (rawAdminIdsEnv.length > 0) {
    return {
      authorized: false,
      reason: `Telegram user ${normalizedUserId} is not in TELEGRAM_ADMIN_IDS`,
    };
  }

  // If TELEGRAM_CHAT_ID is a negative group/channel ID and no explicit TELEGRAM_ADMIN_IDS are set,
  // verify the callback originated in TELEGRAM_CHAT_ID and the user is a chat administrator/creator.
  if (
    configuredChatId &&
    configuredChatId.startsWith('-') &&
    normalizedMessageChatId === configuredChatId
  ) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return { authorized: false, reason: 'Bot token unavailable for group admin check' };
    }
    try {
      const url = `https://api.telegram.org/bot${botToken}/getChatMember`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(6000),
        body: JSON.stringify({
          chat_id: configuredChatId,
          user_id: Number(normalizedUserId),
        }),
      });
      if (res.ok) {
        const json: any = await res.json().catch(() => null);
        const memberStatus = String(json?.result?.status || '').toLowerCase();
        if (memberStatus === 'creator' || memberStatus === 'administrator') {
          return { authorized: true };
        }
      }
    } catch (err: any) {
      console.warn('[TelegramService] getChatMember verification error:', err?.message || err);
    }
  }

  return {
    authorized: false,
    reason: `Telegram user ${normalizedUserId} is not an authorized administrator`,
  };
};

const fetchOrderFromSupabaseForTelegram = async (rawOrderId: string): Promise<any | null> => {
  const cleanId = String(rawOrderId || '').trim();
  if (!cleanId) return null;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId);
  if (isUuid) {
    const { data } = await supabaseAdmin
      .from('orders')
      .select('*')
      .or(`id.eq.${cleanId},order_id.eq.${cleanId}`)
      .maybeSingle();
    if (data) return data;
  }

  const { data: byOrderId } = await supabaseAdmin
    .from('orders')
    .select('*')
    .eq('order_id', cleanId)
    .maybeSingle();

  return byOrderId || null;
};

export const handleTelegramCallbackQuery = async (callbackQuery: any): Promise<void> => {
  if (!callbackQuery || !callbackQuery.id) return;

  const callbackQueryId = String(callbackQuery.id);
  const fromUser = callbackQuery.from || {};
  const fromUserId = fromUser.id;
  const fromUsername =
    fromUser.username
      ? `@${fromUser.username}`
      : [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ') || String(fromUserId || 'Admin');
  const message = callbackQuery.message || {};
  const messageId = Number(message.message_id || 0);
  const messageChatId = message?.chat?.id;
  const originalMessageText = typeof message.text === 'string' ? message.text : undefined;
  const rawCallbackData = String(callbackQuery.data || '').trim();
  const timestamp = new Date().toISOString();

  // Parse callback_data: "approve_order:<orderId>" or "reject_order:<orderId>"
  const match = rawCallbackData.match(/^(approve_order|reject_order|approve|reject):([A-Za-z0-9_-]{1,50})$/);
  if (!match) {
    logTelegramAdminAction({
      adminId: fromUserId || 'unknown',
      adminUsername: fromUsername,
      orderId: rawCallbackData || 'invalid',
      action: 'INVALID_CALLBACK',
      outcome: 'IGNORED_MALFORMED_CALLBACK_DATA',
      timestamp,
    });
    await answerTelegramCallbackQuery(callbackQueryId, '⚠️ Unsupported or invalid button action.', true);
    return;
  }

  const actionVerb = match[1].startsWith('approve') ? 'APPROVE_ORDER' : 'REJECT_ORDER';
  const targetOrderId = match[2].trim();

  // 1. Verify Admin Authorization FIRST before trusting orderId or performing any DB query
  const authCheck = await verifyTelegramAdminAuthorization(fromUserId, messageChatId);
  if (!authCheck.authorized) {
    logTelegramAdminAction({
      adminId: fromUserId || 'unknown',
      adminUsername: fromUsername,
      orderId: targetOrderId,
      action: 'UNAUTHORIZED_ATTEMPT',
      outcome: `DENIED: ${authCheck.reason || 'Unauthorized user'}`,
      timestamp,
    });
    await answerTelegramCallbackQuery(
      callbackQueryId,
      '⛔ Unauthorized: Only authorized FIREVPNs administrators can approve or reject orders.',
      true
    );
    return;
  }

  // 2. Prevent duplicate concurrent processing on rapid double-clicks
  if (inFlightTelegramOrderActions.has(targetOrderId)) {
    await answerTelegramCallbackQuery(
      callbackQueryId,
      '⏳ This order is currently being processed. Please wait...',
      false
    );
    return;
  }

  inFlightTelegramOrderActions.add(targetOrderId);
  let lockedDbId = '';
  let lockedCanonicalOrderId = '';

  try {
    // 3. Verify that the order exists in Supabase
    const order = await fetchOrderFromSupabaseForTelegram(targetOrderId);
    if (!order) {
      logTelegramAdminAction({
        adminId: fromUserId,
        adminUsername: fromUsername,
        orderId: targetOrderId,
        action: actionVerb,
        outcome: 'ORDER_NOT_FOUND',
        timestamp,
      });
      await answerTelegramCallbackQuery(
        callbackQueryId,
        `⚠️ Order "${targetOrderId}" no longer exists in the database.`,
        true
      );
      if (messageChatId && messageId) {
        await removeTelegramMessageInlineKeyboard(messageChatId, messageId);
      }
      return;
    }

    lockedDbId = String(order.id || '');
    lockedCanonicalOrderId = String(order.order_id || order.id || targetOrderId);

    if (
      (lockedDbId && lockedDbId !== targetOrderId && inFlightTelegramOrderActions.has(lockedDbId)) ||
      (lockedCanonicalOrderId &&
        lockedCanonicalOrderId !== targetOrderId &&
        inFlightTelegramOrderActions.has(lockedCanonicalOrderId))
    ) {
      await answerTelegramCallbackQuery(
        callbackQueryId,
        '⏳ This order is currently being processed. Please wait...',
        false
      );
      return;
    }

    if (lockedDbId) inFlightTelegramOrderActions.add(lockedDbId);
    if (lockedCanonicalOrderId) inFlightTelegramOrderActions.add(lockedCanonicalOrderId);

    // 4. Verify that the order is still pending and has not already been approved, rejected, or expired
    const statusLower = String(order.status || '').toLowerCase().trim();
    const paymentStatusLower = String(order.payment_status || '').toLowerCase().trim();

    // Check if an active VPN configuration already exists for this order to prevent duplicate provisioning
    let existingVpnConfig: any = null;
    try {
      const { data: cfgData } = await supabaseAdmin
        .from('vpn_configs')
        .select('id, uuid, vless_link, vless_url, status')
        .eq('order_id', order.id)
        .maybeSingle();
      existingVpnConfig = cfgData;
    } catch {
      // Ignore lookup warning
    }

    const isAlreadyApproved =
      statusLower === 'completed' ||
      statusLower === 'active' ||
      statusLower === 'approved' ||
      Boolean(order.vless_url) ||
      Boolean(existingVpnConfig?.vless_link || existingVpnConfig?.vless_url || existingVpnConfig?.uuid);

    if (isAlreadyApproved) {
      logTelegramAdminAction({
        adminId: fromUserId,
        adminUsername: fromUsername,
        orderId: lockedCanonicalOrderId,
        action: actionVerb,
        outcome: 'SKIPPED_ALREADY_APPROVED',
        timestamp,
      });
      await answerTelegramCallbackQuery(
        callbackQueryId,
        `ℹ️ Order #${lockedCanonicalOrderId} has already been APPROVED.`,
        true
      );
      if (messageChatId && messageId) {
        await editTelegramOrderMessage({
          chatId: messageChatId,
          messageId,
          originalText: originalMessageText,
          order,
          finalStatus: 'APPROVED',
          adminLabel: 'Already Approved',
          uuid: order.client_uuid || existingVpnConfig?.uuid,
        });
      }
      return;
    }

    const isAlreadyRejectedOrExpired =
      statusLower === 'rejected' ||
      statusLower === 'cancelled' ||
      statusLower === 'expired' ||
      paymentStatusLower === 'rejected' ||
      paymentStatusLower === 'cancelled';

    if (isAlreadyRejectedOrExpired) {
      const label = statusLower === 'expired' ? 'EXPIRED' : 'REJECTED';
      logTelegramAdminAction({
        adminId: fromUserId,
        adminUsername: fromUsername,
        orderId: lockedCanonicalOrderId,
        action: actionVerb,
        outcome: `SKIPPED_ALREADY_${label}`,
        timestamp,
      });
      await answerTelegramCallbackQuery(
        callbackQueryId,
        `ℹ️ Order #${lockedCanonicalOrderId} has already been ${label}.`,
        true
      );
      if (messageChatId && messageId) {
        await editTelegramOrderMessage({
          chatId: messageChatId,
          messageId,
          originalText: originalMessageText,
          order,
          finalStatus: 'REJECTED',
          adminLabel: `Already ${label}`,
        });
      }
      return;
    }

    const adminDisplayLabel = `${fromUsername} (ID: ${fromUserId})`;

    // 5. Execute Approve Order or Reject Order using existing backend workflow
    if (actionVerb === 'APPROVE_ORDER') {
      // Answer callback query promptly so Telegram button stops spinning during 3X-UI provisioning
      await answerTelegramCallbackQuery(
        callbackQueryId,
        `⏳ Approving order #${lockedCanonicalOrderId} & provisioning VPN...`,
        false
      );

      const { executeOrderApproval } = await import('../controllers/adminController.js');
      const result = await executeOrderApproval(order.id, undefined, {
        adminLabel: `Telegram Admin ${adminDisplayLabel}`,
      });

      if (messageChatId && messageId) {
        await editTelegramOrderMessage({
          chatId: messageChatId,
          messageId,
          originalText: originalMessageText,
          order,
          finalStatus: 'APPROVED',
          adminLabel: `Telegram Admin ${adminDisplayLabel}`,
          uuid: result?.uuid || order.client_uuid,
        });
      }

      logTelegramAdminAction({
        adminId: fromUserId,
        adminUsername: fromUsername,
        orderId: lockedCanonicalOrderId,
        action: 'APPROVE_ORDER',
        outcome: `SUCCESS (uuid=${result?.uuid || 'N/A'})`,
        timestamp,
      });
    } else {
      // REJECT_ORDER
      const { executeOrderRejection } = await import('../controllers/adminController.js');
      await executeOrderRejection(order.id, 'Rejected by Admin via Telegram', {
        adminLabel: `Telegram Admin ${adminDisplayLabel}`,
      });

      await answerTelegramCallbackQuery(
        callbackQueryId,
        `❌ Order #${lockedCanonicalOrderId} has been REJECTED.`,
        false
      );

      if (messageChatId && messageId) {
        await editTelegramOrderMessage({
          chatId: messageChatId,
          messageId,
          originalText: originalMessageText,
          order,
          finalStatus: 'REJECTED',
          adminLabel: `Telegram Admin ${adminDisplayLabel}`,
          reason: 'Rejected by Admin via Telegram',
        });
      }

      logTelegramAdminAction({
        adminId: fromUserId,
        adminUsername: fromUsername,
        orderId: lockedCanonicalOrderId,
        action: 'REJECT_ORDER',
        outcome: 'SUCCESS',
        timestamp,
      });
    }
  } catch (err: any) {
    const safeErrorMessage = String(err?.message || 'Unexpected processing error')
      .replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]')
      .slice(0, 160);

    logTelegramAdminAction({
      adminId: fromUserId || 'unknown',
      adminUsername: fromUsername,
      orderId: lockedCanonicalOrderId || targetOrderId,
      action: actionVerb,
      outcome: `ERROR: ${safeErrorMessage}`,
      timestamp,
    });

    await answerTelegramCallbackQuery(
      callbackQueryId,
      `⚠️ Action failed: ${safeErrorMessage}`,
      true
    );
  } finally {
    inFlightTelegramOrderActions.delete(targetOrderId);
    if (lockedDbId) inFlightTelegramOrderActions.delete(lockedDbId);
    if (lockedCanonicalOrderId) inFlightTelegramOrderActions.delete(lockedCanonicalOrderId);
  }
};

export const handleTelegramUpdate = async (update: any): Promise<void> => {
  if (!update || typeof update !== 'object') return;
  if (update.callback_query) {
    await handleTelegramCallbackQuery(update.callback_query);
  }
};

let telegramPollingInitialized = false;
let lastTelegramUpdateOffset = 0;

/**
 * Starts a resilient background polling worker for Telegram callback_query events
 * when TELEGRAM_BOT_TOKEN is configured and no active external webhook is registered
 * (or when TELEGRAM_USE_POLLING=true).
 */
export const startTelegramBotPolling = async (): Promise<void> => {
  if (telegramPollingInitialized) return;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return;
  }

  telegramPollingInitialized = true;

  try {
    // Check if an active webhook is already configured on the bot
    const infoUrl = `https://api.telegram.org/bot${botToken}/getWebhookInfo`;
    const infoRes = await fetch(infoUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(6000),
    });
    if (infoRes.ok) {
      const infoJson: any = await infoRes.json().catch(() => null);
      const activeWebhookUrl = String(infoJson?.result?.url || '').trim();
      if (activeWebhookUrl && process.env.TELEGRAM_USE_POLLING !== 'true') {
        console.log(
          '[TelegramService] Active Telegram webhook detected. Callback queries will be handled via /api/telegram/webhook.'
        );
        return;
      }
    }
  } catch {
    // Proceed with polling loop
  }

  console.log('[TelegramService] Starting background Telegram callback_query polling worker...');

  const pollNextUpdates = async () => {
    const currentBotToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!currentBotToken) {
      setTimeout(pollNextUpdates, 10000);
      return;
    }

    try {
      const url = `https://api.telegram.org/bot${currentBotToken}/getUpdates`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({
          offset: lastTelegramUpdateOffset > 0 ? lastTelegramUpdateOffset + 1 : undefined,
          timeout: 15,
          allowed_updates: ['callback_query'],
        }),
      });

      if (response.ok) {
        const json: any = await response.json().catch(() => null);
        const updates: any[] = Array.isArray(json?.result) ? json.result : [];
        for (const upd of updates) {
          if (typeof upd?.update_id === 'number' && upd.update_id > lastTelegramUpdateOffset) {
            lastTelegramUpdateOffset = upd.update_id;
          }
          if (upd?.callback_query) {
            await handleTelegramCallbackQuery(upd.callback_query);
          }
        }
        setTimeout(pollNextUpdates, 500);
        return;
      } else if (response.status === 409) {
        // Conflict: webhook is active or another instance is polling
        setTimeout(pollNextUpdates, 15000);
        return;
      }
    } catch {
      // Transient network timeout or abort
    }

    setTimeout(pollNextUpdates, 3000);
  };

  setTimeout(pollNextUpdates, 1500);
};

