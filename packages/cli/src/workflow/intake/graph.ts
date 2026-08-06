/**
 * The `legion start` interview, as data.
 *
 * The CLI owns this graph. A model renders the current node and relays an
 * answer; it does not decide what is asked, in what order, or when the
 * interview is finished. That inversion is the point: an interview owned by a
 * conversation ends when the conversation gets bored, and the failure mode is
 * silent — a project initialized from three questions looks exactly like one
 * initialized from thirty.
 *
 * Every node is serializable. `dependsOn` is a declarative condition rather
 * than a predicate function so that `legion start --next --json` can emit the
 * node and a host can render it without executing anything, and so the graph
 * can be diffed between versions.
 *
 * The graph is materialized, not stored: `materializeNodes` computes the full
 * ordered node list from the static templates plus the answers so far. Loop
 * instances therefore have deterministic IDs, and "what is the next question"
 * is a pure function of recorded state rather than of who is asking.
 */

import type { IntakeAnswer, IntakeInjectedNode } from "@legion/protocol";

/**
 * Bumped whenever the node set, ordering, or slot meanings change. Sessions pin
 * the version they started under so a graph change cannot silently rewrite the
 * meaning of answers already given.
 */
export const INTAKE_GRAPH_VERSION = "1.1.0";

export const INTAKE_SECTIONS = [
  "identity",
  "problem",
  "requirements",
  "non-goals",
  "constraints",
  "risk",
  "budget",
  "preferences",
  "open-questions"
] as const;

export type IntakeSection = (typeof INTAKE_SECTIONS)[number];

export type IntakeNodeKind = "single" | "multi" | "free-text" | "confirm";

export interface IntakeOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/**
 * A condition on an earlier answer.
 *
 * Kept declarative so the graph stays inspectable. `equals` and `notEquals`
 * compare against a scalar answer; a node that depends on a multi-select is not
 * expressible in 1.0.0 and is deliberately absent rather than half-supported.
 */
export type IntakeCondition =
  | { readonly nodeId: string; readonly equals: string | boolean }
  | { readonly nodeId: string; readonly notEquals: string | boolean };

export interface IntakeNode {
  readonly id: string;
  readonly section: IntakeSection;
  readonly slot: string;
  readonly prompt: string;
  readonly help?: string;
  readonly kind: IntakeNodeKind;
  readonly options?: readonly IntakeOption[];
  readonly required: boolean;
  readonly dependsOn?: IntakeCondition;
  /** Present on nodes appended by a brainstorm; absent on graph nodes. */
  readonly injected?: boolean;
}

/** The protocol caps an intake node ID at 64 characters. */
export const MAX_NODE_ID_LENGTH = 64;

/**
 * Loop bounds.
 *
 * An interview whose length is chosen by the interviewee is not bounded, and an
 * unbounded interview is one nobody finishes. These caps also keep generated
 * node IDs inside `MAX_NODE_ID_LENGTH`.
 */
export const MAX_REQUIREMENTS = 40;
export const MAX_CRITERIA_PER_REQUIREMENT = 20;

const PRIORITY_OPTIONS: readonly IntakeOption[] = [
  { value: "must", label: "Must", description: "The project fails without it." },
  { value: "should", label: "Should", description: "Painful to omit, but survivable." },
  { value: "could", label: "Could", description: "Worth doing if it is cheap." },
  { value: "wont", label: "Won't", description: "Recorded so it stays decided, and out of scope." }
];

const CATEGORY_OPTIONS: readonly IntakeOption[] = [
  { value: "behavior", label: "Behavior", description: "What the system does." },
  { value: "constraint", label: "Constraint", description: "A limit it must respect." },
  { value: "compatibility", label: "Compatibility", description: "What it must keep working with." },
  { value: "security", label: "Security", description: "What it must not permit." },
  { value: "migration", label: "Migration", description: "Moving existing state or callers." },
  { value: "quality", label: "Quality", description: "Performance, reliability, accessibility." },
  { value: "documentation", label: "Documentation", description: "What must be written down." }
];

const PROOF_OPTIONS: readonly IntakeOption[] = [
  {
    value: "executable",
    label: "A command decides it",
    description: "A command that exits zero when the criterion holds and non-zero when it does not."
  },
  {
    value: "manual",
    label: "A human decides it",
    description: "No command can decide it. You will be asked why, and the gap stays visible."
  }
];

