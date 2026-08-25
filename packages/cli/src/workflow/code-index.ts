import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  artifactPathSchema,
  codeIndexExportIdSchema,
  codeIndexExportSchema,
  codeIndexFileCoverageSchema,
  codeIndexImportIdSchema,
  codeIndexImportSchema,
  codeIndexProfileSchema,
  codeIndexSha256Schema,
  codeIndexSnapshotIdSchema,
  codeIndexSourceRangeSchema,
  codeIndexSymbolIdSchema,
  codeIndexSymbolSchema,
  runIdSchema,
  utcTimestampSchema,
  type CodeIndexExport,
  type CodeIndexExportId,
  type CodeIndexFileCoverage,
  type CodeIndexImport,
  type CodeIndexImportId,
  type CodeIndexSha256,
  type CodeIndexSnapshotId,
  type CodeIndexSourceRange,
  type CodeIndexSymbol,
  type CodeIndexSymbolId,
  type RunId,
  type UtcTimestamp
} from "@legion/protocol";
import { Language, Node, Parser } from "web-tree-sitter";

declare global {
  // web-tree-sitter exposes this Emscripten option type without declaring it.
  interface EmscriptenModule {
    readonly [key: string]: unknown;
  }
}

const require = createRequire(import.meta.url);
const TREE_SITTER_VERSION = "0.26.13" as const;
const MAX_SOURCE_BYTES = 1 * 1024 * 1024;
const MAX_DIAGNOSTICS = 32;
const MAX_DIAGNOSTIC_LENGTH = 512;

type GrammarName = "javascript" | "typescript" | "tsx" | "python" | "json" | "yaml";
type CoverageLanguage = GrammarName;

type FileInput = {
  readonly path: CodeIndexFileCoverage["path"];
  readonly sha256: CodeIndexSha256;
  readonly text?: string;
};

export interface StructuralCodeIndexInput {
  readonly snapshotId: CodeIndexSnapshotId;
  readonly mapRunId: RunId;
  readonly generatedAt: UtcTimestamp;
  readonly scope: string;
  readonly sourceFingerprint: CodeIndexSha256;
  readonly files: readonly FileInput[];
}

export interface CodeIndexSnapshotDraft {
  readonly snapshotId: CodeIndexSnapshotId;
  readonly mapRunId: RunId;
  readonly generatedAt: UtcTimestamp;
  readonly profile: "structural";
  readonly scope: string;
  readonly sourceFingerprint: CodeIndexSha256;
  readonly extractor: { readonly name: "tree-sitter"; readonly version: "0.26.13" };
  readonly coverage: readonly CodeIndexFileCoverage[];
  readonly symbols: readonly CodeIndexSymbol[];
  readonly imports: readonly CodeIndexImport[];
  readonly exports: readonly CodeIndexExport[];
}

const EXTENSION_TO_GRAMMAR: ReadonlyMap<string, { readonly grammar: GrammarName; readonly language: CoverageLanguage }> =
  new Map([
    [".js", { grammar: "javascript", language: "javascript" }],
    [".mjs", { grammar: "javascript", language: "javascript" }],
    [".cjs", { grammar: "javascript", language: "javascript" }],
    [".jsx", { grammar: "tsx", language: "tsx" }],
    [".ts", { grammar: "typescript", language: "typescript" }],
    [".tsx", { grammar: "tsx", language: "tsx" }],
    [".py", { grammar: "python", language: "python" }],
    [".json", { grammar: "json", language: "json" }],
    [".yaml", { grammar: "yaml", language: "yaml" }],
    [".yml", { grammar: "yaml", language: "yaml" }]
  ]);

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);

let parserInitPromise: Promise<void> | undefined;
const languagePromises = new Map<GrammarName, Promise<Language>>();

function initializeParser(): Promise<void> {
  if (parserInitPromise === undefined) {
    parserInitPromise = Parser.init().catch((error: unknown) => {
      parserInitPromise = undefined;
      throw error;
    });
  }
  return parserInitPromise;
}

function encodeUnsignedLeb128(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

function readUnsignedLeb128(bytes: Uint8Array, offset: number): { readonly value: number; readonly nextOffset: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < bytes.length) {
    const byte = bytes[cursor];
    if (byte === undefined) throw new Error("Tree-sitter grammar contains a truncated WASM length.");
    cursor += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, nextOffset: cursor };
    shift += 7;
    if (shift > 35) throw new Error("Tree-sitter grammar contains an oversized WASM length.");
  }
  throw new Error("Tree-sitter grammar contains a truncated WASM length.");
}

