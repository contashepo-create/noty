import assert from "node:assert/strict";
import test from "node:test";
import { checkWorkerReadiness } from "./check-worker-readiness.mjs";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("publishing allows the updated Worker only after its D1 schema is ready", async () => {
  let requested;
  await checkWorkerReadiness("https://worker.example/", async (url) => {
    requested = url;
    return json(200, { service: "supernoti-worker", chatLockSchema: 1 });
  });
  assert.equal(requested, "https://worker.example/deployment-readiness");
  for (const response of [
    json(404, { error: "not found" }),
    json(503, { service: "supernoti-worker", chatLockSchema: 0 }),
    json(200, { service: "some-other-worker", chatLockSchema: 1 }),
    new Response("not json", { status: 200 }),
  ]) {
    await assert.rejects(checkWorkerReadiness("https://worker.example", async () => response), /Worker is not ready/);
  }
  await assert.rejects(checkWorkerReadiness("https://worker.example", async () => { throw new Error("offline"); }), /Worker is not ready/);
});

test("without an API URL the existing landing-only deployment remains supported", async () => {
  await checkWorkerReadiness("", () => { throw new Error("fetch should not be called"); });
});
