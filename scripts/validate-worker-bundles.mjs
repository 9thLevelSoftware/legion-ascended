#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Canonical v9 default worker roles (ADR-002).
// These nine roles are the durable dispatch surface for the v9 default runtime.
// A bundle that names any other role must be flagged.
// ---------------------------------------------------------------------------
export const V9_DEFAULT_WORKER_ROLES = Object.freeze([
  "explorer",
  "specifier",
  "oracle-author",
  "architect",
  "planner",
  "implementer",
  "task-reviewer",
  "integration-evaluator",
  "release-controller"
]);

// Mandatory workflow-common-* domain packs every bundle must reference.
// These four packs ship in the v9 default runtime path and are the floor of
// any v9 bundle's domain coverage.
// ---------------------------------------------------------------------------
export const REQUIRED_WORKFLOW_COMMON_PACKS = Object.freeze([
  "workflow-common-core",
  "workflow-common-github",
  "workflow-common-memory",
  "workflow-common-domains"
]);

// Forbidden prompt sections per ADR-002 + the worker bundle schema. These are
// the prose categories the v9 default runtime must never inject.
// ---------------------------------------------------------------------------
export const FORBIDDEN_PROMPT_SECTIONS = Object.freeze([
  "biography",
  "tone",
  "personality"
]);

export const DEFAULT_BUNDLE_INDEX_PATH = "bundles/index.json";
export const DEFAULT_BUNDLE_SCHEMA_PATH = "schemas/entities/worker-bundle.schema.json";
export const DEFAULT_BUNDLE_DIRECTORY = "bundles";
export const DEFAULT_SKILLS_DIRECTORY = "skills";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SHA256_PREFIX_PATTERN = /^sha256:[0-9a-f]{64}$/;

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

async function readJson(root, relativePath) {
  const absolute = path.join(root, relativePath);
  const raw = await readFile(absolute, "utf8");
  return JSON.parse(raw);
}

async function readText(root, relativePath) {
  const absolute = path.join(root, relativePath);
  return readFile(absolute, "utf8");
}

function sha256OfString(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) continue;
    frontmatter[keyMatch[1]] = keyMatch[2].trim();
  }
  return frontmatter;
}

// ---------------------------------------------------------------------------
// Check 1: Manifest schema validation.
// Each bundle entry must validate against the worker bundle JSON Schema.
// ---------------------------------------------------------------------------
async function validateBundleSchema(root, schemaPath) {
  const schema = await readJson(root, schemaPath);
  if (!schema || schema.type !== "object") {
    return {
      ok: false,
      violations: [
        {
          bundle: "(schema)",
          check: "schema-validation",
          message: `worker bundle schema at ${schemaPath} is not an object schema`
        }
      ]
    };
  }

  const indexPath = path.join(root, DEFAULT_BUNDLE_INDEX_PATH);
  const indexRaw = await readText(root, DEFAULT_BUNDLE_INDEX_PATH);
  const index = JSON.parse(indexRaw);
  if (!index || !Array.isArray(index.bundles)) {
    return {
      ok: false,
      violations: [
        {
          bundle: "(index)",
          check: "schema-validation",
          message: `${DEFAULT_BUNDLE_INDEX_PATH} must declare a top-level "bundles" array`
        }
      ]
    };
  }

  const violations = [];
  const requiredKeys = schema.required ?? [];
  const properties = schema.properties ?? {};
  const bundleIndex = indexPath; // marker for error messages

  index.bundles.forEach((bundle, bundleIndex0) => {
    const label = bundle && typeof bundle.id === "string" ? bundle.id : `#${bundleIndex0}`;
    for (const key of requiredKeys) {
      if (!bundle || !(key in bundle)) {
        violations.push({
          bundle: label,
          check: "schema-validation",
          path: key,
          message: `required field "${key}" is missing from bundle manifest`
        });
      }
    }
    if (!bundle || typeof bundle !== "object") {
      violations.push({
        bundle: label,
        check: "schema-validation",
        message: "bundle entry must be an object"
      });
      return;
    }
    for (const [key, definition] of Object.entries(properties)) {
      if (!(key in bundle)) continue;
      const value = bundle[key];
      const issues = checkSchemaShape(key, value, definition);
      for (const issue of issues) {
        violations.push({
          bundle: label,
          check: "schema-validation",
          path: issue.path,
          message: issue.message
        });
      }
    }
  });

  return { ok: violations.length === 0, violations };
}

