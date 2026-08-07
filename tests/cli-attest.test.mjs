import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

/**
 * `legion attest`, driven through the real CLI against a real R3 change.
 *
 * The claim this file exists to hold is that the verb is **not a rubber stamp**.
 * An attestation is the only thing in the tree that links a phase-keyed verdict
 * to a change, and the link is a human act — so the one failure that would make
 * the whole artifact worthless is a command that records "pass" over whatever it
 * is pointed at. Two of the tests below are that refusal, from opposite
 * directions: a report that is red by its own rule, and a file whose shape the
 * CLI cannot read a verdict out of at all.
 *
 * The other half is the audited waiver, which ADR-006 permits and which is the
 * only arm in these three gates that satisfies with no falsifiable evidence
 * behind it. It has to reach the operator, and a satisfied gate emits no
 * diagnostic — so the last test follows a waiver all the way into `legion ship`'s
 * payload and its human output.
 *
 * The evidence fixtures are written into the temp workspace rather than pinned
 * from `docs/next/evidence/`, deliberately. Those files are stored LF in the
 * index and check out CRLF on Windows, `hashContent` hashes raw bytes, and a pin
 * minted on one platform would read `drift` on the other — which is the gates'
 * strongest negative arm. A `.gitattributes` rule now fixes that for the
 * committed files; pinning bytes the test itself wrote makes this suite immune to
 * the question either way, and needs no chmod or attrib.
 */

const CREATED_AT = "2026-08-04T12:00:00.000Z";
const COMPOSE_PATH = "ops/compose.integration.yml";
const THREAT_MODEL_PATH = "evidence/threat-model.json";
const ADR_PATH = "docs/decisions/rollback-not-applicable.md";

const ANSWERS = {
  "project-name": "Order Router",
  "project-summary": "Routes orders to the pricing service.",
  "project-owner": "dasbl",
  "problem-statement": "Orders are priced against a stub, so drift ships.",
  "problem-users": "Payments engineers.",
  "problem-success": "A pricing change that breaks the contract fails before release.",
  "req-1-statement": "Orders are priced against the real pricing service",
  "req-1-priority": "must",
  "req-1-category": "behavior",
  "req-1-ac-1-statement": "A quote request reaches the running pricing service",
  "req-1-ac-1-proof": "executable",
  "req-1-ac-1-detail": "node --version",
  "req-1-ac-1-surface-kind": "real-interface",
  "req-1-ac-1-surface-interface": "POST /v1/quote",
  "req-1-ac-1-surface-rationale":
    "The check starts the pricing service and posts a real quote, with no HTTP stub in the path.",
  "req-1-ac-1-surface-pins": COMPOSE_PATH,
  "req-1-ac-1-more": "false",
  "req-1-more": "false",
  "non-goals": "Currency conversion",
  constraints: "TypeScript only",
  "risk-tier": "R3",
  "risk-reason": "A new surface other services depend on.",
  "budget-files": "20",
  "budget-lines": "2000",
  "budget-new-files": "10",
  "pref-verification": "legion validate"
};

/** A green report in the shape `scripts/baseline/threat-model.mjs` writes. */
function threatModel({ ok }) {
  return {
    schema_version: 1,
    generated_at: "2026-08-05T10:00:00.000Z",
    run_dir: "evidence/runs/security-sensitive.v1-r1",
    output_root: "evidence/runs",
    ok,
    checks: {
      sandbox: { ok, exit_code: ok ? 0 : 1 },
      retention: { ok: true, exit_code: 0 },
      redaction: { ok }
    },
    findings: ok
      ? []
      : [{ source: "redaction", code: "canary_present_after_redaction", message: "1 canary token(s) survived redaction", count: 1 }]
  };
}

/** A green report in the shape `scripts/release/rollback-policy.mjs` writes. */
function rollbackPolicy({ repositoryRoot }) {
  return {
    ok: true,
    status: "restorable",
    backup_manifest_path: path.join(repositoryRoot, "backup-manifest.json"),
    repository_root: repositoryRoot,
    source: "codex-legion",
    kind: "codex-legion-migration-backup",
    manifest: {
      schemaVersion: "0.1.0",
      kind: "codex-legion-migration-backup",
      createdAt: "2026-08-04T12:00:00.000Z",
      repositoryRoot,
      backupPath: path.join(repositoryRoot, "backup"),
      preMigrationHash: `sha256:${"b".repeat(64)}`,
      sourceHash: `sha256:${"1".repeat(64)}`,
      existingLegionRoot: true
    },
    findings: [{ code: "restore_target_absent", message: "No live .legion directory.", severity: "info" }],
    checks: {
      manifest: { name: "manifest", ok: true, findings: [] },
      restore_target: {
        name: "restore_target",
        ok: true,
        findings: [{ code: "restore_target_absent", message: "No live .legion directory.", severity: "info" }]
      }
    }
  };
}

