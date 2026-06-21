import {
  changeIdSchema,
  oracleIdSchema,
  type ArtifactPath,
  type ArtifactReference,
  type ArtifactRevision,
  type ChangeId,
  type ContractId,
  type EvidenceBundle,
  type EvidenceId,
  type OracleId,
  type Requirement,
  type RequirementId,
  type ReviewId,
  type RiskTier,
  type TaskContract,
  type TraceReference
} from "@legion/protocol";

import { loadChangeBundle, type ChangeBundleSuccess } from "../changes/service.js";
import { readEvidenceIndex, type EvidenceIndexSuccess } from "../evidence-index/service.js";
import { deriveOracleManifest, readOracleArtifact, type OracleArtifactSuccess } from "../oracles/service.js";
import { artifactPathForRole, diagnosticForPath, type ArtifactDiagnostic } from "../paths.js";
import { listCurrentSpecs, type CurrentSpecListSuccess } from "../specs/service.js";
import { readTaskGraph, type TaskGraphSuccess } from "../taskgraphs/service.js";
import type { EvidenceIndexEntry } from "../evidence-index/schema.js";

export type TraceabilityNodeKind =
  | "change"
  | "requirement"
  | "decision"
  | "oracle"
  | "task"
  | "evidence"
  | "review"
  | "artifact";

export type TraceabilityEdgeRelation =
  | "contains"
  | "defines"
  | "requires"
  | "covers"
  | "verifies"
  | "records"
  | "depends_on"
  | "accepts";

export interface TraceabilityNode {
  readonly id: string;
  readonly kind: TraceabilityNodeKind;
  readonly label: string;
  readonly source: {
    readonly path: ArtifactPath;
    readonly anchor?: string;
  };
  readonly artifact?: ArtifactReference;
  readonly riskTier?: RiskTier;
}

export interface TraceabilityEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: TraceabilityEdgeRelation;
  readonly source: {
    readonly path: ArtifactPath;
    readonly anchor?: string;
  };
}

export interface TraceabilityGraph {
  readonly changeId: ChangeId;
  readonly nodes: readonly TraceabilityNode[];
  readonly edges: readonly TraceabilityEdge[];
}

export interface TraceabilitySummary {
  readonly requirements: number;
  readonly oracles: number;
  readonly tasks: number;
  readonly evidence: number;
  readonly acceptedEvidence: number;
  readonly reviews: number;
}

export interface TraceabilityReport {
  readonly changeId: ChangeId;
  readonly summary: TraceabilitySummary;
  readonly graph: TraceabilityGraph;
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

export interface TraceabilityValidationSuccess {
  readonly ok: true;
  readonly status: "validated";
  readonly report: TraceabilityReport;
  readonly diagnostics: readonly [];
}

export interface TraceabilityValidationFailure {
  readonly ok: false;
  readonly status: "invalid" | "not_found";
  readonly diagnostics: readonly ArtifactDiagnostic[];
  readonly report?: TraceabilityReport;
}

export type TraceabilityValidationResult = TraceabilityValidationSuccess | TraceabilityValidationFailure;

export interface ValidateChangeTraceabilityInput {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId | string;
}

export interface TraceabilityImpactInput {
  readonly graph: TraceabilityGraph;
  readonly changedArtifactPath: ArtifactPath | string;
  readonly changedRequirementIds?: readonly (RequirementId | string)[];
}

export interface TraceabilityImpactReport {
  readonly changedArtifactPath: ArtifactPath | string;
  readonly affectedRequirements: readonly RequirementId[];
  readonly affectedOracles: readonly OracleId[];
  readonly affectedTasks: readonly ContractId[];
  readonly affectedEvidence: readonly EvidenceId[];
  readonly affectedReviews: readonly ReviewId[];
  readonly affectedArtifacts: readonly ArtifactPath[];
}

interface LoadedTraceabilityArtifacts {
  readonly currentSpecs: CurrentSpecListSuccess;
  readonly change: ChangeBundleSuccess;
  readonly oracles: readonly OracleArtifactSuccess[];
  readonly taskGraph: TaskGraphSuccess;
  readonly evidenceIndex: EvidenceIndexSuccess;
}

interface RequirementEntry {
  readonly requirement: Requirement;
  readonly path: ArtifactPath;
  readonly artifact?: ArtifactReference;
  readonly riskTier: RiskTier;
}

interface GraphState {
  readonly changeId: ChangeId;
  readonly nodes: Map<string, TraceabilityNode>;
  readonly edges: TraceabilityEdge[];
  readonly requirements: Map<RequirementId, RequirementEntry>;
  readonly oracles: Map<OracleId, OracleArtifactSuccess>;
  readonly tasks: Map<ContractId, TaskContract>;
  readonly evidence: Map<EvidenceId, EvidenceIndexEntry>;
  readonly reviews: Set<ReviewId>;
  readonly diagnostics: ArtifactDiagnostic[];
  readonly traceCycleEdges: TraceabilityEdge[];
}

interface ExpectedArtifactInput {
  readonly artifact: ArtifactReference;
  readonly revision?: number;
}

const INVALID_TRACEABILITY_PATH = ".legion/project/changes/invalid-change/traceability.json" as ArtifactPath;
const HIGH_RISK_TIERS = new Set<RiskTier>(["R2", "R3"]);
const RISK_ORDER: readonly RiskTier[] = ["R0", "R1", "R2", "R3"];

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nodeId(kind: TraceabilityNodeKind, id: string): string {
  return `${kind}:${id}`;
}

function requirementNodeId(id: RequirementId): string {
  return nodeId("requirement", id);
}

function oracleNodeId(id: OracleId): string {
  return nodeId("oracle", id);
}

function taskNodeId(id: ContractId): string {
  return nodeId("task", id);
}

function evidenceNodeId(id: EvidenceId): string {
  return nodeId("evidence", id);
}

function reviewNodeId(id: ReviewId): string {
  return nodeId("review", id);
}

function artifactNodeId(path: ArtifactPath): string {
  return nodeId("artifact", path);
}

function traceabilityDiagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly path?: ArtifactPath;
}): ArtifactDiagnostic {
  return diagnosticForPath({
    code: input.code,
    message: input.message,
    path: input.path ?? INVALID_TRACEABILITY_PATH
  });
}

