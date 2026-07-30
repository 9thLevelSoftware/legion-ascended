import assert from "node:assert/strict";
import { test } from "node:test";

import {
  intakeNodeIdSchema,
  intakeSessionSchema,
  intakeSlotIdSchema
} from "../packages/protocol/dist/index.js";
import {
  MAX_CRITERIA_PER_REQUIREMENT,
  MAX_REQUIREMENTS,
  allGraphNodeIds,
  isInjectedNodeId,
  materializeNodes,
  nextNode
} from "../packages/cli/dist/workflow/intake/graph.js";
import {
  createSession,
  graphVersionMismatch,
  pruneOrphanedAnswers,
  recordAnswer,
  stepBack
} from "../packages/cli/dist/workflow/intake/session.js";
import {
  parseCommandLine,
  requirementDrafts,
  validateAnswer,
  validateAnswerSet
} from "../packages/cli/dist/workflow/intake/validators.js";
import { buildRequirements, renderRoadmap } from "../packages/cli/dist/workflow/intake/finalize.js";

/**
 * The graph is data, so most of it is checkable without touching a filesystem.
 *
 * The first test here exists because it was missing: four slots shipped in
 * camelCase, which the protocol's slot pattern forbids, and the failure only
 * surfaced two thirds of the way through a manual interview. Anything the
 * protocol constrains about a node should be asserted against the protocol
 * rather than against a reading of it.
 */

const SCHEMA_VERSION = "0.2.0";
const CREATED_AT = "2026-07-30T12:00:00.000Z";

function answer(nodeId, slot, value) {
  return { nodeId, slot, value, answeredAt: CREATED_AT, source: "human" };
}

/** Drive the graph with a lookup, the way `--intake` does. */
function driveTo(values, { stopAt } = {}) {
  let answers = [];
  for (;;) {
    const { node } = nextNode({ answers, injectedNodes: [] });
    if (node === undefined) break;
    if (stopAt !== undefined && node.id === stopAt) break;
    if (!(node.id in values)) {
      if (!node.required) {
        answers = [...answers, answer(node.id, node.slot, "")];
        continue;
      }
      throw new Error(`no scripted answer for required node ${node.id}`);
    }
    const validated = validateAnswer(node, values[node.id]);
    assert.notEqual(validated.value, undefined, `${node.id} rejected: ${JSON.stringify(validated.diagnostics)}`);
    answers = [...answers, answer(node.id, node.slot, validated.value)];
  }
  return answers;
}

const COMPLETE_ANSWERS = {
  "project-name": "Asset Mapper",
  "project-summary": "Deterministic asset resolution.",
  "project-owner": "dasbl",
  "problem-statement": "Renames silently break downstream builds.",
  "problem-users": "Pipeline engineers.",
  "problem-success": "A broken reference fails at build time, loudly.",
  "req-1-statement": "Resolution fails loudly when an asset is missing",
  "req-1-priority": "must",
  "req-1-category": "behavior",
  "req-1-ac-1-statement": "Resolving a missing asset exits non-zero",
  "req-1-ac-1-proof": "executable",
  "req-1-ac-1-detail": "pnpm test --filter resolver",
  "req-1-ac-1-more": false,
  "req-1-more": false,
  "non-goals": "Automatic renaming",
  constraints: "TypeScript only",
  "risk-tier": "R2",
  "risk-reason": "Every downstream consumer is affected.",
  "budget-files": "12",
  "budget-lines": "600",
  "budget-new-files": "4",
  "pref-verification": "pnpm test"
};

test("every graph node satisfies the protocol's node and slot patterns", () => {
  // Materialized at full depth, so loop-generated IDs are covered too — those
  // are the ones a hand audit misses.
  let answers = [];
  for (let requirement = 1; requirement <= 3; requirement += 1) {
    answers.push(answer(`req-${requirement}-priority`, `requirements.${requirement}.priority`, "must"));
    answers.push(answer(`req-${requirement}-more`, `requirements.${requirement}.more`, true));
    for (let criterion = 1; criterion <= 3; criterion += 1) {
      answers.push(
        answer(
          `req-${requirement}-ac-${criterion}-more`,
          `requirements.${requirement}.criteria.${criterion}.more`,
          true
        )
      );
    }
  }

  const nodes = materializeNodes({ answers, injectedNodes: [] });
  assert.ok(nodes.length > 20, "the deep graph should materialize many nodes");

  for (const node of nodes) {
    assert.doesNotThrow(
      () => intakeNodeIdSchema.parse(node.id),
      `node ID ${node.id} is not a valid intake node ID`
    );
    assert.doesNotThrow(
      () => intakeSlotIdSchema.parse(node.slot),
      `slot ${node.slot} on node ${node.id} is not a valid intake slot ID`
    );
  }
});