function git(root, args) {
  execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

/** An R3 change planned, approved, built, reviewed and accepted — ship's own input. */
async function acceptedR3(t, { ok = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-attest-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);

  await mkdir(path.join(root, "ops"), { recursive: true });
  await writeFile(path.join(root, COMPOSE_PATH), "services:\n  pricing:\n    image: pricing:latest\n", "utf8");
  await mkdir(path.join(root, "evidence"), { recursive: true });
  await writeFile(path.join(root, THREAT_MODEL_PATH), `${JSON.stringify(threatModel({ ok }), null, 2)}\n`, "utf8");
  await mkdir(path.join(root, "docs/decisions"), { recursive: true });
  await writeFile(
    path.join(root, ADR_PATH),
    "# Rollback is not applicable to this change\n\nIt ships no migration and touches no persisted state.\n",
    "utf8"
  );

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  await writeFile(path.join(root, "intake.json"), JSON.stringify(ANSWERS), "utf8");
  assert.equal((await run("start", "--intake", "intake.json", "--created-at", CREATED_AT)).exitCode, 0);
  assert.equal((await run("start", "--finalize", "--json", "--created-at", CREATED_AT)).exitCode, 0);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "intake"]);
  assert.equal((await run("plan", "1", "--json")).exitCode, 0);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "plan"]);
  assert.equal((await run("approve", "spec", "--approver", "dasbl", "--json")).exitCode, 0);
  assert.equal((await run("approve", "oracle", "--approver", "dasbl", "--json")).exitCode, 0);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "approve"]);
  assert.equal((await run("build", "--executor", "fake", "--json")).exitCode, 0);
  assert.equal((await run("review", "--executor", "fake", "--json")).exitCode, 0);
  assert.equal((await run("review", "--accept", "--approver", "dasbl", "--json")).exitCode, 0);

  const changeId = (await readdir(path.join(root, ".legion/project/changes")))[0];
  return { root, run, changeId };
}

test("a pass over a report whose own ok is false is refused, and nothing is written", async (t) => {
  // **The defect this test exists for**, and the reason `legion attest` is a
  // parser rather than a writer with a flag.
  //
  // Without the refusal, the command's whole contract would be "record whatever
  // the operator typed against whatever file they named" — and because
  // `legion ship` re-reads the cited report, the record would be written, exit 0,
  // and then be contradicted by the very gate it was written for. That is the
  // exits-0-and-still-blocked loop this series exists to close, and it would be
  // introduced by the command that closes three gates.
  //
  // The fixture is a real `threat-model.mjs`-shaped report with `ok: false` and a
  // finding, which is what that script actually writes when a run's redacted
  // transcript still contains the secret canary.
  const { root, run, changeId } = await acceptedR3(t, { ok: false });

  const attested = await run(
    "attest",
    "security-evaluation",
    "--attested-by",
    "dasbl",
    "--verdict",
    "pass",
    "--source",
    THREAT_MODEL_PATH,
    "--json"
  );
  assert.equal(attested.exitCode, 1, attested.stdout + attested.stderr);
  const payload = parseJsonOutput(attested);
  assert.equal(payload.status, "blocked");
  const diagnostic = payload.diagnostics[0];
  assert.equal(diagnostic.code, "source_contradicts_verdict");
  assert.match(diagnostic.message, /negative by its own rule/);
  assert.match(diagnostic.message, /canary_present_after_redaction/);
  // The advice is the command that could produce a green report, never another
  // attestation: attesting cannot make a red report green.
  assert.match(payload.nextAction.command, /legion dev evals threat-model/);

  // Nothing was written. A refusal that leaves a partial record behind is a
  // refusal that has to be cleaned up by hand.
  await assert.rejects(
    readdir(path.join(root, ".legion/project/changes", changeId, "attestations")),
    /ENOENT/
  );
});

