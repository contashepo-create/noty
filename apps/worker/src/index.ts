import { Hono } from "hono";
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
  const results = await Promise.allSettled(keys.map((key) => bucket.delete(key)));
  let failures = 0;
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      failures += 1;
      console.error("Could not delete message attachment from R2", keys[index], result.reason);
    }
  });
  return failures;
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
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "OPTIONS"],
}));

app.get("/", (c) => c.json({ status: "ok", service: "supernoti-worker", name: "SuperNoti" }));

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
  await c.env.DB.prepare(
    `INSERT INTO user_notes (id, owner_username, title, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id, owner_username) DO UPDATE SET
       title = excluded.title,
       content = excluded.content,
       updated_at = excluded.updated_at
     WHERE excluded.updated_at >= user_notes.updated_at`,
  ).bind(note.id, username, note.title, note.content, createdAt, note.updatedAt).run();
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
    `SELECT messages.id, messages.sender_username AS sender, messages.recipient_username AS recipient,
            messages.content, messages.created_at AS createdAt,
            message_attachments.id AS attachmentId, message_attachments.filename AS attachmentFilename,
            message_attachments.content_type AS attachmentContentType, message_attachments.size AS attachmentSize
     FROM messages
     LEFT JOIN message_attachments ON message_attachments.message_id = messages.id
     WHERE (sender_username = ? AND recipient_username = ?)
        OR (sender_username = ? AND recipient_username = ?)
     ORDER BY messages.created_at ASC, message_attachments.filename ASC
     LIMIT 500`,
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

  const attachments = await c.env.DB.prepare(
    "SELECT object_key AS objectKey FROM message_attachments WHERE message_id = ?",
  ).bind(messageId).all<{ objectKey: string }>();

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM message_attachments WHERE message_id = ?").bind(messageId),
    c.env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(messageId),
  ]);
  const cleanupFailures = await deleteStoredAttachments(c.env.BUCKET, attachments.results.map(({ objectKey }) => objectKey));
  if (cleanupFailures) {
    return c.json({ error: "حُذفت الرسالة، لكن تعذر حذف بعض الملفات المرفقة من التخزين." }, 502);
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

  const attachments = await c.env.DB.prepare(
    `SELECT message_attachments.object_key AS objectKey
     FROM message_attachments
     JOIN messages ON messages.id = message_attachments.message_id
     WHERE (messages.sender_username = ? AND messages.recipient_username = ?)
        OR (messages.sender_username = ? AND messages.recipient_username = ?)`,
  ).bind(username, recipient, recipient, username).all<{ objectKey: string }>();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM message_attachments
       WHERE message_id IN (
         SELECT id FROM messages
         WHERE (sender_username = ? AND recipient_username = ?)
            OR (sender_username = ? AND recipient_username = ?)
       )`,
    ).bind(username, recipient, recipient, username),
    c.env.DB.prepare(
      `DELETE FROM messages
       WHERE (sender_username = ? AND recipient_username = ?)
          OR (sender_username = ? AND recipient_username = ?)`,
    ).bind(username, recipient, recipient, username),
  ]);

  const cleanupFailures = await deleteStoredAttachments(c.env.BUCKET, attachments.results.map(({ objectKey }) => objectKey));
  if (cleanupFailures) {
    return c.json({ error: "حُذفت المحادثة، لكن تعذر حذف بعض الملفات المرفقة من التخزين." }, 502);
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
