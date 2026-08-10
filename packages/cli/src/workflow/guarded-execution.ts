import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { LEGION_PROJECT_ROOT } from "@legion/artifacts";
import { artifactPathSchema, type GitSha, type TaskContract } from "@legion/protocol";

import {
  observeWorkingTreeDiff,
  pathIsCoveredBy,
  reconcileTaskDiff,
  type DiffObservation,
  type ReconciliationResult
} from "./diff-reconciliation.js";
import { listProjectFiles } from "./project-files.js";
import type { ExecutionResult } from "./executor/types.js";

/**
 * The single path through which a writable executor may be dispatched.
 *
 * `legion build` and `legion review --auto` both run executors that can modify
 * the repository, and each had its own dispatch code. Enforcement was added to
 * one, so the other stayed an unguarded door for several review rounds. The
 * lesson was not "harden the other path" but "stop having two": a guarantee
 * added here applies everywhere, and a new caller cannot opt out by not knowing
 * the rules.
 *
 * Guarantees, in order:
 *
 *  1. The base SHA is supplied by the caller and used throughout, so evidence,
 *     snapshot and reconciliation all describe one revision.
 *  2. Protected files are captured by content before dispatch. Control
 *     artifacts are written by `plan` after the last commit and are routinely
 *     untracked, so restoring them from git would roll a dirty artifact back to
 *     stale content and delete an untracked one outright.
 *  3. Dispatch and `afterRun` are wrapped, so a run that throws after writing is
 *     still reconciled and contained.
 *  4. The control-artifact prohibition runs independently of
 *     `completion.diffReconciliation`. It is a harness invariant; a contract
 *     able to switch it off with a flag would not be constrained by it.
 *  5. Containment covers the index as well as the working tree, and never
 *     writes through a symlink an executor may have left behind.
 *  6. Declared **acceptance paths** are captured by content before dispatch and
 *     compared after, and that observation is *reported only*. It restores
 *     nothing, it contributes no reason, and it cannot make `inContract` false.
 *     This is deliberately not guarantee 4 and the distinction is the whole point
 *     of the separation: a control artifact may never be touched, so the harness
 *     rolls it back; an acceptance test may legitimately be *added* by the task
 *     it belongs to, so the harness reports and the `protected_acceptance_tests`
 *     ship gate — which can read the approval plane, and this cannot — decides.
 *     The two populations share no snapshot map, no entry type, no comparison
 *     function and no `reasons` entry, because the only durable way to hold "this
 *     one is never restored" is for there to be no code path by which it could
 *     be.
 *  7. That pre-dispatch capture is **anchored to the change, not to the
 *     attempt**. A declared path this change has already recorded a pre-run
 *     state for keeps that state as its `before`; only a path with no prior
 *     record is hashed off disk. Without it, guarantee 6 reports honestly and
 *     means nothing: the operator is told to restore and rebuild, rebuilds
 *     without restoring, and the second run's snapshot baselines the weakened
 *     bytes it was supposed to catch. `acceptance-baseline.ts` holds the full
 *     argument and the end-to-end sequence four reviewers drove to find it.
 */

export interface GuardedExecutionInput {
  readonly repositoryRoot: string;
  readonly task: TaskContract;
  /** Captured once by the caller and shared with the task-run manifest. */
  readonly baseGitSha: GitSha;
  /** Harness-written paths for this run; excluded from attribution. */
  readonly harnessPaths: readonly string[];
  /**
   * The acceptance paths this change's oracles declare, or `undefined` when the
   * caller could not establish the set.
   *
   * A **required key typed `| undefined`**, on `ShipGateChangeFacts`' rule one
   * layer down: required, so a second dispatch path cannot silently omit it and
   * have the harness report "nothing changed" over a population nobody supplied;
   * `| undefined` rather than optional, so "the oracle plane would not read" is a
   * value with its own meaning rather than the absence of an argument. `[]` means
   * the plane was read and nothing is declared, which is a different fact and one
   * the gate answers differently.
   *
   * Change-wide rather than the dispatched task's own oracles. `legion plan`
   * materialises one task per executable criterion, so a task-scoped snapshot
   * would leave task B's run free to weaken a test task A's oracle protects: B's
   * snapshot never contained it, and A's item was written by an earlier run. That
   * hole is reachable through the ordinary CLI with two criteria and no
   * hand-written artifact.
   */
  readonly acceptancePaths: readonly string[] | undefined;
  /**
   * What this change's earlier runs already recorded as the pre-run state of
   * those paths — guarantee 7's input.
   *
   * Required rather than optional for the reason the field above is: a second
   * dispatch path that omitted it would silently re-baseline every declared path
   * against the tree as it stands, which is the laundering this exists to close,
   * and it would do so while every test of *this* file stayed green.
   *
   * `status: "unestablished"` is not the empty anchor set. It means a prior run's
   * record could not be read back, and the honest answer to "did this run weaken
   * a test" when the record of what the test was is unreadable is `unknown` — not
   * "nothing changed since I last looked at it".
   */
  readonly acceptanceBaseline: AcceptanceBaseline;
  readonly run: () => Promise<ExecutionResult>;
  readonly afterRun?: () => Promise<void>;
}

