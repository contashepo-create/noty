# SuperNoti

A privacy-focused, local-first notes app with private messaging between configured users.

## Features

- **Desktop app**: Electron, React, Vite, and TypeScript
- **Web interface**: Responsive Arabic notes workspace and sign-in page
- **Local notes**: Notes are saved in the current browser
- **Private messaging**: Cloudflare Worker API with Durable Object-backed message history
- **Authentication**: Accounts configured on the Worker; signed sessions expire after seven days

## Web development

Requirements: Node.js 20+ and pnpm 9+.

1. Install workspace packages with `pnpm install --ignore-scripts`. The desktop app's native SQLite dependency may require Visual Studio C++/ClangCL build tools if installing all lifecycle scripts.
2. Configure Cloudflare resources in `apps/worker/wrangler.jsonc`, including a real D1 database ID and the Durable Objects binding.
3. Configure the Worker secrets:

   ```powershell
   cd apps/worker
   pnpm exec wrangler secret put SUPERNOTI_USERS
   pnpm exec wrangler secret put SESSION_SECRET
   ```

   `SUPERNOTI_USERS` must be a JSON array, for example `[{"username":"user1","password":"..."} ,{"username":"user2","password":"..."}]`. Use two unique accounts and a long random value for `SESSION_SECRET`. Configure these secrets for both local development (`.dev.vars`) and the deployed Worker.

   For local development, create `apps/worker/.dev.vars` (this file is ignored by Git) with:

   ```dotenv
   SUPERNOTI_USERS='[{"username":"user1","password":"replace-me"},{"username":"user2","password":"replace-me-too"}]'
   SESSION_SECRET='replace-with-a-long-random-secret'
   ```

4. Start the API locally in one terminal: `pnpm --filter supernoti-worker dev`.
5. Start the web app in another terminal: `pnpm dev:web`, then open `http://127.0.0.1:5173`.

The Vite development server proxies `/api` requests to `http://127.0.0.1:8787`. In production, host the web app and route `/api` to the Worker, or configure an equivalent same-origin proxy. Messages are persisted by Cloudflare Durable Objects and refresh every three seconds. Notes currently remain local to each browser.

## Web access

The web interface is disguised as "Pixel Arcade". Click the title seven times rapidly to open the sign-in page.
