import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  codeIndexExportIdSchema,
  codeIndexExportSchema,
  codeIndexFileCoverageSchema,
  codeIndexImportIdSchema,
  codeIndexImportSchema,
  codeIndexProfileSchema,
  codeIndexSha256Schema,
  codeIndexSourcePathSchema,
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
import { parseAllDocuments } from "yaml";
import { Language, Node, Parser } from "web-tree-sitter";

declare global {
  // web-tree-sitter exposes this Emscripten option type without declaring it.
  interface EmscriptenModule {
    readonly [key: string]: unknown;
  }
}

const require = createRequire(import.meta.url);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const TREE_SITTER_VERSION = "0.26.13" as const;
const MAX_SOURCE_BYTES = 1 * 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_DIAGNOSTICS = 32;
const MAX_DIAGNOSTIC_LENGTH = 512;

type GrammarName = "javascript" | "typescript" | "tsx" | "python" | "json" | "yaml";
type CoverageLanguage = GrammarName;

const GRAMMAR_ASSET_NAMES: Readonly<Record<GrammarName, string>> = Object.freeze({
  javascript: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  python: "tree-sitter-python.wasm",
  json: "tree-sitter-json.wasm",
  yaml: "tree-sitter-yaml.wasm"
});

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
  const assetName = GRAMMAR_ASSET_NAMES[grammar];
  const bundledPath = path.join(moduleDirectory, assetName);
  if (existsSync(bundledPath)) return bundledPath;

  try {
    return require.resolve(`tree-sitter-wasms/out/${assetName}`);
  } catch (error) {
    throw new Error(
      `Unable to resolve Tree-sitter grammar asset ${assetName} from ${bundledPath} or tree-sitter-wasms/out/.`,
      { cause: error }
    );
  }
}

function loadLanguage(grammar: GrammarName): Promise<Language> {
  const existing = languagePromises.get(grammar);
  if (existing !== undefined) return existing;

  const promise = initializeParser().then(async () => {
    const bytes = normalizeGrammarWasm(new Uint8Array(await readFile(wasmPath(grammar))));
    return Language.load(bytes);
  });
  languagePromises.set(grammar, promise);
  void promise.catch(() => {
    if (languagePromises.get(grammar) === promise) languagePromises.delete(grammar);
  });
  return promise;
}

function utf8ByteLengthForCodeUnit(codeUnit: number): number {
  if (codeUnit <= 0x7f) return 1;
  if (codeUnit <= 0x7ff) return 2;
  return 3;
}

function utf8OffsetTable(text: string): Uint32Array {
  const offsets = new Uint32Array(text.length + 1);
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    const nextCodeUnit = text.charCodeAt(index + 1);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
      // Buffer.byteLength(text.slice(0, offset), "utf8") encodes a lone
      // high surrogate as U+FFFD, while the complete pair is four bytes.
      offsets[index + 1] = offsets[index] ?? 0;
      offsets[index + 2] = (offsets[index] ?? 0) + 4;
      index += 1;
      continue;
    }
    offsets[index + 1] = (offsets[index] ?? 0) + utf8ByteLengthForCodeUnit(codeUnit);
  }
  return offsets;
}

