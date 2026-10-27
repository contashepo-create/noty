import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const apiBase = process.env.SUPERNOTI_WORKER_TEST_URL || "http://127.0.0.1:8787";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(apiBase).hostname)) {
  throw new Error("End-to-end tests may only target a local Worker.");
}

async function api(path: string, token?: string, method = "GET", body?: unknown) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json() as Record<string, any>;
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function token(username: string): Promise<string> {
  const result = await api("/auth/login", undefined, "POST", { username, password: "test-only-password" });
  return result.token;
}

async function login(page: Page, username: string) {
  await page.goto("/notes?auth=1");
  await page.locator("#username").fill(username);
  await page.locator("#password").fill("test-only-password");
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page.getByRole("heading", { name: /ملاحظاتك/ })).toBeVisible();
}

async function clearNotes(userToken: string) {
  const result = await api("/notes", userToken);
  for (const note of result.notes) await api(`/notes/${encodeURIComponent(note.id)}`, userToken, "DELETE");
}

async function send(userToken: string, recipient: string, content: string) {
  return api("/messages", userToken, "POST", { recipient, content });
}

test("mobile notes save, close, search and recover an offline edit", async ({ page }) => {
  const alice = await token("test-alice");
  await clearNotes(alice);
  await login(page, "test-alice");
  await page.locator(".create-note").click();
  await expect(page.getByRole("button", { name: "حفظ وإغلاق" })).toBeInViewport();
  await page.getByLabel("عنوان الملاحظة").fill("ملاحظة اختبار الهاتف");
  await page.getByLabel("محتوى الملاحظة").fill("محتوى محفوظ في السحابة");
  await page.getByRole("button", { name: "حفظ وإغلاق" }).click();
  await expect(page.locator(".editor-panel.editor-open")).toHaveCount(0);
  await expect(page.locator(".note-card").filter({ hasText: "ملاحظة اختبار الهاتف" })).toBeVisible();
  await expect.poll(async () => (await api("/notes", alice)).notes[0]?.content).toBe("محتوى محفوظ في السحابة");

  await page.getByLabel("البحث في الملاحظات").fill("اختبار الهاتف");
  await expect(page.locator(".note-card")).toHaveCount(1);
  await page.getByLabel("البحث في الملاحظات").clear();
  await page.locator(".note-card").filter({ hasText: "ملاحظة اختبار الهاتف" }).click();
  await page.route("**/api/notes", async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 503, json: { error: "offline" } });
    else await route.continue();
  });
  await page.getByLabel("محتوى الملاحظة").fill("تعديل محفوظ محليًا دون اتصال");
  await page.getByRole("button", { name: "حفظ وإغلاق" }).click();
  await expect(page.locator(".notes-sync-caption")).toContainText("تعذرت المزامنة");
  expect((await api("/notes", alice)).notes[0].content).toBe("محتوى محفوظ في السحابة");
  await page.unroute("**/api/notes");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => (await api("/notes", alice)).notes[0]?.content).toBe("تعديل محفوظ محليًا دون اتصال");

  await page.locator(".note-card").filter({ hasText: "ملاحظة اختبار الهاتف" }).click();
  await page.route("**/api/notes", async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 503, json: { error: "offline" } });
    else await route.continue();
  });
  await page.getByLabel("محتوى الملاحظة").fill("تعديل يُستعاد بعد إعادة الدخول");
  await page.getByRole("button", { name: "حفظ وإغلاق" }).click();
  await expect(page.locator(".notes-sync-caption")).toContainText("تعذرت المزامنة");
  await page.unroute("**/api/notes");
  await page.reload();
  await page.locator("#username").fill("test-alice");
  await page.locator("#password").fill("test-only-password");
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page.locator(".note-card").filter({ hasText: "تعديل يُستعاد بعد إعادة الدخول" })).toBeVisible();
  expect((await api("/notes", alice)).notes[0].content).toBe("تعديل يُستعاد بعد إعادة الدخول");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await clearNotes(alice);
});

