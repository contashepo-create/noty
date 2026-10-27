import { defineConfig } from "@playwright/test";

// The tests deliberately exercise destructive operations on dedicated local accounts.
const baseURL = process.env.SUPERNOTI_WEB_TEST_URL || "http://127.0.0.1:5173";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)) {
  throw new Error("End-to-end tests may only target a local development server.");
}

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    headless: true,
    launchOptions: process.env.SUPERNOTI_CHROMIUM_PATH ? {
      executablePath: process.env.SUPERNOTI_CHROMIUM_PATH,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    } : undefined,
  },
});
