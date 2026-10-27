import { Hono } from "hono";
import type { Context, Next } from "hono";
import { cors } from "hono/cors";

type ConfiguredUser = { username: string; password: string };
type ChatMessage = {
  id: string;
  sender: string;
  recipient: string;
  content: string;
  createdAt: number;
  attachments: ChatAttachment[];
};
type ChatAttachment = { id: string; filename: string; contentType: string; size: number };
type ChatMessageRow = Omit<ChatMessage, "attachments"> & {
  attachmentId: string | null;
  attachmentFilename: string | null;
  attachmentContentType: string | null;
  attachmentSize: number | null;
};

type Bindings = {
  DB: D1Database;
  BUCKET: R2Bucket;
  SUPERNOTI_USERS: string;
  SESSION_SECRET: string;
};

const encoder = new TextEncoder();
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000;
const CHAT_TOKEN_DURATION = 60 * 60 * 1000;
const PIN_ITERATIONS = 100_000;
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_DURATION = 5 * 60 * 1000;
const MAX_ATTACHMENT_COUNT = 5;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const ATTACHMENT_TYPES: Record<string, string> = {
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

async function deleteStoredAttachments(bucket: R2Bucket, keys: string[]): Promise<number> {
  // R2 accepts up to 1,000 keys per request; avoid one subrequest per attachment.
  let failures = 0;
  for (let index = 0; index < keys.length; index += 1000) {
    const batch = keys.slice(index, index + 1000);
    try { await bucket.delete(batch); }
    catch (error) {
      failures += batch.length;
      console.error("Could not delete a batch of message attachments from R2", error);
    }
  }
  return failures;
}

// Delete R2 objects before their database references so a failed cleanup can be retried.
// The ID snapshot also leaves messages sent during the operation untouched.
async function deleteMessages(db: D1Database, bucket: R2Bucket, ids: string[]): Promise<boolean> {
  if (!ids.length) return true;
  const messageIds = JSON.stringify(ids);
  const attachments = await db.prepare(
    "SELECT object_key AS objectKey FROM message_attachments WHERE message_id IN (SELECT value FROM json_each(?))",
  ).bind(messageIds).all<{ objectKey: string }>();
  const failures = await deleteStoredAttachments(bucket, attachments.results.map(({ objectKey }) => objectKey));
  if (failures) return false;
  await db.batch([
    db.prepare("DELETE FROM message_attachments WHERE message_id IN (SELECT value FROM json_each(?))").bind(messageIds),
    db.prepare("DELETE FROM messages WHERE id IN (SELECT value FROM json_each(?))").bind(messageIds),
  ]);
  return true;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

type LockRow = { salt: string; pinHash: string; version: string; failedAttempts: number; lockedUntil: number };
type AppContext = Context<{ Bindings: Bindings }>;

function isValidPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^[0-9]{4,8}$/.test(pin);
}

function randomSalt(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

async function hashPin(pin: string, salt: string, secret: string): Promise<Uint8Array> {
  // The Worker secret is a server-side pepper; a stolen database alone cannot verify PIN guesses.
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(`${secret}\0${pin}`), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(base64UrlDecode(salt)), iterations: PIN_ITERATIONS },
    key, 256,
  );
  return new Uint8Array(bits);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function createChatToken(owner: string, version: string, secret: string): Promise<string> {
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({
    owner, version, expiresAt: Date.now() + CHAT_TOKEN_DURATION,
  })));
  const signature = await crypto.subtle.sign(
    "HMAC", await getSigningKey(secret, ["sign"]), encoder.encode(`chat-lock:${payload}`),
  );
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifyChatToken(token: string | undefined, owner: string, version: string, secret: string): Promise<boolean> {
  if (!token) return false;
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return false;
    const valid = await crypto.subtle.verify(
      "HMAC", await getSigningKey(secret, ["verify"]), toArrayBuffer(base64UrlDecode(signature)),
      encoder.encode(`chat-lock:${payload}`),
    );
    if (!valid) return false;
    const decoded: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (!decoded || typeof decoded !== "object") return false;
    const value = decoded as { owner?: unknown; version?: unknown; expiresAt?: unknown };
    return value.owner === owner && value.version === version &&
      typeof value.expiresAt === "number" && value.expiresAt > Date.now();
  } catch {
    return false;
  }
}

