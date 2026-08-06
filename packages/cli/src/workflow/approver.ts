import { DEFAULT_RISK_POLICY, deriveGateSet } from "@legion/core";
import type { Actor, TaskContract } from "@legion/protocol";

/**
 * Who may accept a review, and when saying so is required.
 *
 * `legion ship` satisfied `explicit_human_approval` from any accepted review,
 * and every review Legion writes records a tool as its reviewer. The gate
 * therefore reported that a human approved a change on which no human identity
 * had ever been recorded. Closing that needs two things this module owns: a rule
 * for turning `--approver <id>` into a real actor, and a rule for when the flag
 * is required at all.
 *
 * The single authority is the project manifest's `policy.decisionOwners`. Three
 * other candidates exist in the tree and all three are refused:
 *
 *  - `DEFAULT_RISK_POLICY.decisionOwnerIds` is the literal `["dasbl"]` compiled
 *    into `@legion/core`, identical in every checkout and for every project it
 *    manages, and it authorizes risk-policy overrides rather than change
 *    approvals. Its entries are bare strings with no `kind`, so they cannot
 *    express the one predicate this gate turns on.
 *  - `ownerActor()` in `input.ts` never fails: it slugifies any string and falls
 *    back to `operator-<slug>`. Routing `--approver` through it would turn a typo
 *    into a plausible human approver invented on the spot.
 *  - An environment variable or `git config user.name` is set by whoever
 *    configured the machine, is unverified self-assertion, and is present
 *    everywhere — so the gate would be satisfied by default. A silently
 *    defaulted approver is the same fail-open in a new costume.
 */

export interface ApproverDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type ApproverResolution =
  | { readonly ok: true; readonly approver: Actor }
  | { readonly ok: false; readonly diagnostics: readonly ApproverDiagnostic[] };

export const PROJECT_MANIFEST_PATH = ".legion/project/project.json";

/**
 * Whether accepting this change's reviews requires a named human approver.
 *
 * Derived from the gate set, not from `tier === "R3"`, and with the identical
 * two-argument `deriveGateSet` call `ship-gates.ts` makes — no `adjustments`.
 * Computed any other way, the requirement and the gate can disagree: a change
 * could be accepted with no approver and then be blocked by ship for the gate
 * the accept decided did not apply, or the reverse.
 */
export function requiresHumanApproval(tasks: readonly TaskContract[]): boolean {
  return tasks.some((task) =>
    deriveGateSet({ tier: task.risk.tier, gatesByTier: DEFAULT_RISK_POLICY.gatesByTier }).some(
      (gate) => gate.id === "explicit_human_approval"
    )
  );
}

/** How the manifest's owners read back to an operator who has to pick one. */
export function describeDecisionOwners(owners: readonly Actor[]): string {
  if (owners.length === 0) return "none";
  return owners.map((owner) => `${owner.displayName ?? owner.id} (${owner.kind})`).join(", ");
}

/**
 * Match `--approver <value>` against the project's recorded decision owners.
 *
 * Membership is necessary and not sufficient. `actorSchema.kind` admits
 * `worker`, `system`, `runtime` and `tool`, so a project may legitimately record
 * an automation actor as a decision owner — and a gate that asked only "is this
 * value in the list" would let that actor answer a question about humanity.
 *
 * The match is on `id` or `displayName`, exactly as the intake driver already
 * matches an owner string, and on the raw trimmed value: nothing here
 * normalizes, lowercases or constructs, because every one of those steps is a
 * way for a value that names nobody to end up naming someone. The manifest's own
 * `Actor` object is returned, so what gets recorded as `decidedBy` is the
 * register's entry rather than a reconstruction of it.
 */
export function resolveApprover(input: {
  readonly raw: string;
  readonly decisionOwners: readonly Actor[];
}): ApproverResolution {
  const matches = input.decisionOwners.filter(
    (owner) => owner.id === input.raw || owner.displayName === input.raw
  );

  if (matches.length === 0) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "approver_unknown",
          message:
            `--approver "${input.raw}" is not a decision owner of this project. ` +
            `Recorded decision owners: ${describeDecisionOwners(input.decisionOwners)}. ` +
            "Add the approver to project.policy.decisionOwners, or accept as a recorded owner. " +
            "Legion does not create an approver from the value given.",
          path: PROJECT_MANIFEST_PATH
        }
      ]
    };
  }

  if (matches.length > 1) {
    // Possible when one owner's displayName equals another's id. Refused rather
    // than resolved by preferring the id match: an audit record must not carry
    // an identity the operator cannot be sure they named.
    return {
      ok: false,
      diagnostics: [
        {
          code: "approver_ambiguous",
          message:
            `--approver "${input.raw}" matches more than one decision owner ` +
            `(${matches.map((owner) => owner.id).join(", ")}). Name the approver by its exact actor id.`,
          path: PROJECT_MANIFEST_PATH
        }
      ]
    };
  }

  const approver = matches[0] as Actor;
  if (approver.kind !== "human") {
    return {
      ok: false,
      diagnostics: [
        {
          code: "approver_not_human",
          message:
            `--approver "${input.raw}" resolves to a decision owner whose kind is "${approver.kind}". ` +
            "The explicit_human_approval gate asks whether a human approved this change; a non-human owner cannot answer it.",
          path: PROJECT_MANIFEST_PATH
        }
      ]
    };
  }

  return { ok: true, approver };
}
