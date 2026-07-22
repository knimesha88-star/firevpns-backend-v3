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
  newExpiry?: string | number | Date;
  approvedAt?: string | number | Date;
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
      console.log('[TelegramService] Renewal notification sent successfully via Telegram.');
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
  const newExpiry = formatDateTime(data.newExpiry);
  const approvedAt = formatDateTime(data.approvedAt);

  const text = `✅ FIREVPNs

Renewal Approved

👤 Customer:
${email}

📦 Plan:
${planName}

📅 Duration:
${durationMonths} Month(s)

📆 New Expiry:
${newExpiry}

🕒 Approved:
${approvedAt}

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
      console.log('[TelegramService] Renewal approved notification sent successfully via Telegram.');
    }
  } catch (err: any) {
    console.error('[TelegramService] Failed to send Telegram approved notification:', err?.message || err);
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
      console.log('[TelegramService] New order notification sent successfully via Telegram.');
    }
  } catch (err: any) {
    console.error('[TelegramService] Failed to send Telegram new order notification:', err?.message || err);
  }
};

export interface OrderApprovedNotificationData {
  customerEmail?: string;
  email?: string;
  package?: string;
  plan?: string;
  server?: string;
  duration?: string;
  uuid?: string;
  status?: string;
}

export const sendOrderApprovedNotification = async (data: OrderApprovedNotificationData): Promise<void> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.warn('[TelegramService] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing. Skipping Telegram order approved notification.');
    return;
  }

  const email = data.customerEmail || data.email || 'N/A';
  const pkg = data.package || data.plan || 'N/A';
  const server = data.server || 'N/A';
  const duration = data.duration || 'N/A';
  const uuid = data.uuid || 'N/A';
  const status = data.status || 'Completed';

  const text = `✅ VPN Created Successfully

Customer:
${email}

Package:
${pkg}

Server:
${server}

Duration:
${duration}

UUID:
${uuid}

Status:
${status}`;

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
      console.log('[TelegramService] Order approved Telegram notification sent successfully.');
    }
  } catch (err: any) {
    console.error('[TelegramService] Failed to send Telegram order approved notification:', err?.message || err);
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
      console.log('[TelegramService] Order rejected Telegram notification sent successfully.');
    }
  } catch (err: any) {
    console.error('[TelegramService] Failed to send Telegram order rejected notification:', err?.message || err);
  }
};

