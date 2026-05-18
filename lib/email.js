import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();
const emailConfig = {
  host: 'mail1.netim.hosting',
  port: 465,
  secure: true, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL,
    pass: process.env.EMAIL_PASSWORD,
  },
};
const transporter = nodemailer.createTransport(emailConfig);

if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID && !process.env.API_BASE_URL) {
  transporter.verify((error, success) => {
    if (error) {
      if (!process.env.API_BASE_URL) {
        console.error('Email server connection error:', error);
      }
    } else {
      console.log('Email server is ready to send messages');
    }
  });
}

export async function sendStaffPasswordSetupEmail(to, name, username, token) {
  const baseUrl = process.env.FRONTEND_URL || 'https://workalong.co.uk';
  const setupUrl = `${baseUrl}/staff/setup-password?token=${token}&username=${username}`;

  const mailOptions = {
    from: '"WorkAlong Team" <company@workalong.co.uk>',
    to: to,
    subject: 'Welcome to WorkAlong - Set Up Your Password',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Set Up Your WorkAlong Password</title>
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background-color: #f4f4f4; padding: 20px; border-radius: 5px;">
          <h1 style="color: #667eea;">Welcome to WorkAlong, ${name}!</h1>
          
          <p>You've been added to the WorkAlong system. To get started, please set up your password by clicking the link below:</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${setupUrl}" 
               style="background-color: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
              Set Up Your Password
            </a>
          </div>
          
          <p style="font-size: 14px; color: #666;">
            Your username is: <strong>${username}</strong>
          </p>
          
          <p style="font-size: 14px; color: #666;">
            This link will expire in 7 days. If you didn't expect this email, please ignore it.
          </p>
          
          <p style="font-size: 14px; color: #666;">
            If the button doesn't work, copy and paste this URL into your browser:<br>
            <a href="${setupUrl}" style="color: #667eea; word-break: break-all;">${setupUrl}</a>
          </p>
          
          <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
          
          <p style="font-size: 12px; color: #999; text-align: center;">
            This is an automated message from WorkAlong. Please do not reply to this email.
          </p>
        </div>
      </body>
      </html>
    `,
    text: `
Welcome to WorkAlong, ${name}!

You've been added to the WorkAlong system. To get started, please set up your password by visiting the link below:

${setupUrl}

Your username is: ${username}

This link will expire in 7 days. If you didn't expect this email, please ignore it.
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    const isTestEnv =
      process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID || to.includes('@example.com');
    if (!isTestEnv) {
      console.log('Password setup email sent to:', to);
      console.log('   Message ID:', info.messageId);
    }
    return { success: true, messageId: info.messageId };
  } catch (error) {
    const isTestEnv =
      process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID || to.includes('@example.com');
    if (!isTestEnv) {
      console.error('Error sending password setup email:', error);
    }
    if (isTestEnv) {
      return { success: false, messageId: null };
    }
    throw error;
  }
}

export async function sendLoginCodeEmail(to, name, code) {
  const mailOptions = {
    from: '"WorkAlong Team" <company@workalong.co.uk>',
    to: to,
    subject: 'Your WorkAlong Login Code',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Your WorkAlong Login Code</title>
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background-color: #f4f4f4; padding: 20px; border-radius: 5px;">
          <h1 style="color: #667eea;">Login Verification Code</h1>
          
          <p>Hello ${name},</p>
          
          <p>You requested to sign in to your WorkAlong account. Use the verification code below to complete your login:</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <div style="background-color: #667eea; color: white; padding: 20px; border-radius: 8px; font-size: 32px; font-weight: bold; letter-spacing: 8px; display: inline-block;">
              ${code}
            </div>
          </div>
          
          <p style="font-size: 14px; color: #666;">
            This code will expire in 10 minutes. If you didn't request this code, please ignore this email.
          </p>
          
          <p style="font-size: 14px; color: #666;">
            For security reasons, never share this code with anyone.
          </p>
          
          <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
          
          <p style="font-size: 12px; color: #999; text-align: center;">
            This is an automated message from WorkAlong. Please do not reply to this email.
          </p>
        </div>
      </body>
      </html>
    `,
    text: `
Login Verification Code

Hello ${name},

You requested to sign in to your WorkAlong account. Use the verification code below to complete your login:

${code}

This code will expire in 10 minutes. If you didn't request this code, please ignore this email.

For security reasons, never share this code with anyone.
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    const isTestEnv =
      process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID || to.includes('@example.com');
    if (!isTestEnv) {
      console.log('Login code email sent to:', to);
      console.log('   Message ID:', info.messageId);
    }
    return { success: true, messageId: info.messageId };
  } catch (error) {
    const isTestEnv =
      process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID || to.includes('@example.com');
    if (!isTestEnv) {
      console.error('Error sending login code email:', error);
    }
    if (isTestEnv) {
      return { success: false, messageId: null };
    }
    throw error;
  }
}

