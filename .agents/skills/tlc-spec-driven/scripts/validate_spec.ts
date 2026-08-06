import fs from "node:fs";
import path from "node:path";

const requiredSections = [
  "Problem Statement",
  "Out of Scope",
  "Assumptions & Open Questions",
  "User Stories",
  "Requirement Traceability",
];
const idRe = /^[A-Z][A-Z0-9]*-\d+$/;
const placeholderRe = /^\s*\[.+\]\s*$/;

export function resolveSpec(target: string | undefined, root: string): string | undefined {
  if (target) {
    if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      const candidate = path.join(target, "spec.md");
      return fs.existsSync(candidate) ? candidate : autodetect(target);
    }
    const candidate = path.join(root, ".specs", "features", target, "spec.md");
    return fs.existsSync(candidate) ? candidate : undefined;
  }
  return autodetect(root);
}

function autodetect(root: string): string | undefined {
  const base = path.join(root, ".specs", "features");
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return undefined;
  const features = fs
    .readdirSync(base)
    .sort()
    .filter((name) => fs.existsSync(path.join(base, name, "spec.md")));
  if (features.length === 1) return path.join(base, features[0], "spec.md");
  if (features.length > 1)
    throw new Error(
      `validate_spec: multiple features found; pass one explicitly:\n  ${features.map((name) => path.join(base, name, "spec.md")).join("\n  ")}`,
    );
  return undefined;
}

function sectionBounds(lines: string[], name: string): [number, number] | undefined {
  const header = new RegExp(`^#{1,3}\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
  const start = lines.findIndex((line) => header.test(line.trim()));
  if (start < 0) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1)
    if (/^#{1,3}\s+\S/.test(lines[index])) {
      end = index;
      break;
    }
  return [start + 1, end];
}
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
const isSeparator = (line: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");

export function check(specPath: string): { errors: string[]; warnings: string[] } {
  const lines = fs.readFileSync(specPath, "utf8").split(/\r?\n/);
  const errors: string[] = [],
    warnings: string[] = [];
  for (const name of requiredSections)
    if (!sectionBounds(lines, name)) errors.push(`missing required section: ## ${name}`);
  let inAc = false;
  lines.forEach((line, index) => {
    const stripped = line.trim();
    if (/^\*{0,2}Acceptance Criteria\*{0,2}\s*:?\s*$/.test(stripped)) {
      inAc = true;
      return;
    }
    if (!inAc) return;
    const item = /^\s*\d+\.\s+(.*)$/.exec(line)?.[1]?.trim();
    if (item) {
      if (placeholderRe.test(item)) return;
      const low = item.toLowerCase();
      if (!/\bshall\b/.test(low))
        errors.push(
          `L${index + 1}: acceptance criterion has no SHALL (not testable): ${item.slice(0, 70)}`,
        );
      else if (
        !/\b(while|when|where)\b/.test(low) &&
        !(/^\s*if\b/.test(low) || /\bif\b.*\bthen\b/.test(low)) &&
        !/^\s*the\b/.test(low)
      )
        warnings.push(
          `L${index + 1}: AC has SHALL but no EARS keyword (WHEN/WHILE/WHERE/IF or ubiquitous 'The … shall'): ${item.slice(0, 60)}`,
        );
    } else if (stripped === "" || /^#{1,3}\s/.test(line) || stripped.startsWith("**")) inAc = false;
  });
  const assumptions = sectionBounds(lines, "Assumptions & Open Questions");
  if (assumptions) {
    const data = lines
      .slice(...assumptions)
      .filter((line) => line.trim().startsWith("|") && !isSeparator(line))
      .slice(1);
    let templateSeen = false;
    for (const row of data) {
      const [assumption = "", chosen = "", rationale = ""] = splitRow(row);
      if (placeholderRe.test(assumption) && placeholderRe.test(chosen)) {
        templateSeen = true;
        continue;
      }
      if (!chosen || placeholderRe.test(chosen))
        errors.push(`assumption '${assumption.slice(0, 40)}' has empty 'Chosen default'`);
      if (!rationale || placeholderRe.test(rationale))
        errors.push(`assumption '${assumption.slice(0, 40)}' has empty 'Rationale'`);
    }
    if (templateSeen) warnings.push("Assumptions table still contains template placeholder rows");
    const open = lines
      .slice(...assumptions)
      .filter((line) => line.toLowerCase().includes("open questions"));
    const clean = open.join(" ").replace(/[*_]/g, "").toLowerCase();
    if (!open.length) warnings.push("no 'Open questions:' line in Assumptions section");
    else if (!/open questions.*:\s*none/.test(clean))
      warnings.push("open questions do not read as resolved ('Open questions: none')");
  }
  const traceability = sectionBounds(lines, "Requirement Traceability");
  if (traceability) {
    const data = lines
      .slice(...traceability)
      .filter((line) => line.trim().startsWith("|") && !isSeparator(line))
      .slice(1);
    let template = false,
      real = 0;
    for (const row of data) {
      const rid = splitRow(row)[0] ?? "";
      if (placeholderRe.test(rid) || rid.includes("[")) {
        template = true;
        continue;
      }
      if (rid && !idRe.test(rid))
        errors.push(`malformed requirement ID: '${rid}' (expected e.g. AUTH-01)`);
      else if (rid) real += 1;
    }
    if (template && real === 0)
      warnings.push("Requirement Traceability has only template rows (no real IDs yet)");
  }
  return { errors, warnings };
}

export function main(argv = process.argv.slice(2)): number {
  let target: string | undefined;
  let root = ".";
  let strict = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") root = argv[++i] ?? ".";
    else if (argv[i] === "--strict") strict = true;
    else if (!target) target = argv[i];
    else {
      console.error("usage: validate_spec.ts [target] [--root DIR] [--strict]");
      return 2;
    }
  }
  let spec: string | undefined;
  try {
    spec = resolveSpec(target, root);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (!spec) {
    console.error(
      "validate_spec: could not locate a spec.md. Pass a path or run from the project root.",
    );
    return 2;
  }
  const { errors, warnings } = check(spec);
  warnings.forEach((warning) => console.log(`  WARN  ${warning}`));
  errors.forEach((error) => console.log(`  ERROR ${error}`));
  console.log(
    `\nvalidate_spec: ${errors.length} error(s), ${warnings.length} warning(s) in ${spec}`,
  );
  return errors.length || (strict && warnings.length) ? 1 : 0;
}
if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