// Reserve an attempt atomically before doing the expensive hash, so parallel guesses
// cannot bypass the limit. A correct fifth attempt is still accepted.
async function verifyLockPin(db: D1Database, username: string, pin: string, secret: string): Promise<
  { ok: true; version: string } | { ok: false; status: 403 | 404 | 429; error: string }
> {
  const now = Date.now();
  const lock = await db.prepare(
    `UPDATE conversation_locks
     SET failed_attempts = CASE WHEN locked_until > 0 AND locked_until <= ? THEN 1 ELSE failed_attempts + 1 END,
         locked_until = CASE
           WHEN (CASE WHEN locked_until > 0 AND locked_until <= ? THEN 1 ELSE failed_attempts + 1 END) >= ?
           THEN ? ELSE 0 END
     WHERE owner_username = ? AND locked_until <= ?
     RETURNING salt, pin_hash AS pinHash, version, failed_attempts AS failedAttempts, locked_until AS lockedUntil`,
  ).bind(now, now, MAX_PIN_ATTEMPTS, now + PIN_LOCKOUT_DURATION, username, now).first<LockRow>();

  if (!lock) {
    const existing = await db.prepare("SELECT locked_until AS lockedUntil FROM conversation_locks WHERE owner_username = ?")
      .bind(username).first<{ lockedUntil: number }>();
    return existing
      ? { ok: false, status: 429, error: "محاولات كثيرة. انتظر ٥ دقائق ثم حاول مجددًا." }
      : { ok: false, status: 404, error: "قفل المحادثات غير مفعّل." };
  }

  const valid = equalBytes(await hashPin(pin, lock.salt, secret), base64UrlDecode(lock.pinHash));
  if (!valid) {
    return lock.lockedUntil > now
      ? { ok: false, status: 429, error: "محاولات كثيرة. انتظر ٥ دقائق ثم حاول مجددًا." }
      : { ok: false, status: 403, error: "الرمز السري غير صحيح." };
  }
  const reset = await db.prepare(
    "UPDATE conversation_locks SET failed_attempts = 0, locked_until = 0 WHERE owner_username = ? AND version = ?",
  ).bind(username, lock.version).run();
  if (!reset.meta.changes) return { ok: false, status: 403, error: "تغيّر رمز القفل. حاول مجددًا." };
  return { ok: true, version: lock.version };
}

async function requireChatAccess(c: AppContext, next: Next): Promise<Response | void> {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);
  const lock = await c.env.DB.prepare("SELECT version FROM conversation_locks WHERE owner_username = ?")
    .bind(username).first<{ version: string }>();
  if (lock && !await verifyChatToken(c.req.header("X-Chat-Unlock"), username, lock.version, c.env.SESSION_SECRET)) {
    return c.json({ error: "المحادثات مقفلة. أدخل الرمز السري لفتحها." }, 423);
  }
  await next();
}

async function getSigningKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

async function createToken(username: string, secret: string): Promise<string> {
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({ username, expiresAt: Date.now() + SESSION_DURATION })));
  const signature = await crypto.subtle.sign("HMAC", await getSigningKey(secret, ["sign"]), encoder.encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifyToken(token: string, secret: string): Promise<string | null> {
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    const valid = await crypto.subtle.verify("HMAC", await getSigningKey(secret, ["verify"]), toArrayBuffer(base64UrlDecode(signature)), encoder.encode(payload));
    if (!valid) return null;
    const decoded: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (!decoded || typeof decoded !== "object" || !("username" in decoded) || !("expiresAt" in decoded)) return null;
    const session = decoded as { username: unknown; expiresAt: unknown };
    if (typeof session.username !== "string" || typeof session.expiresAt !== "number" || session.expiresAt <= Date.now()) return null;
    return session.username;
  } catch {
    return null;
  }
}

