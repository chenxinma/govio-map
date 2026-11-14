#!/usr/bin/env node
// X16 assertion dashboard (NON-GATING): parses the aggregated `npm run verify`
// log, compares counts against the dispatch baseline, and writes a GitHub step
// summary (+ ::warning:: annotations on drift).
//
// Hard rules:
//   * NEVER changes the job colour: always exits 0; every internal error is
//     swallowed into a warning annotation. The gate is the `build + lint + verify`
//     required check; this file is observability only (X16 task book §4.3).
//   * Parses all four verify summary formats (共 N 项断言 / N/N checks passed /
//     N/N 通过 / vitest Test Files + Tests).
//   * Models the platform delta explicitly: verify:cwd's caseDrift gate SKIPs 7
//     assertions on case-sensitive filesystems (script design, not drift).
//
// Usage: node assertion-dashboard.mjs <verify.log>
//   Outside GitHub Actions (no GITHUB_STEP_SUMMARY) the markdown goes to stdout.

import { readFileSync, appendFileSync } from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------------------
// BASELINE — single source (hardcoded per X16 task book §4.3; see
// docs/tasks/X16-ci-maintenance/design.md §4 for why not docs/task-plan.json).
// Source: dispatch baseline 2026-11-14, main b5351b8, FULL Windows totals.
// Keep in sync when merged verify scripts change assertion counts; the
// dashboard only warns on drift, it never reddens the gate.
// ---------------------------------------------------------------------------
const BASELINE_SCRIPTS_WINDOWS = {
  "verify:manifest": 92,
  "verify:rerun": 71,
  "verify:audit": 119,
  "verify:export": 138,
  "verify:source-table": 39,
  "verify:semantic-lineage": 48,
  "verify:caliber-conflict": 46,
  "verify:cwd": 13,
  "verify:prompt-injection": 58,
};
const CWD_LINUX_SKIP = 7; // caseDrift assertions skipped on ubuntu
const BASELINE_VITEST = {
  "verify:integration": { files: 15, tests: 194 },
  "verify:ui": { files: 4, tests: 31 },
};

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function warn(message) {
  console.log(`::warning title=X16 assertion dashboard::${message}`);
}

function expectedScripts() {
  const baseline = { ...BASELINE_SCRIPTS_WINDOWS };
  if (os.platform() === "linux") baseline["verify:cwd"] -= CWD_LINUX_SKIP;
  return baseline;
}

// npm prints "> govio-map@<version> verify:<name>" before each sub-script.
function splitSections(log) {
  const sections = new Map();
  let current = null;
  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI, "");
    const header = /^> govio-map@\S+ (verify:\S+)\s*$/.exec(line);
    if (header) {
      current = header[1];
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current) sections.get(current).push(line);
  }
  return sections;
}

// Returns { kind, count?, failures?, files?, tests? } for one section, or null
// when no known summary format matched.
function parseSummary(lines) {
  const text = lines.join("\n");
  let m = /共 (\d+) 项断言，失败 (\d+) 项/.exec(text);
  if (m) return { kind: "assertions", count: Number(m[1]), failures: Number(m[2]) };
  m = /(\d+)\/(\d+) checks passed/.exec(text);
  if (m) return { kind: "checks", count: Number(m[2]), failures: Number(m[2]) - Number(m[1]) };
  m = /(\d+)\/(\d+) 通过/.exec(text);
  if (m) return { kind: "passed-cn", count: Number(m[2]), failures: Number(m[2]) - Number(m[1]) };
  const filesLine = /Test Files\s+[^\n]*/.exec(text);
  const testsLine = /(^|\n)\s*Tests\s+[^\n]*/.exec(text);
  if (filesLine || testsLine) {
    const out = { kind: "vitest" };
    for (const [key, match] of [["files", filesLine], ["tests", testsLine]]) {
      if (!match) continue;
      const total = /\((\d+)\)\s*$/.exec(match[0].trim());
      out[key] = total ? Number(total[1]) : null;
      if (/\bfailed\b/.test(match[0])) out.failures = (out.failures ?? 0) + 1;
    }
    return out;
  }
  return null;
}

function verdictRow(item, expectedText, actualText, ok, note) {
  const icon = ok === null ? "⚠️ missing" : ok ? "✅ ok" : "⚠️ drift";
  return `| \`${item}\` | ${expectedText} | ${actualText} | ${icon}${note ? ` — ${note}` : ""} |`;
}

