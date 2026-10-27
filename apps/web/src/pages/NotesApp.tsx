import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownWideNarrow, ArrowLeft, ArrowRight, Check, ChevronLeft, Clock3, Cloud,
  FileText, FolderOpen, KeyRound, LifeBuoy, LockKeyhole, LogOut, MessageCircle, MoreHorizontal,
  Paperclip, Plus, Search, Send, ShieldCheck, Sparkles, Trash2, UnlockKeyhole,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ChatLockScreen, ConfirmationDialog, PinDialog, type DeleteTarget, type PinDialogMode } from "../components/WorkspaceDialogs";

type User = { id: string; username: string };
type Note = { id: string; title: string; content: string; createdAt: number; updatedAt: number };
type Message = {
  id: string;
  sender: string;
  recipient: string;
  content: string;
  createdAt: number;
  attachments?: MessageAttachment[];
};
type MessageAttachment = { id: string; filename: string; contentType: string; size: number };
type Session = { token: string; user: User };

const SESSION_KEY = "supernoti-session";
const notesKey = (username: string) => `supernoti-notes:${username}`;
const dirtyNotesKey = (username: string) => `supernoti-notes-dirty:${username}`;
const cloudInitializedKey = (username: string) => `supernoti-notes-cloud-initialized:${username}`;
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

function sessionHeaders(token: string, chatToken?: string | null): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  if (chatToken) headers.set("X-Chat-Unlock", chatToken);
  return headers;
}

async function api<T>(path: string, token?: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let response: Response;
  try { response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers }); }
  catch { throw new ApiError("تعذر الاتصال بالخادم. تحقق من اتصالك وحاول مجددًا.", 0); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error || `تعذر إكمال الطلب (${response.status})`, response.status);
  return payload as T;
}

function readNotes(username: string): Note[] {
  try {
    const saved = localStorage.getItem(notesKey(username));
    return saved ? (JSON.parse(saved) as Note[]) : [];
  } catch (error) {
    console.error("Could not read local notes", error);
    return [];
  }
}

function readDirtyNotes(username: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(dirtyNotesKey(username)) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "number"));
  } catch {
    return {};
  }
}

// A stable ID makes a retried conflict copy idempotent even after a reload.
async function createConflictCopy(note: Note, username: string): Promise<Note> {
  const seed = JSON.stringify([username, note.id, note.updatedAt, note.title, note.content]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  const id = `conflict-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const now = Date.now();
  return {
    ...note, id, title: `${(note.title || "ملاحظة").slice(0, 480)} (نسخة محلية)`,
    createdAt: now, updatedAt: now,
  };
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`}>
      <span className="brand-mark" aria-hidden="true">ن</span>
      <span>نوتي<span className="brand-period">.</span></span>
    </div>
  );
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} بايت`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} كيلوبايت`;
  return `${(size / (1024 * 1024)).toFixed(1)} ميغابايت`;
}

function PendingAttachment({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [previewUrl, setPreviewUrl] = useState("");

  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div className="pending-attachment">
      {previewUrl ? <img src={previewUrl} alt="" /> : <span aria-hidden="true">▤</span>}
      <span className="pending-file-copy"><strong>{file.name}</strong><small>{formatFileSize(file.size)}</small></span>
      <button type="button" onClick={onRemove} aria-label={`إزالة ${file.name}`}>×</button>
    </div>
  );
}

