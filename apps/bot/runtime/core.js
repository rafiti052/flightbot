export function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function formatError(err) {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

export async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function shiftDate(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dateVariants(route) {
  const flex = route.flexDays ?? 0;
  if (flex === 0) return [route];

  const variants = [];
  for (let offset = -flex; offset <= flex; offset++) {
    variants.push({
      ...route,
      departureDate: shiftDate(route.departureDate, offset),
      returnDate: route.returnDate ? shiftDate(route.returnDate, offset) : undefined,
      _dateLabel: `dep ${shiftDate(route.departureDate, offset)}`,
    });
  }
  return variants;
}

export function buildUrl(route) {
  const depStr = route.departureDate;
  if (!depStr) throw new Error(`Route "${route.name}" is missing "departureDate"`);

  let query;
  if (route.roundTrip) {
    const retStr = route.returnDate;
    if (!retStr) throw new Error(`Route "${route.name}" is missing "returnDate" for a round trip`);
    query = `Round-trip ${route.from} to ${route.to} ${depStr} return ${retStr}`;
  } else {
    query = `One-way ${route.from} to ${route.to} ${depStr}`;
  }

  const currency = route.currency ?? "USD";
  return `https://www.google.com/travel/flights/search?q=${encodeURIComponent(query)}&curr=${currency}&hl=en`;
}

export function parseDurationHours(durationStr) {
  if (!durationStr) return null;
  const hrMatch = durationStr.match(/(\d+)\s*hr/);
  const minMatch = durationStr.match(/(\d+)\s*min/);
  const hours = hrMatch ? parseInt(hrMatch[1]) : 0;
  const minutes = minMatch ? parseInt(minMatch[1]) : 0;
  return hours + minutes / 60;
}

function formatDateLabel(dateStr) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatMessage(route, flight, alertType) {
  const emoji = { first: "🟢", lower: "📉", returned: "🔁" }[alertType];
  const stopsLabel = flight.stops === 0 ? "Nonstop" : `${flight.stops} stop${flight.stops > 1 ? "s" : ""}`;
  const currency = route.currency ?? "USD";
  const priceFormatted = flight.price.toLocaleString("pt-BR");

  const depLabel = formatDateLabel(route.departureDate);
  const retLabel = route.returnDate ? formatDateLabel(route.returnDate) : null;
  const dateStr = route.roundTrip && retLabel ? `${depLabel} → ${retLabel}` : depLabel;

  const timeStr =
    flight.depTime && flight.arrTime
      ? `${flight.depTime} → ${flight.arrTime}  (${flight.duration})`
      : flight.duration ?? "N/A";

  const searchLink = buildUrl(route);

  return (
    `${emoji} Good price found — ${route.name}\n\n` +
    `✈️  ${flight.airline ?? "Unknown airline"}  ·  ${stopsLabel}\n` +
    `📅  ${dateStr}\n` +
    `🕐  ${timeStr}\n` +
    `💰  ${currency} ${priceFormatted}\n\n` +
    `🔗 [Search on Google Flights](${searchLink})`
  );
}

export function evaluateAlert(route, best, state) {
  const maxBudget = route.maxBudget ?? null;

  if (maxBudget === null) {
    const lastSeen = state?.lastSeenPrice ?? null;
    if (lastSeen === null || best.price < lastSeen) {
      return "first";
    }
    return null;
  }

  if (best.price > maxBudget) {
    return null;
  }

  const lastAlertPrice = state?.lastAlertPrice ?? null;
  if (lastAlertPrice === null) {
    return "first";
  } else if (best.price < lastAlertPrice) {
    return "lower";
  } else if (best.price === lastAlertPrice) {
    return null;
  } else {
    return "returned";
  }
}

export function getVariantScrapeCount(route) {
  return dateVariants(route).length;
}

function normalizePriceState(state) {
  if (!state || typeof state !== "object") {
    return {
      hasHistory: false,
      lastSeenPrice: null,
      lastSeenAt: null,
      lastAlertPrice: null,
      lastAlertAt: null,
    };
  }

  return {
    hasHistory: state.lastSeenPrice != null || state.lastAlertPrice != null,
    lastSeenPrice: state.lastSeenPrice ?? null,
    lastSeenAt: state.lastSeenAt ?? null,
    lastAlertPrice: state.lastAlertPrice ?? null,
    lastAlertAt: state.lastAlertAt ?? null,
  };
}

export function summarizeRecentLogActivity(lines) {
  const summary = {
    lastRunStartedAt: null,
    lastRunCompletedAt: null,
    lastRunStatus: null,
    lastFailureAt: null,
    lastFailureMessage: null,
    lastAlertByRoute: {},
  };

  for (const line of lines) {
    if (line.startsWith("{")) {
      try {
        const record = JSON.parse(line);
        if (record?.route) {
          summary.lastAlertByRoute[record.route] = {
            ts: record.ts ?? null,
            alertType: record.alertType ?? null,
            price: record.price ?? null,
            airline: record.airline ?? null,
            stops: record.stops ?? null,
            duration: record.duration ?? null,
          };
        }
      } catch {
        // Ignore malformed historical log records.
      }
      continue;
    }

    const tsMatch = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (!tsMatch) continue;
    const [, ts, message] = tsMatch;

    if (message === "=== Bot run started ===") {
      summary.lastRunStartedAt = ts;
      summary.lastRunStatus = "started";
      continue;
    }

    if (message === "=== Bot run complete ===") {
      summary.lastRunCompletedAt = ts;
      summary.lastRunStatus = "completed";
      continue;
    }

    if (
      message.includes(" run failed:") ||
      message.startsWith("Unhandled rejection:") ||
      message.startsWith("Uncaught exception:")
    ) {
      summary.lastFailureAt = ts;
      summary.lastFailureMessage = message;
      summary.lastRunStatus = "failed";
    }
  }

  return summary;
}

export function deriveRouteStateSummary(route, priceState, logSummary) {
  const normalized = normalizePriceState(priceState);
  const lastAlert = logSummary.lastAlertByRoute[route.name] ?? null;
  const trackingMode = route.maxBudget == null ? "new-low" : "budget";

  let status = "unknown";
  if (!route.active) {
    status = "inactive";
  } else if (!normalized.hasHistory) {
    status = "watching";
  } else if (route.maxBudget != null && normalized.lastSeenPrice != null) {
    status = normalized.lastSeenPrice <= route.maxBudget ? "under-budget" : "above-budget";
  } else if (normalized.lastSeenPrice != null) {
    status = "tracking";
  }

  return {
    name: route.name,
    active: !!route.active,
    from: route.from,
    to: route.to,
    roundTrip: !!route.roundTrip,
    departureDate: route.departureDate ?? null,
    returnDate: route.returnDate ?? null,
    flexDays: route.flexDays ?? 0,
    variantChecksPerRun: getVariantScrapeCount(route),
    trackingMode,
    maxBudget: route.maxBudget ?? null,
    currency: route.currency ?? "USD",
    maxStops: route.maxStops ?? null,
    maxDurationHours: route.maxDurationHours ?? null,
    status,
    ...normalized,
    lastAlert: lastAlert ?? {
      ts: normalized.lastAlertAt,
      alertType: null,
      price: normalized.lastAlertPrice,
      airline: null,
      stops: null,
      duration: null,
    },
  };
}

function parseIsoDateSafe(value) {
  if (typeof value !== "string" || !value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function parseBracketedLogLine(line) {
  const tsMatch = line.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!tsMatch) return null;
  const [, tsRaw, messageRaw] = tsMatch;
  const ts = parseIsoDateSafe(tsRaw);
  const message = String(messageRaw ?? "").trim();
  if (!ts || !message) return null;

  const routeMatch = message.match(/^\[([^\]]+)\]\s*(.*)$/);
  const route = routeMatch ? routeMatch[1] : null;
  const cleanMessage = routeMatch ? routeMatch[2] : message;
  const messageLower = cleanMessage.toLowerCase();

  if (
    messageLower.includes("fetching:") ||
    messageLower.includes("scraping...") ||
    messageLower.includes("screenshot captured")
  ) {
    return null;
  }

  let event = "run";
  if (message === "=== Bot run started ===") event = "run-started";
  else if (message === "=== Bot run complete ===") event = "run-complete";
  else if (messageLower.includes("run failed:") || messageLower.startsWith("unhandled rejection:") || messageLower.startsWith("uncaught exception:")) event = "run-failed";
  else if (messageLower.includes("alert type:")) event = "alert-triggered";
  else if (messageLower.includes("no alert")) event = "no-alert";
  else if (messageLower.includes("scrape error:")) event = "scrape-error";

  return {
    ts,
    event,
    route,
    message: cleanMessage,
  };
}

function parseAlertLogLine(line) {
  if (!line.startsWith("{")) return null;
  try {
    const record = JSON.parse(line);
    if (!record || typeof record !== "object") return null;
    const ts = parseIsoDateSafe(record.ts);
    if (!ts || !record.route) return null;

    return {
      ts,
      event: "alert-recorded",
      route: String(record.route),
      alertType: record.alertType ?? null,
      price: typeof record.price === "number" ? record.price : null,
      airline: typeof record.airline === "string" ? record.airline : null,
      stops: Number.isInteger(record.stops) ? record.stops : null,
      duration: typeof record.duration === "string" ? record.duration : null,
      message: `Alert ${record.alertType ?? "recorded"} at price ${record.price ?? "n/a"}`,
    };
  } catch {
    return null;
  }
}

export function buildRecentActivity(lines, maxItems = 24) {
  const events = [];
  for (let i = lines.length - 1; i >= 0 && events.length < maxItems; i -= 1) {
    const line = lines[i];
    const event = parseAlertLogLine(line) ?? parseBracketedLogLine(line);
    if (!event) continue;
    events.push(event);
  }
  return events;
}
