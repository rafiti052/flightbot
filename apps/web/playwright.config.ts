import { defineConfig, devices } from "playwright/test";

const PORT = 3002;
const BOT_PORT = 4010;
const NEXTAUTH_SECRET = "e2e-nextauth-secret-for-tests-only";
const BOT_TOKEN = "e2e-bot-token";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: "next dev -p 3002 -H 0.0.0.0",
    port: PORT,
    reuseExistingServer: false,
    env: {
      ...process.env,
      NEXTAUTH_URL: `http://localhost:${PORT}`,
      NEXTAUTH_SECRET,
      GOOGLE_CLIENT_ID: "e2e-google-client-id",
      GOOGLE_CLIENT_SECRET: "e2e-google-client-secret",
      ADMIN_ALLOWLIST: "admin@example.com",
      FLIGHTBOT_BOT_URL: `http://127.0.0.1:${BOT_PORT}`,
      FLIGHTBOT_ADMIN_TOKEN: BOT_TOKEN,
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