test("node IDs stay unique across the whole materialized graph", () => {
  const answers = [];
  for (let requirement = 1; requirement <= 4; requirement += 1) {
    answers.push(answer(`req-${requirement}-priority`, `requirements.${requirement}.priority`, "must"));
    answers.push(answer(`req-${requirement}-more`, `requirements.${requirement}.more`, true));
  }
  const nodes = materializeNodes({ answers, injectedNodes: [] });
  const ids = nodes.map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate node IDs would make answers ambiguous");
});

test("the loops are bounded", () => {
  const answers = [];
  for (let requirement = 1; requirement <= MAX_REQUIREMENTS + 5; requirement += 1) {
    answers.push(answer(`req-${requirement}-priority`, `requirements.${requirement}.priority`, "must"));
    answers.push(answer(`req-${requirement}-more`, `requirements.${requirement}.more`, true));
    for (let criterion = 1; criterion <= MAX_CRITERIA_PER_REQUIREMENT + 5; criterion += 1) {
      answers.push(
        answer(
          `req-${requirement}-ac-${criterion}-more`,
          `requirements.${requirement}.criteria.${criterion}.more`,
          true
        )
      );
    }
  }

  const nodes = materializeNodes({ answers, injectedNodes: [] });
  const requirementIndexes = nodes
    .map((node) => /^req-(\d+)-statement$/.exec(node.id)?.[1])
    .filter((value) => value !== undefined)
    .map(Number);
  assert.equal(Math.max(...requirementIndexes), MAX_REQUIREMENTS);
});

test("a 'wont' requirement skips the acceptance-criteria loop", () => {
  const answers = [
    answer("req-1-priority", "requirements.1.priority", "wont"),
    answer("req-1-more", "requirements.1.more", false)
  ];
  const nodes = materializeNodes({ answers, injectedNodes: [] });
  const criterionNodes = nodes.filter((node) => node.id.startsWith("req-1-ac-"));

  // The nodes are materialized; `dependsOn` is the single thing that excludes
  // them. Asserting on the node list alone would pass even if applicability
  // were broken, so this walks the interview the way `nextNode` does.
  const asked = [];
  let cursor = answers;
  for (;;) {
    const { node } = nextNode({ answers: cursor, injectedNodes: [] });
    if (node === undefined) break;
    asked.push(node.id);
    cursor = [...cursor, answer(node.id, node.slot, node.kind === "confirm" ? false : "x")];
    if (asked.length > 200) break;
  }

  assert.ok(criterionNodes.length > 0, "criterion nodes exist in the node list");
  assert.equal(
    asked.filter((id) => id.startsWith("req-1-ac-")).length,
    0,
    "a requirement nobody will build should not be asked how it is proven"
  );
});

test("a 'must' requirement without acceptance criteria cannot finalize", () => {
  // Reconstructed directly rather than driven through the graph: the graph
  // always asks for one criterion, so this is the batch/imported path where a
  // requirement can arrive with none.
  const answers = [
    answer("req-1-statement", "requirements.1.statement", "It must be fast"),
    answer("req-1-priority", "requirements.1.priority", "must"),
    answer("req-1-category", "requirements.1.category", "quality")
  ];

  const diagnostics = validateAnswerSet({ answers });
  assert.ok(
    diagnostics.some((entry) => entry.code === "must_without_criteria"),
    `expected must_without_criteria, got ${JSON.stringify(diagnostics)}`
  );
});

test("a manual criterion needs a real reason", () => {
  const base = driveTo({
    ...COMPLETE_ANSWERS,
    "req-1-ac-1-proof": "manual",
    "req-1-ac-1-detail": "Message wording is a judgement call no assertion should freeze."
  });
  assert.deepEqual(validateAnswerSet({ answers: base }), []);

  for (const excuse of ["tbd", "n/a", "later", "none", "short"]) {
    const weakened = base.map((entry) =>
      entry.nodeId === "req-1-ac-1-detail" ? { ...entry, value: excuse } : entry
    );
    const diagnostics = validateAnswerSet({ answers: weakened });
    assert.ok(
      diagnostics.some((entry) => entry.code === "empty_manual_reason"),
      `"${excuse}" should not pass as a reason, got ${JSON.stringify(diagnostics)}`
    );
  }
});

