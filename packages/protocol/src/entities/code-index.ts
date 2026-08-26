import * as z from "zod";

import { runIdSchema } from "../primitives/ids.js";
import { artifactPathSchema, utcTimestampSchema } from "../primitives/values.js";

const CODE_INDEX_FACT_ID_PATTERN = /^(idx|sym|imp|exp)_[a-f0-9]{24}$/;
const CODE_INDEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const codeIndexSourcePathPattern = /^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*[\u0000-\u001F\u007F])[^/]+(?:\/[^/]+)*$/u;

export const codeIndexSourcePathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(codeIndexSourcePathPattern, "Invalid code index source path")
  .brand<"CodeIndexSourcePath">()
  .describe("Relative POSIX repository source path with no traversal, backslashes, empty segments, or control characters.");

export type CodeIndexSourcePath = z.infer<typeof codeIndexSourcePathSchema>;

export const codeIndexProfileSchema = z.enum(["inventory", "structural"]);

export type CodeIndexProfile = z.infer<typeof codeIndexProfileSchema>;

export const codeIndexCoverageStatusSchema = z.enum([
  "parsed",
  "metadata-only",
  "size-limited",
  "opaque",
  "parser-error",
  "unsupported"
]);

export type CodeIndexCoverageStatus = z.infer<typeof codeIndexCoverageStatusSchema>;

const codeIndexLanguageSchema = z.string().min(1).max(64);
const codeIndexDiagnosticSchema = z.string().max(512);

export const codeIndexFileCoverageSchema = z.strictObject({
  path: codeIndexSourcePathSchema,
  status: codeIndexCoverageStatusSchema,
  language: codeIndexLanguageSchema.optional(),
  diagnostics: z.array(codeIndexDiagnosticSchema).max(32).optional()
});

export type CodeIndexFileCoverage = z.infer<typeof codeIndexFileCoverageSchema>;

export const codeIndexSnapshotIdSchema = z
  .string()
  .regex(/^idx_[a-f0-9]{24}$/, "Invalid code index snapshot ID")
  .brand<"CodeIndexSnapshotId">();

export const codeIndexFactIdSchema = z
  .string()
  .regex(CODE_INDEX_FACT_ID_PATTERN, "Invalid code index fact ID")
  .brand<"CodeIndexFactId">();

export const codeIndexSymbolIdSchema = z
  .string()
  .regex(/^sym_[a-f0-9]{24}$/, "Invalid code index symbol ID")
  .brand<"CodeIndexSymbolId">();

export const codeIndexImportIdSchema = z
  .string()
  .regex(/^imp_[a-f0-9]{24}$/, "Invalid code index import ID")
  .brand<"CodeIndexImportId">();

export const codeIndexExportIdSchema = z
  .string()
  .regex(/^exp_[a-f0-9]{24}$/, "Invalid code index export ID")
  .brand<"CodeIndexExportId">();

export type CodeIndexSnapshotId = z.infer<typeof codeIndexSnapshotIdSchema>;
export type CodeIndexFactId = z.infer<typeof codeIndexFactIdSchema>;
export type CodeIndexSymbolId = z.infer<typeof codeIndexSymbolIdSchema>;
export type CodeIndexImportId = z.infer<typeof codeIndexImportIdSchema>;
export type CodeIndexExportId = z.infer<typeof codeIndexExportIdSchema>;

export const codeIndexSha256Schema = z
  .string()
  .regex(CODE_INDEX_SHA256_PATTERN, "Invalid SHA-256 digest")
  .brand<"CodeIndexSha256">();

export type CodeIndexSha256 = z.infer<typeof codeIndexSha256Schema>;

export const codeIndexSourceRangeSchema = z
  .strictObject({
    startByte: z.number().int().nonnegative(),
    endByte: z.number().int().nonnegative(),
    startLine: z.number().int().nonnegative(),
    startColumn: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    endColumn: z.number().int().nonnegative()
  })
  .superRefine((range, context) => {
    if (range.endByte < range.startByte) {
      context.addIssue({
        code: "custom",
        message: "Code index source range endByte must be greater than or equal to startByte.",
        path: ["endByte"]
      });
    }
  });

export type CodeIndexSourceRange = z.infer<typeof codeIndexSourceRangeSchema>;

const codeIndexExtractorVersionSchema = z.string().min(1).max(64);
const codeIndexNameSchema = z.string().min(1).max(256);
const codeIndexKindSchema = z.string().min(1).max(128);
const codeIndexSpecifierSchema = z.string().min(1).max(1_024);

