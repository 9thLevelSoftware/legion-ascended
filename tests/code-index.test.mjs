import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildStructuralCodeIndex } from '../packages/cli/dist/workflow/code-index.js';

const SNAPSHOT_ID = 'idx_0123456789abcdef01234567';
const MAP_RUN_ID = 'run_semantic-map-v2';
const GENERATED_AT = '2026-08-25T00:00:00.000Z';
const SOURCE_SHA256 = 'a'.repeat(64);
const FILE_SHA256 = 'b'.repeat(64);

function input(files) {
  return {
    snapshotId: SNAPSHOT_ID,
    mapRunId: MAP_RUN_ID,
    generatedAt: GENERATED_AT,
    scope: '.',
    sourceFingerprint: SOURCE_SHA256,
    files
  };
}

function file(path, text, sha256 = FILE_SHA256) {
  return { path, sha256, text };
}

function factNames(facts) {
  return facts.map(({ path, name, kind }) => ({ path, name, kind }));
}

function expectedFactId(prefix, fact) {
  const kind = prefix === 'imp' ? 'import' : fact.kind;
  const name = fact.name ?? fact.specifier;
  const digest = createHash('sha256')
    .update(`${fact.path}\0${fact.range.startByte}\0${kind}\0${name}`)
    .digest('hex')
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

test('extracts TypeScript imports, symbols, direct exports, and exact source ranges', async () => {
  const text = 'import { helper } from "./dep.js";\nexport function greet(name: string) { return helper(name); }\n';
  const result = await buildStructuralCodeIndex(input([file('src/greet.ts', text)]));

  assert.deepEqual(result.coverage, [{ path: 'src/greet.ts', status: 'parsed', language: 'typescript' }]);
  assert.deepEqual(result.imports.map(({ specifier }) => specifier), ['./dep.js']);
  assert.deepEqual(factNames(result.symbols), [{ path: 'src/greet.ts', name: 'greet', kind: 'function' }]);
  assert.equal(result.symbols[0].exported, true);
  const declarationStart = text.indexOf('function');
  const declarationEnd = text.indexOf('}', text.indexOf('export function')) + 1;
  const declarationLineStart = text.lastIndexOf('\n', declarationStart - 1) + 1;
  assert.deepEqual(result.symbols[0].range, {
    startByte: declarationStart,
    endByte: declarationEnd,
    startLine: 1,
    startColumn: declarationStart - declarationLineStart,
    endLine: 1,
    endColumn: declarationEnd - declarationLineStart
  });
  assert.deepEqual(result.exports.map(({ name, kind }) => ({ name, kind })), [{ name: 'greet', kind: 'function' }]);
  assert.equal(result.extractor.name, 'tree-sitter');
  assert.equal(result.extractor.version, '0.26.13');
});

test('converts Tree-sitter UTF-16 offsets to UTF-8 byte ranges', async () => {
  const text = '// π\nimport { helper } from "./dep.js";\nexport function greet() { return helper(); }\n';
  const result = await buildStructuralCodeIndex(input([file('src/greet.ts', text)]));

  const importRange = result.imports[0].range;
  const symbolRange = result.symbols[0].range;
  const exportRange = result.exports[0].range;
  const rawImportStart = text.indexOf('import');
  const rawImportEnd = text.indexOf(';', rawImportStart) + 1;
  const rawFunctionStart = text.indexOf('function');
  const rawFunctionEnd = text.indexOf('}', rawFunctionStart) + 1;
  const rawExportStart = text.indexOf('export');
  const expectedImportStart = Buffer.byteLength(text.slice(0, rawImportStart), 'utf8');
  const expectedImportEnd = Buffer.byteLength(text.slice(0, rawImportEnd), 'utf8');
  const expectedFunctionStart = Buffer.byteLength(text.slice(0, rawFunctionStart), 'utf8');
  const expectedFunctionEnd = Buffer.byteLength(text.slice(0, rawFunctionEnd), 'utf8');
  const expectedExportStart = Buffer.byteLength(text.slice(0, rawExportStart), 'utf8');

  assert.deepEqual(importRange, {
    startByte: expectedImportStart,
    endByte: expectedImportEnd,
    startLine: 1,
    startColumn: 0,
    endLine: 1,
    endColumn: rawImportEnd - text.indexOf('import')
  });
  assert.deepEqual(symbolRange, {
    startByte: expectedFunctionStart,
    endByte: expectedFunctionEnd,
    startLine: 2,
    startColumn: rawFunctionStart - rawExportStart,
    endLine: 2,
    endColumn: rawFunctionEnd - rawExportStart
  });
  assert.deepEqual(exportRange, {
    startByte: expectedExportStart,
    endByte: expectedFunctionEnd,
    startLine: 2,
    startColumn: 0,
    endLine: 2,
    endColumn: rawFunctionEnd - rawExportStart
  });
  assert.notEqual(expectedImportStart, rawImportStart);
  assert.notEqual(expectedImportEnd, rawImportEnd);
  assert.notEqual(expectedFunctionStart, rawFunctionStart);
  assert.notEqual(expectedFunctionEnd, rawFunctionEnd);
  assert.notEqual(expectedExportStart, rawExportStart);
  assert.equal(result.imports[0].id, expectedFactId('imp', result.imports[0]));
  assert.equal(result.symbols[0].id, expectedFactId('sym', result.symbols[0]));
  assert.equal(result.exports[0].id, expectedFactId('exp', result.exports[0]));
});

test('preserves UTF-8 offsets after supplementary Unicode characters', async () => {
  const text = '// 😀\nexport function greet() {}\n';
  const result = await buildStructuralCodeIndex(input([file('src/emoji.ts', text)]));

  const symbol = result.symbols[0];
  const functionStart = text.indexOf('function');
  assert.equal(symbol.range.startByte, Buffer.byteLength(text.slice(0, functionStart), 'utf8'));
  assert.equal(symbol.range.endByte, Buffer.byteLength(text.slice(0, text.indexOf('}', functionStart) + 1), 'utf8'));
  assert.equal(symbol.id, expectedFactId('sym', symbol));
});

test('uses exact UTF-8 byte ranges and IDs for facts spanning a supplementary character', async () => {
  const text = 'export const value = "😀";\n';
  const result = await buildStructuralCodeIndex(input([file('src/supplementary-range.ts', text)]));

  const symbol = result.symbols[0];
  const rawStart = text.indexOf('value');
  const rawEnd = text.indexOf(';', rawStart);
  assert.deepEqual(symbol.range, {
    startByte: Buffer.byteLength(text.slice(0, rawStart), 'utf8'),
    endByte: Buffer.byteLength(text.slice(0, rawEnd), 'utf8'),
    startLine: 0,
    startColumn: rawStart,
    endLine: 0,
    endColumn: rawEnd
  });
  assert.equal(symbol.id, expectedFactId('sym', symbol));
  assert.equal(symbol.range.endByte - symbol.range.startByte, Buffer.byteLength(text.slice(rawStart, rawEnd), 'utf8'));
});

test('keeps lone surrogate source ranges at their replacement-byte width', async () => {
  const text = 'export const value = "\ud800";\n';
  const result = await buildStructuralCodeIndex(input([file('src/lone-surrogate.ts', text)]));

  const symbol = result.symbols[0];
  const rawStart = text.indexOf('value');
  const rawEnd = text.indexOf(';', rawStart);
  assert.equal(symbol.range.startByte, Buffer.byteLength(text.slice(0, rawStart), 'utf8'));
  assert.equal(symbol.range.endByte, Buffer.byteLength(text.slice(0, rawEnd), 'utf8'));
  assert.equal(symbol.id, expectedFactId('sym', symbol));
});

test('extracts Python function declarations', async () => {
  const text = 'def greet(name):\n    return name\n';
  const result = await buildStructuralCodeIndex(input([file('src/greet.py', text)]));

  assert.deepEqual(factNames(result.symbols), [{ path: 'src/greet.py', name: 'greet', kind: 'function' }]);
  assert.equal(result.symbols[0].exported, false);
  assert.equal(result.imports.length, 0);
  assert.equal(result.exports.length, 0);
});

test('extracts Python import and from-import module specifiers', async () => {
  const result = await buildStructuralCodeIndex(input([file('src/imports.py', 'import os\nfrom pathlib import Path\n')]));

  assert.deepEqual(result.imports.map(({ specifier }) => specifier), ['os', 'pathlib']);
});

test('deduplicates repeated Python import specifiers', async () => {
  const result = await buildStructuralCodeIndex(input([file('src/repeated-imports.py', 'import os, os\n')]));

  assert.deepEqual(result.imports.map(({ specifier }) => specifier), ['os']);
  assert.equal(new Set(result.imports.map(({ id }) => id)).size, result.imports.length);
});

test('class-nested Python functions are emitted as methods', async () => {
  const result = await buildStructuralCodeIndex(input([file('src/service.py', 'class Service:\n    def start(self):\n        return True\n')]));

  assert.deepEqual(factNames(result.symbols), [
    { path: 'src/service.py', name: 'Service', kind: 'class' },
    { path: 'src/service.py', name: 'start', kind: 'method' }
  ]);
});

test('marks named exports and their referenced symbols, including aliases', async () => {
  const text = 'function f() {}\nconst value = 1;\nexport { f, value as alias };\n';
  const result = await buildStructuralCodeIndex(input([file('src/named-exports.js', text)]));

  assert.deepEqual(
    result.exports.map(({ name, kind }) => ({ name, kind })).sort((left, right) => left.name.localeCompare(right.name)),
    [
      { name: 'alias', kind: 'variable' },
      { name: 'f', kind: 'function' }
    ]
  );
  assert.deepEqual(
    result.symbols.map(({ name, exported }) => ({ name, exported })).sort((left, right) => left.name.localeCompare(right.name)),
    [
      { name: 'f', exported: true },
      { name: 'value', exported: true }
    ]
  );
});

test('keeps same-named exports in distinct TypeScript namespaces', async () => {
  const text = [
    'namespace A { export const value = 1; }',
    'namespace B { export const value = 2; }',
    ''
  ].join('\n');
  const result = await buildStructuralCodeIndex(input([file('src/namespaced-exports.ts', text)]));

  assert.deepEqual(result.exports.map(({ name, kind }) => ({ name, kind })), [
    { name: 'value', kind: 'variable' },
    { name: 'value', kind: 'variable' }
  ]);
  assert.equal(new Set(result.exports.map(({ id }) => id)).size, 2);
  assert.notEqual(result.exports[0].range.startByte, result.exports[1].range.startByte);
  assert.deepEqual(result.symbols.map(({ name, exported }) => ({ name, exported })), [
    { name: 'value', exported: true },
    { name: 'value', exported: true }
  ]);
});

test('does not resolve local bindings for source-bearing named re-exports', async () => {
  const text = 'const foo = 1;\nexport { foo as bar } from "pkg";\n';
  const result = await buildStructuralCodeIndex(input([file('src/source-reexport.js', text)]));

  assert.deepEqual(result.symbols.map(({ name, exported }) => ({ name, exported })), [{ name: 'foo', exported: false }]);
  assert.deepEqual(result.imports, []);
  assert.deepEqual(result.exports.map(({ name, kind }) => ({ name, kind })), [{ name: 'bar', kind: 'export' }]);
});

test('emits default export facts with the default name for named declarations', async () => {
  const result = await buildStructuralCodeIndex(input([file('src/default-export.js', 'export default function named() {}\n')]));

  assert.deepEqual(factNames(result.symbols), [{ path: 'src/default-export.js', name: 'named', kind: 'function' }]);
  assert.equal(result.symbols[0].exported, true);
  assert.deepEqual(result.exports.map(({ name, kind }) => ({ name, kind })), [{ name: 'default', kind: 'function' }]);
});

test('emits default export facts for anonymous default functions and classes', async () => {
  const result = await buildStructuralCodeIndex(
    input([
      file('src/anonymous-function.js', 'export default function () {}\n'),
      file('src/anonymous-class.js', 'export default class {}\n')
    ])
  );

  assert.deepEqual(
    result.exports.map(({ path, name, kind }) => ({ path, name, kind })),
    [
      { path: 'src/anonymous-class.js', name: 'default', kind: 'class' },
      { path: 'src/anonymous-function.js', name: 'default', kind: 'function' }
    ]
  );
  assert.deepEqual(result.symbols, []);
});

test('emits one default export fact for expression and identifier default exports', async () => {
  const result = await buildStructuralCodeIndex(
    input([
      file('src/default-expression.js', 'export default 42;\n'),
      file('src/default-identifier.js', 'const value = 1;\nexport default value;\n')
    ])
  );

  assert.deepEqual(
    result.exports.map(({ path, name, kind }) => ({ path, name, kind })),
    [
      { path: 'src/default-expression.js', name: 'default', kind: 'export' },
      { path: 'src/default-identifier.js', name: 'default', kind: 'export' }
    ]
  );
  assert.equal(result.exports.filter(({ name }) => name === 'default').length, 2);
  assert.deepEqual(
    result.symbols.filter(({ path }) => path === 'src/default-identifier.js').map(({ name, kind, exported }) => ({ name, kind, exported })),
    [{ name: 'value', kind: 'variable', exported: true }]
  );
});

test('resolves named exports by lexical scope and nearest preceding binding', async () => {
  const text = [
    'function f() {}',
    'function outer() {',
    '  {',
    '    const f = 1;',
    '  }',
    '}',
    'export { f as alias };',
    ''
  ].join('\n');
  const result = await buildStructuralCodeIndex(input([file('src/shadowed-exports.js', text)]));

  assert.deepEqual(
    result.symbols.filter(({ name }) => name === 'f').map(({ kind, exported }) => ({ kind, exported })),
    [
      { kind: 'function', exported: true },
      { kind: 'variable', exported: false }
    ]
  );
  assert.deepEqual(result.exports.map(({ name, kind }) => ({ name, kind })), [{ name: 'alias', kind: 'function' }]);
});

test('resolves named exports to a same-scope declaration after the export', async () => {
  const result = await buildStructuralCodeIndex(input([file('src/export-before-declaration.js', 'export { f };\nconst f = 1;\n')]));

  assert.deepEqual(result.symbols.map(({ name, kind, exported }) => ({ name, kind, exported })), [
    { name: 'f', kind: 'variable', exported: true }
  ]);
  assert.deepEqual(result.exports.map(({ name, kind }) => ({ name, kind })), [{ name: 'f', kind: 'variable' }]);
});

test('resolves var named exports to the nearest function or program scope across blocks', async () => {
  const text = ['{', '  var f = 1;', '}', 'export { f as alias };', ''].join('\n');
  const result = await buildStructuralCodeIndex(input([file('src/var-export.js', text)]));

  assert.deepEqual(result.symbols.map(({ name, kind, exported }) => ({ name, kind, exported })), [
    { name: 'f', kind: 'variable', exported: true }
  ]);
  assert.deepEqual(result.exports.map(({ name, kind }) => ({ name, kind })), [{ name: 'alias', kind: 'variable' }]);
});

test('keeps generator-function var bindings scoped to the generator function', async () => {
  const text = 'const holder = function* () { var f = 1; };\nexport { f };\n';
  const result = await buildStructuralCodeIndex(input([file('src/generator-var-export.js', text)]));

  assert.deepEqual(result.symbols.filter(({ name }) => name === 'f').map(({ name, kind, exported }) => ({ name, kind, exported })), [
    { name: 'f', kind: 'variable', exported: false }
  ]);
  assert.deepEqual(result.exports.map(({ name, kind }) => ({ name, kind })), [{ name: 'f', kind: 'export' }]);
});

test('keeps static-block var bindings out of the module export scope', async () => {
  const text = 'class C { static { var f = 1; } }\nexport { f };\n';
  const result = await buildStructuralCodeIndex(input([file('src/static-block-var-export.js', text)]));

  assert.deepEqual(result.symbols.filter(({ name }) => name === 'f').map(({ name, kind, exported }) => ({ name, kind, exported })), [
    { name: 'f', kind: 'variable', exported: false }
  ]);
  assert.deepEqual(result.exports.map(({ name, kind }) => ({ name, kind })), [{ name: 'f', kind: 'export' }]);
});

test('emits one symbol and direct export for each object-destructured binding', async () => {
  const result = await buildStructuralCodeIndex(input([file('src/destructured-direct-export.js', 'export const { a, b } = source;\n')]));

  assert.deepEqual(result.symbols.map(({ name, kind, exported }) => ({ name, kind, exported })), [
    { name: 'a', kind: 'variable', exported: true },
    { name: 'b', kind: 'variable', exported: true }
  ]);
  assert.deepEqual(
    result.exports.map(({ name, kind }) => ({ name, kind })).sort((left, right) => left.name.localeCompare(right.name)),
    [
      { name: 'a', kind: 'variable' },
      { name: 'b', kind: 'variable' }
    ]
  );
});

test('resolves local destructured bindings in later named exports', async () => {
  const result = await buildStructuralCodeIndex(input([file('src/destructured-named-export.js', 'const { a } = source;\nexport { a };\n')]));

  assert.deepEqual(result.symbols.map(({ name, kind, exported }) => ({ name, kind, exported })), [
    { name: 'a', kind: 'variable', exported: true }
  ]);
  assert.deepEqual(result.exports.map(({ name, kind }) => ({ name, kind })), [{ name: 'a', kind: 'variable' }]);
});

test('indexes array rest and assignment-pattern bindings', async () => {
  const text = 'const [first, second = fallback, ...rest] = source;\nexport { first, second, rest };\n';
  const result = await buildStructuralCodeIndex(input([file('src/array-destructured-export.js', text)]));

  assert.deepEqual(result.symbols.map(({ name, kind, exported }) => ({ name, kind, exported })), [
    { name: 'first', kind: 'variable', exported: true },
    { name: 'second', kind: 'variable', exported: true },
    { name: 'rest', kind: 'variable', exported: true }
  ]);
  assert.deepEqual(
    result.exports.map(({ name, kind }) => ({ name, kind })).sort((left, right) => left.name.localeCompare(right.name)),
    [
      { name: 'first', kind: 'variable' },
      { name: 'rest', kind: 'variable' },
      { name: 'second', kind: 'variable' }
    ]
  );
});

test('emits namespace exports without fabricating an import fact', async () => {
  const result = await buildStructuralCodeIndex(input([file('src/namespace-export.js', 'export * as ns from "pkg";\n')]));

  assert.deepEqual(result.imports, []);
  assert.deepEqual(result.exports.map(({ name, kind }) => ({ name, kind })), [{ name: 'ns', kind: 'export' }]);
});

test('emits Python assignment symbols only for identifier targets', async () => {
  const result = await buildStructuralCodeIndex(input([file('src/assignment-targets.py', 'x = 1\nobj.field = 2\n')]));

  assert.deepEqual(result.symbols.map(({ name, kind }) => ({ name, kind })), [{ name: 'x', kind: 'variable' }]);
});

test('sanitizes malformed YAML diagnostics without echoing source text', async () => {
  const secret = 'SECRET_TOKEN_123';
  const result = await buildStructuralCodeIndex(input([file('config/secret.yaml', `${secret}: [\n`)]));
  const coverage = result.coverage.find(({ path }) => path === 'config/secret.yaml');
  const diagnostic = coverage.diagnostics?.[0];

  assert.equal(coverage.status, 'parser-error');
  assert.ok(diagnostic);
  assert.equal(diagnostic.includes(secret), false);
  assert.ok(diagnostic.length <= 512);
  assert.match(diagnostic, /^yaml parser error at line \d+: document rejected$/);
});

test('parses valid multi-document YAML without fabricating declaration facts', async () => {
  const text = ['---', 'name: legion', '---', '- enabled', '- true', '---', 'scalar', ''].join('\n');
  const result = await buildStructuralCodeIndex(input([file('config/multi-document.yaml', text)]));

  assert.deepEqual(result.coverage, [{ path: 'config/multi-document.yaml', status: 'parsed', language: 'yaml' }]);
  assert.deepEqual(result.symbols, []);
  assert.deepEqual(result.imports, []);
  assert.deepEqual(result.exports, []);
});

test('reports JSON and YAML as parsed coverage without fabricated declaration facts', async () => {
  const result = await buildStructuralCodeIndex(
    input([
      file('config/app.json', '{"name":"legion"}\n'),
      file('config/app.yaml', 'name: legion\n'),
      file('config/other.yml', 'enabled: true\n'),
      file('config/scalar.yaml', 'totally arbitrary\n'),
      file('config/not-yaml.yaml', 'totally arbitrary: [\n')
    ])
  );

  const coverageByPath = new Map(result.coverage.map((coverage) => [coverage.path, coverage]));
  assert.deepEqual(coverageByPath.get('config/app.json'), { path: 'config/app.json', status: 'parsed', language: 'json' });
  assert.deepEqual(coverageByPath.get('config/app.yaml'), { path: 'config/app.yaml', status: 'parsed', language: 'yaml' });
  assert.deepEqual(coverageByPath.get('config/other.yml'), { path: 'config/other.yml', status: 'parsed', language: 'yaml' });
  assert.deepEqual(coverageByPath.get('config/scalar.yaml'), { path: 'config/scalar.yaml', status: 'parsed', language: 'yaml' });
  const invalidYaml = coverageByPath.get('config/not-yaml.yaml');
  assert.equal(invalidYaml.status, 'parser-error');
  assert.ok(invalidYaml.diagnostics?.length > 0);
  assert.ok(invalidYaml.diagnostics?.every((diagnostic) => diagnostic.length <= 512));
  assert.deepEqual(result.symbols, []);
  assert.deepEqual(result.imports, []);
  assert.deepEqual(result.exports, []);
});

test('marks Markdown as metadata-only and does not claim Markdown AST support', async () => {
  const result = await buildStructuralCodeIndex(input([file('README.md', '# Project\n\n## Usage\n')]));

  assert.deepEqual(result.coverage, [{ path: 'README.md', status: 'metadata-only' }]);
  assert.deepEqual(result.symbols, []);
  assert.deepEqual(result.imports, []);
  assert.deepEqual(result.exports, []);
});

test('reports malformed TypeScript as parser-error without aborting other files', async () => {
  const result = await buildStructuralCodeIndex(
    input([file('broken.ts', 'export function broken( {\n'), file('ok.ts', 'export const answer = 42;\n')])
  );

  const broken = result.coverage.find(({ path }) => path === 'broken.ts');
  assert.equal(broken.status, 'parser-error');
  assert.ok(broken.diagnostics?.length > 0);
  assert.match(broken.diagnostics[0], /parser error|syntax|error/i);
  assert.equal(result.coverage.find(({ path }) => path === 'ok.ts').status, 'parsed');
  assert.ok(result.symbols.some(({ path, name }) => path === 'ok.ts' && name === 'answer'));
});

test('reports unsupported, opaque, and size-limited coverage states', async () => {
  const result = await buildStructuralCodeIndex(
    input([
      { path: 'notes.txt', sha256: FILE_SHA256, text: 'plain text' },
      { path: 'missing.ts', sha256: FILE_SHA256 },
      { path: 'large.ts', sha256: FILE_SHA256, text: 'x'.repeat(2 * 1024 * 1024) }
    ])
  );

  assert.deepEqual(result.coverage, [
    { path: 'large.ts', status: 'size-limited', language: 'typescript' },
    { path: 'missing.ts', status: 'opaque', language: 'typescript' },
    { path: 'notes.txt', status: 'unsupported' }
  ]);
});

test('rejects non-string file.text before extension dispatch with a uniform TypeError', async () => {
  for (const path of ['src/invalid.ts', 'notes.txt', 'README.md', 'data.unknown']) {
    await assert.rejects(
      () => buildStructuralCodeIndex(input([{ path, sha256: FILE_SHA256, text: 42 }])),
      { name: 'TypeError', message: 'input.files[0].text must be a string when provided.' }
    );
  }

  await assert.rejects(
    () => buildStructuralCodeIndex({ ...input([]), files: null }),
    { name: 'TypeError', message: 'input.files must be an array.' }
  );
});

test('validates snapshot metadata before reading file text for parser dispatch', async () => {
  let textRead = false;
  const files = [{
    path: 'src/valid.ts',
    sha256: FILE_SHA256,
    get text() {
      textRead = true;
      return 'export const value = 1;\n';
    }
  }];

  await assert.rejects(
    () => buildStructuralCodeIndex({ ...input(files), snapshotId: 'invalid-snapshot-id' }),
    /Invalid code index snapshot ID/
  );
  assert.equal(textRead, false);
});

test('sorts facts and coverage deterministically and is repeat-run stable', async () => {
  const files = [
    file('z.ts', 'export const zed = 1;\n'),
    file('a.ts', 'import value from "./value.js";\nexport class Alpha {}\n')
  ];
  const first = await buildStructuralCodeIndex(input(files));
  const second = await buildStructuralCodeIndex(input([...files].reverse()));

  assert.deepEqual(second, first);
  assert.deepEqual(first.coverage.map(({ path }) => path), ['a.ts', 'z.ts']);
  for (const facts of [first.symbols, first.imports, first.exports]) {
    assert.deepEqual(facts, [...facts].sort((left, right) => left.path.localeCompare(right.path) || left.range.startByte - right.range.startByte || left.id.localeCompare(right.id)));
  }
});

test('rejects input file lists above the extraction bound', async () => {
  const files = Array.from({ length: 100_001 }, (_, index) => file(`file-${index}.txt`, 'plain text'));

  await assert.rejects(
    () => buildStructuralCodeIndex(input(files)),
    { name: 'RangeError', message: 'input.files exceeds maximum of 100000 files.' }
  );
});

test('rejects duplicate repository-relative input paths before extraction', async () => {
  await assert.rejects(
    () => buildStructuralCodeIndex(input([file('src/repeated.ts', 'const first = 1;'), file('src/repeated.ts', 'const second = 2;')])),
    { name: 'Error', message: 'input.files contains duplicate path: src/repeated.ts.' }
  );
});

test('validates SHA-256 metadata even for unsupported files', async () => {
  await assert.rejects(
    () => buildStructuralCodeIndex(input([{ path: 'notes.txt', sha256: 'not-a-sha256', text: 'plain text' }])),
    (error) => {
      assert.match(String(error), /Invalid SHA-256 digest/);
      return true;
    }
  );
});

test('sorts paths with locale collation', async () => {
  const result = await buildStructuralCodeIndex(
    input([
      file('a.ts', 'export const lower = 1;\n'),
      file('B.ts', 'export const upper = 2;\n')
    ])
  );

  assert.deepEqual(result.coverage.map(({ path }) => path), ['a.ts', 'B.ts']);
  assert.deepEqual(result.symbols.map(({ path }) => path), ['a.ts', 'B.ts']);
});
