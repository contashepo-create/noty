import { fileURLToPath } from "node:url";

// Keep the current Pages deployment in place until its configured API understands
// the chat lock and the additive D1 migration has been applied.
export async function checkWorkerReadiness(apiBase, fetchImpl = fetch) {
  const base = apiBase?.trim().replace(/\/+$/, "");
  if (!base) {
    console.log("VITE_API_BASE_URL is not configured; publishing the landing-only build.");
    return;
  }
  let response;
  try {
    response = await fetchImpl(`${base}/deployment-readiness`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const status = await response.json();
    if (response.ok && status.service === "supernoti-worker" && status.chatLockSchema === 1) {
      console.log("Worker and conversation-lock schema are ready.");
      return;
    }
  } catch {
    // An unreachable API, an older Worker, and an invalid response are all unsafe.
  }
  throw new Error("Worker is not ready. Apply the conversation-lock D1 migration and deploy the updated Worker, then rerun this Pages workflow. The existing site has not been replaced.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  checkWorkerReadiness(process.env.VITE_API_BASE_URL).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