function configuredUsers(value: string): ConfiguredUser[] | null {
  try {
    const users: unknown = JSON.parse(value);
    if (!Array.isArray(users) || users.some((user) =>
      !user || typeof user.username !== "string" || typeof user.password !== "string")) return null;
    return users as ConfiguredUser[];
  } catch {
    return null;
  }
}

async function authenticatedUsername(request: Request, secret: string): Promise<string | null> {
  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer (.+)$/);
  return match ? verifyToken(match[1], secret) : null;
}

const app = new Hono<{ Bindings: Bindings }>();

app.use("/*", cors({
  origin: "*",
  allowHeaders: ["Content-Type", "Authorization", "X-Chat-Unlock"],
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
}));

app.get("/", (c) => c.json({ status: "ok", service: "supernoti-worker", name: "SuperNoti" }));

// Pages checks this before publishing a web build that depends on conversation locking.
// LIMIT 0 verifies the migrated columns without reading or exposing any account data.
app.get("/deployment-readiness", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!c.env.SESSION_SECRET || !c.env.DB) {
    return c.json({ service: "supernoti-worker", chatLockSchema: 0 }, 503);
  }
  try {
    await c.env.DB.prepare(
      "SELECT owner_username, salt, pin_hash, version, failed_attempts, locked_until FROM conversation_locks LIMIT 0",
    ).all();
    return c.json({ service: "supernoti-worker", chatLockSchema: 1 });
  } catch {
    return c.json({ service: "supernoti-worker", chatLockSchema: 0 }, 503);
  }
});

app.post("/auth/login", async (c) => {
  const users = configuredUsers(c.env.SUPERNOTI_USERS || "[]");
  if (!users || users.length === 0) return c.json({ error: "حسابات الدخول غير مهيأة على الخادم" }, 503);
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);

  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || !("username" in body) || !("password" in body)) {
    return c.json({ error: "Username and password are required" }, 400);
  }
  const { username, password } = body as { username: unknown; password: unknown };
  if (typeof username !== "string" || typeof password !== "string") {
    return c.json({ error: "Username and password are required" }, 400);
  }
  const user = users.find((candidate) => candidate.username === username && candidate.password === password);
  if (!user) return c.json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" }, 401);

  return c.json({
    token: await createToken(user.username, c.env.SESSION_SECRET),
    user: { username: user.username, id: user.username },
  });
});

app.get("/users", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);
  const users = configuredUsers(c.env.SUPERNOTI_USERS || "[]");
  if (!users) return c.json({ error: "إعدادات المستخدمين غير صالحة على الخادم" }, 500);
  return c.json({ users: users.filter((user) => user.username !== username).map((user) => user.username) });
});

app.get("/notes", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);

  const result = await c.env.DB.prepare(
    "SELECT id, title, content, created_at AS createdAt, updated_at AS updatedAt FROM user_notes WHERE owner_username = ? ORDER BY updated_at DESC",
  ).bind(username).all<{
    id: string;
    title: string;
    content: string;
    createdAt: number;
    updatedAt: number;
  }>();
  return c.json({ notes: result.results });
});