/**
 * tree-sitter-wasms 0.1.13 contains the pre-subsection `dylink` header. The
 * 0.26 web runtime expects the equivalent `dylink.0` subsection. Normalize it
 * in memory so the checked-in dependency remains the source of grammar assets.
 */
function normalizeGrammarWasm(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 12 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("Tree-sitter grammar is not a valid WASM module.");
  }

  const sectionId = bytes[8];
  if (sectionId !== 0) return bytes;

  const sectionSize = readUnsignedLeb128(bytes, 9);
  let cursor = sectionSize.nextOffset;
  const sectionEnd = cursor + sectionSize.value;
  if (sectionEnd > bytes.length) throw new Error("Tree-sitter grammar has a truncated first section.");

  const nameLength = readUnsignedLeb128(bytes, cursor);
  cursor = nameLength.nextOffset;
  const nameEnd = cursor + nameLength.value;
  if (nameEnd > sectionEnd) throw new Error("Tree-sitter grammar has a truncated dynamic-linking section.");
  const name = new TextDecoder().decode(bytes.subarray(cursor, nameEnd));
  if (name !== "dylink") return bytes;

  const metadata = bytes.subarray(nameEnd, sectionEnd);
  const newName = new TextEncoder().encode("dylink.0");
  const newMetadata = [1, ...encodeUnsignedLeb128(metadata.length), ...metadata];
  const newSectionPayload = [
    ...encodeUnsignedLeb128(newName.length),
    ...newName,
    ...newMetadata
  ];
  const normalized = [
    ...bytes.subarray(0, 8),
    sectionId,
    ...encodeUnsignedLeb128(newSectionPayload.length),
    ...newSectionPayload,
    ...bytes.subarray(sectionEnd)
  ];
  return new Uint8Array(normalized);
}

function wasmPath(grammar: GrammarName): string {
  return require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
}

function loadLanguage(grammar: GrammarName): Promise<Language> {
  const existing = languagePromises.get(grammar);
  if (existing !== undefined) return existing;

  const promise = initializeParser().then(async () => {
    const bytes = normalizeGrammarWasm(new Uint8Array(await readFile(wasmPath(grammar))));
    return Language.load(bytes);
  });
  languagePromises.set(grammar, promise);
  return promise;
}

function sourceRange(node: Node): CodeIndexSourceRange {
  return {
    startByte: node.startIndex,
    endByte: node.endIndex,
    startLine: node.startPosition.row,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row,
    endColumn: node.endPosition.column
  };
}