function failure(status: TraceabilityValidationFailure["status"], diagnostics: readonly ArtifactDiagnostic[], report?: TraceabilityReport): TraceabilityValidationFailure {
  return {
    ok: false,
    status,
    diagnostics,
    ...(report === undefined ? {} : { report })
  };
}

function parseChangeId(input: ChangeId | string): ChangeId | TraceabilityValidationFailure {
  const parsed = changeIdSchema.safeParse(input);
  if (!parsed.success) {
    return failure("invalid", parsed.error.issues.map((issue) =>
      traceabilityDiagnostic({
        code: "invalid_change_id",
        message: issue.message
      })
    ));
  }
  return parsed.data;
}

function maxRiskTier(left: RiskTier, right: RiskTier): RiskTier {
  return RISK_ORDER.indexOf(left) >= RISK_ORDER.indexOf(right) ? left : right;
}

function isHighRisk(tier: RiskTier): boolean {
  return HIGH_RISK_TIERS.has(tier);
}

function artifactPathForTraceability(changeId: ChangeId): ArtifactPath {
  return `${artifactPathForRole({ role: "proposal", changeId })}#traceability` as ArtifactPath;
}

function oracleIdFromPath(path: ArtifactPath): OracleId | undefined {
  const fileName = path.split("/").at(-1);
  if (fileName === undefined || !fileName.endsWith(".yaml")) return undefined;
  const parsed = oracleIdSchema.safeParse(fileName.slice(0, -".yaml".length));
  return parsed.success ? parsed.data : undefined;
}

function entityNodeId(entity: TraceReference["entity"]): string | undefined {
  if (entity === undefined) return undefined;
  if (entity.kind === "project") return nodeId("artifact", `project:${entity.id}`);
  if (entity.kind === "change") return nodeId("change", entity.id);
  if (entity.kind === "requirement") return requirementNodeId(entity.id);
  if (entity.kind === "decision") return nodeId("decision", entity.id);
  if (entity.kind === "oracle") return oracleNodeId(entity.id);
  return undefined;
}

function pushNode(state: GraphState, node: TraceabilityNode): void {
  if (state.nodes.has(node.id)) return;
  state.nodes.set(node.id, node);
}

function pushEdge(state: GraphState, edge: TraceabilityEdge): void {
  state.edges.push(edge);
}

function pushArtifactNode(state: GraphState, revision: ArtifactRevision): void {
  pushNode(state, {
    id: artifactNodeId(revision.artifact.path),
    kind: "artifact",
    label: revision.artifact.path,
    source: { path: revision.artifact.path },
    artifact: revision.artifact
  });
}

function pushArtifactReferenceNode(state: GraphState, artifact: ArtifactReference): void {
  pushNode(state, {
    id: artifactNodeId(artifact.path),
    kind: "artifact",
    label: artifact.path,
    source: { path: artifact.path },
    artifact
  });
}

function allEvidenceTraceRefs(entry: EvidenceIndexEntry): readonly TraceReference[] {
  return [
    ...entry.evidence.traceRefs,
    ...entry.evidence.items.flatMap((item) => item.traceRefs)
  ];
}

function traceRefsContainEntity(traceRefs: readonly TraceReference[], kind: NonNullable<TraceReference["entity"]>["kind"], id: string): boolean {
  return traceRefs.some((traceRef) => traceRef.entity?.kind === kind && traceRef.entity.id === id);
}

function evidenceEntriesForRequirement(entries: Iterable<EvidenceIndexEntry>, requirementId: RequirementId): EvidenceIndexEntry[] {
  return [...entries].filter((entry) =>
    traceRefsContainEntity(allEvidenceTraceRefs(entry), "requirement", requirementId)
  );
}