test("an executable criterion must be a command the runner could actually run", () => {
  assert.deepEqual(parseCommandLine("pnpm test --filter core"), {
    command: "pnpm",
    args: ["test", "--filter", "core"]
  });
  assert.deepEqual(parseCommandLine('node -e "process.exit(0)"'), {
    command: "node",
    args: ["-e", "process.exit(0)"]
  });

  // Verification spawns with `shell: false`, so shell syntax would be passed
  // through as a literal argument and the second command would never run.
  for (const shellish of ["a && b", "a || b", "a; b", "a | b", "a > out", "echo $HOME"]) {
    assert.ok("error" in parseCommandLine(shellish), `${shellish} should be refused`);
  }
  assert.ok("error" in parseCommandLine('node -e "unclosed'));
  assert.ok("error" in parseCommandLine("   "));
});

test("a budget that cannot be satisfied is rejected", () => {
  const answers = driveTo({ ...COMPLETE_ANSWERS, "budget-files": "3", "budget-new-files": "9" });
  const diagnostics = validateAnswerSet({ answers });
  assert.ok(
    diagnostics.some((entry) => entry.code === "budget_inconsistent"),
    `expected budget_inconsistent, got ${JSON.stringify(diagnostics)}`
  );
});

test("answers are validated as they are given, not only at finalize", () => {
  const { node } = nextNode({
    answers: driveTo(COMPLETE_ANSWERS, { stopAt: "budget-files" }),
    injectedNodes: []
  });
  assert.equal(node?.id, "budget-files");

  assert.equal(validateAnswer(node, "twelve").value, undefined);
  assert.equal(validateAnswer(node, "0").value, undefined);
  assert.equal(validateAnswer(node, "-3").value, undefined);
  assert.equal(validateAnswer(node, "12").value, "12");
});

test("a single-choice node refuses a value that is not on offer", () => {
  const { node } = nextNode({
    answers: driveTo(COMPLETE_ANSWERS, { stopAt: "req-1-priority" }),
    injectedNodes: []
  });
  assert.equal(node?.id, "req-1-priority");
  assert.equal(validateAnswer(node, "critical").value, undefined);
  assert.equal(validateAnswer(node, "must").value, "must");
});

test("withdrawing a requirement drops the answers it left behind", () => {
  const twoRequirements = driveTo({
    ...COMPLETE_ANSWERS,
    "req-1-more": true,
    "req-2-statement": "It must also be documented",
    "req-2-priority": "should",
    "req-2-category": "documentation",
    "req-2-ac-1-statement": "The README describes resolution",
    "req-2-ac-1-proof": "manual",
    "req-2-ac-1-detail": "Prose quality is not something a command can decide.",
    "req-2-ac-1-more": false,
    "req-2-more": false
  });
  assert.equal(requirementDrafts(twoRequirements).length, 2);

  // Flip requirement 1's controller back to "no". Without pruning, requirement
  // 2's answers survive and reappear in the contract.
  const session = createSession({ createdAt: CREATED_AT, schemaVersion: SCHEMA_VERSION }).session;
  let current = intakeSessionSchema.parse({ ...session, answers: twoRequirements, cursor: undefined });
  current = pruneOrphanedAnswers(
    intakeSessionSchema.parse({
      ...current,
      answers: current.answers.map((entry) =>
        entry.nodeId === "req-1-more" ? { ...entry, value: false } : entry
      )
    })
  );

  assert.equal(requirementDrafts(current.answers).length, 1);
  assert.equal(
    current.answers.some((entry) => entry.nodeId.startsWith("req-2-")),
    false,
    "a withdrawn requirement must not survive as stale answers"
  );
});

test("stepping back undoes the most recent answer", () => {
  let session = createSession({ createdAt: CREATED_AT, schemaVersion: SCHEMA_VERSION }).session;
  for (const [nodeId, value] of [
    ["project-name", "Asset Mapper"],
    ["project-summary", "Deterministic resolution."]
  ]) {
    const recorded = recordAnswer({ session, nodeId, value, answeredAt: CREATED_AT });
    assert.equal(recorded.ok, true, recorded.reason);
    session = recorded.session;
  }
  assert.equal(session.cursor, "project-owner");

  const stepped = stepBack(session);
  assert.equal(stepped.ok, true);
  assert.equal(stepped.nodeId, "project-summary");
  assert.equal(stepped.session.cursor, "project-summary");
  assert.equal(stepped.session.answers.length, 1);
});

test("the cursor is derived from the answers, so a resumed session cannot disagree", () => {
  const answers = driveTo(COMPLETE_ANSWERS, { stopAt: "risk-tier" });
  const session = createSession({ createdAt: CREATED_AT, schemaVersion: SCHEMA_VERSION }).session;
  const resumed = pruneOrphanedAnswers(
    intakeSessionSchema.parse({ ...session, answers, cursor: "project-name" })
  );

  // A hand-edited cursor is ignored; `nextNode` recomputes from the answers.
  const { node } = nextNode({ answers: resumed.answers, injectedNodes: resumed.injectedNodes });
  assert.equal(node?.id, "risk-tier");
});

