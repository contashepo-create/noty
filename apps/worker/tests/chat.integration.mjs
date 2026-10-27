// Run against an isolated local Wrangler/D1 instance, never production.
import assert from "node:assert/strict";
import test from "node:test";

const base = process.env.SUPERNOTI_TEST_URL || "http://127.0.0.1:8787";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) {
  throw new Error("These destructive integration tests may only target a local Worker.");
}

async function request(path, { token, chatToken, method = "GET", body, headers = {} } = {}) {
  const result = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(chatToken ? { "X-Chat-Unlock": chatToken } : {}),
      ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
  });
  const json = await result.clone().json().catch(() => ({}));
  return { status: result.status, json, response: result };
}

async function login(username) {
  const result = await request("/auth/login", { method: "POST", body: { username, password: "test-only-password" } });
  assert.equal(result.status, 200, `Configure the local test account ${username} in .dev.vars`);
  return result.json.token;
}

async function send(token, recipient, content, attachment = false) {
  const body = new FormData();
  body.append("recipient", recipient);
  body.append("content", content);
  if (attachment) body.append("files", new Blob(["attachment contents"], { type: "text/plain" }), "attachment.txt");
  const result = await request("/messages", { token, method: "POST", body });
  assert.equal(result.status, 201, JSON.stringify(result.json));
  return result.json.message;
}

async function messages(token, contact, chatToken) {
  const result = await request(`/messages/${contact}`, { token, chatToken });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.json.messages;
}

test("PIN protection, token revocation, participant isolation and permanent deletion", async () => {
  const readiness = await request("/deployment-readiness");
  assert.equal(readiness.status, 200);
  assert.deepEqual(readiness.json, { service: "supernoti-worker", chatLockSchema: 1 });
  assert.match(readiness.response.headers.get("cache-control"), /no-store/);
  const alice = await login("test-alice");
  const bob = await login("test-bob");
  const carol = await login("test-carol");
  for (const token of [alice, bob, carol]) {
    const status = await request("/conversation-lock", { token });
    assert.equal(status.json.enabled, false, "Use a fresh local database with unlocked test accounts");
    assert.equal((await request("/conversations", { token, method: "DELETE" })).status, 200);
  }

  const preflight = await request("/messages/test-bob", {
    method: "OPTIONS",
    headers: { Origin: "https://example.test", "Access-Control-Request-Method": "DELETE", "Access-Control-Request-Headers": "authorization,x-chat-unlock" },
  });
  assert.match(preflight.response.headers.get("access-control-allow-methods"), /DELETE/);
  assert.match(preflight.response.headers.get("access-control-allow-headers"), /X-Chat-Unlock/i);

  const attachmentMessage = await send(alice, "test-bob", "message with file", true);
  const attachmentPath = `/messages/${attachmentMessage.id}/attachments/${attachmentMessage.attachments[0].id}`;
  const attachmentResponse = await request(attachmentPath, { token: bob });
  assert.equal(attachmentResponse.status, 200);
  assert.match(attachmentResponse.response.headers.get("cache-control"), /no-store/);
  assert.equal((await request(`/messages/${attachmentMessage.id}`, { token: carol, method: "DELETE" })).status, 404, "Non-participants cannot delete messages");
  assert.equal((await messages(bob, "test-alice")).length, 1);
  assert.equal((await request("/conversation-lock", { token: alice, method: "POST", body: { pin: "12" } })).status, 400);
  assert.equal((await request("/conversation-lock", { token: alice, method: "POST", body: { pin: "8642" } })).status, 201);
  assert.equal((await request("/conversation-lock", { token: alice, method: "POST", body: { pin: "1111" } })).status, 409);

  for (const [path, method, body] of [
    ["/messages/test-bob", "GET", undefined],
    [attachmentPath, "GET", undefined],
    ["/messages", "POST", { recipient: "test-bob", content: "blocked" }],
    [`/messages/${attachmentMessage.id}`, "DELETE", undefined],
    ["/conversations/test-bob", "DELETE", undefined],
    ["/conversations", "DELETE", undefined],
  ]) {
    assert.equal((await request(path, { token: alice, method, body })).status, 423, `${method} ${path} must require the PIN`);
  }
  // Alice's lock is personal; it must not prevent Bob from accessing their conversation.
  assert.equal((await messages(bob, "test-alice")).length, 1);
  assert.equal((await request(attachmentPath, { token: bob })).status, 200);

  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal((await request("/conversation-lock/unlock", { token: alice, method: "POST", body: { pin: "0000" } })).status, 403);
  }
  const unlock = await request("/conversation-lock/unlock", { token: alice, method: "POST", body: { pin: "8642" } });
  assert.equal(unlock.status, 200, "The correct fifth attempt is allowed and resets the counter");
  const oldChatToken = unlock.json.unlockToken;
  assert.equal((await messages(alice, "test-bob", oldChatToken)).length, 1);
  assert.equal((await request("/notes", { token: oldChatToken })).status, 401, "Chat tokens cannot be used as login sessions");

  assert.equal((await request("/conversation-lock", { token: bob, method: "POST", body: { pin: "2468" } })).status, 201);
  assert.equal((await request("/messages/test-alice", { token: bob, chatToken: oldChatToken })).status, 423, "An unlock token is bound to its owner");
  assert.equal((await request("/conversation-lock", { token: bob, method: "DELETE", body: { pin: "2468" } })).status, 200);

  const changed = await request("/conversation-lock/change", { token: alice, method: "POST", body: { currentPin: "8642", newPin: "9753" } });
  assert.equal(changed.status, 200);
  assert.equal((await request("/messages/test-bob", { token: alice, chatToken: oldChatToken })).status, 423);
  assert.equal((await request("/conversation-lock/unlock", { token: alice, method: "POST", body: { pin: "8642" } })).status, 403);
  let currentChatToken = changed.json.unlockToken;
  assert.equal((await request("/conversation-lock/lock", { token: alice, chatToken: currentChatToken, method: "POST" })).status, 200);
  assert.equal((await request("/messages/test-bob", { token: alice, chatToken: currentChatToken })).status, 423);
  currentChatToken = (await request("/conversation-lock/unlock", { token: alice, method: "POST", body: { pin: "9753" } })).json.unlockToken;
  assert.ok(currentChatToken);
  assert.equal((await request("/conversation-lock", { token: alice, method: "DELETE", body: { pin: "0000" } })).status, 403);
  assert.equal((await request("/conversation-lock", { token: alice, method: "DELETE", body: { pin: "9753" } })).status, 200);
  assert.equal((await messages(alice, "test-bob")).length, 1);

  assert.equal((await request(`/messages/${attachmentMessage.id}`, { token: alice, method: "DELETE" })).status, 200);
  assert.equal((await messages(bob, "test-alice")).length, 0, "Deleting one message affects both participants");
  assert.equal((await request(attachmentPath, { token: bob })).status, 404);
  assert.equal((await request(`/messages/${attachmentMessage.id}`, { token: carol, method: "DELETE" })).status, 404);

  await send(alice, "test-bob", "clear this pair", true);
  await send(alice, "test-carol", "keep this pair");
  await send(bob, "test-carol", "not Alice's conversation");
  assert.equal((await request("/conversations/test-bob", { token: alice, method: "DELETE" })).status, 200);
  assert.equal((await messages(alice, "test-bob")).length, 0);
  assert.equal((await messages(bob, "test-alice")).length, 0);
  assert.equal((await messages(alice, "test-carol")).length, 1);
  await send(alice, "test-bob", "also clear this", true);
  assert.equal((await request("/conversations", { token: alice, method: "DELETE" })).status, 200);
  assert.equal((await messages(alice, "test-bob")).length, 0);
  assert.equal((await messages(alice, "test-carol")).length, 0);
  assert.equal((await messages(bob, "test-carol")).length, 1, "Unrelated conversations must remain intact");
  assert.equal((await request("/conversations", { token: bob, method: "DELETE" })).status, 200);
});