/**
 * What one declared acceptance path was, on one side of the run.
 *
 * A discriminated state rather than an optional digest. `protectedPathsTouched`
 * already records why a bare hash is not enough — "a file swapped for a link, or
 * the reverse, is a change even when the bytes behind it happen to match" — and
 * `MAX_SNAPSHOT_BYTES` records the other half: conflating "too large or unreadable
 * to capture" with "absent" is how this file deleted large pre-existing artifacts
 * once already. `unreadable` is therefore its own value and never collapses into
 * `absent`, because the two produce opposite verdicts.
 */
export type AcceptancePathState =
  | { readonly kind: "absent" }
  | { readonly kind: "file"; readonly sha256: string }
  /** Never followed. The target is recorded so a retarget is detectable. */
  | { readonly kind: "symlink"; readonly target: string | undefined }
  | { readonly kind: "directory" }
  | { readonly kind: "unreadable"; readonly reason: string };

export interface AcceptancePathObservation {
  readonly path: string;
  readonly before: AcceptancePathState;
  readonly after: AcceptancePathState;
  /**
   * `unchanged` only when both sides are the same kind *and* the same bytes or
   * the same link target. Everything else is `changed`, and anything either side
   * could not determine is `unknown` — never `unchanged`.
   */
  readonly verdict: "unchanged" | "changed" | "unknown";
  /** For the sentence a reader gets. Never consulted for the verdict. */
  readonly note?: "created" | "deleted" | "modified" | "retargeted" | "kind-changed";
}

/**
 * The pre-run states this change already established for its declared paths.
 *
 * Built by `acceptanceBaselineFromEvidence` and consumed here. Declared in this
 * module rather than beside its builder so the dependency runs one way: the
 * harness owns `AcceptancePathState`, and a reader that reconstructs those states
 * from a persisted report depends on the harness rather than the reverse.
 */
export interface AcceptanceBaseline {
  readonly status: "established" | "unestablished";
  /** Why nothing could be established. Present only on `unestablished`. */
  readonly reason?: string;
  /**
   * Per declared path, the state to compare this run's result against. A path
   * absent from the map has no prior record and is hashed off disk.
   */
  readonly states: ReadonlyMap<string, AcceptancePathState>;
}

export interface AcceptancePathReport {
  /**
   * `unestablished` when the caller could not read the declaration set, or could
   * not read back what this change's earlier runs recorded about it. It must not
   * be spelled as an empty observation list: "I looked at nothing" and "nothing
   * was declared" are different facts and the second is the only one that can
   * honestly answer "nothing changed".
   */
  readonly status: "established" | "unestablished";
  /** Which of those it was, in a sentence, for the persisted report. */
  readonly reason?: string;
  readonly observations: readonly AcceptancePathObservation[];
}

/**
 * A protected path the run modified and containment could not put back.
 *
 * The reason is carried, not just the path. "Could not restore X" cannot be
 * acted on: an operator has to know whether the worktree holds a genuine
 * failure or whether this platform is structurally unable to recreate the
 * artifact. On Windows without `SeCreateSymbolicLinkPrivilege` every symlink
 * restore fails with `EPERM`, and an earlier version reported that
 * indistinguishably from a disk error — so the one diagnostic that would have
 * told the operator to enable Developer Mode read like corruption instead.
 *
 * Carrying the reason does not soften the verdict. An unrestored protected path
 * is a containment failure whatever caused it, and the run still blocks.
 */
export interface UnrestoredPath {
  readonly path: string;
  readonly reason: string;
}

/**
 * Why a restore attempt failed, in the operator's words.
 *
 * `EPERM`/`EACCES` on a symlink write is the privilege case and names the fix.
 * Everything else is reported verbatim rather than guessed at.
 */
function restoreFailureReason(error: unknown, kind: ProtectedEntry["kind"] | undefined): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // `undefined` means the path did not exist before the run, so restoration is
  // a deletion. Naming it that way matters: "restoring the file entry failed"
  // would describe the opposite of what was attempted.
  const action = kind === undefined ? "removing the path the run created" : `restoring the ${kind} entry`;
  if (kind === "symlink" && (code === "EPERM" || code === "EACCES")) {
    return process.platform === "win32"
      ? `recreating the symlink requires symlink-creation privilege (${code}); enable Developer Mode or run elevated`
      : `recreating the symlink was refused by the filesystem (${code})`;
  }
  if (code !== undefined) return `${code} while ${action}`;
  return error instanceof Error ? `${error.message} while ${action}` : `${action} failed`;
}

