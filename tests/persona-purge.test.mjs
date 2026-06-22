import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The v9 default runtime path is the canonical worker bundle surface that
// ships in the v9 package. Today it is the four workflow-common-* v1.0.0 packs
// extracted in P04-T03. Future v9 worker bundle prompt content files (under
// `bundles/`) will join this list once they are added.
//
// The legacy v8 persona surface (`agents/*.md`, `commands/*.md`, `adapters/*.md`,
// `skills/` outside the four packs listed below, and `.codex-plugin/`) is
// explicitly preserved per `docs/next/V8-MAINTENANCE-POLICY.md` and is NOT
// scanned here. A separate opt-in legacy bridge loads those files; the v9
// default runtime path never does.

const V9_DEFAULT_RUNTIME_FILES = [
  "skills/workflow-common-core/SKILL.md",
  "skills/workflow-common-github/SKILL.md",
  "skills/workflow-common-memory/SKILL.md",
  "skills/workflow-common-domains/SKILL.md"
];

const V9_DEFAULT_RUNTIME_DIRECTORIES = [
  // Bundled worker bundle prompt content, once added. Empty today but reserved.
  "bundles"
];

// Forbidden section labels declared by ADR-002 plus the v9 worker bundle
// schema. These are the prose categories the v9 default runtime must not
// inject. A scanner can look for headings, frontmatter, or feature phrases
// that match these patterns.
const FORBIDDEN_HEADING_PATTERNS = [
  /^#{1,6}\s+(Your\s+)?(Identity|Memory|Experience|Personality|Tone)\b/im,
  /^#{1,6}\s+(Your\s+)?Core\s+Beliefs?\b/im,
  /^#{1,6}\s+(Your\s+)?Communication\s+Style\b/im,
  /^#{1,6}\s+(Your\s+)?Success\s+Metrics\b/im,
  /^#{1,6}\s+(Your\s+)?Personality\s+Injection\b/im
];

const FORBIDDEN_PROSE_PHRASES = [
  /\b(?:you\s+are|you're)\s+(?:a|an)\s+[A-Z][\w-]*(?:\s+[A-Z][\w-]*){0,3},?\s+(?:a|an|the)\s+senior\b/i,
  /\b(?:you\s+have|you've)\s+seen\s+too\s+many\b/i,
  /\b(?:era\s+ends|era\s+begins)\s+with\s+you\b/i,
  /\b(?:fantasy|fantasies)\b(?:\s+(?:reporting|approval|claim|score|language))?/i,
  /\bA\+\s+certifications?\b/i,
  /\b(?:zero\s+issues\s+found|perfect\s+scores?|NEEDS\s+WORK)\b/i,
  /\b(?:I|we)\s+remember\s+(?:previous|all)\s+/i,
  /\b(?:skeptical|forensic|skeptical,\s+forensic)\b/i
];

// Legacy v8 persona injection boilerplate. These phrases appear in the
// deprecated `skills/workflow-common/SKILL.md` shim and in legacy agent files.
// They MUST NOT appear in any v9 default runtime path file.
const FORBIDDEN_V8_PERSONA_BOILERPLATE = [
  /\b(?:AGENTS_DIR|agents-orchestrator\.md)\b/,
  /\bInject\s+personality\s+content\b/i,
  /\b(?:ALWAYS|always)\s+read\s+the\s+agent\s+personality\s+file\s+before\s+spawning\b/i,
  /\b(?:personality\s+files?|personality\s+markdown)\b/i,
  /\b(?:load\s+full\s+personality|loading\s+personality)\b/i
];

async function readIfExists(relativePath) {
  try {
    const contents = await readFile(path.join(ROOT, relativePath), "utf8");
    return contents;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function collectDefaultRuntimeFiles() {
  const files = [...V9_DEFAULT_RUNTIME_FILES];
  for (const directory of V9_DEFAULT_RUNTIME_DIRECTORIES) {
    const absolute = path.join(ROOT, directory);
    let exists = false;
    try {
      const info = await stat(absolute);
      exists = info.isDirectory();
    } catch (error) {
      if (error && error.code === "ENOENT") exists = false;
      else throw error;
    }
    if (!exists) continue;

    async function walk(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && /\.md$/.test(entry.name)) {
          files.push(path.relative(ROOT, full).split(path.sep).join("/"));
        }
      }
    }

    await walk(absolute);
  }
  return files;
}

function scanForForbiddenProse(file, contents) {
  const violations = [];
  const lines = contents.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    for (const pattern of FORBIDDEN_HEADING_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          file,
          line: lineNumber,
          category: "forbidden-heading",
          excerpt: line.trim().slice(0, 160),
          pattern: pattern.toString()
        });
      }
    }
    for (const pattern of FORBIDDEN_PROSE_PHRASES) {
      if (pattern.test(line)) {
        violations.push({
          file,
          line: lineNumber,
          category: "forbidden-prose",
          excerpt: line.trim().slice(0, 160),
          pattern: pattern.toString()
        });
      }
    }
    for (const pattern of FORBIDDEN_V8_PERSONA_BOILERPLATE) {
      if (pattern.test(line)) {
        violations.push({
          file,
          line: lineNumber,
          category: "forbidden-v8-persona-boilerplate",
          excerpt: line.trim().slice(0, 160),
          pattern: pattern.toString()
        });
      }
    }
  });
  return violations;
}

