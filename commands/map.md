---
name: legion:map
description: Generate, refresh, check, or query the Legion codebase map and semantic index
argument-hint: "[--check] [--refresh] [--scope <path>] [--query <text>]"
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion]
---

<objective>
Create and maintain Legion's canonical codebase documentation and retrieval index. Produce the architecture document this command's analysis is for, and let the CLI own the file dataset underneath it. `legion map --refresh` writes `codebase.md`, `index.jsonl`, `symbols.json`, `search.md` and `map.json` under the run directory it reports; the analysis is written separately, because the two are different documents that have historically been confused for each other.
</objective>

<execution_context>
skills/workflow-common-core/SKILL.md
skills/codebase-mapper/SKILL.md
</execution_context>

<context>
The CLI owns the artifact set and reports where it wrote them.

    legion map --json

`legion map --refresh --json` returns `mapArtifactPath`; the run directory beside
it holds `codebase.md`, `index.jsonl`, `symbols.json`, `search.md` and
`map.json`.
</context>

<authority>
The CLI owns the derivable state. `legion map --json` reports freshness —
`fresh`, `stale`, `partial` or `absent` — and writes nothing; `--refresh`
regenerates the artifacts; `--query` searches the stored map.

What stays here is the analysis: the architecture narrative, the dependency
graph, the API surface, the coverage map, and the ranked risk hotspots. The
verb's artifact is a file inventory, so rendering its payload would replace an
architecture document with a histogram.

**Write the analysis to its own file — never over the CLI's artifact set.** The
CLI's `codebase.md` is a generated file inventory and `map.json` is the document
`legion map --check` and `--query` read. Overwriting either with the
codebase-mapper's formats makes the stored map unreadable to the verb that owns
it; not writing anywhere leaves the analysis unpersisted. `CODEBASE.md` at the
repository root is the analysis; the run directory is the CLI's.
</authority>

<process>
1. PARSE ARGUMENTS
   - Read `$ARGUMENTS`.
   - Supported flags:
     - `--check`: inspect map freshness and artifact completeness only. Do not write files.
     - `--refresh`: force a rebuild even when the current map is fresh.
     - `--scope <path>`: limit analysis to a file or directory. Scope must exist and must stay inside the current project.
     - `--query <text>`: search the existing map dataset and report matching map chunks plus source files to read next.
   - Invalid flag combinations:
     - `--check` with `--refresh`: print usage and exit.
     - `--query` with `--refresh`: print usage and exit; query uses an existing dataset only.
   - If no flags are present: run a full map only when there is no fresh complete dataset; otherwise summarize the current dataset and offer refresh via AskUserQuestion.

2. SOURCE CODE DETECTION
   - Follow codebase-mapper Section 1 Source Code Detection Heuristic.
   - Exclude Legion state/runtime folders: `.legion/`, `.claude/`, `.codex/`, `.cursor/`, `.windsurf/`, `.gemini/`, `.opencode/`, `.aider/`, `.kilo/`, `.kilocode/`, `.legion/`, `.git/`, dependency/build output directories.
   - If no source code is detected:
     - In `--query`: continue to Query Mode; query reads an existing map dataset and does not require current source detection.
     - In `--check`: report `status: absent`, `reason: no source files detected`, and exit 0.
     - In default/full map mode: display "No source code detected, so no codebase map was generated." and exit without writing files.

3. CHECK MODE
   - Inspect these required artifacts:
   - `legion map --check --json` is the freshness answer. It reads the newest map
     run's `map.json`; the other four artifacts are outputs, not inputs to the check.
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
   - `legion map --query <text> --json` searches the stored map. It reads the newest
     `map.json` and ranks its `files` entries; `index.jsonl` and `symbols.json` are not
     consulted by the verb.
   - If missing, display: "No map index exists. Run `/legion:map` first." and exit.
   - Follow codebase-mapper Section 18 Semantic Search Protocol:
     - Normalize the query into keywords, path hints, symbol hints, and domain hints.
     - Search `index.jsonl` and `symbols.json` using Grep/Read.
     - Return the top 5 matching chunks with id, path, line range, kind, summary, and why it matched.
     - Include "Read next" source files and exact line ranges where available.
   - Never answer from the index alone when source-file evidence is required; instruct consumers to read the source paths before acting.

5. FULL MAP OR REFRESH MODE
   - `legion map --refresh --json` creates the run directory and writes the artifact set; do not create directories yourself.
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
   - `legion map --refresh --json` writes the CLI's five artifacts. Leave them alone.
   - Write the analysis to `CODEBASE.md` at the repository root — the architecture
     narrative, dependency graph, API surface, coverage map and risk hotspots. It is a
     separate document from the CLI's generated `codebase.md`, and conflating the two is
     how the analysis gets silently replaced by a file histogram.
   - `--scope <path>` still writes the same artifact set, but metadata must include `scope: <path>` and the report must say that the dataset is scoped, not full-project.

6. COMPLETION REPORT
   - Show:
     - Map status: generated or refreshed.
     - Source files analyzed.
     - Languages/frameworks detected.
     - Required artifacts written.
     - Top risks or `_None detected_`.
     - Next suggested command:
       - `/legion:start` if no project exists.
       - `/legion:plan <N>` if a project exists and the map is ready.
       - `/legion:map --query "<topic>"` for targeted lookup.
</process>

<decision_matrix>
| Situation | Action |
|-----------|--------|
| Fresh complete dataset and no `--refresh` | Summarize freshness and ask whether to refresh or keep current |
| Stored map covers a different scope than the one checked | The CLI reports `partial`; say the comparison is not like for like and offer a scoped refresh |
| Fingerprint mismatch | Treat as `stale`; recommend `/legion:map --refresh` |
| Query requested without dataset | Do not improvise search; tell user to run `/legion:map` first |
| Scope path outside project | Block with an escalation; never analyze outside the workspace by accident |
</decision_matrix>

<completion_gate>
- `legion map --json` reports a status other than `absent`.
- The architecture analysis was written to `CODEBASE.md`, not over the CLI's artifacts.
- The CLI's run directory still parses: `legion map --check --json` succeeds after the run.
- The final report names every artifact written and any degraded sections.
</completion_gate>
