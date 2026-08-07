import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflowCommands = [
  "start",
  "explore",
  "map",
  "plan",
  "build",
  "review",
  "ship",
  "retro",
  "status",
  "quick",
  "advise",
  "polish",
  "learn",
  "milestone",
  "validate",
  "doctor"
];

function requiredSection(text, startHeading, endHeading) {
  const start = text.indexOf(startHeading);
  assert.notEqual(start, -1, `missing section ${startHeading}`);
  const end = endHeading === undefined ? text.length : text.indexOf(endHeading, start + startHeading.length);
  assert.notEqual(end, -1, `missing section boundary ${endHeading}`);
  return text.slice(start, end);
}

test("ADR-009 makes workflow verbs the canonical CLI front door", async () => {
  const adr = await readFile("docs/next/adr/ADR-009-workflow-first-cli.md", "utf8");
  assert.match(adr, /Status\s*\nAccepted/);
  assert.match(adr, /canonical user-facing command surface is `legion <workflow>`/);
  assert.match(adr, /`legion dev`/);
  assert.match(adr, /worker bundle authoring is an internal developer workflow/);
  for (const command of workflowCommands) {
    assert.match(adr, new RegExp(`legion ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
});

test("CLI README leads with workflow commands, not engine commands", async () => {
  const readme = await readFile("docs/next/cli/README.md", "utf8");
  const opening = readme.slice(0, 800);
  assert.match(opening, /^# Legion CLI\r?\n\r?\nThe canonical CLI is workflow-first:/);
  assert.match(opening, /legion start/);
  assert.match(opening, /legion plan 1/);
  assert.match(opening, /legion build/);
  assert.match(opening, /legion review/);
  assert.match(opening, /legion quick "fix the failing tests"/);
  assert.doesNotMatch(readme.slice(0, 1200), /legion next/);
  assert.doesNotMatch(readme.slice(0, 1200), /worker bundle/);
});

test("user docs do not present worker bundle authoring as typical usage", async () => {
  const readme = await readFile("README.md", "utf8");
  const cliReadme = await readFile("docs/next/cli/README.md", "utf8");
  // Re-anchored onto the README's current sections. The previous anchors were
  // `## Getting Started` → `## Claude Opus 4.7 Hardening` and
  // `## Workflow Reference` → `## v2.0 Advisory Features`, and both boundary
  // headings were themselves the staleness the rewrite removed: one named a
  // model version, the other a product version this package left behind at 2.0.
  // The rule being enforced — usage documentation must not present worker
  // bundle internals as typical usage — is unchanged and now covers the
  // quickstart and the whole command surface rather than two narrower slices.
  const usageSections = [
    requiredSection(readme, "## Quickstart", "## Risk Tiers and Ship Gates"),
    requiredSection(readme, "## Command Surface", "## Executors"),
    cliReadme
  ];

  for (const section of usageSections) {
    assert.doesNotMatch(section, /bundles\/index\.json/);
    assert.doesNotMatch(section, /instructionsHash/);
    assert.doesNotMatch(section, /promptContentContract/);
  }
});

test("README documents the CLI surface as verbs, and the gates as they actually behave", async () => {
  const readme = await readFile("README.md", "utf8");
  const surface = requiredSection(readme, "## Command Surface", "## Executors");

  // The rule this test has always enforced: the front door is `legion <verb>`,
  // and a host alias is a wrapper rather than the thing being documented. It
  // used to assert that by pinning three `#### \`legion x\` (alias: \`/legion:x\`)`
  // headings and two exact sentences, which pinned the prose rather than the
  // property. The property is asserted directly now, so the section can be
  // rewritten without the test having an opinion about its wording.
  for (const verb of ["start", "plan", "build", "review", "ship"]) {
    assert.match(surface, new RegExp(`\`legion ${verb}`), `the core loop must document legion ${verb}`);
  }

  // A slash alias must never be the documented name of a command.
  assert.doesNotMatch(surface, /^#+\s*`?\/legion:/m);

  // The governance verbs are the reason an R2 or R3 change can reach ready at
  // all. A command surface that omits them describes a workflow that stops
  // short of shipping anything above the lowest risk tier — which is what this
  // file documented before they existed.
  for (const verb of ["approve", "attest", "release"]) {
    assert.match(surface, new RegExp(`\`legion ${verb}`), `the governance surface must document legion ${verb}`);
  }

  // Claims this documentation is not allowed to make again: that execution and
  // review are unwired, that agents are spawned with injected personality, or
  // that a phase self-completes once review passes. Each was true of an earlier
  // product and false of this one.
  assert.doesNotMatch(readme, /until runtime execution and review evidence backends are connected/);
  assert.doesNotMatch(readme, /The main loop for any project/);
  assert.doesNotMatch(readme, /Spawns agents with full personality injection/);
  assert.doesNotMatch(readme, /marks the phase complete only after review passes/);

  // `legion ship` reports readiness and does not release. Two tolerant patterns
  // rather than one exact sentence: the claim has to survive a rewrite of the
  // prose, and the first draft of this assertion quoted wording the README does
  // not use — pinning a sentence again, which is the habit being corrected.
  assert.match(readme, /(readiness verdict|reports? readiness|readiness gate)/iu);
  assert.match(readme, /(does not|never|nothing else)[\s\S]{0,80}?(publish|deploy|release)/iu);
});