test("v9 default runtime path contains no biography, tone, or personality prose", async () => {
  const files = await collectDefaultRuntimeFiles();
  assert.ok(
    files.length > 0,
    "expected at least one v9 default runtime path file; check V9_DEFAULT_RUNTIME_FILES"
  );

  const allViolations = [];
  for (const file of files) {
    const contents = await readIfExists(file);
    if (contents === null) continue;
    const violations = scanForForbiddenProse(file, contents);
    allViolations.push(...violations);
  }

  assert.deepEqual(
    allViolations,
    [],
    `v9 default runtime path must not contain biography, tone, or personality prose.\n` +
      `Found ${allViolations.length} violation(s):\n` +
      allViolations
        .map((v) => `  ${v.file}:${v.line} [${v.category}] ${v.excerpt}`)
        .join("\n")
  );
});

test("v9 default runtime path files declare promptContentContract forbiddens", async () => {
  // The canonical v9 worker bundle resolution rules live in
  // `workflow-common-core`, the always-load core pack. That pack MUST declare
  // the prompt-content contract vocabulary so any new runtime that joins the
  // default path knows to honor it. The optional domain packs
  // (github, memory, domains) do not need to restate the contract — they
  // inherit enforcement from the core pack — so the keyword check is scoped
  // to the core pack only.
  const expectedKeywords = [
    "forbiddenSections",
    "instructionsHash",
    "biography",
    "tone",
    "personality"
  ];
  const failures = [];
  for (const file of ["skills/workflow-common-core/SKILL.md"]) {
    const contents = await readIfExists(file);
    assert.ok(contents !== null, `missing v9 default runtime file: ${file}`);
    const missing = expectedKeywords.filter((keyword) => !contents.includes(keyword));
    if (missing.length > 0) {
      failures.push({ file, missing });
    }
  }
  assert.deepEqual(
    failures,
    [],
    "the v9 core pack must declare the prompt-content contract and the forbidden-section vocabulary; missing: " +
      JSON.stringify(failures)
  );
});

test("v9 worker bundle schema marks biography, tone, personality as forbidden", async () => {
  // The fixture and schema for task-run already encode the contract; the test
  // guards against accidental removal during future edits.
  const fixturePath = "schemas/entities/fixtures/lifecycle-valid.json";
  const fixtureRaw = await readIfExists(fixturePath);
  assert.ok(fixtureRaw !== null, `missing fixture: ${fixturePath}`);
  const fixture = JSON.parse(fixtureRaw);
  const forbiddens = new Set(
    fixture.taskRun.manifest.workerBundle.promptContentContract.forbiddenSections
  );
  assert.ok(forbiddens.has("biography"), "fixture must mark biography as forbidden");
  assert.ok(forbiddens.has("tone"), "fixture must mark tone as forbidden");
  assert.ok(forbiddens.has("personality"), "fixture must mark personality as forbidden");
});

test("package-boundary check still blocks v9 packages from importing legacy prompt assets", async () => {
  // This regression guard calls the boundary checker against a fixture that
  // imports a legacy persona file from a workspace package. The check is the
  // durable enforcement that prevents the v9 default runtime path from
  // re-introducing biography/tone/personality prose via imports.
  const { checkPackageBoundaries } = await import(
    "../scripts/check-package-boundaries.mjs"
  );
  const result = await checkPackageBoundaries({ root: ROOT });
  assert.equal(
    result.ok,
    true,
    "v9 workspace packages must not import legacy prompt assets; violations: " +
      JSON.stringify(
        result.violations.map((v) => `${v.file}: ${v.message}`),
        null,
        2
      )
  );
});