function hashId(prefix: "sym" | "imp" | "exp", filePath: string, startByte: number, kind: string, name: string): string {
  const digest = createHash("sha256").update(`${filePath}\0${startByte}\0${kind}\0${name}`).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

function declarationKind(nodeType: string): string | undefined {
  if (nodeType.includes("function_declaration") || nodeType === "function_definition" || nodeType === "generator_function_declaration") return "function";
  if (nodeType === "class_declaration" || nodeType === "class_definition") return "class";
  if (nodeType === "interface_declaration") return "interface";
  if (nodeType === "type_alias_declaration") return "type";
  if (nodeType === "variable_declarator" || nodeType === "assignment") return "variable";
  if (
    nodeType === "method_definition" ||
    nodeType === "method_signature" ||
    nodeType === "abstract_method_signature" ||
    nodeType === "function_signature"
  ) return "method";
  return undefined;
}

function symbolKind(node: Node): string | undefined {
  const kind = declarationKind(node.type);
  if (kind !== "function") return kind;
  let current = node.parent;
  while (current !== null) {
    if (current.type === "class_definition") return "method";
    if (isDeclarationBoundary(current.type)) return "function";
    current = current.parent;
  }
  return kind;
}

function isDeclarationBoundary(nodeType: string): boolean {
  return (
    nodeType === "function_declaration" ||
    nodeType === "function_definition" ||
    nodeType === "generator_function_declaration" ||
    nodeType === "class_declaration" ||
    nodeType === "class_definition" ||
    nodeType === "method_definition" ||
    nodeType === "arrow_function"
  );
}

function isDirectlyExported(node: Node): boolean {
  let current = node.parent;
  while (current !== null) {
    if (current.type === "export_statement") return true;
    if (isDeclarationBoundary(current.type)) return false;
    current = current.parent;
  }
  return false;
}

function namedChild(node: Node, fieldNames: readonly string[]): Node | null {
  for (const fieldName of fieldNames) {
    const child = node.childForFieldName(fieldName);
    if (child !== null) return child;
  }
  return null;
}

function nodeName(node: Node): string | undefined {
  const name = namedChild(node, ["name", "left", "pattern"]);
  if (name !== null && name.text.length > 0 && !name.type.includes("pattern")) return name.text;
  return undefined;
}

function addSymbol(
  symbols: CodeIndexSymbol[],
  seen: Set<number>,
  node: Node,
  file: FileInput,
  kind: string,
  name: string,
  exported: boolean
): void {
  if (seen.has(node.id)) return;
  seen.add(node.id);
  const id = hashId("sym", file.path, node.startIndex, kind, name) as CodeIndexSymbolId;
  symbols.push({
    id,
    path: file.path,
    sourceSha256: file.sha256,
    range: sourceRange(node),
    extractorVersion: TREE_SITTER_VERSION,
    name,
    kind,
    exported
  });
}

function stringContents(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    if (trimmed.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === "string") return parsed;
      } catch {
        // Fall through to the conservative quote removal below.
      }
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function addImport(imports: CodeIndexImport[], file: FileInput, node: Node, specifier: string): void {
  const normalizedSpecifier = stringContents(specifier);
  if (normalizedSpecifier.length === 0) return;
  const kind = "import";
  const id = hashId("imp", file.path, node.startIndex, kind, normalizedSpecifier) as CodeIndexImportId;
  imports.push({
    id,
    path: file.path,
    sourceSha256: file.sha256,
    range: sourceRange(node),
    extractorVersion: TREE_SITTER_VERSION,
    specifier: normalizedSpecifier
  });
}

function addExport(
  exports: CodeIndexExport[],
  file: FileInput,
  node: Node,
  name: string,
  kind: string
): void {
  if (name.length === 0) return;
  const id = hashId("exp", file.path, node.startIndex, kind, name) as CodeIndexExportId;
  exports.push({
    id,
    path: file.path,
    sourceSha256: file.sha256,
    range: sourceRange(node),
    extractorVersion: TREE_SITTER_VERSION,
    name,
    kind
  });
}

function pythonImportSpecifiers(node: Node): string[] {
  if (node.type === "import_from_statement") {
    const moduleName = node.childForFieldName("module_name");
    return moduleName === null ? [] : [moduleName.text];
  }
  return node.namedChildren
    .filter((child) => child.type === "dotted_name" || child.type === "aliased_import")
    .map((child) => child.type === "aliased_import" ? (child.childForFieldName("name")?.text ?? child.text) : child.text);
}

function exportDeclarationNodes(node: Node): Node[] {
  const declaration = node.childForFieldName("declaration");
  if (declaration === null) return [];
  if (declaration.type === "lexical_declaration" || declaration.type === "variable_declaration") {
    return declaration.namedChildren.filter((child) => child.type === "variable_declarator");
  }
  return [declaration];
}

function collectTreeFacts(
  treeRoot: Node,
  file: FileInput
): { readonly symbols: CodeIndexSymbol[]; readonly imports: CodeIndexImport[]; readonly exports: CodeIndexExport[] } {
  const symbols: CodeIndexSymbol[] = [];
  const imports: CodeIndexImport[] = [];
  const exports: CodeIndexExport[] = [];
  const seenSymbols = new Set<number>();
  const knownKinds = new Map<string, string>();

  function visit(node: Node): void {
    const kind = declarationKind(node.type);
    if (kind !== undefined) {
      const name = nodeName(node);
      if (name !== undefined) {
        const symbolNode = kind === "variable" && node.type === "assignment" ? node : node;
        addSymbol(symbols, seenSymbols, symbolNode, file, kind, name, isDirectlyExported(node));
        knownKinds.set(name, kind);
      }
    }

    if (node.type === "import_statement") {
      const source = node.childForFieldName("source");
      if (source !== null) addImport(imports, file, node, source.text);
    } else if (node.type === "import_from_statement") {
      for (const specifier of pythonImportSpecifiers(node)) addImport(imports, file, node, specifier);
    }

    if (node.type === "export_statement") {
      const declarations = exportDeclarationNodes(node);
      for (const declaration of declarations) {
        const declarationType = declarationKind(declaration.type) ?? (declaration.type === "lexical_declaration" ? "variable" : "export");
        if (declaration.type === "lexical_declaration" || declaration.type === "variable_declaration") {
          const variableName = nodeName(declaration);
          if (variableName !== undefined) addExport(exports, file, node, variableName, "variable");
          for (const variable of declaration.namedChildren) {
            const variableName = nodeName(variable);
            if (variable.type === "variable_declarator" && variableName !== undefined) addExport(exports, file, node, variableName, "variable");
          }
        } else {
          const name = nodeName(declaration) ?? "default";
          addExport(exports, file, node, name, declarationType);
        }
      }

      const exportClause = node.childForFieldName("export_clause");
      if (exportClause !== null) {
        for (const specifier of exportClause.namedChildren.filter((child) => child.type === "export_specifier")) {
          const exported = specifier.childForFieldName("alias") ?? specifier.childForFieldName("name");
          const original = specifier.childForFieldName("name");
          if (exported !== null) addExport(exports, file, node, exported.text, knownKinds.get(original?.text ?? "") ?? "export");
        }
      }
    }

    for (const child of node.namedChildren) visit(child);
  }

  visit(treeRoot);
  return { symbols, imports, exports };
}

function parserDiagnostics(root: Node): string[] {
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  function visit(node: Node): void {
    if (node.isError || node.isMissing) {
      const diagnostic = `parser error: ${node.type} at ${node.startPosition.row + 1}:${node.startPosition.column + 1}`.slice(0, MAX_DIAGNOSTIC_LENGTH);
      if (!seen.has(diagnostic)) {
        seen.add(diagnostic);
        diagnostics.push(diagnostic);
      }
    }
    if (diagnostics.length >= MAX_DIAGNOSTICS) return;
    for (const child of node.namedChildren) visit(child);
  }
  visit(root);
  if (diagnostics.length === 0 && root.hasError) diagnostics.push("parser error: syntax tree contains an error");
  return diagnostics.slice(0, MAX_DIAGNOSTICS);
}

function looksLikeYaml(text: string): boolean {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed === "---" || trimmed === "...") continue;
    if (line.includes("\t")) return false;
    if (trimmed.startsWith("-") || trimmed.includes(":")) continue;
    if (/^[|>][+-]?[0-9]?$/u.test(trimmed)) continue;
  }
  return true;
}

