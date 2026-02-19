import dotenv from 'dotenv';
import crypto from 'crypto';
dotenv.config();

// Generate a random session secret if not provided
const generateSessionSecret = () => {
  return crypto.randomBytes(32).toString('hex');
};

export const config = {
  port: process.env.PORT || 8080,
  db: {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME || 'users'
  },
  sessionSecret: process.env.SESSION_SECRET || generateSessionSecret(),
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
  }
};

console.log(config);