function validateTraceRefs(input: {
  readonly state: GraphState;
  readonly from: string;
  readonly refs: readonly TraceReference[];
  readonly sourcePath: ArtifactPath;
}): void {
  const seenRefs = new Set<string>();
  for (const traceRef of input.refs) {
    const refKey = [
      traceRef.path,
      traceRef.anchor ?? "",
      traceRef.relation,
      traceRef.entity?.kind ?? "",
      traceRef.entity?.id ?? ""
    ].join("|");
    if (seenRefs.has(refKey)) {
      input.state.diagnostics.push(
        traceabilityDiagnostic({
          code: "duplicate_trace_reference",
          message: `Duplicate trace reference to ${traceRef.entity?.kind ?? "artifact"} ${traceRef.entity?.id ?? traceRef.path}.`,
          path: input.sourcePath
        })
      );
    }
    seenRefs.add(refKey);

    if (
      traceRef.path.startsWith(".legion/project/changes/chg_") &&
      !traceRef.path.startsWith(`.legion/project/changes/${input.state.changeId}/`)
    ) {
      input.state.diagnostics.push(
        traceabilityDiagnostic({
          code: "cross_change_reference",
          message: `Trace reference points outside change ${input.state.changeId}: ${traceRef.path}.`,
          path: input.sourcePath
        })
      );
    }

    const to = entityNodeId(traceRef.entity);
    if (to === undefined) continue;
    if (!input.state.nodes.has(to)) {
      input.state.diagnostics.push(
        traceabilityDiagnostic({
          code: "removed_target_reference",
          message: `Trace reference points to missing ${traceRef.entity?.kind ?? "entity"} ${traceRef.entity?.id ?? ""}.`,
          path: input.sourcePath
        })
      );
      continue;
    }

    if (input.from !== to && (traceRef.relation === "refines" || traceRef.relation === "supersedes")) {
      input.state.traceCycleEdges.push({
        from: input.from,
        to,
        relation: traceRef.relation === "refines" ? "depends_on" : "records",
        source: { path: input.sourcePath, ...(traceRef.anchor === undefined ? {} : { anchor: traceRef.anchor }) }
      });
    }
  }
}

