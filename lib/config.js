import dotenv from 'dotenv';
import crypto from 'crypto';
import { exit } from 'process';
dotenv.config();

const generateSessionSecret = () => {
  return crypto.randomBytes(32).toString('hex');
};

if (process.env.NODE_ENV === 'dev') {
  if (!process.env.DB_PORT) process.env.DB_PORT = '5433';
  process.env.PORT = process.env.DEV_PORT;
} else {
  if (!process.env.DB_PORT) process.env.DB_PORT = '5432';
  if (!process.env.PORT) process.env.PORT = '8080';
}
export const config = {
  port: process.env.PORT,
  db: {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
  },
  sessionSecret: process.env.SESSION_SECRET || generateSessionSecret(),
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
  },
};