export async function sendPasswordResetEmail(to, name, token) {
  const baseUrl = process.env.FRONTEND_URL || 'https://workalong.co.uk';
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;

  const mailOptions = {
    from: '"WorkAlong Team" <company@workalong.co.uk>',
    to: to,
    subject: 'Reset Your WorkAlong Password',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reset Your WorkAlong Password</title>
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background-color: #f4f4f4; padding: 20px; border-radius: 5px;">
          <h1 style="color: #667eea;">Password Reset Request</h1>
          
          <p>Hello ${name},</p>
          
          <p>You requested to reset your password. Click the button below to create a new password:</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" 
               style="background-color: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
              Reset Password
            </a>
          </div>
          
          <p style="font-size: 14px; color: #666;">
            This link will expire in 24 hours. If you didn't request this, please ignore this email.
          </p>
          
          <p style="font-size: 14px; color: #666;">
            If the button doesn't work, copy and paste this URL into your browser:<br>
            <a href="${resetUrl}" style="color: #667eea; word-break: break-all;">${resetUrl}</a>
          </p>
        </div>
      </body>
      </html>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    const isTestEnv =
      process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID || to.includes('@example.com');
    if (!isTestEnv) {
      console.log('Password reset email sent to:', to);
    }
    return { success: true, messageId: info.messageId };
  } catch (error) {
    const isTestEnv =
      process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID || to.includes('@example.com');
    if (!isTestEnv) {
      console.error('Error sending password reset email:', error);
    }
    if (isTestEnv) {
      return { success: false, messageId: null };
    }
    throw error;
  }
}

