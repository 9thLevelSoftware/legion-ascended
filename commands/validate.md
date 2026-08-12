---
name: legion:validate
description: Report the CLI's validation of committed project state
argument-hint: ""
allowed-tools: [Bash, Read, Edit, AskUserQuestion]
---

<objective>
Render the validation the CLI performs, and help the operator repair what it reports. The CLI checks the artifacts and decides what is wrong. Your job is to show that, and to drive the fix-and-recheck loop.
</objective>

<execution_context>
skills/workflow-common-core/SKILL.md
</execution_context>

<context>
Validation comes from the CLI, not from files read directly.
Run via Bash — `legion` is the npm binary, not a Cargo crate:

    legion validate --json
    legion doctor --json

If `legion` is not found, run `npx @9thlevelsoftware/legion` instead.

`legion doctor` is the superset: the same checks plus the shallow operational
paths. Neither writes anything.
</context>

<authority>
You are not the validator. You are the screen its output is displayed on, and
the hands that repair what it names.

Do not derive a verdict of your own, and do not decide a project is healthy
because the files you happened to read looked fine. A report assembled from a
model's reading of a repository is exactly as trustworthy as that reading, and
its errors are invisible: a check silently skipped looks identical to a check
that passed.

Severity is the CLI's to assign. Only blocking diagnostics fail; warnings are
reported and do not break the build. `status` is `valid_with_warnings` when
there are warnings and nothing blocking — a healthy project with something worth
fixing, not a failure.

`--fix` and `--ci` are gone. Both are recorded deliberate removals: every target
`--fix` had was a legacy planning file that retired with that directory, and `--ci`'s
substance was a three-valued exit code the CLI has no severity tier to populate.
`--json` carries the machine-readable payload.
</authority>

<process>
1. READ THE RESULT

   ```
   legion validate --json
   ```

   One call. Everything below comes out of that payload. Use `legion doctor --json`
   instead when the operator wants the operational paths checked too.

2. RENDER

   - **Verdict** — `ok` and `status`: `valid`, `valid_with_warnings`, `invalid`,
     `traceability_broken`, `requirement_set_drift`, or `settings_unparseable`.
   - **Blocking diagnostics** — `diagnostics`. Each carries a `code`, a `message`
     and a `source.path`. Show all of them; they are why the verdict is what it is.
   - **Warnings** — `warnings`, when present. These do not fail the build. Show
     them as findings to fix, not as errors.
   - **Coverage** — `coverage`: `planned` of `requirements`, naming the
     `unplanned` IDs. Unplanned requirements are the normal state of a project
     mid-flight, so report the number without treating it as a fault.
   - **Settings** — `settings.status`. `absent` means no `settings.json`, which is
     not a problem. `warned` means invalid values were reported as warnings.
     `unparseable` is the only settings state that fails.
   - **Doctor extras** — `checks.operationalStore` and `checks.workerBundles`
     when the payload came from `legion doctor`.

3. REPAIR

   Offer to fix what is mechanically fixable, then prove the fix.

   - Apply one repair at a time, so a failed attempt is attributable.
   - **Then re-run validation on fixed files and show updated results.** A repair
     that has not been re-validated is a claim, not a fix.
   - If the diagnostic count did not fall, say so plainly rather than reporting
     the repair as applied.

4. DECLINE WHAT NEEDS JUDGEMENT

   **Do NOT auto-fix anything whose correct value is a decision.** Editing an
   artifact to satisfy a check is a repair only when the intended content is
   obvious; otherwise it converts a visible failure into an invisible wrong
   answer.

   Never edit a requirement to make its hash match. Requirement-set drift means
   the set changed after it was recorded, and the recorded hash is what makes
   that visible. Show the drift and let the operator decide whether the
   requirement or the record is wrong.
</process>

<inspection>
- `legion doctor --json` is the broader check; use it when a project looks healthy but something operational is wrong.
- `legion status --json` says where the project stands. Validation says whether what it stands on is intact.
- Nothing in this command writes to `.legion/`. If a section is missing from the payload, the artifact is missing — a finding, not a rendering problem to work around.
</inspection>

<decision_matrix>
| Situation | Action |
|-----------|--------|
| `status` is `valid_with_warnings` | Report success, then list the warnings as things to fix |
| `status` is `requirement_set_drift` | Show every drift entry; do not edit requirements to silence it |
| `status` is `traceability_broken` | Name the unresolved IDs; a broken reference means an artifact moved or was removed |
| `status` is `settings_unparseable` | Show the parse error; every consumer is running on defaults while believing otherwise |
| `settings.status` is `absent` | Say so and move on; most projects never write the file |
| A repair was applied | Re-run validation and show the new result before claiming the fix worked |
| The payload looks wrong | Show it as returned and say what you doubt; do not substitute your own reading |
</decision_matrix>

<completion_gate>
- The rendered verdict is the one `legion validate --json` returned.
- Every blocking diagnostic is shown, with its path.
- Any repair applied was followed by a re-run whose result is shown.
- No requirement, oracle, or task artifact was edited to make a check pass.
</completion_gate>
