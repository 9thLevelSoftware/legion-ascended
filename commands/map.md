---
name: legion:map
description: Generate, refresh, check, or query the Legion codebase map and semantic index
argument-hint: "[--check] [--refresh] [--profile inventory|structural] [--scope <path>] [--query <text>] [--why <fact-id>]"
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion]
---

<objective>
Create and maintain Legion's canonical codebase documentation and retrieval index. Produce the architecture document this command's analysis is for, and let the CLI own the file dataset underneath it. `legion map --refresh` defaults to `--profile structural`: it preserves the v1 `codebase.md`, `index.jsonl`, `symbols.json`, `search.md` and `map.json` artifacts and adds a hash-pinned `semantic-index.json` plus `semantic-index.sqlite` under the reported run directory. `--profile inventory` writes only the v1 artifacts. The architecture analysis is written separately, because the two are different documents that have historically been confused for each other.
</objective>

<execution_context>
skills/workflow-common-core/SKILL.md
skills/codebase-mapper/SKILL.md
</execution_context>

<context>
The CLI owns the artifact set and reports where it wrote them.

    legion map --refresh --profile structural --json
    legion map --refresh --profile inventory --json
    legion map --check --profile structural --json
    legion map --query "<text>" --profile structural --json
    legion map --why sym_<fact-id> --json

If `legion` is not found, use `npx legion-ascended` instead.

`legion map --refresh --profile structural --json` returns `mapArtifactPath`,
`semanticIndexArtifactPath`, and `semanticSqliteArtifactPath`; the run directory
beside them holds the v1 `codebase.md`, `index.jsonl`, `symbols.json`, `search.md`
and `map.json`. An inventory refresh returns only the v1 paths.
</context>

<authority>
The CLI owns the derivable state. `legion map --check` and the bare command report
freshness — `fresh`, `stale`, `partial` or `absent` — and write nothing;
`--refresh` regenerates the artifacts. Refresh defaults to the structural profile;
the inventory profile is the v1-only compatibility path. A structural check validates
the newest structural snapshot, its SQLite materialization, and the bound v1 `map.json`
before serving status, while an inventory check validates the v1 map. `--query` reads
an existing index and `--why <fact-id>` reads one structural fact; neither read mode
writes a workflow run.

The structural `semantic-index.json` is the durable authority for parsed coverage
and facts; `semantic-index.sqlite` is a local FTS5 acceleration of that snapshot,
not a second source of truth. Before a structural check, query, or why read serves
those artifacts, discovery validates the bound v1 `map.json`: its scope, source
fingerprint, source-file count, and exact path set match the snapshot and run;
generatedAt timestamps match the run and snapshot; and its exact content hash
(`mapArtifactSha256`) matches the run. Structural query results carry the fact ID,
source path, source hash, extractor version, and exact range. What stays here is the
analysis: the architecture narrative, the dependency graph, the API surface, the
coverage map, and the ranked risk hotspots. The verb's v1 artifact is a file inventory,
so rendering either payload would replace an architecture document with a histogram.

**Write the analysis to its own file — never over the CLI's artifact set.** The
`codebase.md` is a generated file inventory. Inventory checks and fallback
queries read `map.json`; structural checks, queries, and why reads consume the
validated `semantic-index.json` and its hash-matched SQLite materialization only
after discovery validates the bound v1 `map.json`. Overwriting any of these with
the codebase-mapper's formats makes the stored map unreadable to the verb that
owns it; not writing anywhere leaves the analysis unpersisted.
The repository's `.planning` directory contains `CODEBASE.md`, the architecture
analysis; the run directory is the CLI's.
</authority>

<process>
1. PARSE ARGUMENTS
   - Read `$ARGUMENTS`.
   - Supported flags:
     - `--check`: inspect map freshness and artifact completeness only. Do not write files.
     - `--refresh`: force a rebuild even when the current map is fresh.
     - `--profile inventory|structural`: select the v1 inventory or structural index profile.
     - `--scope <path>`: limit analysis to a file or directory. Scope must exist and must stay inside the current project.
     - `--query <text>`: search the existing map dataset and report matching map chunks plus source files to read next.
     - `--why <fact-id>`: explain one structural fact from a fresh snapshot.
   - Invalid flag combinations:
     - `--check` with `--refresh`: print usage and exit.
     - `--query` with `--refresh`: print usage and exit; query uses an existing dataset only.
   - If no flags are present: summarize the current inventory dataset and offer refresh via AskUserQuestion. Refresh is explicit; it is never inferred from a read.

2. SOURCE CODE DETECTION
   - Follow codebase-mapper Section 1 Source Code Detection Heuristic.
   - Exclude Legion state/runtime folders: `.legion/`, `.claude/`, `.codex/`, `.cursor/`, `.windsurf/`, `.gemini/`, `.opencode/`, `.aider/`, `.kilo/`, `.kilocode/`, `.git/`, dependency/build output directories.
   - If no source code is detected:
     - In `--query`: continue to Query Mode; query reads an existing map dataset and does not require current source detection.
     - In `--check`: report `status: absent`, `reason: no source files detected`, and exit 0.
     - In refresh mode: display "No source code detected, so no codebase map was generated." and exit without writing files.