test("a pass over a file whose shape Legion cannot read is refused, and unknown is offered instead", async (t) => {
  // The other direction, and the one a rubber stamp would fail open on. An
  // unrecognised shape is not a shape that passed — a verdict the command cannot
  // check is exactly the thing this artifact was introduced to stop being.
  //
  // `--verdict unknown` is what makes that refusal usable rather than a dead end:
  // the citation is recorded, nothing is asserted about it, and the gate reads it
  // as `unevaluable` rather than as a pass.
  const { run } = await acceptedR3(t);

  const refused = await run(
    "attest",
    "security-evaluation",
    "--attested-by",
    "dasbl",
    "--verdict",
    "pass",
    "--source",
    ADR_PATH,
    "--json"
  );
  assert.equal(refused.exitCode, 1);
  const payload = parseJsonOutput(refused);
  assert.equal(payload.diagnostics[0].code, "source_shape_not_admissible");
  assert.match(payload.diagnostics[0].message, /it does not prove what they say/);
  assert.match(payload.nextAction.command, /--verdict unknown/);

  const unknown = await run(
    "attest",
    "security-evaluation",
    "--attested-by",
    "dasbl",
    "--verdict",
    "unknown",
    "--source",
    ADR_PATH,
    "--json"
  );
  assert.equal(unknown.exitCode, 0, unknown.stdout + unknown.stderr);
  assert.equal(parseJsonOutput(unknown).attestation.verdict, "unknown");
});

test("a clean threat model is attested, satisfies its gate, and re-running writes nothing", async (t) => {
  // The happy path, and the two properties that make it more than a write.
  //
  // The writer's "already attested" question is the *gate's own predicate*, called
  // rather than paraphrased — PR 2's lesson, where a writer whose idea of done was
  // weaker than the reader's idea of satisfied reported success, wrote nothing, and
  // left the change blocked forever. So a rerun reports `unchanged` only when the
  // gate would genuinely be satisfied.
  //
  // And it must not move `attestedAt` on a rerun: that field is what
  // `independent_baseline` orders against, so a harmless rerun that rewrote it
  // would be a command making a change strictly worse.
  const { root, run, changeId } = await acceptedR3(t);

  const attested = await run(
    "attest",
    "security-evaluation",
    "--attested-by",
    "dasbl",
    "--verdict",
    "pass",
    "--source",
    THREAT_MODEL_PATH,
    "--json"
  );
  assert.equal(attested.exitCode, 0, attested.stdout + attested.stderr);
  const payload = parseJsonOutput(attested);
  assert.equal(payload.status, "attested");
  assert.equal(payload.attestation.action, "record");
  assert.deepEqual(payload.attestation.sourceShapes, ["threat-model (clean)"]);
  assert.match(payload.attestation.sources[0].sha256, /^sha256:[0-9a-f]{64}$/);
  // Covers defaults to every task of the change, because the gate quantifies over
  // every task that derived it — a per-task default would make the
  // successful-looking path the one that leaves ship blocked.
  assert.ok(payload.attestation.covers.length > 0);
  assert.equal(payload.warnings, undefined, "a kind with a reader and full coverage owes no warning");

  const written = JSON.parse(
    await readFile(
      path.join(root, ".legion/project/changes", changeId, "attestations", `${payload.attestation.attestationId}.json`),
      "utf8"
    )
  );
  assert.equal(written.attests, "security-evaluation");
  assert.equal(written.attestedBy.kind, "human");

  const shipped = await run("ship", "--json");
  const shipPayload = parseJsonOutput(shipped);
  assert.equal(
    shipPayload.diagnostics.some((entry) => entry.gate === "security_or_e2e_evaluator"),
    false,
    "the gate this attestation feeds must be satisfied, not merely quieter"
  );

  const again = await run(
    "attest",
    "security-evaluation",
    "--attested-by",
    "dasbl",
    "--verdict",
    "pass",
    "--source",
    THREAT_MODEL_PATH,
    "--json"
  );
  assert.equal(again.exitCode, 0);
  const rerun = parseJsonOutput(again);
  assert.equal(rerun.status, "unchanged");
  assert.equal(rerun.attestation.action, "unchanged");
  assert.equal(rerun.attestation.attestedAt, payload.attestation.attestedAt, "a rerun must not re-date the assertion");
});

