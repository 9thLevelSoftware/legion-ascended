import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { classifyEvidenceSource } from "../packages/cli/dist/workflow/evidence-sources.js";

/**
 * The first content-based reader of these reports in the tree, held against the
 * reports themselves.
 *
 * `legion attest` refuses a `pass` over a source whose own verdict is negative,
 * and the three attestation gates re-derive the same answer at ship time. Both
 * go through `classifyEvidenceSource`, so this is where the shape recognition is
 * actually pinned — `tests/ship-risk-gates` and `tests/attestation-gates` inject
 * a fixture classifier so they can stay filesystem-free, which means a defect in
 * the parser itself would be invisible to both.
 *
 * The fixtures are the repository's **own committed artefacts** rather than
 * hand-written literals, deliberately. Every one of these predicates mirrors a
 * rule inside a script this module does not own; a literal transcribed from the
 * script would agree with the script by construction and would keep agreeing
 * after the script changed.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function classifyFile(relativePath, repositoryRoot = ROOT) {
  return classifyEvidenceSource(await readFile(path.join(ROOT, relativePath), "utf8"), { repositoryRoot });
}

function classify(document, repositoryRoot = ROOT) {
  return classifyEvidenceSource(typeof document === "string" ? document : JSON.stringify(document), {
    repositoryRoot
  });
}

test("the green threat model in this repository reads clean", async () => {
  // Structural recognition, asserted against a file that carries no discriminator
  // at all. `threat-model.json`, `ab-comparison.json`, `score.json` and
  // `run-manifest.json` all carry `schema_version: 1`, so the only non-guessing
  // recogniser is the key tuple — `ok` plus `run_dir` plus `output_root` plus a
  // `checks` map whose keys are exactly sandbox/retention/redaction — which is a
  // fact about the producer rather than about where the file was filed.
  const verdict = await classifyFile("docs/next/evidence/P13-T02/threat-model.json");
  assert.equal(verdict.kind, "clean");
  assert.equal(verdict.shape, "threat-model");
  assert.equal(verdict.enveloped, false);
});

test("the committed failing threat model reads blocking and names its findings", async () => {
  // The negative fixture is a real one produced by the same script over a run
  // whose redacted transcript still contains the secret canary. It is the only
  // in-tree, platform-neutral red report of any shape, which is why the refusal
  // tests use it rather than a chmod or an attrib trick.
  const verdict = await classifyFile("docs/next/evidence/P13-T02/negative/threat-model.json");
  assert.equal(verdict.kind, "blocking");
  assert.equal(verdict.shape, "threat-model");
  assert.match(verdict.reason, /canary_present_after_redaction/);
});

test("the committed rollback verdict is blocking here, because it audited another filesystem tree", async () => {
  // **The laundering this comparison exists to stop, asserted against the exact
  // file the CLI's own help text used to recommend.**
  //
  // `rollback-policy.mjs` takes `--repository-root`, records it as
  // `repository_root`, copies the audited manifest's `repositoryRoot`, and raises
  // the blocking `manifest_repository_root_match` when the two differ. So the
  // document states which tree it is a verdict about — and this one names
  // `/var/folders/.../tmpamcjw11f`, a macOS temp directory that has never existed
  // in this repository, backed by a manifest written in June 2026, with its own
  // finding reporting that there is no `.legion` directory there at all. The same
  // audit re-run against this checkout would be `ok: false` / `status: "blocked"`.
  //
  // Read on `ok`, `status` and `findings` alone it is green, and it satisfied
  // `rollback_or_forward_fix_evidence` for every change in this repository —
  // satisfied precisely *because* the audit was run somewhere else. Any
  // rollback-policy JSON from any other checkout, or one produced by pointing the
  // script at a scratch directory holding a hand-made backup manifest, laundered
  // identically.
  const raw = JSON.parse(await readFile(path.join(ROOT, "docs/next/evidence/P13-T03/rollback-policy.json"), "utf8"));
  assert.equal(raw.ok, true, "the fixture must really be green by its own summary");
  assert.equal(raw.status, "restorable");
  assert.notEqual(raw.repository_root, ROOT, "the fixture must really name a foreign tree");

  const verdict = await classifyFile("docs/next/evidence/P13-T03/rollback-policy.json");
  assert.equal(verdict.kind, "blocking");
  assert.equal(verdict.shape, "rollback-policy");
  assert.match(verdict.reason, /not the repository being shipped/);
  assert.match(verdict.reason, /manifest_repository_root_match/);
});

test("the severity filter survives the root check: the same verdict read in its own tree is clean", async () => {
  // **The assertion that would have caught the specification as written.** The
  // rule this release was asked to implement was "refuse a pass when the file's
  // own `ok !== true` or `findings.length > 0`". This file has `ok: true` and
  // exactly one finding, `restore_target_absent`, whose severity is `info` and
  // which `scripts/release/rollback-policy.mjs` excludes from its own verdict at
  // the line that computes `ok`. A severity-blind helper would refuse every green
  // rollback verdict a greenfield migration can produce.
  //
  // Read against the root it actually audited, that is what this file is: clean.
  // Both halves are asserted together deliberately — the root comparison is a
  // *scoping* rule and must not be allowed to quietly stand in for the severity
  // rule, or the next author to relax it would find the suite still green.
  const raw = JSON.parse(await readFile(path.join(ROOT, "docs/next/evidence/P13-T03/rollback-policy.json"), "utf8"));
  assert.ok(raw.findings.length > 0, "the fixture must actually carry the finding this test is about");
  assert.ok(raw.findings.every((finding) => finding.severity === "info"));

  const verdict = await classifyFile("docs/next/evidence/P13-T03/rollback-policy.json", raw.repository_root);
  assert.equal(verdict.kind, "clean");
  assert.equal(verdict.shape, "rollback-policy");
});

test("a rollback verdict that does not say which tree it audited is blocking", () => {
  // Positive check, never negative: a report that omits `repository_root` or the
  // manifest's `repositoryRoot` has not been shown to be about this repository,
  // and "the field is absent so there is nothing to compare" is the shape of every
  // fail-open this series has paid for.
  const green = {
    ok: true,
    status: "restorable",
    backup_manifest_path: `${ROOT}/backup-manifest.json`,
    repository_root: ROOT,
    manifest: { repositoryRoot: ROOT },
    findings: [],
    checks: { manifest: { ok: true, findings: [] }, restore_target: { ok: true, findings: [] } }
  };
  assert.equal(classify(green).kind, "clean", "the control must be clean or this test proves nothing");

  const noRoot = classify({ ...green, repository_root: undefined });
  assert.equal(noRoot.kind, "blocking");
  assert.match(noRoot.reason, /does not record a repository_root/);

  const noManifestRoot = classify({ ...green, manifest: { createdAt: "2026-08-01T00:00:00.000Z" } });
  assert.equal(noManifestRoot.kind, "blocking");
  assert.match(noManifestRoot.reason, /does not record a manifest\.repositoryRoot/);

  // And the manifest's root is compared as well as the top-level one. They are
  // written from two different sources — the operator's `--repository-root` and
  // the audited manifest's own field — and the whole content of
  // `manifest_repository_root_match` is that those two can disagree.
  const foreignManifest = classify({ ...green, manifest: { repositoryRoot: "/var/folders/xx/tmpamcjw11f" } });
  assert.equal(foreignManifest.kind, "blocking");
  assert.match(foreignManifest.reason, /manifest\.repositoryRoot is/);

  // A repository root that never reached the reader fails closed too, rather than
  // skipping the comparison it could not make.
  const unrooted = classifyEvidenceSource(JSON.stringify(green), {});
  assert.equal(unrooted.kind, "blocking");
  assert.match(unrooted.reason, /could not be compared to the repository being shipped/);
});

test("a rollback policy with a finding above info reads blocking", () => {
  // The other half of the same claim: the severity filter is a filter, not a
  // blanket tolerance. Written as a literal rather than taken from a file because
  // the repository ships no red rollback artefact, and the two together are what
  // make the `info` exclusion a rule rather than an exemption.
  const verdict = classify({
    ok: false,
    status: "blocked",
    backup_manifest_path: "/tmp/backup-manifest.json",
    repository_root: ROOT,
    manifest: { repositoryRoot: ROOT },
    findings: [{ code: "manifest_backup_hash_match", severity: "error", message: "hash mismatch" }],
    checks: { manifest: { ok: false }, restore_target: { ok: true } }
  });
  assert.equal(verdict.kind, "blocking");
  assert.equal(verdict.shape, "rollback-policy");
  assert.match(verdict.reason, /manifest_backup_hash_match/);
});

test("a red subcheck blocks even when the document's own summary says ok", () => {
  // **The fail-open both recognisers walked past.** Each of these documents
  // carries its verdict three times — a top-level `ok`, a `findings[]`, and a
  // `checks` map whose entries carry their own `ok` — and the producers compute
  // the first *from* the third: `threat-model.mjs` sets `ok = sandbox &&
  // retention && redaction`, and `rollback-policy.mjs` sets each subcheck's `ok`
  // from the same findings it summarises. Reading only the derived field, having
  // already opened `checks` to recognise the shape, is the identical mistake to
  // reading a CLI envelope's `ok` without descending into `.verdict` — which this
  // same module closes one level up, and which the test below it asserts.
  const threat = classify({
    schema_version: 1,
    run_dir: "x",
    output_root: "y",
    ok: true,
    checks: { sandbox: { ok: false, exit_code: 1 }, retention: { ok: true }, redaction: { ok: false } },
    findings: []
  });
  assert.equal(threat.kind, "blocking");
  assert.equal(threat.shape, "threat-model");
  assert.match(threat.reason, /sandbox subcheck reports ok false/);

  const rollback = classify({
    ok: true,
    status: "restorable",
    backup_manifest_path: `${ROOT}/backup-manifest.json`,
    repository_root: ROOT,
    manifest: { repositoryRoot: ROOT },
    findings: [],
    checks: {
      manifest: { ok: false, findings: [{ code: "manifest_repository_root_match" }] },
      restore_target: { ok: false, findings: [{ code: "backup_hash_drift" }] }
    }
  });
  assert.equal(rollback.kind, "blocking");
  assert.equal(rollback.shape, "rollback-policy");
  assert.match(rollback.reason, /manifest subcheck reports ok false/);

  // A subcheck that says `ok: true` beside its own blocking finding is the same
  // disagreement one level lower, and it blocks for the same reason.
  const contradicted = classify({
    ok: true,
    status: "restorable",
    backup_manifest_path: `${ROOT}/backup-manifest.json`,
    repository_root: ROOT,
    manifest: { repositoryRoot: ROOT },
    findings: [],
    checks: {
      manifest: { ok: true, findings: [{ code: "manifest_backup_hash_match", severity: "error" }] },
      restore_target: { ok: true, findings: [] }
    }
  });
  assert.equal(contradicted.kind, "blocking");
  assert.match(contradicted.reason, /manifest_backup_hash_match/);
});

test("a findings field that is not an array is malformed, never empty", () => {
  // `asArray(document.findings) ?? []` turned an object into zero findings, which
  // defeated the exact redundancy the `ok`-plus-`findings` pair exists for:
  // `findings: {"0": {code: "canary_present_after_redaction"}}` beside a
  // hand-edited `ok: true` read clean. A quantifier over a set this module could
  // not build is the vacuous truth this series has now paid for six times, so a
  // present-but-wrong-typed field is a document that cannot be read as green
  // rather than a document with nothing to report.
  const verdict = classify({
    schema_version: 1,
    run_dir: "x",
    output_root: "y",
    ok: true,
    checks: { sandbox: { ok: true }, retention: { ok: true }, redaction: { ok: true } },
    findings: { 0: { code: "canary_present_after_redaction" } }
  });
  assert.equal(verdict.kind, "blocking");
  assert.equal(verdict.shape, "threat-model");
  assert.match(verdict.reason, /rather than an array/);
});

test("the committed A/B comparison reads blocking, because its baseline side is empty", async () => {
  // The artefact an `independent-baseline` attestation would most naturally cite,
  // and it positively states that there is no baseline: `v8_summary.run_count` is
  // 0 and every scenario row reads `v8_present: false` with a null deterministic
  // total. It is a v9-only aggregate wearing an A/B filename.
  //
  // A recogniser that only checked structural fit would accept it, and no `ok`
  // field exists on this shape for a generic rule to consult — which is why the
  // predicate is over the rows and why, against today's committed bytes, it
  // correctly refuses.
  const raw = JSON.parse(
    await readFile(path.join(ROOT, "docs/next/evidence/P13-T01/ab-comparison/ab-comparison.json"), "utf8")
  );
  assert.equal(raw.ok, undefined, "this shape carries no verdict field at all");
  assert.equal(raw.v8_summary.run_count, 0);

  const verdict = await classifyFile("docs/next/evidence/P13-T01/ab-comparison/ab-comparison.json");
  assert.equal(verdict.kind, "blocking");
  assert.equal(verdict.shape, "ab-comparison");
  assert.match(verdict.reason, /baseline side is empty/);
});

test("a run score is recognised and refused, however green it looks", async () => {
  // The sharpest shape-confusion hazard of the four, and it is not hypothetical.
  // The tampered-run fixture's score is byte-identical in verdict to the passing
  // run's — `critical_failure: false`, `total: 70` — over the run whose own threat
  // model reports a leaked canary, because `grade-run.mjs` checks artefact
  // presence and terminal status and never inspects what the run produced.
  //
  // Its verdict field also has inverted polarity: `critical_failure: false` is the
  // green state, so a generic "read the truthy verdict field" reader would pass
  // exactly the failures. Recognising the shape is what lets the refusal name the
  // file to cite instead; left unrecognised it would refuse too, but silently.
  const tampered = JSON.parse(
    await readFile(
      path.join(ROOT, "docs/next/evidence/P13-T02/negative/tampered-run/score.json"),
      "utf8"
    )
  );
  assert.equal(tampered.critical_failure, false, "the fixture must really look green");

  const verdict = await classifyFile("docs/next/evidence/P13-T02/negative/tampered-run/score.json");
  assert.equal(verdict.kind, "blocking");
  assert.equal(verdict.shape, "run-score");
  assert.match(verdict.reason, /never what the run produced/);
});

test("the CLI envelope is unwrapped once and classified by its inner document", async () => {
  // The same command produces two different documents: `legion dev evals
  // threat-model --json` returns `{ok, status, verdict: <raw report>}` while
  // `--report <path>` writes the raw payload. Both are plausible --source
  // arguments, and `scripts/release/release-checklist.mjs` already tolerates both
  // by hand (`verdict?.findings ?? verdict?.verdict?.findings`).
  //
  // The hazard is reading the envelope's top-level `ok` while never descending
  // into `.verdict.findings`, which passes a red report. Asserted here by wrapping
  // the *failing* report in an envelope whose top-level `ok` is `true`.
  const inner = JSON.parse(
    await readFile(path.join(ROOT, "docs/next/evidence/P13-T02/negative/threat-model.json"), "utf8")
  );
  const verdict = classify({ ok: true, status: "verified", verdict: inner });
  assert.equal(verdict.kind, "blocking");
  assert.equal(verdict.shape, "threat-model");
  assert.equal(verdict.enveloped, true);
});

test("an unrecognised shape is unrecognised, and unreadable bytes are unread", () => {
  // Two different facts with two different sentences, and both refuse a pass.
  // Collapsing them would blame the artifact for the reader's problem or the
  // reader for the artifact's.
  assert.deepEqual(classifyEvidenceSource(JSON.stringify({ hello: "world" })), { kind: "unrecognised" });
  assert.deepEqual(classifyEvidenceSource(JSON.stringify(["a", "b"])), { kind: "unrecognised" });

  const notJson = classifyEvidenceSource("# ADR-006\n\nRisk gates.\n");
  assert.equal(notJson.kind, "unread");
  const uncollected = classifyEvidenceSource(undefined);
  assert.equal(uncollected.kind, "unread");
  assert.match(uncollected.reason, /not collected/);
});

test("an envelope whose inner document is unrecognised does not fall back to the envelope", () => {
  // The fail-open this arm exists to close: reading `{ok: true}` off the wrapper
  // and calling it clean, having never looked at what it wraps.
  const verdict = classifyEvidenceSource(JSON.stringify({ ok: true, status: "verified", verdict: { hello: "world" } }));
  assert.deepEqual(verdict, { kind: "unrecognised" });
});
