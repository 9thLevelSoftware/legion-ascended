import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  listAttestationsForChange,
  readAttestation,
  writeAttestation
} from "../packages/artifacts/dist/index.js";
import { attestationSchema } from "../packages/protocol/dist/index.js";

/**
 * The attestation plane: one document per change per kind, and a listing that
 * says when it dropped one.
 *
 * The service is a structural copy of the approvals service and every part of it
 * has the same reason, with one sharpened. An approval file can be re-decided in
 * place, so a dropped one drops whatever decision stood. An attestation file is
 * *only ever* the current verdict for its kind — the id is derived from the
 * change and the kind, so retaking an assertion overwrites rather than
 * accumulates — which means a dropped file is exactly as likely to hold a `fail`
 * or a `not_applicable` as a `pass`. `skipped` is how the listing says so, and
 * `legion ship` turns any skip into whole-plane absence.
 */

const CHANGE_ID = "chg_attestation-plane";
const PROJECT_ID = "prj_attestation-plane";
const NOW = "2026-08-06T09:00:00.000Z";

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-attestations-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

function attestation(overrides = {}) {
  return {
    schemaVersion: "0.2.0",
    createdAt: NOW,
    kind: "attestation",
    id: "att_attestation-plane-attestation-security-evaluation",
    projectId: PROJECT_ID,
    changeId: CHANGE_ID,
    attests: "security-evaluation",
    verdict: "pass",
    attestedBy: { kind: "human", id: "dasbl" },
    attestedAt: NOW,
    sources: [{ path: "docs/next/evidence/P13-T02/threat-model.json", sha256: `sha256:${"a".repeat(64)}` }],
    covers: [{ kind: "task", id: "tsk_attestation-plane-c1" }],
    statement: "dasbl attests security-evaluation as pass.",
    ...overrides
  };
}

test("an attestation round-trips through the revisioned artifact writer", async (t) => {
  const root = await workspace(t);

  const created = await writeAttestation({ repositoryRoot: root, document: attestation() });
  assert.equal(created.ok, true, JSON.stringify(created.diagnostics));
  assert.equal(created.status, "created");
  assert.equal(
    created.artifactPath,
    `.legion/project/changes/${CHANGE_ID}/attestations/att_attestation-plane-attestation-security-evaluation.json`
  );

  const read = await readAttestation({
    repositoryRoot: root,
    changeId: CHANGE_ID,
    attestationId: created.document.id
  });
  assert.equal(read.ok, true);
  assert.equal(read.document.attests, "security-evaluation");
  assert.equal(read.document.verdict, "pass");
  assert.equal(read.revision.revision, 1);
});

test("retaking an assertion replaces it in place rather than accumulating a sibling", async (t) => {
  // The storage model *is* the safety property here, which is why it has a test
  // of its own. Every gate that reads this plane asks an existential — "a `pass`
  // attestation of the right kind whose sources hash clean" — and an existential
  // over a set that can grow means Monday's `pass` outlives Tuesday's `fail` and
  // the negative is never seen. Approvals bought that back with a strictly-later
  // supersession rule over `decidedAt`; an attestation has no status lattice and
  // no ordered decision field to build one on, so the storage model has to carry
  // it. This asserts that it does: one path, one document, and the `fail`
  // genuinely displaces the `pass`.
  const root = await workspace(t);

  const first = await writeAttestation({ repositoryRoot: root, document: attestation() });
  assert.equal(first.ok, true);

  const second = await writeAttestation({
    repositoryRoot: root,
    expectedRevision: first.revision.revision,
    document: attestation({ verdict: "fail", statement: "The evaluation failed." })
  });
  assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
  assert.equal(second.status, "updated");
  assert.equal(second.artifactPath, first.artifactPath);

  const listing = await listAttestationsForChange({ repositoryRoot: root, changeId: CHANGE_ID });
  assert.equal(listing.ok, true);
  assert.equal(listing.attestations.length, 1, "a retaken assertion must not leave the old one on disk");
  assert.equal(listing.attestations[0].document.verdict, "fail");
});