test("a rerun that authors a different statement records it, rather than reporting unchanged", async (t) => {
  // `unchanged` used to be decided by the gate's predicate alone — attester,
  // verdict, and "would this still satisfy the gate". `--statement` participates
  // in no gate predicate, which is the entire point of it: it is the human's
  // words, not a machine-checkable fact. So an operator correcting a statement
  // hit every branch of the idempotence check, got exit 0 and `unchanged`, and
  // watched the correction be discarded silently.
  //
  // Satisfying the gate and carrying the authored text are two questions, and
  // `unchanged` is only honest when both answer yes.
  const { root, run, changeId } = await acceptedR3(t);

  const first = await run(
    "attest", "security-evaluation",
    "--attested-by", "dasbl",
    "--verdict", "pass",
    "--source", THREAT_MODEL_PATH,
    "--statement", "First reading of the threat model.",
    "--json"
  );
  assert.equal(first.exitCode, 0, first.stdout + first.stderr);
  const firstPayload = parseJsonOutput(first);
  assert.equal(firstPayload.attestation.action, "record");

  const corrected = await run(
    "attest", "security-evaluation",
    "--attested-by", "dasbl",
    "--verdict", "pass",
    "--source", THREAT_MODEL_PATH,
    "--statement", "Corrected: the canary check was read against the redacted transcript.",
    "--json"
  );
  assert.equal(corrected.exitCode, 0, corrected.stdout + corrected.stderr);
  const correctedPayload = parseJsonOutput(corrected);
  assert.equal(
    correctedPayload.attestation.action,
    "re-record",
    "a changed statement is a changed attestation, however satisfied the gate remains"
  );

  // The assertion that matters: the new words are on disk, not merely reported.
  const written = JSON.parse(
    await readFile(
      path.join(root, ".legion/project/changes", changeId, "attestations", `${correctedPayload.attestation.attestationId}.json`),
      "utf8"
    )
  );
  assert.match(written.statement, /^Corrected: /);

  // And an identical rerun is still `unchanged`, so this does not turn every
  // rerun into a write.
  const again = await run(
    "attest", "security-evaluation",
    "--attested-by", "dasbl",
    "--verdict", "pass",
    "--source", THREAT_MODEL_PATH,
    "--statement", "Corrected: the canary check was read against the redacted transcript.",
    "--json"
  );
  assert.equal(parseJsonOutput(again).attestation.action, "unchanged");
});

test("editing a cited report after the attestation blocks the gate, and the cure is the bytes", async (t) => {
  // The tampering arm, end to end. Without the re-hash, the record would certify
  // whatever the report said on the day it was written and would keep certifying
  // it after somebody edited the file — which is the failure the pin exists to
  // catch, inverted.
  const { root, run } = await acceptedR3(t);

  assert.equal(
    (await run("attest", "security-evaluation", "--attested-by", "dasbl", "--verdict", "pass", "--source", THREAT_MODEL_PATH, "--json"))
      .exitCode,
    0
  );

  const before = parseJsonOutput(await run("ship", "--json"));
  assert.equal(before.diagnostics.some((entry) => entry.gate === "security_or_e2e_evaluator"), false);

  // Edited out of band, to the report that would never have been attestable.
  await writeFile(path.join(root, THREAT_MODEL_PATH), `${JSON.stringify(threatModel({ ok: false }), null, 2)}\n`, "utf8");

  const after = parseJsonOutput(await run("ship", "--json"));
  const gate = after.diagnostics.find((entry) => entry.gate === "security_or_e2e_evaluator");
  assert.notEqual(gate, undefined, "an edited source must never leave this gate satisfied");
  assert.equal(gate.code, "risk_gate_unsatisfied");
  assert.match(gate.message, /whose bytes have changed since the attestation was recorded/);
});

test("an audited waiver is recorded and reaches the ship payload and its human output", async (t) => {
  // The arm with no falsifiable evidence behind it, followed all the way to the
  // operator.
  //
  // A waived gate is `satisfied`, and `shipGateDiagnostics` skips satisfied gates
  // — so without a deliberate echo the quietest thing in a blocked ship payload
  // would be the gate nobody checked. `payload.warnings` alone is not enough
  // either: ship's `human` output renders only traceability warnings, which is a
  // defect that file's own comment already records. Both are asserted here.
  const { run } = await acceptedR3(t);

  const waived = await run(
    "attest",
    "rollback-evidence",
    "--attested-by",
    "dasbl",
    "--verdict",
    "not_applicable",
    "--waiver-reason",
    "This change ships no migration and touches no persisted state, so there is nothing to roll back.",
    "--source",
    ADR_PATH,
    "--json"
  );
  assert.equal(waived.exitCode, 0, waived.stdout + waived.stderr);
  assert.equal(parseJsonOutput(waived).attestation.verdict, "not_applicable");

  const shipped = await run("ship", "--json");
  const payload = parseJsonOutput(shipped);
  assert.equal(
    payload.diagnostics.some((entry) => entry.gate === "rollback_or_forward_fix_evidence"),
    false,
    "the waiver satisfies the gate"
  );
  const warning = payload.warnings.find((entry) => entry.code === "risk_gate_waived");
  assert.notEqual(warning, undefined, "a gate satisfied with nothing checked must not be the quietest row in the payload");
  assert.match(warning.message, /rollback_or_forward_fix_evidence was satisfied by an audited waiver/);
  assert.match(warning.message, /nothing to roll back/);
  assert.match(warning.message, /Nothing was checked for this gate/);
  // Printed, not only recorded: a warning that lived solely in the payload was
  // invisible to exactly the operator who relied on it.
  assert.match(shipped.stdout, /risk_gate_waived|audited waiver/);
});