function main() {
  const logPath = process.argv[2];
  if (!logPath) {
    warn("no verify log path given; dashboard skipped");
    return;
  }
  let log;
  try {
    log = readFileSync(logPath, "utf8");
  } catch (error) {
    warn(`cannot read verify log (${error.message}); dashboard skipped`);
    return;
  }

  const platform = os.platform();
  const expected = expectedScripts();
  const expectedTotal = Object.values(expected).reduce((a, b) => a + b, 0);
  const sections = splitSections(log);

  const rows = [];
  const notes = [];
  let actualTotal = 0;
  let totalKnown = true;

  for (const [name, expectedCount] of Object.entries(expected)) {
    const lines = sections.get(name);
    if (!lines) {
      rows.push(verdictRow(name, String(expectedCount), "—", null, "section not found in log"));
      warn(`${name}: section not found in verify log`);
      totalKnown = false;
      continue;
    }
    const summary = parseSummary(lines);
    if (!summary || summary.kind === "vitest") {
      rows.push(verdictRow(name, String(expectedCount), "—", null, "no known summary format"));
      warn(`${name}: summary line did not match any known format (parser needs update?)`);
      totalKnown = false;
      continue;
    }
    actualTotal += summary.count;
    const ok = summary.count === expectedCount && !summary.failures;
    const note = summary.failures ? `${summary.failures} failing?!` : summary.count > expectedCount ? "above baseline (merged test additions?)" : "";
    rows.push(verdictRow(name, String(expectedCount), String(summary.count), ok, note));
    if (!ok) warn(`${name}: expected ${expectedCount}, got ${summary.count}${summary.failures ? ` (${summary.failures} failures)` : ""}`);
  }
  rows.push(
    verdictRow("script total", totalKnown ? String(expectedTotal) : `${expectedTotal} (partial)`, String(actualTotal), totalKnown && actualTotal === expectedTotal, ""),
  );
  if (totalKnown && actualTotal !== expectedTotal) warn(`script total: expected ${expectedTotal} on ${platform}, got ${actualTotal}`);

  for (const [name, base] of Object.entries(BASELINE_VITEST)) {
    const lines = sections.get(name);
    const summary = lines ? parseSummary(lines) : null;
    if (!summary || summary.kind !== "vitest") {
      rows.push(verdictRow(name, `${base.files} files / ${base.tests} tests`, "—", null, "vitest summary not found"));
      warn(`${name}: vitest summary not found`);
      continue;
    }
    const ok = summary.files === base.files && summary.tests === base.tests && !summary.failures;
    rows.push(verdictRow(name, `${base.files} files / ${base.tests} tests`, `${summary.files ?? "?"} files / ${summary.tests ?? "?"} tests`, ok, summary.failures ? "failing cases?!" : ""));
    if (!ok) warn(`${name}: expected ${base.files} files / ${base.tests} tests, got ${summary.files} / ${summary.tests}`);
  }

  const skipNote =
    platform === "linux"
      ? `platform ${platform}: \`verify:cwd\` caseDrift gate SKIPs ${CWD_LINUX_SKIP} assertions by design → expected script total ${expectedTotal} (Windows baseline ${Object.values(BASELINE_SCRIPTS_WINDOWS).reduce((a, b) => a + b, 0)}).`
      : `platform ${platform}: full Windows baseline, expected script total ${expectedTotal}.`;

  const markdown = [
    "## X16 assertion dashboard (non-gating)",
    "",
    skipNote,
    "",
    "| item | baseline | actual | verdict |",
    "|---|---|---|---|",
    ...rows,
    "",
    "> Informational only — drift raises `::warning::` annotations but never reddens the gate.",
    "> Baseline source: `docs/tasks/X16-ci-maintenance/` (dispatch baseline 2026-11-14).",
  ].join("\n");

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n", "utf8");
    notes.push("written to $GITHUB_STEP_SUMMARY");
  } else {
    console.log(markdown);
  }
  for (const note of notes) console.log(`dashboard: ${note}`);
}

try {
  main();
} catch (error) {
  warn(`internal error (${error && error.message}); dashboard skipped`);
}
process.exit(0);