export interface GuardedExecutionOutcome {
  readonly result: ExecutionResult;
  readonly reconciliation?: ReconciliationResult;
  readonly inContract: boolean;
  readonly restored: readonly string[];
  readonly unrestored: readonly UnrestoredPath[];
  readonly blockedReason?: string;
  /**
   * What the run did to the declared acceptance paths.
   *
   * Reported, never acted on. Nothing in this module reads it back, which is the
   * mechanical form of guarantee 6.
   */
  readonly acceptancePaths: AcceptancePathReport;
}

/**
 * Turn a containment or reconciliation failure into the result the caller must
 * persist and expose. Returning the adapter's success result after the harness
 * blocked a run would let a read-only caller publish a green workflow record.
 */
export function blockedResultFromGuardedExecution(input: GuardedExecutionOutcome): ExecutionResult {
  if (input.inContract) return input.result;
  const reason = input.blockedReason ?? "The guarded execution did not remain within its contract.";
  return {
    ...input.result,
    ok: false,
    status: "blocked",
    summary: reason,
    filesChanged: [],
    findings: [
      ...input.result.findings,
      {
        id: "guarded-execution-blocked",
        title: "Guarded execution blocked",
        body: reason,
        severity: "blocking"
      }
    ]
  };
}

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/**
 * What a protected path looked like before dispatch.
 *
 * Each variant carries enough to detect a change and, where possible, undo it.
 * Absence from the map means one thing only: the path did not exist. An earlier
 * version conflated "too large to capture" with absence, so restoration deleted
 * large pre-existing artifacts.
 */
type ProtectedEntry =
  | { readonly kind: "file"; readonly bytes: Buffer }
  /** Too large to hold; identified by digest so a same-length rewrite is still caught. */
  | { readonly kind: "oversized"; readonly sha256: string | undefined }
  /** Never followed. The target is recorded so a retarget is detectable and reversible. */
  | {
      readonly kind: "symlink";
      readonly target: string | undefined;
      /**
       * What the target *was* before dispatch, for `symlinkSync`'s Windows
       * `type` argument.
       *
       * Captured here rather than resolved at restore time. The restore ran
       * after the executor, so inspecting the target then reads mutable
       * post-run state: a run that replaced the target with a directory
       * (or the reverse) made the link come back with the wrong reparse
       * kind, and the path was reported `restored` — a false restore, which
       * is worse than the honest failure this module reports elsewhere.
       */
      readonly targetKind: "file" | "dir" | undefined;
    };

type ProtectedSnapshot = ReadonlyMap<string, ProtectedEntry>;

interface ProtectedState {
  readonly entries: ProtectedSnapshot;
  /** Protected paths already staged before dispatch, so staging can be put back. */
  readonly staged: ReadonlySet<string>;
}

function isHarnessPath(relative: string, harnessPaths: readonly string[]): boolean {
  return harnessPaths.some((entry) => pathIsCoveredBy(relative, entry));
}

/**
 * Whether a declared path names the control plane, **case-folded**.
 *
 * `.Legion/project/change.yaml` passed every exact-string refusal in the tree and
 * resolved, on Windows and macOS, to the very control artifact the other
 * population restores. The consequence was not a near miss: `restoreProtectedFiles`
 * runs before `observeAcceptancePaths`, so the file is put back before it is
 * compared, `before === after` unconditionally, and the run records `pass` for a
 * declaration protecting no test at all. The same artifacts on a case-sensitive
 * Linux CI answer absent/absent, so the gate's verdict depended on the
 * filesystem rather than on the record.
 *
 * Refused on every platform rather than under a `process.platform` test, on
 * `isWindowsStreamPath`'s recorded rule: a declaration is authored once and
 * judged on whatever machine ships the change, and a rule that holds on Linux and
 * fails open on Windows is worse than no rule. `toLowerCase` and not
 * `toLocaleLowerCase`, which would fold the `i` of `.legion` differently under a
 * Turkish locale.
 */
function isInsideControlPlane(relative: string): boolean {
  const folded = relative.toLowerCase();
  const root = LEGION_PROJECT_ROOT.toLowerCase();
  return folded === root || folded.startsWith(`${root}/`);
}

function digestOf(absolute: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(absolute)).digest("hex");
  } catch {
    return undefined;
  }
}

function readTarget(absolute: string): string | undefined {
  try {
    return readlinkSync(absolute);
  } catch {
    return undefined;
  }
}

/**
 * Whether a link's target is a directory, read *before* dispatch.
 *
 * `undefined` for a dangling link, which is legitimate and is itself something
 * the guards are tested against; the restore falls back to Node's own default
 * rather than inventing a kind.
 */
