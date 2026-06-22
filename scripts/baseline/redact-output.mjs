#!/usr/bin/env node
// P13-T01 redact step. Mirrors scripts/baseline/redact-output.ps1 in pure
// Node so the eval pipeline runs on macOS without PowerShell. Masks the
// configured secret canary, OpenAI-style API keys, bearer tokens, and common
// credential assignments.
//
// P13-T02 hardening (2026-06-22):
//   - URL-embedded credentials (https://user:pass@host)
//   - JSON-style embedded secrets ("apiKey": "...")
//   - PEM-encoded private keys (BEGIN ... PRIVATE KEY ... END)
//   - JWT tokens (header.payload.signature triple)
//   - Multiline bearer tokens (header on one line, value on the next)
//   - Audit log: counts of matched patterns (no secret values ever logged)
//   - A `redactAndAudit()` helper used by the threat-model validator so
//     redaction and policy enforcement are the same code path.
//
// The held-out contract from security-sensitive.v1 still holds:
//   * "configured secret canaries are redacted in retained logs"
//   * "redaction does not hide command failures"
//
// Mask values always preserve the surrounding context (line, prefix,
// failure indicator) so transcripts remain inspectable for failure root
// cause while secrets stay sealed.
//
// Usage:
//   node scripts/baseline/redact-output.mjs --input raw.log --output redacted.log
//   node scripts/baseline/redact-output.mjs --input raw.log --output redacted.log --audit audit.json

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

// The JSON-credential pattern is reused in two passes (audit count + final
// replacement), so we hoist it to a top-level constant rather than nesting
// it inside REDACTION_PATTERNS.
const JSON_CREDENTIAL_RE = /"(?:api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|token|secret)"\s*:\s*"(?:[^"\\]|\\.)*"/gi;

// Each entry is { id, pattern, replacement }. The `id` is reported in the
// audit log so the threat-model validator can confirm which detectors
// fired without ever reporting the matched secret value. Order matters:
// PEM-key and JWT patterns must run before the generic credential-assignment
// catch-all so we don't lose precision.
export const REDACTION_PATTERNS = [
  // 1. Configured secret canaries (highest priority so the audit log can
  //    confirm at least one canary was redacted without leaking the value).
  {
    id: "secret_canary",
    pattern: /LEGION_SECRET_CANARY_[A-Z0-9_]+/g,
    replacement: "[REDACTED_SECRET_CANARY]"
  },
  // 2. PEM-encoded private keys (multiline). Mask the entire BEGIN/END
  //    block so we don't leak fragments via header-only matching.
  {
    id: "pem_private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PEM_PRIVATE_KEY]"
  },
  // 3. JWT tokens (three base64url segments separated by dots). The header
  //    and payload always start with `eyJ` (base64url of `{"`) so we can
  //    anchor the match precisely without false positives.
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[REDACTED_JWT]"
  },
  // 4. URL-embedded credentials (https://user:pass@host). Mask the userinfo
  //    portion but preserve the host so context (which endpoint was hit)
  //    remains inspectable. Uses a function replacement to avoid $-string
  //    pitfalls; $1 in the pattern is the scheme group.
  {
    id: "url_credentials",
    pattern: /([a-z][a-z0-9+.\-]*:\/\/)([^\s:@\/]+):([^\s@\/]+)@/gi,
    replacement: (_match, scheme) => `${scheme}[REDACTED_URL_CREDENTIALS]@`
  },
  // 5. Multiline bearer token continuation: a line ending in "Bearer"
  //    followed by a line starting with a long opaque value.
  {
    id: "bearer_continuation",
    pattern: /(Bearer)\s*\r?\n\s*([A-Za-z0-9._\-]{20,})/g,
    replacement: (_match, prefix) => `${prefix} [REDACTED_TOKEN]`
  },
  // 6. Single-line bearer tokens.
  {
    id: "bearer",
    pattern: /Bearer\s+[A-Za-z0-9._\-]+/g,
    replacement: "Bearer [REDACTED_TOKEN]"
  },
  // 7. OpenAI-style API keys (sk-...). Comes before the generic
  //    credential-assignment catch-all so we don't double-mask.
  {
    id: "openai_key",
    pattern: /sk-[A-Za-z0-9_-]{20,}/g,
    replacement: "[REDACTED_OPENAI_KEY]"
  },
  // 8. JSON-style embedded secrets: "<key>": "<value>". The replacement is
  //    applied separately because the pattern keeps the JSON key verbatim
  //    so downstream readers can still tell which credential was redacted.
  {
    id: "json_credential",
    pattern: JSON_CREDENTIAL_RE,
    replacement: null // sentinel; the apply pass uses a custom function
  },
  // 9. Generic credential assignment mask (case-insensitive key, [:=]
  //    separator, optional surrounding quotes, then non-whitespace value).
  //    Placed LAST so the more specific detectors above win. Uses a
  //    function replacement to keep the original key/separator visible so
  //    failure context (which env var was set, which config flag triggered)
  //    remains inspectable.
  {
    id: "credential_assignment",
    pattern: /(api[_-]?key|api[_-]?secret|token|password|passwd|pwd|secret)(\s*[:=]\s*)['"]?[^'"\s]+/gi,
    replacement: (_match, key, sep) => `${key}${sep}[REDACTED_SECRET]`
  }
];

export function redactText(input) {
  let output = input;
  // Apply each pattern in order. Each pass writes the count of matches into
  // the audit object so the threat-model validator can confirm coverage
  // without ever recording the matched secret value.
  const audit = Object.create(null);
  for (const entry of REDACTION_PATTERNS) {
    if (entry.id === "json_credential") {
      let count = 0;
      output = output.replace(JSON_CREDENTIAL_RE, (match) => {
        count += 1;
        // Preserve the JSON key (so readers know which credential was
        // redacted) but mask the value.
        return match.replace(/:\s*"(?:[^"\\]|\\.)*"/, ': "[REDACTED_JSON_SECRET]"');
      });
      if (count > 0) audit[entry.id] = count;
      continue;
    }
    let count = 0;
    output = output.replace(entry.pattern, (...args) => {
      count += 1;
      // Support both literal and function replacements so pattern authors
      // can capture groups without worrying about $-string escaping.
      if (typeof entry.replacement === "function") {
        return entry.replacement(...args);
      }
      return entry.replacement;
    });
    if (count > 0) audit[entry.id] = count;
  }
  return { text: output, audit };
}

export async function redactFile(inputPath, outputPath) {
  const raw = await readFile(inputPath, "utf8");
  const { text, audit } = redactText(raw);
  const parent = path.dirname(outputPath);
  if (parent) await mkdir(parent, { recursive: true });
  await writeFile(outputPath, text, "utf8");
  return audit;
}

export async function redactAndAudit(inputPath, outputPath, auditPath) {
  const audit = await redactFile(inputPath, outputPath);
  if (typeof auditPath === "string") {
    const parent = path.dirname(auditPath);
    if (parent) await mkdir(parent, { recursive: true });
    await writeFile(
      auditPath,
      `${JSON.stringify({ schema_version: 1, audit }, null, 2)}\n`,
      "utf8"
    );
  }
  return audit;
}

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.input !== "string" || typeof args.output !== "string") {
    throw new Error(
      "Usage: redact-output.mjs --input <path> --output <path> [--audit <path>]"
    );
  }
  const audit = await redactAndAudit(
    args.input,
    args.output,
    typeof args.audit === "string" ? args.audit : undefined
  );
  process.stdout.write(`${JSON.stringify({ ok: true, audit })}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath !== undefined && path.resolve(SCRIPT_PATH) === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
