import type { ArtifactReference } from "@legion/protocol";
import type { EvidenceIndexEntry } from "@legion/artifacts";

import type { AcceptanceBaseline, AcceptancePathState } from "./guarded-execution.js";
import { resolvePinnedReferenceReader } from "./pinned-references.js";

/**
 * The state a protected acceptance path was in when *this change* first looked
 * at it — not when the last attempt happened to start.
 *
 * The defect this module exists for, driven end to end by four reviewers against
 * the compiled build: `legion build` twice launders a weakening into a green
 * ship. Attempt 1 guts `acceptance.test.mjs`, the harness records `changed`, the
 * item records `fail`, and `protected_acceptance_tests` reports `unsatisfied`
 * with a recovery naming `legion build`. Running that recovery *without
 * restoring anything* re-hashes the already-gutted file as attempt 2's own
 * pre-dispatch `before`, so attempt 2 observes `unchanged`, records `pass`, and
 * the gate — which reads the latest attempt, correctly, for every other question
 * it could be asked — reports satisfied over bytes nobody put back and an
 * approval plane nobody consulted.
 *
 * There were two places to fix it and only one of them is honest.
 *
 * Folding *every* attempt's verdict at the gate ("any recorded fail stands
 * forever") closes the hole and breaks lesson 1 in the same line: restoring the
 * file and rebuilding would then repair nothing, because the old `fail` is still
 * in the index, and the gate would name a recovery that cannot clear it. That is
 * the failure `evidence-selection.ts` chose latest-attempt-only to avoid, and
 * re-introducing it for one gate would be trading a laundering for a permanent
 * block.
 *
 * So the anchor moves instead. A run's `before` for a declared path is the
 * earliest state any run of this change recorded for it, and only a path with no
 * prior record is hashed off disk. Then:
 *
 *  - Attempt 2 without a restore compares the change's original bytes against the
 *    gutted file, records `fail` again, and stays blocked. The recovery is no
 *    longer the bypass.
 *  - Attempt 3 *after* the operator restores the file compares original against
 *    original, records `pass`, and ships. The prose half of
 *    `ACCEPTANCE_PATHS_RESTORE_RECOVERY` — "restore the path to the pre-run state
 *    recorded in protected-paths.json" — is now the half that is checked.
 *  - The gate keeps reading the latest attempt, and that reading is now sound,
 *    because the latest attempt's answer is about the change's original bytes
 *    rather than about the previous attempt's leftovers.
 *
 * It also closes, without being asked to, the residual the first cut admitted:
 * a test gutted *between* two builds by hand is now caught, because the anchor
 * does not move when nobody is dispatched. What remains outside reach is a test
 * gutted before this change's first run ever observed it — the harness observes
 * across a dispatch, and there is no dispatch before the first one.
 *
 * Every failure here is `unestablished`, never the empty anchor set. Falling back
 * to "hash whatever is on disk" for a report that would not read is exactly the
 * laundering above with an extra step.
 */

/** The evidence item `legion build` writes about declared acceptance paths. */
const PROTECTED_ACCEPTANCE_ITEM = "protected-acceptance-paths";

/** The `kind` a protected-paths report declares about itself. */
const PROTECTED_PATHS_REPORT_KIND = "protected_paths";

const PROTECTED_PATHS_REPORT_SCHEMA_VERSION = 1;

function unestablished(reason: string): AcceptanceBaseline {
  return { status: "unestablished", reason, states: new Map() };
}

/**
 * One recorded pre-run state, or `undefined` for anything this reader did not
 * recognise.
 *
 * A hand parser rather than a schema because `@legion/cli` does not depend on
 * zod, and positive throughout: every arm names the shape it accepts and there
 * is no `default:` that passes an unknown state through as a determinate one. A
 * state this function cannot read is one the anchor must not be built from.
 */
function readState(value: unknown): AcceptancePathState | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  if (kind === "absent") return { kind: "absent" };
  if (kind === "directory") return { kind: "directory" };
  if (kind === "file") {
    const sha256 = record["sha256"];
    return typeof sha256 === "string" && sha256.length > 0 ? { kind: "file", sha256 } : undefined;
  }
  if (kind === "symlink") {
    const target = record["target"];
    if (target === undefined) return { kind: "symlink", target: undefined };
    return typeof target === "string" ? { kind: "symlink", target } : undefined;
  }
  if (kind === "unreadable") {
    const reason = record["reason"];
    return typeof reason === "string" ? { kind: "unreadable", reason } : undefined;
  }
  return undefined;
}

