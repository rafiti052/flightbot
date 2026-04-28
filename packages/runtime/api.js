import crypto from "node:crypto";

export function maskConfig(config) {
  return {
    ...config,
    anthropic: { ...config.anthropic, apiKey: "••••••" },
    telegram: { ...config.telegram, token: "••••••" },
  };
}

export function requireAdminAuth(req, res, next) {
  const expected = process.env.FLIGHTBOT_ADMIN_TOKEN;
  if (!expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const header = req.get("authorization") || req.get("Authorization");
  if (!header || typeof header !== "string") {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const presented = match[1].trim();
  if (!presented) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const presentedBuf = Buffer.from(presented, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (presentedBuf.length !== expectedBuf.length) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!crypto.timingSafeEqual(presentedBuf, expectedBuf)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
}

export function deepMergePreservingSensitive(incoming, onDisk) {
  return {
    ...onDisk,
    ...incoming,
    anthropic: { ...onDisk.anthropic },
    telegram: {
      ...onDisk.telegram,
      chatId: incoming.telegram?.chatId ?? onDisk.telegram.chatId,
    },
  };
}

export function createConfigWriteRateLimit() {
  const CONFIG_WRITE_RATE_WINDOW_MS = 60_000;
  const CONFIG_WRITE_RATE_MAX = 5;
  const configWriteHits = new Map();

  return function configWriteRateLimit(req, res, next) {
    const ip = req.ip || "unknown";
    const now = Date.now();
    const cutoff = now - CONFIG_WRITE_RATE_WINDOW_MS;
    const recent = (configWriteHits.get(ip) || []).filter((t) => t > cutoff);
    if (recent.length >= CONFIG_WRITE_RATE_MAX) {
      configWriteHits.set(ip, recent);
      return res.status(429).json({ error: "Rate limit exceeded" });
    }
    recent.push(now);
    configWriteHits.set(ip, recent);
    return next();
  };
}
