import dotenv from 'dotenv';
import crypto from 'crypto';
import { exit } from 'process';
dotenv.config();

// Generate a random session secret if not provided
const generateSessionSecret = () => {
  return crypto.randomBytes(32).toString('hex');
};

if (process.env.NODE_ENV === 'dev') {
  process.env.DB_PORT = 5433;
  process.env.PORT = 8081;
} else {
  process.env.DB_PORT = 5432;
  process.env.PORT = 8080;
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

console.log(config);
