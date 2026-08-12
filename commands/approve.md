---
name: legion:approve
description: Record a human's decision about the change's delta specs, oracles, verification surfaces or protected acceptance paths
argument-hint: "spec [--requirement <id>] | oracle [--oracle <id>] | surface [--path <file>] | protected-paths [--oracle <id>] --approver <id> [--dry-run]"
allowed-tools: [Bash, Read]
---

<objective>
Record that a named human decided something about the current change, pinning the exact bytes they decided about. This writes governance artifacts and nothing else — it does not plan, build, review or ship.

Four subjects:

- **`spec`** — approve the change's delta specs. Runs between `legion plan` and `legion build`. `legion ship` reads what it writes: the `approved_delta_spec` risk gate is satisfied only when every delta spec in the change carries a granted approval whose pinned hash still matches the file on disk.
- **`oracle`** — approve the oracles the change's work will be judged against. Runs in the same window, beside `spec`. At R3 the `approved_spec_and_oracle` gate asks whether the spec and the oracle were approved **before** gated execution proceeded, and compares the last of those decisions against the instant the first task run started.
- **`protected-paths`** — permit this change's work to modify an acceptance test its own oracle protects. An executable acceptance criterion can name the tests its work must not weaken; `legion build` hashes them immediately before and after every run and records what moved. At R3 `protected_acceptance_tests` refuses a run that changed one unless a named human decided it could **before that run started**. That ordering is the whole meaning of "cannot be weakened by the implementer": only the approval plane blesses it, and only in advance.
- **`surface`** — re-affirm a verification surface whose pinned file has been edited. A surface declares what a verification command reaches and pins the files that make that true: the compose file standing the real service up, the schema it is checked against. `legion ship` re-hashes them, so editing one stops the declaration being believed and `integration_or_real_interface_checks` reports unsatisfied. That is the gate working. This is the way back, and it is a decision rather than a rewrite: nothing re-mints a pin silently, because a silent re-mint would launder an out-of-band edit into a declaration.
</objective>

<authority>
You are not the approver. The human named by `--approver` is.

Never invent an approver id, never pick the project's only decision owner because it is the only one, and never read one out of git config or the environment. The CLI refuses all three, and the reason it refuses them is the whole point of the artifact: an approval recorded against a defaulted identity is not a human approval, and a gate that reads one is a gate that cannot fail.

If the user has not named an approver, ask. Do not guess, and do not offer the owner you can see in the manifest as a default. This is true of every subject: re-affirming a surface is a claim that a declaration still describes what somebody meant, which only that somebody can make.

There is also a limit worth being honest about. Approving a delta spec records that a named person said yes to a specific set of bytes at a specific moment. It does not establish that they read them. The pin makes the claim falsifiable afterwards — anyone can check which text was approved — but it does not make it true. Do not present this step as a formality.

Approving an oracle has its own honest limit, and it is a different one. An oracle states the criteria the work will be judged against, and it is approved before that work exists — so the person deciding is agreeing to a test they have not seen applied to code that has not been written. That is deliberate: an oracle agreed to afterwards proves nothing about what the work was aimed at. Say so, and give them the criteria to read rather than a count of them.
</authority>

<context>
Change state comes from the CLI, not from files read directly.
Run via Bash — `legion` is the npm binary, not a Cargo crate:

    legion status --json

If `legion` is not found, run `npx @9thlevelsoftware/legion` instead.
</context>

<process>
1. SHOW WHAT WOULD BE APPROVED

   ```
   legion approve spec --dry-run --approver <id> --json
   ```

   The dry run resolves the approver and reads the change, so a mistyped id fails here rather than after something has been written. Show, per entry in `approvals`:

   - `requirementId` and `deltaSpecPath` — what is being approved.
   - `pinned.sha256` — the bytes that would be recorded.
   - `action` — `grant` for a first decision, `regrant` when a document exists that the ship gate would not accept (`previousStatus` says what it was), `unchanged` when this approver's grant already satisfies the gate against these exact bytes and nothing would be written.

   Offer to display the delta spec itself. An approver who has not seen the text cannot approve it, and this is the only step in the workflow where that text is the subject.

   The dry run's `nextAction` is this command, not the next stage, whenever anything is still unapproved. Nothing has been decided yet, so a dry run never routes forward.

2. RECORD THE DECISION

   ```
   legion approve spec --approver <id> --json
   ```

   Add `--requirement <id>` only when the user asked to approve one requirement rather than the change's whole set. It is not repeatable: a second `--requirement` replaces the first.

