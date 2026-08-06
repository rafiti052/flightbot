import { afterEach, describe, expect, it, vi } from "vitest";

const stdout = process.stdout as NodeJS.WriteStream;
const originalIsTty = Object.getOwnPropertyDescriptor(stdout, "isTTY");
const originalColumns = Object.getOwnPropertyDescriptor(stdout, "columns");

function setTerminal(isTTY: boolean, columns = 80): void {
  Object.defineProperty(stdout, "isTTY", { configurable: true, value: isTTY });
  Object.defineProperty(stdout, "columns", { configurable: true, value: columns });
}

async function loadUi({
  isTTY = false,
  columns = 80,
  forceColor,
  noColor,
  lang = "en_US.UTF-8",
}: {
  isTTY?: boolean;
  columns?: number;
  forceColor?: string;
  noColor?: string;
  lang?: string;
} = {}) {
  setTerminal(isTTY, columns);
  vi.stubEnv("FORCE_COLOR", forceColor);
  vi.stubEnv("NO_COLOR", noColor);
  vi.stubEnv("LANG", lang);
  vi.stubEnv("LC_ALL", undefined);
  vi.stubEnv("LC_CTYPE", undefined);
  vi.stubEnv("TERM", "xterm-256color");
  vi.resetModules();
  return import("../ui.ts");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (originalIsTty) Object.defineProperty(stdout, "isTTY", originalIsTty);
  else delete (stdout as { isTTY?: boolean }).isTTY;
  if (originalColumns) Object.defineProperty(stdout, "columns", originalColumns);
  else delete (stdout as { columns?: number }).columns;
});

describe("terminal UI contracts", () => {
  it("honors ANSI color, NO_COLOR, and FORCE_COLOR decisions", async () => {
    const plain = await loadUi({ isTTY: false });
    expect(plain.useColor).toBe(false);
    expect(plain.c.ok("ready")).toBe("ready");

    const disabled = await loadUi({ isTTY: true, noColor: "1" });
    expect(disabled.useColor).toBe(false);
    expect(disabled.c.err("failed")).toBe("failed");

    const forced = await loadUi({ isTTY: false, forceColor: "1" });
    expect(forced.useColor).toBe(true);
    expect(forced.c.ok("ready")).toBe("\x1b[32mready\x1b[0m");
    expect(forced.stripAnsi(forced.c.ok("ready"))).toBe("ready");
  });

  it("uses Unicode-aware display widths and truncates without splitting graphemes", async () => {
    const ui = await loadUi();
    expect(ui.displayWidth("A界é🙂")).toBe(6);
    expect(ui.truncate("界界界", 5)).toBe("界界…");
    expect(ui.truncate("abcdef", 1)).toBe("…");
    expect(ui.truncate("\x1b[31mabcdef\x1b[0m", 4)).toBe("abc…");
  });

  it("renders width-bounded aligned tables with truncated cells", async () => {
    const ui = await loadUi();
    const output = ui.table(
      [
        { header: "Route", key: "route" },
        { header: "Price", key: "price", align: "right" },
      ],
      [{ route: "São Paulo to New York", price: "$ 1,200" }],
      { indent: 2, maxWidth: 18 },
    );
    const [header, row] = output.split("\n");
    expect(ui.displayWidth(header)).toBeLessThanOrEqual(18);
    expect(ui.displayWidth(row)).toBeLessThanOrEqual(18);
    expect(row).toMatch(/\s\$ 1,200$/);
    expect(row).toContain("…");
  });

  it("formats money, duration, and terminal status with ASCII fallbacks", async () => {
    const unicode = await loadUi();
    expect(unicode.money(1234, "BRL")).toBe("R$ 1.234");
    expect(unicode.money("bad")).toBe("—");
    expect(unicode.dur(61_400)).toBe("1m 1s");
    expect(unicode.dur(-1)).toBe("0s");
    expect(unicode.status("warn", "watch")).toBe("⚠ watch");

    const ascii = await loadUi({ lang: "C" });
    expect(ascii.useUnicode).toBe(false);
    expect(ascii.status("unknown", "idle")).toBe("- idle");
    expect(ascii.glyph.ellipsis).toBe("...");
  });

  it("keeps spinner progress silent until completion in non-TTY mode", async () => {
    const ui = await loadUi({ isTTY: false });
    const write = vi.spyOn(stdout, "write");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const progress = ui.spinner("loading");
    progress.update("loaded");
    expect(write).not.toHaveBeenCalled();
    progress.succeed();
    progress.fail("broken");
    expect(write).not.toHaveBeenCalled();
    expect(log).toHaveBeenNthCalledWith(1, "✓ loaded");
    expect(log).toHaveBeenNthCalledWith(2, "✗ broken");
  });
});