test("an exploration adds questions and never removes them", () => {
  const exploration = {
    schemaVersion: SCHEMA_VERSION,
    createdAt: CREATED_AT,
    kind: "exploration",
    runId: "run_explore-1",
    status: "exploratory",
    entry: "raw-idea",
    topic: "asset mapping",
    summary: "An idea about resolving assets.",
    proposals: [
      {
        slot: "project.name",
        value: "Asset Mapper",
        rationale: "The topic named it.",
        anchor: "framing",
        confidence: "inferred"
      }
    ],
    openQuestions: [
      {
        nodeId: "which-runtime",
        slot: "open.runtime",
        question: "Which runtime must this support?",
        why: "The exploration assumed Node but never checked."
      }
    ],
    notes: []
  };

  const seeded = createSession({
    createdAt: CREATED_AT,
    schemaVersion: SCHEMA_VERSION,
    exploration,
    explorationArtifact: { path: ".legion/project/workflow/explore/x/exploration.json", sha256: `sha256:${"0".repeat(64)}` }
  });

  // The proposal is a suggestion, not an answer: the node is still asked.
  assert.equal(seeded.session.answers.length, 0);
  assert.equal(seeded.session.cursor, "project-name");
  assert.equal(seeded.proposals.get("project.name")?.value, "Asset Mapper");

  // The open question became a required node, so a fuzzier exploration produces
  // a longer interview.
  assert.equal(seeded.session.injectedNodes.length, 1);
  const withInjected = materializeNodes({ answers: [], injectedNodes: seeded.session.injectedNodes });
  const withoutInjected = materializeNodes({ answers: [], injectedNodes: [] });
  assert.equal(withInjected.length, withoutInjected.length + 1);
  // Namespaced on the way in, so a slugified open question can never shadow a
  // built-in node.
  assert.equal(withInjected.at(-1)?.id, "open-which-runtime");
  assert.equal(withInjected.at(-1)?.required, true);
});

test("a completed interview builds requirements that match the protocol", () => {
  const answers = driveTo({
    ...COMPLETE_ANSWERS,
    "req-1-more": true,
    "req-2-statement": "Rewriting history to hide a broken reference is out of scope",
    "req-2-priority": "wont",
    "req-2-category": "constraint",
    "req-2-more": false
  });
  assert.deepEqual(validateAnswerSet({ answers }), []);

  const requirements = buildRequirements({
    answers,
    projectId: "prj_asset-mapper",
    createdAt: CREATED_AT,
    schemaVersion: SCHEMA_VERSION,
    intakeSessionPath: ".legion/project/intake/itk_x/session.json"
  });

  assert.equal(requirements.length, 2);
  const [built, declined] = requirements;

  assert.equal(built.status, "accepted");
  assert.equal(built.priority, "must");
  assert.deepEqual(built.acceptance.criteria[0].proof, {
    mode: "executable",
    command: "pnpm",
    args: ["test", "--filter", "resolver"],
    expectedExitCode: 0
  });

  // A `wont` requirement is a recorded decision, not a plan.
  assert.equal(declined.status, "rejected");
  assert.equal(declined.priority, "wont");
  assert.equal(declined.acceptance.criteria[0].proof.mode, "manual");
});