test("mobile support deletes one message, one conversation and all conversations", async ({ page }) => {
  const alice = await token("test-alice");
  const bob = await token("test-bob");
  const carol = await token("test-carol");
  for (const userToken of [alice, bob, carol]) await api("/conversations", userToken, "DELETE");
  await send(alice, "test-bob", "الرسالة التي سنحذفها");
  await send(bob, "test-alice", "رسالة ستبقى");
  await login(page, "test-bob");
  await page.getByRole("button", { name: "الدعم", exact: true }).click();
  await page.getByRole("button", { name: /test-alice/ }).click();
  const row = page.locator(".message-row").filter({ hasText: "الرسالة التي سنحذفها" });
  await row.getByRole("button", { name: "حذف الرسالة من الطرفين" }).click();
  await expect(page.getByRole("dialog")).toContainText("حساب الطرف الآخر");
  await page.getByRole("button", { name: "نعم، احذف" }).click();
  await expect(row).toHaveCount(0);
  expect((await api("/messages/test-bob", alice)).messages).toHaveLength(1);

  const composer = page.getByLabel("نص الرسالة");
  await composer.fill("سطر من الهاتف");
  await composer.press("Enter");
  await expect(composer).toHaveValue("سطر من الهاتف\n");
  await composer.fill("رسالة مع مرفق");
  await page.locator('input[type="file"]').setInputFiles({ name: "test.txt", mimeType: "text/plain", buffer: Buffer.from("file contents") });
  await page.getByRole("button", { name: "إرسال الرسالة" }).click();
  const sentRow = page.locator(".message-row").filter({ hasText: "رسالة مع مرفق" });
  await expect(sentRow).toContainText("test.txt");
  expect((await api("/messages/test-bob", alice)).messages).toHaveLength(2);
  await sentRow.getByRole("button", { name: "حذف الرسالة من الطرفين" }).click();
  await page.getByRole("button", { name: "نعم، احذف" }).click();
  await expect(sentRow).toHaveCount(0);
  await page.getByRole("button", { name: /مسح المحادثة مع test-alice/ }).click();
  await page.getByRole("button", { name: "نعم، احذف" }).click();
  await expect(page.getByText("ابدأ المحادثة")).toBeVisible();
  expect((await api("/messages/test-bob", alice)).messages).toHaveLength(0);

  await send(bob, "test-alice", "محادثة أولى");
  await send(bob, "test-carol", "محادثة ثانية");
  await send(alice, "test-carol", "محادثة لا تخص بوب");
  await page.getByRole("button", { name: "العودة إلى المحادثات" }).click();
  await page.getByRole("button", { name: "مسح جميع المحادثات" }).click();
  await page.getByRole("button", { name: "نعم، امسح الكل" }).click();
  expect((await api("/messages/test-bob", alice)).messages).toHaveLength(0);
  expect((await api("/messages/test-bob", carol)).messages).toHaveLength(0);
  expect((await api("/messages/test-carol", alice)).messages).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await api("/conversations", alice, "DELETE");
});

test("PIN can be enabled, unlocked, changed, relocked and disabled", async ({ page }) => {
  const carol = await token("test-carol");
  await login(page, "test-carol");
  await page.getByRole("button", { name: "الدعم", exact: true }).click();
  await page.getByRole("button", { name: "تفعيل القفل" }).click();
  const setup = page.getByRole("dialog");
  await setup.getByLabel("الرمز السري", { exact: true }).fill("١٢٣٤");
  await setup.getByLabel("تأكيد الرمز").fill("١٢٣٤");
  await setup.getByRole("button", { name: "تفعيل القفل" }).click();
  await expect(page.getByRole("heading", { name: "المحادثات مقفلة" })).toBeVisible();
  expect((await fetch(`${apiBase}/messages/test-alice`, { headers: { Authorization: `Bearer ${carol}` } })).status).toBe(423);
  await page.getByLabel("الرمز السري").fill("0000");
  await page.getByRole("button", { name: "فتح المحادثات" }).click();
  await expect(page.getByRole("alert")).toContainText("غير صحيح");
  await page.getByLabel("الرمز السري").fill("1234");
  await page.getByRole("button", { name: "فتح المحادثات" }).click();
  await expect(page.getByRole("button", { name: "قفل الآن" })).toBeVisible();
  await page.getByRole("button", { name: /test-alice/ }).click();
  await page.getByRole("button", { name: "قفل المحادثات الآن" }).click();
  await expect(page.getByRole("heading", { name: "المحادثات مقفلة" })).toBeVisible();
  await page.getByLabel("الرمز السري").fill("1234");
  await page.getByRole("button", { name: "فتح المحادثات" }).click();
  await page.getByRole("button", { name: "الملاحظات", exact: true }).click();
  await page.getByRole("button", { name: "الدعم", exact: true }).click();
  await expect(page.getByRole("heading", { name: "المحادثات مقفلة" })).toBeVisible();
  await page.getByLabel("الرمز السري").fill("1234");
  await page.getByRole("button", { name: "فتح المحادثات" }).click();
  await page.getByLabel("إدارة قفل المحادثات").click();
  await page.getByRole("button", { name: "تغيير الرمز السري" }).click();
  const change = page.getByRole("dialog");
  await change.getByLabel("الرمز الحالي").fill("1234");
  await change.getByLabel("الرمز الجديد").fill("5678");
  await change.getByLabel("تأكيد الرمز").fill("5678");
  await change.getByRole("button", { name: "حفظ الرمز" }).click();
  await expect(change).toHaveCount(0);
  await page.getByRole("button", { name: "قفل الآن" }).click();
  await page.getByLabel("الرمز السري").fill("5678");
  await page.getByRole("button", { name: "فتح المحادثات" }).click();
  await page.getByLabel("إدارة قفل المحادثات").click();
  await page.getByRole("button", { name: "إيقاف القفل" }).click();
  const disable = page.getByRole("dialog");
  await disable.getByLabel("الرمز الحالي").fill("5678");
  await disable.getByRole("button", { name: "إيقاف القفل" }).click();
  await expect(page.getByRole("button", { name: "تفعيل القفل" })).toBeVisible();
  expect((await api("/conversation-lock", carol)).enabled).toBe(false);
});