const codeIndexFactBaseSchema = {
  path: codeIndexSourcePathSchema,
  sourceSha256: codeIndexSha256Schema,
  range: codeIndexSourceRangeSchema,
  extractorVersion: codeIndexExtractorVersionSchema
} as const;

export const codeIndexSymbolSchema = z.strictObject({
  id: codeIndexSymbolIdSchema,
  ...codeIndexFactBaseSchema,
  name: codeIndexNameSchema,
  kind: codeIndexKindSchema,
  exported: z.boolean()
});

export type CodeIndexSymbol = z.infer<typeof codeIndexSymbolSchema>;

export const codeIndexImportSchema = z.strictObject({
  id: codeIndexImportIdSchema,
  ...codeIndexFactBaseSchema,
  specifier: codeIndexSpecifierSchema
});

export type CodeIndexImport = z.infer<typeof codeIndexImportSchema>;

export const codeIndexExportSchema = z.strictObject({
  id: codeIndexExportIdSchema,
  ...codeIndexFactBaseSchema,
  name: codeIndexNameSchema,
  kind: codeIndexKindSchema
});

export type CodeIndexExport = z.infer<typeof codeIndexExportSchema>;

const codeIndexExtractorSchema = z.strictObject({
  name: z.literal("tree-sitter"),
  version: codeIndexExtractorVersionSchema
});

const codeIndexSqliteSchema = z.strictObject({
  path: artifactPathSchema,
  sha256: codeIndexSha256Schema
});

const codeIndexScopeSchema = z.union([z.literal("."), codeIndexSourcePathSchema]);

function compareFacts(
  left: { readonly path: string; readonly range: { readonly startByte: number }; readonly id: string },
  right: { readonly path: string; readonly range: { readonly startByte: number }; readonly id: string }
): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  if (left.range.startByte < right.range.startByte) return -1;
  if (left.range.startByte > right.range.startByte) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

const FACT_ARRAYS = ["symbols", "imports", "exports"] as const;

type CodeIndexFactValue = CodeIndexSymbol | CodeIndexImport | CodeIndexExport;
type CodeIndexFactArrayName = (typeof FACT_ARRAYS)[number];

export const codeIndexSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("code_index_snapshot"),
    snapshotId: codeIndexSnapshotIdSchema,
    mapRunId: runIdSchema,
    generatedAt: utcTimestampSchema,
    profile: codeIndexProfileSchema,
    scope: codeIndexScopeSchema,
    sourceFingerprint: codeIndexSha256Schema,
    extractor: codeIndexExtractorSchema,
    sqlite: codeIndexSqliteSchema,
    coverage: z.array(codeIndexFileCoverageSchema).max(100_000).readonly(),
    symbols: z.array(codeIndexSymbolSchema),
    imports: z.array(codeIndexImportSchema),
    exports: z.array(codeIndexExportSchema)
  })
  .superRefine((snapshot, context) => {
    const seenCoveragePaths = new Set<string>();
    let previousCoveragePath: string | undefined;

    for (const [index, coverage] of snapshot.coverage.entries()) {
      if (seenCoveragePaths.has(coverage.path)) {
        context.addIssue({
          code: "custom",
          message: "Code index coverage paths must be unique within a snapshot.",
          path: ["coverage", index, "path"]
        });
      }
      seenCoveragePaths.add(coverage.path);

      if (previousCoveragePath !== undefined && previousCoveragePath >= coverage.path) {
        context.addIssue({
          code: "custom",
          message: "Code index coverage paths must be in strictly ascending lexicographic order.",
          path: ["coverage", index, "path"]
        });
      }
      previousCoveragePath = coverage.path;
    }

    const seenIds = new Set<string>();

    for (const arrayName of FACT_ARRAYS) {
      const facts = snapshot[arrayName] as readonly CodeIndexFactValue[];
      for (const [index, fact] of facts.entries()) {
        if (seenIds.has(fact.id)) {
          context.addIssue({
            code: "custom",
            message: "Code index fact IDs must be unique within a snapshot.",
            path: [arrayName, index, "id"]
          });
        }
        seenIds.add(fact.id);

        if (index === 0) continue;
        const previous = facts[index - 1];
        if (previous !== undefined && compareFacts(previous, fact) > 0) {
          context.addIssue({
            code: "custom",
            message: "Code index facts must be sorted by path, startByte, and ID.",
            path: [arrayName, index]
          });
        }
      }
    }
  });

export type CodeIndexSnapshot = z.infer<typeof codeIndexSnapshotSchema>;

export type CodeIndexFact = CodeIndexFactValue;
export type CodeIndexFactArray = CodeIndexFactArrayName;
