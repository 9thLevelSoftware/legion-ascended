import { schemaVersionSchema, type SchemaVersion } from "../primitives/values.js";

export const CURRENT_PROTOCOL_VERSION = schemaVersionSchema.parse("0.1.0");

export type CurrentProtocolVersion = typeof CURRENT_PROTOCOL_VERSION;

export const SUPPORTED_PROTOCOL_VERSIONS = [CURRENT_PROTOCOL_VERSION] as const;

export interface VersionedRecord {
  readonly schemaVersion: SchemaVersion;
  readonly [key: string]: unknown;
}

export interface ProtocolMigrationDescriptor {
  readonly id: string;
  readonly fromVersion: string;
  readonly toVersion: string;
}

export interface NormalizedProtocolMigrationDescriptor extends ProtocolMigrationDescriptor {
  readonly fromVersion: SchemaVersion;
  readonly toVersion: SchemaVersion;
}

export type ProtocolNegotiationRejectionReason =
  | "missing_version"
  | "invalid_version"
  | "unsupported_future_version"
  | "unsupported_old_version"
  | "unsupported_reader_version";

export interface CompatibleProtocolNegotiation {
  readonly status: "compatible";
  readonly readerVersion: SchemaVersion;
  readonly writerVersion: SchemaVersion;
  readonly targetVersion: SchemaVersion;
  readonly migrationsRequired: readonly string[];
}

export interface RejectedProtocolNegotiation {
  readonly status: "rejected";
  readonly reason: ProtocolNegotiationRejectionReason;
  readonly message: string;
  readonly readerVersion?: SchemaVersion;
  readonly writerVersion?: SchemaVersion;
}

export type ProtocolNegotiationResult = CompatibleProtocolNegotiation | RejectedProtocolNegotiation;

export interface ProtocolVersionNegotiationInput {
  readonly readerVersion: unknown;
  readonly writerVersion: unknown;
  readonly supportedVersions?: readonly unknown[];
  readonly migrations?: readonly ProtocolMigrationDescriptor[];
}

export interface SemanticVersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const migrationIdPattern = /^[a-z][a-z0-9._-]{1,127}$/;

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function safeParseSchemaVersion(input: unknown): SchemaVersion | null {
  const result = schemaVersionSchema.safeParse(input);
  if (!result.success) return null;
  return result.data;
}

export function parseSchemaVersion(input: unknown, fieldName = "schemaVersion"): SchemaVersion {
  const version = safeParseSchemaVersion(input);
  if (version === null) {
    throw new TypeError(`${fieldName} must be a valid semantic schema version.`);
  }
  return version;
}

export function assertVersionedRecord(input: unknown): VersionedRecord {
  if (!isRecord(input)) {
    throw new TypeError("Versioned protocol records must be objects.");
  }

  const schemaVersion = parseSchemaVersion(input["schemaVersion"], "schemaVersion");
  return { ...input, schemaVersion };
}

export function parseSemanticVersion(version: unknown): SemanticVersionParts {
  const schemaVersion = parseSchemaVersion(version, "version");
  const parts = schemaVersion.split(".").map((part) => Number.parseInt(part, 10));
  const [major, minor, patch] = parts;

  if (major === undefined || minor === undefined || patch === undefined) {
    throw new TypeError("version must contain major, minor, and patch parts.");
  }

  return { major, minor, patch };
}

export function compareSchemaVersions(left: unknown, right: unknown): -1 | 0 | 1 {
  const leftParts = parseSemanticVersion(left);
  const rightParts = parseSemanticVersion(right);

  if (leftParts.major !== rightParts.major) return leftParts.major < rightParts.major ? -1 : 1;
  if (leftParts.minor !== rightParts.minor) return leftParts.minor < rightParts.minor ? -1 : 1;
  if (leftParts.patch !== rightParts.patch) return leftParts.patch < rightParts.patch ? -1 : 1;
  return 0;
}

export function normalizeSupportedVersions(input: readonly unknown[] = SUPPORTED_PROTOCOL_VERSIONS): readonly SchemaVersion[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError("supportedVersions must contain at least one semantic schema version.");
  }

  const unique = new Map<string, SchemaVersion>();
  for (const version of input) {
    const parsed = parseSchemaVersion(version, "supportedVersions");
    unique.set(parsed, parsed);
  }

  return [...unique.values()].sort(compareSchemaVersions);
}

export function versionIsSupported(version: unknown, supportedVersions: readonly unknown[] = SUPPORTED_PROTOCOL_VERSIONS): boolean {
  const parsed = parseSchemaVersion(version, "version");
  return normalizeSupportedVersions(supportedVersions).includes(parsed);
}