test("small phones keep the editor and chat controls on screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const alice = await token("test-alice");
  await login(page, "test-alice");
  await page.locator(".create-note").click();
  await expect(page.getByRole("button", { name: "حفظ وإغلاق" })).toBeInViewport();
  await page.getByLabel("عنوان الملاحظة").fill("شاشة صغيرة");
  await page.getByRole("button", { name: "حفظ وإغلاق" }).click();
  await expect.poll(async () => (await api("/notes", alice)).notes.some((note: { title: string }) => note.title === "شاشة صغيرة")).toBe(true);
  await page.getByRole("button", { name: "الدعم", exact: true }).click();
  await page.getByRole("button", { name: /test-bob/ }).click();
  await expect(page.getByRole("button", { name: "إرسال الرسالة" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await clearNotes(alice);
});

test.describe("desktop layout", () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
  test("keeps the editor and chat usable within the viewport", async ({ page }) => {
    await login(page, "test-alice");
    await page.locator(".create-note").click();
    await expect(page.getByRole("button", { name: "حفظ وإغلاق" })).toBeVisible();
    await page.getByLabel("عنوان الملاحظة").fill("ملاحظة سطح المكتب");
    await page.getByRole("button", { name: "حفظ وإغلاق" }).click();
    await page.getByRole("button", { name: "الدعم", exact: true }).click();
    await page.getByRole("button", { name: /test-bob/ }).click();
    await expect(page.locator(".message-composer")).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(900);
    const alice = await token("test-alice");
    await expect.poll(async () => (await api("/notes", alice)).notes.some((note: { title: string }) => note.title === "ملاحظة سطح المكتب")).toBe(true);
    await clearNotes(alice);
  });
});

test("an empty cloud account does not resurrect notes deleted on another device", async ({ page }) => {
  const alice = await token("test-alice");
  await clearNotes(alice);
  await login(page, "test-alice");
  await page.locator(".create-note").click();
  await page.getByLabel("عنوان الملاحظة").fill("ملاحظة ستُحذف من جهاز آخر");
  await page.getByRole("button", { name: "حفظ وإغلاق" }).click();
  await expect.poll(async () => (await api("/notes", alice)).notes.length).toBe(1);
  await clearNotes(alice);
  await page.reload();
  await page.locator("#username").fill("test-alice");
  await page.locator("#password").fill("test-only-password");
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page.locator(".notes-sync-caption")).toContainText("متزامنة");
  await expect(page.locator(".note-card")).toHaveCount(0);
  expect((await api("/notes", alice)).notes).toHaveLength(0);
});

test("offline edits and newer cloud edits are preserved as separate notes", async ({ page }) => {
  const alice = await token("test-alice");
  await clearNotes(alice);
  await login(page, "test-alice");
  await page.locator(".create-note").click();
  await page.getByLabel("عنوان الملاحظة").fill("ملاحظة مشتركة");
  await page.getByLabel("محتوى الملاحظة").fill("المحتوى الأصلي");
  await page.getByRole("button", { name: "حفظ وإغلاق" }).click();
  await expect.poll(async () => (await api("/notes", alice)).notes[0]?.content).toBe("المحتوى الأصلي");

  await page.locator(".note-card").filter({ hasText: "ملاحظة مشتركة" }).click();
  await page.route("**/api/notes", async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 503, json: { error: "offline" } });
    else await route.continue();
  });
  await page.getByLabel("محتوى الملاحظة").fill("تعديل الجهاز المحلي");
  await page.getByRole("button", { name: "حفظ وإغلاق" }).click();
  await expect(page.locator(".notes-sync-caption")).toContainText("تعذرت المزامنة");
  const original = (await api("/notes", alice)).notes[0];
  await api("/notes", alice, "POST", { ...original, content: "تعديل جهاز آخر", updatedAt: Date.now() + 60_000 });
  await page.unroute("**/api/notes");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".notes-sync-caption")).toContainText("تعارضت التعديلات");

  await page.reload();
  await page.locator("#username").fill("test-alice");
  await page.locator("#password").fill("test-only-password");
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page.locator(".notes-sync-caption")).toContainText("نسخة منفصلة");
  await expect(page.locator(".note-card").filter({ hasText: "تعديل جهاز آخر" })).toBeVisible();
  await expect(page.locator(".note-card").filter({ hasText: "تعديل الجهاز المحلي" })).toBeVisible();
  const notes = (await api("/notes", alice)).notes;
  expect(notes).toHaveLength(2);
  expect(notes.find((note: { id: string }) => note.id === original.id).content).toBe("تعديل جهاز آخر");
  expect(notes.find((note: { title: string }) => note.title.includes("نسخة محلية")).content).toBe("تعديل الجهاز المحلي");
  await clearNotes(alice);
});

