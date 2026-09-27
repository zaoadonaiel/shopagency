const nodemailer = require('nodemailer');

const from = process.env.MAIL_FROM || 'The Agency School <no-reply@localhost>';
let transport = null;

if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

// Never throws. Without SMTP settings it prints the email to the console (dev mode).
async function sendMail(to, subject, text) {
  const list = Array.isArray(to) ? to : [to];
  if (!list.length) return;
  if (!transport) {
    console.log(`\n--- EMAIL (dev, not sent) ---\nTo: ${list.join(', ')}\nSubject: ${subject}\n\n${text}\n-----------------------------\n`);
    return;
  }
  try {
    // Bcc so contractors never see each other's addresses.
    await transport.sendMail({ from, to: list.length === 1 ? list[0] : from, bcc: list.length === 1 ? undefined : list, subject, text });
  } catch (err) {
    console.error('Email failed:', subject, err.message);
  }
}

module.exports = { sendMail };
