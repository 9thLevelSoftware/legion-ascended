import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The ratchet that retires `.planning/` from the installed command surface, and
 * the verifier for the capability inventory that governs how each command gets
 * converted.
 *
 * Two commands are already converted. The remaining sixteen are not one kind of
 * work, and the way to get that wrong is to decide from a command's name or its
 * one-line help text. That is not hypothetical: the first pass of the phase 16
 * plan classified all sixteen from help text and put four commands in classes
 * that would have deleted an advisor selection, a publishing workflow, a
 * deliberating panel, and a design conversation.
 *
 * So the inventory is data rather than prose, and this scanner checks it against
 * the files. A claim that a command owns something the CLI does not carries an
 * anchor that must still appear in the command. A claim about what a verb does
 * names a symbol that must still exist at the cited path, and whether that verb
 * is executor-backed is computed from its handler body rather than asserted.
 * Claims cannot rot quietly, and a class cannot be assigned to a command the
 * inventory has never looked at.
 */

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PLANNING_REFERENCE = /\.planning\//;

/**
 * Commands still permitted to read `.planning/`.
 *
 * Empty, as of phase 16. Every one of the nineteen installed commands now reads
 * project state through a CLI payload, and the ratchet below keeps it that way:
 * a command that reintroduces a `.planning/` read fails the build unless someone
 * adds it back here and says why.
 *
 * This list may only ever shorten. It is not maintained by hand in one
 * direction: `scanCommandSurface` reports an entry that no longer references
 * `.planning/` as a violation, so converting a command forces its removal in the
 * same change. A list that could grow would record the debt without bounding it.
 */
export const PLANNING_ALLOWLIST = Object.freeze([]);

const INVENTORY_PATH = "docs/next/command-capability-inventory.json";

/**
 * The calls that hand work to a model.
 *
 * `runGuidanceExecutor(` alone was not enough. `legion review --executor codex`
 * and `legion build --executor codex` both dispatch, through
 * `adapterForKind(...).run(...)` — and both were recorded `executorBacked:
 * false`, because the probe read only the top-level handler body and the
 * dispatch sits one function away. The claim this check exists to compute was
 * being computed wrongly for two of the three commands that matter most.
 */
const EXECUTOR_CALLS = ["runGuidanceExecutor(", "adapterForKind("];

/**
 * Who owns a capability the verb does not have, and whether it has been built.
 *
 * `built-in-cli` exists because its absence caused a silent, repeated lie. The
 * set was `{build-in-cli, keep-in-host, deliberate-removal}` — three answers to
 * "who owns this", and none to "this was owed and is now done". When work
 * landed there was nowhere to move the entry, so the gap *text* was rewritten
 * to describe the shipped behaviour and the disposition left alone. Twenty-one
 * of twenty-six `build-in-cli` entries ended up reading "is now", "no longer",
 * "is closed at both ends" while still claiming to be owed, and every count
 * taken from the field was meaningless.
 *
 * A schema that cannot express the truth will be filled in with something else.
 */
const DISPOSITIONS = new Set(["build-in-cli", "built-in-cli", "keep-in-host", "deliberate-removal"]);

/**
 * A disposition that can be checked rather than believed.
 *
 * - `built-in-cli` must name an `evidence` test file that exists on disk, so
 *   "built" cannot be claimed with nothing behind it.
 * - `build-in-cli` must carry a `closedWhen` probe — a `{file, pattern}` that
 *   must **not** currently match. The day someone ships the capability the
 *   pattern starts matching and this fails, forcing the disposition to move.
 *   That is the check the previous drift had no equivalent of: prose describing
 *   completed work sat under an "owed" label indefinitely because nothing
 *   compared the two.
 *
 * A keyword scan over the gap text was tried first and misclassified entries in
 * both directions. Prose cannot be the check.
 */
