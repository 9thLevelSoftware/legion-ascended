import { readRequirementSet, verifyRequirementSet } from "@legion/artifacts";

import { nextNode } from "./intake/graph.js";
import { findActiveSession, graphVersionMismatch } from "./intake/session.js";
import { checkTraceability } from "./traceability-check.js";

/**
 * The v9 project artifacts `legion status` reports on top of the stage machine.
 *
 * `resolveWorkflowState` answers "which verb comes next". These three answer
 * "what state did the interview, the requirement set, and planning actually
 * leave on disk" — the artifacts phases C and D introduced, which status could
 * not see at all and therefore never mentioned.
 */

export interface IntakeStatus {
  readonly status: "none" | "active" | "unreadable";
  readonly sessionId?: string;
  /** Answers recorded so far. Not a fraction: see `pendingNodeId`. */
  readonly answered?: number;
  /**
   * Applicable nodes in the graph *as currently materialized*.
   *
   * The interview graph expands with the answers given — one more requirement
   * adds its whole criterion loop — so this is a floor, not a total, and a
   * percentage built from it would fall as the operator makes progress. Report
   * the count and the pending question, and let the reader draw no false
   * precision from either.
   */
  readonly applicable?: number;
  readonly pendingNodeId?: string;
  readonly pendingSection?: string;
  readonly graphVersion?: string;
  /** Set when the session was started under a graph version this build cannot serve. */
  readonly graphMismatch?: string;
  readonly reason?: string;
}

export async function resolveIntakeStatus(repositoryRoot: string): Promise<IntakeStatus> {
  const active = await findActiveSession(repositoryRoot);
  if (!active.ok) {
    return { status: "unreadable", reason: active.reason };
  }
  const session = active.session;
  if (session === undefined) {
    return { status: "none" };
  }

  const materializeInput = {
    answers: session.answers,
    injectedNodes: session.injectedNodes
  };
  // `nextNode` already walks the applicable set to find the pending question, so
  // take its counts rather than recounting. Its `answered` is the applicable
  // answered count, which is the one that matches what is left to ask.
  const pending = nextNode(materializeInput);
  const mismatch = graphVersionMismatch(session);

  return {
    status: "active",
    sessionId: session.id,
    answered: pending.answered,
    applicable: pending.total,
    graphVersion: session.graphVersion,
    ...(pending.node === undefined
      ? {}
      : { pendingNodeId: pending.node.id, pendingSection: pending.node.section }),
    ...(mismatch === undefined ? {} : { graphMismatch: mismatch })
  };
}

export interface RequirementsStatus {
  readonly status: "none" | "ready" | "drifted" | "invalid";
  readonly count?: number;
  readonly setHash?: string;
  readonly drift?: readonly { readonly code: string; readonly message: string }[];
  readonly reason?: string;
}

export async function resolveRequirementsStatus(repositoryRoot: string): Promise<RequirementsStatus> {
  const read = await readRequirementSet(repositoryRoot);
  if (!read.ok) {
    if (read.status === "not_found") return { status: "none" };
    return { status: "invalid", reason: read.reason };
  }

  // Verify the snapshot just read rather than letting `verifyRequirementSet`
  // read a second time: checking one read and reporting on another is how a
  // requirement edited between the two passes gets called clean.
  const drift = await verifyRequirementSet(repositoryRoot, read);
  return {
    status: drift.length === 0 ? "ready" : "drifted",
    count: read.requirements.length,
    setHash: read.set.requirementSetHash,
    ...(drift.length === 0 ? {} : { drift: drift.map((entry) => ({ code: entry.code, message: entry.message })) })
  };
}

export interface TraceabilityStatus {
  readonly status: "none" | "unverifiable" | "clean" | "incomplete";
  readonly requirements?: number;
  readonly planned?: number;
  readonly unplanned?: readonly string[];
  readonly diagnostics?: readonly { readonly code: string; readonly message: string }[];
  readonly reason?: string;
}

export async function resolveTraceabilityStatus(
  repositoryRoot: string,
  requirements: RequirementsStatus
): Promise<TraceabilityStatus> {
  // With no requirement set there is nothing to trace to, and `checkTraceability`
  // would report a clean graph over an empty set — which reads as "traceability
  // satisfied" for a project that has not stated a single requirement.
  if (requirements.status === "none") return { status: "none" };

  // The same reasoning, and the case the guard above originally missed: an
  // unreadable set is also an empty one as far as `checkTraceability` can tell,
  // so a malformed index reported `clean — 0 of 0 planned`. "Could not be
  // verified" must never render as "verified"; that is the direction of error
  // this whole surface exists to avoid.
  if (requirements.status === "invalid") {
    return {
      status: "unverifiable",
      ...(requirements.reason === undefined ? {} : { reason: requirements.reason })
    };
  }

  const report = await checkTraceability(repositoryRoot);
  const clean = report.diagnostics.length === 0 && report.coverage.unplanned.length === 0;
  return {
    status: clean ? "clean" : "incomplete",
    requirements: report.coverage.requirements,
    planned: report.coverage.planned,
    unplanned: report.coverage.unplanned,
    ...(report.diagnostics.length === 0
      ? {}
      : { diagnostics: report.diagnostics.map((entry) => ({ code: entry.code, message: entry.message })) })
  };
}

export function renderIntakeLine(intake: IntakeStatus): string {
  if (intake.status === "none") return "Intake: no active interview";
  if (intake.status === "unreadable") return `Intake: unreadable — ${intake.reason ?? "unknown reason"}`;
  const pending = intake.pendingNodeId === undefined
    ? "ready to finalize"
    : `next ${intake.pendingNodeId}`;
  const mismatch = intake.graphMismatch === undefined ? "" : " (graph version mismatch)";
  return `Intake: ${intake.sessionId} — ${intake.answered ?? 0} answered, ${pending}${mismatch}`;
}

export function renderRequirementsLine(requirements: RequirementsStatus): string {
  switch (requirements.status) {
    case "none":
      return "Requirements: none written";
    case "invalid":
      return `Requirements: invalid — ${requirements.reason ?? "unknown reason"}`;
    case "drifted":
      return `Requirements: ${requirements.count ?? 0}, DRIFTED from recorded hash (${requirements.drift?.length ?? 0})`;
    case "ready":
      return `Requirements: ${requirements.count ?? 0}, hash verified`;
  }
}

export function renderTraceabilityLine(traceability: TraceabilityStatus): string {
  if (traceability.status === "none") return "Traceability: no requirements to trace";
  if (traceability.status === "unverifiable") {
    return `Traceability: NOT VERIFIED — the requirement set could not be read${
      traceability.reason === undefined ? "" : ` (${traceability.reason})`
    }`;
  }
  const planned = `${traceability.planned ?? 0} of ${traceability.requirements ?? 0} requirements planned`;
  if (traceability.status === "clean") return `Traceability: ${planned}`;
  const diagnostics = traceability.diagnostics?.length ?? 0;
  return diagnostics === 0
    ? `Traceability: ${planned}`
    : `Traceability: ${planned}, ${diagnostics} diagnostic${diagnostics === 1 ? "" : "s"}`;
}