/** The `{path, before}` pairs a report records, or a sentence saying why not. */
function readReport(text: string, at: string): readonly { readonly path: string; readonly before: AcceptancePathState }[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `${at} is not readable JSON`;
  }
  if (parsed === null || typeof parsed !== "object") return `${at} is not a JSON object`;
  const record = parsed as Record<string, unknown>;
  // Recognised by what the document says it is, never by where it sits: a
  // reader keyed on the file name would accept whatever a rename left behind.
  if (record["kind"] !== PROTECTED_PATHS_REPORT_KIND) {
    return `${at} does not declare itself a ${PROTECTED_PATHS_REPORT_KIND} report`;
  }
  if (record["schemaVersion"] !== PROTECTED_PATHS_REPORT_SCHEMA_VERSION) {
    return `${at} records schema version ${String(record["schemaVersion"])}, which this reader cannot read a pre-run state out of`;
  }
  const observations = record["observations"];
  if (!Array.isArray(observations)) return `${at} records no observation list`;

  const pairs: { readonly path: string; readonly before: AcceptancePathState }[] = [];
  for (const observation of observations) {
    if (observation === null || typeof observation !== "object") return `${at} records an observation that is not an object`;
    const entry = observation as Record<string, unknown>;
    const observedPath = entry["path"];
    if (typeof observedPath !== "string" || observedPath.length === 0) {
      return `${at} records an observation with no path`;
    }
    const before = readState(entry["before"]);
    if (before === undefined) return `${at} records a pre-run state for ${observedPath} that this reader cannot read`;
    pairs.push({ path: observedPath, before });
  }
  return pairs;
}

function sameState(left: AcceptancePathState, right: AcceptancePathState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "file" && right.kind === "file") return left.sha256 === right.sha256;
  if (left.kind === "symlink" && right.kind === "symlink") return left.target === right.target;
  return true;
}

/**
 * The anchors every prior run of this change recorded, read back through the
 * evidence that cites them.
 *
 * The entry point is the evidence index rather than a directory listing, and
 * that is the positive check: a run that recorded a `protected-acceptance-paths`
 * item is a run whose report *must* be readable, so deleting the report to lose
 * an inconvenient anchor answers `unestablished` instead of silently
 * re-baselining. Nothing here is found by scanning `runs/` for a file name.
 *
 * The digest is verified through `resolvePinnedReferenceReader` — the same
 * resolver `legion ship` verifies pins with — so a report whose bytes no longer
 * match the reference the evidence carries is refused, along with the alternate
 * data stream, escaped-symlink and case-folded-alias cases that resolver already
 * refuses. Reading these bytes through a bare `readFile` would be a second,
 * weaker verifier for the same class of question.
 *
 * Order does not matter and that is deliberate. The rule is "the state every
 * prior run agreed on", not "the state the earliest prior run recorded", so no
 * caller has to establish a total order over runs of different tasks in order to
 * be correct. Within a build the anchors are recomputed between tasks, so the
 * only way two runs disagree is a hand-edited record — answered per path with an
 * `unreadable` anchor, which the harness reports as `unknown` and the gate as
 * `unevaluable`. A record that contradicts itself is not evidence of a clean run.
 */
export async function acceptanceBaselineFromEvidence(input: {
  readonly repositoryRoot: string;
  readonly entries: readonly EvidenceIndexEntry[];
}): Promise<AcceptanceBaseline> {
  const cited: { readonly at: string; readonly reference: ArtifactReference }[] = [];
  for (const entry of input.entries) {
    const item = entry.evidence.items.find((candidate) => candidate.id === PROTECTED_ACCEPTANCE_ITEM);
    if (item === undefined) continue;
    const reference = item.artifact;
    if (reference === undefined) {
      return unestablished(
        `${entry.evidence.id} records a ${PROTECTED_ACCEPTANCE_ITEM} item citing no report, so what its run saw before dispatch cannot be read back.`
      );
    }
    cited.push({ at: `${reference.path} (cited by ${entry.evidence.id})`, reference });
  }
  if (cited.length === 0) return { status: "established", states: new Map() };

  const reader = await resolvePinnedReferenceReader({
    repositoryRoot: input.repositoryRoot,
    references: cited.map((entry) => entry.reference),
    retainContentFor: cited.map((entry) => entry.reference.path)
  });

  const states = new Map<string, AcceptancePathState>();
  const contradicted = new Set<string>();
  for (const { at, reference } of cited) {
    const verdict = reader.verifyPin(reference);
    if (verdict !== "match") {
      return unestablished(
        `${at} ${verdict === "missing" ? "is no longer there" : verdict === "drift" ? "no longer hashes to the digest its evidence cites" : "could not be verified"}, so the pre-run state of this change's acceptance paths cannot be read back.`
      );
    }
    const text = reader.contentOf(reference);
    if (text === undefined) return unestablished(`${at} could not be read.`);
    const pairs = readReport(text, at);
    if (typeof pairs === "string") return unestablished(`${pairs}, so the pre-run state of this change's acceptance paths cannot be read back.`);

    for (const pair of pairs) {
      // An `unreadable` prior state anchors nothing. It is an environmental
      // answer — a permission, a device, a path the schema refuses — and
      // pinning it would make one bad run's transient state a permanent
      // `unevaluable` no rebuild could clear. The next run hashes disk instead
      // and gets a determinate answer or the same `unknown` honestly.
      if (pair.before.kind === "unreadable") continue;
      const held = states.get(pair.path);
      if (held === undefined) {
        states.set(pair.path, pair.before);
        continue;
      }
      if (!sameState(held, pair.before)) contradicted.add(pair.path);
    }
  }

  for (const contradictedPath of contradicted) {
    states.set(contradictedPath, {
      kind: "unreadable",
      reason: "prior runs of this change recorded different pre-run states for it, so which one this run must be judged against is unestablished"
    });
  }

  return { status: "established", states };
}
