---
name: legion:release
description: Record how this change's release will be observed and taken back, before it is released
argument-hint: "plan --environment <local|test|staging|production> --rollback-strategy <revert|disable|restore|manual> --health-criterion <text>... --rollback-criterion <text>... [--covers <taskId>...] [--dry-run]"
allowed-tools: [Bash, Read]
---

<objective>
Record the current change's release observation plan. This writes a governance artifact and nothing else — it does not deploy, publish, run a canary probe, or observe anything.

One subject today: `plan`. The plan says which environment the release goes to, what it will be watched against, what would make it be taken back, how it would be taken back, and which of the change's tasks it observes.

`release_observation_plan` is the ADR-006 gate that reads it. A **plan** is checkable before the release, which is the whole reason that gate is answerable at ship time. It carries no ordering rule: a plan authored after the build is still a plan, because it constrains the release rather than the run.
</objective>

<authority>
You are not the person who decides what a good release looks like. The user is.

The health criteria and the rollback criteria are authored, never derived. Do not write them from the task graph, from the diff, or from what a similar change did. A criterion Legion or you composed is not something anybody chose to watch, and the gate would then be satisfied by the act of running a command — which is the rubber stamp this whole family of verbs refuses to be.

Ask for criteria somebody could check afterwards and disagree with now. "The service is healthy" is not one. "p99 quote latency stays under 400ms for 30 minutes after the cutover" is.

Three things in this repository carry the words "release observation", and it is worth being exact about which one is in play:

- `legion release plan` — this verb. A **plan**, on the control plane, at `.legion/project/changes/<id>/release.json`, checkable before the release.
- `legion attest release-observation` — an **audited waiver**, for a change that deploys nothing. `--verdict not_applicable` with a named human and a reason. `--verdict pass` is refused: the plan is the evidence route, and a second route that is a sentence would make the two operators indistinguishable.
- `legion dev board release-observation` — a **post-deployment report** from an out-of-band monitor, aggregated into the board's event log. It lives outside `.legion/project` and no ship gate reads it. It is not this.
</authority>

<context>
Change state comes from the CLI, not from files read directly.

    legion status --json

</context>

<process>
1. FIND OUT WHAT WOULD ACTUALLY BE WATCHED

   Ask the user what would tell them this release had gone wrong, and what they would do about it. Those two answers are the health criteria and the rollback plan. Write down what they say, in their words.

   Ask what has to be true of the environment, too: a plan for `local` and a plan for `production` observe different things and are different plans. There is no default and the CLI will not pick one.

   The gate reads that choice. Only `staging` and `production` satisfy `release_observation_plan` — nothing is released into `local` or `test`, so a plan naming one of those is recorded, warned about, and leaves the gate unsatisfied. A change that reaches no released environment at all is the waiver, not a `local` plan.

2. SHOW WHAT WOULD BE RECORDED

   ```
   legion release plan --dry-run --environment <env> --rollback-strategy <strategy> \
     --health-criterion "<text>" --rollback-criterion "<text>" --json
   ```

   `--health-criterion`, `--rollback-criterion` and `--covers` are repeatable. Show, from `release`:

   - `healthCriteria` and `rollbackPlan` — read them back to the user in full.
   - `covers` — which tasks the plan observes. Omitted, every task of the change.
   - `releaseIntent` — the task graph the coverage was drawn from.
   - `action` — `record` for a first plan, `re-record` when one exists that the gate reading it would not accept, `unchanged` when the plan on disk already satisfies that gate with these exact criteria.

3. RECORD THE PLAN

   ```
   legion release plan --environment <env> --rollback-strategy <strategy> \
     --health-criterion "<text>" --rollback-criterion "<text>" --json
   ```

   A change carries at most one release plan. Re-planning replaces rather than accumulates, which is deliberate: a superseded plan sitting beside the current one would let a gate answer from whichever record happened to be favourable.

   One state is refused rather than replaced: a `release.json` recording `failed`, `rollback_required`, `rolled_back` or `forward_fix_required`. Writing a fresh `requested` plan over one of those would report the gate satisfied about a release nobody repaired. That follow-up work is a new change.

4. READ THE WARNINGS OUT

   `release_plan_gate_unmet` is the gate's own verdict on the plan just recorded, quoted rather than paraphrased: the command exited 0 and `legion ship` will still block. Read it out in full. `release_plan_partial_coverage` means `--covers` left tasks out. `release_plan_gate_not_derived` means the change is below R3, so the plan is a true record that moves no gate — say that rather than reporting a gate was satisfied. `release_plan_status_replaced` means the plan being overwritten recorded a release already under way.

5. ROUTE

   Show `nextAction.command` and `nextAction.reason`. Present it as a recommendation. Do not run it.
</process>

<inspection>
- `legion release plan --dry-run --json` is read-only and safe to run at any time.
- Re-running after a successful plan reports `unchanged` and rewrites nothing. That answer is computed by calling the ship gate's own predicate, so "unchanged" means the gate reading it is satisfied and not merely that a file exists.
- The verb refuses a plan with no health criterion and one with no rollback criterion. Both refusals are the gate's own floor held at the writer; a plan that observes nothing would exit 0 here and leave the ship blocked forever.
- It refuses to overwrite a `release.json` it could not read. Writing over an unread record is the one way to silently replace a failed release with a fresh plan.
- It refuses to overwrite one that records a failed or taken-back release, for the same reason with the record in front of it. `legion ship` does not advertise this command for those states either; the two halves are one repair.
- Nothing here writes outside `.legion/project/changes/<id>/release.json`.
</inspection>

<decision_matrix>
| Situation | Action |
|-----------|--------|
| `environment_required` | Ask which environment this release goes to. Do not choose one |
| `unknown_environment` / `unknown_rollback_strategy` | Show the supported values from the usage error. They are the protocol's own enums |
| `health_criteria_required` | Ask what this release will be watched against. Do not compose the criteria yourself |
| `rollback_criteria_required` | Ask what would make them take the release back. A strategy with no trigger says how, not when |
| `rollback_strategy_required` | Ask how this release would be undone: `revert`, `disable`, `restore`, or `manual` |
| `task_not_in_change` | The named task is not in this change. Show the tasks the diagnostic lists |
| `change_has_no_tasks` | The change is not planned yet. `legion plan <phase>` first |
| `release_records_negative` | The change's release failed or was taken back. Nothing re-plans it green; the follow-up work is a new change. If the record is wrong, that is a hand edit and their decision, not yours |
| `release_plan_gate_unmet` warning | Read the gate's sentence out in full. The plan was recorded and ship is still blocked; say which of the two it is — a pre-release environment, or coverage |
| `release_plan_gate_not_derived` warning | The record is real and moves no gate; the gate is R3 work. Say so |
| `release_plan_partial_coverage` warning | Name the uncovered tasks. Whether that blocks the gate is `release_plan_gate_unmet`'s answer, not this one's |
| `release_plan_status_replaced` warning | Say what the previous document recorded and that it is being superseded |
| `status` is `unchanged` | Say nothing was written and why — the plan on disk already satisfies the gate with these criteria |
| The user wants to record that the change deploys nothing | That is the waiver, not a plan: `legion attest release-observation --verdict not_applicable --waiver-reason <text> --attested-by <id>`. Ask them for the reason; do not compose it |
</decision_matrix>
