import dotenv from 'dotenv';
import { sendSingleTestEmail, parseSenderConfig, getEmailSettings } from '../api/services/emailService.js';

dotenv.config();

async function runSafeSingleEmailTest() {
  const cliRecipient = process.argv[2];
  const recipient = (cliRecipient || process.env.TEST_EMAIL_RECIPIENT || '').trim();

  const sender = parseSenderConfig(
    process.env.EMAIL_FROM,
    process.env.EMAIL_FROM_NAME,
    process.env.EMAIL_FROM_ADDRESS
  );
  const settings = await getEmailSettings();

  console.log('--- FIREVPNs Safe Backend Email Test ---');
  console.log('Configured Sender:', sender.formatted);
  console.log('RESEND_API_KEY Present:', Boolean(process.env.RESEND_API_KEY || settings.hasConfiguredApiKey));

  if (!recipient || !recipient.includes('@') || recipient.includes(',')) {
    console.log(
      'Status: Skipped live dispatch — no explicit single test recipient provided (pass email as CLI argument or set TEST_EMAIL_RECIPIENT).'
    );
    return;
  }

  console.log(`Dispatching 1 test email to explicit recipient: ${recipient}...`);
  const result = await sendSingleTestEmail(recipient);

  console.log('Resend API Verification Result:', JSON.stringify({
    success: result.success,
    accepted: Boolean(result.accepted && result.messageId),
    messageId: result.messageId || null,
    from: result.from || sender.formatted,
    to: result.to || recipient,
    statusCode: result.statusCode || null,
    error: result.error || null
  }, null, 2));

  if (!result.success || !result.accepted || !result.messageId) {
    process.exitCode = 1;
  }
}

runSafeSingleEmailTest().catch((err) => {
  console.error('[TestEmail] Unexpected error:', err?.message || err);
  process.exitCode = 1;
});
