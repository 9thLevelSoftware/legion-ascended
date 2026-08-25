import {
  codeIndexExportSchema,
  codeIndexImportSchema,
  codeIndexSnapshotSchema,
  codeIndexSymbolSchema,
  type CodeIndexFact,
  type CodeIndexSha256,
  type CodeIndexSnapshot,
  type CodeIndexSourceRange
} from "@legion/protocol";
import { DatabaseSync } from "node:sqlite";
import { renameSync, rmSync } from "node:fs";
import path from "node:path";

export interface CodeIndexStoreWrite {
  readonly databasePath: string;
  readonly factCount: number;
}

export interface CodeIndexSearchHit {
  readonly id: string;
  readonly kind: string;
  readonly path: string;
  readonly name?: string;
  readonly specifier?: string;
  readonly range: CodeIndexSourceRange;
  readonly sourceSha256: CodeIndexSha256;
  readonly extractorVersion: string;
  readonly factKind: CodeIndexFactKind;
  readonly rank: number;
}

type CodeIndexFactKind = "symbol" | "import" | "export";

type SqliteFactRow = {
  readonly id: string;
  readonly fact_kind: CodeIndexFactKind;
  readonly path: string;
  readonly name: string | null;
  readonly source_sha256: string;
  readonly start_byte: number;
  readonly end_byte: number;
  readonly start_line: number;
  readonly start_column: number;
  readonly end_line: number;
  readonly end_column: number;
  readonly extractor_version: string;
  readonly payload_json: string;
};

type SqliteSearchRow = SqliteFactRow & {
  readonly rank: number;
};

const FACTS_SCHEMA = `
  CREATE TABLE facts (
    id TEXT PRIMARY KEY, fact_kind TEXT NOT NULL, path TEXT NOT NULL, name TEXT,
    source_sha256 TEXT NOT NULL, start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL,
    start_line INTEGER NOT NULL, start_column INTEGER NOT NULL,
    end_line INTEGER NOT NULL, end_column INTEGER NOT NULL,
    extractor_version TEXT NOT NULL, payload_json TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE facts_fts USING fts5(id UNINDEXED, path, name, searchable);
`;

