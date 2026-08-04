import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewSummary } from "../packages/cli/dist/commands/workflow/review.js";

/**
 * What `legion review --json` gives a host rendering a review panel.
 *
 * `reviewSummary` reported `findings` as a **number**. A panel built from it
 * could say "3 findings" and nothing else — not what they were, not how severe,
 * not what evidence backed them — so either the panel showed a bare count or
 * the host read the review artifact itself, which is the coupling the payload
 * exists to avoid.
 *
 * Asserted at the seam rather than through `legion review`: review requires
 * *collected* build evidence, and a fake executor's build blocks on the harness
 * observations acceptance cannot override, so no review artifact is producible
 * from a fixture. That gate is correct; this pins the payload contract where it
 * is decided.
 */

const REVIEW = {
  artifactPath: ".legion/project/changes/chg_x/reviews/rev_first.json",
  document: {
    id: "rev_first",
    taskId: "tsk_x-c1",
    status: "submitted",
    reviewer: { kind: "agent", id: "task-reviewer" },
    confidence: "high",
    verdicts: { specification: "pass", integration: "fail", evidence: "pass" },
    supersedes: [],
    findings: [
      {
        id: "f-blocking",
        title: "Integration contract broken",
        body: "The handler returns a shape the caller cannot parse.",
        severity: "blocking",
        evidenceRefs: ["evd_x-c1-attempt-1"]
      },
      { id: "f-minor", title: "Naming", body: "Prefer a clearer name.", severity: "minor" }
    ]
  }
};

test("findings carry their body, severity and evidence, not just a count", () => {
  const summary = reviewSummary(REVIEW);

  // The count survives under a new name, so a caller that only wanted a number
  // still has one.
  assert.equal(summary.findingCount, 2);
  assert.ok(Array.isArray(summary.findings), "findings must be a list, not a count");
  assert.equal(summary.findings.length, summary.findingCount, "the list and the count must agree");

  const [blocking, minor] = summary.findings;
  assert.equal(blocking.title, "Integration contract broken");
  assert.equal(blocking.body, "The handler returns a shape the caller cannot parse.");
  assert.equal(blocking.severity, "blocking");
  assert.deepEqual(blocking.evidenceRefs, ["evd_x-c1-attempt-1"]);

  // A minor finding may carry no evidence. Reported as an empty list rather
  // than omitted, so a caller need not distinguish absent from empty.
  assert.deepEqual(minor.evidenceRefs, []);
});

test("the panel can tell who reviewed and whether this was a first attempt", () => {
  const summary = reviewSummary(REVIEW);

  // Without the reviewer, a panel cannot distinguish a human verdict from an
  // executor's. Without `supersedes`, it cannot tell a first attempt from a
  // retry — the same distinction `legion retro`'s first-pass rate counts.
  assert.deepEqual(summary.reviewer, { kind: "agent", id: "task-reviewer" });
  assert.deepEqual(summary.supersedes, []);
  assert.equal(summary.confidence, "high");
  assert.equal(summary.status, "submitted");
  // Per-dimension verdicts, so "failed" says which dimension failed.
  assert.equal(summary.verdicts.integration, "fail");
});

test("a recommended follow-up keeps the phase scope", async () => {
  const { scopedCommand } = await import("../packages/cli/dist/commands/workflow/review.js");

  // The clean-review path advertises `legion review --accept`. Following that
  // without the scope resolves the newest change, so a caller reviewing an
  // older phase would accept a different one. A next action that silently acts
  // on something else is worse than no next action.
  assert.equal(scopedCommand("legion review --accept", "3"), "legion review --accept --phase 3");
  // Unscoped stays unscoped: appending a flag the caller did not give would be
  // the same defect in the other direction.
  assert.equal(scopedCommand("legion review --accept", undefined), "legion review --accept");
});

test("a malformed --phase is a usage error, not a workflow block", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const path = (await import("node:path")).default;
  const { tmpdir } = await import("node:os");
  const { parseJsonOutput, runCliCapture } = await import("./helpers/cli-runner.mjs");

  const root = await mkdtemp(path.join(tmpdir(), "legion-phase-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  execFileSync("git", ["-C", root, "init", "--initial-branch=main"], { stdio: ["ignore", "pipe", "ignore"] });

  for (const value of ["1.5", "1foo", "01"]) {
    const result = await runCliCapture(["--repository-root", root, "review", "--phase", value, "--json"]);
    const payload = parseJsonOutput(result);
    // Routed through `blockedReview` this reported `blocked` and suggested
    // `legion plan 1`, so automation could not tell malformed CLI input from a
    // phase that was genuinely never planned.
    assert.equal(payload.status, "usage_error", `--phase ${value} was not a usage error`);
    assert.match(payload.diagnostics[0].message, /positive integer/);
  }
});
