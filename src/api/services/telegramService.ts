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
  email?: string;
  plan?: string;
  server?: string;
  duration?: string;
  packageType?: string;
  amount?: number | string;
  transactionRef?: string;
  paymentDate?: string;
  notes?: string;
  orderId?: string;
}

export const sendNewOrderNotification = async (data: OrderNotificationData): Promise<void> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.warn('[TelegramService] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing. Skipping Telegram new order notification.');
    return;
  }

  const email = data.email || 'N/A';
  const plan = data.plan || 'N/A';
  const server = data.server || 'N/A';
  const duration = data.duration || 'N/A';
  const packageType = data.packageType || 'N/A';
  const amount = data.amount !== undefined && data.amount !== null ? data.amount : '0';
  const orderId = data.orderId || 'N/A';

  const priceStr = typeof amount === 'number' ? amount.toLocaleString() : Number(amount).toLocaleString();

  let currentDateTime = '';
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

  const text = `🛒 NEW FIREVPNs ORDER

━━━━━━━━━━━━━━━━━━

👤 Customer
Email: ${email}

📦 Package
Package: ${plan}

📡 Package Type
${packageType}

🌍 Server
${server}

📅 Duration
${duration}

💰 Total Price
LKR ${priceStr}

━━━━━━━━━━━━━━━━━━

🏦 Bank Payment

Bank:
Commercial Bank

Account:
G.K Nimesha

Branch:
Ganemulla

━━━━━━━━━━━━━━━━━━

🕒 Order Time
${currentDateTime}

🆔 Order ID
${orderId}

━━━━━━━━━━━━━━━━━━

Status:
🟡 Waiting for Payment Verification`;

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
Key-Location: backend/src/api/services/telegramService.ts:492

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

  console.log('[TelegramService] Requesting Telegram URL:', url);
  console.log('[TelegramService] Telegram payload:', JSON.stringify(payload, null, 2));

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const resBody = await response.text();
    console.log('[TelegramService] Response status:', response.status);
    console.log('[TelegramService] Response body:', resBody);

    if (!response.ok) {
      const errText = `Telegram API Error (Status ${response.status}): ${resBody}`;
      console.error(`[TelegramService] ${errText}`);
      throw new Error(errText);
    }

    return { status: response.status, body: resBody };
  } catch (err: any) {
    console.error('[TelegramService] Exception occurred in sendTrialRequestNotification:', err);
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

  const customer = data.customerName || data.customerEmail.split('@')[0] || 'Unknown';
  const email = data.customerEmail || 'N/A';
  const msg = data.message || '';

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
