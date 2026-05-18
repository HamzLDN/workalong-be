import { Router } from 'express';
import { sendDemoBookingEmail } from '../lib/email.js';

const router = Router();

router.post('/', async (req, res) => {
  try {
    const { name, email, company, date, timeSlot, message } = req.body || {};

    if (!name || !email || !date || !timeSlot) {
      return res.status(400).json({ error: 'Name, email, date and time slot are required.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(String(email).trim())) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    const chosenDate = new Date(date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (chosenDate < today) {
      return res.status(400).json({ error: 'Please choose a future date.' });
    }

    await sendDemoBookingEmail({
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      company: company ? String(company).trim() : null,
      date: String(date).trim(),
      timeSlot: String(timeSlot).trim(),
      message: message ? String(message).trim() : null,
    });

    res
      .status(200)
      .json({ message: 'Demo booked successfully! We will confirm your session by email.' });
  } catch (err) {
    console.error('Demo booking error:', err);
    res.status(500).json({ error: 'Failed to book demo. Please try again or email us directly.' });
  }
});

export default router;
