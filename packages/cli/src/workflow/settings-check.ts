import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseSettings } from "@legion/core";

import type { CliWarning } from "../runtime.js";

/**
 * The root `settings.json`, checked.
 *
 * This is the one capability in `commands/validate.md` that outlives
 * `.planning/`. The file sits at the repository root, has a published schema at
 * `docs/settings.schema.json`, and nothing in `packages/` reads a single one of
 * its keys — so the schema the file itself names via `$schema` has never been
 * enforced by anything. Thinning the command onto the verb without this would
 * not retire the check; it would remove it silently, which is the deletion the
 * conversion contract exists to prevent.
 */

export type SettingsStatus = "absent" | "valid" | "warned" | "unparseable";

export interface SettingsCheck {
  readonly status: SettingsStatus;
  readonly path: string;
  readonly diagnostics: readonly { readonly code: string; readonly message: string; readonly source: { readonly path: string } }[];
  readonly warnings: readonly CliWarning[];
}

const SETTINGS_FILE = "settings.json";

export async function checkSettings(repositoryRoot: string): Promise<SettingsCheck> {
  let text: string;
  try {
    text = await readFile(path.join(repositoryRoot, SETTINGS_FILE), "utf8");
  } catch (error) {
    // Absent is a state, not a finding. Most projects will never write this
    // file, and every existing test fixture is a fresh repository without one;
    // treating that as a failure would make `legion validate` red for the
    // default configuration, which is how a check teaches people to ignore it.
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { status: "absent", path: SETTINGS_FILE, diagnostics: [], warnings: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "unparseable",
      path: SETTINGS_FILE,
      diagnostics: [{ code: "settings_unreadable", message: `${SETTINGS_FILE} could not be read: ${message}`, source: { path: SETTINGS_FILE } }],
      warnings: []
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    // The only failing case. A file that does not parse is not configuring
    // anything, and every consumer of it is silently running on defaults while
    // believing otherwise.
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "unparseable",
      path: SETTINGS_FILE,
      diagnostics: [{ code: "settings_unparseable", message: `${SETTINGS_FILE} is not valid JSON: ${message}`, source: { path: SETTINGS_FILE } }],
      warnings: []
    };
  }

  const parsed = parseSettings(value);
  if (parsed.ok) return { status: "valid", path: SETTINGS_FILE, diagnostics: [], warnings: [] };

  // Warnings, never diagnostics. `ok` is computed from diagnostics being empty
  // and `failure` hardcodes exit 1, so routing a bad enum there would turn a
  // fixable settings typo into a hard CI failure — the exact collapse recorded
  // against thinning validate before the WARN tier exists.
  return {
    status: "warned",
    path: SETTINGS_FILE,
    diagnostics: [],
    warnings: parsed.findings.map((finding) => ({
      code: "settings_invalid_value",
      message: `${SETTINGS_FILE}: ${finding.message}`
    }))
  };
}