/**
 * What a criterion's command reaches.
 *
 * Mirrors `verificationSurfaceKindSchema`. The descriptions carry the
 * consequence rather than only the definition, because the consequence is what
 * an operator needs at the moment of answering: `unit` is a real answer that a
 * risk-tier-R2 change's integration gate reads as a recorded "no", and finding
 * that out two commands later at `legion ship` is finding it out too late.
 */
const SURFACE_OPTIONS: readonly IntakeOption[] = [
  {
    value: "unit",
    label: "Unit — nothing outside this codebase",
    description:
      "Exercises code in this repository only. At risk tier R2 this is a recorded negative: the integration check reports unsatisfied, not unproven."
  },
  {
    value: "integration",
    label: "Integration — two of our own parts, really connected",
    description: "Crosses a boundary inside the system: a real database, a real queue, two services in one process."
  },
  {
    value: "real-interface",
    label: "Real interface — the actual thing production talks to",
    description: "No stub, no mock, no recorded fixture: the live protocol, API or driver."
  },
  {
    value: "end-to-end",
    label: "End to end — the whole path a user takes",
    description: "Entry point to observable outcome, through everything in between."
  }
];

const RISK_OPTIONS: readonly IntakeOption[] = [
  { value: "R0", label: "R0 — trivial", description: "Local, reversible, no external effect." },
  { value: "R1", label: "R1 — routine", description: "Ordinary change to existing behavior." },
  { value: "R2", label: "R2 — significant", description: "New surface, or behavior others depend on." },
  { value: "R3", label: "R3 — critical", description: "Data, money, credentials, or anything hard to undo." }
];

const YES_NO_HELP = "Answer with true or false.";

/**
 * Nodes asked before the requirements loop.
 *
 * Identity is first because it is cheap and orienting. The problem section sits
 * between identity and requirements on purpose: stating who is hurt and how you
 * would know it stopped is what makes the requirements that follow answerable.
 */
const OPENING_NODES: readonly IntakeNode[] = [
  {
    id: "project-name",
    section: "identity",
    slot: "project.name",
    prompt: "What is this project called?",
    kind: "free-text",
    required: true
  },
  {
    id: "project-summary",
    section: "identity",
    slot: "project.summary",
    prompt: "Summarize it in one or two sentences.",
    help: "This lands in project.json and heads every context pack an implementer sees.",
    kind: "free-text",
    required: true
  },
  {
    id: "project-owner",
    section: "identity",
    slot: "project.owner",
    prompt: "Who owns the decisions on this project?",
    help: "The person an implementer escalates to. Not necessarily whoever is typing.",
    kind: "free-text",
    required: true
  },
  {
    id: "problem-statement",
    section: "problem",
    slot: "problem.statement",
    prompt: "What problem does this solve?",
    help: "Describe the situation as it is now, not the solution you have in mind.",
    kind: "free-text",
    required: true
  },
  {
    id: "problem-users",
    section: "problem",
    slot: "problem.users",
    prompt: "Who has this problem?",
    kind: "free-text",
    required: true
  },
  {
    id: "problem-success",
    section: "problem",
    slot: "problem.success",
    prompt: "How will you know it worked?",
    help: "Answer concretely. This is the question the acceptance criteria below make executable.",
    kind: "free-text",
    required: true
  }
];

