import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test, expect } from "playwright/test";
import { encode } from "next-auth/jwt";

const BOT_PORT = 4010;
const BOT_TOKEN = "e2e-bot-token";
const NEXTAUTH_SECRET = "e2e-nextauth-secret-for-tests-only";

type BotConfig = {
  revision: number;
  schedule: string;
  routes: Array<{ name: string; active: boolean; from: string; to: string; maxBudget: number | null }>;
  anthropic: { apiKey: string };
  telegram: { token: string; chatId: string };
};

function json(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

test.describe("Authenticated config journey", () => {
  let server: ReturnType<typeof createServer>;
  let configState: BotConfig;
  let lastPutPayload: Record<string, unknown> | null = null;

  test.beforeAll(async () => {
    configState = {
      revision: 7,
      schedule: "0 7 * * *",
      routes: [{ name: "E2E Route", active: true, from: "GRU", to: "LIS", maxBudget: 3000 }],
      anthropic: { apiKey: "anthropic-secret" },
      telegram: { token: "telegram-secret", chatId: "123" },
    };

    server = createServer(async (req, res) => {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${BOT_TOKEN}`) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }

      if (req.method === "GET" && req.url === "/config") {
        json(res, 200, configState);
        return;
      }

      if (req.method === "GET" && req.url === "/status") {
        json(res, 200, {
          healthy: true,
          lastRunAt: new Date().toISOString(),
        });
        return;
      }

      if (req.method === "PUT" && req.url === "/config") {
        const raw = await readBody(req);
        const payload = JSON.parse(raw) as Record<string, unknown>;
        lastPutPayload = payload;
        configState = {
          ...(payload as unknown as BotConfig),
          revision: configState.revision + 1,
        };
        json(res, 200, { ok: true, revision: configState.revision });
        return;
      }

      json(res, 404, { error: "Not found" });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(BOT_PORT, "127.0.0.1", () => resolve());
    });
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  test("opens authenticated page, edits schedule, saves, and confirms success", async ({ browser }) => {
    const sessionToken = await encode({
      secret: NEXTAUTH_SECRET,
      token: {
        sub: "e2e-user",
        email: "admin@example.com",
        name: "E2E Admin",
      },
      maxAge: 60 * 60,
    });

    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "next-auth.session-token",
        value: sessionToken,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    const page = await context.newPage();
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Schedule" })).toBeVisible();

    const nextCron = "15 9 * * *";
    await page.getByLabel("Advanced cron expression").fill(nextCron);
    const saveResponsePromise = page.waitForResponse(
      (response) => response.url().includes("/api/config") && response.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "Save schedule" }).click();
    const saveResponse = await saveResponsePromise;

    expect(saveResponse.ok()).toBeTruthy();
    await expect.poll(() => lastPutPayload?.schedule).toBe(nextCron);
    await expect.poll(() => page.getByText("revision 8").count()).toBeGreaterThan(0);

    await context.close();
  });
});
