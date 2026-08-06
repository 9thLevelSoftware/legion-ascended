---
name: legion:attest
description: Record a human's assertion that specific pinned files are this change's evidence for an ADR-006 question
argument-hint: "<kind> --attested-by <id> --verdict <pass|fail|unknown|not_applicable> --source <path>... [--covers <taskId>...] [--waiver-reason <text>] [--dry-run]"
allowed-tools: [Bash, Read]
---

<objective>
Record that a named human asserts specific hash-pinned files are the current change's evidence for one of the questions ADR-006 asks. This writes a governance artifact and nothing else — it does not run a check, plan, build, review or ship.

Seven kinds: `independent-baseline`, `security-evaluation`, `e2e-evaluation`, `architecture-review`, `rollback-evidence`, `forward-fix-evidence`, `release-observation`.

Five risk gates read them, and as of this release every kind is read by one. `independent_baseline` reads `independent-baseline`, `security_or_e2e_evaluator` reads `security-evaluation` or `e2e-evaluation`, `rollback_or_forward_fix_evidence` reads `rollback-evidence` or `forward-fix-evidence`, `architecture_or_security_review` reads `architecture-review`, and `release_observation_plan` reads `release-observation`. The CLI still warns when a kind has no reader; it is now a warning nothing in the current gate set can trigger, and it stays because a kind added upstream would trigger it again.

Two of those gates have a second producer that is not an attestation, and for both of them the attestation is the weaker route. `architecture_or_security_review` is satisfied by a review recorded with `legion review --domain architecture`. `release_observation_plan` is satisfied by a plan recorded with `legion release plan` — and for that gate `legion attest release-observation --verdict pass` is refused outright, because the plan is the evidence and a sentence beside it would make the two operators indistinguishable. The only attestation route into it is `--verdict not_applicable`, for a change that deploys nothing.
</objective>

<authority>
You are not the attester. The human named by `--attested-by` is.

Never invent an attester id, never pick the project's only decision owner because it is the only one, and never read one out of git config or the environment. The CLI refuses all three, and the reason it refuses them is the whole reason this artifact exists.

Be honest about what this verb is for, because it is easy to mistake for bookkeeping. The reports it cites — the threat model, the rollback-policy verdict, the A/B comparison — are keyed by phase or by release. Nothing in them has any concept of a change. So the link from a verdict to this change has to come from somewhere, and the only two candidates are an inference and a person. An inference is a link nobody took responsibility for and nobody can be shown to have been wrong about. This command is the other answer: a named person says these bytes are this change's evidence, the instant is recorded, and `legion ship` re-hashes the bytes so they cannot drift underneath the assertion.

What it cannot do is turn a phase-keyed artifact into a change-keyed one. Say so. Do not present an attestation as though the underlying check had been run against this change when it was not.
</authority>

<context>
Change state comes from the CLI, not from files read directly.

    legion status --json

</context>

<process>
1. FIND OUT WHAT IS ACTUALLY BEING CLAIMED

   Ask which file the assertion rests on and read it with the user. An attestation over a file nobody looked at is the thing this artifact exists to make falsifiable, not the thing it exists to produce.

2. SHOW WHAT WOULD BE RECORDED

   ```
   legion attest <kind> --dry-run --attested-by <id> --verdict <verdict> --source <path> --json
   ```

   `--source` is repeatable and every value is pinned. Show, from `attestation`:

   - `sources` — the paths and the digests that would be recorded.
   - `sourceShapes` — what the CLI recognised each file as, and whether it reads clean. `unrecognised` means the CLI cannot check the claim at all.
   - `covers` — which tasks the assertion speaks for. Omitted, every task of the change.
   - `action` — `record` for a first assertion, `re-record` when one exists that the gate reading it would not accept, `unchanged` when this attester's record already satisfies that gate against these exact bytes.

