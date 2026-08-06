import fs from "node:fs";
const types = ["feat", "fix", "refactor", "docs", "test", "style", "perf", "build", "ci", "chore"];
const headerRe = /^(?<type>\w+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?: (?<desc>.+)$/;
export function check(message: string) {
  const warnings: string[] = [],
    errors: string[] = [];
  const lines = message.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("#"));
  while (lines.length && !lines[0].trim()) lines.shift();
  if (!lines.length) return { errors: ["empty commit message"], warnings };
  const header = lines[0].trimEnd();
  if (header.length > 72)
    warnings.push(`header is ${header.length} chars (>72): ${header.slice(0, 60)}...`);
  const match = headerRe.exec(header);
  if (!match)
    return { errors: [`header does not match 'type(scope): description': '${header}'`], warnings };
  const { type, desc, bang } = match.groups as { type: string; desc: string; bang?: string };
  if (!types.includes(type)) errors.push(`type '${type}' is not one of: ${types.join(", ")}`);
  if (!desc.trim()) errors.push("description is empty");
  else {
    if (/^[A-Z]/.test(desc))
      errors.push(`description should start lowercase: '${desc.slice(0, 30)}'`);
    if (desc.trimEnd().endsWith(".")) errors.push("description should not end with a period");
  }
  if (bang && !/^BREAKING CHANGE:/m.test(lines.slice(1).join("\n")))
    errors.push("'!' breaking marker present but no 'BREAKING CHANGE:' footer");
  return { errors, warnings };
}
export function main(argv = process.argv.slice(2), stdin = ""): number {
  let message: string | undefined, file: string | undefined;
  for (let i = 0; i < argv.length; i += 1)
    if (argv[i] === "--message") message = argv[++i];
    else if (!file) file = argv[i];
    else return 2;
  if (message === undefined) message = file ? fs.readFileSync(file, "utf8") : stdin;
  if (!message.trim()) {
    console.error("check_commit: no message provided (pass a file, --message, or pipe via stdin).");
    return 2;
  }
  const { errors, warnings } = check(message);
  warnings.forEach((x) => console.log(`  WARN  ${x}`));
  errors.forEach((x) => console.log(`  ERROR ${x}`));
  if (errors.length) {
    console.log("\ncheck_commit: FAIL - see https://www.conventionalcommits.org/en/v1.0.0/");
    return 1;
  }
  console.log("check_commit: OK");
  return 0;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (x) => (input += x));
  process.stdin.on("end", () => (process.exitCode = main(undefined, input)));
  if (process.stdin.isTTY) process.exitCode = main();
}
