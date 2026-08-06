import fs from "node:fs";
import path from "node:path";
const signals = new Set([
  "ac_gap",
  "surviving_mutant",
  "spec_precision_gap",
  "spec_deviation",
  "gate_fail",
]);
type Lesson = {
  id: string;
  key: string;
  text: string;
  signal: string;
  scope: string;
  status: string;
  features: string[];
  recurrence: number;
  harmful: number;
  evidence: string[];
  created: string;
  last_seen: string;
};
type Store = {
  schema: number;
  promote_threshold: number;
  window_days: number;
  quarantine_threshold: number;
  next_id: number;
  lessons: Lesson[];
};
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  norm = (text: string) =>
    text
      .toLocaleLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
const storePath = (root: string) => path.join(root, ".specs/lessons.json"),
  renderPath = (root: string) => path.join(root, ".specs/LESSONS.md");
function load(root: string): Store {
  if (!fs.existsSync(storePath(root)))
    return {
      schema: 1,
      promote_threshold: 2,
      window_days: 45,
      quarantine_threshold: 2,
      next_id: 1,
      lessons: [],
    };
  const d = JSON.parse(fs.readFileSync(storePath(root), "utf8")) as Partial<Store>;
  return {
    schema: d.schema ?? 1,
    promote_threshold: d.promote_threshold ?? 2,
    window_days: d.window_days ?? 45,
    quarantine_threshold: d.quarantine_threshold ?? 2,
    next_id: d.next_id ?? 1,
    lessons: d.lessons ?? [],
  };
}
function render(root: string, d: Store) {
  const by = (status: string) =>
    d.lessons.filter((l) => l.status === status).sort((a, b) => a.id.localeCompare(b.id));
  const block = (title: string, items: Lesson[], note: string) => [
    "## " + title,
    "",
    note,
    "",
    ...(items.length
      ? items.flatMap((l) => [
          `### ${l.id} - ${l.text}`,
          `- signal: \`${l.signal}\` · recurrence: ${l.recurrence} feature(s)${l.scope ? ` · scope: \`${l.scope}\`` : ""} · harmful: ${l.harmful ?? 0}`,
          `- features: ${l.features.join(", ") || "-"}`,
          ...(l.evidence.length
            ? [
                `- evidence: ${l.evidence[0]}${l.evidence.length > 1 ? ` (+${l.evidence.length - 1} more)` : ""}`,
              ]
            : []),
          `- last seen: ${l.last_seen || "-"}`,
          "",
        ])
      : ["_none_", ""]),
  ];
  const lines = [
    "# LESSONS - auto-maintained by scripts/lessons.ts",
    "",
    "> Machine-owned. Do NOT hand-edit. Changes are overwritten on the next `lessons.ts` write.",
    "> Canonical state lives in `.specs/lessons.json`. Edit lessons only via the script.",
    `> promote_threshold=${d.promote_threshold} distinct features · window_days=${d.window_days} · quarantine_threshold=${d.quarantine_threshold}`,
    "",
    ...block(
      "Confirmed (load these at Specify/Design)",
      by("confirmed"),
      "Corroborated across multiple features. Safe to apply as guidance.",
    ),
    ...block(
      "Candidates (under observation - do NOT load as guidance yet)",
      by("candidate"),
      "Seen once or not yet corroborated. Tracked, not trusted.",
    ),
    ...block(
      "Quarantined (failed when applied - ignore)",
      by("quarantined"),
      "A confirmed lesson that recurred alongside failure. Kept for the maintainer to review.",
    ),
  ];
  fs.writeFileSync(renderPath(root), lines.join("\n").trimEnd() + "\n");
}
function save(root: string, d: Store) {
  fs.mkdirSync(path.join(root, ".specs"), { recursive: true });
  fs.writeFileSync(storePath(root), JSON.stringify(d, null, 2) + "\n");
  render(root, d);
}
function prune(d: Store) {
  const cutoff = Date.now() - d.window_days * 864e5;
  const drop = d.lessons
    .filter(
      (l) =>
        l.status === "candidate" &&
        l.recurrence < d.promote_threshold &&
        Date.parse(l.last_seen || l.created) < cutoff,
    )
    .map((l) => l.id);
  d.lessons = d.lessons.filter((l) => !drop.includes(l.id));
  return drop;
}
export function main(argv = process.argv.slice(2)): number {
  let root = ".";
  const args = [...argv];
  const ri = args.indexOf("--root");
  if (ri >= 0) {
    root = args[ri + 1] ?? ".";
    args.splice(ri, 2);
  }
  root = path.resolve(root);
  const cmd = args.shift();
  const get = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? "") : "";
  };
  if (!cmd) {
    console.error("usage: lessons.ts [--root DIR] {init,add,list,penalize,prune,status,selftest}");
    return 2;
  }
  if (cmd === "selftest") {
    const ok =
      norm("Não use datas locais") === "nao use datas locais" &&
      norm("日本語の文です") !== norm("別の日本語文") &&
      norm("café") === "cafe";
    console.log(ok ? "selftest_norm: ok" : "FAIL: normalization");
    return ok ? 0 : 1;
  }
  const d = load(root);
  if (cmd === "init") {
    save(root, d);
    console.log(`Initialized lessons store at ${storePath(root)} and ${renderPath(root)}`);
    return 0;
  }
  if (cmd === "add") {
    const signal = get("--signal"),
      feature = get("--feature").trim(),
      source = get("--source").trim(),
      text = get("--text").trim(),
      scope = get("--scope").trim();
    if (!signals.has(signal) || !feature || !source || text.length < 12) {
      console.error("ERROR: invalid lesson grounding or text");
      return 2;
    }
    prune(d);
    const key = `${signal}::${norm(text)}`,
      existing = d.lessons.find((l) => l.key === key);
    if (existing) {
      if (!existing.features.includes(feature)) existing.features.push(feature);
      existing.recurrence = existing.features.length;
      existing.last_seen = now();
      const ev = scope ? `${source} (${scope})` : source;
      if (!existing.evidence.includes(ev)) existing.evidence.push(ev);
      let promoted = false;
      if (existing.status === "candidate" && existing.recurrence >= d.promote_threshold) {
        existing.status = "confirmed";
        promoted = true;
      }
      save(root, d);
      console.log(
        `UPDATED ${existing.id} (recurrence=${existing.recurrence}, status=${existing.status})${promoted ? " - PROMOTED to confirmed" : ""}`,
      );
      return 0;
    }
    const id = `L-${String(d.next_id++).padStart(3, "0")}`;
    d.lessons.push({
      id,
      key,
      text,
      signal,
      scope,
      status: "candidate",
      features: [feature],
      recurrence: 1,
      harmful: 0,
      evidence: [scope ? `${source} (${scope})` : source],
      created: now(),
      last_seen: now(),
    });
    save(root, d);
    console.log(`ADDED ${id} (status=candidate, recurrence=1)`);
    return 0;
  }
  if (cmd === "penalize") {
    const l = d.lessons.find((x) => x.id.toLowerCase() === get("--id").toLowerCase());
    if (!l) {
      console.error(`ERROR: no lesson with id ${get("--id")}`);
      return 2;
    }
    l.harmful = (l.harmful ?? 0) + 1;
    l.last_seen = now();
    if (l.harmful >= d.quarantine_threshold) l.status = "quarantined";
    save(root, d);
    console.log(`PENALIZED ${l.id} (harmful=${l.harmful}, status=${l.status})`);
    return 0;
  }
  if (cmd === "prune") {
    const dropped = prune(d);
    save(root, d);
    console.log(`Pruned ${dropped.length} stale candidate(s): ${dropped.join(", ") || "-"}`);
    return 0;
  }
  if (cmd === "status") {
    const c = { confirmed: 0, candidate: 0, quarantined: 0 };
    d.lessons.forEach((l) => {
      if (l.status in c) c[l.status as keyof typeof c] += 1;
    });
    console.log(
      `lessons: ${d.lessons.length} total | confirmed=${c.confirmed} candidate=${c.candidate} quarantined=${c.quarantined}`,
    );
    return 0;
  }
  if (cmd === "list") {
    if (prune(d).length) save(root, d);
    const status = get("--status") || "confirmed",
      q = get("--query").toLowerCase(),
      scope = get("--scope").toLowerCase();
    const rows = d.lessons.filter(
      (l) =>
        (status === "all" || l.status === status) &&
        (!q || l.text.toLowerCase().includes(q)) &&
        (!scope || l.scope.toLowerCase().includes(scope)),
    );
    if (!rows.length)
      console.log(`(no ${status} lessons${q || scope ? ` matching '${q || scope}'` : ""})`);
    else
      rows
        .sort((a, b) => a.id.localeCompare(b.id))
        .forEach((l) =>
          console.log(
            `${l.id} (${l.status}, x${l.recurrence})${l.scope ? ` [scope:${l.scope}]` : ""}: ${l.text}`,
          ),
        );
    return 0;
  }
  console.error(`usage: unknown command ${cmd}`);
  return 2;
}
if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
