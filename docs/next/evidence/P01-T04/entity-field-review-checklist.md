# P01-T04 Entity Field Review Checklist

Task: P01-T04 — Define project, change, requirement, decision, and oracle schemas
Date: 2026-06-19

## Ownership Boundary

- [x] Project schema models repository and policy boundary only.
- [x] Project schema requires `id` to match `prj_{slug}`.
- [x] Project schema references constitution, spec root, change root, ADR root, risk policy, oracle policy, and decision owners.
- [x] Project schema does not model board rows, active claims, leases, runtime sessions, retries, or UI projections.
- [x] Change schema separates `currentTruth` from `proposedTruth`.
- [x] Change schema records current spec refs, base spec hash, base Git SHA, proposed delta refs, target spec hash, risk, acceptance, decision refs, and oracle refs.
- [x] Change schema does not model queue state, worker assignment, active runtime sessions, or mutable board projections.
- [x] Accepted change states require `acceptedAt` and `acceptedBy`.
- [x] Rejected and blocked change states require `reason`.
- [x] Risk override records require active `tier` to match `override.to`.
- [x] Risk override records require `override.from` and `override.to` to differ.

## Requirement Coverage

- [x] Requirement schema records priority, category, status, statement, trace refs, supersession, and acceptance language.
- [x] Requirement acceptance requires criteria and oracle refs.
- [x] Superseded requirements require `supersededBy`, preserving replacement traceability.
- [x] Trace references are syntactic artifact/entity references only and do not require repository I/O during parse.
- [x] Trace references bind each scoped entity `kind` to the matching ID prefix.

## Decision History

- [x] Decision schema records alternatives, rationale, status, approver, decided-at timestamp, affected artifacts, trace refs, and supersession references.
- [x] Superseded decisions require `supersededBy`, preserving history rather than rewriting the original decision.
- [x] Non-proposed decisions require approver and decision timestamp.
- [x] Accepted decisions require exactly one selected alternative.
- [x] Proposed decisions reject multiple selected alternatives.
- [x] Decision lifecycle audit requirements are represented in generated JSON Schema, not only Zod runtime refinements.

## Oracle Protection

- [x] Oracle schema records explicit owner, protected paths, source artifacts, execution mode, expected preconditions, expected postconditions, expected evidence, and requirement coverage.
- [x] Oracle coverage cannot be empty.
- [x] Protected oracle paths cannot be empty.
- [x] Oracle schema remains provider-neutral by modeling command/runtime-driver/manual-inspection modes without importing runtime implementation types.
- [x] Executable oracles reject manual-inspection execution.
- [x] Inspectable oracles require manual-inspection execution.

## Verification Hooks

- [x] Valid entity fixture corpus parses and serializes identically.
- [x] Invalid fixture corpus covers missing ownership/protection/version/status/coverage expectations.
- [x] Unknown mutable operational fields are rejected by strict schemas.
- [x] Generated JSON Schema artifacts are reproducible from TypeScript/Zod source.