const FACTS_INSERT = `
  INSERT INTO facts (
    id, fact_kind, path, name, source_sha256,
    start_byte, end_byte, start_line, start_column, end_line, end_column,
    extractor_version, payload_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const FTS_INSERT = "INSERT INTO facts_fts (id, path, name, searchable) VALUES (?, ?, ?, ?)";
const TEMP_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const DATABASE_SIDECARS = ["-wal", "-shm", "-journal"] as const;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(object)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) throw new TypeError("Cannot serialize code index fact.");
  return serialized;
}

function tokenize(value: string): readonly string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function searchableText(factKind: CodeIndexFactKind, fact: CodeIndexFact): string {
  const values = [factKind, fact.path, "kind" in fact ? fact.kind : "", "name" in fact ? fact.name : "", "specifier" in fact ? fact.specifier : ""];
  return values.flatMap((value) => tokenize(value)).join(" ");
}

function materializedFacts(snapshot: CodeIndexSnapshot): readonly { readonly factKind: CodeIndexFactKind; readonly fact: CodeIndexFact }[] {
  return [
    ...snapshot.symbols.map((fact) => ({ factKind: "symbol" as const, fact })),
    ...snapshot.imports.map((fact) => ({ factKind: "import" as const, fact })),
    ...snapshot.exports.map((fact) => ({ factKind: "export" as const, fact }))
  ];
}

function factName(fact: CodeIndexFact): string | null {
  return "name" in fact ? fact.name : null;
}

function factSearchName(fact: CodeIndexFact): string | null {
  if ("name" in fact) return fact.name;
  if ("specifier" in fact) return fact.specifier;
  return null;
}

function temporaryDatabasePath(databasePath: string): string {
  return path.join(path.dirname(databasePath), `.${path.basename(databasePath)}.${process.pid}.tmp`);
}

function removeTemporaryDatabaseFiles(databasePath: string): void {
  for (const suffix of TEMP_SUFFIXES) {
    rmSync(databasePath + suffix, { force: true });
  }
}

function removeDatabaseSidecars(databasePath: string): void {
  for (const suffix of DATABASE_SIDECARS) {
    rmSync(databasePath + suffix, { force: true });
  }
}

function parseFact(factKind: CodeIndexFactKind, payloadJson: string): CodeIndexFact {
  const payload: unknown = JSON.parse(payloadJson);
  if (factKind === "symbol") return codeIndexSymbolSchema.parse(payload);
  if (factKind === "import") return codeIndexImportSchema.parse(payload);
  return codeIndexExportSchema.parse(payload);
}

function readFactRow(database: DatabaseSync, id: string): SqliteFactRow | undefined {
  return database.prepare(`
    SELECT id, fact_kind, path, name, source_sha256,
      start_byte, end_byte, start_line, start_column, end_line, end_column,
      extractor_version, payload_json
    FROM facts
    WHERE id = ?
  `).get(id) as SqliteFactRow | undefined;
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("limit must be an integer between 1 and 1000");
  }
}

function safeMatchQuery(query: string): string {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    throw new RangeError("query must contain at least one alphanumeric token");
  }
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
}

function searchHit(row: SqliteSearchRow): CodeIndexSearchHit {
  const fact = parseFact(row.fact_kind, row.payload_json);
  const base = {
    ...fact,
    kind: "kind" in fact ? fact.kind : row.fact_kind,
    factKind: row.fact_kind,
    rank: Number(row.rank)
  };
  const name = factSearchName(fact);
  if (name === null) return base as CodeIndexSearchHit;
  return { ...base, name } as CodeIndexSearchHit;
}

export function writeCodeIndexStore(input: {
  readonly databasePath: string;
  readonly snapshot: CodeIndexSnapshot;
}): CodeIndexStoreWrite {
  const snapshot = codeIndexSnapshotSchema.parse(input.snapshot);
  const temporaryPath = temporaryDatabasePath(input.databasePath);
  removeTemporaryDatabaseFiles(temporaryPath);

  let database: DatabaseSync | undefined;
  let transactionStarted = false;
  let writeCompleted = false;
  try {
    database = new DatabaseSync(temporaryPath);
    database.exec(FACTS_SCHEMA);
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;

    const insertFact = database.prepare(FACTS_INSERT);
    const insertSearchFact = database.prepare(FTS_INSERT);
    for (const { factKind, fact } of materializedFacts(snapshot)) {
      insertFact.run(
        fact.id,
        factKind,
        fact.path,
        factName(fact),
        fact.sourceSha256,
        fact.range.startByte,
        fact.range.endByte,
        fact.range.startLine,
        fact.range.startColumn,
        fact.range.endLine,
        fact.range.endColumn,
        fact.extractorVersion,
        canonicalJson(fact)
      );
      insertSearchFact.run(fact.id, fact.path, factSearchName(fact), searchableText(factKind, fact));
    }

    database.exec("COMMIT");
    transactionStarted = false;
    writeCompleted = true;
  } catch (error) {
    if (transactionStarted) {
      try {
        database?.exec("ROLLBACK");
      } catch {
        // Preserve the original write failure.
      }
    }
    throw error;
  } finally {
    database?.close();
    if (!writeCompleted) removeTemporaryDatabaseFiles(temporaryPath);
  }

  let renamed = false;
  try {
    renameSync(temporaryPath, input.databasePath);
    renamed = true;
    removeDatabaseSidecars(input.databasePath);
  } finally {
    if (!renamed) removeTemporaryDatabaseFiles(temporaryPath);
  }

  return {
    databasePath: input.databasePath,
    factCount: snapshot.symbols.length + snapshot.imports.length + snapshot.exports.length
  };
}

export function queryCodeIndexStore(input: {
  readonly databasePath: string;
  readonly query: string;
  readonly limit: number;
}): readonly CodeIndexSearchHit[] {
  validateLimit(input.limit);
  const matchQuery = safeMatchQuery(input.query);
  const database = new DatabaseSync(input.databasePath);
  try {
    const rows = database.prepare(`
      SELECT f.id, f.fact_kind, f.path, f.name, f.source_sha256,
        f.start_byte, f.end_byte, f.start_line, f.start_column,
        f.end_line, f.end_column, f.extractor_version, f.payload_json,
        bm25(facts_fts) AS rank
      FROM facts_fts
      INNER JOIN facts AS f ON f.id = facts_fts.id
      WHERE facts_fts MATCH ?
      ORDER BY rank ASC, f.path ASC, f.id ASC
      LIMIT ?
    `).all(matchQuery, input.limit) as unknown as SqliteSearchRow[];
    return rows.map((row) => searchHit(row));
  } finally {
    database.close();
  }
}

export function findCodeIndexFact(input: {
  readonly databasePath: string;
  readonly id: string;
}): CodeIndexFact | undefined {
  const database = new DatabaseSync(input.databasePath);
  try {
    const row = readFactRow(database, input.id);
    return row === undefined ? undefined : parseFact(row.fact_kind, row.payload_json);
  } finally {
    database.close();
  }
}