3. REPORT WHAT IS STILL OPEN

   `unapproved` lists requirement ids in the change that are still without a granted approval — read from the approvals plane, not from what this invocation happened to select, so a requirement approved in an earlier run does not appear. Show it whenever it is non-empty and say plainly that the gate is not satisfied until it is empty — a partial approval looks like success and leaves the ship blocked on requirements the user never saw named.

   If `warnings` is present, read it out. `withdrawn_approval_superseded` means this grant overruled a recorded withdrawal, and `supersededDecisions` names the file that decision was preserved in. `approval_after_execution` means something different and worse: the change carries R3 work, a task run already exists, and `approved_spec_and_oracle` compares this decision's instant against that run's start. The decision is still recorded — it is a true governance fact — but the gate can no longer be satisfied for this change, and no command re-orders it. Say that plainly rather than reporting a successful approval.

4. ROUTE

   Show `nextAction.command` and `nextAction.reason`. Present it as a recommendation. Do not run it.

   At R3 this routes to `legion approve oracle`, not to `legion build`: the gate reads both halves and both have to be decided before the first task run.

## Approving the oracles

Do this in the same window as `legion approve spec` — after `legion plan`, before `legion build`. Order is the whole point of the gate it feeds, and it is not recoverable: once a task run exists, its start instant is fixed, nothing rewinds or deletes a run, and re-approving only writes a later decision. An oracle approved after the build can never satisfy `approved_spec_and_oracle`.

1. SHOW WHAT WOULD BE APPROVED

   ```
   legion approve oracle --dry-run --approver <id> --json
   ```

   Per entry in `approvals`, show `oracleId`, `taskIds` — which tasks are judged against it — and `pinned.sha256`.

   Read the oracle to the approver. It is a JSON document at `oraclePath` whose `expected.postconditions` and `execution` are the substance of the decision; a hash and an id are not something a person can agree to.

2. RECORD THE DECISION

   ```
   legion approve oracle --approver <id> --json
   ```

   Add `--oracle <id>` only when the user asked to approve one rather than the change's whole set. It is not repeatable.

3. REPORT WHAT IS STILL OPEN

   `unapproved` lists oracles the change's tasks are judged against that still carry no granted approval. `unreferencedOracles`, when present, lists oracle documents no task names — those are reported and never approved, because approving one would record a decision about criteria nothing is judged against.

4. ROUTE

   `nextAction` is `legion build` once nothing is unapproved and nothing has run. If `warnings` carries `approval_after_execution`, say plainly that the decision was recorded but is dated after the work it claims to gate, and that no command re-orders it.

## Permitting a change to a protected acceptance test

Do this in the same window as `legion approve spec` and `legion approve oracle` — after `legion plan`, before `legion build` — and only when the work genuinely has to modify a test its own oracle protects. Order is the whole meaning of this gate: the decision must predate the run it permits, nothing rewinds a run, and re-deciding only writes a later instant. A decision recorded after the build can never satisfy `protected_acceptance_tests`, and the route out then is to restore the test file and build again, not to approve.

1. SHOW WHAT WOULD BE DECIDED

   ```
   legion approve protected-paths --dry-run --approver <id> --json
   ```

   Per entry in `decisions`, show `oracleId` and `paths` — the test files that oracle says this change's work must not weaken.

   **Ask what the work is going to do to those files, and why the change cannot be made without it.** This is the decision, and it cannot be answered from a list of paths. A test that is being extended is not the same act as a test whose assertion is being deleted or whose expected value is being moved to match the code; the second is the implementer marking their own work, which is exactly what this gate exists to catch. If that is what is being proposed, say so and do not record the decision.

2. RECORD THE DECISION

   ```
   legion approve protected-paths --approver <id> --json
   ```

   Add `--oracle <id>` only when the user asked to decide one oracle rather than every oracle in the change that declares protected paths. It is not repeatable.

3. REPORT WHAT IS STILL OPEN

   `undecided` lists oracles declaring a protected acceptance path that carry no live decision. The gate reads every one of them when a run has changed a protected path.

4. ROUTE

   `nextAction` is `legion build` while nothing has run, because that is what the decision has to precede. If `warnings` carries `approval_after_execution`, say plainly that the decision was recorded but is dated after the work it claims to gate, and that restoring the file is the only repair that does not need a re-plan.

## Re-affirming a verification surface

Reach for this only when `legion ship` reports `integration_or_real_interface_checks` as `risk_gate_unsatisfied` with a message about bytes that have changed. It is not a step in the normal flow, and it has nothing to say about a gate that is unsatisfied for any other reason.

1. SHOW WHAT DRIFTED

   ```
   legion approve surface --dry-run --approver <id> --json
   ```

   `drifted` lists the pinned files whose bytes no longer match what was declared or last re-affirmed. Per entry in `reaffirmations`, show `path`, the `interfaces` that pin it, `declaredSha256` and `currentSha256`.

   **Show the user what actually changed in that file.** A diff is the whole substance of this decision: the question being asked is "does this file still make the integration check real", and it cannot be answered from two hashes. If the change replaced a live service with a stub, a fake or a recorded fixture, the honest answer is no — say so, and do not record the re-affirmation.

