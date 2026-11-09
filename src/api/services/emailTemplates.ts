export type EmailBadgeVariant = 'success' | 'danger' | 'warning' | 'info';

export interface EmailInfoItem {
  label: string;
  value: string;
  tone?: 'default' | 'danger' | 'success' | 'warning';
}

export interface EmailCodeBlock {
  title?: string;
  description?: string;
  code: string;
}

export interface EmailCtaButton {
  label: string;
  url: string;
}

export interface EmailTemplateConfig {
  subject: string;
  preheader?: string;
  badgeText: string;
  badgeVariant: EmailBadgeVariant;
  heading: string;
  greetingName?: string;
  introParagraphs: string[];
  infoRows?: EmailInfoItem[];
  codeBlock?: EmailCodeBlock;
  messageBox?: string;
  outroParagraphs?: string[];
  cta?: EmailCtaButton;
}

export interface RenderedEmailTemplate {
  subject: string;
  html: string;
  text: string;
}

const BRAND_PORTAL_URL = (process.env.APP_URL || 'https://firevpnsvip.qzz.io').replace(/\/+$/, '');
const BRAND_SUPPORT_EMAIL = 'support@firevpnsteam.qd.je';
const BRAND_SENDER_NAME = 'FIREVPNs Support';

export const escapeHtml = (unsafe: string | number | null | undefined): string => {
  return String(unsafe ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

export const renderBadge = (text: string, variant: EmailBadgeVariant): string => {
  return `<span class="badge badge-${variant}">${escapeHtml(text)}</span>`;
};

export const renderInfoBox = (rows: EmailInfoItem[]): string => {
  if (!rows || rows.length === 0) return '';

  const rowsHtml = rows
    .filter((row) => row.value !== undefined && row.value !== null && String(row.value).trim() !== '')
    .map((row) => {
      let valueStyle = '';
      if (row.tone === 'danger') valueStyle = ' style="color: #f87171;"';
      else if (row.tone === 'success') valueStyle = ' style="color: #4ade80;"';
      else if (row.tone === 'warning') valueStyle = ' style="color: #fbbf24;"';

      return `
      <div class="info-row">
        <span class="info-label">${escapeHtml(row.label)}</span>
        <span class="info-value"${valueStyle}>${escapeHtml(row.value)}</span>
      </div>`;
    })
    .join('');

  if (!rowsHtml) return '';

  return `
    <div class="info-box">
      ${rowsHtml}
    </div>`;
};

export const renderCodeBlock = (block?: EmailCodeBlock): string => {
  if (!block || !block.code) return '';
  return `
    ${block.title ? `<h3>${escapeHtml(block.title)}</h3>` : ''}
    ${block.description ? `<p>${escapeHtml(block.description)}</p>` : ''}
    <div class="code-box">${escapeHtml(block.code)}</div>`;
};

export const renderMessageBox = (message?: string): string => {
  if (!message) return '';
  return `
    <div class="info-box">
      <div style="color: #e2e8f0; font-size: 15px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(message)}</div>
    </div>`;
};

export const renderCtaButton = (cta?: EmailCtaButton): string => {
  if (!cta || !cta.url || !cta.label) return '';
  return `
    <div style="text-align: center; margin: 24px 0 8px;">
      <a href="${escapeHtml(cta.url)}" class="btn" target="_blank" rel="noopener noreferrer">${escapeHtml(cta.label)}</a>
    </div>`;
};

export const renderEmailLayout = (title: string, bodyContent: string, preheader?: string): string => {
  const safeTitle = escapeHtml(title);
  const safePreheader = preheader ? escapeHtml(preheader) : safeTitle;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #0f172a;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #e2e8f0;
      -webkit-font-smoothing: antialiased;
    }
    .preheader {
      display: none !important;
      visibility: hidden;
      opacity: 0;
      color: transparent;
      height: 0;
      width: 0;
      max-height: 0;
      max-width: 0;
      overflow: hidden;
      mso-hide: all;
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
    .brand-title {
      font-size: 24px;
      font-weight: 800;
      color: #ffffff;
      margin: 0;
      letter-spacing: -0.5px;
    }
    .brand-subtitle {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.82);
      margin-top: 4px;
      letter-spacing: 0.4px;
      text-transform: uppercase;
    }
    .content {
      padding: 32px;
      line-height: 1.6;
    }
    h1, h2, h3 {
      color: #f8fafc;
      margin-top: 0;
    }
    p {
      margin: 0 0 14px;
      color: #cbd5e1;
      font-size: 15px;
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
      gap: 12px;
    }
    .info-row:last-child {
      border-bottom: none;
    }
    .info-label {
      color: #94a3b8;
      font-size: 14px;
      flex-shrink: 0;
    }
    .info-value {
      color: #f8fafc;
      font-weight: 600;
      font-size: 14px;
      text-align: right;
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
    .footer p {
      color: #64748b;
      font-size: 12px;
      margin: 4px 0;
    }
    .footer a {
      color: #38bdf8;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="preheader">${safePreheader}</div>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <div class="brand-title">🔥 FIREVPNs</div>
        <div class="brand-subtitle">High-Speed VLESS VPN Network</div>
      </div>
      <div class="content">
        ${bodyContent}
      </div>
      <div class="footer">
        <p>&copy; ${new Date().getFullYear()} FIREVPNs. All rights reserved.</p>
        <p>Sent by ${escapeHtml(BRAND_SENDER_NAME)} (<a href="mailto:${escapeHtml(BRAND_SUPPORT_EMAIL)}">${escapeHtml(BRAND_SUPPORT_EMAIL)}</a>)</p>
      </div>
    </div>
  </div>
</body>
</html>`;
};

export const renderBrandedEmail = (config: EmailTemplateConfig): RenderedEmailTemplate => {
  const greetingName = (config.greetingName || 'Valued Customer').trim();
  const introHtml = config.introParagraphs.map((p) => `<p>${p}</p>`).join('\n    ');
  const outroHtml = (config.outroParagraphs || []).map((p) => `<p>${p}</p>`).join('\n    ');

  const bodyHtml = `
    ${renderBadge(config.badgeText, config.badgeVariant)}
    <h1>${escapeHtml(config.heading)}</h1>
    <p>Hello ${escapeHtml(greetingName)},</p>
    ${introHtml}
    ${config.infoRows ? renderInfoBox(config.infoRows) : ''}
    ${renderMessageBox(config.messageBox)}
    ${renderCodeBlock(config.codeBlock)}
    ${outroHtml}
    ${renderCtaButton(config.cta)}
  `;

  const stripTags = (str: string) => str.replace(/<[^>]*>/g, '');
  const textLines: string[] = [
    `FIREVPNs - ${config.badgeText.toUpperCase()}`,
    config.heading,
    '',
    `Hello ${greetingName},`,
    ...config.introParagraphs.map(stripTags),
  ];

  if (config.infoRows && config.infoRows.length > 0) {
    textLines.push('');
    for (const row of config.infoRows) {
      if (row.value !== undefined && row.value !== null && String(row.value).trim() !== '') {
        textLines.push(`${row.label} ${row.value}`);
      }
    }
  }

  if (config.messageBox) {
    textLines.push('', config.messageBox);
  }

  if (config.codeBlock?.code) {
    textLines.push('', `${config.codeBlock.title || 'Connection Link'}:`, config.codeBlock.code);
  }

  if (config.outroParagraphs && config.outroParagraphs.length > 0) {
    textLines.push('', ...config.outroParagraphs.map(stripTags));
  }

  if (config.cta) {
    textLines.push('', `${config.cta.label}: ${config.cta.url}`);
  }

  textLines.push('', `— ${BRAND_SENDER_NAME} (${BRAND_SUPPORT_EMAIL})`);

  return {
    subject: config.subject,
    html: renderEmailLayout(config.subject, bodyHtml, config.preheader || config.heading),
    text: textLines.join('\n')
  };
};

// ================= MODULAR EVENT TEMPLATE BUILDERS ================= //

export const buildCustomerRegistrationTemplate = (data: {
  userEmail: string;
  customerName?: string;
}): RenderedEmailTemplate => {
  const subject = 'Welcome to FIREVPNs - Your Account has been Created';
  return renderBrandedEmail({
    subject,
    preheader: 'Your FIREVPNs customer account is ready. Claim up to 2 free trials or activate a VPN plan.',
    badgeText: 'Welcome to FIREVPNs',
    badgeVariant: 'info',
    heading: `Welcome Aboard, ${data.customerName || 'Valued Customer'}!`,
    greetingName: data.customerName,
    introParagraphs: [
      `Thank you for registering with <strong>FIREVPNs</strong>. Your customer account has been created successfully.`
    ],
    infoRows: [
      { label: 'Account Email:', value: data.userEmail },
      { label: 'Free Trial Quota:', value: 'Up to 2 Free Trials (1 GB / 24 Hours each)', tone: 'success' },
      { label: 'Support Contact:', value: BRAND_SUPPORT_EMAIL }
    ],
    outroParagraphs: [
      'Once you verify your email address and sign in, you can claim your free trial or activate a high-speed VLESS VPN package directly from the FIREVPNs Store.'
    ],
    cta: {
      label: 'Open FIREVPNs Portal',
      url: `${BRAND_PORTAL_URL}/login`
    }
  });
};

export const buildOrderReceivedTemplate = (data: {
  customerName?: string;
  orderId: string;
  packageName: string;
  amount: number;
  paymentMethod?: string;
}): RenderedEmailTemplate => {
  const subject = `Order Confirmation #${data.orderId} - FIREVPNs`;
  return renderBrandedEmail({
    subject,
    preheader: `Order #${data.orderId} for ${data.packageName} has been received and is pending verification.`,
    badgeText: 'Order Received',
    badgeVariant: 'info',
    heading: 'Thank You for Your Order!',
    greetingName: data.customerName,
    introParagraphs: [
      `We have successfully received your order for <strong>${escapeHtml(data.packageName)}</strong>. Our team is processing your payment verification.`
    ],
    infoRows: [
      { label: 'Order Reference:', value: `#${data.orderId}` },
      { label: 'Package:', value: data.packageName },
      { label: 'Amount:', value: `LKR ${data.amount}` },
      { label: 'Payment Method:', value: data.paymentMethod || 'Bank Transfer / Manual Slip' }
    ],
    outroParagraphs: [
      'You will receive another email with your VLESS VPN access credentials as soon as your payment is verified.'
    ],
    cta: {
      label: 'View Order Status',
      url: `${BRAND_PORTAL_URL}/dashboard`
    }
  });
};

export const buildPaymentApprovedTemplate = (data: {
  customerName?: string;
  orderId: string;
  packageName: string;
  vlessUrl?: string;
  expiryDate?: string;
}): RenderedEmailTemplate => {
  const subject = `Payment Approved! Your ${data.packageName} VPN is Ready - FIREVPNs`;
  const formattedExpiry = data.expiryDate
    ? new Date(data.expiryDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : 'N/A';

  return renderBrandedEmail({
    subject,
    preheader: `Your ${data.packageName} VPN configuration is active and ready to connect.`,
    badgeText: 'Payment Approved',
    badgeVariant: 'success',
    heading: 'Your VPN is Activated!',
    greetingName: data.customerName,
    introParagraphs: [
      `Great news! Your payment for <strong>${escapeHtml(data.packageName)}</strong> (Order #${escapeHtml(data.orderId)}) has been verified and approved.`
    ],
    infoRows: [
      { label: 'Order ID:', value: `#${data.orderId}` },
      { label: 'Package:', value: data.packageName },
      { label: 'Status:', value: 'Active', tone: 'success' },
      { label: 'Expiry Date:', value: formattedExpiry }
    ],
    codeBlock: data.vlessUrl
      ? {
          title: 'Your VLESS Connection Link',
          description: 'Import this link directly into v2rayNG, v2rayN, Shadowrocket, or Streisand:',
          code: data.vlessUrl
        }
      : undefined,
    outroParagraphs: [
      'You can also access QR codes, monitor live traffic usage, and manage your configurations directly from your customer dashboard.'
    ],
    cta: {
      label: 'Open Customer Dashboard',
      url: `${BRAND_PORTAL_URL}/dashboard`
    }
  });
};

export const buildOrderCompletedTemplate = (data: {
  customerName?: string;
  orderId: string;
  packageName: string;
  vlessUrl?: string;
  expiryDate?: string;
}): RenderedEmailTemplate => {
  const subject = 'Your FIREVPNs Order Is Completed!';
  const formattedExpiry = data.expiryDate
    ? new Date(data.expiryDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : 'N/A';

  return renderBrandedEmail({
    subject,
    preheader: `Your ${data.packageName} VPN configuration is ready and active.`,
    badgeText: 'Order Completed',
    badgeVariant: 'success',
    heading: 'Your Order Is Completed!',
    greetingName: data.customerName,
    introParagraphs: [
      `Your subscription order for <strong>${escapeHtml(data.packageName)}</strong> (Order #${escapeHtml(data.orderId)}) has been successfully completed and your VPN configuration is ready.`
    ],
    infoRows: [
      { label: 'Order ID:', value: `#${data.orderId}` },
      { label: 'Package:', value: data.packageName },
      { label: 'Status:', value: 'Completed & Active', tone: 'success' },
      { label: 'Expiry Date:', value: formattedExpiry }
    ],
    codeBlock: data.vlessUrl
      ? {
          title: 'Your VLESS Connection Link',
          description: 'Import this link directly into v2rayNG, v2rayN, Shadowrocket, or Streisand:',
          code: data.vlessUrl
        }
      : undefined,
    outroParagraphs: [
      'Please open your customer dashboard to view your complete VPN configuration, QR codes, and connection instructions.',
      '<strong>Need Help?</strong><br>If you experience any issues with your order, payment verification, or VPN configuration, please contact our support team. We are happy to help you.<br><br><strong>WhatsApp / Phone Support:</strong> <a href="tel:0769225099">0769225099</a> · <a href="https://wa.me/94769225099" target="_blank">Chat on WhatsApp</a>'
    ],
    cta: {
      label: 'Open Customer Dashboard',
      url: `${BRAND_PORTAL_URL}/dashboard`
    }
  });
};

export const buildPaymentRejectedTemplate = (data: {
  customerName?: string;
  orderId: string;
  packageName: string;
  reason?: string;
}): RenderedEmailTemplate => {
  const subject = `Order #${data.orderId} Update - Action Required - FIREVPNs`;
  return renderBrandedEmail({
    subject,
    preheader: `Update regarding your payment verification for Order #${data.orderId}.`,
    badgeText: 'Payment Rejected',
    badgeVariant: 'danger',
    heading: 'Payment Verification Issue',
    greetingName: data.customerName,
    introParagraphs: [
      `We were unable to verify your payment for order <strong>#${escapeHtml(data.orderId)}</strong> (${escapeHtml(data.packageName)}).`
    ],
    infoRows: [
      { label: 'Order ID:', value: `#${data.orderId}` },
      { label: 'Package:', value: data.packageName },
      {
        label: 'Reason:',
        value: data.reason || 'Invalid or unreadable payment slip uploaded.',
        tone: 'danger'
      }
    ],
    outroParagraphs: [
      'If you believe this is an error, please reach out via live chat or submit a support ticket in your customer dashboard.'
    ],
    cta: {
      label: 'Contact Support',
      url: `${BRAND_PORTAL_URL}/support`
    }
  });
};

export const buildRenewalRequestReceivedTemplate = (data: {
  customerName?: string;
  packageName: string;
  durationMonths?: number;
  amount?: number;
  receiptNumber?: string;
}): RenderedEmailTemplate => {
  const subject = `Renewal Request Submitted - ${data.packageName} - FIREVPNs`;
  const infoRows: EmailInfoItem[] = [
    { label: 'Package:', value: data.packageName },
    { label: 'Duration:', value: `${data.durationMonths || 1} Month(s)` }
  ];
  if (data.amount !== undefined) {
    infoRows.push({ label: 'Amount:', value: `LKR ${data.amount}` });
  }
  if (data.receiptNumber) {
    infoRows.push({ label: 'Receipt Reference:', value: data.receiptNumber });
  }
  infoRows.push({ label: 'Status:', value: 'Pending Verification', tone: 'warning' });

  return renderBrandedEmail({
    subject,
    preheader: `Your renewal request for ${data.packageName} has been received and is pending verification.`,
    badgeText: 'Renewal Pending Verification',
    badgeVariant: 'info',
    heading: 'Renewal Request Received',
    greetingName: data.customerName,
    introParagraphs: [
      `We have received your subscription renewal request for <strong>${escapeHtml(data.packageName)}</strong>. Our team is currently verifying your payment transfer slip.`
    ],
    infoRows,
    outroParagraphs: [
      'You will receive a confirmation email as soon as your renewal is approved and your VPN expiration date is extended.'
    ],
    cta: {
      label: 'Track Renewal Status',
      url: `${BRAND_PORTAL_URL}/history`
    }
  });
};

export const buildRenewalApprovedTemplate = (data: {
  customerName?: string;
  packageName: string;
  vlessUrl?: string;
  expiryDate?: string;
}): RenderedEmailTemplate => {
  const subject = `Renewal Approved! ${data.packageName} Extended - FIREVPNs`;
  const formattedExpiry = data.expiryDate
    ? new Date(data.expiryDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : 'N/A';

  return renderBrandedEmail({
    subject,
    preheader: `Your ${data.packageName} subscription has been renewed until ${formattedExpiry}.`,
    badgeText: 'Renewal Approved',
    badgeVariant: 'success',
    heading: 'Your Subscription Has Been Extended!',
    greetingName: data.customerName,
    introParagraphs: [
      `Your renewal request for <strong>${escapeHtml(data.packageName)}</strong> has been verified and approved successfully.`
    ],
    infoRows: [
      { label: 'Package:', value: data.packageName },
      { label: 'Renewal Status:', value: 'Approved & Extended', tone: 'success' },
      { label: 'New Expiry Date:', value: formattedExpiry }
    ],
    codeBlock: data.vlessUrl
      ? {
          title: 'Your VLESS Connection Link',
          code: data.vlessUrl
        }
      : undefined,
    outroParagraphs: [
      'Thank you for continuing to trust FIREVPNs for your online privacy and high-speed access!'
    ],
    cta: {
      label: 'View Active Subscription',
      url: `${BRAND_PORTAL_URL}/dashboard`
    }
  });
};

export const buildRenewalRejectedTemplate = (data: {
  customerName?: string;
  packageName: string;
  reason?: string;
}): RenderedEmailTemplate => {
  const subject = `Renewal Request Update - ${data.packageName} - FIREVPNs`;
  return renderBrandedEmail({
    subject,
    preheader: `Action required regarding your ${data.packageName} renewal request.`,
    badgeText: 'Renewal Rejected',
    badgeVariant: 'danger',
    heading: 'Renewal Verification Issue',
    greetingName: data.customerName,
    introParagraphs: [
      `We could not approve your renewal request for <strong>${escapeHtml(data.packageName)}</strong>.`
    ],
    infoRows: [
      { label: 'Package:', value: data.packageName },
      {
        label: 'Reason:',
        value: data.reason || 'Payment verification failed or invalid transfer slip.',
        tone: 'danger'
      }
    ],
    outroParagraphs: [
      'Please log in to your account to re-submit a clear payment slip or contact our support team for assistance.'
    ],
    cta: {
      label: 'Open Customer Dashboard',
      url: `${BRAND_PORTAL_URL}/dashboard`
    }
  });
};

export const buildTrialApprovedTemplate = (data: {
  customerName?: string;
  packageName: string;
  vlessUrl?: string;
  expiryDate?: string;
}): RenderedEmailTemplate => {
  const subject = `Free Trial Approved! Your ${data.packageName} VPN is Ready - FIREVPNs`;
  const formattedExpiry = data.expiryDate
    ? new Date(data.expiryDate).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : '24 Hours (1 Day)';

  return renderBrandedEmail({
    subject,
    preheader: `Your 1 GB / 24-Hour free trial for ${data.packageName} is now active.`,
    badgeText: 'Free Trial Active',
    badgeVariant: 'success',
    heading: 'Welcome to Your Free Trial!',
    greetingName: data.customerName,
    introParagraphs: [
      `Your free trial for <strong>${escapeHtml(data.packageName)}</strong> has been approved and your VPN configuration is active!`
    ],
    infoRows: [
      { label: 'Package:', value: data.packageName },
      { label: 'Trial Allowance:', value: '1 GB / 24 Hours', tone: 'success' },
      { label: 'Expires At:', value: formattedExpiry }
    ],
    codeBlock: data.vlessUrl
      ? {
          title: 'Your Free Trial VLESS Link',
          description: 'Import this link directly into your V2Ray / VLESS client (v2rayNG, v2rayN, Shadowrocket, Streisand):',
          code: data.vlessUrl
        }
      : undefined,
    outroParagraphs: [
      'Enjoy blazing fast speeds and secure protection during your trial period!'
    ],
    cta: {
      label: 'Manage Trial in Dashboard',
      url: `${BRAND_PORTAL_URL}/dashboard`
    }
  });
};

export const buildTrialRejectedTemplate = (data: {
  customerName?: string;
  packageName: string;
  reason?: string;
}): RenderedEmailTemplate => {
  const subject = `Free Trial Request Update - FIREVPNs`;
  return renderBrandedEmail({
    subject,
    preheader: `Update regarding your free trial request for ${data.packageName}.`,
    badgeText: 'Trial Request Declined',
    badgeVariant: 'danger',
    heading: 'Free Trial Request Update',
    greetingName: data.customerName,
    introParagraphs: [
      `We were unable to approve your free trial request for <strong>${escapeHtml(data.packageName)}</strong>.`
    ],
    infoRows: [
      { label: 'Package:', value: data.packageName },
      {
        label: 'Reason:',
        value: data.reason || 'A free trial was already claimed for this account.',
        tone: 'danger'
      }
    ],
    outroParagraphs: [
      'You can still purchase any of our regular high-speed VPN plans anytime from the FIREVPNs Store.'
    ],
    cta: {
      label: 'Browse VPN Packages',
      url: `${BRAND_PORTAL_URL}/store`
    }
  });
};

export const buildExpiryReminderTemplate = (data: {
  customerName?: string;
  packageName: string;
  daysLeft: number;
  expiryDate?: string;
}): RenderedEmailTemplate => {
  const daysText = data.daysLeft === 1 ? 'Tomorrow' : `in ${data.daysLeft} Days`;
  const subject = `Reminder: Your VPN Expires ${daysText} - FIREVPNs`;
  const formattedExpiry = data.expiryDate
    ? new Date(data.expiryDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : undefined;

  const infoRows: EmailInfoItem[] = [
    { label: 'Package:', value: data.packageName },
    { label: 'Days Remaining:', value: `${data.daysLeft} Day(s)`, tone: 'warning' }
  ];
  if (formattedExpiry) {
    infoRows.push({ label: 'Expiration Date:', value: formattedExpiry });
  }

  return renderBrandedEmail({
    subject,
    preheader: `Your VPN configuration ${data.packageName} expires ${daysText}. Renew now to avoid interruption.`,
    badgeText: 'Expiry Warning',
    badgeVariant: 'warning',
    heading: 'Your VPN Subscription Expires Soon',
    greetingName: data.customerName,
    introParagraphs: [
      `Your VPN configuration <strong>${escapeHtml(data.packageName)}</strong> is scheduled to expire <strong>${escapeHtml(daysText)}</strong>.`
    ],
    infoRows,
    outroParagraphs: [
      'To avoid any service interruption and keep your existing VLESS configuration active, please renew your subscription from your customer dashboard today.'
    ],
    cta: {
      label: 'Renew Subscription Now',
      url: `${BRAND_PORTAL_URL}/dashboard`
    }
  });
};

export const buildVpnExpiredTemplate = (data: {
  customerName?: string;
  packageName: string;
  expiryDate?: string;
}): RenderedEmailTemplate => {
  const subject = `Your VPN Subscription Has Expired - FIREVPNs`;
  const formattedExpiry = data.expiryDate
    ? new Date(data.expiryDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : 'Expired';

  return renderBrandedEmail({
    subject,
    preheader: `Your VPN configuration ${data.packageName} has expired. Renew your plan to restore access.`,
    badgeText: 'Subscription Expired',
    badgeVariant: 'danger',
    heading: 'Your VPN Has Expired',
    greetingName: data.customerName,
    introParagraphs: [
      `Your VPN configuration <strong>${escapeHtml(data.packageName)}</strong> has reached its expiration date and is currently inactive.`
    ],
    infoRows: [
      { label: 'Package:', value: data.packageName },
      { label: 'Status:', value: 'Expired / Inactive', tone: 'danger' },
      { label: 'Expired On:', value: formattedExpiry }
    ],
    outroParagraphs: [
      'Renew your plan or order a new VPN package from your customer portal to immediately restore high-speed unlimited access!'
    ],
    cta: {
      label: 'Renew or Purchase Plan',
      url: `${BRAND_PORTAL_URL}/dashboard`
    }
  });
};

export const buildSupportReplyTemplate = (data: {
  customerName?: string;
  ticketId: string;
  subject: string;
  replyMessage: string;
}): RenderedEmailTemplate => {
  const emailSubject = `New Reply on Support Ticket #${data.ticketId} - FIREVPNs`;
  return renderBrandedEmail({
    subject: emailSubject,
    preheader: `Our support team replied to your ticket #${data.ticketId} (${data.subject}).`,
    badgeText: 'Support Ticket Reply',
    badgeVariant: 'info',
    heading: 'Support Response Received',
    greetingName: data.customerName,
    introParagraphs: [
      `Our support team has posted a reply to your ticket <strong>#${escapeHtml(data.ticketId)}</strong> ("${escapeHtml(data.subject)}"):`
    ],
    messageBox: data.replyMessage,
    outroParagraphs: [
      'You can view the full conversation and respond directly to this ticket from your customer dashboard.'
    ],
    cta: {
      label: 'View Support Ticket',
      url: `${BRAND_PORTAL_URL}/support`
    }
  });
};

export const buildLiveChatReplyTemplate = (data: {
  customerName?: string;
  chatMessage: string;
}): RenderedEmailTemplate => {
  const subject = 'New Message from FIREVPNs Support';
  return renderBrandedEmail({
    subject,
    preheader: 'You have a new message from the FIREVPNs support team.',
    badgeText: 'Live Chat Message',
    badgeVariant: 'info',
    heading: 'New Live Chat Message',
    greetingName: data.customerName,
    introParagraphs: [
      'You have received a new message from our live chat support team:'
    ],
    messageBox: data.chatMessage,
    outroParagraphs: [
      'Open the live chat widget on our website to continue the conversation.'
    ],
    cta: {
      label: 'Open FIREVPNs Live Chat',
      url: BRAND_PORTAL_URL
    }
  });
};

export const buildMaintenanceAnnouncementTemplate = (data: {
  customerName?: string;
  announcementTitle: string;
  announcementBody: string;
}): RenderedEmailTemplate => {
  const subject = `[Announcement] ${data.announcementTitle} - FIREVPNs`;
  return renderBrandedEmail({
    subject,
    preheader: data.announcementTitle,
    badgeText: 'System Announcement',
    badgeVariant: 'warning',
    heading: data.announcementTitle,
    greetingName: data.customerName,
    introParagraphs: [
      'Please review the following important announcement regarding your FIREVPNs service:'
    ],
    messageBox: data.announcementBody,
    outroParagraphs: [
      'If you have any questions regarding this announcement, please reach out to our 24/7 support team.'
    ],
    cta: {
      label: 'Go to Dashboard',
      url: `${BRAND_PORTAL_URL}/dashboard`
    }
  });
};

export const buildSystemTestEmailTemplate = (data: {
  recipientEmail: string;
  senderFormatted: string;
}): RenderedEmailTemplate => {
  const subject = '🔥 FIREVPNs Email System Test';
  return renderBrandedEmail({
    subject,
    preheader: 'Verification of your FIREVPNs Resend email configuration.',
    badgeText: 'System Verification',
    badgeVariant: 'success',
    heading: 'FIREVPNs Automatic Email System',
    greetingName: 'Administrator',
    introParagraphs: [
      'This is a single-recipient verification email sent from the FIREVPNs backend via Resend.'
    ],
    infoRows: [
      { label: 'Verified Sender:', value: data.senderFormatted },
      { label: 'Test Recipient:', value: data.recipientEmail },
      { label: 'Domain Status:', value: 'firevpnsteam.qd.je (Verified)', tone: 'success' },
      { label: 'Timestamp:', value: new Date().toISOString() }
    ],
    outroParagraphs: [
      'Your Resend domain and modular HTML email template system are configured and operating properly.'
    ]
  });
};