function auditGapDisposition({ root, name, gap, label }) {
  const violations = [];

  if (gap.disposition === "built-in-cli") {
    const evidence = typeof gap.evidence === "string" ? gap.evidence : undefined;
    if (evidence === undefined) {
      violations.push({
        kind: "gap_built_without_evidence",
        command: name,
        message: `a built-in-cli gap on ${name} names no evidence test. Add "evidence": "<test path>": ${label}`
      });
    } else if (!existsSync(path.join(root, evidence))) {
      violations.push({
        kind: "gap_built_evidence_missing",
        command: name,
        message: `a built-in-cli gap on ${name} names ${JSON.stringify(evidence)}, which does not exist: ${label}`
      });
    }
    return violations;
  }

  if (gap.disposition !== "build-in-cli") return violations;

  const probe = gap.closedWhen;
  if (probe === undefined || typeof probe.file !== "string" || typeof probe.pattern !== "string") {
    violations.push({
      kind: "gap_open_without_probe",
      command: name,
      message:
        `a build-in-cli gap on ${name} has no closedWhen probe. Add ` +
        `"closedWhen": {"file": "<path>", "pattern": "<regex that matches once built>"}: ${label}`
    });
    return violations;
  }

  const probePath = path.join(root, probe.file);
  if (!existsSync(probePath)) {
    // A probe pointing at a file that does not exist can never fire, so the gap
    // would stay open forever without anyone noticing — the same silence this
    // check exists to break.
    violations.push({
      kind: "gap_probe_unresolvable",
      command: name,
      message: `a build-in-cli gap on ${name} probes ${JSON.stringify(probe.file)}, which does not exist: ${label}`
    });
    return violations;
  }

  let matched;
  try {
    matched = new RegExp(probe.pattern).test(readFileSync(probePath, "utf8"));
  } catch (error) {
    violations.push({
      kind: "gap_probe_invalid",
      command: name,
      message: `a build-in-cli gap on ${name} has an unparseable closedWhen pattern: ${error.message}: ${label}`
    });
    return violations;
  }

  if (matched) {
    violations.push({
      kind: "gap_closed_but_open",
      command: name,
      message:
        `a build-in-cli gap on ${name} is recorded as owed, but its closedWhen probe now matches ` +
        `(${JSON.stringify(probe.pattern)} in ${probe.file}). Either the capability was built and the ` +
        `disposition must become built-in-cli, or the probe is wrong: ${label}`
    });
  }
  return violations;
}

export async function scanCommandSurface({ root = DEFAULT_ROOT, allowlist = PLANNING_ALLOWLIST } = {}) {
  const violations = [];
  const commandsDir = path.join(root, "commands");
  const entries = (await readdir(commandsDir))
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.slice(0, -".md".length))
    .sort();

  const sources = new Map();
  for (const name of entries) {
    sources.set(name, await readFile(path.join(commandsDir, `${name}.md`), "utf8"));
  }

  // Overridable so the negative tests stay meaningful now that the real list is
  // empty: a ratchet whose failure cases can no longer be triggered is a ratchet
  // nobody can check.
  const allowed = new Set(allowlist);
  for (const name of allowed) {
    if (!sources.has(name)) {
      violations.push({
        kind: "allowlist_unknown_command",
        command: name,
        message: `the allowlist names commands/${name}.md, which does not exist`
      });
    }
  }

  const referencing = [];
  for (const [name, source] of sources) {
    const lines = source.split(/\r?\n/);
    const hits = [];
    lines.forEach((line, index) => {
      if (PLANNING_REFERENCE.test(line)) hits.push(index + 1);
    });
    if (hits.length === 0) continue;
    referencing.push(name);
    if (allowed.has(name)) continue;
    violations.push({
      kind: "planning_reference",
      command: name,
      lines: hits,
      message:
        `commands/${name}.md reads .planning/ on ${hits.length} line(s) and is not on the allowlist. ` +
        `Convert it, or add it to PLANNING_ALLOWLIST and record why it is still owed.`
    });
  }

  // The ratchet. An allowlist entry that no longer reads `.planning/` is a
  // converted command whose entry was left behind, and leaving it behind is what
  // would let the list stop shrinking.
  const referencingSet = new Set(referencing);
  for (const name of allowed) {
    if (!sources.has(name) || referencingSet.has(name)) continue;
    violations.push({
      kind: "stale_allowlist_entry",
      command: name,
      message:
        `commands/${name}.md no longer reads .planning/, so it must be removed from ` +
        `PLANNING_ALLOWLIST. The list may only ever shorten.`
    });
  }

  const inventory = await readInventory(root, violations);
  if (inventory !== undefined) {
    await verifyInventory({ root, inventory, sources, allowed, violations });
  }

  return {
    ok: violations.length === 0,
    commands: entries,
    allowlist: [...allowed].sort(),
    referencing: referencing.sort(),
    violations
  };
}

