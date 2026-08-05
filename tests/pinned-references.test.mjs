import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { hashContent } from "../packages/artifacts/dist/revisions.js";
import { resolvePinnedReferences } from "../packages/cli/dist/workflow/pinned-references.js";

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-pins-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return root;
}

async function writeArtifact(root, artifactPath, content) {
  const absolute = path.join(root, ...artifactPath.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  return { path: artifactPath, sha256: hashContent(content) };
}

test("a pin over unmodified bytes matches, and one byte of drift does not", async (t) => {
  // A gate that reads an approval without re-hashing what it approved certifies
  // the approval, not the artifact: the delta spec or oracle can be edited
  // afterwards and the gate still passes. This is the check that makes the
  // difference visible, so it has to be able to see both answers.
  const root = await workspace(t);
  const clean = await writeArtifact(root, ".legion/project/changes/chg_x/delta/req.md", "# spec\n");
  const stale = { path: clean.path, sha256: hashContent("# something else\n") };

  const verify = await resolvePinnedReferences({ repositoryRoot: root, references: [clean, stale] });

  assert.equal(verify(clean), "match");
  assert.equal(verify(stale), "drift");
});

test("line endings are not normalized before hashing", async (t) => {
  // Every pin in the tree is minted by `artifactReferenceForContent`, which
  // hashes raw bytes. The requirements service has a private helper that
  // normalizes CRLF first; adopting its semantics here would disagree with every
  // stored pin on a Windows checkout, so a clean artifact would report drift and
  // the gates built on this would block on nothing.
  const root = await workspace(t);
  const crlf = await writeArtifact(root, ".legion/project/changes/chg_x/delta/req.md", "line one\r\nline two\r\n");
  const normalized = { path: crlf.path, sha256: hashContent("line one\nline two\n") };

  const verify = await resolvePinnedReferences({ repositoryRoot: root, references: [crlf, normalized] });

  assert.equal(verify(crlf), "match");
  assert.equal(verify(normalized), "drift");
});

test("a pinned file that is gone reports missing, not unverified", async (t) => {
  // A pin asserts the file existed at that digest, so its absence is a negative
  // answer rather than an absent one. Reporting it as unverified would turn a
  // deleted approved artifact into "not checked", which a gate treats as
  // unevaluable and an operator reads as a gap in Legion rather than a defect in
  // the change.
  const root = await workspace(t);
  const reference = { path: ".legion/project/changes/chg_x/oracle/orc_a.yaml", sha256: hashContent("gone\n") };

  const verify = await resolvePinnedReferences({ repositoryRoot: root, references: [reference] });

  assert.equal(verify(reference), "missing");
});

test("a reference nobody resolved is unverified, not missing and not clean", async (t) => {
  // The verifier is pre-resolved because hashing is I/O and the gate evaluator
  // is synchronous, so a gate can ask about a reference no collector gathered.
  // Answering "missing" would report that a file sitting right there is gone;
  // answering "match" would pass a gate on a pin nobody checked. Both are wrong
  // in a way that only shows up once a gate depends on it.
  const root = await workspace(t);
  const collected = await writeArtifact(root, ".legion/project/changes/chg_x/delta/req.md", "# spec\n");
  const present = await writeArtifact(root, ".legion/project/changes/chg_x/delta/other.md", "# other\n");

  const verify = await resolvePinnedReferences({ repositoryRoot: root, references: [collected] });

  assert.equal(verify(collected), "match");
  assert.equal(verify(present), "unverified");
});

test("a pin outside .legion/project, with uppercase in its path, is still verified", async (t) => {
  // The project artifact resolver throws for any path outside `.legion/project`
  // and for any uppercase character. Pinned references are not limited to
  // project artifacts — a verification surface or an attestation pins ordinary
  // repository files such as docs/next/evidence/P13-T02/threat-model.json, which
  // the artifact-path schema accepts and that resolver refuses. Built on it,
  // `legion ship` would throw on the very pins it exists to check.
  const root = await workspace(t);
  const reference = await writeArtifact(root, "docs/next/evidence/P13-T02/threat-model.json", '{"ok":true}\n');

  const verify = await resolvePinnedReferences({ repositoryRoot: root, references: [reference] });

  assert.equal(verify(reference), "match");
});

test("a path that is not a readable file answers rather than throwing", async (t) => {
  // `legion ship` reports; it does not write and it must not die. A read that
  // fails for anything other than absence is a read that failed, not an artifact
  // that is gone, so it reports unverified — and, either way, it reports.
  const root = await workspace(t);
  await mkdir(path.join(root, ".legion", "project", "changes", "chg_x", "oracle"), { recursive: true });
  const directory = {
    path: ".legion/project/changes/chg_x/oracle",
    sha256: hashContent("whatever\n")
  };

  const verify = await resolvePinnedReferences({ repositoryRoot: root, references: [directory] });

  assert.equal(verify(directory), "unverified");
});

test("a pinned path containing ':' is refused rather than hashed", async (t) => {
  // `artifactPathSchema` permits ':' inside a segment — it only refuses a
  // leading drive letter — so `docs/notes.md:approved` parses as a valid
  // reference. On Windows that names an NTFS alternate data stream: bytes
  // attached to `docs/notes.md` that git does not track and no reviewer sees.
  // Hashing them reports the approved artifact clean while the tracked file at
  // the same path says something else, which is this module's own defect
  // inverted. The project path resolver refuses ':' for exactly this reason, and
  // this module dropped that resolver deliberately; the refusal has to come back
  // with it.
  //
  // On a filesystem with no stream syntax the same write creates an ordinary
  // sibling file, so the pin would verify against bytes at a path git does track
  // under a different name. Either way the reference is refused, which is why
  // the check is not conditioned on the platform.
  const root = await workspace(t);
  const visible = await writeArtifact(root, "docs/notes.md", "VISIBLE-TAMPERED\n");
  const approvedBytes = "APPROVED-BYTES\n";
  await writeFile(path.join(root, "docs", "notes.md:approved"), approvedBytes);

  const streamReference = { path: "docs/notes.md:approved", sha256: hashContent(approvedBytes) };
  const staleVisible = { path: visible.path, sha256: hashContent(approvedBytes) };

  const verify = await resolvePinnedReferences({
    repositoryRoot: root,
    references: [streamReference, staleVisible]
  });

  assert.equal(verify(streamReference), "unverified");
  // And the pin on the path git actually tracks still reports the tampering.
  assert.equal(verify(staleVisible), "drift");
});

test("a pin that differs from the stored file only by letter case is refused", async (t) => {
  // The project resolver refuses uppercase outright; this module cannot, because
  // real pins name docs/next/evidence/P13-T02/threat-model.json. The equivalent
  // defence is applied to the resolved location instead: `realpath` returns the
  // casing the filesystem stores, so a declared path that case-folds onto a
  // differently-cased file is visible here and nowhere else. It matters because
  // a repository can carry `docs/NOTES.md` and `docs/notes.md` as two tracked
  // files on Linux and only one after a Windows checkout, at which point a pin on
  // the one that did not survive silently verifies the one that did.
  //
  // The verdict differs by platform and both are correct: a case-insensitive
  // filesystem opens the survivor and this refuses it as an alias; a
  // case-sensitive one never finds the file at all. What must not happen is
  // "match".
  const root = await workspace(t);
  const stored = await writeArtifact(root, "docs/next/evidence/P13-T02/threat-model.json", '{"ok":true}\n');
  const folded = { path: "docs/next/evidence/p13-t02/threat-model.json", sha256: stored.sha256 };

  const verify = await resolvePinnedReferences({ repositoryRoot: root, references: [stored, folded] });

  assert.equal(verify(stored), "match");
  assert.notEqual(verify(folded), "match");
  assert.ok(["unverified", "missing"].includes(verify(folded)), verify(folded));
});

test("a pin whose path leaves the repository through a symlink is refused", async (t) => {
  // The artifact-path regex refuses `..` segments and absolute paths, but it
  // cannot refuse a symlink whose target sits outside the repository — and a pin
  // read through such a link hashes bytes the repository does not contain, so a
  // gate could be satisfied by content that is not in the change. Containment is
  // therefore checked after `realpath`, on the resolved location. Nothing else in
  // this suite supplies an escaping reference, so without this the guard and its
  // comment describe a defence no test can see.
  const root = await workspace(t);
  const outside = await mkdtemp(path.join(tmpdir(), "legion-pins-outside-"));
  t.after(async () => {
    await rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const secretBytes = "outside the repository\n";
  await writeFile(path.join(outside, "secret.md"), secretBytes);

  await mkdir(path.join(root, ".legion", "project", "changes", "chg_x", "delta"), { recursive: true });
  const link = path.join(root, ".legion", "project", "changes", "chg_x", "delta", "req.md");
  try {
    await symlink(path.join(outside, "secret.md"), link, "file");
  } catch (error) {
    // Creating a symlink needs a privilege Windows does not grant by default.
    // Skipping is honest; asserting nothing would be a green test that never ran.
    t.skip(`symlinks unavailable: ${error.code ?? error.message}`);
    return;
  }

  const reference = {
    path: ".legion/project/changes/chg_x/delta/req.md",
    sha256: hashContent(secretBytes)
  };
  const verify = await resolvePinnedReferences({ repositoryRoot: root, references: [reference] });

  assert.equal(verify(reference), "unverified");
});

test("a reference is answered from the bytes read when it was resolved", async (t) => {
  // Change-scoped gates are evaluated once per task, so the same reference is
  // asked about repeatedly. Re-reading per question would make one report a mix
  // of moments rather than a snapshot of one, and a file edited mid-run would
  // produce a report that disagrees with itself.
  //
  // Named for what it proves. It was called "references sharing a path are read
  // once", which it does not test: nothing here counts reads, and deleting the
  // `resolved.has` short-circuit leaves this file entirely green. The dedup is a
  // performance property with no witness; the snapshot is the correctness one and
  // this is it.
  const root = await workspace(t);
  const reference = await writeArtifact(root, ".legion/project/changes/chg_x/delta/req.md", "# spec\n");

  const verify = await resolvePinnedReferences({
    repositoryRoot: root,
    references: [reference, { ...reference }, { ...reference }]
  });

  await writeFile(path.join(root, ".legion", "project", "changes", "chg_x", "delta", "req.md"), "# edited\n");

  assert.equal(verify(reference), "match");
});