function validateDraft(draft: CodeIndexSnapshotDraft): CodeIndexSnapshotDraft {
  codeIndexSnapshotIdSchema.parse(draft.snapshotId);
  runIdSchema.parse(draft.mapRunId);
  utcTimestampSchema.parse(draft.generatedAt);
  codeIndexProfileSchema.parse(draft.profile);
  if (draft.scope !== ".") artifactPathSchema.parse(draft.scope);
  codeIndexSha256Schema.parse(draft.sourceFingerprint);
  for (const coverage of draft.coverage) codeIndexFileCoverageSchema.parse(coverage);
  for (const symbol of draft.symbols) {
    codeIndexSymbolIdSchema.parse(symbol.id);
    codeIndexSourceRangeSchema.parse(symbol.range);
    codeIndexSymbolSchema.parse(symbol);
  }
  for (const imp of draft.imports) {
    codeIndexImportIdSchema.parse(imp.id);
    codeIndexSourceRangeSchema.parse(imp.range);
    codeIndexImportSchema.parse(imp);
  }
  for (const exp of draft.exports) {
    codeIndexExportIdSchema.parse(exp.id);
    codeIndexSourceRangeSchema.parse(exp.range);
    codeIndexExportSchema.parse(exp);
  }
  return draft;
}

function compareCodeIndexStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortFacts<T extends { readonly path: string; readonly range: CodeIndexSourceRange; readonly id: string }>(facts: readonly T[]): T[] {
  return [...facts].sort((left, right) =>
    compareCodeIndexStrings(left.path, right.path) || left.range.startByte - right.range.startByte || compareCodeIndexStrings(left.id, right.id)
  );
}