app.post("/notes", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);

  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || !("id" in body) || !("title" in body) ||
      !("content" in body) || !("updatedAt" in body)) {
    return c.json({ error: "بيانات الملاحظة غير مكتملة" }, 400);
  }
  const note = body as { id: unknown; title: unknown; content: unknown; createdAt?: unknown; updatedAt: unknown };
  if (typeof note.id !== "string" || !note.id || note.id.length > 128 ||
      typeof note.title !== "string" || note.title.length > 500 ||
      typeof note.content !== "string" || note.content.length > 100_000 ||
      typeof note.updatedAt !== "number" || !Number.isSafeInteger(note.updatedAt) ||
      (note.createdAt !== undefined && (typeof note.createdAt !== "number" || !Number.isSafeInteger(note.createdAt)))) {
    return c.json({ error: "بيانات الملاحظة غير صالحة" }, 400);
  }

  const createdAt = typeof note.createdAt === "number" ? note.createdAt : note.updatedAt;
  const saved = await c.env.DB.prepare(
    `INSERT INTO user_notes (id, owner_username, title, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id, owner_username) DO UPDATE SET
       title = excluded.title,
       content = excluded.content,
       updated_at = excluded.updated_at
     WHERE excluded.updated_at >= user_notes.updated_at`,
  ).bind(note.id, username, note.title, note.content, createdAt, note.updatedAt).run();
  // Do not tell the client a stale edit was saved when the upsert rejected it.
  if (!saved.meta.changes) return c.json({ error: "تغيّرت الملاحظة على جهاز آخر. احتُفظ بنسختك المحلية." }, 409);
  return c.json({ success: true });
});

app.delete("/notes/:id", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);
  await c.env.DB.prepare("DELETE FROM user_notes WHERE id = ? AND owner_username = ?")
    .bind(c.req.param("id"), username)
    .run();
  return c.json({ success: true });
});

// Do not cache chat contents, attachment metadata or lock state in browsers or intermediaries.
const noChatCache = async (c: AppContext, next: Next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
};
app.use("/conversation-lock", noChatCache);
app.use("/conversation-lock/*", noChatCache);
app.use("/messages", noChatCache);
app.use("/messages/*", noChatCache);
app.use("/conversations", noChatCache);
app.use("/conversations/*", noChatCache);

// Lock settings are scoped to the signed-in user, not to the other chat participant.
app.get("/conversation-lock", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);
  const lock = await c.env.DB.prepare("SELECT locked_until AS lockedUntil FROM conversation_locks WHERE owner_username = ?")
    .bind(username).first<{ lockedUntil: number }>();
  return c.json({ enabled: Boolean(lock), lockedUntil: lock?.lockedUntil ?? 0 });
});

app.post("/conversation-lock", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);
  const body = await c.req.json<{ pin?: unknown }>().catch(() => null);
  if (!isValidPin(body?.pin)) return c.json({ error: "اختر رمزًا من ٤ إلى ٨ أرقام." }, 400);
  const salt = randomSalt();
  const pinHash = base64UrlEncode(await hashPin(body.pin, salt, c.env.SESSION_SECRET));
  const result = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO conversation_locks (owner_username, salt, pin_hash, version) VALUES (?, ?, ?, ?)",
  ).bind(username, salt, pinHash, crypto.randomUUID()).run();
  if (!result.meta.changes) return c.json({ error: "قفل المحادثات مفعّل بالفعل." }, 409);
  return c.json({ success: true }, 201);
});

app.post("/conversation-lock/unlock", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);
  const body = await c.req.json<{ pin?: unknown }>().catch(() => null);
  if (!isValidPin(body?.pin)) return c.json({ error: "أدخل رمزًا من ٤ إلى ٨ أرقام." }, 400);
  const result = await verifyLockPin(c.env.DB, username, body.pin, c.env.SESSION_SECRET);
  if (result.ok === false) return c.json({ error: result.error }, result.status);
  return c.json({ unlockToken: await createChatToken(username, result.version, c.env.SESSION_SECRET) });
});