/** Nodes asked after the requirements loop. */
const CLOSING_NODES: readonly IntakeNode[] = [
  {
    id: "non-goals",
    section: "non-goals",
    slot: "scope.non-goals",
    prompt: "What is explicitly out of scope?",
    help: "One per line. Answer 'none' if nothing is worth ruling out yet — but consider that an unstated non-goal is the most common source of scope drift.",
    kind: "free-text",
    required: true
  },
  {
    id: "constraints",
    section: "constraints",
    slot: "constraints.text",
    prompt: "What constraints must the implementation respect?",
    help: "Language, runtime, dependencies it may not add, systems it may not touch. One per line, or 'none'.",
    kind: "free-text",
    required: true
  },
  {
    id: "risk-tier",
    section: "risk",
    slot: "risk.tier",
    prompt: "How risky is the riskiest thing this project will do?",
    help: "This sets the default gate set. It can be raised per change; lowering it later requires an audited override.",
    kind: "single",
    options: RISK_OPTIONS,
    required: true
  },
  {
    id: "risk-reason",
    section: "risk",
    slot: "risk.reason",
    prompt: "Why that tier?",
    help: "Recorded verbatim on the risk profile, so a later reader can judge whether the tier still fits.",
    kind: "free-text",
    required: true
  },
  {
    id: "budget-files",
    section: "budget",
    slot: "budget.max-files-changed",
    prompt: "At most how many files should a single task change?",
    help: "A task that exceeds its budget is blocked, not warned. Small numbers force decomposition, which is the point.",
    kind: "free-text",
    required: true
  },
  {
    id: "budget-lines",
    section: "budget",
    slot: "budget.max-lines-changed",
    prompt: "At most how many lines should a single task change?",
    kind: "free-text",
    required: true
  },
  {
    id: "budget-new-files",
    section: "budget",
    slot: "budget.max-new-files",
    prompt: "At most how many new files should a single task create?",
    kind: "free-text",
    required: true
  },
  {
    id: "pref-verification",
    section: "preferences",
    slot: "preferences.verification",
    prompt: "What command verifies the whole project?",
    help: "The command a task runs to prove it did not break anything — a test script, a build, a lint. It becomes the default verification on generated task contracts.",
    kind: "free-text",
    required: true
  },
  {
    id: "pref-notes",
    section: "preferences",
    slot: "preferences.notes",
    prompt: "Anything else an implementer should know before touching this code?",
    help: "Optional. Skip it with --skip if nothing comes to mind.",
    kind: "free-text",
    required: false
  }
];

function requirementNodes(index: number): readonly IntakeNode[] {
  return [
    {
      id: `req-${index}-statement`,
      section: "requirements",
      slot: `requirements.${index}.statement`,
      prompt: `Requirement ${index}: what must be true when this is done?`,
      help: "State one testable fact. If it needs an 'and', it is probably two requirements.",
      kind: "free-text",
      required: true
    },
    {
      id: `req-${index}-priority`,
      section: "requirements",
      slot: `requirements.${index}.priority`,
      prompt: `Requirement ${index}: how important is it?`,
      kind: "single",
      options: PRIORITY_OPTIONS,
      required: true
    },
    {
      id: `req-${index}-category`,
      section: "requirements",
      slot: `requirements.${index}.category`,
      prompt: `Requirement ${index}: what kind of requirement is it?`,
      kind: "single",
      options: CATEGORY_OPTIONS,
      required: true
    }
  ];
}

