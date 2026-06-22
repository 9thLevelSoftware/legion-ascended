#!/usr/bin/env node
// scan-default-runtime.mjs
//
// Automated scan that verifies the v9 default runtime path does not inject
// biography, tone, or personality prose into any prompt content file.
//
// The v9 default runtime path today is the four workflow-common-* v1.0.0
// packs plus any future worker bundle prompt content under `bundles/`. The
// reserved governance documents (ADR-002 and the legacy persona migration
// table) are scanned as well — they are allowed to *reference* the contract
// vocabulary but must not contain the forbidden prose patterns in their body.
//
// The legacy v8 surface (`agents/*.md`, `commands/*.md`, `adapters/*.md`,
// `skills/` outside the four packs listed below, `.codex-plugin/`) is
// explicitly preserved per `docs/next/V8-MAINTENANCE-POLICY.md` and is NOT
// scanned here. The v9 default runtime path never reads those files; the
// package-boundary check (`scripts/check-package-boundaries.mjs`) enforces
// that v9 workspace packages cannot import them.
//
// Used by:
//   - tests/default-runtime-scan.test.mjs (per-file regression guard)
//   - tests/persona-purge.test.mjs (broader prompt-content regression guard)
//   - scripts/validate-next.mjs `default-runtime-scan` step (CI gate)

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

// The v9 default runtime prompt-content files. Always-load core plus the
// three optional domain packs. Future worker bundle prompt content under
// `bundles/` is discovered dynamically.
export const V9_DEFAULT_RUNTIME_FILES = Object.freeze([
  "skills/workflow-common-core/SKILL.md",
  "skills/workflow-common-github/SKILL.md",
  "skills/workflow-common-memory/SKILL.md",
  "skills/workflow-common-domains/SKILL.md"
]);

// Reserved directories for future v9 worker bundle prompt content. Any
// `.md` / `.markdown` file under these roots becomes part of the default
// runtime scan surface. Empty today (bundles/ does not yet exist) but the
// directory will be created when worker bundles start shipping.
export const V9_DEFAULT_RUNTIME_DIRECTORIES = Object.freeze(["bundles"]);

// Governance documents that declare the prompt-content contract. They are
// scanned so a regression that injects persona prose into the contract
// itself (e.g. by mis-editing ADR-002) is caught here. They are allowed to
// reference the contract vocabulary (biography / tone / personality) but
// must not contain the forbidden prose patterns in their body.
export const GOVERNANCE_DOCUMENTS = Object.freeze([
  {
    path: "docs/next/adr/ADR-002-functional-workers.md",
    role: "ADR"
  },
  {
    path: "docs/next/migration/LEGACY-PERSONA-MAP.md",
    role: "migration-table"
  }
]);

// Forbidden heading patterns: any `^#{1,6} ...` line matching these labels
// is a persona-style heading that the v9 default runtime path must never
// emit. Anchored to line start and limited to the prose categories the v9
// runtime forbids (see ADR-002 §"Forbidden Prose Categories").
export const FORBIDDEN_HEADING_PATTERNS = Object.freeze([
  /^#{1,6}\s+(Your\s+)?(Identity|Memory|Experience|Personality|Tone)\b/im,
  /^#{1,6}\s+(Your\s+)?Core\s+Beliefs?\b/im,
  /^#{1,6}\s+(Your\s+)?Communication\s+Style\b/im,
  /^#{1,6}\s+(Your\s+)?Success\s+Metrics\b/im,
  /^#{1,6}\s+(Your\s+)?Personality\s+Injection\b/im
]);

