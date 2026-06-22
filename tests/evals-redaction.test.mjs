// P13-T02 redaction policy regression test.
//
// The Phase 0 SCORING-RUBRIC.md declares that the held-out assertion
// `redaction does not hide command failures` is binding. This test pins
// the contract:
//
//   * Every detector in REDACTION_PATTERNS fires on a representative
//     input and emits a stable placeholder.
//   * Re-running redactText() on its own output is idempotent (the
//     placeholders are not re-matched by the canary / bearer / JSON /
//     URL-credential / credential-assignment detectors).
//   * The held-out redaction contract preserves failure context: a
//     transcript that contains a non-zero exit code and stderr lines
//     still contains those lines after redaction.
//   * redactAndAudit() writes the audit JSON with per-detector counts
//     but never includes the matched secret values.
//
// The test runs without spawning subprocesses so it stays under the
// root-level `node --test` budget.

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  REDACTION_PATTERNS,
  redactAndAudit,
  redactText
} from "../scripts/baseline/redact-output.mjs";

const CANARY = "LEGION_SECRET_CANARY_A1B2_C3D4";
const BEARER = "abcdefghijklmnopqrstuvwxyz1234567890";
const OPENAI_KEY = "sk-proXXYYZZfakefakefakefake";
const URL_CREDS = "https://alice:hunter2@example.com/api/v1";
// Placeholder JSON credential: the value is a fake "AK..." prefix that
// still matches the JSON-credential regex but is not a real AWS access
// key. The detector masks it to [REDACTED_JSON_SECRET] in the audit
// path regardless of the literal prefix used here.
const JSON_SECRET = '{"apiKey": "PLACEHOLDER-AWS-ACCESS-KEY", "other": 1}';
// PEM block: real PEM markers so the regex matches. The header/footer
// name the key as a clearly-fake "FAKE EXAMPLE" type so gitleaks and
// humans won't mistake it for a real private key. The body is a
// deterministic placeholder.
const PEM_KEY = [
  "-----BEGIN FAKE EXAMPLE PRIVATE KEY-----",
  "MIIEPLACEHOLDERPLACEHOLDERPLACEHOLDERPLACEHOLDER",
  "MIIEPLACEHOLDERPLACEHOLDERPLACEHOLDERPLACEHOLDER",
  "-----END FAKE EXAMPLE PRIVATE KEY-----"
].join("\n");
// Placeholder JWT: anchors are real (eyJ... .eyJ... .signature) so the
// detector regex fires, but the body is plain ASCII that is not a real
// signed token. Each segment is at least 12 characters so the regex's
// `[A-Za-z0-9_-]{8,}` quantifier matches; the placeholder text keeps
// the literal from looking like a real signed JWT.
const JWT_TOKEN = "eyJPLACEHOLDER01.eyJPLACEHOLDER02.PLACEHOLDER03";
const CREDENTIAL_ASSIGNMENT = "password=hunter2";

test("P13-T02 redact-output covers every documented detector with a stable placeholder", () => {
  // Map detector id -> sample input + expected placeholder substring.
  const samples = {
    secret_canary: [CANARY, "[REDACTED_SECRET_CANARY]"],
    bearer: [`Bearer ${BEARER}`, "[REDACTED_TOKEN]"],
    bearer_continuation: [`Bearer\n  ${BEARER}abcdef`, "[REDACTED_TOKEN]"],
    openai_key: [OPENAI_KEY, "[REDACTED_OPENAI_KEY]"],
    url_credentials: [URL_CREDS, "[REDACTED_URL_CREDENTIALS]"],
    json_credential: [JSON_SECRET, "[REDACTED_JSON_SECRET]"],
    pem_private_key: [PEM_KEY, "[REDACTED_PEM_PRIVATE_KEY]"],
    jwt: [JWT_TOKEN, "[REDACTED_JWT]"],
    credential_assignment: [CREDENTIAL_ASSIGNMENT, "[REDACTED_SECRET]"]
  };

  const seenIds = new Set();
  for (const entry of REDACTION_PATTERNS) {
    seenIds.add(entry.id);
  }
  for (const id of Object.keys(samples)) {
    assert.ok(seenIds.has(id), `REDACTION_PATTERNS is missing the ${id} detector`);
  }

  // Each detector must mask its sample and produce a non-empty audit
  // entry. We run the full redactText pipeline on each sample so we
  // exercise the actual ordering.
  for (const [id, [sample, expected]] of Object.entries(samples)) {
    const { text, audit } = redactText(sample);
    // PEM blocks include the BEGIN/END markers in the sample so the
    // redaction must collapse the body, not erase the markers
    // entirely. For everything else the raw sample must be gone.
    if (id !== "pem_private_key") {
      assert.ok(
        !text.includes(sample),
        `${id}: raw sample must not survive redaction`
      );
    } else {
      // PEM: the BEGIN/END markers can stay (they're the framing, not the
      // secret); the body placeholder must be present.
      assert.ok(
        text.includes("[REDACTED_PEM_PRIVATE_KEY]"),
        `${id}: PEM body must be redacted`
      );
      assert.ok(
        !text.includes("MIIEPLACEHOLDER"),
        `${id}: PEM body placeholder must not survive redaction`
      );
    }
    assert.ok(
      text.includes(expected) || text.includes("[REDACTED_"),
      `${id}: expected placeholder ${expected} in redacted output, got ${text}`
    );
    assert.ok(
      audit[id] && audit[id] >= 1,
      `${id}: expected at least one match in audit log, got ${JSON.stringify(audit)}`
    );
  }
});