function criterionNodes(
  requirementIndex: number,
  criterionIndex: number,
  askForAnother = true
): readonly IntakeNode[] {
  const prefix = `req-${requirementIndex}-ac-${criterionIndex}`;
  const slotPrefix = `requirements.${requirementIndex}.criteria.${criterionIndex}`;
  // Every criterion node hangs off the priority answer, so a `wont` requirement
  // skips the whole loop rather than asking how a thing nobody will build is
  // proven.
  const notWont: IntakeCondition = { nodeId: `req-${requirementIndex}-priority`, notEquals: "wont" };

  return [
    {
      id: `${prefix}-statement`,
      section: "requirements",
      slot: `${slotPrefix}.statement`,
      prompt: `Requirement ${requirementIndex}, criterion ${criterionIndex}: what specifically must hold?`,
      help: "Narrower than the requirement. Something a single check could decide.",
      kind: "free-text",
      required: true,
      dependsOn: notWont
    },
    {
      id: `${prefix}-proof`,
      section: "requirements",
      slot: `${slotPrefix}.proof`,
      prompt: `Requirement ${requirementIndex}, criterion ${criterionIndex}: how is it proven?`,
      kind: "single",
      options: PROOF_OPTIONS,
      required: true,
      dependsOn: notWont
    },
    {
      id: `${prefix}-detail`,
      section: "requirements",
      slot: `${slotPrefix}.detail`,
      prompt: `Requirement ${requirementIndex}, criterion ${criterionIndex}: the command, or the reason no command can decide it.`,
      help: "For a command, write it as you would type it — 'pnpm test --filter core'. Exit code 0 must mean the criterion holds.",
      kind: "free-text",
      required: true,
      dependsOn: notWont
    },
    // The verification surface, asked once per *executable* criterion and opted
    // into rather than demanded.
    //
    // `dependsOn` names the proof node and nothing else, and one condition
    // buys both exclusions this needs. `IntakeCondition` permits exactly one
    // clause per node, and `isNodeApplicable` treats an unanswered dependency as
    // not applicable — so a `manual` criterion answers `manual` and fails the
    // `equals`, while a `wont` requirement never answers `-proof` at all and
    // fails it transitively. Expressing the wont-skip structurally instead would
    // be the second conditionality mechanism `materializeNodes` warns against.
    //
    // Only the kind is optional. The three follow-ups hang off it having been
    // answered, so declining once removes all four, and answering commits to the
    // rest — a surface with a kind and no pin is a claim nothing can falsify,
    // which is strictly worse than the absence a gate reports honestly as
    // unevaluable. `notEquals: ""` is false both when the kind is unanswered and
    // when it was declined, since a skip records `SKIPPED_VALUE`.
    {
      id: `${prefix}-surface-kind`,
      section: "requirements",
      slot: `${slotPrefix}.surface.kind`,
      prompt: `Requirement ${requirementIndex}, criterion ${criterionIndex}: what does this command reach?`,
      help: "Optional. Skip it to leave the surface undeclared, and legion ship reports the integration check as unproven rather than as answered. Answering commits you to three short follow-ups.",
      kind: "single",
      options: SURFACE_OPTIONS,
      required: false,
      dependsOn: { nodeId: `${prefix}-proof`, equals: "executable" }
    },
    {
      id: `${prefix}-surface-interface`,
      section: "requirements",
      slot: `${slotPrefix}.surface.interface`,
      prompt: `Requirement ${requirementIndex}, criterion ${criterionIndex}: name the interface it reaches.`,
      help: "The thing on the other side of the boundary, as you would say it out loud: 'postgres:5432', 'POST /v1/orders', 'PricingEngine.quote()'. Quoted back to a reviewer; nothing parses it.",
      kind: "free-text",
      required: true,
      dependsOn: { nodeId: `${prefix}-surface-kind`, notEquals: "" }
    },
    {
      id: `${prefix}-surface-rationale`,
      section: "requirements",
      slot: `${slotPrefix}.surface.rationale`,
      prompt: `Requirement ${requirementIndex}, criterion ${criterionIndex}: what does reaching it catch that a smaller check would miss?`,
      help: "One sentence a reviewer can disagree with. Nothing verifies this claim; it is recorded so a human can refuse it.",
      kind: "free-text",
      required: true,
      dependsOn: { nodeId: `${prefix}-surface-kind`, notEquals: "" }
    },
    {
      id: `${prefix}-surface-pins`,
      section: "requirements",
      slot: `${slotPrefix}.surface.pins`,
      prompt: `Requirement ${requirementIndex}, criterion ${criterionIndex}: which files make that true?`,
      help: "Repository-relative paths, one per line or comma separated — the compose file that stands the real service up, the schema it is checked against, the harness that connects to it. Legion hashes them now and re-checks them at ship time, so the declaration stops being believed if they change. Name what makes the check real, not the file you are about to write.",
      kind: "free-text",
      required: true,
      dependsOn: { nodeId: `${prefix}-surface-kind`, notEquals: "" }
    },
    ...(askForAnother
      ? [
          {
            id: `${prefix}-more`,
            section: "requirements" as const,
            slot: `${slotPrefix}.more`,
            prompt: `Requirement ${requirementIndex}: is there another acceptance criterion?`,
            help: YES_NO_HELP,
            kind: "confirm" as const,
            required: true,
            dependsOn: notWont
          }
        ]
      : [])
  ];
}

function moreRequirementsNode(index: number): IntakeNode {
  return {
    id: `req-${index}-more`,
    section: "requirements",
    slot: `requirements.${index}.more`,
    prompt: "Is there another requirement?",
    help: YES_NO_HELP,
    kind: "confirm",
    required: true
  };
}

/**
 * The namespace every injected node ID lives in.
 *
 * Exploration derives node IDs by slugifying its own open questions, so a
 * question phrased "Project name?" produces `project-name` — the ID of a graph
 * node. Answers are keyed by node ID, so the collision would make answering the
 * built-in question mark the injected one answered, and the operator would
 * never be asked something the exploration explicitly flagged as unresolved.
 *
 * Namespacing is structural rather than a collision check because a check has
 * to know the full graph ID space, which includes loop-generated IDs that
 * depend on the answers so far. A reserved prefix needs to know nothing.
 */
