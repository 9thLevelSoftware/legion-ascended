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

async function fixtureRoot(t, { commands, inventory, sources = {} }) {
  const root = await mkdtemp(path.join(tmpdir(), "legion-surface-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await mkdir(path.join(root, "commands"), { recursive: true });
  await mkdir(path.join(root, "docs", "next"), { recursive: true });
  for (const [name, body] of Object.entries(commands)) {
    await writeFile(path.join(root, "commands", `${name}.md`), body);
  }
  for (const [relative, body] of Object.entries(sources)) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
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
  //
  // Both sides are empty as of phase 16: every installed command reads project
  // state through a CLI payload. The assertion still earns its place, because
  // the next command to reintroduce a `.planning/` read fails here.
  assert.deepEqual([...report.allowlist].sort(), [...report.referencing].sort());
  assert.deepEqual(report.referencing, [], "no installed command should read .planning/");
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
  // A converted command whose allowlist entry was left behind — exactly the
  // state this ratchet exists to force a cleanup of. The allowlist is supplied
  // because the real one is empty now, and a failure case that can no longer be
  // triggered is one nobody can check.
  const root = await fixtureRoot(t, {
    commands: { retro: "Render `legion retro --json` and stop.\n" }
  });
  const report = await scanCommandSurface({ root, allowlist: ["retro"] });

  assert.equal(report.ok, false);
  const violation = report.violations.find((entry) => entry.kind === "stale_allowlist_entry");
  assert.ok(violation, `expected a stale_allowlist_entry violation, got ${JSON.stringify(report.violations)}`);
  assert.equal(violation.command, "retro");
});

test("an owed command with no inventory entry is reported", async (t) => {
  const root = await fixtureRoot(t, {
    commands: { retro: "Read `.planning/memory/RETRO.md` for prior findings.\n" },
    inventory: { schemaVersion: 1, kind: "command_capability_inventory", commands: [] }
  });
  const report = await scanCommandSurface({ root, allowlist: ["retro"] });

  assert.equal(report.ok, false);
  const violation = report.violations.find((entry) => entry.kind === "inventory_missing");
  assert.ok(violation, `expected an inventory_missing violation, got ${JSON.stringify(report.violations)}`);
  assert.equal(violation.command, "retro");
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
  // Every owed command is inventoried; converted ones keep their entry.
  //
  // Equality would force deleting a command's entry the moment it converts, and
  // that entry is the record of what the conversion had to preserve — the
  // anchors it lists are what the ratchet checks are still present in the
  // converted file. Losing it would mean the conversion could be undone by a
  // later edit with nothing to notice.
  const inventoried = new Set(inventory.commands.map((entry) => entry.command));
  const missing = PLANNING_ALLOWLIST.filter((command) => !inventoried.has(command));
  assert.deepEqual(missing, [], "every command still owed a conversion must be inventoried");

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
  // `built-in-cli` is the fourth: work that was owed and is now done. Its
  // absence is why the field drifted — there was nowhere to move a finished
  // entry, so the gap text was rewritten and the disposition left claiming it
  // was still owed.
  const allowed = new Set(["build-in-cli", "built-in-cli", "keep-in-host", "deliberate-removal"]);

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

test("a model dispatch one helper away is detected, not missed", async (t) => {
  const root = await fixtureRoot(t, {
    commands: { retro: "Read `.planning/memory/RETRO.md`.\n" },
    inventory: {
      schemaVersion: 1,
      kind: "command_capability_inventory",
      commands: [
        {
          command: "retro",
          verb: "retro",
          // Points at a real handler that reaches `adapterForKind` only through
          // `submitReview`. The earlier probe read the top-level body alone and
          // reported false for `review` and `build` — the two commands where
          // being wrong matters most, because both dispatch a model that writes.
          handler: { file: "src/handler.ts", symbol: "handleThing" },
          executorBacked: false,
          class: "B",
          hostOnly: [],
          cliGaps: []
        }
      ]
    },
    sources: {
      "src/handler.ts": [
        "export async function handleThing(context) {",
        "  return submitThing(context);",
        "}",
        "",
        "async function submitThing(context) {",
        "  return adapterForKind(context.executor).run({});",
        "}",
        ""
      ].join("\n")
    }
  });
  const report = await scanCommandSurface({ root, allowlist: ["retro"] });

  assert.equal(report.ok, false);
  const violation = report.violations.find((entry) => entry.kind === "executor_claim_mismatch");
  assert.ok(violation, `expected an executor_claim_mismatch, got ${JSON.stringify(report.violations)}`);
});

test("a deterministic verb sharing a file with a dispatching one is still deterministic", async () => {
  // contextual.ts holds explore and council, which dispatch, alongside map and
  // milestone, which do not. A file-level grep would mark all four backed; the
  // walk has to start from the named handler.
  const report = await scanCommandSurface({ root: ROOT });
  assert.equal(report.ok, true, report.violations.map((entry) => entry.message).join("\n"));

  const inventory = JSON.parse(
    await readFile(path.join(ROOT, "docs", "next", "command-capability-inventory.json"), "utf8")
  );
  const byName = new Map(inventory.commands.map((entry) => [entry.command, entry]));
  assert.equal(byName.get("map").executorBacked, false);
  assert.equal(byName.get("milestone").executorBacked, false);
  assert.equal(byName.get("explore").executorBacked, true);
});

/**
 * A gap's disposition has to be falsifiable, or it decays into decoration.
 *
 * The set was {build-in-cli, keep-in-host, deliberate-removal} — three answers
 * to "who owns this" and none to "this was owed and is now done". When work
 * landed there was nowhere to move the entry, so the gap *text* was rewritten
 * to describe the shipped behaviour and the disposition left alone. Twenty-one
 * of twenty-six entries ended up claiming to be owed while describing finished
 * work, and every count taken from the field was meaningless.
 *
 * A keyword scan over the prose was tried first and misclassified entries in
 * both directions, which is the whole argument for checking it in code.
 */

function inventoryWith(gap) {
  return {
    schemaVersion: 1,
    kind: "command_capability_inventory",
    commands: [
      {
        command: "sample",
        class: "C",
        verb: null,
        handler: null,
        executorBacked: false,
        retainedCapabilities: [],
        cliGaps: [gap]
      }
    ]
  };
}

const SAMPLE_COMMAND = { sample: "Render `legion sample --json` and stop.\n" };

test("a gap recorded as owed whose closer already exists is reported", async (t) => {
  // The drift that produced this check: a capability ships, nobody moves the
  // entry, and the inventory goes on reporting it as owed forever.
  const root = await fixtureRoot(t, {
    commands: SAMPLE_COMMAND,
    sources: { "packages/cli/src/sample.ts": "export function alreadyBuilt() {}\n" },
    inventory: inventoryWith({
      gap: "the thing is not built",
      disposition: "build-in-cli",
      closedWhen: { file: "packages/cli/src/sample.ts", pattern: "alreadyBuilt" }
    })
  });
  const report = await scanCommandSurface({ root });

  assert.equal(report.ok, false);
  const violation = report.violations.find((entry) => entry.kind === "gap_closed_but_open");
  assert.ok(violation, `expected gap_closed_but_open, got ${JSON.stringify(report.violations)}`);
});

test("a gap recorded as owed with no probe is reported", async (t) => {
  // Without this, an entry opts out of the check by omitting the field, which
  // is exactly what every pre-existing entry did.
  const root = await fixtureRoot(t, {
    commands: SAMPLE_COMMAND,
    inventory: inventoryWith({ gap: "the thing is not built", disposition: "build-in-cli" })
  });
  const report = await scanCommandSurface({ root });

  assert.equal(report.ok, false);
  assert.ok(report.violations.some((entry) => entry.kind === "gap_open_without_probe"));
});

test("a probe pointing at a file that does not exist is reported", async (t) => {
  // A probe that can never fire leaves the gap open forever without anyone
  // noticing — the same silence this check exists to break.
  const root = await fixtureRoot(t, {
    commands: SAMPLE_COMMAND,
    inventory: inventoryWith({
      gap: "the thing is not built",
      disposition: "build-in-cli",
      closedWhen: { file: "packages/cli/src/gone.ts", pattern: "whatever" }
    })
  });
  const report = await scanCommandSurface({ root });

  assert.equal(report.ok, false);
  assert.ok(report.violations.some((entry) => entry.kind === "gap_probe_unresolvable"));
});

test("a gap recorded as built must name a test that exists", async (t) => {
  // "Built" cannot be claimed with nothing behind it, or the new disposition
  // becomes a quieter version of the problem it replaced.
  const root = await fixtureRoot(t, {
    commands: SAMPLE_COMMAND,
    inventory: inventoryWith({
      gap: "the thing is built",
      disposition: "built-in-cli",
      evidence: "tests/does-not-exist.test.mjs"
    })
  });
  const report = await scanCommandSurface({ root });

  assert.equal(report.ok, false);
  assert.ok(report.violations.some((entry) => entry.kind === "gap_built_evidence_missing"));

  const bare = await fixtureRoot(t, {
    commands: SAMPLE_COMMAND,
    inventory: inventoryWith({ gap: "the thing is built", disposition: "built-in-cli" })
  });
  const bareReport = await scanCommandSurface({ root: bare });
  assert.equal(bareReport.ok, false);
  assert.ok(bareReport.violations.some((entry) => entry.kind === "gap_built_without_evidence"));
});

test("an owed gap whose probe does not yet match passes", async (t) => {
  // The positive case. A check that only ever fails is one nobody can satisfy,
  // and the negative cases above prove nothing without it.
  const root = await fixtureRoot(t, {
    commands: SAMPLE_COMMAND,
    sources: { "packages/cli/src/sample.ts": "export function somethingElse() {}\n" },
    inventory: inventoryWith({
      gap: "the thing is not built",
      disposition: "build-in-cli",
      closedWhen: { file: "packages/cli/src/sample.ts", pattern: "notBuiltYet" }
    })
  });
  const report = await scanCommandSurface({ root });

  assert.ok(
    !report.violations.some((entry) => entry.kind.startsWith("gap_")),
    `unexpected gap violation: ${JSON.stringify(report.violations)}`
  );
});
