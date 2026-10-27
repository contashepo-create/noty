# Deployment Instructions

## Setup Cloudflare (Free Tier)

1. Install Wrangler: `npm install -g wrangler` or use `npx wrangler`
2. Login: `wrangler login`
3. Create D1 database: `wrangler d1 create supernoti-db`
4. Create R2 bucket: `wrangler r2 bucket create supernoti-attachments`
5. Update wrangler.jsonc with the D1 database ID
6. Run migrations: `wrangler d1 execute supernoti-db --file=./apps/worker/schema.sql`

## GitHub Secrets

Add these secrets to your GitHub repo:
- `SUPERNOTI_USERS` - JSON: `[{"username":"user1","password":"pass1"},{"username":"user2","password":"pass2"}]`
- `CLOUDFLARE_API_TOKEN` - For deployment
- `CLOUDFLARE_ACCOUNT_ID`

## GitHub Pages

1. Go to repo Settings > Pages
2. Source: GitHub Actions
3. Push to main branch to trigger deployment

## Local Development

```bash
pnpm install
pnpm dev
```
