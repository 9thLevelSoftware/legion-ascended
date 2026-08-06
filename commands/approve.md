---
name: legion:approve
description: Record a human's decision about the change's delta specs
argument-hint: "spec [--requirement <id>] --approver <id> [--dry-run]"
allowed-tools: [Bash, Read]
---

<objective>
Record that a named human approved the delta specs of the current change, pinning the exact bytes they approved. This writes one governance artifact per requirement and nothing else — it does not plan, build, review or ship.

It runs between `legion plan` and `legion build`. `legion ship` reads what it writes: the `approved_delta_spec` risk gate is satisfied only when every delta spec in the change carries a granted approval whose pinned hash still matches the file on disk.
</objective>

<authority>
You are not the approver. The human named by `--approver` is.

Never invent an approver id, never pick the project's only decision owner because it is the only one, and never read one out of git config or the environment. The CLI refuses all three, and the reason it refuses them is the whole point of the artifact: an approval recorded against a defaulted identity is not a human approval, and a gate that reads one is a gate that cannot fail.

If the user has not named an approver, ask. Do not guess, and do not offer the owner you can see in the manifest as a default.

There is also a limit worth being honest about. Approving a delta spec records that a named person said yes to a specific set of bytes at a specific moment. It does not establish that they read them. The pin makes the claim falsifiable afterwards — anyone can check which text was approved — but it does not make it true. Do not present this step as a formality.
</authority>

<context>
Change state comes from the CLI, not from files read directly.

    legion status --json

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

   If `warnings` is present, read it out. It means this grant overruled a recorded withdrawal; `supersededDecisions` names the file that decision was preserved in.

4. ROUTE

   Show `nextAction.command` and `nextAction.reason`. Present it as a recommendation. Do not run it.
</process>

<inspection>
- `legion approve spec --dry-run --json` is read-only and safe to run at any time.
- Re-running after a successful approval reports `unchanged` and rewrites nothing. It is not an error and does not need a flag.
- Re-granting over a withdrawn approval copies the withdrawal to its own file before the grant is written, so the negative decision, its reason and its author survive. Nothing here deletes a decision.
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
| A write failed partway | `approvals` in the failure payload names what landed. Rerunning is safe: an already-approved requirement reports `unchanged` |
</decision_matrix>