test("a waiver over a failing report of the check being waived is refused", async (t) => {
  // The one thing an audited waiver must not be able to do: convert a negative
  // result into a satisfied gate with no evidence in between. A waiver states
  // that a check does not apply; a failing report *of that check* is evidence
  // that it did apply and did not pass.
  const { run } = await acceptedR3(t, { ok: false });

  const refused = await run(
    "attest",
    "security-evaluation",
    "--attested-by",
    "dasbl",
    "--verdict",
    "not_applicable",
    "--waiver-reason",
    "We have decided this evaluation does not apply to the current change.",
    "--source",
    THREAT_MODEL_PATH,
    "--json"
  );
  assert.equal(refused.exitCode, 1);
  const payload = parseJsonOutput(refused);
  assert.equal(payload.diagnostics[0].code, "waiver_contradicted_by_source");
  assert.match(payload.diagnostics[0].message, /Waiving a check that ran and failed/);
});

test("a baseline attested after the build warns, cannot pass on evidence, and leaves the waiver as the route out", async (t) => {
  // PR 5's trap reproduced for a new verb, and answered the same way. The record
  // is a true governance fact, so the command writes it — refusing would leave no
  // way to record one at all — but it must not be silent about what it has just
  // made impossible.
  //
  // `legion build` has already run by the time `acceptedR3` returns, which is the
  // normal workflow: ship routes an R3 operator to approve and then to build, and
  // an operator only reaches for a baseline once ship tells them the gate is
  // unmet. That is exactly why the warning exists at the write end and the
  // recovery names re-planning at the read end.
  const { run } = await acceptedR3(t);

  const attested = await run(
    "attest",
    "independent-baseline",
    "--attested-by",
    "dasbl",
    "--verdict",
    "pass",
    "--source",
    ADR_PATH,
    "--json"
  );
  // The pass is refused on its own account first — `independent-baseline` admits
  // only an A/B comparison, and this repository's committed one has an empty
  // baseline side — so the honest record here is `unknown`.
  assert.equal(attested.exitCode, 1);
  assert.equal(parseJsonOutput(attested).diagnostics[0].code, "source_shape_not_admissible");

  const waived = await run(
    "attest",
    "independent-baseline",
    "--attested-by",
    "dasbl",
    "--verdict",
    "not_applicable",
    "--waiver-reason",
    "No sealed baseline corpus covers this change's surface, so no independent baseline applies.",
    "--source",
    ADR_PATH,
    "--json"
  );
  assert.equal(waived.exitCode, 0, waived.stdout + waived.stderr);
  // The warning fires on every baseline verdict rather than only on a pass, and
  // that breadth is what makes it reachable at all: the pass arm additionally
  // requires an A/B comparison with a populated baseline side, which this
  // repository's sealed corpus cannot produce for a change, so a warning narrowed
  // to `pass` would be dead code wearing the name of a safeguard.
  const ordering = parseJsonOutput(waived).warnings.find(
    (entry) => entry.code === "attestation_after_execution"
  );
  assert.notEqual(ordering, undefined, "the operator has to learn the evidence arm is closed");
  assert.match(ordering.message, /no command re-dates an attestation/);
  assert.match(ordering.message, /an audited waiver is the only route out/);

  const payload = parseJsonOutput(await run("ship", "--json"));
  assert.equal(
    payload.diagnostics.some((entry) => entry.gate === "independent_baseline"),
    false,
    "the audited waiver is the route out this gate keeps open after a build"
  );
  const warning = payload.warnings.find((entry) => entry.code === "risk_gate_waived");
  assert.match(warning.message, /independent_baseline was satisfied by an audited waiver/);
});

