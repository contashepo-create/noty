# SuperNoti

A privacy-focused, local-first notes app with private messaging between configured users.

## Features

- **Desktop app**: Electron, React, Vite, and TypeScript
- **Web interface**: Responsive Arabic notes workspace and sign-in page
- **Cloud notes and messages**: Stored per user in Cloudflare D1
- **Authentication**: Accounts configured on the Worker; signed sessions expire after seven days
- **Private support**: Optional per-account PIN lock, with options to delete one message, one conversation, or all conversations
- **Mobile notes**: Responsive editor with an explicit save-and-close action and automatic local/cloud saving

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

The Vite development server proxies `/api` requests to `http://127.0.0.1:8787`. The deployed Worker persists notes and private messages in Cloudflare D1. Existing browser-cached notes are imported once when an account is first connected and its D1 account has no notes; subsequent offline edits are retried separately. GitHub Pages uses the `/noty/` base path; the search page works without the API, but login and cloud storage require the repository variable `VITE_API_BASE_URL` to point to the deployed Worker. Messages refresh every three seconds and show the most recent 500 messages.

## Web access

The public landing page is a generic search interface. Click its logo eight times within 2.5 seconds to open sign-in. The gesture is held in memory only and is not written to notes or browser storage.


## Upgrading an existing deployment

The conversation lock requires a new D1 table. **Apply the migration before deploying the updated Worker and web app**; without it the Worker cannot check the lock state and chat access fails closed. The migration only creates the new table and does not delete existing data.

```bash
pnpm --filter supernoti-worker exec wrangler d1 execute supernoti-db --remote --file=./migrations/0001_conversation_locks.sql
pnpm --filter supernoti-worker exec wrangler deploy
pnpm --filter supernoti-web build
```

Publish the web build using the **Deploy Web to GitHub Pages** workflow on `main`. The workflow checks the configured Worker and migration before publishing; if either is missing, it stops without replacing the current site. After updating the Worker, rerun the failed workflow (or trigger it manually). With no `VITE_API_BASE_URL` configured, the workflow still permits a landing-only deployment. The Worker must be updated as well as the web app; changing only the static site is not sufficient.

## Conversation privacy and deletion

The optional 4–8 digit PIN protects the signed-in account's chat API, including attachments, sending and deletion, across devices. It does not change the other participant's access and is not end-to-end encryption. The PIN is stored as a salted PBKDF2 hash with a server-side secret; five incorrect attempts temporarily block further attempts for five minutes. Unlocks are kept in memory, expire after one hour, and are revoked when the user locks chat or leaves the support screen. Locking revokes other currently unlocked chat sessions for the same account as well.

Choose a PIN you can remember: the application cannot recover it. An administrator with access to D1 can remove that account's row from `conversation_locks` to reset the lock without deleting messages. Because the Worker `SESSION_SECRET` also protects the PIN hash, disable existing PIN locks before rotating that secret; otherwise an administrator must reset the affected lock rows and users must set new PINs.

Deleting an individual message or clearing a conversation permanently removes it **for both participants**, including its stored attachments. Clearing all conversations affects every conversation involving the current account. Each destructive action requires confirmation.

Notes continue to save automatically. **Save and close** first saves to browser storage and then syncs to D1; if the network is unavailable, the locally changed note is retained and retried when connectivity returns or the next time the account loads. If a newer cloud version conflicts with a pending local edit, the next sign-in keeps the cloud note and saves the local edit as a separate copy.

## Tests

The integration and browser tests perform destructive actions and are restricted to local servers. Use a separate local D1 state and these dedicated test accounts in `apps/worker/.dev.vars` (do not use them in production):

```dotenv
SUPERNOTI_USERS='[{"username":"test-alice","password":"test-only-password"},{"username":"test-bob","password":"test-only-password"},{"username":"test-carol","password":"test-only-password"}]'
SESSION_SECRET='local-test-secret-only'
```

```bash
pnpm --filter supernoti-worker exec wrangler d1 execute supernoti-db --local --persist-to .wrangler/test-state --file=./schema.sql
# In separate terminals:
pnpm --filter supernoti-worker exec wrangler dev --local --persist-to .wrangler/test-state
pnpm dev:web
# After both servers are ready:
pnpm --filter supernoti-worker test:integration
node --test scripts/check-worker-readiness.test.mjs
pnpm --filter supernoti-web exec playwright install chromium
pnpm --filter supernoti-web test:e2e
```
