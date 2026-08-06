// eslint-disable-next-line no-control-regex -- terminal formatting uses ANSI CSI sequences.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

type ColorRole = (value: unknown) => string;
type TableColumn = { header: string; key: string; align?: "left" | "right" };
type TableRow = Record<string, unknown>;

export const isTty = Boolean(process.stdout.isTTY);

const forceColor = process.env.FORCE_COLOR;
export const useColor =
  forceColor !== undefined
    ? forceColor !== "0"
    : isTty && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG;
export const useUnicode = !locale || /utf-?8/i.test(locale);

function role(code: string): ColorRole {
  return (value) => (useColor ? `\x1b[${code}m${String(value)}\x1b[0m` : String(value));
}

export const c = {
  ok: role("32"),
  warn: role("33"),
  err: role("31"),
  dim: role("2"),
  accent: role("36"),
  label: role("36"),
  bold: role("1"),
};

export const glyph: Record<string, string> = {
  ok: useUnicode ? "✓" : "+",
  err: useUnicode ? "✗" : "x",
  warn: useUnicode ? "⚠" : "!",
  alert: useUnicode ? "▲" : "^",
  dot: useUnicode ? "·" : "-",
  up: useUnicode ? "↑" : "up",
  down: useUnicode ? "↓" : "down",
  rule: useUnicode ? "─" : "-",
  ellipsis: useUnicode ? "…" : "...",
};

export function width(): number {
  return Math.max(60, Math.min(100, process.stdout.columns ?? 80));
}

export function stripAnsi(value: unknown): string {
  return String(value).replace(ANSI_RE, "");
}

function codePointWidth(char: string): number {
  const point = char.codePointAt(0) ?? 0;
  if (point === 0x200d || (point >= 0xfe00 && point <= 0xfe0f) || /\p{Mark}/u.test(char)) return 0;

  if (
    (point >= 0x1100 && point <= 0x115f) ||
    (point >= 0x2329 && point <= 0x232a) ||
    (point >= 0x2e80 && point <= 0xa4cf) ||
    (point >= 0xac00 && point <= 0xd7a3) ||
    (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe10 && point <= 0xfe6f) ||
    (point >= 0xff00 && point <= 0xff60) ||
    (point >= 0xffe0 && point <= 0xffe6) ||
    (point >= 0x1f000 && point <= 0x1faff) ||
    (point >= 0x20000 && point <= 0x3fffd)
  )
    return 2;

  return point < 0x20 ? 0 : 1;
}

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function graphemes(value: string): string[] {
  if (!graphemeSegmenter) return Array.from(value);
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

function graphemeWidth(value: string): number {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value)) return 2;
  let result = 0;
  for (const char of value) result += codePointWidth(char);
  return result;
}

export function displayWidth(value: unknown): number {
  let result = 0;
  for (const segment of graphemes(stripAnsi(value))) result += graphemeWidth(segment);
  return result;
}

export function truncate(value: unknown, max: number): string {
  const input = stripAnsi(value);
  if (displayWidth(input) <= max) return input;
  if (max <= displayWidth(glyph.ellipsis)) return glyph.ellipsis.slice(0, max);

  const suffixWidth = displayWidth(glyph.ellipsis);
  let result = "";
  let used = 0;
  for (const segment of graphemes(input)) {
    const segmentWidth = graphemeWidth(segment);
    if (used + segmentWidth + suffixWidth > max) break;
    result += segment;
    used += segmentWidth;
  }
  return result + glyph.ellipsis;
}

function pad(value: unknown, size: number, align: "left" | "right" = "left"): string {
  const text = String(value);
  const missing = Math.max(0, size - displayWidth(text));
  return align === "right" ? " ".repeat(missing) + text : text + " ".repeat(missing);
}

export function table(
  columns: TableColumn[],
  rows: TableRow[],
  { indent = 2, maxWidth = width() }: { indent?: number; maxWidth?: number } = {},
): string {
  if (columns.length === 0) return "";

  const widths = columns.map((column) =>
    Math.max(
      displayWidth(column.header),
      ...rows.map((row) => displayWidth(row[column.key] ?? "")),
    ),
  );
  const gutters = (columns.length - 1) * 2;
  const available = Math.max(columns.length, maxWidth - indent - gutters);

  while (widths.reduce((sum, value) => sum + value, 0) > available) {
    let index = -1;
    let largest = 0;
    for (let i = 0; i < widths.length; i++) {
      const minimum = Math.min(6, Math.max(3, displayWidth(columns[i].header)));
      if (widths[i] > minimum && widths[i] > largest) {
        largest = widths[i];
        index = i;
      }
    }
    if (index === -1) break;
    widths[index]--;
  }

  const renderRow = (row: TableRow, header = false): string => {
    const cells = columns.map((column, index) => {
      const raw = header ? column.header.toUpperCase() : (row[column.key] ?? "");
      const value = truncate(raw, widths[index]);
      const padded = pad(value, widths[index], column.align);
      return header ? c.dim(padded) : padded;
    });
    return " ".repeat(indent) + cells.join("  ").trimEnd();
  };

  return [renderRow({}, true), ...rows.map((row) => renderRow(row))].join("\n");
}

export function title(text: unknown, meta?: unknown): string {
  return [c.bold(text), meta ? c.dim(meta) : null].filter(Boolean).join("  ");
}

export function rule(): string {
  return c.dim(glyph.rule.repeat(width()));
}

export function kv(label: unknown, value: unknown): string {
  return `${c.dim(label)}  ${value}`;
}

export function status(kind: string, text: unknown): string {
  const styles: Record<string, ColorRole> = { ok: c.ok, warn: c.warn, err: c.err, alert: c.accent };
  return `${(styles[kind] ?? c.dim)(glyph[kind] ?? glyph.dot)} ${text}`;
}

export function blank(): string {
  return "";
}

export function money(value: unknown, currency = "USD"): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const symbols: Record<string, string> = { BRL: "R$", USD: "$" };
  const amount = Number(value).toLocaleString("pt-BR");
  return `${symbols[currency] ?? currency} ${amount}`;
}

export function dur(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

export function spinner(text: string) {
  let current = text;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const frames = useUnicode
    ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    : ["-", "\\", "|", "/"];

  const render = (): void => {
    process.stdout.write(
      `\r${c.dim(frames[frame++ % frames.length])} ${truncate(current, width() - 3)}\x1b[K`,
    );
  };
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
    if (isTty) process.stdout.write("\r\x1b[K");
  };

  if (isTty) {
    render();
    timer = setInterval(render, 80);
    timer.unref?.();
  }

  return {
    update(next: string): void {
      current = next;
      if (isTty) render();
    },
    succeed(message = current): void {
      stop();
      console.log(status("ok", message));
    },
    fail(message = current): void {
      stop();
      console.log(status("err", message));
    },
  };
}