function normalizeMigrationDescriptor(descriptor: ProtocolMigrationDescriptor): NormalizedProtocolMigrationDescriptor {
  if (!migrationIdPattern.test(descriptor.id)) {
    throw new TypeError(`Migration ID ${descriptor.id} is invalid.`);
  }

  return {
    id: descriptor.id,
    fromVersion: parseSchemaVersion(descriptor.fromVersion, "fromVersion"),
    toVersion: parseSchemaVersion(descriptor.toVersion, "toVersion")
  };
}

export function findProtocolMigrationPath(input: {
  readonly fromVersion: unknown;
  readonly toVersion: unknown;
  readonly migrations?: readonly ProtocolMigrationDescriptor[];
}): readonly ProtocolMigrationDescriptor[] | null {
  const fromVersion = parseSchemaVersion(input.fromVersion, "fromVersion");
  const toVersion = parseSchemaVersion(input.toVersion, "toVersion");
  if (fromVersion === toVersion) return [];

  const migrations = (input.migrations ?? []).map(normalizeMigrationDescriptor);
  const visited = new Set<string>([fromVersion]);
  const queue: { readonly version: SchemaVersion; readonly path: readonly NormalizedProtocolMigrationDescriptor[] }[] = [
    { version: fromVersion, path: [] }
  ];

  let next = queue.shift();
  while (next !== undefined) {
    for (const migration of migrations) {
      if (migration.fromVersion !== next.version) continue;
      if (visited.has(migration.toVersion)) continue;

      const path = [...next.path, migration];
      if (migration.toVersion === toVersion) return path;

      visited.add(migration.toVersion);
      queue.push({ version: migration.toVersion, path });
    }

    next = queue.shift();
  }

  return null;
}

function rejected(input: {
  readonly reason: ProtocolNegotiationRejectionReason;
  readonly message: string;
  readonly readerVersion?: SchemaVersion;
  readonly writerVersion?: SchemaVersion;
}): RejectedProtocolNegotiation {
  return { status: "rejected", ...input };
}

export function negotiateProtocolVersion(input: ProtocolVersionNegotiationInput): ProtocolNegotiationResult {
  const readerVersion = safeParseSchemaVersion(input.readerVersion);
  const writerVersion = safeParseSchemaVersion(input.writerVersion);

  if (input.readerVersion === undefined || input.writerVersion === undefined) {
    return rejected({
      reason: "missing_version",
      message: "readerVersion and writerVersion are required for protocol negotiation."
    });
  }

  if (readerVersion === null || writerVersion === null) {
    return rejected({
      reason: "invalid_version",
      message: "readerVersion and writerVersion must be valid semantic schema versions."
    });
  }

  const supportedVersions = normalizeSupportedVersions(input.supportedVersions ?? SUPPORTED_PROTOCOL_VERSIONS);
  if (!supportedVersions.includes(readerVersion)) {
    return rejected({
      reason: "unsupported_reader_version",
      message: `Reader version ${readerVersion} is not in the supported protocol version range.`,
      readerVersion,
      writerVersion
    });
  }

  const path = findProtocolMigrationPath({
    fromVersion: writerVersion,
    toVersion: readerVersion,
    ...(input.migrations === undefined ? {} : { migrations: input.migrations })
  });
  if (path !== null) {
    return {
      status: "compatible",
      readerVersion,
      writerVersion,
      targetVersion: readerVersion,
      migrationsRequired: path.map((migration) => migration.id)
    };
  }

  const comparison = compareSchemaVersions(writerVersion, readerVersion);
  if (comparison > 0) {
    return rejected({
      reason: "unsupported_future_version",
      message: `Writer version ${writerVersion} is newer than reader version ${readerVersion} and has no registered migration path.`,
      readerVersion,
      writerVersion
    });
  }

  return rejected({
    reason: "unsupported_old_version",
    message: `Writer version ${writerVersion} is older than reader version ${readerVersion} with no registered migration path.`,
    readerVersion,
    writerVersion
  });
}

export const protocolEvolutionPolicyDocumentation = [
  "# Legion Protocol Evolution Policy",
  "",
  "Every persisted protocol record must carry a valid `schemaVersion`. Readers must reject records without a version before schema parsing, migration, or projection replay.",
  "",
  "Breaking schema changes require a major protocol version or an explicit migration with tests proving the preserved invariants. No reader may silently coerce records across versions.",
  "",
  "Minor and patch changes may be read only when the reader supports the writer version directly or a registered ordered migration path exists.",
  "",
  "Deprecated fields require a removal version, release-note entry, and compatibility test fixture before removal. Removing a field without a migration is a breaking change.",
  "",
  "Downcasts are disabled unless the registered migration declares that it is information-preserving and lists the fields or invariants it preserves.",
  "",
  "Migration failures must leave caller-owned input unchanged. Retry of an already-migrated record must be idempotent and apply no additional steps."
].join("\n");