app.post("/conversation-lock/change", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);
  const body = await c.req.json<{ currentPin?: unknown; newPin?: unknown }>().catch(() => null);
  if (!isValidPin(body?.currentPin) || !isValidPin(body?.newPin)) {
    return c.json({ error: "يجب أن يتكون الرمز من ٤ إلى ٨ أرقام." }, 400);
  }
  const verified = await verifyLockPin(c.env.DB, username, body.currentPin, c.env.SESSION_SECRET);
  if (verified.ok === false) return c.json({ error: verified.error }, verified.status);
  const salt = randomSalt();
  const hash = base64UrlEncode(await hashPin(body.newPin, salt, c.env.SESSION_SECRET));
  const version = crypto.randomUUID();
  const result = await c.env.DB.prepare(
    "UPDATE conversation_locks SET salt = ?, pin_hash = ?, version = ?, failed_attempts = 0, locked_until = 0 WHERE owner_username = ? AND version = ?",
  ).bind(salt, hash, version, username, verified.version).run();
  if (!result.meta.changes) return c.json({ error: "تغيّر رمز القفل. حاول مجددًا." }, 409);
  return c.json({ unlockToken: await createChatToken(username, version, c.env.SESSION_SECRET) });
});

app.delete("/conversation-lock", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);
  const body = await c.req.json<{ pin?: unknown }>().catch(() => null);
  if (!isValidPin(body?.pin)) return c.json({ error: "أدخل رمزًا من ٤ إلى ٨ أرقام." }, 400);
  const verified = await verifyLockPin(c.env.DB, username, body.pin, c.env.SESSION_SECRET);
  if (verified.ok === false) return c.json({ error: verified.error }, verified.status);
  const result = await c.env.DB.prepare("DELETE FROM conversation_locks WHERE owner_username = ? AND version = ?")
    .bind(username, verified.version).run();
  if (!result.meta.changes) return c.json({ error: "تغيّر رمز القفل. حاول مجددًا." }, 409);
  return c.json({ success: true });
});

app.post("/conversation-lock/lock", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);
  const lock = await c.env.DB.prepare("SELECT version FROM conversation_locks WHERE owner_username = ?")
    .bind(username).first<{ version: string }>();
  if (!lock) return c.json({ success: true });
  if (!await verifyChatToken(c.req.header("X-Chat-Unlock"), username, lock.version, c.env.SESSION_SECRET)) {
    return c.json({ error: "المحادثات مقفلة بالفعل." }, 423);
  }
  await c.env.DB.prepare("UPDATE conversation_locks SET version = ? WHERE owner_username = ? AND version = ?")
    .bind(crypto.randomUUID(), username, lock.version).run();
  return c.json({ success: true });
});

// Protect message contents, attachments, sending, and both kinds of deletion.
app.use("/messages", requireChatAccess);
app.use("/messages/*", requireChatAccess);
app.use("/conversations", requireChatAccess);
app.use("/conversations/*", requireChatAccess);

app.get("/messages/:username", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);
  const recipient = c.req.param("username");
  const users = configuredUsers(c.env.SUPERNOTI_USERS || "[]");
  if (!users) return c.json({ error: "إعدادات المستخدمين غير صالحة على الخادم" }, 500);
  if (!users.some((user) => user.username === username) || !users.some((user) => user.username === recipient) || username === recipient) {
    return c.json({ error: "المستخدم غير متاح" }, 404);
  }

  const result = await c.env.DB.prepare(
    `WITH recent_messages AS (
       SELECT id, sender_username, recipient_username, content, created_at
       FROM messages
       WHERE (sender_username = ? AND recipient_username = ?)
          OR (sender_username = ? AND recipient_username = ?)
       ORDER BY created_at DESC, id DESC
       LIMIT 500
     )
     SELECT messages.id, messages.sender_username AS sender, messages.recipient_username AS recipient,
            messages.content, messages.created_at AS createdAt,
            message_attachments.id AS attachmentId, message_attachments.filename AS attachmentFilename,
            message_attachments.content_type AS attachmentContentType, message_attachments.size AS attachmentSize
     FROM recent_messages AS messages
     LEFT JOIN message_attachments ON message_attachments.message_id = messages.id
     ORDER BY messages.created_at ASC, messages.id ASC, message_attachments.filename ASC`,
  ).bind(username, recipient, recipient, username).all<ChatMessageRow>();
  const messages = new Map<string, ChatMessage>();
  for (const row of result.results) {
    let message = messages.get(row.id);
    if (!message) {
      message = {
        id: row.id,
        sender: row.sender,
        recipient: row.recipient,
        content: row.content,
        createdAt: row.createdAt,
        attachments: [],
      };
      messages.set(row.id, message);
    }
    if (row.attachmentId && row.attachmentFilename && row.attachmentContentType && row.attachmentSize !== null) {
      message.attachments.push({
        id: row.attachmentId,
        filename: row.attachmentFilename,
        contentType: row.attachmentContentType,
        size: row.attachmentSize,
      });
    }
  }
  return c.json({ messages: Array.from(messages.values()) });
});