test("every attestation kind is read by some gate, so the no-reader warning has nothing left to fire on", async (t) => {
  // **This test had no re-point target left, and that is what it now asserts.**
  //
  // It was written to hold one claim: a kind no gate reads is *written* and says
  // so, rather than being refused or succeeding in silence. It named
  // `architecture-review` until that gate gained a producer, then
  // `release-observation` — and this release gives that kind a reader too, so all
  // seven `attestationKindSchema` options are now read by some gate and the
  // warning is unreachable through the CLI.
  //
  // Deleting the test would retire the only assertion that the warning ever
  // fires, and re-pointing it at a kind some gate reads would assert nothing. So
  // the claim is derived from the compiled module instead: the unread set is
  // computed from `GATE_READ_ATTESTATION_KINDS` and asserted empty. Add a kind
  // upstream without a reader and this reddens, which is exactly when the warning
  // becomes reachable again. The warning's own code path is covered directly by
  // the unit assertion below rather than through a CLI run that can no longer
  // produce it.
  const { attestationKindSchema } = await import("../packages/protocol/dist/index.js");
  const { GATE_READ_ATTESTATION_KINDS } = await import("../packages/cli/dist/workflow/ship-gates.js");
  const unread = attestationKindSchema.options.filter((kind) => !GATE_READ_ATTESTATION_KINDS.has(kind));
  assert.deepEqual(unread, [], "a kind with no reader is recordable and moves nothing; none is left");
  assert.equal(GATE_READ_ATTESTATION_KINDS.size, attestationKindSchema.options.length);

  // And the kind that was the stand-in until this release now moves the gate that
  // reads it — through the artifact route, which is the one the gate prefers. The
  // waiver route is asserted end to end in tests/cli-release-plan.
  const { run } = await acceptedR3(t);
  const attested = await run(
    "attest",
    "release-observation",
    "--attested-by",
    "dasbl",
    "--verdict",
    "unknown",
    "--source",
    ADR_PATH,
    "--json"
  );
  assert.equal(attested.exitCode, 0, attested.stdout + attested.stderr);
  const payload = parseJsonOutput(attested);
  assert.equal(payload.status, "attested");
  assert.equal(payload.warnings, undefined, "the kind has a reader now, so no no-reader warning is due");

  // An `unknown` verdict asserts nothing, so the gate stays unmet — and it says
  // what is missing rather than that Legion cannot answer it.
  const shipPayload = parseJsonOutput(await run("ship", "--json"));
  const row = shipPayload.diagnostics.find((entry) => entry.gate === "release_observation_plan");
  assert.notEqual(row, undefined);
  assert.doesNotMatch(row.message, /does not yet produce/);
  assert.match(row.message, /No release plan is recorded for change chg_/);
});

test("an architecture-review pass is recorded on a person's sentence, and refused without one", async (t) => {
  // **The third admissibility state, driven end to end through the real CLI.**
  //
  // Under the previous encoding this kind shared the empty-shape list with
  // `e2e-evaluation`, and both ends read that as a positive refusal: `legion
  // attest architecture-review --verdict pass` exited 1, while `--verdict
  // not_applicable --waiver-reason <text>` satisfied the same gate. An operator
  // who genuinely held an architecture review in a PR thread was told to record
  // that no architecture review applied — a gate that punishes an accurate answer,
  // which is the defect `GATE_SCOPE`'s own comment names one gate over.
  //
  // What the arm gives up is asserted rather than described. There is no report to
  // read, so the record's whole content is the attester's sentence: the pass needs
  // an authored `--statement`, and `legion ship` echoes it as a distinct warning
  // on a gate that would otherwise emit nothing at all.
  const { run } = await acceptedR3(t);

  const bare = await run(
    "attest",
    "architecture-review",
    "--attested-by",
    "dasbl",
    "--verdict",
    "pass",
    "--source",
    ADR_PATH,
    "--json"
  );
  assert.equal(bare.exitCode, 1, "a pass carrying a statement Legion wrote asserts nothing anybody said");
  const barePayload = parseJsonOutput(bare);
  assert.equal(barePayload.diagnostics[0].code, "judgement_requires_statement");
  assert.match(barePayload.diagnostics[0].message, /requires --statement/);

  const attested = await run(
    "attest",
    "architecture-review",
    "--attested-by",
    "dasbl",
    "--verdict",
    "pass",
    "--statement",
    "The pricing boundary was reviewed against ADR-006 and introduces no new coupling.",
    "--source",
    ADR_PATH,
    "--json"
  );
  assert.equal(attested.exitCode, 0, attested.stdout + attested.stderr);
  const payload = parseJsonOutput(attested);
  assert.equal(payload.status, "attested");
  // The kind now has a reader, so the stale warning is gone — computed from the
  // gate module's own set rather than from a second list.
  assert.equal(
    (payload.warnings ?? []).some((entry) => entry.code === "attestation_kind_has_no_reader"),
    false
  );

  const shipPayload = parseJsonOutput(await run("ship", "--json"));
  assert.equal(
    shipPayload.diagnostics.some((entry) => entry.gate === "architecture_or_security_review"),
    false,
    "a pin-clean pass by a named human is the attestation route this gate keeps open"
  );
  const judgement = shipPayload.warnings.find((entry) => entry.code === "risk_gate_human_judgement");
  assert.notEqual(judgement, undefined, "a satisfied gate emits no diagnostic, so this arm has to warn");
  assert.match(judgement.message, /satisfied by a recorded human judgement/);
  assert.match(judgement.message, /no new coupling/);
});