function MessageAttachmentView({ messageId, attachment, token, chatToken, onLockExpired }: {
  messageId: string;
  attachment: MessageAttachment;
  token: string;
  chatToken: string | null;
  onLockExpired: () => void;
}) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [error, setError] = useState("");
  const isImage = attachment.contentType.startsWith("image/");

  const openAttachment = async () => {
    setError("");
    try {
      const response = await fetch(
        `${API_BASE_URL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}`,
        { headers: sessionHeaders(token, chatToken) },
      );
      if (!response.ok) {
        if (response.status === 423) {
          onLockExpired();
          return;
        }
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "تعذر تحميل الملف");
      }
      const url = URL.createObjectURL(await response.blob());
      if (isImage) {
        setPreviewUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return url;
        });
      } else {
        const link = document.createElement("a");
        link.href = url;
        link.download = attachment.filename;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (cause) {
      setError(cause instanceof TypeError ? "تعذر الاتصال بالخادم لتحميل الملف." : cause instanceof Error ? cause.message : "تعذر تحميل الملف");
    }
  };

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  return (
    <div className={`message-attachment ${isImage ? "image-attachment" : ""}`}>
      {previewUrl && isImage ? <img className="attachment-preview" src={previewUrl} alt={attachment.filename} /> : null}
      <button type="button" className="attachment-file" onClick={() => void openAttachment()}>
        <span className="attachment-icon" aria-hidden="true">{isImage ? "▧" : "↧"}</span>
        <span className="attachment-copy"><strong>{attachment.filename}</strong><small>{formatFileSize(attachment.size)} · {isImage ? "صورة" : "ملف"}</small></span>
        <span className="attachment-action">{isImage ? (previewUrl ? "فتح" : "عرض") : "تنزيل"}</span>
      </button>
      {error && <span className="attachment-error" role="alert">{error}</span>}
    </div>
  );
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const session = await api<Session>("/auth/login", undefined, {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      setUsername("");
      setPassword("");
      onLogin(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر تسجيل الدخول");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="login-page" dir="rtl">
      <div className="login-decoration login-decoration-one" />
      <div className="login-decoration login-decoration-two" />
      <div className="login-shell">
        <section className="login-story">
          <Brand />
          <div className="story-copy">
            <span className="eyebrow"><span className="eyebrow-dot" /> مساحتك، بطريقتك</span>
            <h1>أفكارك تستحق<br /><span>مكانًا أجمل.</span></h1>
            <p>ملاحظاتك ومتابعاتك المهمة، مرتبة في مساحة واحدة هادئة وآمنة.</p>
            <div className="story-preview">
              <div className="preview-top">
                <span className="preview-avatar">س</span>
                <div><strong>مساحة هادئة</strong><small>لحظاتك محفوظة هنا</small></div>
                <span className="preview-sparkle">✳</span>
              </div>
              <div className="preview-lines"><i /><i /><i /></div>
              <div className="preview-tags"><span>أفكار</span><span>يومياتي</span><span>✦</span></div>
            </div>
          </div>
          <div className="login-footer"><span>خصوصيتك أولويتنا</span><span>•</span><span>مساحة خاصة بك</span></div>
        </section>

        <section className="login-card">
          <div className="mobile-brand"><Brand /></div>
          <span className="login-icon">✦</span>
          <h2>مرحبًا بعودتك</h2>
          <p className="login-subtitle">سجّل الدخول إلى مساحتك الشخصية</p>
          <form onSubmit={handleSubmit} autoComplete="off">
            <label htmlFor="username">اسم المستخدم</label>
            <div className="field-wrap">
              <span className="field-icon" aria-hidden="true">♙</span>
              <input id="username" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="أدخل اسم المستخدم" required />
            </div>
            <div className="password-label"><label htmlFor="password">كلمة المرور</label><span>محميّة بالتشفير</span></div>
            <div className="field-wrap">
              <span className="field-icon" aria-hidden="true">⌑</span>
              <input id="password" type={showPassword ? "text" : "password"} autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="أدخل كلمة المرور" required />
              <button className="reveal-button" type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}>{showPassword ? "إخفاء" : "عرض"}</button>
            </div>
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="primary-button login-submit" type="submit" disabled={loading}>
              {loading ? <><span className="spinner" /> جارٍ تسجيل الدخول...</> : <>تسجيل الدخول <span>←</span></>}
            </button>
          </form>
          <div className="login-secure"><span>◆</span> جلسة دخول محمية</div>
        </section>
      </div>
    </main>
  );
}

const shortDate = (value: number) => new Date(value).toLocaleDateString("ar", { day: "numeric", month: "short", year: "numeric" });
const messageDate = (value: number) => new Date(value).toLocaleDateString("ar", { day: "numeric", month: "long", year: "numeric" });
const wordCount = (content: string) => content.trim().split(/\s+/).filter(Boolean).length;