app.delete("/messages/:messageId", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);

  const messageId = c.req.param("messageId");
  const message = await c.env.DB.prepare(
    "SELECT id FROM messages WHERE id = ? AND (sender_username = ? OR recipient_username = ?)",
  ).bind(messageId, username, username).first<{ id: string }>();
  if (!message) return c.json({ error: "الرسالة غير متاحة" }, 404);

  if (!await deleteMessages(c.env.DB, c.env.BUCKET, [messageId])) {
    return c.json({ error: "تعذر حذف بعض المرفقات. لم تُحذف الرسالة؛ حاول مجددًا." }, 502);
  }
  return c.json({ success: true });
});

app.delete("/conversations", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);
  const messages = await c.env.DB.prepare(
    "SELECT id FROM messages WHERE sender_username = ? OR recipient_username = ?",
  ).bind(username, username).all<{ id: string }>();
  if (!await deleteMessages(c.env.DB, c.env.BUCKET, messages.results.map(({ id }) => id))) {
    return c.json({ error: "تعذر حذف بعض المرفقات. لم تُحذف المحادثات؛ حاول مجددًا." }, 502);
  }
  return c.json({ success: true });
});

app.delete("/conversations/:username", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);

  const recipient = c.req.param("username");
  const users = configuredUsers(c.env.SUPERNOTI_USERS || "[]");
  if (!users) return c.json({ error: "إعدادات المستخدمين غير صالحة على الخادم" }, 500);
  if (username === recipient || !users.some((user) => user.username === username) ||
      !users.some((user) => user.username === recipient)) {
    return c.json({ error: "المستخدم غير متاح" }, 404);
  }

  const messages = await c.env.DB.prepare(
    `SELECT id FROM messages
     WHERE (sender_username = ? AND recipient_username = ?)
        OR (sender_username = ? AND recipient_username = ?)`,
  ).bind(username, recipient, recipient, username).all<{ id: string }>();
  if (!await deleteMessages(c.env.DB, c.env.BUCKET, messages.results.map(({ id }) => id))) {
    return c.json({ error: "تعذر حذف بعض المرفقات. لم تُحذف المحادثة؛ حاول مجددًا." }, 502);
  }
  return c.json({ success: true });
});