test("an unpinnable source is refused by name, and no identity is invented", async (t) => {
  // Two refusals that would each be a quiet fail-open. A source that cannot be
  // pinned through the resolver `legion ship` verifies with would be reported as
  // unchecked forever with nothing naming the cause; and an attester resolved from
  // anywhere but the project manifest is exactly the defaulted identity this
  // artifact exists to replace.
  const { run } = await acceptedR3(t);

  const missing = await run(
    "attest",
    "security-evaluation",
    "--attested-by",
    "dasbl",
    "--verdict",
    "unknown",
    "--source",
    "evidence/does-not-exist.json",
    "--json"
  );
  assert.equal(missing.exitCode, 1);
  const missingPayload = parseJsonOutput(missing);
  assert.equal(missingPayload.diagnostics[0].code, "source_unpinnable");
  assert.match(missingPayload.diagnostics[0].message, /evidence\/does-not-exist\.json/);

  const unknownAttester = await run(
    "attest",
    "security-evaluation",
    "--attested-by",
    "somebody-else",
    "--verdict",
    "unknown",
    "--source",
    ADR_PATH,
    "--json"
  );
  assert.equal(unknownAttester.exitCode, 1);
  assert.equal(parseJsonOutput(unknownAttester).diagnostics[0].code, "approver_unknown");

  const noAttester = await run("attest", "security-evaluation", "--verdict", "unknown", "--source", ADR_PATH, "--json");
  assert.equal(noAttester.exitCode, 1);
  assert.equal(parseJsonOutput(noAttester).diagnostics[0].code, "attester_required");
});

test("--source is repeatable, and a second value does not replace the first", async (t) => {
  // `parseCliArgs` stores options in a Map, so before this release a second
  // `--source` silently replaced the first and the command would have recorded an
  // attestation citing one file when the operator named two. Comma-splitting was
  // refused as a fix: a comma is a legal filename character on every platform
  // Legion runs on, so the split would be wrong rather than merely redundant.
  const { run } = await acceptedR3(t);

  const attested = await run(
    "attest",
    "security-evaluation",
    "--attested-by",
    "dasbl",
    "--verdict",
    "pass",
    "--source",
    THREAT_MODEL_PATH,
    "--source",
    ADR_PATH,
    "--json"
  );
  assert.equal(attested.exitCode, 0, attested.stdout + attested.stderr);
  const payload = parseJsonOutput(attested);
  assert.deepEqual(
    payload.attestation.sources.map((source) => source.path).sort(),
    [ADR_PATH, THREAT_MODEL_PATH].sort()
  );
});

test("a green report of the wrong shape for the kind is refused, at the writer as well as the reader", async (t) => {
  // **The per-kind admissibility matrix, held at the end that shipped without an
  // assertion.** `ADMISSIBLE_SOURCE_SHAPES` is the only thing stopping `legion
  // attest rollback-evidence --source <a clean threat model> --verdict pass` from
  // satisfying the rollback gate off a security report, and the conjunct that
  // enforces it survived deletion at both the writer and the reader with the whole
  // suite green — every other scenario in the tree happens to cite the right
  // shape for its kind.
  //
  // A hash pin proves which bytes were meant; it does not prove what they say,
  // and "some recognised report in this repository is green" is not an answer to
  // the question a particular gate asks.
  const { run } = await acceptedR3(t);

  const refused = await run(
    "attest",
    "rollback-evidence",
    "--attested-by",
    "dasbl",
    "--verdict",
    "pass",
    "--source",
    THREAT_MODEL_PATH,
    "--json"
  );
  assert.equal(refused.exitCode, 1, refused.stdout + refused.stderr);
  const payload = parseJsonOutput(refused);
  assert.equal(payload.diagnostics[0].code, "source_shape_not_admissible");
  assert.match(payload.diagnostics[0].message, /needs at least one source that is a rollback-policy report/);
  assert.match(payload.diagnostics[0].message, /threat-model \(clean\)/);

  // Nothing was written, so the gate is still absent rather than refused.
  const ship = parseJsonOutput(await run("ship", "--json"));
  const gate = ship.diagnostics.find((entry) => entry.gate === "rollback_or_forward_fix_evidence");
  assert.equal(gate.code, "risk_gate_unevaluable");
  assert.match(gate.message, /No attestation records anyone asserting/);
});

