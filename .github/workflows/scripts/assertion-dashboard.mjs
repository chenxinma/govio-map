#!/usr/bin/env node
// Assertion dashboard (NON-GATING): parses the aggregated `npm run verify` log,
// compares counts against the baseline in docs/task-plan.json, and writes a
// GitHub step summary (+ ::warning:: annotations on drift).
//
// Introduced by X16 (docs/tasks/X16-ci-maintenance/); baseline moved out of this
// file into docs/task-plan.json → verificationBaseline by X23
// (docs/tasks/X23-ci-dashboard-baseline/), closing X16 design.md 遗留 1.
//
// Hard rules (unchanged from X16):
//   * NEVER changes the job colour: always exits 0; every internal error is
//     swallowed into a warning annotation. The gate is the `build + lint + verify`
//     required check; this file is observability only.
//   * Parses all four verify summary formats (共 N 项断言 / N/N checks passed /
//     N/N 通过 / vitest Test Files + Tests).
//   * Models the platform delta explicitly via verificationBaseline.platformSkip
//     (verify:cwd's caseDrift gate SKIPs 7 assertions on case-sensitive
//     filesystems — script design, not drift).
//   * Baseline unavailable (file/field missing, bad JSON, wrong shape) → report
//     actual values only, one warning, still exit 0. A missing baseline must
//     never look like drift and never redden the job.
//
// Usage: node assertion-dashboard.mjs <verify.log>
//   Outside GitHub Actions (no GITHUB_STEP_SUMMARY) the markdown goes to stdout.
//   Env ASSERTION_DASHBOARD_BASELINE overrides the task-plan path (test hook;
//   CI leaves it unset).

import { readFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function warn(message) {
  console.log(`::warning title=assertion dashboard::${message}`);
}

// ---------------------------------------------------------------------------
// BASELINE — single source: docs/task-plan.json → verificationBaseline (X23).
// ---------------------------------------------------------------------------

function isPositiveInt(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Load + shape-check the baseline. Returns `{ scripts, vitest, platformSkip,
 * declaredTotal, source }` or `{ error }` — never throws.
 */
function loadBaseline() {
  const source =
    process.env.ASSERTION_DASHBOARD_BASELINE ||
    fileURLToPath(new URL("../../../docs/task-plan.json", import.meta.url));
  let raw;
  try {
    raw = readFileSync(source, "utf8");
  } catch (error) {
    return { error: `cannot read ${source} (${error.message})`, source };
  }
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (error) {
    return { error: `${source} is not valid JSON (${error.message})`, source };
  }
  const base = plan?.verificationBaseline;
  if (!base || typeof base !== "object") {
    return { error: `${source} has no verificationBaseline object`, source };
  }
  const scripts = base.scripts;
  if (!scripts || typeof scripts !== "object" || Object.keys(scripts).length === 0) {
    return { error: "verificationBaseline.scripts missing or empty", source };
  }
  for (const [name, count] of Object.entries(scripts)) {
    if (!isPositiveInt(count)) return { error: `verificationBaseline.scripts["${name}"] is not a non-negative integer`, source };
  }
  const vitest = base.vitest;
  if (!vitest || typeof vitest !== "object" || Object.keys(vitest).length === 0) {
    return { error: "verificationBaseline.vitest missing or empty", source };
  }
  for (const [name, entry] of Object.entries(vitest)) {
    if (!entry || !isPositiveInt(entry.files) || !isPositiveInt(entry.tests)) {
      return { error: `verificationBaseline.vitest["${name}"] needs integer {files, tests}`, source };
    }
  }
  // platformSkip: { [platform]: { [script]: skipCount } } — optional, validated when present.
  const platformSkip = base.platformSkip && typeof base.platformSkip === "object" ? base.platformSkip : {};
  for (const [platform, perScript] of Object.entries(platformSkip)) {
    if (!perScript || typeof perScript !== "object") return { error: `verificationBaseline.platformSkip["${platform}"] is not an object`, source };
    for (const [name, count] of Object.entries(perScript)) {
      if (!isPositiveInt(count)) return { error: `verificationBaseline.platformSkip["${platform}"]["${name}"] is not a non-negative integer`, source };
    }
  }
  const declaredTotal = isPositiveInt(base.scriptTotalWindows) ? base.scriptTotalWindows : null;
  return { scripts: { ...scripts }, vitest: { ...vitest }, platformSkip, declaredTotal, source };
}

/** Baseline per script for this platform (Windows totals minus platformSkip[platform]). */
function expectedScripts(baseline, platform) {
  const expected = { ...baseline.scripts };
  const skips = baseline.platformSkip[platform] ?? {};
  for (const [name, count] of Object.entries(skips)) {
    if (name in expected) expected[name] -= count;
  }
  return expected;
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
  const baseline = loadBaseline();
  const sections = splitSections(log);
  const rows = [];
  const notes = [];

  // ---- baseline unavailable → report actual values only, never look like drift
  if (baseline.error) {
    warn(`baseline unavailable (${baseline.error}); reporting actual values only, no comparison`);
    for (const [name, lines] of sections) {
      const summary = parseSummary(lines);
      if (!summary) continue;
      const actual =
        summary.kind === "vitest"
          ? `${summary.files ?? "?"} files / ${summary.tests ?? "?"} tests`
          : String(summary.count);
      rows.push(verdictRow(name, "— (no baseline)", actual, null, "baseline unavailable"));
    }
    writeSummary(rows, notes, `baseline unavailable: ${baseline.error}`, platform, null, null);
    return;
  }

  const expected = expectedScripts(baseline, platform);
  const expectedTotal = Object.values(expected).reduce((a, b) => a + b, 0);
  // Data hygiene: declared Windows total must equal the sum of per-script numbers.
  const windowsTotal = Object.values(baseline.scripts).reduce((a, b) => a + b, 0);
  if (baseline.declaredTotal !== null && baseline.declaredTotal !== windowsTotal) {
    warn(
      `verificationBaseline.scriptTotalWindows (${baseline.declaredTotal}) != sum(scripts) (${windowsTotal}); using sum(scripts)`,
    );
  }

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
    const note = summary.failures
      ? `${summary.failures} failing?!`
      : summary.count > expectedCount
        ? "above baseline (merged test additions? update verificationBaseline)"
        : summary.count < expectedCount
          ? "below baseline (assertions removed?)"
          : "";
    rows.push(verdictRow(name, String(expectedCount), String(summary.count), ok, note));
    if (!ok) warn(`${name}: expected ${expectedCount}, got ${summary.count}${summary.failures ? ` (${summary.failures} failures)` : ""}`);
  }
  rows.push(
    verdictRow(
      "script total",
      totalKnown ? String(expectedTotal) : `${expectedTotal} (partial)`,
      String(actualTotal),
      totalKnown && actualTotal === expectedTotal,
      "",
    ),
  );
  if (totalKnown && actualTotal !== expectedTotal) warn(`script total: expected ${expectedTotal} on ${platform}, got ${actualTotal}`);

  for (const [name, base] of Object.entries(baseline.vitest)) {
    const lines = sections.get(name);
    const summary = lines ? parseSummary(lines) : null;
    if (!summary || summary.kind !== "vitest") {
      rows.push(verdictRow(name, `${base.files} files / ${base.tests} tests`, "—", null, "vitest summary not found"));
      warn(`${name}: vitest summary not found`);
      continue;
    }
    const ok = summary.files === base.files && summary.tests === base.tests && !summary.failures;
    rows.push(
      verdictRow(
        name,
        `${base.files} files / ${base.tests} tests`,
        `${summary.files ?? "?"} files / ${summary.tests ?? "?"} tests`,
        ok,
        summary.failures ? "failing cases?!" : "",
      ),
    );
    if (!ok) warn(`${name}: expected ${base.files} files / ${base.tests} tests, got ${summary.files} / ${summary.tests}`);
  }

  const skipped = baseline.platformSkip[platform] ?? {};
  const skipNote =
    Object.keys(skipped).length > 0
      ? `platform ${platform}: ${Object.entries(skipped)
          .map(([name, count]) => `\`${name}\` caseDrift gate SKIPs ${count} assertions by design`)
          .join("; ")} → expected script total ${expectedTotal} (Windows baseline ${windowsTotal}).`
      : `platform ${platform}: full Windows baseline, expected script total ${expectedTotal}.`;

  writeSummary(rows, notes, skipNote, platform, baseline, expectedTotal);
}

function writeSummary(rows, notes, skipNote, platform, baseline, expectedTotal) {
  const markdown = [
    "## Assertion dashboard (non-gating)",
    "",
    skipNote,
    "",
    "| item | baseline | actual | verdict |",
    "|---|---|---|---|",
    ...rows,
    "",
    "> Informational only — drift raises `::warning::` annotations but never reddens the gate.",
    baseline
      ? `> Baseline source: \`docs/task-plan.json → verificationBaseline\` (single source, X23); platform \`${platform}\`, expected script total ${expectedTotal}.`
      : "> Baseline source unavailable — actual values only, no drift comparison (X23 degradation path).",
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