function detectTraceCycles(state: GraphState): void {
  const adjacency = new Map<string, string[]>();
  for (const edge of state.traceCycleEdges) {
    const existing = adjacency.get(edge.from) ?? [];
    existing.push(edge.to);
    adjacency.set(edge.from, existing);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = new Set<string>();

  function visit(node: string): boolean {
    if (visiting.has(node)) {
      cyclic.add(node);
      return true;
    }
    if (visited.has(node)) return false;
    visiting.add(node);
    let found = false;
    for (const next of adjacency.get(node) ?? []) {
      found = visit(next) || found;
    }
    visiting.delete(node);
    visited.add(node);
    if (found) cyclic.add(node);
    return found;
  }

  for (const node of adjacency.keys()) {
    visit(node);
  }

  if (cyclic.size === 0) return;
  state.diagnostics.push(
    traceabilityDiagnostic({
      code: "cyclic_reference",
      message: `Trace references contain a cycle involving ${[...cyclic].sort(compareStrings).join(", ")}.`,
      path: artifactPathForTraceability(state.changeId)
    })
  );
}

function addCurrentRequirements(state: GraphState, currentSpecs: CurrentSpecListSuccess): void {
  const currentEntriesByRequirement = new Map<RequirementId, {
    readonly path: ArtifactPath;
    readonly artifact: ArtifactReference;
  }>();
  for (const entry of currentSpecs.index.entries) {
    for (const requirement of entry.requirements) {
      currentEntriesByRequirement.set(requirement.id, {
        path: entry.path,
        artifact: entry.artifact
      });
    }
  }

  for (const document of currentSpecs.documents) {
    for (const requirement of document.requirements) {
      const location = currentEntriesByRequirement.get(requirement.id);
      const path = location?.path ?? `${artifactPathForTraceability(state.changeId)}#${requirement.id}` as ArtifactPath;
      state.requirements.set(requirement.id, {
        requirement,
        path,
        ...(location?.artifact === undefined ? {} : { artifact: location.artifact }),
        riskTier: "R0"
      });
    }
  }
}

function addDeltaRequirements(state: GraphState, change: ChangeBundleSuccess): void {
  const deltaPaths = new Map<RequirementId, {
    readonly path: ArtifactPath;
    readonly artifact: ArtifactReference;
  }>();
  for (const delta of change.bundle.deltas) {
    deltaPaths.set(delta.requirementId, {
      path: delta.path,
      artifact: delta.delta
    });
  }

  for (const delta of change.deltaSpecs) {
    if (delta.proposedRequirement === undefined) continue;
    const location = deltaPaths.get(delta.requirementId);
    const prior = state.requirements.get(delta.requirementId);
    const artifact = location?.artifact ?? prior?.artifact;
    state.requirements.set(delta.requirementId, {
      requirement: delta.proposedRequirement,
      path: location?.path ?? prior?.path ?? artifactPathForTraceability(state.changeId),
      ...(artifact === undefined ? {} : { artifact }),
      riskTier: prior?.riskTier ?? "R0"
    });
  }
}

function addTaskRisk(state: GraphState, taskGraph: TaskGraphSuccess, changeRisk: RiskTier): void {
  for (const requirementId of taskGraph.document.tasks.flatMap((task) => task.requirementIds)) {
    const entry = state.requirements.get(requirementId);
    if (entry === undefined) continue;
    const taskRisk = taskGraph.document.tasks
      .filter((task) => task.requirementIds.includes(requirementId))
      .map((task) => task.risk.tier)
      .reduce(maxRiskTier, changeRisk);
    state.requirements.set(requirementId, {
      ...entry,
      riskTier: maxRiskTier(entry.riskTier, taskRisk)
    });
  }

  if (!isHighRisk(changeRisk)) return;
  for (const requirementId of state.requirements.keys()) {
    if (!taskGraph.document.tasks.some((task) => task.requirementIds.includes(requirementId))) continue;
    const entry = state.requirements.get(requirementId);
    if (entry === undefined) continue;
    state.requirements.set(requirementId, {
      ...entry,
      riskTier: maxRiskTier(entry.riskTier, changeRisk)
    });
  }
}

function addChangeRiskToTargets(state: GraphState, change: ChangeBundleSuccess): void {
  for (const requirementId of change.bundle.change.proposedTruth.requirementIds) {
    const entry = state.requirements.get(requirementId);
    if (entry === undefined) continue;
    state.requirements.set(requirementId, {
      ...entry,
      riskTier: maxRiskTier(entry.riskTier, change.bundle.change.risk.tier)
    });
  }
}

function addCurrentSpecDefinitionEdges(state: GraphState, currentSpecs: CurrentSpecListSuccess): void {
  for (const entry of currentSpecs.index.entries) {
    pushArtifactReferenceNode(state, entry.artifact);
    for (const requirement of entry.requirements) {
      pushEdge(state, {
        from: artifactNodeId(entry.artifact.path),
        to: requirementNodeId(requirement.id),
        relation: "defines",
        source: { path: entry.path, anchor: requirement.id }
      });
    }
  }
}

function expectedArtifactInputs(input: LoadedTraceabilityArtifacts): Map<ArtifactPath, ExpectedArtifactInput> {
  const expected = new Map<ArtifactPath, ExpectedArtifactInput>();
  const addRevision = (revision: ArtifactRevision): void => {
    expected.set(revision.artifact.path, {
      artifact: revision.artifact,
      revision: revision.revision
    });
  };

  addRevision(input.change.revision);
  for (const revision of input.change.bundle.artifactRevisions) addRevision(revision);
  for (const oracle of input.oracles) addRevision(oracle.revision);
  addRevision(input.taskGraph.revision);
  addRevision(input.evidenceIndex.revision);
  for (const entry of input.currentSpecs.index.entries) {
    expected.set(entry.artifact.path, {
      artifact: entry.artifact,
      revision: entry.revision
    });
  }
  return expected;
}

function validateArtifactInputFreshness(state: GraphState, input: LoadedTraceabilityArtifacts): void {
  const expected = expectedArtifactInputs(input);
  for (const [sourcePath, artifactInputs] of [
    [input.taskGraph.artifactPath, input.taskGraph.document.artifactInputs],
    [input.evidenceIndex.artifactPath, input.evidenceIndex.document.artifactManifest.inputs]
  ] as const) {
    for (const artifactInput of artifactInputs) {
      const current = expected.get(artifactInput.artifact.path);
      if (current === undefined) continue;
      if (current.artifact.sha256 === artifactInput.artifact.sha256 && current.revision === artifactInput.revision) continue;
      state.diagnostics.push(
        traceabilityDiagnostic({
          code: "stale_revision_reference",
          message: `Artifact input ${artifactInput.artifact.path} records revision ${artifactInput.revision} (${artifactInput.artifact.sha256}), but current traceability truth is revision ${current.revision ?? "unknown"} (${current.artifact.sha256}).`,
          path: sourcePath
        })
      );
    }
  }
}

function buildGraph(input: LoadedTraceabilityArtifacts): TraceabilityReport {
  const diagnostics: ArtifactDiagnostic[] = [];
  const state: GraphState = {
    changeId: input.change.bundle.change.id,
    nodes: new Map(),
    edges: [],
    requirements: new Map(),
    oracles: new Map(input.oracles.map((oracle) => [oracle.document.id, oracle])),
    tasks: new Map(input.taskGraph.document.tasks.map((task) => [task.id, task])),
    evidence: new Map(input.evidenceIndex.document.entries.map((entry) => [entry.evidence.id, entry])),
    reviews: new Set(input.evidenceIndex.document.entries.flatMap((entry) =>
      entry.acceptance.status === "accepted" ? [entry.acceptance.reviewId] : []
    )),
    diagnostics,
    traceCycleEdges: []
  };

  pushNode(state, {
    id: nodeId("change", input.change.bundle.change.id),
    kind: "change",
    label: input.change.bundle.change.title,
    source: { path: input.change.artifactPath },
    artifact: input.change.reference,
    riskTier: input.change.bundle.change.risk.tier
  });
  pushArtifactNode(state, input.change.revision);
  for (const revision of input.change.bundle.artifactRevisions) pushArtifactNode(state, revision);
  for (const revision of input.taskGraph.document.artifactInputs) pushArtifactNode(state, revision);
  pushArtifactNode(state, input.taskGraph.revision);
  pushArtifactNode(state, input.evidenceIndex.revision);

  addCurrentRequirements(state, input.currentSpecs);
  addDeltaRequirements(state, input.change);
  addTaskRisk(state, input.taskGraph, input.change.bundle.change.risk.tier);
  addChangeRiskToTargets(state, input.change);

  for (const entry of state.requirements.values()) {
    pushNode(state, {
      id: requirementNodeId(entry.requirement.id),
      kind: "requirement",
      label: entry.requirement.id,
      source: { path: entry.path, anchor: entry.requirement.id },
      ...(entry.artifact === undefined ? {} : { artifact: entry.artifact }),
      riskTier: entry.riskTier
    });
  }
  addCurrentSpecDefinitionEdges(state, input.currentSpecs);

  for (const decision of input.change.decisions) {
    pushNode(state, {
      id: nodeId("decision", decision.id),
      kind: "decision",
      label: decision.title,
      source: { path: input.change.bundle.paths.decisions, anchor: decision.id }
    });
  }

  for (const oracle of input.oracles) {
    pushNode(state, {
      id: oracleNodeId(oracle.document.id),
      kind: "oracle",
      label: oracle.document.title,
      source: { path: oracle.artifactPath, anchor: oracle.document.id },
      artifact: oracle.reference
    });
  }

  for (const task of input.taskGraph.document.tasks) {
    pushNode(state, {
      id: taskNodeId(task.id),
      kind: "task",
      label: task.title,
      source: { path: input.taskGraph.artifactPath, anchor: task.id },
      artifact: input.taskGraph.reference,
      riskTier: task.risk.tier
    });
    for (const artifact of [
      ...task.context.specRefs,
      ...task.context.designRefs,
      ...task.context.predecessorArtifacts
    ]) {
      pushEdge(state, {
        from: artifactNodeId(artifact.path),
        to: taskNodeId(task.id),
        relation: "depends_on",
        source: { path: input.taskGraph.artifactPath, anchor: task.id }
      });
    }
  }

  for (const entry of input.evidenceIndex.document.entries) {
    pushNode(state, {
      id: evidenceNodeId(entry.evidence.id),
      kind: "evidence",
      label: entry.evidence.id,
      source: { path: input.evidenceIndex.artifactPath, anchor: entry.evidence.id },
      artifact: input.evidenceIndex.reference
    });
    if (entry.acceptance.status === "accepted") {
      pushNode(state, {
        id: reviewNodeId(entry.acceptance.reviewId),
        kind: "review",
        label: entry.acceptance.reviewId,
        source: { path: input.evidenceIndex.artifactPath, anchor: entry.evidence.id }
      });
      pushEdge(state, {
        from: evidenceNodeId(entry.evidence.id),
        to: reviewNodeId(entry.acceptance.reviewId),
        relation: "accepts",
        source: { path: input.evidenceIndex.artifactPath, anchor: entry.evidence.id }
      });
    }
  }

  validateArtifactInputFreshness(state, input);
  validateCoverage(state, input);
  detectTraceCycles(state);

  const graph: TraceabilityGraph = {
    changeId: state.changeId,
    nodes: [...state.nodes.values()].sort((left, right) => compareStrings(left.id, right.id)),
    edges: state.edges.sort((left, right) =>
      compareStrings(left.from, right.from) ||
      compareStrings(left.to, right.to) ||
      compareStrings(left.relation, right.relation)
    )
  };

  const report: TraceabilityReport = {
    changeId: state.changeId,
    summary: {
      requirements: [...state.nodes.values()].filter((node) => node.kind === "requirement").length,
      oracles: [...state.nodes.values()].filter((node) => node.kind === "oracle").length,
      tasks: [...state.nodes.values()].filter((node) => node.kind === "task").length,
      evidence: [...state.nodes.values()].filter((node) => node.kind === "evidence").length,
      acceptedEvidence: input.evidenceIndex.document.entries.filter((entry) => entry.acceptance.status === "accepted").length,
      reviews: [...state.nodes.values()].filter((node) => node.kind === "review").length
    },
    graph,
    diagnostics: diagnostics.sort((left, right) =>
      compareStrings(left.source.path, right.source.path) ||
      compareStrings(left.code, right.code) ||
      compareStrings(left.message, right.message)
    )
  };

  return report;
}

function validateCoverage(state: GraphState, input: LoadedTraceabilityArtifacts): void {
  const targetRequirementIds = [...new Set(input.change.bundle.change.proposedTruth.requirementIds)].sort(compareStrings);

  for (const requirementId of targetRequirementIds) {
    const entry = state.requirements.get(requirementId);
    if (entry === undefined) {
      state.diagnostics.push(
        traceabilityDiagnostic({
          code: "missing_requirement_target",
          message: `Change targets requirement ${requirementId}, but no current or proposed requirement content was loaded.`,
          path: input.change.artifactPath
        })
      );
      continue;
    }

    const requirement = entry.requirement;
    validateTraceRefs({
      state,
      from: requirementNodeId(requirement.id),
      refs: requirement.traceRefs,
      sourcePath: entry.path
    });

    if (requirement.acceptance.oracleRefs.length === 0) {
      state.diagnostics.push(
        traceabilityDiagnostic({
          code: "missing_requirement_oracle",
          message: `Requirement ${requirement.id} has no acceptance oracle references.`,
          path: entry.path
        })
      );
    }

    for (const oracleId of requirement.acceptance.oracleRefs) {
      const oracle = state.oracles.get(oracleId);
      if (oracle === undefined) {
        state.diagnostics.push(
          traceabilityDiagnostic({
            code: "missing_oracle_artifact",
            message: `Requirement ${requirement.id} references missing oracle ${oracleId}.`,
            path: entry.path
          })
        );
        continue;
      }
      pushEdge(state, {
        from: requirementNodeId(requirement.id),
        to: oracleNodeId(oracleId),
        relation: "covers",
        source: { path: entry.path, anchor: requirement.id }
      });
      if (!oracle.document.requirementCoverage.some((coverage) => coverage.requirementId === requirement.id)) {
        state.diagnostics.push(
          traceabilityDiagnostic({
            code: "oracle_missing_requirement_coverage",
            message: `Oracle ${oracleId} does not declare coverage for ${requirement.id}.`,
            path: oracle.artifactPath
          })
        );
      }
    }

    const tasks = [...state.tasks.values()].filter((task) => task.requirementIds.includes(requirement.id));
    if (tasks.length === 0) {
      state.diagnostics.push(
        traceabilityDiagnostic({
          code: "missing_requirement_task",
          message: `Requirement ${requirement.id} has no task contract coverage.`,
          path: entry.path
        })
      );
    }

    for (const task of tasks) {
      pushEdge(state, {
        from: requirementNodeId(requirement.id),
        to: taskNodeId(task.id),
        relation: "requires",
        source: { path: input.taskGraph.artifactPath, anchor: task.id }
      });

      const taskOracleCoversRequirement = task.oracleRefs.some((oracleId) => {
        const oracle = state.oracles.get(oracleId);
        return oracle?.document.requirementCoverage.some((coverage) => coverage.requirementId === requirement.id) ?? false;
      });
      if (!taskOracleCoversRequirement) {
        state.diagnostics.push(
          traceabilityDiagnostic({
            code: "task_missing_requirement_oracle",
            message: `Task ${task.id} has no oracle that covers ${requirement.id}.`,
            path: input.taskGraph.artifactPath
          })
        );
      }
    }

    const evidence = evidenceEntriesForRequirement(state.evidence.values(), requirement.id);
    for (const evidenceEntry of evidence) {
      pushEdge(state, {
        from: requirementNodeId(requirement.id),
        to: evidenceNodeId(evidenceEntry.evidence.id),
        relation: "verifies",
        source: { path: input.evidenceIndex.artifactPath, anchor: evidenceEntry.evidence.id }
      });
    }
    for (const task of tasks) {
      for (const evidenceEntry of evidence) {
        pushEdge(state, {
          from: taskNodeId(task.id),
          to: evidenceNodeId(evidenceEntry.evidence.id),
          relation: "records",
          source: { path: input.evidenceIndex.artifactPath, anchor: evidenceEntry.evidence.id }
        });
      }
    }

    if (isHighRisk(entry.riskTier) && !evidence.some((evidenceEntry) => evidenceEntry.acceptance.status === "accepted")) {
      state.diagnostics.push(
        traceabilityDiagnostic({
          code: "missing_accepted_evidence",
          message: `High-risk requirement ${requirement.id} has no accepted evidence with review provenance.`,
          path: entry.path
        })
      );
    }
  }

  for (const oracle of state.oracles.values()) {
    for (const coverage of oracle.document.requirementCoverage) {
      if (!state.requirements.has(coverage.requirementId)) {
        state.diagnostics.push(
          traceabilityDiagnostic({
            code: "oracle_references_unknown_requirement",
            message: `Oracle ${oracle.document.id} covers unknown requirement ${coverage.requirementId}.`,
            path: oracle.artifactPath
          })
        );
      }
    }
    validateTraceRefs({
      state,
      from: oracleNodeId(oracle.document.id),
      refs: oracle.document.traceRefs,
      sourcePath: oracle.artifactPath
    });
  }

  for (const task of state.tasks.values()) {
    for (const requirementId of task.requirementIds) {
      if (!state.requirements.has(requirementId)) {
        state.diagnostics.push(
          traceabilityDiagnostic({
            code: "task_references_unknown_requirement",
            message: `Task ${task.id} references unknown requirement ${requirementId}.`,
            path: input.taskGraph.artifactPath
          })
        );
      }
    }

    for (const oracleId of task.oracleRefs) {
      if (!state.oracles.has(oracleId)) {
        state.diagnostics.push(
          traceabilityDiagnostic({
            code: "task_references_unknown_oracle",
            message: `Task ${task.id} references unknown oracle ${oracleId}.`,
            path: input.taskGraph.artifactPath
          })
        );
        continue;
      }
      pushEdge(state, {
        from: oracleNodeId(oracleId),
        to: taskNodeId(task.id),
        relation: "verifies",
        source: { path: input.taskGraph.artifactPath, anchor: task.id }
      });
    }
  }

  for (const entry of state.evidence.values()) {
    const traceRefs = allEvidenceTraceRefs(entry);
    validateEvidenceTraceTargets({
      state,
      evidence: entry.evidence,
      traceRefs,
      sourcePath: input.evidenceIndex.artifactPath
    });
    if (!traceRefs.some((traceRef) =>
      (traceRef.entity?.kind === "requirement" && state.requirements.has(traceRef.entity.id)) ||
      (traceRef.entity?.kind === "oracle" && state.oracles.has(traceRef.entity.id))
    )) {
      state.diagnostics.push(
        traceabilityDiagnostic({
          code: "orphan_evidence",
          message: `Evidence ${entry.evidence.id} is not linked to a known requirement or oracle.`,
          path: input.evidenceIndex.artifactPath
        })
      );
    }
    for (const traceRef of traceRefs) {
      if (traceRef.entity?.kind === "oracle" && state.oracles.has(traceRef.entity.id)) {
        pushEdge(state, {
          from: oracleNodeId(traceRef.entity.id),
          to: evidenceNodeId(entry.evidence.id),
          relation: "verifies",
          source: { path: input.evidenceIndex.artifactPath, anchor: entry.evidence.id }
        });
      }
    }
  }

  for (const decision of input.change.decisions) {
    validateTraceRefs({
      state,
      from: nodeId("decision", decision.id),
      refs: decision.traceRefs,
      sourcePath: input.change.bundle.paths.decisions
    });
  }
}

function validateEvidenceTraceTargets(input: {
  readonly state: GraphState;
  readonly evidence: EvidenceBundle;
  readonly traceRefs: readonly TraceReference[];
  readonly sourcePath: ArtifactPath;
}): void {
  for (const traceRef of input.traceRefs) {
    if (traceRef.entity?.kind === "requirement" && !input.state.requirements.has(traceRef.entity.id)) {
      input.state.diagnostics.push(
        traceabilityDiagnostic({
          code: "evidence_references_unknown_requirement",
          message: `Evidence ${input.evidence.id} references unknown requirement ${traceRef.entity.id}.`,
          path: input.sourcePath
        })
      );
    }
    if (traceRef.entity?.kind === "oracle" && !input.state.oracles.has(traceRef.entity.id)) {
      input.state.diagnostics.push(
        traceabilityDiagnostic({
          code: "evidence_references_unknown_oracle",
          message: `Evidence ${input.evidence.id} references unknown oracle ${traceRef.entity.id}.`,
          path: input.sourcePath
        })
      );
    }
  }
}

async function loadOracles(input: {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId;
}): Promise<readonly OracleArtifactSuccess[] | TraceabilityValidationFailure> {
  const manifest = await deriveOracleManifest(input);
  if (!manifest.ok) return failure(manifest.status === "not_found" ? "not_found" : "invalid", manifest.diagnostics);

  const oracles: OracleArtifactSuccess[] = [];
  for (const revision of manifest.manifest.oracles) {
    const oracleId = oracleIdFromPath(revision.artifact.path);
    if (oracleId === undefined) {
      return failure("invalid", [
        traceabilityDiagnostic({
          code: "invalid_oracle_manifest_path",
          message: `Oracle manifest contains a path that does not end in an oracle ID: ${revision.artifact.path}.`,
          path: revision.artifact.path
        })
      ]);
    }
    const oracle = await readOracleArtifact({
      repositoryRoot: input.repositoryRoot,
      changeId: input.changeId,
      oracleId
    });
    if (!oracle.ok) return failure(oracle.status === "not_found" ? "not_found" : "invalid", oracle.diagnostics);
    oracles.push(oracle);
  }

  return oracles.sort((left, right) => compareStrings(left.document.id, right.document.id));
}

async function loadTraceabilityArtifacts(input: {
  readonly repositoryRoot: string;
  readonly changeId: ChangeId;
}): Promise<LoadedTraceabilityArtifacts | TraceabilityValidationFailure> {
  const change = await loadChangeBundle(input);
  if (!change.ok) return failure(change.status === "not_found" ? "not_found" : "invalid", change.diagnostics);

  const currentSpecs = await listCurrentSpecs({ repositoryRoot: input.repositoryRoot });
  if (!currentSpecs.ok) return failure(currentSpecs.status === "not_found" ? "not_found" : "invalid", currentSpecs.diagnostics);

  const oracles = await loadOracles(input);
  if ("diagnostics" in oracles) return oracles;

  const taskGraph = await readTaskGraph(input);
  if (!taskGraph.ok) {
    if (taskGraph.status === "not_found") {
      return failure("invalid", [
        traceabilityDiagnostic({
          code: "missing_taskgraph",
          message: `Change ${input.changeId} has no taskgraph artifact.`,
          path: artifactPathForRole({ role: "taskgraph", changeId: input.changeId })
        })
      ]);
    }
    return failure("invalid", taskGraph.diagnostics);
  }

  const evidenceIndex = await readEvidenceIndex(input);
  if (!evidenceIndex.ok) {
    if (evidenceIndex.status === "not_found") {
      return failure("invalid", [
        traceabilityDiagnostic({
          code: "missing_evidence_index",
          message: `Change ${input.changeId} has no evidence-index artifact.`,
          path: artifactPathForRole({ role: "evidence-index", changeId: input.changeId })
        })
      ]);
    }
    return failure("invalid", evidenceIndex.diagnostics);
  }

  return { currentSpecs, change, oracles, taskGraph, evidenceIndex };
}

export async function validateChangeTraceability(input: ValidateChangeTraceabilityInput): Promise<TraceabilityValidationResult> {
  const changeId = parseChangeId(input.changeId);
  if (typeof changeId !== "string") return changeId;

  const loaded = await loadTraceabilityArtifacts({
    repositoryRoot: input.repositoryRoot,
    changeId
  });
  if ("diagnostics" in loaded) return loaded;

  const report = buildGraph(loaded);
  if (report.diagnostics.length > 0) return failure("invalid", report.diagnostics, report);

  return {
    ok: true,
    status: "validated",
    report,
    diagnostics: []
  };
}

function externalId(node: TraceabilityNode): string {
  return node.id.slice(node.id.indexOf(":") + 1);
}

function sortedIds<T extends string>(values: Iterable<T>): readonly T[] {
  return [...new Set(values)].sort(compareStrings);
}

export function analyzeTraceabilityImpact(input: TraceabilityImpactInput): TraceabilityImpactReport {
  const nodesById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const requirementFilter = new Set(input.changedRequirementIds ?? []);
  const start = new Set<string>();
  const changedArtifactNodeId = nodeId("artifact", String(input.changedArtifactPath));
  const requirementsDefinedByChangedArtifact = new Set(
    input.graph.edges
      .filter((edge) => edge.from === changedArtifactNodeId && edge.relation === "defines")
      .map((edge) => edge.to)
  );

  for (const node of input.graph.nodes) {
    const pathMatches = node.source.path === input.changedArtifactPath || node.artifact?.path === input.changedArtifactPath;
    if (requirementFilter.size > 0) {
      if (node.kind !== "requirement") continue;
      if (!requirementFilter.has(externalId(node))) continue;
      if (!pathMatches && !requirementsDefinedByChangedArtifact.has(node.id)) continue;
      start.add(node.id);
      continue;
    }
    if (pathMatches) start.add(node.id);
  }

  const downstream = new Map<string, string[]>();
  for (const edge of input.graph.edges) {
    const existing = downstream.get(edge.from) ?? [];
    existing.push(edge.to);
    downstream.set(edge.from, existing);
  }

  const visited = new Set<string>();
  const queue = [...start].sort(compareStrings);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const next of downstream.get(current) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
    queue.sort(compareStrings);
  }

  const affectedNodes = [...visited].map((id) => nodesById.get(id)).filter((node): node is TraceabilityNode => node !== undefined);
  return {
    changedArtifactPath: input.changedArtifactPath,
    affectedRequirements: sortedIds(affectedNodes.filter((node) => node.kind === "requirement").map((node) => externalId(node) as RequirementId)),
    affectedOracles: sortedIds(affectedNodes.filter((node) => node.kind === "oracle").map((node) => externalId(node) as OracleId)),
    affectedTasks: sortedIds(affectedNodes.filter((node) => node.kind === "task").map((node) => externalId(node) as ContractId)),
    affectedEvidence: sortedIds(affectedNodes.filter((node) => node.kind === "evidence").map((node) => externalId(node) as EvidenceId)),
    affectedReviews: sortedIds(affectedNodes.filter((node) => node.kind === "review").map((node) => externalId(node) as ReviewId)),
    affectedArtifacts: sortedIds(affectedNodes.filter((node) => node.kind === "artifact").map((node) => node.source.path))
  };
}

export function renderTraceabilityReport(report: TraceabilityReport): string {
  const diagnostics = report.diagnostics.length === 0
    ? ["- Diagnostics: none"]
    : report.diagnostics.map((diagnostic) => `- ${diagnostic.code}: ${diagnostic.message} (${diagnostic.source.path})`);

  return [
    `# Traceability Report: ${report.changeId}`,
    "",
    `- Requirements: ${report.summary.requirements}`,
    `- Oracles: ${report.summary.oracles}`,
    `- Tasks: ${report.summary.tasks}`,
    `- Evidence bundles: ${report.summary.evidence}`,
    `- Accepted evidence: ${report.summary.acceptedEvidence}`,
    `- Reviews: ${report.summary.reviews}`,
    "",
    "## Diagnostics",
    "",
    ...diagnostics,
    ""
  ].join("\n");
}