// Forbidden prose phrases: persona-fiction patterns the v9 default runtime
// path must never inject. Matches identity-fiction prose ("you are X, a/the
// senior Y"), experience-claim prose ("you've seen too many ..."),
// motivational-era prose ("era ends with you"), legacy grading prose
// ("A+ certifications", "zero issues found", "perfect scores"), and the
// forbidden identity-memory prose ("I/we remember previous/all ...").
export const FORBIDDEN_PROSE_PHRASES = Object.freeze([
  /\b(?:you\s+are|you're)\s+(?:a|an)\s+[A-Z][\w-]*(?:\s+[A-Z][\w-]*){0,3},?\s+(?:a|an|the)\s+senior\b/i,
  /\b(?:you\s+have|you've)\s+seen\s+too\s+many\b/i,
  /\b(?:era\s+ends|era\s+begins)\s+with\s+you\b/i,
  /\b(?:fantasy|fantasies)\b(?:\s+(?:reporting|approval|claim|score|language))?/i,
  /\bA\+\s+certifications?\b/i,
  /\b(?:zero\s+issues\s+found|perfect\s+scores?|NEEDS\s+WORK)\b/i,
  /\b(?:I|we)\s+remember\s+(?:previous|all)\s+/i,
  /\b(?:skeptical|forensic|skeptical,\s+forensic)\b/i
]);

// Forbidden v8 persona-injection boilerplate: imperative phrases the legacy
// v8 runtime used to inject persona content. Patterns are anchored to
// imperative verbs (ALWAYS read, Inject, load) so descriptive governance
// text that *mentions* these patterns in negative form is not flagged.
export const FORBIDDEN_V8_PERSONA_BOILERPLATE = Object.freeze([
  /\b(?:AGENTS_DIR|agents-orchestrator\.md)\b(?=\s+(?:=|is\s+used|points|holds)\b)/i,
  /\bInject\s+personality\s+content\b/i,
  /\b(?:ALWAYS|always)\s+read\s+the\s+agent\s+personality\s+file\s+before\s+spawning\b/i,
  /\bload\s+full\s+personality\b/i,
  /\bloading\s+personality\s+(?:file|markdown|content)\b/i
]);

// All forbidden patterns grouped by category. The full set is used for v9
// default runtime prompt content; governance documents use a reduced set
// (heading + v8-boilerplate only) because they describe the contract in
// negative form and must be allowed to reference the prose categories the
// scanner otherwise forbids.
const RUNTIME_FORBIDDEN_PATTERNS = [
  { category: "forbidden-heading", patterns: FORBIDDEN_HEADING_PATTERNS },
  { category: "forbidden-prose", patterns: FORBIDDEN_PROSE_PHRASES },
  { category: "forbidden-v8-persona-boilerplate", patterns: FORBIDDEN_V8_PERSONA_BOILERPLATE }
];

const GOVERNANCE_FORBIDDEN_PATTERNS = [
  { category: "forbidden-heading", patterns: FORBIDDEN_HEADING_PATTERNS },
  { category: "forbidden-v8-persona-boilerplate", patterns: FORBIDDEN_V8_PERSONA_BOILERPLATE }
];

function isGovernancePath(relativePath) {
  return GOVERNANCE_DOCUMENTS.some((entry) => entry.path === relativePath);
}

export async function readIfExists(root, relativePath) {
  try {
    return await readFile(path.join(root, relativePath), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function collectDefaultRuntimeFiles(root) {
  const files = new Set(V9_DEFAULT_RUNTIME_FILES);

  for (const directory of V9_DEFAULT_RUNTIME_DIRECTORIES) {
    const absolute = path.join(root, directory);
    if (!existsSync(absolute)) continue;
    const info = await stat(absolute);
    if (!info.isDirectory()) continue;

    async function walk(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && /\.md(?:arkdown)?$/i.test(entry.name)) {
          files.add(path.relative(root, full).split(path.sep).join("/"));
        }
      }
    }

    await walk(absolute);
  }

  for (const entry of GOVERNANCE_DOCUMENTS) {
    const absolute = path.join(root, entry.path);
    if (existsSync(absolute)) {
      files.add(entry.path);
    }
  }

  return [...files].sort((left, right) => left.localeCompare(right));
}

export function scanContents(file, contents, options = {}) {
  const violations = [];
  const useGovernanceRules = options.governance === true;
  const patternGroups = useGovernanceRules
    ? GOVERNANCE_FORBIDDEN_PATTERNS
    : RUNTIME_FORBIDDEN_PATTERNS;
  const lines = contents.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    for (const { category, patterns } of patternGroups) {
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          violations.push({
            file,
            line: lineNumber,
            category,
            excerpt: line.trim().slice(0, 160),
            pattern: pattern.toString()
          });
        }
      }
    }
  });
  return violations;
}

/**
 * Scan the v9 default runtime path for forbidden biography / tone /
 * personality prose. Returns a structured report that downstream tests and
 * the validate-next gate can consume without re-deriving the rules.
 *
 * @param {object} [options]
 * @param {string} [options.root] Repository root (defaults to DEFAULT_ROOT).
 * @returns {Promise<{
 *   ok: boolean,
 *   root: string,
 *   files: string[],
 *   violations: Array<{ file: string, line: number, category: string, excerpt: string, pattern: string }>,
 *   counts: { filesScanned: number, violationsByCategory: Record<string, number> }
 * }>}
 */
export async function scanDefaultRuntime(options = {}) {
  const root = options.root ?? DEFAULT_ROOT;
  const files = await collectDefaultRuntimeFiles(root);
  const violations = [];
  const fileRuleMap = [];

  for (const file of files) {
    const contents = await readIfExists(root, file);
    if (contents === null) continue;
    const governance = isGovernancePath(file);
    fileRuleMap.push({ file, rule: governance ? "governance" : "runtime" });
    violations.push(...scanContents(file, contents, { governance }));
  }

  const violationsByCategory = {};
  for (const v of violations) {
    violationsByCategory[v.category] = (violationsByCategory[v.category] ?? 0) + 1;
  }

  return {
    ok: violations.length === 0,
    root,
    files,
    fileRuleMap,
    violations,
    counts: {
      filesScanned: files.length,
      violationsByCategory
    }
  };
}

function formatViolation(v) {
  return `  ${v.file}:${v.line} [${v.category}] ${v.excerpt}`;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");

  const report = await scanDefaultRuntime();

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(
      `[scan-default-runtime] files=${report.counts.filesScanned} ` +
        `violations=${report.violations.length}\n`
    );
    if (report.violations.length > 0) {
      process.stdout.write(report.violations.map(formatViolation).join("\n") + "\n");
    }
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (resolveMainScript() === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`
    );
    process.exitCode = 1;
  });
}

function resolveMainScript() {
  try {
    if (process.argv[1]) {
      return path.resolve(process.argv[1]);
    }
  } catch (_error) {
    // Fall through; argv[1] may be undefined under unusual invocations.
  }
  return "";
}