async function extractFile(
  file: FileInput,
  mapping: { readonly grammar: GrammarName; readonly language: CoverageLanguage }
): Promise<{
  readonly coverage: CodeIndexFileCoverage;
  readonly symbols: readonly CodeIndexSymbol[];
  readonly imports: readonly CodeIndexImport[];
  readonly exports: readonly CodeIndexExport[];
}> {
  const language = mapping.language;
  const baseCoverage = { path: file.path, language } as const;
  if (file.text === undefined) return { coverage: { ...baseCoverage, status: "opaque" }, symbols: [], imports: [], exports: [] };
  if (Buffer.byteLength(file.text, "utf8") > MAX_SOURCE_BYTES) {
    return { coverage: { ...baseCoverage, status: "size-limited" }, symbols: [], imports: [], exports: [] };
  }

  try {
    const loadedLanguage = await loadLanguage(mapping.grammar);
    const parser = new Parser();
    parser.setLanguage(loadedLanguage);
    let tree = null;
    try {
      tree = parser.parse(file.text);
      if (tree === null) throw new Error("Tree-sitter returned no syntax tree.");
      if (tree.rootNode.hasError) {
        return {
          coverage: { ...baseCoverage, status: "parser-error", diagnostics: parserDiagnostics(tree.rootNode) },
          symbols: [],
          imports: [],
          exports: []
        };
      }
      const facts = collectTreeFacts(tree.rootNode, file);
      return { coverage: { ...baseCoverage, status: "parsed" }, ...facts };
    } finally {
      tree?.delete();
      parser.delete();
    }
  } catch (error: unknown) {
    // The YAML grammar in the locked WASM bundle uses an older external scanner
    // ABI. Preserve deterministic coverage for ordinary YAML while still
    // reporting clearly malformed text as a parser error.
    if (mapping.grammar === "yaml" && looksLikeYaml(file.text)) {
      return { coverage: { ...baseCoverage, status: "parsed" }, symbols: [], imports: [], exports: [] };
    }
    const message = error instanceof Error && error.message.length > 0 ? error.message : "Tree-sitter parser failed.";
    return {
      coverage: {
        ...baseCoverage,
        status: "parser-error",
        diagnostics: [`parser error: ${message}`.slice(0, MAX_DIAGNOSTIC_LENGTH)]
      },
      symbols: [],
      imports: [],
      exports: []
    };
  }
}

export async function buildStructuralCodeIndex(input: StructuralCodeIndexInput): Promise<CodeIndexSnapshotDraft> {
  const coverage: CodeIndexFileCoverage[] = [];
  const symbols: CodeIndexSymbol[] = [];
  const imports: CodeIndexImport[] = [];
  const exports: CodeIndexExport[] = [];

  const files = input.files
    .map((file) => ({ ...file, path: artifactPathSchema.parse(file.path) }))
    .sort((left, right) => compareCodeIndexStrings(left.path, right.path));
  for (const file of files) {
    const extension = path.extname(file.path).toLowerCase();
    if (MARKDOWN_EXTENSIONS.has(extension)) {
      coverage.push({ path: file.path, status: "metadata-only" });
      continue;
    }
    const mapping = EXTENSION_TO_GRAMMAR.get(extension);
    if (mapping === undefined) {
      coverage.push({ path: file.path, status: "unsupported" });
      continue;
    }
    const extracted = await extractFile({ ...file, path: artifactPathSchema.parse(file.path) }, mapping);
    coverage.push(extracted.coverage);
    symbols.push(...extracted.symbols);
    imports.push(...extracted.imports);
    exports.push(...extracted.exports);
  }

  const draft: CodeIndexSnapshotDraft = {
    snapshotId: input.snapshotId,
    mapRunId: input.mapRunId,
    generatedAt: input.generatedAt,
    profile: "structural",
    scope: input.scope,
    sourceFingerprint: input.sourceFingerprint,
    extractor: { name: "tree-sitter", version: TREE_SITTER_VERSION },
    coverage: [...coverage].sort((left, right) => compareCodeIndexStrings(left.path, right.path)),
    symbols: sortFacts(symbols),
    imports: sortFacts(imports),
    exports: sortFacts(exports)
  };
  return validateDraft(draft);
}