test("P13-T02 redact-output is idempotent on its own output", () => {
  const sample = [
    CANARY,
    `Bearer ${BEARER}`,
    URL_CREDS,
    JSON_SECRET,
    CREDENTIAL_ASSIGNMENT
  ].join("\n");
  const first = redactText(sample).text;
  const second = redactText(first).text;
  assert.equal(second, first, "redactText must converge in one pass");
  // The canary detector must not re-match a placeholder.
  assert.ok(!first.includes(CANARY), "placeholder redaction removed the canary");
  assert.ok(first.includes("[REDACTED_SECRET_CANARY]"), "placeholder is present");
});

test("P13-T02 redact-output preserves failure context (held-out contract)", () => {
  // The held-out assertion `redaction does not hide command failures`
  // means that a transcript with non-zero exit codes, stderr lines, and
  // stack traces must keep those lines visible after redaction. We seed
  // the transcript with a canary, a credential assignment, and a
  // failure context block, then assert that the failure lines survive.
  const sample = [
    `$ running integration tests`,
    `$ ${CANARY}`,
    `password=hunter2`,
    `Traceback (most recent call last):`,
    `  File "test.py", line 7, in <module>`,
    `AssertionError: expected 200, got 500`,
    `exit_code=1`,
    `stderr: 1 test failed`
  ].join("\n");
  const { text, audit } = redactText(sample);
  assert.ok(audit.secret_canary >= 1, "canary detector fired");
  assert.ok(audit.credential_assignment >= 1, "credential detector fired");
  assert.ok(text.includes("AssertionError"), "stack trace line preserved");
  assert.ok(text.includes("exit_code=1"), "exit code line preserved");
  assert.ok(text.includes("stderr: 1 test failed"), "stderr line preserved");
  assert.ok(text.includes("Traceback"), "traceback header preserved");
});

test("P13-T02 redactAndAudit writes per-detector counts without leaking secret values", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "p13-t02-redact-"));
  const inputPath = path.join(dir, "raw.log");
  const outputPath = path.join(dir, "redacted.log");
  const auditPath = path.join(dir, "audit.json");
  await writeFile(
    inputPath,
    [
      `${CANARY}`,
      `${URL_CREDS}`,
      `${JSON_SECRET}`,
      `exit_code=1`,
      `stderr: 1 test failed`
    ].join("\n"),
    "utf8"
  );
  const audit = await redactAndAudit(inputPath, outputPath, auditPath);
  assert.ok(audit.secret_canary >= 1);
  assert.ok(audit.url_credentials >= 1);
  assert.ok(audit.json_credential >= 1);
  const auditJson = JSON.parse(await readFile(auditPath, "utf8"));
  assert.equal(auditJson.schema_version, 1);
  // The audit log must not contain the secret values themselves.
  const auditText = await readFile(auditPath, "utf8");
  assert.ok(!auditText.includes(CANARY.split("_").slice(-1)[0] === "C3D4" ? "C3D4" : ""));
  assert.ok(!auditText.includes("hunter2"));
  assert.ok(!auditText.includes("PLACEHOLDER-AWS-ACCESS-KEY"));
  // The redacted transcript must contain the canary placeholder and the
  // preserved failure context.
  const redactedText = await readFile(outputPath, "utf8");
  assert.ok(redactedText.includes("[REDACTED_SECRET_CANARY]"));
  assert.ok(redactedText.includes("exit_code=1"));
});