test("a rollback verdict taken in another checkout is refused, and one taken here satisfies the gate", async (t) => {
  // **The laundering that made `rollback_or_forward_fix_evidence` satisfiable off
  // the shelf.** `rollback-policy.mjs` takes `--repository-root`, records it, and
  // raises the blocking `manifest_repository_root_match` when the audited
  // manifest disagrees with it — so a verdict is a statement about one filesystem
  // tree, and the same audit re-run against a different tree is `ok: false`.
  //
  // Nothing read that field. This repository's own committed
  // `docs/next/evidence/P13-T03/rollback-policy.json` — which the CLI's help text
  // recommended by name — was taken in a macOS temp directory whose own finding
  // reports there is no `.legion` there at all, and copying it into a change's
  // worktree satisfied this gate. It was green *because* the audit ran somewhere
  // else, and any other checkout's report, or one produced against a scratch
  // directory holding a hand-made manifest, laundered identically.
  //
  // Both halves are asserted, because a scoping rule that refuses everything is
  // not a scoping rule.
  const { root, run } = await acceptedR3(t);
  const FOREIGN = "evidence/rollback-elsewhere.json";
  const LOCAL = "evidence/rollback-policy.json";
  await writeFile(
    path.join(root, FOREIGN),
    `${JSON.stringify(rollbackPolicy({ repositoryRoot: "/var/folders/3h/0b2xvsws05g5/T/tmpamcjw11f" }), null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(root, LOCAL),
    `${JSON.stringify(rollbackPolicy({ repositoryRoot: root }), null, 2)}\n`,
    "utf8"
  );

  const refused = await run(
    "attest",
    "rollback-evidence",
    "--attested-by",
    "dasbl",
    "--verdict",
    "pass",
    "--source",
    FOREIGN,
    "--json"
  );
  assert.equal(refused.exitCode, 1, refused.stdout + refused.stderr);
  const diagnostic = parseJsonOutput(refused).diagnostics[0];
  assert.equal(diagnostic.code, "source_contradicts_verdict");
  assert.match(diagnostic.message, /not the repository being shipped/);

  const attested = await run(
    "attest",
    "rollback-evidence",
    "--attested-by",
    "dasbl",
    "--verdict",
    "pass",
    "--source",
    LOCAL,
    "--json"
  );
  assert.equal(attested.exitCode, 0, attested.stdout + attested.stderr);
  assert.deepEqual(parseJsonOutput(attested).attestation.sourceShapes, ["rollback-policy (clean)"]);

  const ship = parseJsonOutput(await run("ship", "--json"));
  assert.equal(
    ship.diagnostics.some((entry) => entry.gate === "rollback_or_forward_fix_evidence"),
    false,
    `a rollback verdict taken in this very repository must satisfy this gate: ${JSON.stringify(
      ship.diagnostics.find((entry) => entry.gate === "rollback_or_forward_fix_evidence")
    )}`
  );
});

test("both kinds one gate accepts can be recorded, and the unfavourable one is not buried", async (t) => {
  // **Two attestations of the two kinds one gate reads is the normal state, and
  // the gate treated it as corruption.** `legion attest` derives an id from
  // `(changeId, attests)`, so recording a `security-evaluation` and then an
  // `e2e-evaluation` writes two distinct files that both belong to
  // `security_or_e2e_evaluator`. Counting them together collapsed a satisfied
  // gate to `unevaluable` and advised deleting a real governance record — and in
  // the worst direction it turned a recorded `fail` into "unestablished", the
  // exact inversion the one-per-kind rule was written to prevent.
  const { run } = await acceptedR3(t);

  const security = await run(
    "attest", "security-evaluation", "--attested-by", "dasbl",
    "--verdict", "pass", "--source", THREAT_MODEL_PATH, "--json"
  );
  assert.equal(security.exitCode, 0, security.stdout + security.stderr);
  const before = parseJsonOutput(await run("ship", "--json"));
  assert.equal(before.diagnostics.some((entry) => entry.gate === "security_or_e2e_evaluator"), false);

  // A second, honest record of the other kind this gate reads. It moves nothing,
  // and it must not unmake what is already established.
  const e2e = await run(
    "attest", "e2e-evaluation", "--attested-by", "dasbl",
    "--verdict", "unknown", "--source", ADR_PATH, "--json"
  );
  assert.equal(e2e.exitCode, 0, e2e.stdout + e2e.stderr);

  const after = parseJsonOutput(await run("ship", "--json"));
  const gate = after.diagnostics.find((entry) => entry.gate === "security_or_e2e_evaluator");
  assert.equal(gate, undefined, `the second kind must not unmake the first: ${JSON.stringify(gate)}`);
});

test("a waiver with no substantive reason is refused", async (t) => {
  // The audited waiver is the path an operator under deadline pressure reaches
  // for, and ADR-006's requirement is a reason a reviewer can disagree with. A
  // single word is not one.
  const { run } = await acceptedR3(t);

  const refused = await run(
    "attest",
    "rollback-evidence",
    "--attested-by",
    "dasbl",
    "--verdict",
    "not_applicable",
    "--waiver-reason",
    "n/a",
    "--source",
    ADR_PATH,
    "--json"
  );
  assert.equal(refused.exitCode, 1);
  assert.equal(parseJsonOutput(refused).diagnostics[0].code, "waiver_requires_reason");
});