function Workspace({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [notes, setNotes] = useState<Note[]>(() => readNotes(session.user.username));
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [noteSyncStatus, setNoteSyncStatus] = useState("جارٍ تحميل ملاحظاتك...");
  const noteSyncTimers = useRef(new Map<string, number>());
  const noteSyncQueues = useRef(new Map<string, Promise<void>>());
  const dirtyNotes = useRef<Record<string, number>>(readDirtyNotes(session.user.username));
  const latestNotes = useRef(notes);
  latestNotes.current = notes;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [section, setSection] = useState<"notes" | "messages">("notes");
  const [search, setSearch] = useState("");
  const [contacts, setContacts] = useState<string[]>([]);
  const [contactsError, setContactsError] = useState("");
  const [activeContact, setActiveContact] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draftMessage, setDraftMessage] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const chatGeneration = useRef(0);
  const deletingChat = useRef(false);
  const [chatError, setChatError] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [lockState, setLockState] = useState<"loading" | "disabled" | "locked" | "unlocked" | "error">("loading");
  const [chatToken, setChatToken] = useState<string | null>(null);
  const [lockNotice, setLockNotice] = useState("");
  const [lockBusy, setLockBusy] = useState(false);
  const [pinDialog, setPinDialog] = useState<PinDialogMode | null>(null);
  const lockMenuRef = useRef<HTMLDetailsElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const selectedNote = notes.find((note) => note.id === selectedId) ?? null;
  const sortedNotes = useMemo(() => [...notes].sort((a, b) => b.updatedAt - a.updatedAt), [notes]);
  const filteredNotes = useMemo(() => sortedNotes.filter((note) =>
    `${note.title} ${note.content}`.toLowerCase().includes(search.trim().toLowerCase())), [sortedNotes, search]);
  const filteredContacts = useMemo(() => contacts.filter((contact) =>
    contact.toLowerCase().includes(search.trim().toLowerCase())), [contacts, search]);
  const chatAvailable = lockState === "disabled" || lockState === "unlocked";

  const persistDirtyNotes = (): boolean => {
    try {
      localStorage.setItem(dirtyNotesKey(session.user.username), JSON.stringify(dirtyNotes.current));
      return true;
    } catch {
      setNoteSyncStatus("تعذر الحفظ على هذا الجهاز");
      return false;
    }
  };

  const markNoteDirty = (note: Note) => {
    dirtyNotes.current[note.id] = note.updatedAt;
    persistDirtyNotes();
  };

  const clearDirtyNote = (note: Note) => {
    if (dirtyNotes.current[note.id] === note.updatedAt) {
      delete dirtyNotes.current[note.id];
      persistDirtyNotes();
    }
  };

  useEffect(() => {
    let active = true;
    const cachedNotes = readNotes(session.user.username);
    const loadNotes = async () => {
      try {
        const { notes: cloudNotes } = await api<{ notes: Note[] }>("/notes", session.token);
        if (!active) return;
        let initialized = false;
        try { initialized = localStorage.getItem(cloudInitializedKey(session.user.username)) === "1"; } catch { /* storage is optional */ }
        // Import pre-existing local notes once, not every time an account becomes empty.
        // Dirty notes are always retried, including offline edits to an empty account.
        const importLegacy = !initialized && cloudNotes.length === 0 && cachedNotes.length > 0;
        if (importLegacy) {
          for (const note of cachedNotes) dirtyNotes.current[note.id] ??= note.updatedAt;
          if (!persistDirtyNotes()) throw new Error("Local storage unavailable");
        }
        try { localStorage.setItem(cloudInitializedKey(session.user.username), "1"); } catch { /* retry on next load */ }

        const merged = new Map(cloudNotes.map((note) => [note.id, note]));
        const toSync: { source: Note; target: Note }[] = [];
        let conflicts = 0;
        for (const note of cachedNotes) {
          if (dirtyNotes.current[note.id] === undefined) continue;
          const cloud = merged.get(note.id);
          if (cloud && cloud.updatedAt > note.updatedAt) {
            // Keep both versions instead of discarding an offline edit. The source
            // stays dirty until its separate copy is safely stored in the cloud.
            const copy = await createConflictCopy(note, session.user.username);
            merged.set(copy.id, copy);
            toSync.push({ source: note, target: copy });
            conflicts += 1;
          } else {
            merged.set(note.id, note);
            toSync.push({ source: note, target: note });
          }
        }
        const results = await Promise.allSettled(toSync.map(async ({ source, target }) => {
          await api("/notes", session.token, { method: "POST", body: JSON.stringify(target) });
          clearDirtyNote(source);
        }));
        if (results.some((result) => result.status === "rejected")) throw new Error("Sync failed");
        if (!active) return;
        setNotes([...merged.values()]);
        setNotesLoaded(true);
        setNoteSyncStatus(conflicts ? "حُفظت التعديلات المتعارضة في نسخة منفصلة" : "ملاحظاتك متزامنة");
      } catch {
        if (!active) return;
        // Retain the original cached records and dirty markers if any upload failed.
        setNotes(cachedNotes);
        setNotesLoaded(true);
        setNoteSyncStatus("الملاحظات على هذا الجهاز؛ تعذرت المزامنة");
      }
    };
    void loadNotes();
    return () => { active = false; };
  }, [session.token, session.user.username]);

  useEffect(() => {
    try { localStorage.setItem(notesKey(session.user.username), JSON.stringify(notes)); }
    catch { setNoteSyncStatus("تعذر الحفظ على هذا الجهاز"); }
  }, [notes, session.user.username]);

  useEffect(() => () => {
    for (const timer of noteSyncTimers.current.values()) window.clearTimeout(timer);
    chatGeneration.current += 1;
  }, []);

  const syncNote = (note: Note): Promise<void> => {
    const previous = noteSyncQueues.current.get(note.id) ?? Promise.resolve();
    const request = previous.catch(() => undefined).then(async () => {
      await api("/notes", session.token, { method: "POST", body: JSON.stringify(note) });
    });
    noteSyncQueues.current.set(note.id, request);
    void request.then(() => {
      clearDirtyNote(note);
      if (noteSyncQueues.current.get(note.id) === request) {
        noteSyncQueues.current.delete(note.id);
        setNoteSyncStatus(Object.keys(dirtyNotes.current).length ? "جارٍ حفظ الملاحظات..." : "ملاحظاتك متزامنة");
      }
    }, (error: unknown) => {
      if (noteSyncQueues.current.get(note.id) === request) {
        noteSyncQueues.current.delete(note.id);
        setNoteSyncStatus(error instanceof ApiError && error.status === 409
          ? "تعارضت التعديلات؛ سجّل الدخول مجددًا لحفظ نسخة من تعديلك."
          : "محفوظة على هذا الجهاز؛ تعذرت المزامنة");
      }
    });
    return request;
  };

  const syncNoteRef = useRef(syncNote);
  syncNoteRef.current = syncNote;
  useEffect(() => {
    const retryPendingNotes = () => {
      for (const note of latestNotes.current) {
        if (dirtyNotes.current[note.id] !== note.updatedAt || noteSyncQueues.current.has(note.id) || noteSyncTimers.current.has(note.id)) continue;
        setNoteSyncStatus("جارٍ حفظ الملاحظات...");
        void syncNoteRef.current(note).catch(() => undefined);
      }
    };
    window.addEventListener("online", retryPendingNotes);
    return () => window.removeEventListener("online", retryPendingNotes);
  }, []);

  const scheduleNoteSave = (note: Note) => {
    const previous = noteSyncTimers.current.get(note.id);
    if (previous) window.clearTimeout(previous);
    setNoteSyncStatus("جارٍ حفظ الملاحظة...");
    markNoteDirty(note);
    const timer = window.setTimeout(() => {
      noteSyncTimers.current.delete(note.id);
      void syncNote(note).catch(() => undefined);
    }, 450);
    noteSyncTimers.current.set(note.id, timer);
  };

  const clearChatView = useCallback(() => {
    chatGeneration.current += 1;
    setMessages([]);
    setActiveContact("");
    setDraftMessage("");
    setSelectedFiles([]);
    setChatError("");
    nearBottom.current = true;
  }, []);

  const expireChatAccess = useCallback(() => {
    clearChatView();
    setChatToken(null);
    setLockState("locked");
    setLockNotice("أُغلقت المحادثات. أدخل الرمز لفتحها مجددًا.");
  }, [clearChatView]);

  const refreshLockStatus = useCallback(async () => {
    setLockState("loading");
    setLockNotice("");
    try {
      const result = await api<{ enabled: boolean }>("/conversation-lock", session.token);
      setChatToken(null);
      setLockState(result.enabled ? "locked" : "disabled");
    } catch (cause) {
      setLockState("error");
      setLockNotice(cause instanceof ApiError && cause.status === 404
        ? "تحتاج خدمة المحادثات إلى التحديث على الخادم قبل استخدامها."
        : cause instanceof Error ? cause.message : "تعذر التحقق من قفل المحادثات.");
    }
  }, [session.token]);

  useEffect(() => { void refreshLockStatus(); }, [refreshLockStatus]);

  const lockChat = async () => {
    if (lockState !== "unlocked" || !chatToken) return;
    const tokenToRevoke = chatToken;
    setLockBusy(true);
    clearChatView();
    setChatToken(null);
    setLockState("locked");
    setLockNotice("");
    try {
      await api("/conversation-lock/lock", session.token, {
        method: "POST", headers: sessionHeaders(session.token, tokenToRevoke),
      });
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 423)) {
        setLockNotice("أُغلقت المحادثات على هذا الجهاز، لكن تعذر إنهاء الجلسة على الخادم.");
      }
    } finally { setLockBusy(false); }
  };

  const changeSection = (next: "notes" | "messages") => {
    if (section === "messages" && next !== "messages" && lockState === "unlocked") void lockChat();
    setSearch("");
    setSection(next);
  };

  const logout = async () => {
    if (lockState === "unlocked") await lockChat();
    onLogout();
  };

  useEffect(() => {
    if (section !== "messages" || !chatAvailable) return;
    let active = true;
    setContactsError("");
    api<{ users: string[] }>("/users", session.token).then(({ users }) => {
      if (active) setContacts(users);
    }).catch((error: unknown) => {
      if (active) setContactsError(error instanceof Error ? error.message : "تعذر تحميل جهات الاتصال");
    });
    return () => { active = false; };
  }, [section, chatAvailable, session.token]);

  const chatApi = useCallback(<T,>(path: string, init?: RequestInit) =>
    api<T>(path, session.token, { ...init, headers: sessionHeaders(session.token, chatToken) }),
  [session.token, chatToken]);

  const handleChatError = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 423) expireChatAccess();
    else setChatError(cause instanceof Error ? cause.message : "تعذر إكمال الطلب");
  }, [expireChatAccess]);

  const loadMessages = useCallback(async () => {
    if (!activeContact || !chatAvailable || deletingChat.current) return;
    const generation = chatGeneration.current;
    try {
      const result = await chatApi<{ messages: Message[] }>(`/messages/${encodeURIComponent(activeContact)}`);
      if (generation === chatGeneration.current) setMessages(result.messages);
    } catch (cause) {
      if (generation === chatGeneration.current) handleChatError(cause);
    }
  }, [activeContact, chatAvailable, chatApi, handleChatError]);

  useEffect(() => {
    if (section !== "messages" || !chatAvailable || !activeContact) return;
    let active = true;
    setChatLoading(true);
    void loadMessages().finally(() => { if (active) setChatLoading(false); });
    const timer = window.setInterval(() => { void loadMessages(); }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [loadMessages, section, chatAvailable, activeContact]);

  useEffect(() => {
    const history = historyRef.current;
    if (history && nearBottom.current) history.scrollTop = history.scrollHeight;
  }, [messages, activeContact]);

  const createNote = () => {
    if (!notesLoaded) return;
    if (section === "messages" && lockState === "unlocked") void lockChat();
    const now = Date.now();
    const note: Note = { id: crypto.randomUUID(), title: "", content: "", createdAt: now, updatedAt: now };
    setNotes((current) => [note, ...current]);
    setSelectedId(note.id);
    setSearch("");
    setSection("notes");
    scheduleNoteSave(note);
  };

  const updateNote = (field: "title" | "content", value: string) => {
    if (!selectedNote) return;
    const updatedNote = { ...selectedNote, [field]: value, updatedAt: Math.max(Date.now(), selectedNote.updatedAt + 1) };
    setNotes((current) => current.map((note) => note.id === selectedNote.id ? updatedNote : note));
    scheduleNoteSave(updatedNote);
  };

  const saveAndCloseNote = () => {
    if (!selectedNote) return;
    const pending = noteSyncTimers.current.get(selectedNote.id);
    if (pending) window.clearTimeout(pending);
    noteSyncTimers.current.delete(selectedNote.id);
    try {
      // Persist the retry metadata as well as the content before closing.
      if (!persistDirtyNotes()) throw new Error("Local storage unavailable");
      // A slow or unavailable network should not trap the editor open.
      localStorage.setItem(notesKey(session.user.username), JSON.stringify(notes));
    } catch {
      scheduleNoteSave(selectedNote);
      setNoteSyncStatus("تعذر الحفظ على هذا الجهاز. تحقق من مساحة التخزين وحاول مجددًا.");
      return;
    }
    setNoteSyncStatus("جارٍ حفظ الملاحظة...");
    setSelectedId(null);
    void syncNote(selectedNote).catch(() => undefined);
  };

  const openContact = (contact: string) => {
    if (contact === activeContact) return;
    chatGeneration.current += 1;
    setActiveContact(contact);
    setMessages([]);
    setDraftMessage("");
    setSelectedFiles([]);
    setChatError("");
    nearBottom.current = true;
  };

  const closeContact = () => {
    chatGeneration.current += 1;
    setActiveContact("");
    setMessages([]);
    setDraftMessage("");
    setSelectedFiles([]);
    setChatError("");
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    const content = draftMessage.trim();
    if ((!content && selectedFiles.length === 0) || !activeContact || sending || !chatAvailable) return;
    // Discard polls started before this send; they may contain an older history.
    chatGeneration.current += 1;
    const generation = chatGeneration.current;
    setSending(true);
    setChatError("");
    try {
      const form = new FormData();
      form.append("recipient", activeContact);
      form.append("content", content);
      selectedFiles.forEach((file) => form.append("files", file));
      const result = await chatApi<{ message: Message }>("/messages", { method: "POST", body: form });
      if (generation !== chatGeneration.current) return;
      chatGeneration.current += 1;
      nearBottom.current = true;
      setMessages((current) => current.some((message) => message.id === result.message.id) ? current : [...current, result.message]);
      setDraftMessage("");
      setSelectedFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (cause) {
      if (generation === chatGeneration.current) handleChatError(cause);
    } finally { setSending(false); }
  };

  const submitPin = async (currentPin: string, newPin: string) => {
    if (pinDialog === "setup") {
      await api("/conversation-lock", session.token, { method: "POST", body: JSON.stringify({ pin: newPin }) });
      clearChatView();
      setChatToken(null);
      setLockState("locked");
      setLockNotice("");
    } else if (pinDialog === "change") {
      const result = await api<{ unlockToken: string }>("/conversation-lock/change", session.token, {
        method: "POST", body: JSON.stringify({ currentPin, newPin }),
      });
      setChatToken(result.unlockToken);
      setLockState("unlocked");
    } else if (pinDialog === "disable") {
      await api("/conversation-lock", session.token, { method: "DELETE", body: JSON.stringify({ pin: currentPin }) });
      setChatToken(null);
      setLockState("disabled");
    }
    setPinDialog(null);
  };

  const unlockChat = async (pin: string) => {
    const result = await api<{ unlockToken: string }>("/conversation-lock/unlock", session.token, {
      method: "POST", body: JSON.stringify({ pin }),
    });
    setChatToken(result.unlockToken);
    setLockNotice("");
    setLockState("unlocked");
  };

  const requestDelete = (target: DeleteTarget) => { setDeleteError(""); setDeleteTarget(target); };
  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    const target = deleteTarget;
    setDeleting(true);
    setDeleteError("");
    if (target.type !== "note") { deletingChat.current = true; chatGeneration.current += 1; }
    try {
      if (target.type === "note") {
        const pending = noteSyncTimers.current.get(target.id);
        if (pending) window.clearTimeout(pending);
        noteSyncTimers.current.delete(target.id);
        await noteSyncQueues.current.get(target.id)?.catch(() => undefined);
        await api(`/notes/${encodeURIComponent(target.id)}`, session.token, { method: "DELETE" });
        delete dirtyNotes.current[target.id];
        persistDirtyNotes();
        setNotes((current) => current.filter((note) => note.id !== target.id));
        setSelectedId((current) => current === target.id ? null : current);
        setNoteSyncStatus("ملاحظاتك متزامنة");
      } else if (target.type === "message") {
        await chatApi(`/messages/${encodeURIComponent(target.id)}`, { method: "DELETE" });
        setMessages((current) => current.filter((message) => message.id !== target.id));
      } else if (target.type === "conversation") {
        await chatApi(`/conversations/${encodeURIComponent(target.contact)}`, { method: "DELETE" });
        if (activeContact === target.contact) setMessages([]);
      } else {
        await chatApi("/conversations", { method: "DELETE" });
        setMessages([]);
      }
      setDeleteTarget(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 423) { setDeleteTarget(null); expireChatAccess(); }
      else setDeleteError(cause instanceof Error ? cause.message : "تعذر الحذف. حاول مجددًا.");
    } finally {
      if (target.type !== "note") { chatGeneration.current += 1; deletingChat.current = false; }
      setDeleting(false);
    }
  };

  const initials = session.user.username.slice(0, 1).toUpperCase();
  const showPinDialog = (mode: PinDialogMode) => {
    if (lockMenuRef.current) lockMenuRef.current.open = false;
    setPinDialog(mode);
  };

  return (
    <div className="app-shell" dir="rtl">
      <aside className="sidebar">
        <div className="sidebar-brand"><Brand compact /><span className="sidebar-brand-caption">مساحتك الخاصة</span></div>
        <button className="new-note-button" type="button" onClick={createNote} disabled={!notesLoaded}><Plus /> ملاحظة جديدة</button>
        <div className="nav-caption">مساحة العمل</div>
        <nav className="main-nav" aria-label="التنقل الرئيسي">
          <button type="button" className={section === "notes" ? "nav-item active" : "nav-item"} onClick={() => changeSection("notes")}><span className="nav-icon"><FileText /></span><span>الملاحظات</span><span className="nav-count">{notes.length}</span></button>
          <button type="button" className={section === "messages" ? "nav-item active" : "nav-item"} onClick={() => changeSection("messages")}><span className="nav-icon"><LifeBuoy /></span><span>الدعم</span></button>
        </nav>
        <div className="sidebar-divider" />
        <div className="nav-caption list-caption">ملاحظات حديثة <button type="button" onClick={createNote} disabled={!notesLoaded} aria-label="إضافة ملاحظة"><Plus /></button></div>
        <div className="note-list">
          {sortedNotes.slice(0, 6).map((note) => (
            <button key={note.id} className={`note-list-item ${selectedId === note.id && section === "notes" ? "selected" : ""}`} disabled={!notesLoaded} onClick={() => { if (section === "messages" && lockState === "unlocked") void lockChat(); setSelectedId(note.id); setSection("notes"); setSearch(""); }}>
              <span className="note-list-icon"><FileText /></span><span className="note-list-copy"><strong>{note.title || "ملاحظة بدون عنوان"}</strong><small>{shortDate(note.updatedAt)}</small></span>
            </button>
          ))}
          {notes.length === 0 && <p className="empty-sidebar">ستظهر ملاحظاتك الأخيرة هنا.</p>}
        </div>
        <div className="sidebar-bottom">
          <div className="sync-status"><Cloud /><span>{noteSyncStatus}</span></div>
          <div className="profile-summary"><span className="profile-avatar">{initials}</span><span className="profile-copy"><strong>{session.user.username}</strong><small>مساحتك الشخصية</small></span><ShieldCheck className="profile-shield" /></div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumb"><span>مساحة العمل</span><ChevronLeft /><strong>{section === "notes" ? "الملاحظات" : "الدعم"}</strong></div>
          <div className="topbar-actions">
            <label className="search-box"><Search /><input aria-label={section === "notes" ? "البحث في الملاحظات" : "البحث في المحادثات"} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={section === "notes" ? "ابحث في ملاحظاتك..." : "ابحث عن شخص..."} /></label>
            <button className="logout-button" type="button" onClick={() => void logout()} aria-label="تسجيل الخروج"><LogOut /><span>تسجيل الخروج</span></button>
            <span className="topbar-avatar" title={session.user.username}>{initials}</span>
          </div>
        </header>

        {section === "notes" ? (
          <div className="notes-layout">
            <section className="notes-column" aria-labelledby="notes-heading">
              <div className="page-heading notes-heading">
                <div><span className="workspace-eyebrow"><span /> مساحة لأفكارك</span><h1 id="notes-heading">ملاحظاتك <span className="heading-count">{notes.length}</span></h1><p>كل أفكارك وتفاصيلك المهمة، في مكان واحد.</p></div>
                <button className="primary-button create-note" onClick={createNote} disabled={!notesLoaded}><Plus /><span>ملاحظة جديدة</span></button>
              </div>
              <div className="notes-toolbar"><div className="notes-tab"><FolderOpen /><strong>كل الملاحظات</strong><span>{filteredNotes.length}</span></div><span className="sort-label"><ArrowDownWideNarrow /> الأحدث أولًا</span></div>
              {!notesLoaded ? <div className="content-loading"><span className="spinner" /> جارٍ تحميل ملاحظاتك...</div> : filteredNotes.length ? (
                <div className="notes-grid">
                  {filteredNotes.map((note, index) => (
                    <button key={note.id} className={`note-card note-tone-${index % 4} ${selectedId === note.id ? "note-card-selected" : ""}`} onClick={() => setSelectedId(note.id)}>
                      <span className="note-card-top"><span className="note-card-mark"><FileText /></span><span className="note-card-label">ملاحظة</span><ArrowLeft className="note-card-arrow" /></span>
                      <strong>{note.title || "ملاحظة بدون عنوان"}</strong>
                      <p>{note.content || "مساحة جديدة لأفكارك..."}</p>
                      <span className="note-card-footer"><Clock3 /> {shortDate(note.updatedAt)}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-notes"><span className="empty-note-icon"><FileText /></span><h2>{search ? "لم نجد ملاحظات مطابقة" : "كل فكرة تستحق مكانًا"}</h2><p>{search ? "جرّب كلمة بحث أخرى للوصول إلى ما تبحث عنه." : "ابدأ بملاحظة جديدة، واترك لأفكارك مساحة لتنمو."}</p>{!search && <button className="primary-button" onClick={createNote}><Plus /> أنشئ ملاحظتك الأولى</button>}</div>
              )}
              <div className="notes-sync-caption" role="status"><Cloud /> {noteSyncStatus}</div>
            </section>
            <section className={`editor-panel ${selectedNote ? "editor-open" : ""}`} aria-label="محرر الملاحظة">
              {selectedNote ? (
                <>
                  <div className="editor-actions">
                    <div className="editor-header-label"><span className="editor-header-icon"><FileText /></span><span><strong>ملاحظتك</strong><small>مساحة خاصة لأفكارك</small></span></div>
                    <div className="editor-action-buttons"><button type="button" className="editor-delete icon-button" onClick={() => requestDelete({ type: "note", id: selectedNote.id })} aria-label="حذف الملاحظة" title="حذف الملاحظة"><Trash2 /></button><button type="button" className="editor-save primary-button" onClick={saveAndCloseNote}><Check />حفظ وإغلاق</button></div>
                  </div>
                  <div className="editor-paper">
                    <span className="editor-overline"><Sparkles /> ملاحظة شخصية</span>
                    <input className="editor-title" aria-label="عنوان الملاحظة" value={selectedNote.title} onChange={(event) => updateNote("title", event.target.value)} placeholder="عنوان الملاحظة" maxLength={500} />
                    <div className="editor-meta"><span><Clock3 /> آخر تعديل {shortDate(selectedNote.updatedAt)}</span><span className="meta-dot">•</span><span>{wordCount(selectedNote.content)} كلمة</span></div>
                    <div className="editor-rule" />
                    <textarea className="editor-content" aria-label="محتوى الملاحظة" value={selectedNote.content} onChange={(event) => updateNote("content", event.target.value)} placeholder="ابدأ بكتابة ما يدور في ذهنك..." maxLength={100000} />
                  </div>
                  <div className="editor-hint"><span className={`saved-indicator ${noteSyncStatus.includes("تعذر") || noteSyncStatus.includes("تعارض") ? "sync-warning" : ""}`} /><span>{noteSyncStatus}</span></div>
                </>
              ) : (
                <div className="editor-empty"><div className="editor-empty-illustration"><FileText /><Sparkles /></div><h3>مساحة تستوعب أفكارك</h3><p>اختر ملاحظة من القائمة، أو ابدأ صفحة جديدة.</p><button onClick={createNote} disabled={!notesLoaded}><Plus /> ملاحظة جديدة</button></div>
              )}
            </section>
          </div>
        ) : (
          <section className={`messages-page ${activeContact && chatAvailable ? "has-active-chat" : ""}`} aria-labelledby="messages-heading">
            <div className="page-heading messages-heading">
              <div><span className="workspace-eyebrow"><span /> نحن هنا لأجلك</span><h1 id="messages-heading">الدعم</h1><p>تواصل بسهولة، في مساحة تجمعك بمن يهمك.</p></div>
              {chatAvailable && <div className="messages-heading-actions">
                {lockState === "disabled" ? <button className="outline-button" type="button" onClick={() => showPinDialog("setup")}><LockKeyhole /> تفعيل القفل</button> : <>
                  <button className="outline-button" type="button" onClick={() => void lockChat()} disabled={lockBusy}><LockKeyhole /> قفل الآن</button>
                  <details className="lock-menu" ref={lockMenuRef}><summary className="icon-button" aria-label="إدارة قفل المحادثات" title="إدارة قفل المحادثات"><MoreHorizontal /></summary><div className="lock-menu-popover"><button type="button" onClick={() => showPinDialog("change")}><KeyRound /> تغيير الرمز السري</button><button type="button" onClick={() => showPinDialog("disable")}><UnlockKeyhole /> إيقاف القفل</button></div></details>
                </>}
              </div>}
            </div>

            {lockState === "locked" ? <ChatLockScreen onUnlock={unlockChat} busy={lockBusy} notice={lockNotice} /> : lockState === "loading" ? <div className="chat-status-panel"><span className="spinner" /> جارٍ تجهيز المحادثات...</div> : lockState === "error" ? <div className="chat-status-panel error-panel"><ShieldCheck /><strong>تعذر فتح المحادثات</strong><p>{lockNotice}</p><button className="outline-button" onClick={() => void refreshLockStatus()}>إعادة المحاولة</button></div> : (
              <div className={`chat-card ${activeContact ? "chat-selected" : ""}`}>
                <aside className="contacts-panel">
                  <div className="contacts-title"><div><strong>المحادثات</strong><small>الأشخاص المتاحون للتواصل</small></div><span>{contacts.length}</span></div>
                  <div className="contacts-list">
                    {filteredContacts.map((contact, index) => <button key={contact} className={`contact-item ${activeContact === contact ? "contact-active" : ""}`} onClick={() => openContact(contact)}><span className={`contact-avatar contact-color-${index % 3}`}>{contact.slice(0, 1).toUpperCase()}</span><span className="contact-details"><strong>{contact}</strong><small>اضغط لفتح المحادثة</small></span><ChevronLeft className="contact-chevron" /></button>)}
                    {contactsError && <div className="no-contacts" role="alert">{contactsError}</div>}
                    {!contactsError && filteredContacts.length === 0 && <div className="no-contacts">{search ? "لا توجد نتائج مطابقة للبحث." : "لا توجد حسابات أخرى متاحة بعد."}</div>}
                  </div>
                  <div className="contacts-footer"><span><ShieldCheck /> مساحة تواصل خاصة</span><button type="button" onClick={() => requestDelete({ type: "all" })}><Trash2 /> مسح جميع المحادثات</button></div>
                </aside>
                <div className="conversation">
                  {activeContact ? <>
                    <div className="conversation-header">
                      <button type="button" className="chat-back-button icon-button" onClick={closeContact} aria-label="العودة إلى المحادثات"><ArrowRight /></button>
                      <span className="contact-avatar contact-color-0">{activeContact.slice(0, 1).toUpperCase()}</span>
                      <div className="conversation-contact"><strong>{activeContact}</strong><small><span /> محادثة خاصة</small></div>
                      {lockState === "unlocked" && <button type="button" className="conversation-lock-button icon-button" onClick={() => void lockChat()} aria-label="قفل المحادثات الآن" title="قفل المحادثات الآن"><LockKeyhole /></button>}
                      <button type="button" className="clear-conversation-button" onClick={() => requestDelete({ type: "conversation", contact: activeContact })} aria-label={`مسح المحادثة مع ${activeContact} للطرفين`} title="مسح المحادثة للطرفين"><Trash2 /><span>مسح المحادثة</span></button>
                    </div>
                    <div className="message-history" ref={historyRef} onScroll={(event) => { const element = event.currentTarget; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
                      {chatLoading && messages.length === 0 && <div className="chat-loading"><span className="spinner" /> جارٍ تحميل المحادثة...</div>}
                      {!chatLoading && messages.length === 0 && !chatError && <div className="chat-empty"><span><MessageCircle /></span><strong>ابدأ المحادثة</strong><p>أرسل أول رسالة إلى {activeContact}.</p></div>}
                      {messages.map((message, index) => {
                        const previous = messages[index - 1];
                        const showDate = !previous || new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
                        return <div key={message.id}>
                          {showDate && <div className="day-divider"><span>{messageDate(message.createdAt)}</span></div>}
                          <div className={`message-row ${message.sender === session.user.username ? "message-mine" : ""}`}>
                            <div className="message-bubble">{message.content && <p>{message.content}</p>}{message.attachments?.map((attachment) => <MessageAttachmentView key={attachment.id} messageId={message.id} attachment={attachment} token={session.token} chatToken={chatToken} onLockExpired={expireChatAccess} />)}<time>{new Date(message.createdAt).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" })}</time></div>
                            <button type="button" className="delete-message-button" onClick={() => requestDelete({ type: "message", id: message.id })} aria-label="حذف الرسالة من الطرفين" title="حذف الرسالة من الطرفين"><Trash2 /></button>
                          </div>
                        </div>;
                      })}
                      {chatError && <div className="chat-error" role="alert">{chatError} <button type="button" onClick={() => { setChatError(""); void loadMessages(); }}>إعادة المحاولة</button></div>}
                    </div>
                    <form className="message-composer" onSubmit={sendMessage}>
                      {selectedFiles.length > 0 && <div className="pending-attachments">{selectedFiles.map((file, index) => <PendingAttachment key={`${file.name}-${file.lastModified}-${index}`} file={file} onRemove={() => setSelectedFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))} />)}</div>}
                      <div className="composer-input-row">
                        <input ref={fileInputRef} className="attachment-input" type="file" multiple accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={(event) => {
                          const incoming = Array.from(event.currentTarget.files ?? []);
                          const available = Math.max(0, 5 - selectedFiles.length);
                          setChatError(incoming.length > available ? "يمكن إرفاق ٥ ملفات كحد أقصى في الرسالة." : "");
                          setSelectedFiles((current) => [...current, ...incoming.slice(0, available)]);
                          event.currentTarget.value = "";
                        }} />
                        <button className="attach-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={sending} aria-label="إرفاق صورة أو ملف" title="إرفاق صورة أو ملف"><Paperclip /></button>
                        <textarea aria-label="نص الرسالة" value={draftMessage} onChange={(event) => setDraftMessage(event.target.value)} placeholder="اكتب رسالتك هنا..." rows={1} maxLength={4000} disabled={sending} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia("(hover: hover) and (pointer: fine)").matches) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
                        <button className="send-button" type="submit" disabled={(!draftMessage.trim() && selectedFiles.length === 0) || sending} aria-label="إرسال الرسالة">{sending ? <span className="spinner" /> : <Send />}</button>
                      </div>
                      <div className="composer-bottom"><span>حتى ٥ ملفات، ١٠ ميغابايت لكل ملف</span><span className="composer-hint">Enter للإرسال · Shift + Enter لسطر جديد</span></div>
                    </form>
                  </> : <div className="chat-empty no-active-chat"><span><MessageCircle /></span><strong>كل حديث يبدأ برسالة</strong><p>اختر محادثة من القائمة لبدء التواصل.</p><div className="empty-chat-privacy"><ShieldCheck /> محادثاتك في مساحة خاصة</div></div>}
                </div>
              </div>
            )}
          </section>
        )}
      </main>
      {pinDialog && <PinDialog key={pinDialog} mode={pinDialog} onClose={() => setPinDialog(null)} onSubmit={submitPin} />}
      {deleteTarget && <ConfirmationDialog target={deleteTarget} busy={deleting} error={deleteError} onClose={() => setDeleteTarget(null)} onConfirm={() => void confirmDelete()} />}
    </div>
  );
}

export default function NotesApp() {
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch (error) {
      console.error("Could not clear a previously saved session", error);
    }
  }, []);

  const login = (nextSession: Session) => {
    setSession(nextSession);
  };

  const logout = () => {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch (error) {
      console.error("Could not clear a previously saved session", error);
    }
    setSession(null);
    navigate("/");
  };

  return session ? <Workspace session={session} onLogout={logout} /> : <Login onLogin={login} />;
}
