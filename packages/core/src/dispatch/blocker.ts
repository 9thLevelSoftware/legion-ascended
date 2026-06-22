/**
 * Map structured dispatch issues to board blockers.
 *
 * The board persistence layer (Phase 3) stores tasks with a
 * `BoardTaskBlocker { reason, reportedBy, reportedAt }` shape. The
 * structured preflight issues carry codes and JSON-pointer paths so
 * operators can debug quickly. This module translates the typed
 * `DispatchIssue` into a single board-shaped blocker that:
 *
 *  - carries the typed code in a parseable `code: <code>` prefix on
 *    `reason` (boards do not have a separate `code` column yet;
 *    keeping it in the reason string preserves auditability),
 *  - encodes the JSON-pointer path so operators can jump to the
 *    failing field,
 *  - records the reporter ("fresh-context-dispatcher") and the
 *    observed timestamp.
 *
 * Why we keep this mapping in core (not in board adapters):
 *  - board consumers must agree on the format (code prefix + path),
 *  - the format is part of the Phase 8 cut line.
 *
 * The same mapper is used by the CLI's `next board` commands
 * (P08-T02 per-task review) and by the evidence indexer (P09).
 */

import type { UtcTimestamp } from "@legion/protocol";

import type {
  DispatchBoardBlocker,
  DispatchIssue,
  DispatchIssueCode
} from "./contract.js";

export const DISPATCH_BLOCKER_REPORTER = "fresh-context-dispatcher";

/**
 * Render a JSON-pointer-ish path. We use bracket notation instead of
 * RFC 6901 because the source issues already use bracket notation
 * (`["agents", 0]`) and downstream consumers want readable strings.
 */
function renderPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return "<root>";
  return path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : `.${segment}`))
    .join("")
    .replace(/^\./, "");
}

export function renderIssueReason(issue: DispatchIssue): string {
  return `code=${issue.code} path=${renderPath(issue.path)} :: ${issue.message}`;
}

export interface MapIssueToBlockerOptions {
  readonly reporter?: string;
  readonly now?: () => UtcTimestamp;
}

/**
 * Map a single structured issue into a board blocker. Use this when
 * the board wants one blocker per issue.
 */
export function mapDispatchIssueToBoardBlocker(
  issue: DispatchIssue,
  options: MapIssueToBlockerOptions = {}
): DispatchBoardBlocker {
  return {
    reason: renderIssueReason(issue),
    reportedBy: options.reporter ?? DISPATCH_BLOCKER_REPORTER,
    reportedAt: (options.now ?? defaultNow)(),
    code: issue.code,
    path: issue.path
  };
}

/**
 * Map every issue in a list into board blockers. The order is
 * preserved. This is the helper the dispatcher uses to populate
 * `FreshContextDispatchFailure.blockers`.
 */
export function mapDispatchIssuesToBoardBlockers(
  issues: readonly DispatchIssue[],
  options: MapIssueToBlockerOptions = {}
): readonly DispatchBoardBlocker[] {
  const now = options.now ?? defaultNow;
  const reporter = options.reporter ?? DISPATCH_BLOCKER_REPORTER;
  return issues.map((issue) => ({
    reason: renderIssueReason(issue),
    reportedBy: reporter,
    reportedAt: now(),
    code: issue.code,
    path: issue.path
  }));
}

/**
 * The full reason string for a failure (one line per issue). Boards
 * often render a single blocker block, so we expose this helper to
 * concatenate issues for display while keeping the per-issue
 * structured blocker available for parsing.
 */
export function renderDispatchFailureReason(
  issues: readonly DispatchIssue[]
): string {
  if (issues.length === 0) return "fresh-context dispatch failed with no structured issues";
  return issues.map(renderIssueReason).join(" | ");
}

function defaultNow(): UtcTimestamp {
  // Workers MUST inject a clock for determinism; this fallback is
  // only for board renderers and tests that don't care about
  // timestamp stability.
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z") as UtcTimestamp;
}

/**
 * Filter helper: keep only blockers whose issue code matches one of
 * the supplied codes. Used by the board UI to render
 * "preflight blockers" and "dispatcher blockers" separately.
 */
export function filterBlockersByCode(
  blockers: readonly DispatchBoardBlocker[],
  codes: readonly DispatchIssueCode[]
): readonly DispatchBoardBlocker[] {
  const allowed = new Set<string>(codes);
  return blockers.filter((blocker) => allowed.has(blocker.code));
}
