import type { ProtocolMigration } from "./index.js";
import type { VersionedRecord } from "../versioning/index.js";

/**
 * Upcast from protocol 0.1.0 to 0.2.0.
 *
 * 0.2.0 makes two things mandatory that 0.1.0 had no way to express: a task's
 * blast-radius budget, and an explicit proof mode on every acceptance
 * criterion. Neither can be recovered from a 0.1.0 record, so this migration is
 * deliberately not information-preserving, and it fails safe rather than
 * inventing plausible-looking values:
 *
 *  - A migrated task contract receives the most restrictive budget that still
 *    permits its declared write scope. If the legacy task genuinely needed a
 *    wider radius, reconciliation blocks and a human authors a real budget —
 *    the correct direction to be wrong in.
 *  - A migrated acceptance criterion becomes `manual`, because a 0.1.0
 *    criterion was prose and carried no command. Marking it executable would
 *    assert a proof that was never written.
 *
 * Both stamp `metadata.annotations` so downstream code and `legion validate`
 * can tell a migrated value from an authored one.
 *
 * This is a single migration rather than one per entity kind: `applyMigrations`
 * resolves a path by version pair, so two migrations sharing 0.1.0 -> 0.2.0
 * would be ambiguous. It dispatches on `record.kind` instead.
 */

// Metadata keys are constrained to /^[a-z][a-z0-9._-]{0,63}$/ — dots, not slashes.
export const MIGRATED_BUDGET_ANNOTATION = "legion.protocol.budget-origin";
export const MIGRATED_CRITERIA_ANNOTATION = "legion.protocol.criteria-origin";
export const MIGRATED_VALUE = "migrated-from-0.1.0";

export const MIGRATED_CRITERION_REASON =
  "Migrated from protocol 0.1.0, which recorded acceptance criteria as prose with no proof. Author an executable criterion before treating this as verified.";

const MIGRATED_LINES_PER_FILE = 200;
const TARGET_VERSION = "0.2.0";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withAnnotation(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const metadata = isRecord(record["metadata"]) ? record["metadata"] : {};
  const annotations = isRecord(metadata["annotations"]) ? metadata["annotations"] : {};
  return {
    ...record,
    metadata: {
      ...metadata,
      annotations: { ...annotations, [key]: MIGRATED_VALUE }
    }
  };
}

/** `requirement.acceptance.criteria: string[]` -> criterion objects. */
function upcastRequirement(record: VersionedRecord): Record<string, unknown> {
  const acceptance = isRecord(record["acceptance"]) ? record["acceptance"] : undefined;
  const criteria = acceptance === undefined ? undefined : acceptance["criteria"];
  if (!Array.isArray(criteria) || criteria.length === 0) return { ...record };
  // Idempotent: an already-migrated record passes through untouched.
  if (criteria.every((entry) => isRecord(entry))) return { ...record };

  const upcast = criteria.map((entry, index) =>
    isRecord(entry)
      ? entry
      : {
          id: `ac_migrated-${index + 1}`,
          statement: String(entry),
          proof: { mode: "manual", reason: MIGRATED_CRITERION_REASON }
        }
  );

  return withAnnotation(
    { ...record, acceptance: { ...acceptance, criteria: upcast } },
    MIGRATED_CRITERIA_ANNOTATION
  );
}

/** Add `scope.budget` and `completion.diffReconciliation`. */
function upcastTaskContract(record: VersionedRecord): Record<string, unknown> {
  const scope = isRecord(record["scope"]) ? record["scope"] : undefined;
  const completion = isRecord(record["completion"]) ? record["completion"] : undefined;
  if (scope === undefined || completion === undefined) return { ...record };
  if (isRecord(scope["budget"]) && isRecord(completion["diffReconciliation"])) return { ...record };

  const write = Array.isArray(scope["write"]) ? scope["write"] : [];
  const declaredFiles = Math.max(write.length, 1);

  return withAnnotation(
    {
      ...record,
      scope: {
        ...scope,
        budget: isRecord(scope["budget"])
          ? scope["budget"]
          : {
              maxFilesChanged: declaredFiles,
              maxLinesChanged: declaredFiles * MIGRATED_LINES_PER_FILE,
              maxNewFiles: declaredFiles
            }
      },
      completion: {
        ...completion,
        diffReconciliation: isRecord(completion["diffReconciliation"])
          ? completion["diffReconciliation"]
          : { required: true, allowUnlistedReads: true }
      }
    },
    MIGRATED_BUDGET_ANNOTATION
  );
}

export const legionProtocol010To020: ProtocolMigration = {
  id: "legion.protocol.0-1-0.to.0-2-0",
  fromVersion: "0.1.0",
  toVersion: TARGET_VERSION,
  kind: "upcast",
  description:
    "Add fail-safe task blast-radius budgets and diff reconciliation, and convert prose acceptance criteria into criterion objects with explicit proof modes.",
  preserves: [
    "scope.read",
    "scope.write",
    "scope.forbidden",
    "scope.sequentialFiles",
    "acceptance.language",
    "acceptance.oracleRefs",
    "statement",
    "traceRefs"
  ],
  informationPreserving: false,
  appliesToKinds: ["requirement", "task-contract"],
  migrate(record: VersionedRecord): unknown {
    const migrated =
      record["kind"] === "requirement"
        ? upcastRequirement(record)
        : record["kind"] === "task-contract"
          ? upcastTaskContract(record)
          : { ...record };
    return { ...migrated, schemaVersion: TARGET_VERSION };
  }
};

export const LEGION_PROTOCOL_MIGRATIONS: readonly ProtocolMigration[] = [legionProtocol010To020];