2. RECORD THE DECISION

   ```
   legion approve surface --approver <id> --json
   ```

   Add `--path <file>` only when the user asked to re-affirm one file rather than every drifted pin. It is not repeatable.

3. REPORT WHAT IS STILL OPEN

   `drifted` in the result names pins this run left alone. The gate stays unsatisfied until it is empty.

4. ROUTE

   `nextAction` is `legion ship`, because re-affirming changes no evidence — it changes whether the gate believes a declaration it already had.
</process>

<inspection>
- `legion approve spec --dry-run --json`, `legion approve oracle --dry-run --json`, `legion approve surface --dry-run --json` and `legion approve protected-paths --dry-run --json` are read-only and safe to run at any time.
- Re-running after a successful approval reports `unchanged` and rewrites nothing. It is not an error and does not need a flag.
- Re-granting over a withdrawn approval copies the withdrawal to its own file before the grant is written, so the negative decision, its reason and its author survive. Nothing here deletes a decision.
- A re-affirmation covers exactly one revision of the pinned file. Edit it again and the gate blocks again; there is no way to exempt a path permanently, which is deliberate.
- `legion approve surface` re-affirms only pins that have actually drifted. It never rewrites the requirement, the task graph or the oracles.
- Nothing here writes outside `.legion/project/changes/<id>/approvals/`.
</inspection>

<decision_matrix>
| Situation | Action |
|-----------|--------|
| `approver_required` | Ask the user who is approving. Do not supply an id yourself |
| `approver_unknown` | The id is not a recorded decision owner. Show the recorded owners from the diagnostic; adding one is a change to the project manifest, not something to work around |
| `approver_ambiguous` | Two owners match. Ask for the exact actor id |
| `approver_not_human` | The named owner is a tool, worker, system or runtime actor. It cannot answer a question about human approval; ask for a person |
| `requirement_not_in_change` | The requirement has no delta spec here. Show the ids the diagnostic lists and ask which was meant |
| `delta_artifact_mismatch` | A delta spec's bytes no longer match the hash its change bundle records. Nothing in Legion rewrites a delta spec, so the file was changed out of band; restore it. Do not re-approve the edited bytes |
| `unapproved` is non-empty | Say the gate is still unsatisfied and name the requirements left |
| `status` is `unchanged` | Say nothing was written and why — the same approver already granted these exact bytes, in a document the ship gate accepts |
| `withdrawal_not_superseded` | A recorded revocation or denial is dated at or after now, so no grant taken now can supersede it. Nothing was written. This is a clock problem on whatever wrote the withdrawal, not something to work around |
| `action` is `regrant` with `previousStatus` `revoked` or `denied` | Say whose decision is being overruled and where it was preserved. Do not present it as a routine rerun |
| A write failed partway | `approvals` (or `reaffirmations`) in the failure payload names what landed. Rerunning is safe: an already-decided subject reports `unchanged` |
| `oracle_not_in_change` | Either a task names an oracle that is not on disk, or `--oracle` names one no task references. Show the ids the diagnostic lists. A missing oracle file is a broken change, not something to approve around |
| `oracle_plane_unreadable` | An oracle document in this change will not parse, so the set of criteria cannot be established and none of it is approved. Correct or remove the named file |
| `no_referenced_oracle` | No task contract here references an oracle, so there are no criteria to approve. Read what `legion ship` actually said; this is not the repair |
| `approval_after_execution` warning | The decision was recorded and is real, but it is dated after the run it claims to gate. Say that `approved_spec_and_oracle` cannot pass for this change and that no command re-orders it — planning the remaining work as a new change is the only route that does |
| `unreferencedOracles` is non-empty | Oracle documents no task is judged against. Report them; do not offer to approve them |
| `no_declared_surface` | Nothing in this change declares a verification surface beyond unit, so there is no pin to re-affirm. The gate is unmet for a different reason; read what `legion ship` actually said |
| `path_not_pinned` | The named file is not pinned by any surface here. Show the pinned files from the diagnostic and ask which was meant |
| `unreadable_surface_pin` | The pinned file is gone. A re-affirmation records the digest of a file that is there, so there is nothing to record. Restore the file |
| `drifted` is non-empty after a write | Say the gate is still unsatisfied and name the files left |
| `no_declared_acceptance_paths` | No oracle here names a test the work must not weaken, so there is nothing to decide. `protected_acceptance_tests` reports that as unprovable rather than met; declaring the tests happens at `legion start --intake`, not here |
| `oracle_not_declaring_acceptance_paths` | The named oracle protects no test. Show the oracles the diagnostic lists and ask which was meant |
| `undecided` is non-empty after a write | Say the gate still reads those oracles and name them |
</decision_matrix>
