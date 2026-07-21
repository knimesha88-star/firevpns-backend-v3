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