function sourceRange(node: Node, offsets: Uint32Array): CodeIndexSourceRange {
  return {
    startByte: offsets[node.startIndex] ?? 0,
    endByte: offsets[node.endIndex] ?? 0,
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

function isLexicalScopeBoundary(nodeType: string): boolean {
  return (
    nodeType === "program" ||
    nodeType === "statement_block" ||
    nodeType === "switch_statement" ||
    nodeType === "switch_body" ||
    nodeType === "for_statement" ||
    nodeType === "for_in_statement" ||
    nodeType === "for_of_statement" ||
    nodeType === "catch_clause" ||
    nodeType === "class_body" ||
    nodeType === "function_declaration" ||
    nodeType === "function_definition" ||
    nodeType === "generator_function_declaration" ||
    nodeType === "method_definition" ||
    nodeType === "arrow_function"
  );
}

function isVarScopeBoundary(nodeType: string): boolean {
  return (
    nodeType === "program" ||
    nodeType === "module" ||
    nodeType === "module_declaration" ||
    nodeType === "internal_module" ||
    nodeType === "function_declaration" ||
    nodeType === "function_definition" ||
    nodeType === "function_expression" ||
    nodeType === "generator_function" ||
    nodeType === "generator_function_declaration" ||
    nodeType === "method_definition" ||
    nodeType === "arrow_function" ||
    nodeType === "class_static_block" ||
    nodeType === "static_block"
  );
}

function isVarBinding(node: Node): boolean {
  let current: Node | null = node;
  while (current !== null) {
    if (current.type === "variable_declaration") {
      const kind = current.childForFieldName("kind");
      return kind?.text === "var" || current.text.trim().startsWith("var");
    }
    current = current.parent;
  }
  return false;
}

function lexicalScope(node: Node, root: Node): Node {
  const varBinding = isVarBinding(node);
  let current = node.parent;
  while (current !== null) {
    if ((varBinding ? isVarScopeBoundary(current.type) : isLexicalScopeBoundary(current.type))) return current;
    current = current.parent;
  }
  return root;
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

function bindingIdentifierNodes(pattern: Node): Node[] {
  const bindings: Node[] = [];

  function visit(node: Node): void {
    if (node.type === "identifier" || node.type === "shorthand_property_identifier_pattern") {
      bindings.push(node);
      return;
    }
    if (node.type === "pair_pattern") {
      const value = node.childForFieldName("value");
      if (value !== null) visit(value);
      return;
    }
    if (node.type === "object_assignment_pattern" || node.type === "assignment_pattern") {
      const left = node.childForFieldName("left");
      if (left !== null) visit(left);
      return;
    }
    if (
      node.type === "array_pattern" ||
      node.type === "object_pattern" ||
      node.type === "rest_pattern" ||
      node.type === "tuple_pattern" ||
      node.type === "list_pattern" ||
      node.type === "list_splat_pattern" ||
      node.type === "dictionary_splat_pattern" ||
      node.type === "pattern_list"
    ) {
      for (const child of node.namedChildren) visit(child);
    }
  }

  visit(pattern);
  return bindings;
}

function addSymbol(
  symbols: CodeIndexSymbol[],
  seen: Set<number>,
  node: Node,
  file: FileInput,
  offsets: Uint32Array,
  kind: string,
  name: string,
  exported: boolean
): number | undefined {
  if (seen.has(node.id)) return undefined;
  seen.add(node.id);
  const range = sourceRange(node, offsets);
  const id = hashId("sym", file.path, range.startByte, kind, name) as CodeIndexSymbolId;
  symbols.push({
    id,
    path: file.path,
    sourceSha256: file.sha256,
    range,
    extractorVersion: TREE_SITTER_VERSION,
    name,
    kind,
    exported
  });
  return symbols.length - 1;
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

function addImport(
  imports: CodeIndexImport[],
  file: FileInput,
  node: Node,
  offsets: Uint32Array,
  specifier: string,
  seenIds: Set<string>
): void {
  const normalizedSpecifier = stringContents(specifier);
  if (normalizedSpecifier.length === 0) return;
  const kind = "import";
  const range = sourceRange(node, offsets);
  const id = hashId("imp", file.path, range.startByte, kind, normalizedSpecifier) as CodeIndexImportId;
  if (seenIds.has(id)) return;
  seenIds.add(id);
  imports.push({
    id,
    path: file.path,
    sourceSha256: file.sha256,
    range,
    extractorVersion: TREE_SITTER_VERSION,
    specifier: normalizedSpecifier
  });
}

function addExport(
  exports: CodeIndexExport[],
  file: FileInput,
  node: Node,
  offsets: Uint32Array,
  name: string,
  kind: string
): void {
  if (name.length === 0) return;
  const range = sourceRange(node, offsets);
  const id = hashId("exp", file.path, range.startByte, kind, name) as CodeIndexExportId;
  exports.push({
    id,
    path: file.path,
    sourceSha256: file.sha256,
    range,
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

function exportDeclarationNodes(node: Node, defaultExport: boolean): Node[] {
  const declaration = node.childForFieldName("declaration");
  if (declaration === null) {
    if (!defaultExport) return [];
    return node.namedChildren.filter((child) => child.type !== "export_clause");
  }
  if (declaration.type === "lexical_declaration" || declaration.type === "variable_declaration") {
    return declaration.namedChildren.filter((child) => child.type === "variable_declarator");
  }
  return [declaration];
}

function exportDeclarationKind(node: Node): string {
  const kind = declarationKind(node.type);
  if (kind !== undefined) return kind;
  if (node.type === "function_expression") return "function";
  if (node.type === "class") return "class";
  return "export";
}

function isDefaultExport(node: Node): boolean {
  return node.children.some((child) => child.type === "default") || /^export\s+default(?:\s|$)/.test(node.text);
}

function collectTreeFacts(
  treeRoot: Node,
  file: FileInput,
  grammar: GrammarName,
  offsets: Uint32Array
): { readonly symbols: CodeIndexSymbol[]; readonly imports: CodeIndexImport[]; readonly exports: CodeIndexExport[] } {
  const symbols: CodeIndexSymbol[] = [];
  const imports: CodeIndexImport[] = [];
  const exports: CodeIndexExport[] = [];
  const seenSymbols = new Set<number>();
  const seenImportIds = new Set<string>();
  type DeclarationBinding = {
    readonly symbolIndex: number;
    readonly declaration: Node;
    readonly scope: Node;
    readonly name: string;
    readonly kind: string;
  };
  const declarationBindingsByScopeAndName = new Map<string, DeclarationBinding[]>();
  const namedExports: Array<{ readonly node: Node; readonly original: string; readonly exported: string }> = [];
  const defaultBindings: Array<{ readonly node: Node; readonly name: string }> = [];
  const emittedExports = new Set<string>();

  function declarationBindingKey(scope: Node, name: string): string {
    return `${scope.id}\u0000${name}`;
  }

  function addDeclarationBinding(binding: DeclarationBinding): void {
    const key = declarationBindingKey(binding.scope, binding.name);
    const bindings = declarationBindingsByScopeAndName.get(key);
    if (bindings === undefined) {
      declarationBindingsByScopeAndName.set(key, [binding]);
    } else {
      bindings.push(binding);
    }
  }

  function emitExport(node: Node, name: string, kind: string): void {
    const scope = lexicalScope(node, treeRoot);
    const key = `${name}\u0000${kind}\u0000${node.id}\u0000${node.startIndex}\u0000${node.endIndex}\u0000${scope.id}`;
    if (emittedExports.has(key)) return;
    emittedExports.add(key);
    addExport(exports, file, node, offsets, name, kind);
  }

  function resolveNamedExport(name: string, exportNode: Node): DeclarationBinding | undefined {
    const exportScope = lexicalScope(exportNode, treeRoot);
    const bindings = declarationBindingsByScopeAndName.get(declarationBindingKey(exportScope, name)) ?? [];
    let preceding: DeclarationBinding | undefined;
    let following: DeclarationBinding | undefined;
    for (const binding of bindings) {
      if (binding.declaration.endIndex <= exportNode.startIndex) {
        if (preceding === undefined || binding.declaration.endIndex > preceding.declaration.endIndex) preceding = binding;
      } else if (binding.declaration.startIndex >= exportNode.endIndex) {
        if (following === undefined || binding.declaration.startIndex < following.declaration.startIndex) following = binding;
      }
    }
    return preceding ?? following;
  }

  function markBindingExported(binding: DeclarationBinding | undefined): void {
    if (binding === undefined) return;
    const symbol = symbols[binding.symbolIndex];
    if (symbol !== undefined) symbols[binding.symbolIndex] = { ...symbol, exported: true };
  }

  function visit(node: Node): void {
    const kind = symbolKind(node);
    if (kind !== undefined) {
      if (node.type === "variable_declarator" || (grammar === "python" && node.type === "assignment")) {
        const pattern = namedChild(node, ["name", "left", "pattern"]);
        const bindings =
          pattern === null
            ? []
            : grammar === "python" && node.type === "assignment"
              ? pattern.type === "identifier" ? [pattern] : []
              : bindingIdentifierNodes(pattern);
        for (const binding of bindings) {
          const symbolNode = pattern !== null && binding.id === pattern.id ? node : binding;
          const name = binding.text;
          const symbolIndex = addSymbol(symbols, seenSymbols, symbolNode, file, offsets, kind, name, isDirectlyExported(symbolNode));
          if (symbolIndex !== undefined) {
            addDeclarationBinding({ symbolIndex, declaration: node, scope: lexicalScope(node, treeRoot), name, kind });
          }
        }
      } else {
        const name = nodeName(node);
        if (name !== undefined) {
          const symbolIndex = addSymbol(symbols, seenSymbols, node, file, offsets, kind, name, isDirectlyExported(node));
          if (symbolIndex !== undefined) {
            addDeclarationBinding({ symbolIndex, declaration: node, scope: lexicalScope(node, treeRoot), name, kind });
          }
        }
      }
    }

    if (node.type === "import_statement") {
      if (grammar === "python") {
        for (const specifier of pythonImportSpecifiers(node)) addImport(imports, file, node, offsets, specifier, seenImportIds);
      } else {
        const source = node.childForFieldName("source");
        if (source !== null) addImport(imports, file, node, offsets, source.text, seenImportIds);
      }
    } else if (node.type === "import_from_statement") {
      for (const specifier of pythonImportSpecifiers(node)) addImport(imports, file, node, offsets, specifier, seenImportIds);
    }

    if (node.type === "export_statement") {
      const defaultExport = isDefaultExport(node);
      const declarations = exportDeclarationNodes(node, defaultExport);
      for (const declaration of declarations) {
        if (!defaultExport && declaration.type === "variable_declarator") {
          const pattern = namedChild(declaration, ["name", "left", "pattern"]);
          const bindings = pattern === null ? [] : bindingIdentifierNodes(pattern);
          for (const binding of bindings) emitExport(node, binding.text, "variable");
          continue;
        }
        const declarationType = exportDeclarationKind(declaration);
        const name = defaultExport ? "default" : (nodeName(declaration) ?? "default");
        emitExport(node, name, declarationType);
      }
      const defaultDeclaration = declarations[0];
      if (defaultExport && declarations.length === 1 && defaultDeclaration?.type === "identifier") {
        defaultBindings.push({ node, name: defaultDeclaration.text });
      }

      const exportClause = node.namedChildren.find((child) => child.type === "export_clause");
      const externalModule = node.childForFieldName("source") ?? node.childForFieldName("module");
      if (exportClause !== undefined) {
        for (const specifier of exportClause.namedChildren.filter((child) => child.type === "export_specifier")) {
          const exported = specifier.childForFieldName("alias") ?? specifier.childForFieldName("name");
          const original = specifier.childForFieldName("name");
          if (original !== null && exported !== null) {
            if (externalModule !== null) emitExport(node, exported.text, "export");
            else namedExports.push({ node, original: original.text, exported: exported.text });
          }
        }
      }
      const namespaceExport = node.namedChildren.find((child) => child.type === "namespace_export");
      if (namespaceExport !== undefined) {
        const name = namespaceExport.childForFieldName("name") ?? namespaceExport.namedChildren.find((child) => child.type === "identifier");
        if (name !== undefined) emitExport(node, name.text, "export");
      }
    }

    for (const child of node.namedChildren) visit(child);
  }

  visit(treeRoot);
  for (const defaultBinding of defaultBindings) {
    markBindingExported(resolveNamedExport(defaultBinding.name, defaultBinding.node));
  }
  for (const namedExport of namedExports) {
    const binding = resolveNamedExport(namedExport.original, namedExport.node);
    markBindingExported(binding);
    emitExport(namedExport.node, namedExport.exported, binding?.kind ?? "export");
  }
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

/**
 * YAML parser messages may include source fragments. Keep diagnostics bounded and
 * provenance-safe by exposing only a stable error type and optional line.
 */
function yamlParserDiagnostic(error: unknown): string {
  let line = 1;
  if (typeof error === "object" && error !== null && "linePos" in error) {
    const linePos = (error as { readonly linePos?: unknown }).linePos;
    if (Array.isArray(linePos)) {
      const first = linePos[0];
      if (typeof first === "object" && first !== null && "line" in first) {
        const candidate = (first as { readonly line?: unknown }).line;
        if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) line = Math.min(candidate, 1_000_000);
      }
    }
  }
  return `yaml parser error at line ${line}: document rejected`;
}

/**
 * Keep Tree-sitter as the first YAML parser attempt. The pinned
 * tree-sitter-wasms@0.1.13 YAML grammar uses an external-scanner ABI that
 * throws under web-tree-sitter@0.26.13, so this compatibility path uses the
 * real `yaml` parser rather than a heuristic success check.
 */
function parseYamlCompatibilityFallback(
  file: FileInput,
  baseCoverage: { readonly path: CodeIndexFileCoverage["path"]; readonly language: CoverageLanguage }
): {
  readonly coverage: CodeIndexFileCoverage;
  readonly symbols: readonly CodeIndexSymbol[];
  readonly imports: readonly CodeIndexImport[];
  readonly exports: readonly CodeIndexExport[];
} {
  try {
    const documents = parseAllDocuments(file.text ?? "");
    const parserErrors = documents.flatMap((document) => document.errors);
    if (parserErrors.length > 0) {
      return {
        coverage: {
          ...baseCoverage,
          status: "parser-error",
          diagnostics: parserErrors
            .slice(0, MAX_DIAGNOSTICS)
            .map((error) => yamlParserDiagnostic(error))
        },
        symbols: [],
        imports: [],
        exports: []
      };
    }
    return { coverage: { ...baseCoverage, status: "parsed" }, symbols: [], imports: [], exports: [] };
  } catch (error: unknown) {
    return {
      coverage: {
        ...baseCoverage,
        status: "parser-error",
        diagnostics: [yamlParserDiagnostic(error)]
      },
      symbols: [],
      imports: [],
      exports: []
    };
  }
}

function validateDraft(draft: CodeIndexSnapshotDraft): CodeIndexSnapshotDraft {
  codeIndexSnapshotIdSchema.parse(draft.snapshotId);
  runIdSchema.parse(draft.mapRunId);
  utcTimestampSchema.parse(draft.generatedAt);
  codeIndexProfileSchema.parse(draft.profile);
  if (draft.scope !== ".") codeIndexSourcePathSchema.parse(draft.scope);
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

  const offsets = utf8OffsetTable(file.text);
  try {
    const loadedLanguage = await loadLanguage(mapping.grammar);
    const parser = new Parser();
    let tree = null;
    try {
      parser.setLanguage(loadedLanguage);
      tree = parser.parse(file.text);
      if (tree === null) throw new Error("Tree-sitter returned no syntax tree.");
      const diagnostics = tree.rootNode.hasError ? parserDiagnostics(tree.rootNode) : [];
      const facts = collectTreeFacts(tree.rootNode, file, mapping.grammar, offsets);
      if (diagnostics.length > 0) {
        return {
          coverage: { ...baseCoverage, status: "partial", diagnostics },
          ...facts
        };
      }
      return { coverage: { ...baseCoverage, status: "parsed" }, ...facts };
    } finally {
      tree?.delete();
      parser.delete();
    }
  } catch (error: unknown) {
    if (mapping.grammar === "yaml") return parseYamlCompatibilityFallback(file, baseCoverage);
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

type ValidatedStructuralCodeIndexInput = Omit<StructuralCodeIndexInput, "files"> & {
  readonly profile: "structural";
  readonly files: readonly FileInput[];
};

function validateInputMetadata(input: StructuralCodeIndexInput): ValidatedStructuralCodeIndexInput {
  if (typeof input !== "object" || input === null) throw new TypeError("input must be an object.");

  const snapshotId = codeIndexSnapshotIdSchema.parse(input.snapshotId);
  const mapRunId = runIdSchema.parse(input.mapRunId);
  const generatedAt = utcTimestampSchema.parse(input.generatedAt);
  codeIndexProfileSchema.parse("structural");
  const scope = input.scope === "." ? input.scope : codeIndexSourcePathSchema.parse(input.scope);
  const sourceFingerprint = codeIndexSha256Schema.parse(input.sourceFingerprint);

  if (!Array.isArray(input.files)) throw new TypeError("input.files must be an array.");
  if (input.files.length > MAX_FILES) throw new RangeError(`input.files exceeds maximum of ${MAX_FILES} files.`);

  const seenPaths = new Set<string>();
  const files = input.files.map((file, index) => {
    if (typeof file !== "object" || file === null || Array.isArray(file)) {
      throw new TypeError(`input.files[${index}] must be an object.`);
    }
    const parsedPath = codeIndexSourcePathSchema.parse(file.path);
    const parsedSha256 = codeIndexSha256Schema.parse(file.sha256);
    const text = file.text;
    if (text !== undefined && typeof text !== "string") {
      throw new TypeError(`input.files[${index}].text must be a string when provided.`);
    }
    if (seenPaths.has(parsedPath)) throw new Error(`input.files contains duplicate path: ${parsedPath}.`);
    seenPaths.add(parsedPath);
    return text === undefined ? { path: parsedPath, sha256: parsedSha256 } : { path: parsedPath, sha256: parsedSha256, text };
  });

  return { snapshotId, mapRunId, generatedAt, profile: "structural", scope, sourceFingerprint, files };
}

export async function buildStructuralCodeIndex(input: StructuralCodeIndexInput): Promise<CodeIndexSnapshotDraft> {
  const validatedInput = validateInputMetadata(input);

  const coverage: CodeIndexFileCoverage[] = [];
  const symbols: CodeIndexSymbol[] = [];
  const imports: CodeIndexImport[] = [];
  const exports: CodeIndexExport[] = [];

  const sortedFiles = [...validatedInput.files]
    .sort((left, right) => compareCodeIndexStrings(left.path, right.path));
  for (const file of sortedFiles) {
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
    const extracted = await extractFile(file, mapping);
    coverage.push(extracted.coverage);
    symbols.push(...extracted.symbols);
    imports.push(...extracted.imports);
    exports.push(...extracted.exports);
  }

  const draft: CodeIndexSnapshotDraft = {
    snapshotId: validatedInput.snapshotId,
    mapRunId: validatedInput.mapRunId,
    generatedAt: validatedInput.generatedAt,
    profile: validatedInput.profile,
    scope: validatedInput.scope,
    sourceFingerprint: validatedInput.sourceFingerprint,
    extractor: { name: "tree-sitter", version: TREE_SITTER_VERSION },
    coverage: [...coverage].sort((left, right) => compareCodeIndexStrings(left.path, right.path)),
    symbols: sortFacts(symbols),
    imports: sortFacts(imports),
    exports: sortFacts(exports)
  };
  return validateDraft(draft);
}
