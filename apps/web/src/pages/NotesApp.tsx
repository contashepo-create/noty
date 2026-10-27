import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

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
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");

function sessionHeaders(token: string): Headers {
  const headers = new Headers();
  headers.set("Authorization", ["Bearer", token].join(" "));
  return headers;
}

async function api<T>(path: string, token?: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `تعذر إكمال الطلب (${response.status})`);
  }
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

function MessageAttachmentView({ messageId, attachment, token }: {
  messageId: string;
  attachment: MessageAttachment;
  token: string;
}) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [error, setError] = useState("");
  const isImage = attachment.contentType.startsWith("image/");

  const openAttachment = async () => {
    setError("");
    try {
      const response = await fetch(
        `${API_BASE_URL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}`,
        { headers: sessionHeaders(token) },
      );
      if (!response.ok) {
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
      setError(cause instanceof Error ? cause.message : "تعذر تحميل الملف");
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

function Workspace({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [notes, setNotes] = useState<Note[]>(() => readNotes(session.user.username));
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [noteSyncStatus, setNoteSyncStatus] = useState("جاري تحميل ملاحظاتك...");
  const noteSyncTimers = useRef(new Map<string, number>());
  const notesSyncError = useRef<(error: unknown) => void>(() => {});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [section, setSection] = useState<"notes" | "messages">("notes");
  const [search, setSearch] = useState("");
  const [contacts, setContacts] = useState<string[]>([]);
  const [activeContact, setActiveContact] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draftMessage, setDraftMessage] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [chatError, setChatError] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [sending, setSending] = useState(false);

  const selectedNote = notes.find((note) => note.id === selectedId) ?? null;
  const filteredNotes = useMemo(() => notes.filter((note) => `${note.title} ${note.content}`.toLowerCase().includes(search.toLowerCase())), [notes, search]);

  useEffect(() => {
    let active = true;
    const cachedNotes = readNotes(session.user.username);
    api<{ notes: Note[] }>("/notes", session.token).then(async ({ notes: cloudNotes }) => {
      let nextNotes = cloudNotes;
      if (cloudNotes.length === 0 && cachedNotes.length > 0) {
        await Promise.all(cachedNotes.map((note) => api("/notes", session.token, {
          method: "POST",
          body: JSON.stringify(note),
        })));
        nextNotes = cachedNotes;
      }
      if (!active) return;
      setNotes(nextNotes);
      setNotesLoaded(true);
      setNoteSyncStatus("متزامنة مع Cloudflare");
    }).catch((error: unknown) => {
      if (!active) return;
      setNotes(cachedNotes);
      setNotesLoaded(true);
      setNoteSyncStatus(error instanceof Error ? error.message : "تعذرت مزامنة الملاحظات");
    });
    return () => { active = false; };
  }, [session.token, session.user.username]);

  useEffect(() => {
    localStorage.setItem(notesKey(session.user.username), JSON.stringify(notes));
  }, [notes, session.user.username]);

  useEffect(() => {
    notesSyncError.current = (error) => {
      setNoteSyncStatus(error instanceof Error ? error.message : "تعذر حفظ الملاحظة على Cloudflare");
    };
  }, []);

  useEffect(() => () => {
    for (const timer of noteSyncTimers.current.values()) window.clearTimeout(timer);
  }, []);

  const scheduleNoteSave = (note: Note) => {
    const previousTimer = noteSyncTimers.current.get(note.id);
    if (previousTimer) window.clearTimeout(previousTimer);
    setNoteSyncStatus("جارٍ الحفظ على Cloudflare...");
    const timer = window.setTimeout(() => {
      noteSyncTimers.current.delete(note.id);
      void api("/notes", session.token, {
        method: "POST",
        body: JSON.stringify(note),
      }).then(() => setNoteSyncStatus("متزامنة مع Cloudflare")).catch(notesSyncError.current);
    }, 450);
    noteSyncTimers.current.set(note.id, timer);
  };

  useEffect(() => {
    let active = true;
    api<{ users: string[] }>("/users", session.token)
      .then(({ users }) => {
        if (active) {
          setContacts(users);
          setActiveContact((current) => current || users[0] || "");
        }
      })
      .catch((error: unknown) => {
        if (active) setChatError(error instanceof Error ? error.message : "تعذر تحميل جهات الاتصال");
      });
    return () => { active = false; };
  }, [session.token]);

  const loadMessages = useCallback(async () => {
    if (!activeContact) return;
    try {
      const result = await api<{ messages: Message[] }>(`/messages/${encodeURIComponent(activeContact)}`, session.token);
      setMessages(result.messages);
      setChatError("");
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "تعذر تحميل المحادثة");
    }
  }, [activeContact, session.token]);

  useEffect(() => {
    if (section !== "messages" || !activeContact) return;
    setChatLoading(true);
    void loadMessages().finally(() => setChatLoading(false));
    const timer = window.setInterval(() => { void loadMessages(); }, 3000);
    return () => window.clearInterval(timer);
  }, [loadMessages, section, activeContact]);

  const createNote = () => {
    const now = Date.now();
    const note: Note = { id: crypto.randomUUID(), title: "", content: "", createdAt: now, updatedAt: now };
    setNotes((current) => [note, ...current]);
    setSelectedId(note.id);
    setSection("notes");
    if (notesLoaded) scheduleNoteSave(note);
  };

  const updateNote = (field: "title" | "content", value: string) => {
    if (!selectedNote) return;
    const updatedNote = { ...selectedNote, [field]: value, updatedAt: Date.now() };
    setNotes((current) => current.map((note) => note.id === selectedId ? updatedNote : note));
    if (notesLoaded) scheduleNoteSave(updatedNote);
  };

  const deleteSelectedNote = () => {
    if (!selectedNote) return;
    const pendingTimer = noteSyncTimers.current.get(selectedNote.id);
    if (pendingTimer) window.clearTimeout(pendingTimer);
    noteSyncTimers.current.delete(selectedNote.id);
    setNotes((current) => current.filter((note) => note.id !== selectedNote.id));
    setSelectedId(null);
    if (notesLoaded) {
      setNoteSyncStatus("جارٍ حذف الملاحظة...");
      void api(`/notes/${encodeURIComponent(selectedNote.id)}`, session.token, { method: "DELETE" })
        .then(() => setNoteSyncStatus("متزامنة مع Cloudflare"))
        .catch(notesSyncError.current);
    }
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    const content = draftMessage.trim();
    if ((!content && selectedFiles.length === 0) || !activeContact || sending) return;
    setSending(true);
    setChatError("");
    try {
      const form = new FormData();
      form.append("recipient", activeContact);
      form.append("content", content);
      selectedFiles.forEach((file) => form.append("files", file));
      await api("/messages", session.token, { method: "POST", body: form });
      setDraftMessage("");
      setSelectedFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadMessages();
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "تعذر إرسال الرسالة");
    } finally {
      setSending(false);
    }
  };

  const initials = session.user.username.slice(0, 1).toUpperCase();

  return (
    <div className="app-shell" dir="rtl">
      <aside className="sidebar">
        <div className="sidebar-brand"><Brand compact /><span className="sidebar-menu-mark">⌘</span></div>
        <button className="new-note-button" onClick={createNote}><span>＋</span> ملاحظة جديدة <kbd>⌘ N</kbd></button>
        <div className="nav-caption">مساحتك</div>
        <nav className="main-nav" aria-label="التنقل الرئيسي">
          <button className={section === "notes" ? "nav-item active" : "nav-item"} onClick={() => setSection("notes")}><span className="nav-icon">▤</span><span>كل الملاحظات</span><span className="nav-count">{notes.length}</span></button>
          <button className={section === "messages" ? "nav-item active" : "nav-item"} onClick={() => setSection("messages")}><span className="nav-icon">◌</span><span>الدعم</span><span className="nav-count">{contacts.length}</span></button>
        </nav>
        <div className="sidebar-divider" />
        <div className="nav-caption list-caption">ملاحظاتك <button onClick={createNote} aria-label="إضافة ملاحظة">＋</button></div>
        <div className="note-list">
          {notes.slice(0, 8).map((note) => (
            <button key={note.id} className={`note-list-item ${selectedId === note.id && section === "notes" ? "selected" : ""}`} onClick={() => { setSelectedId(note.id); setSection("notes"); }}>
              <span className="note-list-icon">✎</span><span className="note-list-copy"><strong>{note.title || "ملاحظة بدون عنوان"}</strong><small>{note.content || "ابدأ بالكتابة..."}</small></span>
            </button>
          ))}
          {notes.length === 0 && <p className="empty-sidebar">ملاحظاتك الجديدة ستظهر هنا</p>}
        </div>
        <div className="sidebar-bottom">
          <div className="sync-status"><span className="status-dot" /><span>{noteSyncStatus}</span><span className="sync-cloud">☁</span></div>
          <div className="profile-summary"><span className="profile-avatar">{initials}</span><span className="profile-copy"><strong>{session.user.username}</strong><small>حسابك الشخصي</small></span></div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumb"><span>مساحتي</span><span className="crumb-slash">/</span><strong>{section === "notes" ? "كل الملاحظات" : "الدعم"}</strong></div>
          <div className="topbar-actions"><label className="search-box"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث في مساحتك..." /><kbd>⌘ K</kbd></label><button className="logout-button" onClick={onLogout}><span aria-hidden="true">↗</span> تسجيل الخروج</button><span className="topbar-avatar">{initials}</span></div>
        </header>

        {section === "notes" ? (
          <div className="notes-layout">
            <section className="notes-column">
              <div className="page-heading"><div><span className="eyebrow muted-eyebrow">مساحة مرتبة، ذهن أصفى</span><h1>كل الملاحظات<span className="heading-count">{notes.length}</span></h1><p>أفكارك الصغيرة تصنع أشياء كبيرة.</p></div><button className="primary-button create-note" onClick={createNote}>＋ <span>ملاحظة جديدة</span></button></div>
              <div className="notes-toolbar"><span>{filteredNotes.length} ملاحظات</span><button>الأحدث أولًا <span>⌄</span></button></div>
              {filteredNotes.length ? (
                <div className="notes-grid">
                  {filteredNotes.map((note, index) => (
                    <button key={note.id} className={`note-card note-tone-${index % 4} ${selectedId === note.id ? "note-card-selected" : ""}`} onClick={() => setSelectedId(note.id)}>
                      <span className="note-card-mark">{["✦", "◈", "⌁", "✳"][index % 4]}</span><strong>{note.title || "ملاحظة بدون عنوان"}</strong><p>{note.content || "أضف بعض الأفكار إلى هذه الملاحظة..."}</p><small>{new Date(note.updatedAt).toLocaleDateString("ar", { day: "numeric", month: "long" })}</small>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-notes"><span className="empty-note-icon">✎</span><h2>{search ? "لا توجد نتائج" : "مساحتك تبدأ بفكرة"}</h2><p>{search ? "جرّب البحث بكلمات مختلفة." : "أنشئ ملاحظتك الأولى ودع أفكارك تأخذ مكانها."}</p>{!search && <button className="primary-button" onClick={createNote}>＋ إنشاء ملاحظة</button>}</div>
              )}
            </section>
            <section className={`editor-panel ${selectedNote ? "editor-open" : ""}`}>
              {selectedNote ? (
                <>
                  <div className="editor-actions"><span className="saved-label"><i /> تم الحفظ محليًا</span><button onClick={deleteSelectedNote} aria-label="حذف الملاحظة" title="حذف الملاحظة">⌫</button></div>
                  <input className="editor-title" value={selectedNote.title} onChange={(e) => updateNote("title", e.target.value)} placeholder="عنوان الملاحظة" />
                  <div className="editor-meta"><span>آخر تعديل {new Date(selectedNote.updatedAt).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" })}</span><span>•</span><span>{selectedNote.content.trim().split(/\s+/).filter(Boolean).length} كلمات</span></div>
                  <textarea className="editor-content" value={selectedNote.content} onChange={(e) => updateNote("content", e.target.value)} placeholder="ابدأ بكتابة ما يدور في ذهنك..." />
                  <div className="editor-hint">تُحفظ ملاحظاتك تلقائيًا على هذا الجهاز.</div>
                </>
              ) : (
                <div className="editor-empty"><span>✦</span><h3>مساحة لأفكارك</h3><p>اختر ملاحظة لعرضها أو ابدأ واحدة جديدة.</p><button onClick={createNote}>＋ ملاحظة جديدة</button></div>
              )}
            </section>
          </div>
        ) : (
          <section className="messages-page">
            <div className="page-heading messages-heading"><div><span className="eyebrow muted-eyebrow">مركز المساعدة</span><h1>الدعم<span className="heading-count">{contacts.length}</span></h1><p>مساحتك الخاصة للتواصل مع فريقك.</p></div><span className="secure-chat-badge">◆ مساحة خاصة</span></div>
            <div className={`chat-card ${activeContact ? "chat-selected" : ""}`}>
              <aside className="contacts-panel"><div className="contacts-title"><strong>المحادثات</strong><span>{contacts.length}</span></div>
                {contacts.map((contact, index) => <button key={contact} className={`contact-item ${activeContact === contact ? "contact-active" : ""}`} onClick={() => { setActiveContact(contact); setMessages([]); setSelectedFiles([]); setChatError(""); }}><span className={`contact-avatar contact-color-${index % 3}`}>{contact.slice(0, 1).toUpperCase()}<i /></span><span className="contact-details"><strong>{contact}</strong><small>محادثة خاصة</small></span><span className="contact-chevron">‹</span></button>)}
                {!contacts.length && <div className="no-contacts">{chatError || "لا توجد حسابات أخرى مفعّلة بعد."}</div>}
              </aside>
              <div className="conversation">
                {activeContact ? <>
                  <div className="conversation-header"><button type="button" className="chat-back-button" onClick={() => { setActiveContact(""); setSelectedFiles([]); }} aria-label="العودة إلى المحادثات">›</button><span className="contact-avatar contact-color-0">{activeContact.slice(0, 1).toUpperCase()}</span><div><strong>{activeContact}</strong><small><i /> محادثة خاصة</small></div><span className="conversation-secure">◆</span></div>
                  <div className="message-history">
                    <div className="day-divider"><span>بداية المحادثة</span></div>
                    {chatLoading && messages.length === 0 && <div className="chat-loading"><span className="spinner" /> جارٍ تحميل المحادثة...</div>}
                    {!chatLoading && messages.length === 0 && <div className="chat-empty"><span>✉</span><strong>ابدأ محادثة لطيفة</strong><p>أرسل أول رسالة إلى {activeContact}.</p></div>}
                    {messages.map((message) => <div key={message.id} className={`message-row ${message.sender === session.user.username ? "message-mine" : ""}`}><div className="message-bubble">{message.content && <p>{message.content}</p>}{message.attachments?.map((attachment) => <MessageAttachmentView key={attachment.id} messageId={message.id} attachment={attachment} token={session.token} />)}<time>{new Date(message.createdAt).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" })}</time></div></div>)}
                    {chatError && <div className="chat-error" role="alert">{chatError} <button onClick={() => void loadMessages()}>إعادة المحاولة</button></div>}
                  </div>
                  <form className="message-composer" onSubmit={sendMessage}>
                    {selectedFiles.length > 0 && <div className="pending-attachments">{selectedFiles.map((file, index) => <PendingAttachment key={`${file.name}-${file.lastModified}-${index}`} file={file} onRemove={() => setSelectedFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))} />)}</div>}
                    <div className="composer-input-row">
                      <input ref={fileInputRef} className="attachment-input" type="file" multiple accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx" onChange={(event) => {
                        const incoming = Array.from(event.currentTarget.files ?? []);
                        const available = Math.max(0, 5 - selectedFiles.length);
                        if (incoming.length > available) setChatError("يمكن إرفاق 5 ملفات كحد أقصى في الرسالة.");
                        else setChatError("");
                        setSelectedFiles((current) => [...current, ...incoming.slice(0, available)]);
                        event.currentTarget.value = "";
                      }} />
                      <button className="attach-button" type="button" onClick={() => fileInputRef.current?.click()} aria-label="إرفاق صورة أو ملف" title="إرفاق صورة أو ملف">＋</button>
                      <textarea value={draftMessage} onChange={(e) => setDraftMessage(e.target.value)} placeholder="اكتب رسالتك..." rows={1} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
                      <button className="send-button" type="submit" disabled={(!draftMessage.trim() && selectedFiles.length === 0) || sending} aria-label="إرسال الرسالة">{sending ? "…" : "↑"}</button>
                    </div>
                    <div className="composer-bottom"><span>صور وملفات حتى 10 MB · بحد أقصى 5 ملفات</span><span className="composer-hint">Enter للإرسال</span></div>
                  </form>
                </> : <div className="chat-empty no-active-chat"><span>◌</span><strong>مساحة للتواصل</strong><p>اختر محادثة من القائمة لبدء المراسلة.</p></div>}
              </div>
            </div>
          </section>
        )}
      </main>
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