test("a stale expected revision is a conflict, not a silent overwrite", async (t) => {
  const root = await workspace(t);
  const first = await writeAttestation({ repositoryRoot: root, document: attestation() });
  assert.equal(first.ok, true);

  const stale = await writeAttestation({
    repositoryRoot: root,
    expectedRevision: 7,
    document: attestation({ verdict: "fail", statement: "The evaluation failed." })
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, "conflict");
  assert.equal(stale.diagnostics[0].code, "revision_conflict");
});

test("a document whose change or id disagrees with the request is refused, not returned", async (t) => {
  // The read path is what `listAttestationsForChange` is built on, so a mismatch
  // it tolerated would put a document about one change into another change's
  // plane — where the gate's strict change-id equality check is the only other
  // thing that would catch it.
  const root = await workspace(t);
  const created = await writeAttestation({ repositoryRoot: root, document: attestation() });
  assert.equal(created.ok, true);

  const misfiled = path.join(
    root,
    ".legion/project/changes/chg_some-other-change/attestations",
    "att_attestation-plane-attestation-security-evaluation.json"
  );
  await mkdir(path.dirname(misfiled), { recursive: true });
  await writeFile(misfiled, JSON.stringify(attestation()), "utf8");

  const read = await readAttestation({
    repositoryRoot: root,
    changeId: "chg_some-other-change",
    attestationId: "att_attestation-plane-attestation-security-evaluation"
  });
  assert.equal(read.ok, false);
  assert.equal(read.status, "invalid");
  assert.equal(read.diagnostics[0].code, "attestation_change_mismatch");
});

test("a directory entry the listing cannot read is reported as skipped, not dropped", async (t) => {
  // Platform-neutral by construction: a directory and a wrongly-named file, never
  // a permission bit. The chmod/attrib pattern an earlier release reached for is
  // not repeatable here — it behaves differently on Windows, and a test that only
  // fails on one platform is a test that gets deleted.
  //
  // The defect this exists for: `completeAttestations` refuses to answer from a
  // partial listing, and it can only do that if the listing tells it. A `.DS_Store`
  // or an editor swap file that vanished from the listing in silence would collapse
  // nothing and would leave a gate answering from records it could not know were
  // incomplete.
  const root = await workspace(t);
  const created = await writeAttestation({ repositoryRoot: root, document: attestation() });
  assert.equal(created.ok, true);

  const plane = path.join(root, ".legion/project/changes", CHANGE_ID, "attestations");
  await mkdir(path.join(plane, "a-directory.json"), { recursive: true });
  await writeFile(path.join(plane, "not-an-attestation-id.json"), "{}", "utf8");
  await writeFile(path.join(plane, "notes.txt"), "scratch", "utf8");

  const listing = await listAttestationsForChange({ repositoryRoot: root, changeId: CHANGE_ID });
  assert.equal(listing.ok, true);
  assert.equal(listing.attestations.length, 1);
  assert.deepEqual([...listing.skipped].sort(), ["a-directory.json", "not-an-attestation-id.json", "notes.txt"]);
});

test("a change with no attestations directory reads as empty and readable, not as a failure", async (t) => {
  // `[]` and `undefined` are different facts and the caller spells them
  // differently: "the plane was read and this change has attested nothing" is
  // `unevaluable` for its own reason, and "the plane would not read" is
  // `unevaluable` for another. Collapsing them would make every change written
  // before this release look like a broken one.
  const root = await workspace(t);
  const listing = await listAttestationsForChange({ repositoryRoot: root, changeId: CHANGE_ID });
  assert.equal(listing.ok, true);
  assert.deepEqual(listing.attestations, []);
  assert.deepEqual(listing.skipped, []);
});

test("a not_applicable attestation requires a waiver reason and a human attester", () => {
  // The audited waiver is the one arm in all three attestation gates that
  // satisfies with no falsifiable evidence behind it, so both of its conditions
  // are schema invariants rather than checks somebody has to remember. ADR-006
  // permits a waived gate only as an audited waiver: a named human, a recorded
  // time, and a reason a reviewer can disagree with.
  const noReason = attestationSchema.safeParse(attestation({ verdict: "not_applicable" }));
  assert.equal(noReason.success, false);
  assert.match(JSON.stringify(noReason.error.issues), /audited waiver/);

  const machineWaiver = attestationSchema.safeParse(
    attestation({
      verdict: "not_applicable",
      attestedBy: { kind: "tool", id: "legion-cli" },
      waiverReason: "This change ships no migration, so there is nothing to roll back."
    })
  );
  assert.equal(machineWaiver.success, false);
  assert.match(JSON.stringify(machineWaiver.error.issues), /must be made by a human/);

  const tooShort = attestationSchema.safeParse(
    attestation({ verdict: "not_applicable", waiverReason: "n/a" })
  );
  assert.equal(tooShort.success, false);

  const good = attestationSchema.safeParse(
    attestation({
      verdict: "not_applicable",
      waiverReason: "This change ships no migration and touches no persisted state."
    })
  );
  assert.equal(good.success, true, JSON.stringify(good.error?.issues));
});

test("a waiver reason on any other verdict is refused", () => {
  // The converse, and it is not symmetry for its own sake: a waiver sentence
  // sitting on a `fail` reads as a waiver *of that failure* to anything rendering
  // the record, and `legion ship` renders it.
  const parsed = attestationSchema.safeParse(
    attestation({ verdict: "fail", waiverReason: "This does not really apply to us anyway." })
  );
  assert.equal(parsed.success, false);
  assert.match(JSON.stringify(parsed.error.issues), /only meaningful on a not_applicable/);
});

test("empty and duplicated collections are refused at the schema", () => {
  // Lesson five, closed at the shape rather than in each of three gates. An empty
  // `sources` passes every pin check vacuously and an empty `covers` passes every
  // coverage check vacuously; a path pinned twice asserts two truths about the
  // same bytes. The gates keep their own guards anyway, because a gate must not
  // inherit its central truth claim from another module's invariant — but the
  // honest refusal is here.
  assert.equal(attestationSchema.safeParse(attestation({ sources: [] })).success, false);
  assert.equal(attestationSchema.safeParse(attestation({ covers: [] })).success, false);

  const duplicated = attestationSchema.safeParse(
    attestation({
      sources: [
        { path: "docs/a.json", sha256: `sha256:${"a".repeat(64)}` },
        { path: "docs/a.json", sha256: `sha256:${"b".repeat(64)}` }
      ]
    })
  );
  assert.equal(duplicated.success, false);
  assert.match(JSON.stringify(duplicated.error.issues), /pin a source path only once/);
});

test("an attestedAt earlier than the record's own creation is refused", () => {
  const parsed = attestationSchema.safeParse(attestation({ attestedAt: "2026-08-05T09:00:00.000Z" }));
  assert.equal(parsed.success, false);
  assert.match(JSON.stringify(parsed.error.issues), /attestedAt cannot be before createdAt/);
});

test("a single long token is not a waiver reason, however many characters it is", () => {
  // A raw character floor made the CLI refusal's own sentence — "A single word is
  // not a reason" — false: `--waiver-reason aaaaaaaaaaaaaaaaaaaaaaaaaa` was
  // accepted, satisfied an R3 risk gate, and was quoted verbatim into ship's
  // `risk_gate_waived` warning and its human output. The audited waiver is the one
  // `satisfied` verdict in all three attestation gates with no falsifiable
  // evidence behind it, so the one thing it has to carry is a sentence a reviewer
  // can disagree with.
  const single = attestationSchema.safeParse(
    attestation({
      verdict: "not_applicable",
      attestedBy: { kind: "human", id: "dasbl" },
      waiverReason: "a".repeat(40)
    })
  );
  assert.equal(single.success, false);
  assert.match(JSON.stringify(single.error.issues), /more than one word/);

  // The control, so this is a statement about tokens rather than about the waiver
  // arm refusing everything.
  assert.equal(
    attestationSchema.safeParse(
      attestation({
        verdict: "not_applicable",
        attestedBy: { kind: "human", id: "dasbl" },
        waiverReason: "This change ships no migration and touches no persisted state."
      })
    ).success,
    true
  );
});
