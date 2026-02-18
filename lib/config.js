export const config = {
  port: process.env.PORT,
  db: {
    user: process.env.DB_USER || 'workalong',
    password: process.env.DB_PASSWORD || 'admin',
    host: process.env.DB_HOST || (process.env.DOCKER === 'true' ? 'postgres' : 'localhost'),
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'users'
  },
  sessionSecret: process.env.SESSION_SECRET || 'change-this-secret-key-in-production',
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || 'sk_test_51RgEjWIrkFfXWFRhlWBD0SFw484fvzlfwxGrU80Df3B8KkRUTDX2KoYrNCi2OyjRrqhoFwkyfz3M4DCjhcP3EoEZ00TNFod97f',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_51RgEjWIrkFfXWFRh5cxWlHWYsvfF5G7MSpnmJsRHQ2l9gtnUXQtSlNjjA8VpwLireb7GLXPBWAoCvci9luAM9WRG00bb74zGWB',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || 'whsec_YOUR_WEBHOOK_SECRET_HERE'
  }
};