export const INJECTED_NODE_PREFIX = "open-";

/** Node IDs the graph itself may never use, so injection can own them. */
export function isInjectedNodeId(nodeId: string): boolean {
  return nodeId.startsWith(INJECTED_NODE_PREFIX);
}

/**
 * Move a proposed injected node ID into the injected namespace.
 *
 * Idempotent, so an exploration that already produced a namespaced ID is left
 * alone rather than accumulating prefixes.
 */
export function namespaceInjectedNodeId(nodeId: string): string {
  if (isInjectedNodeId(nodeId)) return nodeId;
  const available = MAX_NODE_ID_LENGTH - INJECTED_NODE_PREFIX.length;
  const trimmed = nodeId.slice(0, available).replace(/-+$/g, "");
  return `${INJECTED_NODE_PREFIX}${trimmed.length > 0 ? trimmed : "question"}`;
}

export function injectedNodeToIntakeNode(node: IntakeInjectedNode): IntakeNode {
  return {
    id: node.nodeId,
    section: "open-questions",
    slot: node.slot,
    prompt: node.prompt,
    help: `Raised as unresolved during exploration ${node.origin.runId}.`,
    kind: "free-text",
    required: true,
    injected: true
  };
}

export interface MaterializeInput {
  readonly answers: readonly IntakeAnswer[];
  readonly injectedNodes: readonly IntakeInjectedNode[];
}

function answerMap(answers: readonly IntakeAnswer[]): ReadonlyMap<string, IntakeAnswer["value"]> {
  const map = new Map<string, IntakeAnswer["value"]>();
  for (const answer of answers) map.set(answer.nodeId, answer.value);
  return map;
}

/** `true` only when the answer is unambiguously affirmative. */
function isAffirmative(value: IntakeAnswer["value"] | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "yes" || normalized === "y";
}

/**
 * The full ordered node list implied by the answers so far.
 *
 * Loops expand only as far as the answers justify: a requirement's criterion
 * nodes appear once its priority is known, and the next requirement appears
 * only once the current one has been closed out with an explicit "yes, another".
 * An unanswered loop controller therefore stops expansion rather than guessing,
 * which keeps the node list finite at every point in the interview.
 */
export function materializeNodes(input: MaterializeInput): readonly IntakeNode[] {
  const answers = answerMap(input.answers);
  const nodes: IntakeNode[] = [...OPENING_NODES];

  for (let requirement = 1; requirement <= MAX_REQUIREMENTS; requirement += 1) {
    nodes.push(...requirementNodes(requirement));

    // Until the priority is known the loop cannot be shaped at all: the number
    // of criterion nodes depends on the loop controllers inside it.
    if (answers.get(`req-${requirement}-priority`) === undefined) break;

    for (let criterion = 1; criterion <= MAX_CRITERIA_PER_REQUIREMENT; criterion += 1) {
      // At the cap the "another?" question is not asked at all. Asking it and
      // then ignoring an affirmative answer let an operator explicitly request
      // a criterion and finalize a contract that silently omitted it — the cap
      // has to be visible as a limit rather than as a question that does
      // nothing.
      nodes.push(...criterionNodes(requirement, criterion, criterion < MAX_CRITERIA_PER_REQUIREMENT));
      if (!isAffirmative(answers.get(`req-${requirement}-ac-${criterion}-more`))) break;
    }
    // Criterion nodes are materialized regardless of priority and excluded from
    // being asked by their `dependsOn`. Skipping them here instead would make
    // conditionality two mechanisms — a structural one and a declarative one —
    // that have to agree, and the structural one is invisible to the pruning
    // pass, so a requirement flipped to `wont` would keep the criteria it had.

    if (requirement < MAX_REQUIREMENTS) {
      nodes.push(moreRequirementsNode(requirement));
      if (!isAffirmative(answers.get(`req-${requirement}-more`))) break;
    }
  }

  nodes.push(...CLOSING_NODES);
  nodes.push(...input.injectedNodes.map(injectedNodeToIntakeNode));
  return nodes;
}

