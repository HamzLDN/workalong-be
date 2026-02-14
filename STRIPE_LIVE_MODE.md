# Switching Stripe from Test Mode to Live Mode

To accept real payments, use **live** API keys and a **live** webhook. Test and live data are separate in Stripe.

---

## 1. Get your live keys from Stripe

1. Log in to [Stripe Dashboard](https://dashboard.stripe.com).
2. **Turn off Test mode** (toggle in the top right – it should say “Live” or show no test badge).
3. Go to **Developers → API keys**.
4. Copy:
   - **Publishable key** (starts with `pk_live_...`) – safe to use in frontend.
   - **Secret key** (starts with `sk_live_...`) – backend only, never commit or expose.

---

## 2. Set environment variables

Set these on your **production server** (or in your deployment env). Do **not** commit live keys to git.

| Variable | Description | Example |
|----------|-------------|---------|
| `STRIPE_SECRET_KEY` | Live secret key (backend) | `sk_live_...` |
| `STRIPE_PUBLISHABLE_KEY` | Live publishable key (returned to frontend via `/api/payment/config`) | `pk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for your **live** webhook (see step 3) | `whsec_...` |

**Examples:**

- **Docker / docker-compose:** Add to the `backend` service `environment` section:
  ```yaml
  environment:
    - STRIPE_SECRET_KEY=sk_live_...
    - STRIPE_PUBLISHABLE_KEY=pk_live_...
    - STRIPE_WEBHOOK_SECRET=whsec_...
  ```
  Or use an env file and reference it with `env_file:`.

- **Systemd / shell:** Export before starting the app:
  ```bash
  export STRIPE_SECRET_KEY=sk_live_...
  export STRIPE_PUBLISHABLE_KEY=pk_live_...
  export STRIPE_WEBHOOK_SECRET=whsec_...
  node index.js
  ```

- **.env file (local/production):** In `workalong-backend/.env`:
  ```
  STRIPE_SECRET_KEY=sk_live_...
  STRIPE_PUBLISHABLE_KEY=pk_live_...
  STRIPE_WEBHOOK_SECRET=whsec_...
  ```
  Ensure `.env` is in `.gitignore` and never committed.

The backend reads these in `config.js`; when set, they override any default test values.

---

## 3. Create a live webhook endpoint

Test and live webhooks are different. You need a **live** endpoint for production.

1. In Stripe Dashboard, stay in **Live** mode.
2. Go to **Developers → Webhooks**.
3. Click **Add endpoint**.
4. **Endpoint URL:** Your production API URL, e.g.  
   `https://api.workalong.co.uk/api/payment/webhook`  
   (must be HTTPS and reachable by Stripe).
5. **Events to send:** Select (or add) at least:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
6. Create the endpoint. Stripe will show a **Signing secret** (starts with `whsec_...`).
7. Put that value in `STRIPE_WEBHOOK_SECRET` (step 2). If you had a test webhook secret there before, replace it with this live one.

---

## 4. Restart the backend

After setting env vars and the live webhook secret, restart the backend so it loads the new keys:

```bash
# If using Docker
./update-server.sh
# or
docker compose -f workalong-backend/docker-compose.full.yml restart backend

# If running manually
# Stop the process, then:
cd workalong-backend && node index.js
```

---

## 5. Quick checklist

- [ ] Stripe Dashboard is in **Live** mode when copying keys and creating the webhook.
- [ ] `STRIPE_SECRET_KEY` is `sk_live_...` (not `sk_test_...`).
- [ ] `STRIPE_PUBLISHABLE_KEY` is `pk_live_...` (not `pk_test_...`).
- [ ] New **live** webhook created; its signing secret is in `STRIPE_WEBHOOK_SECRET`.
- [ ] Webhook URL is your production API base + `/api/payment/webhook`.
- [ ] Live keys and webhook secret are only in env (or a non-committed `.env`), not in code.
- [ ] Backend restarted after changing env.

---

## Test vs live summary

| Item | Test mode | Live mode |
|------|-----------|-----------|
| Publishable key | `pk_test_...` | `pk_live_...` |
| Secret key | `sk_test_...` | `sk_live_...` |
| Webhook | One endpoint (test) | Separate endpoint (live) |
| Webhook secret | `whsec_...` (test) | `whsec_...` (live) |
| Data | Fake customers/payments | Real customers/payments |

Your app does not have a “test/live” flag in code; it uses whichever keys you set in the environment. So “switching to live” = setting the three live env vars and restarting.
