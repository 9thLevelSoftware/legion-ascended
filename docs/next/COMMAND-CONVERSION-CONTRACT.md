# Command Conversion Contract

How a `commands/*.md` file is moved off `.planning/`, and what may not be lost doing it.

`commands/start.md` and `commands/status.md` are the worked examples. Sixteen commands remain, enumerated in `PLANNING_ALLOWLIST` in `scripts/scan-command-surface.mjs` and inventoried in `docs/next/command-capability-inventory.json`.

## The rule this exists to state

**A command may not be converted before its host-only behaviour is inventoried.**

Not "should not". The conversion of a command with an uninventoried capability is not a risky change, it is an unreviewable one: the capability is absent afterwards and no test names it, so the deletion and the intended outcome are indistinguishable in the diff and in CI.

The corollary is the part that is easy to skip. **Verb existence is not evidence of behavioural parity.** `legion <verb>` sharing a name with `/legion:<command>` says nothing about whether it does the same work. Deciding from the name, the description line, or `--help` output is deciding from a summary someone else wrote for a different purpose.

This is not a hypothetical failure mode. The first pass of the phase 16 plan classified all sixteen commands from one-line help text. Four were wrong — `advise`, `ship`, `board`, and `explore` — and each would have deleted, respectively, an advisor selection, a publishing workflow, a deliberating panel, and the design conversation that exploration exists to hold. Three were caught in review; the fourth was caught only once the inventory was built from code. The same pass also stated three verb rationales that were false and three dispatch-site counts that had no source.

## Classes

| Class | The CLI owns | The host keeps | Conversion |
|---|---|---|---|
| **A** | The work itself. The verb is deterministic or purpose-built, and produces the artifact. | Rendering, and prompts that only choose between the verb's own modes. | Thin to a renderer of the verb's `--json` payload. |
| **B** | The derivable state: typed artifacts, verification, gates, risk, and the decision that a step is complete. | The named orchestration: agent selection, dispatch, deliberation, multi-turn sessions, and anything that publishes. | Split along the recorded boundary. The host reaches state only through the CLI's typed artifacts. |
| **C** | Nothing yet. No verb exists. | Everything. | Do not convert. `P16-B009` decides placement. |

Class A is the destructive direction. Misfiling a class-B command as class A deletes capability; misfiling class A as class B leaves work in the host that the CLI could have owned, which is waste rather than loss. **When the evidence is ambiguous, assign B.**

### Class A is currently empty, and that is the finding

Five commands were proposed as class A — `map`, `milestone`, `retro`, `learn`, `validate`. Grounding each in its handler moved all five to B.

The pattern was identical every time: the verb is **deterministic and executor-free**, that was read as **equivalent**, and it is a different claim. Deterministic says how the verb computes. Equivalent says what it produces.

| Command | Read as | Actually |
|---|---|---|
| `map` | Produces CODEBASE.md | Produces a *file-extension histogram*. The command produces an architecture document. Same filename, different artifact. |
| `retro` | Takes `--phase` | `--phase` reaches a slug, a run record, and a prompt topic string. It selects no evidence. The flag looks implemented and does nothing. |
| `milestone` | Has an `--archive` mode | Sets a status field. Nothing moves. No `git commit` or `gh` call exists anywhere in the CLI. |
| `learn` | Records lessons | Records lessons *untyped*. Pattern, pitfall, and preference do not exist in the data model, so the three modes built on them cannot be. |
| `validate` | Reports diagnostics | Reports them without severity. The command's WARN tier collapses into failure, so thinning turns every warning into a hard CI failure. |

The lesson is narrower than "be careful". **A verb that shares a name, a flag, and an output filename with a command can still produce something else entirely**, and every one of those three surface similarities is what made the wrong answer look checked. The only reading that distinguished them was the handler body.

Class A is not deleted — a genuinely equivalent verb should still take the work. But an assignment to it now requires showing the artifacts match, not that the verb is deterministic.

## Procedure

1. **Inventory the command.** For each behaviour, record what it is and an anchor string that locates it in the file. Anchors are checked by `scripts/scan-command-surface.mjs`; a capability with no anchor is a capability no test can protect.
2. **Inventory the verb — from its implementation.** Name the handler file and symbol. `executorBacked` is *computed* from the handler body, not asserted, so a wrong claim fails rather than misleads. Record `sharedWith` when two verbs resolve to one implementation: that is the sharpest form of the parity trap, because both names then describe the same generic behaviour.
3. **Diff the two.** Everything the command does that the verb does not is either host-only work or a `cliGaps` entry.
4. **Close the gaps in the CLI first, with tests.** A class-A command may not be thinned onto a verb that is missing a mode it has. Adding the mode afterwards is a regression with a follow-up ticket attached.
5. **Assign the class**, and only now.
6. **Convert**, then remove the command from `PLANNING_ALLOWLIST` in the same change.

## What the ratchet enforces

`tests/command-surface.test.mjs` fails when:

- a command reads `.planning/` and is not on the allowlist — unconverted work nobody recorded;
- an allowlisted command no longer reads `.planning/` — converted work whose entry was left behind, which is how a list that must shrink stops shrinking;
- an allowlisted command has no inventory entry — a class assigned to a command nobody looked at;
- a recorded capability's anchor has vanished from the command — either it moved and the inventory is stale, or it was deleted and the deletion was never recorded;
- a cited handler symbol no longer exists, or a verb's `executorBacked` claim disagrees with its code.

The allowlist may only ever shorten, and that is enforced rather than asked for: the list and the set of commands that actually read `.planning/` are asserted equal, so neither direction can drift.

## Recording a deliberate removal

Some capability should not survive. `commands/validate.md` checks agent-roster consistency against the `.planning/` agent catalog, which retires with `.planning/` itself.

A removal is deliberate when it is written down as a `cliGaps` entry saying so before the edit lands. A removal discovered afterwards is a regression, whatever its merits — the distinction is the record, not the judgment.