3. CHECK MODE
   - `legion map --check --profile <profile> --json` is the freshness answer. An
     inventory check reads the newest valid v1 map's `map.json`; a structural check
     validates the newest structural snapshot, its SQLite hash, and the bound v1
     `map.json` integrity before serving the structural status.
   - Report from its payload:
     - `status`, `scope`, `sourceFileCount`, `sourceFingerprint`, `generatedAt`
   - The CLI's four states, as it defines them:
     - `fresh`: a map exists for this scope, its fingerprint matches the current source, and it is within the 30-day limit.
     - `stale`: the fingerprint differs, or the map is older than 30 days.
     - `partial`: a map exists but covers a different scope than the one being checked — the comparison is not like for like.
     - `absent`: no map run has been generated.
   - Output status, reason, age, scope, fingerprint match, and the recommended action.
   - Do not write files in `--check`.

4. QUERY MODE
   - `legion map --query <text> --json` discovers and validates the newest structural
     snapshot and its bound v1 `map.json`, then queries the snapshot's local SQLite
     FTS5 index. Use `--profile structural` to require structural query behavior; if
     no structural snapshot exists and no profile was specified, the CLI falls back
     to the legacy v1 `map.json` lexical query. `--profile inventory` is valid only
     for inventory refreshes and freshness checks, not structural query mode.
   - Structural matches include the fact ID, fact kind/name or import specifier,
     source path, source hash, snapshot ID, extractor version, and exact byte/line
     range. Inventory matches retain the v1 `path`, `score`, `symbols`, and `summary`.
   - If it reports no map, display: "No map exists. Run `/legion:map --refresh` first." and exit.
   - Follow codebase-mapper Section 18 Semantic Search Protocol over the returned matches:
     - Normalize the query into keywords, path hints, symbol hints, and domain hints.
     - Rank and group the `matches` the verb returned, preserving the structural provenance fields when present.
     - Report the top 5 with why each matched, and name the source files to read next.
   - Never answer from the ranking or a structural fact alone. The index is provenance
     and retrieval context, not behavioral proof; open the cited source and verify its
     behavior before acting.

5. WHY MODE
   - `legion map --why <fact-id> --json` looks up a symbol, import, or export fact in
     the newest fresh structural snapshot. It does not accept `--scope`, query, check,
     refresh, or an inventory profile, and it does not read source text.
   - The response identifies the snapshot, fact, source hash, extractor version, and
     exact range. An unknown or stale fact blocks with a refresh action. Treat the
     result as provenance only, never as behavioral proof.

6. FULL MAP OR REFRESH MODE
   - `legion map --refresh --profile structural --json` creates the run directory,
     writes the unchanged v1 artifact set, and materializes `semantic-index.sqlite`
     followed by the hash-pinned `semantic-index.json`; do not create directories yourself.
   - `legion map --refresh --profile inventory --json` creates the same v1 artifact
     set without structural snapshot or SQLite fields.
   - Structural coverage reports one status per collected file. The statuses are:
     `parsed` (supported grammar parsed), `metadata-only` (files with the `.md` or
     `.mdx` Markdown extensions are collected without AST facts), `size-limited` (source exceeds the parser limit), `opaque`
     (source text was unavailable), `parser-error` (the grammar rejected the source),
     and `unsupported` (the extension has no structural grammar). Parser errors are
     retained in the snapshot and make the refresh report blocked; they are not silently
     treated as parsed.
   - Run the full codebase-mapper protocol:
     - Architecture narrative and module structure.
     - Functionality/feature inventory.
     - Module ownership and domain boundaries.
     - Dependency/import graph and high fan-in files.
     - Route/API surface.
     - Data/config/environment map.
     - Test and coverage map.
     - Risk hotspots and dependency risk.
     - Setup/runbook.
     - Pattern library and conventions.
     - Monorepo package map, if applicable.
   - Write the analysis to `CODEBASE.md` in the repository's `.planning` directory — the architecture
     narrative, dependency graph, API surface, coverage map and risk hotspots. It is a
     separate document from the CLI's generated `codebase.md`, and conflating the two is
     how the analysis gets silently replaced by a file histogram.
   - `--scope <path>` on refresh still writes the same profile-specific artifact set,
     but metadata must include `scope: <path>` and the report must say that the dataset
     is scoped, not full-project. Query and why read the stored scope and refuse a new
     scope on the read command.

7. COMPLETION REPORT
   - Show:
     - Map status: generated or refreshed.
     - Source files analyzed.
     - Languages/frameworks detected.
     - Required artifacts written, including semantic paths for structural refreshes.
     - Top risks or `_None detected_`.
     - Next suggested command:
       - `/legion:start` if no project exists.
       - `/legion:plan <N>` if a project exists and the map is ready.
       - `/legion:map --query "<topic>"` for targeted lookup.
</process>

<decision_matrix>
| Situation | Action |
|-----------|--------|
| Fresh complete dataset and no `--refresh` | Summarize the selected profile's freshness and ask whether to refresh or keep current |
| Stored map covers a different scope than the one checked | The CLI reports `partial`; say the comparison is not like for like and offer a scoped refresh |
| Fingerprint mismatch | Treat as `stale`; recommend `/legion:map --refresh` |
| Structural query or why requested without a valid structural dataset | Do not improvise search; tell user to run `/legion:map --refresh --profile structural` first |
| Scope path outside project | Block with an escalation; never analyze outside the workspace by accident |
</decision_matrix>

<completion_gate>
- `legion map --check --profile <profile>` reports a status other than `absent` for the requested profile.
- The architecture analysis was written to `CODEBASE.md` in the repository's `.planning` directory, not over the CLI's artifacts.
- The CLI's run directory still parses: `legion map --check --profile structural --json` succeeds after a structural run.
- A structural run has both `semantic-index.json` and `semantic-index.sqlite`, and the final report names every artifact written and any degraded sections.
</completion_gate>
