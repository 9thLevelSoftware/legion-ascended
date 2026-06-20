import {
  CURRENT_PROTOCOL_VERSION,
  assertVersionedRecord,
  compareSchemaVersions,
  findProtocolMigrationPath,
  normalizeSupportedVersions,
  parseSchemaVersion,
  protocolEvolutionPolicyDocumentation,
  type ProtocolMigrationDescriptor,
  type VersionedRecord
} from "../versioning/index.js";
import type { SchemaVersion } from "../primitives/values.js";

export type ProtocolMigrationKind = "upcast" | "downcast";

export interface ProtocolMigration extends ProtocolMigrationDescriptor {
  readonly kind: ProtocolMigrationKind;
  readonly description: string;
  readonly preserves: readonly string[];
  readonly informationPreserving?: boolean;
  readonly migrate: (record: VersionedRecord) => unknown;
}

export interface MigrationRegistry {
  readonly currentVersion: SchemaVersion;
  readonly supportedVersions: readonly SchemaVersion[];
  readonly migrations: readonly ProtocolMigration[];
}

export interface CreateMigrationRegistryInput {
  readonly currentVersion?: unknown;
  readonly supportedVersions?: readonly unknown[];
  readonly migrations?: readonly ProtocolMigration[];
}

export interface ApplyMigrationsInput {
  readonly registry: MigrationRegistry;
  readonly targetVersion?: unknown;
}

export interface MigrationApplicationResult {
  readonly record: VersionedRecord;
  readonly appliedMigrations: readonly string[];
}

export interface CompatibilityReportInput {
  readonly registry: MigrationRegistry;
}

const migrationIdPattern = /^[a-z][a-z0-9._-]{1,127}$/;

function cloneVersionedRecord(record: VersionedRecord): VersionedRecord {
  const serialized = JSON.stringify(record);
  if (serialized === undefined) {
    throw new TypeError("Versioned protocol records must be JSON-serializable objects.");
  }

  const cloned: unknown = JSON.parse(serialized);
  return assertVersionedRecord(cloned);
}

function assertSupportedVersion(version: SchemaVersion, registry: MigrationRegistry, fieldName: string): void {
  if (!registry.supportedVersions.includes(version)) {
    throw new RangeError(`${fieldName} ${version} is not included in the migration registry supportedVersions.`);
  }
}

function normalizePreservedInvariants(input: readonly string[]): readonly string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError("Protocol migrations must list at least one preserved field or invariant.");
  }

  for (const invariant of input) {
    if (typeof invariant !== "string" || invariant.trim().length === 0) {
      throw new TypeError("Protocol migration preserved invariants must be non-empty strings.");
    }
  }

  return Object.freeze([...input]);
}

function normalizeMigration(registry: MigrationRegistry, migration: ProtocolMigration): ProtocolMigration {
  if (!migrationIdPattern.test(migration.id)) {
    throw new TypeError(`Protocol migration ID ${migration.id} is invalid.`);
  }

  if (typeof migration.description !== "string" || migration.description.trim().length === 0) {
    throw new TypeError("Protocol migrations require a non-empty description.");
  }

  if (migration.kind !== "upcast" && migration.kind !== "downcast") {
    throw new TypeError("Protocol migrations must be declared as upcast or downcast.");
  }

  if (typeof migration.migrate !== "function") {
    throw new TypeError("Protocol migrations require a migrate function.");
  }

  const fromVersion = parseSchemaVersion(migration.fromVersion, "fromVersion");
  const toVersion = parseSchemaVersion(migration.toVersion, "toVersion");
  if (fromVersion === toVersion) {
    throw new RangeError("Protocol migration source and target versions must differ.");
  }

  assertSupportedVersion(fromVersion, registry, "fromVersion");
  assertSupportedVersion(toVersion, registry, "toVersion");

  const comparison = compareSchemaVersions(fromVersion, toVersion);
  if (migration.kind === "upcast" && comparison >= 0) {
    throw new RangeError("Upcast migrations must move to a newer protocol version.");
  }

  if (migration.kind === "downcast") {
    if (comparison <= 0) {
      throw new RangeError("Downcast migrations must move to an older protocol version.");
    }

    if (migration.informationPreserving !== true) {
      throw new Error("Downcast migrations must declare information-preserving evidence.");
    }
  }

  const preserves = normalizePreservedInvariants(migration.preserves);

  return Object.freeze({
    id: migration.id,
    fromVersion,
    toVersion,
    kind: migration.kind,
    description: migration.description,
    preserves,
    ...(migration.informationPreserving === undefined ? {} : { informationPreserving: migration.informationPreserving }),
    migrate: migration.migrate
  });
}

