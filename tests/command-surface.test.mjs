import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { PLANNING_ALLOWLIST, scanCommandSurface } from "../scripts/scan-command-surface.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The ratchet that retires `.planning/` from the installed command surface.
 *
 * Two things are being guarded, and they fail in opposite directions. A command
 * that reads `.planning/` without being on the allowlist is unconverted work
 * nobody recorded. An allowlist entry for a command that no longer reads
 * `.planning/` is converted work whose entry was left behind, which is how a
 * list that is supposed to shrink stops shrinking.
 *
 * The negative cases below run the scanner against fabricated roots rather than
 * asserting on its source. A guard that has never been seen to fire is a guard
 * nobody has checked, and every one of these fired against a mistake in the
 * inventory it now protects.
 */

async function fixtureRoot(t, { commands, inventory }) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-surface-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await mkdir(path.join(root, "commands"), { recursive: true });
  await mkdir(path.join(root, "docs", "next"), { recursive: true });
  for (const [name, body] of Object.entries(commands)) {
    await writeFile(path.join(root, "commands", `${name}.md`), body);
  }
  await writeFile(
    path.join(root, "docs", "next", "command-capability-inventory.json"),
    JSON.stringify(inventory ?? { schemaVersion: 1, kind: "command_capability_inventory", commands: [] })
  );
  return root;
}

test("the installed command surface has no unrecorded .planning/ reader", async () => {
  const report = await scanCommandSurface({ root: ROOT });
  assert.equal(
    report.ok,
    true,
    `command surface violations:\n${report.violations.map((v) => `  [${v.kind}] ${v.message}`).join("\n")}`
  );
});

test("the allowlist holds exactly the commands that still read .planning/", async () => {
  const report = await scanCommandSurface({ root: ROOT });

  // Stated as set equality rather than containment. Containment in one
  // direction permits a stale entry, and a stale entry is what would let the
  // list stop shrinking while still passing.
  assert.deepEqual([...report.allowlist].sort(), [...report.referencing].sort());
});

test("start and status stay converted", async () => {
  const report = await scanCommandSurface({ root: ROOT });
  for (const converted of ["start", "status"]) {
    assert.ok(report.commands.includes(converted), `commands/${converted}.md must exist`);
    assert.equal(
      report.referencing.includes(converted),
      false,
      `commands/${converted}.md is a worked example of a converted command and must not read .planning/ again`
    );
    assert.equal(PLANNING_ALLOWLIST.includes(converted), false);
  }
});

test("a new command that reads .planning/ is reported", async (t) => {
  const root = await fixtureRoot(t, {
    commands: { fresh: "Read `.planning/STATE.md` before acting.\n" }
  });
  const report = await scanCommandSurface({ root });

  assert.equal(report.ok, false);
  const violation = report.violations.find((entry) => entry.kind === "planning_reference");
  assert.ok(violation, `expected a planning_reference violation, got ${JSON.stringify(report.violations)}`);
  assert.equal(violation.command, "fresh");
  assert.deepEqual(violation.lines, [1]);
});

test("an allowlisted command that no longer reads .planning/ must be removed from the allowlist", async (t) => {
  // `advise` is on the allowlist, so a copy that has been converted is exactly
  // the state this ratchet exists to force a cleanup of.
  const root = await fixtureRoot(t, {
    commands: { advise: "Render `legion advise --json` and stop.\n" }
  });
  const report = await scanCommandSurface({ root });

  assert.equal(report.ok, false);
  const violation = report.violations.find((entry) => entry.kind === "stale_allowlist_entry");
  assert.ok(violation, `expected a stale_allowlist_entry violation, got ${JSON.stringify(report.violations)}`);
  assert.equal(violation.command, "advise");
});

test("an owed command with no inventory entry is reported", async (t) => {
  const root = await fixtureRoot(t, {
    commands: { advise: "Read `.planning/agents/` to pick an advisor.\n" },
    inventory: { schemaVersion: 1, kind: "command_capability_inventory", commands: [] }
  });
  const report = await scanCommandSurface({ root });

  assert.equal(report.ok, false);
  const violation = report.violations.find((entry) => entry.kind === "inventory_missing");
  assert.ok(violation, `expected an inventory_missing violation, got ${JSON.stringify(report.violations)}`);
  assert.equal(violation.command, "advise");
});

