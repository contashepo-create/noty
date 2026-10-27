# Deployment Instructions

## Setup Cloudflare (Free Tier)

1. Install Wrangler: `npm install -g wrangler` or use `npx wrangler`
2. Login: `wrangler login`
3. Create D1 database: `wrangler d1 create supernoti-db`
4. Create R2 bucket: `wrangler r2 bucket create supernoti-attachments`
5. Set the D1 database ID in `apps/worker/wrangler.jsonc`
6. Apply the database schema:
   `pnpm --filter supernoti-worker exec wrangler d1 execute supernoti-db --remote --file=./schema.sql`
7. From `apps/worker`, add Worker secrets with `pnpm exec wrangler secret put SUPERNOTI_USERS` and `pnpm exec wrangler secret put SESSION_SECRET`, then deploy with `pnpm exec wrangler deploy`.
8. Set the GitHub Actions repository variable `VITE_API_BASE_URL` to the deployed Worker URL and push to `main`.

## GitHub Secrets

Add these secrets to your GitHub repo:
- `CLOUDFLARE_API_TOKEN` - For deployment
- `CLOUDFLARE_ACCOUNT_ID`

`SUPERNOTI_USERS` and `SESSION_SECRET` are Worker secrets, not GitHub Actions secrets.

## GitHub Pages

1. Go to repo Settings > Pages
2. Source: GitHub Actions
3. Push to main branch to trigger deployment

## Local Development

```bash
pnpm install
pnpm dev
```
