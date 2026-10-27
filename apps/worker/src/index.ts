import { Hono } from "hono";
import { cors } from "hono/cors";

type ConfiguredUser = { username: string; password: string };
type ChatMessage = {
  id: string;
  sender: string;
  recipient: string;
  content: string;
  createdAt: number;
};

type Bindings = {
  DB: D1Database;
  BUCKET: R2Bucket;
  SYNC_ROOM: DurableObjectNamespace;
  SUPERNOTI_USERS: string;
  SESSION_SECRET: string;
};

const encoder = new TextEncoder();
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000;

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

export class SyncRoom {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/messages") return new Response("Not found", { status: 404 });

    if (request.method === "GET") {
      const messages = await this.state.storage.get<ChatMessage[]>("messages") ?? [];
      return Response.json({ messages });
    }

    if (request.method === "POST") {
      const message = await request.json<ChatMessage>();
      await this.state.storage.transaction(async (transaction) => {
        const messages = await transaction.get<ChatMessage[]>("messages") ?? [];
        messages.push(message);
        await transaction.put("messages", messages);
      });
      return Response.json({ success: true });
    }

    return new Response("Method not allowed", { status: 405 });
  }
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

  const roomName = `messages:${[username, recipient].sort().map(encodeURIComponent).join(":")}`;
  const roomId = c.env.SYNC_ROOM.idFromName(roomName);
  const room = c.env.SYNC_ROOM.get(roomId);
  const response = await room.fetch(new Request("https://room/messages", { method: "GET" }));
  const result = await response.json<{ messages: ChatMessage[] }>();
  return c.json({ messages: result.messages.filter((message) =>
    (message.sender === username && message.recipient === recipient) ||
    (message.sender === recipient && message.recipient === username)) });
});

app.post("/messages", async (c) => {
  if (!c.env.SESSION_SECRET) return c.json({ error: "المصادقة غير مهيأة على الخادم" }, 503);
  const username = await authenticatedUsername(c.req.raw, c.env.SESSION_SECRET);
  if (!username) return c.json({ error: "انتهت صلاحية الجلسة. سجّل الدخول مجددًا." }, 401);
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || !("recipient" in body) || !("content" in body)) {
    return c.json({ error: "المستلم ونص الرسالة مطلوبان" }, 400);
  }
  const { recipient, content } = body as { recipient: unknown; content: unknown };
  if (typeof recipient !== "string" || typeof content !== "string" || !content.trim()) {
    return c.json({ error: "المستلم ونص الرسالة مطلوبان" }, 400);
  }
  if (content.length > 4000) return c.json({ error: "الحد الأقصى للرسالة 4000 حرف" }, 400);
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
  };
  const roomName = `messages:${[username, recipient].sort().map(encodeURIComponent).join(":")}`;
  const room = c.env.SYNC_ROOM.get(c.env.SYNC_ROOM.idFromName(roomName));
  await room.fetch(new Request("https://room/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  }));
  return c.json({ message }, 201);
});

export default app;