function readTargetKind(linkPath: string, target: string | undefined): "file" | "dir" | undefined {
  if (target === undefined) return undefined;
  try {
    const resolved = path.isAbsolute(target) ? target : path.resolve(path.dirname(linkPath), target);
    return statSync(resolved).isDirectory() ? "dir" : "file";
  } catch {
    return undefined;
  }
}

function stagedProtectedPaths(repositoryRoot: string): ReadonlySet<string> {
  try {
    const output = execFileSync(
      "git",
      ["-C", repositoryRoot, "diff", "--cached", "--name-only", "--", LEGION_PROJECT_ROOT],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return new Set(
      output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    );
  } catch {
    return new Set();
  }
}

function snapshotProtectedState(input: {
  readonly repositoryRoot: string;
  readonly harnessPaths: readonly string[];
}): ProtectedState {
  const entries = new Map<string, ProtectedEntry>();

  for (const entry of listProjectFiles(input.repositoryRoot, LEGION_PROJECT_ROOT)) {
    if (isHarnessPath(entry.path, input.harnessPaths)) continue;
    const absolute = path.join(input.repositoryRoot, entry.path);

    if (entry.kind === "symlink") {
      const snapshotTarget = readTarget(absolute);
      entries.set(entry.path, {
        kind: "symlink",
        target: snapshotTarget,
        targetKind: readTargetKind(absolute, snapshotTarget)
      });
      continue;
    }
    if (entry.size !== undefined && entry.size > MAX_SNAPSHOT_BYTES) {
      // Digest rather than size: a rewrite preserving byte length would
      // otherwise be invisible.
      entries.set(entry.path, { kind: "oversized", sha256: digestOf(absolute) });
      continue;
    }
    try {
      entries.set(entry.path, { kind: "file", bytes: readFileSync(absolute) });
    } catch {
      entries.set(entry.path, { kind: "oversized", sha256: undefined });
    }
  }

  return { entries, staged: stagedProtectedPaths(input.repositoryRoot) };
}

/**
 * What one declared acceptance path is right now, without following anything.
 *
 * Positive checks throughout, each refusal naming itself. There is no arm that
 * returns a determinate state for something this function did not understand:
 * a `catch` that answered `absent` would make an unreadable file read as
 * "deleted" on one side and "unchanged" on both, and a fifo or a device answering
 * `file` would hash something that is not a test.
 *
 * The containment checks are the ones `pinned-references.ts` reinstated as
 * verdicts rather than exceptions, applied to the same class of path — an
 * ordinary repository file rather than a project artifact. They are belt and
 * braces over `acceptancePathsSchema`, which already refuses a control-plane
 * path and anything `artifactPathSchema` refuses; a hand-written oracle reaches
 * here regardless, and the harness must never be the layer that assumed the
 * schema ran.
 */
function classifyAcceptancePath(
  repositoryRoot: string,
  relative: string,
  harnessPaths: readonly string[]
): AcceptancePathState {
  if (!artifactPathSchema.safeParse(relative).success) {
    return { kind: "unreadable", reason: "is not a repository-relative path" };
  }
  if (relative.includes(":")) {
    return { kind: "unreadable", reason: "names a Windows alternate data stream" };
  }
  if (isInsideControlPlane(relative)) {
    // The control plane is the *other* population: it is restored, and a path
    // seen by both walkers would be reported as an observation and rolled back
    // as a violation. Refused here so the two can never overlap on disk.
    return { kind: "unreadable", reason: `is inside ${LEGION_PROJECT_ROOT}, which is restored rather than reported` };
  }
  if (isHarnessPath(relative, harnessPaths)) {
    return { kind: "unreadable", reason: "is written by the harness for this run" };
  }

  const absolute = path.join(repositoryRoot, relative);
  const contained = path.relative(repositoryRoot, absolute);
  if (contained.startsWith("..") || path.isAbsolute(contained)) {
    return { kind: "unreadable", reason: "resolves outside the repository" };
  }

  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unreadable", reason: `could not be inspected (${code ?? "unknown error"})` };
  }

  if (stat.isSymbolicLink()) return { kind: "symlink", target: readTarget(absolute) };
  if (stat.isDirectory()) return { kind: "directory" };
  if (!stat.isFile()) return { kind: "unreadable", reason: "is not a regular file" };

  const sha256 = digestOf(absolute);
  if (sha256 === undefined) return { kind: "unreadable", reason: "could not be read" };
  return { kind: "file", sha256 };
}

