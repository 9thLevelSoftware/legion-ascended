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
  const usageSections = [
    requiredSection(readme, "## Getting Started", "## Claude Opus 4.7 Hardening"),
    requiredSection(readme, "## Workflow Reference", "## v2.0 Advisory Features"),
    cliReadme
  ];

  for (const section of usageSections) {
    assert.doesNotMatch(section, /bundles\/index\.json/);
    assert.doesNotMatch(section, /instructionsHash/);
    assert.doesNotMatch(section, /promptContentContract/);
  }
});

test("README workflow reference stays CLI-first and honest about live gates", async () => {
  const readme = await readFile("README.md", "utf8");
  const workflowReference = requiredSection(readme, "## Workflow Reference", "## v2.0 Advisory Features");

  assert.match(workflowReference, /#### `legion start` \(alias: `\/legion:start`\)/);
  assert.match(workflowReference, /#### `legion build` \(alias: `\/legion:build`\)/);
  assert.match(workflowReference, /#### `legion review` \(alias: `\/legion:review`\)/);
  assert.match(workflowReference, /executes it through the selected executor adapter with durable evidence/);
  assert.match(workflowReference, /submits structured review decisions against collected build evidence/);

  assert.doesNotMatch(workflowReference, /^#### `\/legion:/m);
  assert.doesNotMatch(workflowReference, /until runtime execution and review evidence backends are connected/);
  assert.doesNotMatch(workflowReference, /The main loop for any project/);
  assert.doesNotMatch(workflowReference, /Spawns agents with full personality injection/);
  assert.doesNotMatch(workflowReference, /marks the phase complete only after review passes/);
});
