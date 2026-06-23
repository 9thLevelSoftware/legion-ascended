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
  const files = ["README.md", "docs/next/cli/README.md"];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const firstUsageSection = text.slice(0, 2500);
    assert.doesNotMatch(firstUsageSection, /bundles\/index\.json/);
    assert.doesNotMatch(firstUsageSection, /instructionsHash/);
    assert.doesNotMatch(firstUsageSection, /promptContentContract/);
  }
});