/**
 * The pre-dispatch state of every declared acceptance path, deduped.
 *
 * Deliberately **not** `snapshotProtectedState`, and deliberately structurally
 * incompatible with it: `ProtectedState` is what `restoreProtectedFiles` and
 * `restoreProtectedIndex` take, so a map of this type cannot be handed to either
 * without the compiler objecting. That is the guarantee, not the comment.
 *
 * Guarantee 7 lives in the one line that consults `anchors`: a path this change
 * has already recorded a pre-run state for is compared against *that* state, and
 * only a path with no prior record is hashed here. The disk is therefore read
 * once per path per change rather than once per attempt, which is what stops a
 * rebuild re-baselining what the previous run did.
 *
 * Taking an anchor does **not** skip a containment check, and that is worth
 * saying because it looks as though it might. `classifyAcceptancePath` still runs
 * on the *after* side of every path, so a forged anchor for a control-plane path
 * or one that leaves the repository meets an `unreadable` after and falls to
 * `unknown`. There is no anchor that produces a determinate comparison for a path
 * this module would otherwise refuse.
 */
function snapshotAcceptancePaths(input: {
  readonly repositoryRoot: string;
  readonly paths: readonly string[];
  readonly harnessPaths: readonly string[];
  readonly anchors: ReadonlyMap<string, AcceptancePathState>;
}): ReadonlyMap<string, AcceptancePathState> {
  const entries = new Map<string, AcceptancePathState>();
  for (const relative of input.paths) {
    if (entries.has(relative)) continue;
    const anchored = input.anchors.get(relative);
    entries.set(
      relative,
      anchored ?? classifyAcceptancePath(input.repositoryRoot, relative, input.harnessPaths)
    );
  }
  return entries;
}

function sameAcceptanceState(before: AcceptancePathState, after: AcceptancePathState): boolean {
  if (before.kind === "file" && after.kind === "file") return before.sha256 === after.sha256;
  if (before.kind === "symlink" && after.kind === "symlink") {
    // Two links whose targets could not be read are not established to be the
    // same link, so this is `false` and the pair falls to `changed`. Saying
    // "unchanged" about two things nobody could compare is the fail-open.
    return before.target !== undefined && before.target === after.target;
  }
  return before.kind === "directory" && after.kind === "directory";
}

function acceptanceNote(
  before: AcceptancePathState,
  after: AcceptancePathState
): AcceptancePathObservation["note"] {
  if (before.kind === "absent") return "created";
  if (after.kind === "absent") return "deleted";
  if (before.kind !== after.kind) return "kind-changed";
  if (before.kind === "symlink") return "retargeted";
  return "modified";
}

/**
 * What the run did to each declared acceptance path.
 *
 * A module-level function taking exactly what it needs, and `reasons` is not in
 * its scope. That is not tidiness: `inContract` is `reasons.length === 0`, so a
 * single accidental push here would turn a legitimately added acceptance test
 * into a blocked, rolled-back run on every tier — R2 milestone included.
 *
 * The arms, in order and all positive:
 *
 *  1. **Absent before and absent after is `unknown`, not `unchanged`.** An oracle
 *     protecting a path that is not there declares something nothing can falsify,
 *     and reporting it as clean would certify it. It is also the case-fold hole
 *     on Linux: a declaration of `tests/Foo.test.mjs` against a disk carrying
 *     `tests/foo.test.mjs` is absent on both sides, and `pass` there would be a
 *     gate satisfied by a typo.
 *  2. Anything either side could not determine — unreadable, or a directory,
 *     which has no single content to compare — is `unknown`.
 *  3. Structurally equal is `unchanged`.
 *  4. Everything else is `changed`. **A file the run created counts**: writing
 *     the bar you are judged against is the same self-grading act as lowering it,
 *     and the harness's job is to report it rather than to decide whether it was
 *     legitimate. It costs nothing honest, because a declaration names the tests
 *     that already exist.
 */
function observeAcceptancePaths(input: {
  readonly repositoryRoot: string;
  readonly harnessPaths: readonly string[];
  readonly before: ReadonlyMap<string, AcceptancePathState>;
}): readonly AcceptancePathObservation[] {
  const observations: AcceptancePathObservation[] = [];
  for (const [relative, before] of input.before) {
    const after = classifyAcceptancePath(input.repositoryRoot, relative, input.harnessPaths);
    if (before.kind === "absent" && after.kind === "absent") {
      observations.push({ path: relative, before, after, verdict: "unknown" });
      continue;
    }
    if (
      before.kind === "unreadable" ||
      after.kind === "unreadable" ||
      before.kind === "directory" ||
      after.kind === "directory"
    ) {
      observations.push({ path: relative, before, after, verdict: "unknown" });
      continue;
    }
    if (sameAcceptanceState(before, after)) {
      observations.push({ path: relative, before, after, verdict: "unchanged" });
      continue;
    }
    const note = acceptanceNote(before, after);
    observations.push({
      path: relative,
      before,
      after,
      verdict: "changed",
      ...(note === undefined ? {} : { note })
    });
  }
  return observations.sort((left, right) => left.path.localeCompare(right.path));
}

