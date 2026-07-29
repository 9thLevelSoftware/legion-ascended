import { LEGION_PROTOCOL_MIGRATIONS } from "./legion-0-2-0.js";
import { applyMigrations, createMigrationRegistry } from "./index.js";
import {
  CURRENT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  compareSchemaVersions
} from "../versioning/index.js";

/**
 * Bring a persisted protocol document up to the current schema version.
 *
 * Listing an old version in `SUPPORTED_PROTOCOL_VERSIONS` and registering a
 * migration does not, by itself, make anything readable — something has to
 * actually invoke the migration. Without this, adding 0.1.0 to the supported set
 * advertised a compatibility that did not exist: readers handed legacy documents
 * straight to the 0.2.0 schemas, which reject a task contract with no
 * `scope.budget`.
 *
 * The walk is recursive because protocol documents nest versioned records: a
 * taskgraph carries task contracts, a change bundle carries proposed
 * requirements, a spec document carries requirements. Migrating only the
 * outermost `schemaVersion` would renumber the envelope and leave its contents
 * at the old shape — worse than not migrating, because the document would then
 * claim to be current.
 */

/**
 * Built on first use, not at module load.
 *
 * The migrations barrel re-exports this module, so a top-level
 * `createMigrationRegistry()` call runs while `./index.js` is still
 * initializing and fails on its module-private constants.
 */
let cachedRegistry: ReturnType<typeof createMigrationRegistry> | undefined;

function migrationRegistry(): ReturnType<typeof createMigrationRegistry> {
  cachedRegistry ??= createMigrationRegistry({
    currentVersion: CURRENT_PROTOCOL_VERSION,
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    migrations: LEGION_PROTOCOL_MIGRATIONS
  });
  return cachedRegistry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Kinds some registered migration claims it can convert.
 *
 * Deliberately not "anything with a schemaVersion". Artifact envelopes
 * (`taskgraph`, `change-artifact-manifest`, evidence indexes) are versioned by
 * their own constants, not by the protocol version, and some embed a hash
 * computed over their own fields. Bumping their `schemaVersion` on read breaks
 * that self-hash and makes every read fail — which is exactly what a blanket
 * walk did before this restriction.
 */
function migratableKinds(): ReadonlySet<string> {
  const kinds = new Set<string>();
  for (const migration of LEGION_PROTOCOL_MIGRATIONS) {
    for (const kind of migration.appliesToKinds ?? []) kinds.add(kind);
  }
  return kinds;
}

/** A protocol record a registered migration claims: right `kind`, has a version. */
function isMigratableRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (typeof value["schemaVersion"] !== "string") return false;
  const kind = value["kind"];
  return typeof kind === "string" && migratableKinds().has(kind);
}

function needsUpcast(value: Record<string, unknown>): boolean {
  try {
    return compareSchemaVersions(value["schemaVersion"], CURRENT_PROTOCOL_VERSION) < 0;
  } catch {
    // An unparseable version is left alone; the schema will reject it with a
    // better diagnostic than a migration failure would give.
    return false;
  }
}

/**
 * Recursively upcast every versioned record in `value`.
 *
 * Returns the input unchanged when nothing needed migrating, so callers can
 * treat a no-op cheaply. Never throws: a record that cannot be migrated is
 * passed through for the schema to reject, because a validation error naming the
 * offending field is more useful than a thrown migration.
 */
export function upcastProtocolRecords(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => upcastProtocolRecords(entry));
  }

  if (!isRecord(value)) return value;

  // Children first, so a parent migration sees already-current contents.
  const migratedChildren: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    migratedChildren[key] = upcastProtocolRecords(child);
  }

  if (!isMigratableRecord(migratedChildren) || !needsUpcast(migratedChildren)) {
    return migratedChildren;
  }

  try {
    return applyMigrations(migratedChildren, { registry: migrationRegistry() }).record;
  } catch {
    return migratedChildren;
  }
}
