#!/usr/bin/env node
// P13-T01 redact step. Mirrors scripts/baseline/redact-output.ps1 in pure
// Node so the eval pipeline runs on macOS without PowerShell. Masks the
// configured secret canary, OpenAI-style API keys, bearer tokens, and common
// credential assignments.
//
// Usage:
//   node scripts/baseline/redact-output.mjs --input raw.log --output redacted.log

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const REDACTION_PATTERNS = [
  { pattern: /LEGION_SECRET_CANARY_[A-Z0-9_]+/g, replacement: "[REDACTED_SECRET_CANARY]" },
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED_OPENAI_KEY]" },
  { pattern: /Bearer\s+[A-Za-z0-9._-]+/g, replacement: "Bearer [REDACTED_TOKEN]" },
  // Conservative credential assignment mask (case-insensitive key, [:=] separator,
  // optional surrounding quotes, then non-whitespace/non-quote value).
  {
    pattern: /(api[_-]?key|token|password)(\s*[:=]\s*)['"]?[^'"\s]+/gi,
    replacement: "$1$2[REDACTED_SECRET]"
  }
];

export function redactText(input) {
  let output = input;
  for (const entry of REDACTION_PATTERNS) {
    output = output.replace(entry.pattern, entry.replacement);
  }
  return output;
}

export async function redactFile(inputPath, outputPath) {
  const raw = await readFile(inputPath, "utf8");
  const out = redactText(raw);
  const parent = path.dirname(outputPath);
  if (parent) await mkdir(parent, { recursive: true });
  await writeFile(outputPath, out, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.input !== "string" || typeof args.output !== "string") {
    throw new Error("Usage: redact-output.mjs --input <path> --output <path>");
  }
  await redactFile(args.input, args.output);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