/** Protected paths that differ from the snapshot: modified, deleted, retargeted or created. */
function protectedPathsTouched(input: {
  readonly repositoryRoot: string;
  readonly state: ProtectedState;
  readonly harnessPaths: readonly string[];
}): readonly string[] {
  const touched = new Set<string>();
  const current = new Map(
    listProjectFiles(input.repositoryRoot, LEGION_PROJECT_ROOT)
      .filter((entry) => !isHarnessPath(entry.path, input.harnessPaths))
      .map((entry) => [entry.path, entry] as const)
  );

  for (const [relative, before] of input.state.entries) {
    const now = current.get(relative);
    if (now === undefined) {
      // Deletion leaves nothing in the listing, so a scan that only walked
      // observed files would call it clean.
      touched.add(relative);
      continue;
    }

    const absolute = path.join(input.repositoryRoot, relative);
    const nowIsSymlink = now.kind === "symlink";

    if (before.kind === "symlink" || nowIsSymlink) {
      // A file swapped for a link, or the reverse, is a change even when the
      // bytes behind it happen to match.
      if (before.kind !== "symlink" || !nowIsSymlink) {
        touched.add(relative);
        continue;
      }
      if (readTarget(absolute) !== before.target) touched.add(relative);
      continue;
    }

    if (before.kind === "oversized") {
      if (digestOf(absolute) !== before.sha256) touched.add(relative);
      continue;
    }

    try {
      if (!before.bytes.equals(readFileSync(absolute))) touched.add(relative);
    } catch {
      touched.add(relative);
    }
  }

  for (const relative of current.keys()) {
    if (!input.state.entries.has(relative)) touched.add(relative);
  }

  return [...touched].sort();
}

/**
 * Put the Git index back for restored paths.
 *
 * Rewriting the working tree is not enough: an executor that ran `git add`
 * leaves its blob staged, and the operator's next commit would reintroduce the
 * tampering even though the run was reported blocked and restored.
 */