function migrationKey(migration: ProtocolMigrationDescriptor): string {
  return `${migration.fromVersion}->${migration.toVersion}`;
}

export function createMigrationRegistry(input: CreateMigrationRegistryInput = {}): MigrationRegistry {
  const currentVersion = parseSchemaVersion(input.currentVersion ?? CURRENT_PROTOCOL_VERSION, "currentVersion");
  const supportedVersions = normalizeSupportedVersions(input.supportedVersions ?? [currentVersion]);

  if (!supportedVersions.includes(currentVersion)) {
    throw new RangeError(`currentVersion ${currentVersion} must be included in supportedVersions.`);
  }

  let registry: MigrationRegistry = Object.freeze({
    currentVersion,
    supportedVersions,
    migrations: []
  });

  for (const migration of input.migrations ?? []) {
    registry = registerMigration(registry, migration);
  }

  return registry;
}

export function registerMigration(registry: MigrationRegistry, migration: ProtocolMigration): MigrationRegistry {
  const normalized = normalizeMigration(registry, migration);

  if (registry.migrations.some((entry) => entry.id === normalized.id)) {
    throw new Error(`Protocol migration ${normalized.id} is already registered.`);
  }

  const key = migrationKey(normalized);
  if (registry.migrations.some((entry) => migrationKey(entry) === key)) {
    throw new Error(`Protocol migration path ${key} is already registered.`);
  }

  return Object.freeze({
    currentVersion: registry.currentVersion,
    supportedVersions: registry.supportedVersions,
    migrations: Object.freeze([...registry.migrations, normalized])
  });
}

export function applyMigrations(input: unknown, options: ApplyMigrationsInput): MigrationApplicationResult {
  const initial = assertVersionedRecord(input);
  const targetVersion = parseSchemaVersion(options.targetVersion ?? options.registry.currentVersion, "targetVersion");
  assertSupportedVersion(targetVersion, options.registry, "targetVersion");

  const path = findProtocolMigrationPath({
    fromVersion: initial.schemaVersion,
    toVersion: targetVersion,
    migrations: options.registry.migrations
  });

  if (path === null) {
    throw new Error(`No registered migration path from ${initial.schemaVersion} to ${targetVersion}.`);
  }

  let record = cloneVersionedRecord(initial);
  const appliedMigrations: string[] = [];

  for (const descriptor of path) {
    const migration = options.registry.migrations.find((entry) => entry.id === descriptor.id);
    if (!migration) {
      throw new Error(`Migration descriptor ${descriptor.id} is not registered.`);
    }

    const migrated = assertVersionedRecord(migration.migrate(cloneVersionedRecord(record)));
    if (migrated.schemaVersion !== migration.toVersion) {
      throw new Error(
        `Migration ${migration.id} returned schemaVersion ${migrated.schemaVersion}; expected ${migration.toVersion}.`
      );
    }

    record = cloneVersionedRecord(migrated);
    appliedMigrations.push(migration.id);
  }

  return Object.freeze({
    record,
    appliedMigrations: Object.freeze(appliedMigrations)
  });
}

export function generateCompatibilityReport(input: CompatibilityReportInput): string {
  const rows =
    input.registry.migrations.length === 0
      ? "| none | none | none | none | none |\n"
      : input.registry.migrations
          .map(
            (migration) =>
              `| \`${migration.id}\` | \`${migration.fromVersion}\` | \`${migration.toVersion}\` | ${migration.kind} | ${migration.preserves.join(", ")} |`
          )
          .join("\n");

  return [
    "# Protocol Compatibility Report",
    "",
    `Current protocol version: \`${input.registry.currentVersion}\``,
    "",
    `Supported protocol versions: ${input.registry.supportedVersions.map((version) => `\`${version}\``).join(", ")}`,
    "",
    "## Compatibility Matrix",
    "",
    "| Migration | From | To | Kind | Preserved invariants |",
    "| --- | --- | --- | --- | --- |",
    rows,
    "",
    "## Evolution Policy",
    "",
    protocolEvolutionPolicyDocumentation
  ].join("\n");
}
