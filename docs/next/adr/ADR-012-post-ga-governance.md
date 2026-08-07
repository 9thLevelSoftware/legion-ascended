# ADR-012: Post-GA Governance Scope

## Status
Accepted

## Context
The rewrite program defined a completion hierarchy in `docs/legion-next-roadmap.md`: task implementation, deterministic verification, independent task review, task acceptance, phase integration verification, independent phase review, phase handoff. Its acceptance checklist records these as "non-optional", and the Evidence And Ledger Policy sets a minimum evidence set per accepted task and per accepted phase.

Phases 0 through 13 were executed that way. Each carries a ledger under `.legion/project/changes/LEGION-NEXT/implementation/phase-NN/`, an `evidence-index.yaml` with a SHA-256 per artifact, an evidence bundle under `docs/next/evidence/`, and a signed independent review under `docs/next/reviews/` recording a reviewer distinct from the implementer. Phase 13 closed its implementation tasks on 2026-06-22, leaving only P13-T04 — the GA sign-off itself — open.

Work did not stop there, and it did not follow that process.

- Phase 14 has one backlog item, `P14-B001`, realigning the CLI to the workflow-first UX of ADR-009.
- Phase 15 was deliberately never claimed; the backlog records why.
- Phase 16 has fourteen items retiring `.planning/` from the installed command surface.
- Beyond that, the work carries no phase numbering at all. Protocol 0.2.0 and 0.3.0, the approval and attestation planes, the review panel, the retrospective loop, and the ten ship-gate producers arrived as PRs #37 through #83 between 2026-07-30 and 2026-08-06, titled by intent rather than by task ID. The branch names say `p17`, `p18`, `p19`; nothing else does.

None of that span has a ledger, an evidence index, or an independent phase review. Measured against the roadmap's wording, six phases of work skipped gates described as non-optional.

Three facts decided this ADR rather than a backfill.

**The gate mechanism does not exist for these phases.** Every phase 0-13 gate is anchored to a source phase document under `C:/Users/dasbl/Documents/legion/docs/rebuild/`, a tree outside this repository. The roadmap's Phase Index enumerates exactly phases 0 through 13, and its rule "execute phases in numeric order" has no continuation. There is no phase document for 14 or beyond to verify against, so an independent phase review of them would have no contract to check the work against.

**A backfill would have to invent its own evidence.** The per-task fields these ledgers carry — `run_id`, `assignee`, per-task `commit`, `depends_on` — have no ground truth for this span. The work was not decomposed into `PNN-TYY` tasks. Reconstructing them from git log would produce artifacts shaped like evidence but sourced from a narrative written afterwards, which is the specific failure mode this project's own doctrine names: a self-report is not evidence.

**Nothing would check the result.** `scripts/release/release-checklist.mjs` is the only reader of a ledger, a kanban manifest, or a review document anywhere in the repository, and every check it performs is hardcoded to Phase 13. `scripts/validate-next.mjs` parses none of them. Backfilled phase 14-19 artifacts would satisfy zero automated checks and could not regress any.

The honest choice is between amending the rule and pretending it was followed. The work shipped under a lighter process; this ADR states what that process is and scopes the heavier one, rather than leaving the roadmap asserting a gate the repository does not meet.

## Decision
The phase ledger, evidence index, and independent phase review gates are scoped to the rewrite program: **phases 0 through 13**. They are not amended, weakened, or retroactively waived for that span, and phase 13 still requires its independent review to reach a `PASS` before GA.

Work after the Phase 13 cut line is governed by:

| Gate | Mechanism |
| --- | --- |
| Review | Two passes per PR as defined in `REVIEW.md` — a correctness pass and a mandatory Ponytail pass. Never optional. |
| Behavioural record | A `CHANGELOG.md` entry for every change to observable behaviour, stating what changed and what it changed *from*. |
| Architectural record | An ADR for any change to the protocol, the gate semantics, the command surface, or a documented refusal. |
| Verification | `pnpm run validate:next` green on all three supported platforms before merge. |

This is a real process, not an absence of one. What it drops relative to phases 0-13 is the per-phase ledger, the hash-pinned evidence index, and the separately-signed phase review. What it keeps is independent review of every change, a durable record of what changed, and a deterministic verification gate.

`docs/next/IMPLEMENTATION-BACKLOG.yaml` is a planning input, not a tracker. Its items carry no status field and none is added; completion is recorded by the CHANGELOG and the git history, not by mutating the backlog.

## Consequences
`docs/legion-next-roadmap.md` and `docs/next/REWRITE-CHARTER.md` are amended to state this scope. The roadmap's "non-optional" wording stands for the phases it enumerates and no longer implies an obligation for work beyond them.

No phase 14-19 ledgers, evidence indexes, or independent reviews are owed. Their absence is now a recorded decision rather than an unexplained gap, which is the substantive change: an auditor reading the repository can tell that the heavier process ended deliberately at a stated line, and can see what replaced it.

The release checklist's Phase-13-hardcoded checks are correct as written and are not generalised. GA remains gated on the phase 13 independent review reaching `PASS` by a reviewer who is not the implementer.

This ADR does not authorise reducing review on future work. Any move to a lighter gate than the table above requires a later ADR that names this one.

## Review And Approval
- Approver: dasbl
- Date: 2026-08-07
- Supersession rule: Supersede only by a later accepted ADR that names ADR-012 and states, in full, the governance gates that replace the table above.