export async function sendBillingReminderEmail(to, name, daysLeft, renewalDate, billingPortalUrl) {
  const isTestEnv =
    process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID || to.includes('@example.com');

  const formattedDate = renewalDate.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const urgencyColor = daysLeft === 1 ? '#e53e3e' : daysLeft === 3 ? '#dd6b20' : '#667eea';
  const urgencyLabel =
    daysLeft === 1 ? '⚠️ Last chance — renews tomorrow!' : `Your plan renews in ${daysLeft} days`;

  const mailOptions = {
    from: '"WorkAlong Team" <company@workalong.co.uk>',
    to,
    subject: `[WorkAlong] Your subscription renews in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background-color: #f9f9f9; border-radius: 8px; padding: 32px; border-top: 4px solid ${urgencyColor};">
          <h1 style="color: ${urgencyColor}; margin-top: 0;">${urgencyLabel}</h1>

          <p>Hi ${name},</p>

          <p>Just a heads-up — your WorkAlong subscription is due to renew on <strong>${formattedDate}</strong>.</p>

          <p>To keep enjoying uninterrupted access to scheduling, payroll, and staff management, please make sure your payment details are up to date.</p>

          <div style="text-align: center; margin: 32px 0;">
            <a href="${billingPortalUrl}"
               style="background-color: ${urgencyColor}; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold; font-size: 16px;">
              Manage Billing
            </a>
          </div>

          <p style="font-size: 14px; color: #666;">
            If your payment method is already up to date, no action is needed — your subscription will renew automatically.
          </p>

          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">

          <p style="font-size: 12px; color: #999; text-align: center;">
            This is an automated reminder from WorkAlong. You are receiving this because you have an active subscription.<br>
            <a href="https://workalong.co.uk/plans" style="color: #667eea;">View your plan</a>
          </p>
        </div>
      </body>
      </html>
    `,
    text: `
Hi ${name},

Your WorkAlong subscription renews in ${daysLeft} day${daysLeft === 1 ? '' : 's'} on ${formattedDate}.

Please make sure your payment details are up to date: ${billingPortalUrl}

If your payment method is already current, no action is needed.

— The WorkAlong Team
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    if (!isTestEnv) {
      console.log(`[BillingReminder] ${daysLeft}d reminder sent to ${to}`);
    }
    return { success: true, messageId: info.messageId };
  } catch (error) {
    if (!isTestEnv) {
      console.error(`[BillingReminder] Failed to send ${daysLeft}d reminder to ${to}:`, error);
    }
    if (isTestEnv) return { success: false, messageId: null };
    throw error;
  }
}

const CONTACT_FORWARD_EMAIL = process.env.CONTACT_FORWARD_EMAIL || 'Hamchenhbf3@gmail.com';

const SUBJECT_LABELS = {
  sales: 'Sales Inquiry',
  support: 'Technical Support',
  billing: 'Billing Question',
  partnership: 'Partnership Opportunity',
  other: 'Other',
};

export async function sendContactFormEmail(name, email, company, subject, message) {
  const subjectLabel = SUBJECT_LABELS[subject] || subject || 'Other';
  const text = [
    `Name: ${name}`,
    `Email: ${email}`,
    company ? `Company: ${company}` : null,
    `Subject: ${subjectLabel}`,
    '',
    'Message:',
    message,
  ]
    .filter(Boolean)
    .join('\n');

  const mailOptions = {
    from: '"WorkAlong Contact" <company@workalong.co.uk>',
    to: CONTACT_FORWARD_EMAIL,
    replyTo: email,
    subject: `[WorkAlong Contact] ${subjectLabel} – ${name}`,
    text,
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background-color: #f4f4f4; padding: 20px; border-radius: 5px;">
          <h1 style="color: #667eea;">New contact form message</h1>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
          ${company ? `<p><strong>Company:</strong> ${company}</p>` : ''}
          <p><strong>Subject:</strong> ${subjectLabel}</p>
          <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
          <p><strong>Message:</strong></p>
          <p style="white-space: pre-wrap;">${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
          <p style="font-size: 12px; color: #999;">Reply to this email to respond to the sender.</p>
        </div>
      </body>
      </html>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    const isTestEnv =
      process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID || process.env.API_BASE_URL;
    if (!isTestEnv) {
      console.log('Contact form email sent to:', CONTACT_FORWARD_EMAIL);
    }
    return { success: true, messageId: info.messageId };
  } catch (error) {
    const isTestEnv =
      process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID || process.env.API_BASE_URL;
    if (!isTestEnv) {
      console.error('Error sending contact form email:', error);
    }
    if (isTestEnv) {
      return { success: false, messageId: null };
    }
    throw error;
  }
}

export async function sendDemoBookingEmail({ name, email, company, date, timeSlot, message }) {
  const safeMsg = (message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const mailOptions = {
    from: '"Workalong Demo" <company@workalong.co.uk>',
    to: CONTACT_FORWARD_EMAIL,
    replyTo: email,
    subject: `[Demo Booking] ${name} — ${date} ${timeSlot}`,
    text: [
      `New demo session request`,
      ``,
      `Name:      ${name}`,
      `Email:     ${email}`,
      company ? `Company:   ${company}` : null,
      `Date:      ${date}`,
      `Time slot: ${timeSlot}`,
      message ? `\nNotes:\n${message}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"></head>
      <body style="font-family:Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;">
        <div style="background:#f4f4f4;padding:24px;border-radius:8px;">
          <h2 style="color:#6366f1;margin-top:0;">📅 New Demo Booking Request</h2>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:6px 0;font-weight:bold;width:120px;">Name</td><td>${name}</td></tr>
            <tr><td style="padding:6px 0;font-weight:bold;">Email</td><td><a href="mailto:${email}">${email}</a></td></tr>
            ${company ? `<tr><td style="padding:6px 0;font-weight:bold;">Company</td><td>${company}</td></tr>` : ''}
            <tr><td style="padding:6px 0;font-weight:bold;">Date</td><td>${date}</td></tr>
            <tr><td style="padding:6px 0;font-weight:bold;">Time slot</td><td>${timeSlot}</td></tr>
          </table>
          ${safeMsg ? `<hr style="border:none;border-top:1px solid #ddd;margin:16px 0;"><p style="font-weight:bold;">Notes</p><p style="white-space:pre-wrap;">${safeMsg}</p>` : ''}
          <p style="font-size:12px;color:#999;margin-top:24px;">Reply directly to this email to respond to ${name}.</p>
        </div>
      </body>
      </html>
    `,
  };

  const info = await transporter.sendMail(mailOptions);
  console.log('Demo booking email sent to:', CONTACT_FORWARD_EMAIL);
  return { success: true, messageId: info.messageId };
}