test("a partially failed legacy import retries the remaining local notes", async ({ page }) => {
  const alice = await token("test-alice");
  await clearNotes(alice);
  await page.goto("/notes?auth=1");
  await page.evaluate(() => {
    const now = Date.now();
    localStorage.setItem("supernoti-notes:test-alice", JSON.stringify([
      { id: "legacy-one", title: "القديمة الأولى", content: "one", createdAt: now, updatedAt: now },
      { id: "legacy-two", title: "القديمة الثانية", content: "two", createdAt: now, updatedAt: now },
    ]));
    localStorage.removeItem("supernoti-notes-dirty:test-alice");
    localStorage.removeItem("supernoti-notes-cloud-initialized:test-alice");
  });
  await page.route("**/api/notes", async (route) => {
    if (route.request().method() === "POST" && route.request().postDataJSON().id === "legacy-two") {
      await route.fulfill({ status: 503, json: { error: "offline" } });
    } else await route.continue();
  });
  await login(page, "test-alice");
  await expect(page.locator(".notes-sync-caption")).toContainText("تعذرت المزامنة");
  expect((await api("/notes", alice)).notes).toHaveLength(1);
  await expect(page.locator(".note-card")).toHaveCount(2);
  await page.unroute("**/api/notes");
  await page.reload();
  await page.locator("#username").fill("test-alice");
  await page.locator("#password").fill("test-only-password");
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page.locator(".notes-sync-caption")).toContainText("متزامنة");
  await expect(page.locator(".note-card")).toHaveCount(2);
  expect((await api("/notes", alice)).notes).toHaveLength(2);
  await clearNotes(alice);
});

test("the public landing page keeps its hidden sign-in gesture and logout destination", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("searchbox", { name: "Search the web" })).toBeVisible();
  const logo = page.getByRole("button", { name: "Search home" });
  for (let count = 0; count < 7; count++) await logo.click();
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await logo.click();
  await expect(page.locator("#username")).toBeVisible();
  await page.locator("#username").fill("test-alice");
  await page.locator("#password").fill("test-only-password");
  await page.getByRole("button", { name: "تسجيل الدخول" }).click();
  await expect(page.getByRole("heading", { name: /ملاحظاتك/ })).toBeVisible();
  await page.getByRole("button", { name: "تسجيل الخروج" }).click();
  await expect(page.getByRole("searchbox", { name: "Search the web" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("save and close stays open when local retry metadata cannot be stored", async ({ page }) => {
  const alice = await token("test-alice");
  await clearNotes(alice);
  await login(page, "test-alice");
  await page.locator(".create-note").click();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("supernoti-notes-dirty:")) throw new DOMException("Storage full", "QuotaExceededError");
      return original.call(this, key, value);
    };
    (window as typeof window & { restoreStorage?: () => void }).restoreStorage = () => { Storage.prototype.setItem = original; };
  });
  await page.getByLabel("عنوان الملاحظة").fill("حفظ آمن");
  await page.getByRole("button", { name: "حفظ وإغلاق" }).click();
  await expect(page.locator(".editor-panel.editor-open")).toBeVisible();
  await expect(page.locator(".editor-hint")).toContainText("تعذر الحفظ");
  await page.evaluate(() => (window as typeof window & { restoreStorage?: () => void }).restoreStorage?.());
  await page.getByRole("button", { name: "حفظ وإغلاق" }).click();
  await expect(page.locator(".editor-panel.editor-open")).toHaveCount(0);
  await expect.poll(async () => (await api("/notes", alice)).notes.some((note: { title: string }) => note.title === "حفظ آمن")).toBe(true);
  await clearNotes(alice);
});