async function readInventory(root, violations) {
  try {
    return JSON.parse(await readFile(path.join(root, INVENTORY_PATH), "utf8"));
  } catch (error) {
    violations.push({
      kind: "inventory_unreadable",
      message: `${INVENTORY_PATH} could not be read: ${error instanceof Error ? error.message : String(error)}`
    });
    return undefined;
  }
}

async function verifyInventory({ root, inventory, sources, allowed, violations }) {
  const entries = Array.isArray(inventory.commands) ? inventory.commands : [];
  const inventoried = new Set();
  const handlerSources = new Map();

  for (const entry of entries) {
    const name = entry.command;
    if (inventoried.has(name)) {
      violations.push({ kind: "inventory_duplicate", command: name, message: `${name} is inventoried twice` });
      continue;
    }
    inventoried.add(name);

    const source = sources.get(name);
    if (source === undefined) {
      violations.push({
        kind: "inventory_unknown_command",
        command: name,
        message: `the inventory describes ${name}, but commands/${name}.md does not exist`
      });
      continue;
    }

    // Every claim that the host owns something must still be findable in the
    // command. A capability described only in the inventory is a capability
    // nobody can check for before deleting it.
    for (const capability of entry.hostOnly ?? []) {
      if (source.includes(capability.anchor)) continue;
      violations.push({
        kind: "anchor_missing",
        command: name,
        message:
          `commands/${name}.md no longer contains the anchor for "${capability.capability}" ` +
          `(${JSON.stringify(capability.anchor)}). Either the capability moved and the inventory ` +
          `needs updating, or it was removed and that removal was never recorded.`
      });
    }

    // A gap with no disposition is a capability assigned to nobody. That is how
    // a conversion passes every criterion while the behaviour disappears: the
    // CLI was never required to gain it, the host was never told to keep it, and
    // nothing recorded that it was meant to go. Review found that shape four
    // separate times in one backlog item, so it is checked rather than reviewed.
    for (const gap of entry.cliGaps ?? []) {
      const label = JSON.stringify(String(gap?.gap ?? gap).slice(0, 80));
      if (!DISPOSITIONS.has(gap?.disposition)) {
        violations.push({
          kind: "gap_unassigned",
          command: name,
          message:
            `a cliGap on ${name} has no valid disposition (${JSON.stringify(gap?.disposition)}). ` +
            `Every gap must be one of ${[...DISPOSITIONS].join(", ")}: ${label}`
        });
        continue;
      }
      violations.push(...auditGapDisposition({ root, name, gap, label }));
    }

    if (entry.class === "C") {
      if (entry.verb !== null || entry.handler !== null) {
        violations.push({
          kind: "inventory_class_mismatch",
          command: name,
          message: `${name} is class C, which means no verb exists, but the inventory names one`
        });
      }
      continue;
    }

    if (entry.handler === null || entry.handler === undefined) {
      violations.push({
        kind: "inventory_handler_missing",
        command: name,
        message: `${name} is class ${entry.class} but names no handler`
      });
      continue;
    }

    let handlerSource = handlerSources.get(entry.handler.file);
    if (handlerSource === undefined) {
      try {
        handlerSource = await readFile(path.join(root, entry.handler.file), "utf8");
      } catch {
        handlerSource = null;
      }
      handlerSources.set(entry.handler.file, handlerSource);
    }
    if (handlerSource === null) {
      violations.push({
        kind: "handler_file_missing",
        command: name,
        message: `${name} cites ${entry.handler.file}, which does not exist`
      });
      continue;
    }

    const body = functionBody(handlerSource, entry.handler.symbol);
    if (body === undefined) {
      violations.push({
        kind: "handler_symbol_missing",
        command: name,
        message:
          `${entry.handler.file} no longer defines ${entry.handler.symbol}. The inventory's claim ` +
          `about what legion ${entry.verb} does is describing code that moved.`
      });
      continue;
    }

    // Computed, not asserted. Whether a verb hands the work to a model is the
    // fact that decides whether a command can be thinned onto it, so it is the
    // one claim that must never be taken on trust — which means following the
    // helpers the handler calls, not stopping at its own body.
    const observed = dispatchesToModel(handlerSource, entry.handler.symbol);
    if (observed !== Boolean(entry.executorBacked)) {
      violations.push({
        kind: "executor_claim_mismatch",
        command: name,
        message:
          `the inventory says legion ${entry.verb} is ${entry.executorBacked ? "" : "not "}executor-backed, ` +
          `but ${entry.handler.symbol} in ${entry.handler.file} does ${observed ? "" : "not "}call ` +
          `any of ${EXECUTOR_CALLS.map((call) => call.slice(0, -1)).join(" or ")}, directly or through a helper it calls.`
      });
    }
  }

  // A command may not be assigned a class the inventory has never examined.
  // This is the check that would have caught the first pass: it classified from
  // help text, and help text is not in this file.
  for (const name of allowed) {
    if (inventoried.has(name) || !sources.has(name)) continue;
    violations.push({
      kind: "inventory_missing",
      command: name,
      message:
        `commands/${name}.md is owed a conversion but has no inventory entry. ` +
        `Inventory what it does, and what its verb does, before assigning it a class.`
    });
  }
}

