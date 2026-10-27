# SuperNoti

A privacy-focused, local-first notes app with private messaging between configured users.

## Features

- **Desktop app**: Electron, React, Vite, and TypeScript
- **Web interface**: Responsive Arabic notes workspace and sign-in page
- **Cloud notes and messages**: Stored per user in Cloudflare D1
- **Authentication**: Accounts configured on the Worker; signed sessions expire after seven days

## Web development

Requirements: Node.js 20+ and pnpm 9+.

1. Install workspace packages with `pnpm install --ignore-scripts`. The desktop app's native SQLite dependency may require Visual Studio C++/ClangCL build tools if installing all lifecycle scripts.
2. Log in to Cloudflare with `pnpm --filter supernoti-worker exec wrangler login`. The project uses D1 database `supernoti-db`; its ID is recorded in `apps/worker/wrangler.jsonc`.
3. For local development, create `apps/worker/.dev.vars` (ignored by Git) with:

   ```dotenv
   SUPERNOTI_USERS='[{"username":"user1","password":"replace-me"},{"username":"user2","password":"replace-me-too"}]'
   SESSION_SECRET='replace-with-a-long-random-secret'
   ```

4. Apply the schema to the Cloudflare database: `pnpm --filter supernoti-worker exec wrangler d1 execute supernoti-db --remote --file=./schema.sql`.
5. From `apps/worker`, add authentication secrets and deploy the API:

   ```powershell
   cd apps/worker
   pnpm exec wrangler secret put SUPERNOTI_USERS
   pnpm exec wrangler secret put SESSION_SECRET
   pnpm exec wrangler deploy
   ```

   Wrangler prompts for each value. Enter `SUPERNOTI_USERS` as a JSON array containing the two account usernames and passwords. Use a long, unique random value for `SESSION_SECRET`.

6. Set the GitHub repository variable `VITE_API_BASE_URL` to `https://supernoti-worker.mobileshop2026.workers.dev` under **Settings → Secrets and variables → Actions → Variables**.
7. Start the API locally in one terminal: `pnpm --filter supernoti-worker dev`.
8. Start the web app in another terminal: `pnpm dev:web`, then open `http://127.0.0.1:5173`.

The Vite development server proxies `/api` requests to `http://127.0.0.1:8787`. The deployed Worker persists notes and private messages in Cloudflare D1. Existing browser-cached notes are imported when that user's D1 account has no notes. GitHub Pages uses the `/noty/` base path; the search page works without the API, but login and cloud storage require the repository variable `VITE_API_BASE_URL` to point to the deployed Worker. Messages refresh every three seconds.

## Web access

The public landing page is a generic search interface. Click its logo eight times within 2.5 seconds to open sign-in. The gesture is held in memory only and is not written to notes or browser storage.