3. RECORD THE ASSERTION

   ```
   legion attest <kind> --attested-by <id> --verdict <verdict> --source <path> --json
   ```

   A change carries at most one attestation per kind. Re-attesting replaces rather than accumulates, so a `fail` genuinely displaces an earlier `pass` — which is the point, and is why `attestation_verdict_superseded` appears as a warning when it happens.

   A change can carry both kinds a gate reads, and that is not a duplicate. `security_or_e2e_evaluator` reads two kinds and `rollback_or_forward_fix_evidence` reads two; recording the second does not replace the first, and a recorded `fail` on one kind is not unmade by a `pass` or a waiver on the other. Do not offer deleting a record as a way to move a gate.

4. READ THE WARNINGS OUT

   `attestation_kind_has_no_reader` means the record was written and moves no gate. `attestation_partial_coverage` means `--covers` left tasks out and ship will report the gate unsatisfied. `attestation_after_execution` means something worse: a task run already exists, and `independent_baseline` compares this record's instant against that run's start, so the gate can no longer be satisfied on evidence for this change.

5. ROUTE

   Show `nextAction.command` and `nextAction.reason`. Present it as a recommendation. Do not run it.
</process>

<inspection>
- `legion attest <kind> --dry-run --json` is read-only and safe to run at any time.
- Re-running after a successful attestation reports `unchanged` and rewrites nothing.
- The verb refuses `--verdict pass` over a report whose own verdict is negative, and over a file whose shape it does not recognise. A verdict it cannot check is a rubber stamp. That refusal is not something to work around.
- Nothing here writes outside `.legion/project/changes/<id>/attestations/`.
</inspection>

<decision_matrix>
| Situation | Action |
|-----------|--------|
| `attester_required` | Ask the user who is attesting. Do not supply an id yourself |
| `approver_unknown` / `approver_ambiguous` / `approver_not_human` | The same identity rule as `legion approve`. Show the recorded owners; adding one is a change to the project manifest, not something to work around |
| `source_required` | An attestation with no source asserts a link to nothing. Ask which file the claim rests on |
| `source_unpinnable` | The path is absent, leaves the repository, or is not a repository-relative path. Fix the path; a pin minted any other way would be reported as unchecked forever |
| `source_contradicts_verdict` | The cited report is red by its own rule. Say so plainly and show the reason from the diagnostic. Re-running the check until it passes is the repair; attesting is not. A rollback-policy verdict records the filesystem tree it audited, so one taken in another checkout is refused here however green it is — including the committed `docs/next/evidence/P13-T03/rollback-policy.json`, which audited a temp directory on somebody else's machine. Produce one with `legion dev release rollback-verify` in this repository |
| `waiver_contradicted_by_source` | The user is waiving a check whose own report says it failed. Refuse to help work around it. Waiving a check that ran and failed is the one thing an audited waiver must not be able to do |
| `source_shape_not_admissible` | Nothing named is a report the CLI can read a verdict out of. Offer `--verdict unknown`, which records the citation without asserting a pass |
| `kind_has_no_evidence_shape` | No report shape in this repository can evidence a pass for this kind. Offer `--verdict unknown`, or an audited waiver if the check genuinely does not apply |
| `waiver_requires_reason` | `--verdict not_applicable` needs a reason a reviewer could disagree with. Ask for one; do not compose it yourself |
| `attestation_kind_has_no_reader` warning | The record is real and moves no gate. Say that, rather than reporting that a gate was satisfied |
| `attestation_after_execution` warning | The record is real and `independent_baseline` cannot pass on evidence for this change. Planning the remaining work as a new change, or an audited waiver, are the only routes |
| `attestation_partial_coverage` warning | Name the uncovered tasks and say the gate stays unsatisfied |
| `attestation_verdict_superseded` warning | Say whose verdict is being replaced and with what. Do not present it as a routine rerun |
| `status` is `unchanged` | Say nothing was written and why — the same attester's record already satisfies the gate against these exact bytes |
</decision_matrix>
