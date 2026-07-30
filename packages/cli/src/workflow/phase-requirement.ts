/**
 * Resolving the requirement a roadmap phase was rendered from.
 *
 * `ROADMAP.md` is a view of `.legion/project/requirements`, and it names the
 * requirement each phase came from. Planning used to ignore that and mint its
 * own `req_<phase-suffix>` ID with generated prose criteria, so the typed
 * contract the interview had just written was not what got planned: the
 * operator's executable acceptance proofs were replaced, and nothing downstream
 * traced back to the requirement set.
 *
 * Resolution is best-effort by design. A roadmap written by hand, imported from
 * `.planning`, or produced by direct initialization names no requirement, and
 * those projects must keep planning rather than being told to hold an interview
 * they already skipped.
 */

import { readRequirementSet } from "@legion/artifacts";
import type { Requirement, RequirementCriterion } from "@legion/protocol";

import type { PhaseSource } from "./phase-compat.js";

/**
 * A criterion whose proof is executable, narrowed at the point it is sorted.
 *
 * `partition` already establishes this, but returning the wide union made every
 * consumer re-check `proof.mode` and carry unreachable fallbacks for a case the
 * type system had already ruled out.
 */
export type ExecutableCriterion = RequirementCriterion & {
  readonly proof: Extract<RequirementCriterion["proof"], { mode: "executable" }>;
};

/** Matches the `**Requirement:** \`req_x\`` line `renderRoadmap` emits. */
const REQUIREMENT_ANCHOR = /\*\*Requirement:\*\*\s*`(req_[A-Za-z0-9._@+=:,~-]+)`/;

export interface ResolvedPhaseRequirement {
  readonly requirement: Requirement;
  /** Criteria the runner can decide, in the order the operator gave them. */
  readonly executable: readonly ExecutableCriterion[];
  /** Criteria that state why no command can decide them. */
  readonly manual: readonly RequirementCriterion[];
}

export type PhaseRequirementResult =
  | { readonly ok: true; readonly resolved: ResolvedPhaseRequirement }
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: "absent" };

/** The requirement ID a phase body names, if it names one. */
export function requirementIdInPhase(phase: PhaseSource): string | undefined {
  return REQUIREMENT_ANCHOR.exec(phase.body)?.[1];
}

function partition(requirement: Requirement): {
  readonly executable: readonly ExecutableCriterion[];
  readonly manual: readonly RequirementCriterion[];
} {
  const executable: ExecutableCriterion[] = [];
  const manual: RequirementCriterion[] = [];
  for (const criterion of requirement.acceptance.criteria) {
    if (criterion.proof.mode === "executable") executable.push(criterion as ExecutableCriterion);
    else manual.push(criterion);
  }
  return { executable, manual };
}

/**
 * Load the requirement a phase was rendered from.
 *
 * `{ ok: "absent" }` means this project has no requirement set, or its roadmap
 * names no requirement — both legitimate. `{ ok: false }` means the roadmap
 * names one that is missing or unreadable, which is a broken trace rather than
 * an absent one and must not be quietly treated the same way.
 */
export async function resolvePhaseRequirement(
  repositoryRoot: string,
  phase: PhaseSource,
  /**
   * The requirements the caller already verified.
   *
   * Passed in rather than re-read, because a second independent read is a second
   * snapshot: a file changed between verification and resolution would enter the
   * task contract without a drift diagnostic, which is exactly what the
   * verification was added to prevent.
   */
  verified?: readonly Requirement[]
): Promise<PhaseRequirementResult> {
  const requirementId = requirementIdInPhase(phase);
  if (requirementId === undefined) return { ok: "absent" };

  if (verified !== undefined) {
    const found = verified.find((entry) => entry.id === requirementId);
    if (found === undefined) {
      return {
        ok: false,
        reason: `Phase ${phase.number} names requirement ${requirementId}, which is not in the requirement set. The roadmap is stale; re-run legion start --finalize.`
      };
    }
    return { ok: true, resolved: { requirement: found, ...partition(found) } };
  }

  const set = await readRequirementSet(repositoryRoot);
  if (!set.ok) {
    if (set.status === "not_found") {
      return {
        ok: false,
        reason: `Phase ${phase.number} names requirement ${requirementId}, but this project has no requirement set. Re-render the roadmap, or remove the reference.`
      };
    }
    return { ok: false, reason: set.reason };
  }

  const requirement = set.requirements.find((entry) => entry.id === requirementId);
  if (requirement === undefined) {
    return {
      ok: false,
      reason: `Phase ${phase.number} names requirement ${requirementId}, which is not in the requirement set. The roadmap is stale; re-run legion start --finalize.`
    };
  }

  return { ok: true, resolved: { requirement, ...partition(requirement) } };
}

/**
 * The oracle caps both coverage criteria and postconditions at 1024 characters.
 *
 * Intake accepts a criterion statement of exactly that length, so appending the
 * proof description overflowed it and `oracleSchema.parse` threw — after the
 * current spec and change bundle were already on disk, leaving partial planning
 * artifacts behind for a perfectly valid interview.
 */
export const MAX_CRITERION_DESCRIPTION = 1_024;

function clamp(value: string): string {
  if (value.length <= MAX_CRITERION_DESCRIPTION) return value;
  // Truncated with a visible marker rather than allowed to throw. The statement
  // leads, so what survives is the part that identifies the criterion; the full
  // text remains in the requirement artifact this describes.
  return `${value.slice(0, MAX_CRITERION_DESCRIPTION - 1).trimEnd()}…`;
}

/**
 * A criterion rendered as the line a reviewer reads.
 *
 * Executable criteria carry their command so the oracle states what decides
 * them; manual ones carry their reason, so an unproven criterion stays visible
 * as a gap rather than reading like one that passed.
 */
export function describeCriterion(criterion: RequirementCriterion): string {
  if (criterion.proof.mode === "executable") {
    const command = [criterion.proof.command, ...criterion.proof.args].join(" ");
    return clamp(`${criterion.statement} — \`${command}\` must exit ${criterion.proof.expectedExitCode}`);
  }
  return clamp(`${criterion.statement} — manual: ${criterion.proof.reason}`);
}