function checkSchemaShape(key, value, definition) {
  const issues = [];
  const path = key;
  const type = definition.type;
  if (type === "string" && typeof value !== "string") {
    issues.push({ path, message: `${key} must be a string` });
    return issues;
  }
  if (type === "array" && !Array.isArray(value)) {
    issues.push({ path, message: `${key} must be an array` });
    return issues;
  }
  if (type === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) {
    issues.push({ path, message: `${key} must be an object` });
    return issues;
  }

  if (typeof definition.pattern === "string") {
    if (typeof value !== "string" || !new RegExp(definition.pattern).test(value)) {
      issues.push({
        path,
        message: `${key} must match pattern ${definition.pattern}`
      });
    }
  }

  if (type === "string" && typeof definition.minLength === "number" && value.length < definition.minLength) {
    issues.push({
      path,
      message: `${key} must be at least ${definition.minLength} characters`
    });
  }
  if (type === "string" && typeof definition.maxLength === "number" && value.length > definition.maxLength) {
    issues.push({
      path,
      message: `${key} must be at most ${definition.maxLength} characters`
    });
  }
  if (type === "array" && typeof definition.minItems === "number" && value.length < definition.minItems) {
    issues.push({
      path,
      message: `${key} must contain at least ${definition.minItems} item(s)`
    });
  }

  if (type === "array" && Array.isArray(definition.items)) {
    value.forEach((item, index) => {
      for (const sub of definition.items) {
        for (const issue of checkSchemaShape(`${key}[${index}]`, item, sub)) {
          issues.push(issue);
        }
      }
    });
  } else if (type === "array" && definition.items && typeof definition.items === "object") {
    value.forEach((item, index) => {
      for (const issue of checkSchemaShape(`${key}[${index}]`, item, definition.items)) {
        issues.push(issue);
      }
    });
  }

  if (type === "object" && definition.properties) {
    for (const [subKey, subDefinition] of Object.entries(definition.properties)) {
      if (!(subKey in value)) continue;
      for (const issue of checkSchemaShape(`${key}.${subKey}`, value[subKey], subDefinition)) {
        issues.push(issue);
      }
    }
    if (definition.additionalProperties === false) {
      for (const subKey of Object.keys(value)) {
        if (!(subKey in definition.properties)) {
          issues.push({
            path: `${key}.${subKey}`,
            message: `${key}.${subKey} is not an allowed property`
          });
        }
      }
    }
    if (Array.isArray(definition.required)) {
      for (const required of definition.required) {
        if (!(required in value)) {
          issues.push({
            path: `${key}.${required}`,
            message: `${key}.${required} is required`
          });
        }
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Check 2: Capability completeness.
// - bundle.id unique across the registry
// - bundle.role matches a known v9 default role
// - bundle.role matches the bundle.id (one role per bundle ID by convention)
// - bundle.capabilities non-empty AND unique
// - bundle.promptContentContract.forbiddenSections MUST include the canonical
//   forbidden prose categories (biography, tone, personality)
// - bundle.promptContentContract.requiredSections MUST include the canonical
//   required headings (role, domain, capabilities, prompt-content-contract)
// - bundle.promptContentContract.instructionsHash MUST equal the SHA-256 of
//   bundles/<promptFile> as written on disk (proves the v9 contract is honored
//   end-to-end, not just declared)
// ---------------------------------------------------------------------------
async function validateCapabilityCompleteness(root, options = {}) {
  const violations = [];
  const index = JSON.parse(await readText(root, DEFAULT_BUNDLE_INDEX_PATH));

  const seenIds = new Set();
  const declaredCapabilities = new Set();
  const seenRoles = new Set();

  for (const bundle of index.bundles) {
    const label = bundle?.id ?? "(missing-id)";

    if (typeof bundle.id !== "string" || !SHA256_HEX_PATTERN.test(bundle.id.replace(/[^a-z0-9._-]/g, "a")) && false) {
      // string pattern check is enforced by schema validation; duplicate detection is the new contribution
    }

    if (seenIds.has(bundle.id)) {
      violations.push({
        bundle: label,
        check: "capability-completeness",
        message: `duplicate bundle id "${bundle.id}" in registry`
      });
    }
    seenIds.add(bundle.id);

    if (!V9_DEFAULT_WORKER_ROLES.includes(bundle.role)) {
      violations.push({
        bundle: label,
        check: "capability-completeness",
        path: "role",
        message: `role "${bundle.role}" is not in the v9 default worker set (${V9_DEFAULT_WORKER_ROLES.join(", ")})`
      });
    }
    if (seenRoles.has(bundle.role)) {
      violations.push({
        bundle: label,
        check: "capability-completeness",
        path: "role",
        message: `role "${bundle.role}" is declared by multiple bundles; v9 default workers are 1:1 with roles`
      });
    }
    seenRoles.add(bundle.role);

    if (bundle.role !== bundle.id) {
      violations.push({
        bundle: label,
        check: "capability-completeness",
        path: "id",
        message: `bundle id "${bundle.id}" must equal role "${bundle.role}" in the v9 default runtime`
      });
    }

    if (!Array.isArray(bundle.capabilities) || bundle.capabilities.length === 0) {
      violations.push({
        bundle: label,
        check: "capability-completeness",
        path: "capabilities",
        message: "capabilities array must be non-empty"
      });
    } else {
      const uniq = new Set();
      for (const capability of bundle.capabilities) {
        if (uniq.has(capability)) {
          violations.push({
            bundle: label,
            check: "capability-completeness",
            path: "capabilities",
            message: `duplicate capability "${capability}"`
          });
        }
        uniq.add(capability);
        declaredCapabilities.add(capability);
      }
    }

    const contract = bundle.promptContentContract ?? {};
    const forbidden = new Set(contract.forbiddenSections ?? []);
    for (const required of FORBIDDEN_PROMPT_SECTIONS) {
      if (!forbidden.has(required)) {
        violations.push({
          bundle: label,
          check: "capability-completeness",
          path: "promptContentContract.forbiddenSections",
          message: `bundle must forbid the canonical section "${required}"`
        });
      }
    }
    const requiredHeadings = new Set(contract.requiredSections ?? []);
    for (const heading of ["role", "domain", "capabilities", "prompt-content-contract"]) {
      if (!requiredHeadings.has(heading)) {
        violations.push({
          bundle: label,
          check: "capability-completeness",
          path: "promptContentContract.requiredSections",
          message: `bundle must require the canonical section "${heading}"`
        });
      }
    }

    if (typeof contract.instructionsHash !== "string" || !SHA256_PREFIX_PATTERN.test(contract.instructionsHash)) {
      violations.push({
        bundle: label,
        check: "capability-completeness",
        path: "promptContentContract.instructionsHash",
        message: "instructionsHash must be a lowercase sha256: hex string"
      });
    } else if (typeof bundle.promptFile === "string") {
      const promptRelative = toPosixPath(path.join(DEFAULT_BUNDLE_DIRECTORY, bundle.promptFile));
      let promptContents;
      try {
        promptContents = await readText(root, promptRelative);
      } catch (error) {
        violations.push({
          bundle: label,
          check: "capability-completeness",
          path: "promptFile",
          message: `prompt file "${promptRelative}" not readable: ${error?.message ?? error}`
        });
        continue;
      }
      const expected = `sha256:${sha256OfString(promptContents)}`;
      if (expected !== contract.instructionsHash) {
        violations.push({
          bundle: label,
          check: "capability-completeness",
          path: "promptContentContract.instructionsHash",
          message: `instructionsHash mismatch: declared ${contract.instructionsHash}, computed ${expected} from ${promptRelative}`
        });
      }
      // The prompt file itself must not contain any forbidden-section heading.
      const lines = promptContents.split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const forbiddenSection of FORBIDDEN_PROMPT_SECTIONS) {
          const headingPattern = new RegExp(`^#{1,6}\\s+${forbiddenSection}\\b`, "i");
          if (headingPattern.test(line)) {
            violations.push({
              bundle: label,
              check: "capability-completeness",
              path: promptRelative,
              message: `prompt file renders forbidden heading "${forbiddenSection}" at line ${index + 1}`
            });
          }
        }
      });
    }
  }

  return { ok: violations.length === 0, violations, declaredCapabilities };
}

// ---------------------------------------------------------------------------
// Check 3: Domain-pack integrity.
// Every workflow-common-* pack referenced by a bundle must exist on disk with
// pack_version >= 1.0.0 and pack_status === "extracted". A bundle that omits
// the required workflow-common-core pack is incomplete because core is the
// always-load base.
// ---------------------------------------------------------------------------
async function validateDomainPackIntegrity(root) {
  const violations = [];
  const index = JSON.parse(await readText(root, DEFAULT_BUNDLE_INDEX_PATH));

  // The v9 default runtime mandates four workflow-common-* packs on disk even
  // when no individual bundle references them all. Each one carries shared
  // contracts (core, github, memory, domains) that any bundle may opt into.
  // Missing files break the v9 default runtime path silently because the
  // resolution layer can't honor a `domainPacks` reference at dispatch time.
  for (const mandatory of REQUIRED_WORKFLOW_COMMON_PACKS) {
    try {
      await readText(root, toPosixPath(path.join(DEFAULT_SKILLS_DIRECTORY, mandatory, "SKILL.md")));
    } catch (error) {
      violations.push({
        bundle: "(ecosystem)",
        check: "domain-pack-integrity",
        path: "domainPacks",
        message: `mandatory pack "${mandatory}" is missing from ${DEFAULT_SKILLS_DIRECTORY}/${mandatory}/SKILL.md`
      });
    }
  }

  const packFrontmatterCache = new Map();

  async function readPackFrontmatter(packId) {
    if (packFrontmatterCache.has(packId)) {
      return packFrontmatterCache.get(packId);
    }
    const relative = toPosixPath(path.join(DEFAULT_SKILLS_DIRECTORY, packId, "SKILL.md"));
    let contents;
    try {
      contents = await readText(root, relative);
    } catch (error) {
      const result = { ok: false, message: `pack file "${relative}" not readable: ${error?.message ?? error}` };
      packFrontmatterCache.set(packId, result);
      return result;
    }
    const frontmatter = parseFrontmatter(contents);
    if (!frontmatter) {
      const result = { ok: false, message: `pack file "${relative}" has no YAML frontmatter` };
      packFrontmatterCache.set(packId, result);
      return result;
    }
    if (frontmatter.pack_id !== packId) {
      const result = {
        ok: false,
        message: `pack file "${relative}" declares pack_id="${frontmatter.pack_id}" but path expects "${packId}"`
      };
      packFrontmatterCache.set(packId, result);
      return result;
    }
    const version = frontmatter.pack_version;
    const status = frontmatter.pack_status;
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      const result = { ok: false, message: `pack "${packId}" frontmatter pack_version is missing or malformed` };
      packFrontmatterCache.set(packId, result);
      return result;
    }
    const [major] = version.split(".").map((part) => Number.parseInt(part, 10));
    if (!Number.isInteger(major) || major < 1) {
      const result = { ok: false, message: `pack "${packId}" pack_version ${version} is below the v1.0.0 floor` };
      packFrontmatterCache.set(packId, result);
      return result;
    }
    if (status !== "extracted") {
      const result = { ok: false, message: `pack "${packId}" pack_status "${status}" must be "extracted"` };
      packFrontmatterCache.set(packId, result);
      return result;
    }
    const result = { ok: true, version, status, relative };
    packFrontmatterCache.set(packId, result);
    return result;
  }

  for (const bundle of index.bundles) {
    const label = bundle?.id ?? "(missing-id)";
    const packs = Array.isArray(bundle.domainPacks) ? bundle.domainPacks : [];
    if (packs.length === 0) {
      violations.push({
        bundle: label,
        check: "domain-pack-integrity",
        path: "domainPacks",
        message: "bundle must declare at least one domain pack"
      });
    }
    if (!packs.includes("workflow-common-core")) {
      violations.push({
        bundle: label,
        check: "domain-pack-integrity",
        path: "domainPacks",
        message: `bundle must reference the mandatory "workflow-common-core" pack`
      });
    }
    const seenPacks = new Set();
    for (const packId of packs) {
      if (seenPacks.has(packId)) {
        violations.push({
          bundle: label,
          check: "domain-pack-integrity",
          path: "domainPacks",
          message: `duplicate pack reference "${packId}"`
        });
      }
      seenPacks.add(packId);
      const result = await readPackFrontmatter(packId);
      if (!result.ok) {
        violations.push({
          bundle: label,
          check: "domain-pack-integrity",
          path: "domainPacks",
          message: result.message
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Top-level entry point.
// ---------------------------------------------------------------------------
export async function validateWorkerBundles(options = {}) {
  const root = options.root;
  if (!root) {
    throw new TypeError("validateWorkerBundles requires { root } in options");
  }
  const schemaPath = options.schemaPath ?? DEFAULT_BUNDLE_SCHEMA_PATH;

  const [schemaResult, capabilityResult, packResult] = await Promise.all([
    validateBundleSchema(root, schemaPath),
    validateCapabilityCompleteness(root),
    validateDomainPackIntegrity(root)
  ]);

  const violations = [
    ...schemaResult.violations,
    ...capabilityResult.violations,
    ...packResult.violations
  ];

  return {
    ok: violations.length === 0,
    violations,
    checks: {
      schemaValidation: schemaResult,
      capabilityCompleteness: capabilityResult,
      domainPackIntegrity: packResult
    }
  };
}

function formatViolations(violations) {
  if (violations.length === 0) return "(no violations)";
  return violations
    .map((v) => {
      const where = v.path ? `${v.bundle} :: ${v.path}` : v.bundle;
      return `  - [${v.check}] ${where}: ${v.message}`;
    })
    .join("\n");
}

export async function runValidateWorkerBundlesCli(options = {}) {
  const root = options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await validateWorkerBundles({ root });

  process.stdout.write("\n[validate-worker-bundles] schema validation\n");
  process.stdout.write(`  ${result.checks.schemaValidation.ok ? "pass" : "FAIL"} (${result.checks.schemaValidation.violations.length} violation(s))\n`);
  process.stdout.write("[validate-worker-bundles] capability completeness\n");
  process.stdout.write(`  ${result.checks.capabilityCompleteness.ok ? "pass" : "FAIL"} (${result.checks.capabilityCompleteness.violations.length} violation(s))\n`);
  process.stdout.write("[validate-worker-bundles] domain-pack integrity\n");
  process.stdout.write(`  ${result.checks.domainPackIntegrity.ok ? "pass" : "FAIL"} (${result.checks.domainPackIntegrity.violations.length} violation(s))\n`);

  if (!result.ok) {
    process.stdout.write(`\n[validate-worker-bundles] violations:\n${formatViolations(result.violations)}\n`);
    process.exitCode = 1;
    return result;
  }
  process.stdout.write("\n[validate-worker-bundles] all worker bundles pass\n");
  return result;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ENTRY_PATH = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (ENTRY_PATH && ENTRY_PATH === SCRIPT_PATH) {
  runValidateWorkerBundlesCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