test("the rendered roadmap satisfies the validator its own docs specify", () => {
  const answers = driveTo(COMPLETE_ANSWERS);
  const requirements = buildRequirements({
    answers,
    projectId: "prj_asset-mapper",
    createdAt: CREATED_AT,
    schemaVersion: SCHEMA_VERSION,
    intakeSessionPath: ".legion/project/intake/itk_x/session.json"
  });
  const roadmap = renderRoadmap({
    projectName: "Asset Mapper",
    answers,
    requirements,
    intakeSessionId: "itk_x"
  });

  // commands/validate.md requires a table whose header names Phase and Status,
  // plus Name or Requirements. The shipped template emitted a header its own
  // validator rejected.
  const header = roadmap.split("\n").find((line) => /^\|\s*Phase\s*\|/i.test(line));
  assert.ok(header !== undefined, "the roadmap must contain a phase table");
  assert.match(header, /Status/i);
  assert.ok(/Name/i.test(header) || /Requirements/i.test(header));

  // `resolvePhaseSource` greps for this heading shape; a roadmap that does not
  // carry it cannot be planned against.
  assert.match(roadmap, /^## Phase 1: /m);
});

test("an exploration cannot inject a node ID the graph already uses", () => {
  // Open questions become node IDs by slugifying their text, so a question
  // phrased "Project name?" lands on `project-name`. Answers are keyed by node
  // ID, so the collision would make answering the built-in question mark the
  // injected one answered — and the operator would never be asked something the
  // exploration explicitly flagged as unresolved.
  const exploration = {
    schemaVersion: SCHEMA_VERSION,
    createdAt: CREATED_AT,
    kind: "exploration",
    runId: "run_explore-collide",
    status: "exploratory",
    entry: "raw-idea",
    topic: "collision",
    summary: "An exploration whose open questions collide with the graph.",
    proposals: [],
    openQuestions: [
      { nodeId: "project-name", slot: "open.a", question: "Project name?", why: "unsettled" },
      { nodeId: "req-1-statement", slot: "open.b", question: "First requirement?", why: "unsettled" },
      { nodeId: "project-name", slot: "open.c", question: "Project name, again?", why: "unsettled" }
    ],
    notes: []
  };

  const { session } = createSession({
    createdAt: CREATED_AT,
    schemaVersion: SCHEMA_VERSION,
    exploration
  });

  const graphIds = new Set(allGraphNodeIds());
  const injectedIds = session.injectedNodes.map((node) => node.nodeId);

  assert.equal(injectedIds.length, 3);
  assert.equal(new Set(injectedIds).size, 3, "injected IDs must stay unique among themselves");
  for (const id of injectedIds) {
    assert.equal(graphIds.has(id), false, `${id} collides with a graph node`);
    assert.doesNotThrow(() => intakeNodeIdSchema.parse(id), `${id} is not a valid node ID`);
  }

  // Every injected question is still asked, which is the invariant the
  // collision would have broken.
  const nodes = materializeNodes({ answers: [], injectedNodes: session.injectedNodes });
  const ids = nodes.map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, "materialized IDs must be unique");
  for (const id of injectedIds) assert.ok(ids.includes(id), `${id} should be asked`);
});

test("the graph never emits an ID inside the injected namespace", () => {
  // The namespace is only a guarantee if the graph stays out of it.
  for (const id of allGraphNodeIds()) {
    assert.equal(
      isInjectedNodeId(id),
      false,
      `graph node ${id} sits in the namespace reserved for injected questions`
    );
  }
});

test("an active session pinned to another graph version is refused", () => {
  const { session } = createSession({ createdAt: CREATED_AT, schemaVersion: SCHEMA_VERSION });
  assert.equal(graphVersionMismatch(session), undefined);

  // Answers given under one graph were given to different questions. Running
  // them against a new graph would silently reinterpret them, which is the
  // failure the pinning exists to catch.
  const stale = intakeSessionSchema.parse({ ...session, graphVersion: "0.9.0" });
  assert.match(graphVersionMismatch(stale) ?? "", /0\.9\.0/);
  assert.match(graphVersionMismatch(stale) ?? "", /--abort/);

  // A finalized session is a record, not work in progress. Refusing to read it
  // after an upgrade would make history unreadable.
  const finalized = intakeSessionSchema.parse({
    ...stale,
    status: "finalized",
    projectId: "prj_asset-mapper",
    cursor: undefined
  });
  assert.equal(graphVersionMismatch(finalized), undefined);
});

test("the criterion cap is not asked as a question that does nothing", () => {
  // At the cap the graph used to still ask "another?" and then ignore an
  // affirmative answer, so an operator could explicitly request a criterion and
  // finalize a contract that silently omitted it. The limit has to show up as
  // an absent question rather than a dead one.
  const answers = [answer("req-1-priority", "requirements.1.priority", "must")];
  for (let criterion = 1; criterion < MAX_CRITERIA_PER_REQUIREMENT; criterion += 1) {
    answers.push(
      answer(`req-1-ac-${criterion}-more`, `requirements.1.criteria.${criterion}.more`, true)
    );
  }

  const ids = materializeNodes({ answers, injectedNodes: [] }).map((node) => node.id);
  assert.ok(
    ids.includes(`req-1-ac-${MAX_CRITERIA_PER_REQUIREMENT}-statement`),
    "the last permitted criterion is still asked"
  );
  assert.equal(
    ids.includes(`req-1-ac-${MAX_CRITERIA_PER_REQUIREMENT}-more`),
    false,
    "the cap must not be presented as a question whose answer is discarded"
  );
  assert.ok(
    ids.includes(`req-1-ac-${MAX_CRITERIA_PER_REQUIREMENT - 1}-more`),
    "below the cap the question is still asked"
  );
});
