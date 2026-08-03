import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseJsonOutput, runCliCapture } from "./helpers/cli-runner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Boolean options must be declared valueless, and the declaration must be
 * complete rather than remembered.
 *
 * `hasFlag` requires the parsed value to be exactly `true`. An option missing
 * from `VALUELESS_OPTIONS` silently binds the next argument and then reads as
 * *absent* — so the flag does not merely fail to take its value, it disappears,
 * and the handler runs whatever branch it falls through to.
 *
 * That is not theoretical. `legion map --check src` bound "src" to `check`,
 * `hasFlag` returned false, and the handler fell through to `mapRefresh` — so a
 * request to inspect the map overwrote it, and exited 0.
 *
 * The first test is the durable one. Four flags were missing when it was
 * written, which is four chances review had to notice a one-line omission in a
 * list of twenty-three strings and did not.
 */

async function readSource(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

/** Every file under packages/cli/src, so the scan cannot miss a new handler. */
async function sourceFiles(dir = "packages/cli/src") {
  const entries = await readdir(path.join(ROOT, dir), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await sourceFiles(relative)));
    else if (entry.name.endsWith(".ts")) files.push(relative);
  }
  return files;
}

test("every flag read with hasFlag is declared valueless", async () => {
  const runtime = await readSource("packages/cli/src/runtime.ts");
  const declaration = /const VALUELESS_OPTIONS = new Set\(\[(.*?)\]\);/s.exec(runtime);
  assert.ok(declaration, "VALUELESS_OPTIONS must still be a literal set this test can read");
  const declared = new Set([...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));

  const used = new Map();
  for (const file of await sourceFiles()) {
    const source = await readSource(file);
    for (const match of source.matchAll(/hasFlag\(\s*context\s*,\s*"([^"]+)"/g)) {
      used.set(match[1], file);
    }
  }
  assert.ok(used.size > 0, "expected to find hasFlag call sites");

  const missing = [...used.entries()]
    .filter(([key]) => !declared.has(key))
    .map(([key, file]) => `--${key} (read in ${file})`);

  assert.deepEqual(
    missing,
    [],
    "these flags are read with hasFlag but not declared valueless, so a following argument " +
      "binds to them and the flag reads as absent:\n  " + missing.join("\n  ")
  );
});

test("a boolean flag given a value does not vanish", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "legion-parse-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const git = (args) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-m", "initial"]);

  const run = (...args) => runCliCapture(["--repository-root", root, ...args]);
  assert.equal((await run("map", "--refresh")).exitCode, 0);

  // The reported defect, end to end. Asking to check must never refresh: the
  // caller wanted to know whether the map was current, and the destructive
  // branch answers by destroying the thing being asked about.
  const checked = await run("map", "--check", "src", "--json");
  assert.equal(checked.exitCode, 0, checked.stderr);
  assert.equal(parseJsonOutput(checked).mode, "check", "--check with a following argument must still check");
});
