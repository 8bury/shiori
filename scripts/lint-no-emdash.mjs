import { execFileSync } from "node:child_process";
import fs from "node:fs";

const EMDASH = "\u2014";
const IGNORE = new Set(["package-lock.json", "scripts/lint-no-emdash.mjs"]);

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .map((f) => f.trim())
  .filter((f) => f && !IGNORE.has(f) && fs.existsSync(f));

const violations = [];

for (const file of files) {
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) continue; // skip binary files
  const lines = buf.toString("utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(EMDASH)) {
      violations.push(`${file}:${i + 1}: em-dash found`);
    }
  }
}

if (violations.length) {
  console.error("Em-dash lint failed (no em-dashes allowed):\n" + violations.join("\n"));
  process.exit(1);
}

console.log(`Em-dash lint passed (${files.length} files checked).`);
