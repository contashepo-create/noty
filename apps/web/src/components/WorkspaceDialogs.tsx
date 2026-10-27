import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { KeyRound, LockKeyhole, ShieldCheck, Trash2, UnlockKeyhole, X } from "lucide-react";

export type PinDialogMode = "setup" | "change" | "disable";
export type DeleteTarget =
  | { type: "note"; id: string }
  | { type: "message"; id: string }
  | { type: "conversation"; contact: string }
  | { type: "all" };

function normalizePin(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  }).replace(/\D/g, "").slice(0, 8);
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const modalRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const modal = modalRef.current;
    const focusable = () => Array.from(modal?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    (modal?.querySelector<HTMLElement>("[data-autofocus]") ?? focusable()[0])?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === "Tab") {
        const elements = focusable();
        if (!elements.length) return;
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("keydown", handleKey); previousFocus?.focus(); };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={modalRef} className="workspace-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-heading"><h2 id="modal-title">{title}</h2><button type="button" className="icon-button modal-close" onClick={onClose} aria-label="إغلاق"><X /></button></div>
        {children}
      </div>
    </div>
  );
}

export function PinDialog({ mode, onClose, onSubmit }: {
  mode: PinDialogMode;
  onClose: () => void;
  onSubmit: (currentPin: string, newPin: string) => Promise<void>;
}) {
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const title = mode === "setup" ? "تفعيل قفل المحادثات" : mode === "change" ? "تغيير الرمز السري" : "إيقاف قفل المحادثات";

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (mode !== "setup" && currentPin.length < 4) return setError("أدخل الرمز الحالي المكوّن من ٤ إلى ٨ أرقام.");
    if (mode !== "disable" && newPin.length < 4) return setError("اختر رمزًا من ٤ إلى ٨ أرقام.");
    if (mode !== "disable" && newPin !== confirmation) return setError("الرمزان غير متطابقين. حاول مجددًا.");
    setBusy(true);
    try { await onSubmit(currentPin, newPin); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر إكمال العملية."); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={title} onClose={() => { if (!busy) onClose(); }}>
      <div className="modal-intro-icon"><LockKeyhole /></div>
      <p className="modal-description">
        {mode === "setup"
          ? "أضف رمزًا لحماية محادثات حسابك على جميع أجهزتك. سيُطلب عند العودة إلى الدعم."
          : mode === "change" ? "أدخل رمزك الحالي، ثم اختر رمزًا جديدًا لمحادثاتك."
            : "أدخل رمزك الحالي لإيقاف القفل والسماح بفتح المحادثات دون رمز."}
      </p>
      <form className="pin-form" onSubmit={handleSubmit}>
        {mode !== "setup" && <label>الرمز الحالي<input data-autofocus type="password" inputMode="numeric" autoComplete="off" value={currentPin} onChange={(event) => setCurrentPin(normalizePin(event.target.value))} placeholder="أدخل الرمز الحالي" maxLength={8} /></label>}
        {mode !== "disable" && <>
          <label>{mode === "setup" ? "الرمز السري" : "الرمز الجديد"}<input data-autofocus={mode === "setup" ? true : undefined} type="password" inputMode="numeric" autoComplete="off" value={newPin} onChange={(event) => setNewPin(normalizePin(event.target.value))} placeholder="من ٤ إلى ٨ أرقام" maxLength={8} /></label>
          <label>تأكيد الرمز<input type="password" inputMode="numeric" autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(normalizePin(event.target.value))} placeholder="أعد إدخال الرمز" maxLength={8} /></label>
        </>}
        {mode === "setup" && <p className="pin-note"><ShieldCheck /> احتفظ برمزك في مكان آمن؛ لا يمكن استعادته من داخل التطبيق.</p>}
        {error && <div className="dialog-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>إلغاء</button>
          <button type="submit" className={`primary-button ${mode === "disable" ? "danger-button" : ""}`} disabled={busy}>{busy ? "جارٍ الحفظ..." : mode === "setup" ? "تفعيل القفل" : mode === "change" ? "حفظ الرمز" : "إيقاف القفل"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ChatLockScreen({ onUnlock, busy, notice }: { onUnlock: (pin: string) => Promise<void>; busy: boolean; notice: string }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (pin.length < 4) return setError("أدخل رمزًا من ٤ إلى ٨ أرقام.");
    setSubmitting(true);
    try { await onUnlock(pin); setPin(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر فتح المحادثات."); }
    finally { setSubmitting(false); }
  };
  return (
    <div className="chat-lock-screen">
      <div className="lock-illustration"><span><LockKeyhole /></span><i className="lock-spark lock-spark-one">✦</i><i className="lock-spark lock-spark-two">✧</i></div>
      <span className="lock-eyebrow">مساحة خاصة بك</span>
      <h2>المحادثات مقفلة</h2>
      <p>أدخل الرمز السري لفتح محادثاتك ومتابعة التواصل.</p>
      <form className="unlock-form" onSubmit={handleSubmit}>
        <label htmlFor="unlock-pin">الرمز السري</label>
        <div className="pin-input-wrap"><KeyRound /><input id="unlock-pin" type="password" inputMode="numeric" autoComplete="off" placeholder="أدخل الرمز السري" value={pin} maxLength={8} onChange={(event) => setPin(normalizePin(event.target.value))} /></div>
        {(error || notice) && <div className="dialog-error" role="alert">{error || notice}</div>}
        <button className="primary-button unlock-button" type="submit" disabled={submitting || busy}>{busy ? "جارٍ قفل المحادثات..." : submitting ? "جارٍ التحقق..." : <><UnlockKeyhole /> فتح المحادثات</>}</button>
      </form>
      <div className="lock-footnote"><ShieldCheck /> القفل خاص بحسابك ولا يغيّر وصول الطرف الآخر.</div>
    </div>
  );
}

export function ConfirmationDialog({ target, busy, error, onClose, onConfirm }: {
  target: DeleteTarget;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const title = target.type === "note" ? "حذف الملاحظة؟" : target.type === "message" ? "حذف الرسالة؟" : target.type === "conversation" ? "مسح المحادثة؟" : "مسح جميع المحادثات؟";
  const description = target.type === "note"
    ? "ستُحذف هذه الملاحظة من حسابك. لا يمكن التراجع عن هذا الإجراء."
    : target.type === "message"
      ? "ستُحذف الرسالة ومرفقاتها من حسابك وحساب الطرف الآخر نهائيًا."
      : target.type === "conversation"
        ? `ستُحذف كل الرسائل والمرفقات في محادثتك مع ${target.contact} من حساب الطرفين نهائيًا.`
        : "ستُحذف كل رسائلك ومرفقاتك في جميع المحادثات من حسابك وحسابات الأطراف الأخرى نهائيًا.";
  return (
    <Modal title={title} onClose={() => { if (!busy) onClose(); }}>
      <div className="modal-intro-icon danger-icon"><Trash2 /></div>
      <p className="modal-description">{description}</p>
      <p className="delete-warning">لا يمكن التراجع عن هذا الإجراء.</p>
      {error && <div className="dialog-error" role="alert">{error}</div>}
      <div className="modal-actions">
        <button data-autofocus type="button" className="secondary-button" onClick={onClose} disabled={busy}>تراجع</button>
        <button type="button" className="primary-button danger-button" onClick={onConfirm} disabled={busy}>{busy ? "جارٍ الحذف..." : target.type === "all" ? "نعم، امسح الكل" : "نعم، احذف"}</button>
      </div>
    </Modal>
  );
}