/**
 * Whether a handler reaches a model dispatch, directly or through a helper.
 *
 * File-level grep would be wrong in the other direction: `contextual.ts` holds
 * `explore` and `council`, which dispatch, alongside `map` and `milestone`,
 * which are deterministic. So this walks the local call graph from the named
 * handler, visiting only functions declared in the same file, and stops at the
 * first dispatch it can actually reach.
 */
function dispatchesToModel(source, symbol, visited = new Set()) {
  if (visited.has(symbol)) return false;
  visited.add(symbol);

  const body = functionBody(source, symbol);
  if (body === undefined) return false;
  if (EXECUTOR_CALLS.some((call) => body.includes(call))) return true;

  // Any locally-declared function this body names is a helper it may reach.
  const declared = [...source.matchAll(/(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1]);
  return declared
    .filter((name) => name !== symbol && new RegExp(`\\b${name}\\s*\\(`).test(body))
    .some((name) => dispatchesToModel(source, name, visited));
}

/**
 * The body of a top-level function declaration.
 *
 * Brace matching rather than a parser: these files are formatted consistently,
 * and a wrong answer here surfaces as a failing test rather than a silent pass,
 * because the executor claim it feeds is checked in both directions.
 */
function functionBody(source, symbol) {
  const declaration = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function\\s+${symbol}\\b`);
  const match = declaration.exec(source);
  if (match === null) return undefined;

  // Skip the parameter list before looking for the body. Inline object types in
  // a signature open braces of their own, and taking the first one found a
  // "body" that ended at the parameter type — which read as "this verb does not
  // call the executor" for a function whose entire purpose is calling it.
  const open = bodyBrace(source, match.index + match[0].length);
  if (open === -1) return undefined;

  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return source.slice(open);
}

/** Index of the brace opening a function body, given an offset at its name. */
function bodyBrace(source, from) {
  const paren = source.indexOf("(", from);
  if (paren === -1) return -1;
  let depth = 0;
  for (let index = paren; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return source.indexOf("{", index + 1);
    }
  }
  return -1;
}

export function renderViolations(violations) {
  return violations.map((violation) => `  [${violation.kind}] ${violation.message}`).join("\n");
}

// `file://` string comparison drops a slash on Windows paths, so compare URLs.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await scanCommandSurface();
  if (report.ok) {
    console.log(
      `command surface: ${report.commands.length} commands, ` +
        `${report.allowlist.length} still reading .planning/.`
    );
  } else {
    console.error(`command surface: ${report.violations.length} violation(s)\n${renderViolations(report.violations)}`);
    process.exitCode = 1;
  }
}