/** Whether a node's `dependsOn` condition is satisfied by the answers so far. */
export function isNodeApplicable(
  node: IntakeNode,
  answers: ReadonlyMap<string, IntakeAnswer["value"]>
): boolean {
  const condition = node.dependsOn;
  if (condition === undefined) return true;
  const value = answers.get(condition.nodeId);
  if (value === undefined) return false;
  if ("equals" in condition) return value === condition.equals;
  return value !== condition.notEquals;
}

export interface NextNodeResult {
  readonly node: IntakeNode | undefined;
  /** Total applicable nodes discovered so far, for progress reporting. */
  readonly total: number;
  readonly answered: number;
}

/**
 * The next unanswered, applicable node.
 *
 * `node: undefined` means the interview is complete as far as the graph is
 * concerned. It does not mean the answers are valid — that is `--finalize`'s
 * job, and keeping the two separate is deliberate: completeness is structural,
 * validity is semantic, and conflating them lets a graph change quietly relax a
 * validator.
 */
export function nextNode(input: MaterializeInput): NextNodeResult {
  const answers = answerMap(input.answers);
  const nodes = materializeNodes(input);

  let total = 0;
  let answered = 0;
  let next: IntakeNode | undefined;

  for (const node of nodes) {
    if (!isNodeApplicable(node, answers)) continue;
    total += 1;
    // A skip is recorded as an answer, so it needs no separate bookkeeping here.
    if (answers.has(node.id)) {
      answered += 1;
      continue;
    }
    if (next === undefined) next = node;
  }

  return { node: next, total, answered };
}

/**
 * Recorded when an optional node is skipped.
 *
 * A skip is an answer — "asked, and declined" — not an absence, so it occupies
 * an answer slot and the cursor moves past it. Storing it rather than leaving a
 * hole keeps a deliberately skipped optional node distinguishable from a
 * required node nobody reached, which is what `--session-status` and every
 * resume-after-interruption depend on.
 *
 * The empty string is the value because for an optional node "declined" and
 * "answered with nothing" are the same fact. Required nodes reject it.
 */
export const SKIPPED_VALUE = "";

export function findNode(input: MaterializeInput, nodeId: string): IntakeNode | undefined {
  return materializeNodes(input).find((node) => node.id === nodeId);
}

/** The answer map a caller needs to test applicability itself. */
export function answersByNodeId(
  answers: readonly IntakeAnswer[]
): ReadonlyMap<string, IntakeAnswer["value"]> {
  return answerMap(answers);
}

/**
 * The nodes the graph is currently asking: materialized and applicable.
 *
 * Distinct from `materializeNodes`, which includes nodes excluded by a
 * `dependsOn`. Anything that decides whether an answer belongs in the session —
 * recording one, or pruning stale ones — must use this, because an answer to a
 * question the graph is not asking has no place in the record of what was asked.
 */
export function applicableNodes(input: MaterializeInput): readonly IntakeNode[] {
  const answers = answerMap(input.answers);
  return materializeNodes(input).filter((node) => isNodeApplicable(node, answers));
}

/**
 * Every node ID the graph itself can produce, at full loop depth.
 *
 * Exported for the test that asserts the graph never enters the injected
 * namespace. Without that assertion the namespace is a convention, and a
 * convention is exactly what an injected node ID collided with in the first
 * place.
 */
export function allGraphNodeIds(): readonly string[] {
  const answers: IntakeAnswer[] = [];
  const at = "1970-01-01T00:00:00.000Z";
  for (let requirement = 1; requirement <= MAX_REQUIREMENTS; requirement += 1) {
    answers.push({
      nodeId: `req-${requirement}-priority`,
      slot: `requirements.${requirement}.priority`,
      value: "must",
      answeredAt: at,
      source: "human"
    });
    answers.push({
      nodeId: `req-${requirement}-more`,
      slot: `requirements.${requirement}.more`,
      value: true,
      answeredAt: at,
      source: "human"
    });
    for (let criterion = 1; criterion <= MAX_CRITERIA_PER_REQUIREMENT; criterion += 1) {
      answers.push({
        nodeId: `req-${requirement}-ac-${criterion}-more`,
        slot: `requirements.${requirement}.criteria.${criterion}.more`,
        value: true,
        answeredAt: at,
        source: "human"
      });
    }
  }
  return materializeNodes({ answers, injectedNodes: [] }).map((node) => node.id);
}