app.get("/messages/:messageId/attachments/:attachmentId", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);
  const attachment = await c.env.DB.prepare(
    `SELECT message_attachments.object_key AS objectKey, message_attachments.filename AS filename,
            message_attachments.content_type AS contentType
     FROM message_attachments
     JOIN messages ON messages.id = message_attachments.message_id
     WHERE message_attachments.id = ? AND messages.id = ?
       AND (messages.sender_username = ? OR messages.recipient_username = ?)`,
  ).bind(c.req.param("attachmentId"), c.req.param("messageId"), username, username)
    .first<{ objectKey: string; filename: string; contentType: string }>();
  if (!attachment) return c.json({ error: "المرفق غير متاح" }, 404);
  const object = await c.env.BUCKET.get(attachment.objectKey);
  if (!object) return c.json({ error: "الملف غير موجود في التخزين" }, 404);
  const isImage = attachment.contentType.startsWith("image/");
  const safeFilename = encodeURIComponent(attachment.filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(object.body, {
    headers: {
      "Content-Type": attachment.contentType,
      "Content-Disposition": `${isImage ? "inline" : "attachment"}; filename="attachment"; filename*=UTF-8''${safeFilename}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

app.post("/messages", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);
  const isMultipart = c.req.header("Content-Type")?.includes("multipart/form-data") ?? false;
  let recipient: unknown;
  let content: unknown;
  let files: File[] = [];
  if (isMultipart) {
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: "تعذر قراءة الملفات المرفقة" }, 400);
    recipient = form.get("recipient");
    content = form.get("content") ?? "";
    files = form.getAll("files").filter((value): value is File => value instanceof File);
  } else {
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || !("recipient" in body) || !("content" in body)) {
      return c.json({ error: "المستلم ونص الرسالة مطلوبان" }, 400);
    }
    ({ recipient, content } = body as { recipient: unknown; content: unknown });
  }
  if (typeof recipient !== "string" || typeof content !== "string" || (!content.trim() && files.length === 0)) {
    return c.json({ error: "أضف نصًا أو ملفًا إلى الرسالة" }, 400);
  }
  if (content.length > 4000) return c.json({ error: "الحد الأقصى للرسالة 4000 حرف" }, 400);
  if (files.length > MAX_ATTACHMENT_COUNT) return c.json({ error: "الحد الأقصى 5 ملفات لكل رسالة" }, 400);
  const preparedFiles: { file: File; id: string; key: string; filename: string; contentType: string }[] = [];
  for (const file of files) {
    if (file.size === 0 || file.size > MAX_ATTACHMENT_SIZE) {
      return c.json({ error: "يجب أن يكون حجم كل ملف أقل من 10 ميغابايت" }, 400);
    }
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const contentType = ATTACHMENT_TYPES[extension];
    if (!contentType) {
      return c.json({ error: "نوع الملف غير مدعوم. أرسل صورة أو PDF أو مستندًا شائعًا." }, 415);
    }
    const id = crypto.randomUUID();
    preparedFiles.push({
      file,
      id,
      key: `messages/${id}`,
      filename: file.name.replace(/[\r\n]/g, "_").slice(0, 255) || `file.${extension}`,
      contentType,
    });
  }
  const users = configuredUsers(c.env.SUPERNOTI_USERS || "[]");
  if (!users) return c.json({ error: "إعدادات المستخدمين غير صالحة على الخادم" }, 500);
  if (!users.some((user) => user.username === username) || !users.some((user) => user.username === recipient) || username === recipient) {
    return c.json({ error: "المستخدم غير متاح" }, 404);
  }

  const message: ChatMessage = {
    id: crypto.randomUUID(),
    sender: username,
    recipient,
    content: content.trim(),
    createdAt: Date.now(),
    attachments: preparedFiles.map(({ id, filename, contentType, file }) => ({
      id,
      filename,
      contentType,
      size: file.size,
    })),
  };
  const storedKeys: string[] = [];
  try {
    for (const attachment of preparedFiles) {
      await c.env.BUCKET.put(attachment.key, attachment.file.stream(), {
        httpMetadata: { contentType: attachment.contentType },
      });
      storedKeys.push(attachment.key);
    }
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO messages (id, sender_username, recipient_username, content, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(message.id, message.sender, message.recipient, message.content, message.createdAt),
      ...preparedFiles.map((attachment) => c.env.DB.prepare(
        "INSERT INTO message_attachments (id, message_id, object_key, filename, content_type, size) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(attachment.id, message.id, attachment.key, attachment.filename, attachment.contentType, attachment.file.size)),
    ]);
  } catch (error) {
    await Promise.all(storedKeys.map((key) => c.env.BUCKET.delete(key)));
    throw error;
  }
  return c.json({ message }, 201);
});

export default app;