test("a host capability whose anchor has vanished is reported", async (t) => {
  const root = await fixtureRoot(t, {
    commands: { advise: "Read `.planning/agents/`. The selection step has been deleted.\n" },
    inventory: {
      schemaVersion: 1,
      kind: "command_capability_inventory",
      commands: [
        {
          command: "advise",
          verb: "advise",
          handler: { file: "packages/cli/src/commands/workflow/ad-hoc.ts", symbol: "runAdviceWorkflow" },
          executorBacked: true,
          class: "B",
          hostOnly: [{ capability: "Advisor selection", anchor: "3. SELECT ADVISOR" }],
          cliGaps: []
        }
      ]
    }
  });
  const report = await scanCommandSurface({ root });

  assert.equal(report.ok, false);
  const violation = report.violations.find((entry) => entry.kind === "anchor_missing");
  assert.ok(violation, `expected an anchor_missing violation, got ${JSON.stringify(report.violations)}`);
  assert.equal(violation.command, "advise");
});

test("every inventory claim about a verb is checked against the code, not taken on trust", async () => {
  const inventory = JSON.parse(
    await readFile(path.join(ROOT, "docs", "next", "command-capability-inventory.json"), "utf8")
  );

  // The scan resolves each handler symbol and recomputes `executorBacked` from
  // the handler body, so a clean scan is the assertion. What this adds is that
  // the inventory covers the whole surface: a command left out is a command no
  // check applies to.
  const inventoried = new Set(inventory.commands.map((entry) => entry.command));
  assert.deepEqual([...inventoried].sort(), [...PLANNING_ALLOWLIST].sort());

  for (const entry of inventory.commands) {
    assert.ok(["A", "B", "C"].includes(entry.class), `${entry.command} has an unknown class ${entry.class}`);
    assert.ok(entry.rationale?.length > 0, `${entry.command} must record why it is class ${entry.class}`);
    if (entry.class === "C") continue;
    assert.ok(entry.handler?.symbol, `${entry.command} is class ${entry.class} and must name a handler`);
  }
});

test("every capability the verb lacks is assigned to someone", async (t) => {
  const root = await fixtureRoot(t, {
    commands: { advise: "Read `.planning/agents/`. Step: 3. SELECT ADVISOR\n" },
    inventory: {
      schemaVersion: 1,
      kind: "command_capability_inventory",
      commands: [
        {
          command: "advise",
          verb: "advise",
          handler: { file: "packages/cli/src/commands/workflow/ad-hoc.ts", symbol: "runAdviceWorkflow" },
          executorBacked: true,
          class: "B",
          hostOnly: [{ capability: "Advisor selection", anchor: "3. SELECT ADVISOR" }],
          // No disposition: nobody is required to build it, keep it, or drop it.
          cliGaps: [{ gap: "legion advise selects no specialist" }]
        }
      ]
    }
  });
  const report = await scanCommandSurface({ root });

  assert.equal(report.ok, false);
  const violation = report.violations.find((entry) => entry.kind === "gap_unassigned");
  assert.ok(violation, `expected a gap_unassigned violation, got ${JSON.stringify(report.violations)}`);
  assert.equal(violation.command, "advise");
});

test("the shipped inventory assigns every gap", async () => {
  const inventory = JSON.parse(
    await readFile(path.join(ROOT, "docs", "next", "command-capability-inventory.json"), "utf8")
  );
  const allowed = new Set(["build-in-cli", "keep-in-host", "deliberate-removal"]);

  // Review found unassigned capabilities in one backlog item four separate
  // times. Each time the conversion would still have satisfied every written
  // criterion, because nothing required the CLI to gain the behaviour, told the
  // host to keep it, or recorded that it was meant to go.
  for (const entry of inventory.commands) {
    for (const gap of entry.cliGaps ?? []) {
      assert.ok(
        allowed.has(gap.disposition),
        `${entry.command} has a gap with no disposition: ${JSON.stringify(gap)}`
      );
      assert.ok(gap.gap?.length > 0, `${entry.command} has a gap with no text`);
    }
  }
});

test("a verb whose implementation is shared says so, because the name proves nothing", async () => {
  const inventory = JSON.parse(
    await readFile(path.join(ROOT, "docs", "next", "command-capability-inventory.json"), "utf8")
  );
  const bySymbol = new Map();
  for (const entry of inventory.commands) {
    if (entry.handler === null || entry.handler === undefined) continue;
    const key = `${entry.handler.file}#${entry.handler.symbol}`;
    bySymbol.set(key, [...(bySymbol.get(key) ?? []), entry]);
  }

  // Treating verb existence as evidence of behavioural parity is what put four
  // commands in the wrong class. Two verbs sharing one implementation is the
  // sharpest form of that trap, so it has to be stated where the class is.
  for (const [key, entries] of bySymbol) {
    if (entries.length < 2) continue;
    const verbs = entries.map((entry) => entry.verb).sort();
    for (const entry of entries) {
      const others = verbs.filter((verb) => verb !== entry.verb);
      assert.deepEqual(
        [...(entry.sharedWith ?? [])].sort(),
        others,
        `${entry.command} shares ${key} with ${others.join(", ")} and must record that in sharedWith`
      );
    }
  }
});