function restoreProtectedIndex(input: {
  readonly repositoryRoot: string;
  readonly baseGitSha: GitSha;
  readonly state: ProtectedState;
  readonly paths: readonly string[];
}): readonly string[] {
  if (input.paths.length === 0) return [];
  // Failures are returned rather than swallowed: a reset that did not happen
  // leaves the tampered blob staged while containment reports the path restored.
  const run = (args: readonly string[]): boolean => {
    try {
      execFileSync("git", ["-C", input.repositoryRoot, ...args], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  // Reset against the pre-dispatch commit, not the current one. A bare
  // `git reset -- <path>` resets to HEAD, and if the executor committed its
  // rewrite then HEAD is the executor's — so the index would be restored to the
  // tampered blob. Naming the base makes the reference point one the run could
  // not influence.
  const failures: string[] = [];
  if (!run(["reset", "--quiet", input.baseGitSha, "--", ...input.paths])) {
    failures.push(...input.paths);
  }
  const restage = input.paths.filter((relative) => input.state.staged.has(relative));
  if (restage.length > 0 && !run(["add", "--", ...restage])) {
    failures.push(...restage);
  }
  return failures;
}

/**
 * Protected paths that differ between the base commit and the current HEAD.
 *
 * Checked independently of the working tree. An executor can commit a rewrite
 * and then put the files back, leaving nothing for the snapshot comparison to
 * find while the poisoned blob sits in history — a guard that only looks at the
 * tree is defeated by tidying up.
 */
function protectedPathsCommittedSince(input: {
  readonly repositoryRoot: string;
  readonly baseGitSha: GitSha;
}): readonly string[] {
  try {
    const output = execFileSync(
      "git",
      [
        "-C",
        input.repositoryRoot,
        "diff",
        "--name-only",
        input.baseGitSha,
        "HEAD",
        "--",
        LEGION_PROJECT_ROOT
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** The commit the worktree is on now, or `undefined` when it cannot be read. */
function currentHead(repositoryRoot: string): string | undefined {
  try {
    return execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Restore protected paths to their pre-dispatch state, working tree and index.
 *
 * Every replacement removes the current entry first. Writing straight to the
 * path would follow a symlink an executor had put there, overwriting whatever it
 * points at — possibly outside the repository — with the saved control-artifact
 * bytes, while leaving the link in place and reporting the path restored. That
 * turns containment into an arbitrary-write primitive.
 *
 * Anything that cannot be faithfully recreated is left alone and reported,
 * because deleting it would be worse than the modification being undone.
 */
function restoreProtectedFiles(input: {
  readonly repositoryRoot: string;
  readonly baseGitSha: GitSha;
  readonly state: ProtectedState;
  readonly paths: readonly string[];
}): { readonly restored: readonly string[]; readonly unrestored: readonly UnrestoredPath[] } {
  const restored: string[] = [];
  const unrestored: UnrestoredPath[] = [];

  // A replaced root is handled first and alone. Restoring a root symlink and
  // then processing descendants would make every later `rmSync` traverse the
  // recreated link and delete files in its target; a root replaced by a regular
  // file blocks descendant restoration with ENOTDIR until it is removed.
  const rootTouched = input.paths.includes(LEGION_PROJECT_ROOT);
  const ordered = rootTouched
    ? [LEGION_PROJECT_ROOT, ...input.paths.filter((entry) => entry !== LEGION_PROJECT_ROOT)]
    : input.paths;
  const rootWasProtectedEntry = input.state.entries.has(LEGION_PROJECT_ROOT);

  for (const relative of ordered) {
    const absolute = path.join(input.repositoryRoot, relative);
    const before = input.state.entries.get(relative);

    // When the root itself was a snapshotted non-directory, it is the whole
    // protected tree, and restoring it already removed anything that appeared
    // beneath the replacement. Count those descendants rather than skipping
    // them silently: a diagnostic reading "modified N, restored M" with an
    // unexplained gap invites the reader to assume the difference went
    // unhandled.
    if (rootWasProtectedEntry && relative !== LEGION_PROJECT_ROOT) {
      restored.push(relative);
      continue;
    }

    try {
      if (before === undefined) {
        rmSync(absolute, { force: true, recursive: true });
        restored.push(relative);
        continue;
      }
      if (before.kind === "file") {
        rmSync(absolute, { force: true, recursive: true });
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, before.bytes);
        restored.push(relative);
        continue;
      }
      if (before.kind === "symlink" && before.target !== undefined) {
        rmSync(absolute, { force: true, recursive: true });
        mkdirSync(path.dirname(absolute), { recursive: true });
        // The type argument is load-bearing on Windows and ignored on POSIX.
        // Node defaults to `"file"`, so a directory symlink restored without it
        // fails there even when the process *does* hold symlink privilege.
        //
        // Taken from the snapshot, never re-derived here. This code runs after
        // the executor, so resolving the target now would read whatever the run
        // left behind: a run that swapped the target from a file to a directory
        // got its link back with the wrong reparse kind and the path reported
        // `restored`. A false restore is worse than the honest failure below,
        // because nothing downstream re-checks it.
        //
        // Deliberately not falling back to `"junction"` for the directory case.
        // A junction would succeed unprivileged, but it is not the artifact that
        // was snapshotted, and this function's contract is that anything it
        // cannot recreate faithfully is left alone and reported. Substituting a
        // different reparse kind and calling the path restored would be the
        // quiet lie the reason string exists to prevent.
        symlinkSync(before.target, absolute, before.targetKind ?? "file");
        restored.push(relative);
        continue;
      }
      unrestored.push({
        path: relative,
        reason:
          before.kind === "symlink"
            ? "the pre-run symlink target could not be read, so the link cannot be recreated"
            : `no restore is defined for a snapshotted ${before.kind} entry`
      });
    } catch (error) {
      unrestored.push({ path: relative, reason: restoreFailureReason(error, before?.kind) });
    }
  }

  const indexFailures = restoreProtectedIndex({
    repositoryRoot: input.repositoryRoot,
    baseGitSha: input.baseGitSha,
    state: input.state,
    paths: restored
  });

  // A path whose index entry could not be reset is not restored, whatever the
  // working tree looks like.
  const stillStaged = new Set(indexFailures);
  return {
    restored: restored.filter((entry) => !stillStaged.has(entry)),
    unrestored: [
      ...unrestored,
      ...indexFailures.map((entry) => ({
        path: entry,
        reason: "the working tree was restored but the index entry could not be reset"
      }))
    ]
  };
}

/**
 * Why this run cannot answer about acceptance paths at all, or `undefined` when
 * it can.
 *
 * Only the baseline arm is decided here; an unreadable *declaration set* is
 * already `undefined` at the call site and carries its own sentence. The
 * declaration set is consulted first and positively: a change that declares
 * nothing has nothing to be judged against, so an unreadable baseline over an
 * empty declaration set must not manufacture an `unknown` item for a gate that
 * would otherwise answer "nobody declared one" from the plan.
 */
function acceptanceUnestablishedReason(input: GuardedExecutionInput): string | undefined {
  if (input.acceptancePaths === undefined || input.acceptancePaths.length === 0) return undefined;
  if (input.acceptanceBaseline.status === "established") return undefined;
  return (
    input.acceptanceBaseline.reason ??
    "What this change's earlier runs recorded about its protected acceptance paths could not be read back, so this run has nothing established to compare against."
  );
}

export async function runGuardedExecution(
  input: GuardedExecutionInput
): Promise<GuardedExecutionOutcome> {
  const before: DiffObservation | undefined = observeWorkingTreeDiff({
    repositoryRoot: input.repositoryRoot,
    baseGitSha: input.baseGitSha
  }).observation;

  const state = snapshotProtectedState({
    repositoryRoot: input.repositoryRoot,
    harnessPaths: input.harnessPaths
  });

  // The second population, captured in the same pre-dispatch instant and kept in
  // a type neither restore function accepts. `undefined` means the caller could
  // not establish either half of what this needs — the declaration set, or what
  // this change's earlier runs already recorded about it — and both are reported
  // as such rather than silently walked as the empty set.
  const acceptanceUnestablished = acceptanceUnestablishedReason(input);
  const acceptanceBefore =
    input.acceptancePaths === undefined || acceptanceUnestablished !== undefined
      ? undefined
      : snapshotAcceptancePaths({
          repositoryRoot: input.repositoryRoot,
          paths: input.acceptancePaths,
          harnessPaths: input.harnessPaths,
          anchors: input.acceptanceBaseline.states
        });

  let result: ExecutionResult | undefined;
  let thrown: unknown;
  try {
    result = await input.run();
    if (input.afterRun !== undefined) await input.afterRun();
  } catch (error) {
    // A run that throws after writing must still be contained; returning here
    // would leave a poisoned control artifact on disk.
    thrown = error;
  }

  const touchedProtected = protectedPathsTouched({
    repositoryRoot: input.repositoryRoot,
    state,
    harnessPaths: input.harnessPaths
  });

  const containment = touchedProtected.length === 0
    ? { restored: [] as readonly string[], unrestored: [] as readonly UnrestoredPath[] }
    : restoreProtectedFiles({
        repositoryRoot: input.repositoryRoot,
        baseGitSha: input.baseGitSha,
        state,
        paths: touchedProtected
      });

  // Contract-driven reconciliation is optional; the control-artifact invariant
  // is not, so it has already run above regardless of this flag.
  const reconciliation = input.task.completion.diffReconciliation.required
    ? reconcileTaskDiff({
        repositoryRoot: input.repositoryRoot,
        baseGitSha: input.baseGitSha,
        scope: input.task.scope,
        harnessPaths: input.harnessPaths,
        alwaysForbidden: [LEGION_PROJECT_ROOT],
        ...(before === undefined ? {} : { before })
      })
    : undefined;

  const reasons: string[] = [];
  if (thrown !== undefined) {
    reasons.push(`The run failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  }
  if (touchedProtected.length > 0) {
    const note = containment.unrestored.length === 0
      ? `Restored ${containment.restored.length} protected path(s) to their pre-run state.`
      : `Could not restore ${containment.unrestored
          .map((entry) => `${entry.path} (${entry.reason})`)
          .join(", ")}; inspect the worktree before rerunning.`;
    reasons.push(
      `The run modified ${touchedProtected.length} protected control artifact(s): ${touchedProtected.join(", ")}. ${note}`
    );
  }
  const committedProtected = protectedPathsCommittedSince({
    repositoryRoot: input.repositoryRoot,
    baseGitSha: input.baseGitSha
  });
  const headAfter = currentHead(input.repositoryRoot);
  if (committedProtected.length > 0 && headAfter !== undefined && headAfter !== input.baseGitSha) {
    // The worktree and index are restored, but a commit the run created still
    // contains the rewrite. Rewriting history here would discard whatever else
    // that commit holds, so the operator is told instead of guessed for.
    reasons.push(
      `The run committed changes to ${committedProtected.length} protected control artifact(s): ${committedProtected.join(", ")}. HEAD is now ${headAfter} rather than ${input.baseGitSha}; the working tree and index were restored, but that commit still contains the change.`
    );
  }
  if (reconciliation?.status === "unavailable") {
    reasons.push(
      `The run could not be reconciled against its task contract, so it is not proven in contract. ${reconciliation.unavailableReason ?? ""}`.trim()
    );
  }
  if (reconciliation?.status === "violated") {
    reasons.push(...reconciliation.violations.map((violation) => violation.message));
  }

  const inContract = reasons.length === 0;

  // Computed *after* `inContract` is fixed, so that even an edit made here later
  // cannot reach `reasons`. The value is returned and read by nothing in this
  // module.
  const acceptancePaths: AcceptancePathReport =
    acceptanceBefore === undefined
      ? {
          status: "unestablished",
          observations: [],
          reason:
            acceptanceUnestablished ??
            "The oracles of this change would not read as a complete set, so which acceptance tests its runs must not weaken is unestablished."
        }
      : {
          status: "established",
          observations: observeAcceptancePaths({
            repositoryRoot: input.repositoryRoot,
            harnessPaths: input.harnessPaths,
            before: acceptanceBefore
          })
        };

  if (result === undefined) {
    result = {
      ok: false,
      status: "failed",
      summary: reasons.join(" "),
      filesChanged: [],
      commandsRun: [],
      findings: []
    };
  }

  return {
    result,
    ...(reconciliation === undefined ? {} : { reconciliation }),
    inContract,
    restored: containment.restored,
    unrestored: containment.unrestored,
    ...(inContract ? {} : { blockedReason: reasons.join(" ") }),
    acceptancePaths
  };
}