test("stale note writes are rejected instead of silently reported as saved", async () => {
  const alice = await login("test-alice");
  const now = Date.now();
  const note = { id: "test-stale-write", title: "Current", content: "newer version", createdAt: now, updatedAt: now + 60_000 };
  assert.equal((await request("/notes", { token: alice, method: "POST", body: note })).status, 200);
  const stale = { ...note, content: "older offline edit", updatedAt: now };
  assert.equal((await request("/notes", { token: alice, method: "POST", body: stale })).status, 409);
  const saved = await request("/notes", { token: alice });
  assert.equal(saved.json.notes.find((entry) => entry.id === note.id).content, "newer version");
  assert.equal((await request(`/notes/${note.id}`, { token: alice, method: "DELETE" })).status, 200);
});

test("long conversations show the latest 500 messages and retain all attachments", async () => {
  const alice = await login("test-alice");
  const bob = await login("test-bob");
  assert.equal((await request("/conversations", { token: alice, method: "DELETE" })).status, 200);
  await send(alice, "test-bob", "oldest-message");
  for (let offset = 0; offset < 500; offset += 10) {
    const responses = await Promise.all(Array.from({ length: 10 }, (_, index) => request("/messages", {
      token: alice, method: "POST", body: { recipient: "test-bob", content: `message-${offset + index}` },
    })));
    assert.ok(responses.every((response) => response.status === 201));
  }
  const form = new FormData();
  form.append("recipient", "test-bob");
  form.append("content", "latest-with-files");
  for (let index = 0; index < 5; index++) {
    form.append("files", new Blob([`file ${index}`], { type: "text/plain" }), `file-${index}.txt`);
  }
  assert.equal((await request("/messages", { token: alice, method: "POST", body: form })).status, 201);
  const history = await messages(bob, "test-alice");
  assert.equal(history.length, 500);
  assert.ok(!history.some((entry) => entry.content === "oldest-message"));
  assert.equal(history.find((entry) => entry.content === "latest-with-files").attachments.length, 5);
  assert.equal((await request("/conversations", { token: alice, method: "DELETE" })).status, 200);
});
