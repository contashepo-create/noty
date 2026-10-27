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

## Upgrading conversation security

Before deploying the updated Worker, create the conversation-lock table in the existing D1 database:

```bash
pnpm --filter supernoti-worker exec wrangler d1 execute supernoti-db --remote --file=./migrations/0001_conversation_locks.sql
pnpm --filter supernoti-worker exec wrangler deploy
```

Then run (or rerun) the **Deploy Web to GitHub Pages** workflow on `main`. The workflow checks `/deployment-readiness` on the configured `VITE_API_BASE_URL` before publishing. If the Worker or the table is not ready, the workflow stops and the previous Pages deployment remains live. The migration is additive and leaves existing notes, messages, attachments and account configuration unchanged. A new web build requires this updated Worker; without the table or Worker update, access to chat fails closed. If no API URL is configured, the workflow still supports the landing-only site.

The optional PIN is per account and protects its chat endpoints, not the other participant's access. PINs cannot be recovered in the app. An administrator can remove the relevant `conversation_locks` row to reset one without deleting messages. Disable PIN locks before rotating `SESSION_SECRET`, or reset and recreate them afterward.

## Chat Attachments

Chat attachments are stored in the `supernoti-attachments` R2 bucket. Before deploying a Worker version that supports chat attachments, apply the schema from `apps/worker`:

```bash
pnpm exec wrangler d1 execute supernoti-db --remote --file=./schema.sql
pnpm exec wrangler deploy
```

Each message can include up to five files, with a 10 MB limit per file. Supported formats include JPEG, PNG, GIF, WebP, PDF, TXT, DOC/DOCX, XLS/XLSX, and PPT/PPTX. Attachments are served only to participants in the conversation. Deleting a message or clearing a conversation removes it for both participants and deletes its stored attachments.

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
