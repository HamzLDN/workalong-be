import { Router } from 'express';
import { sendContactFormEmail } from '../lib/email.js';

const router = Router();

router.post('/', async (req, res) => {
  try {
    const { name, email, company, subject, message } = req.body || {};
    if (!name || !email || !subject || !message) {
      return res.status(400).json({
        error: 'Name, email, subject and message are required'
      });
    }
    const trimmedName = String(name).trim();
    const trimmedEmail = String(email).trim().toLowerCase();
    const trimmedMessage = String(message).trim();
    if (!trimmedName || !trimmedEmail || !trimmedMessage) {
      return res.status(400).json({ error: 'Name, email and message cannot be empty' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    await sendContactFormEmail(
      trimmedName,
      trimmedEmail,
      company ? String(company).trim() : null,
      String(subject).trim() || 'other',
      trimmedMessage
    );

    res.status(200).json({ message: 'Message sent successfully' });
  } catch (err) {
    console.error('Contact form error:', err);
    res.status(500).json({ error: 'Failed to send message. Please try again later.' });
  }
});

export default router;
