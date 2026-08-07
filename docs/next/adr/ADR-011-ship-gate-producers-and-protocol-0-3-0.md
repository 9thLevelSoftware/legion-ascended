# ADR-011: Ship Gate Producers And Protocol 0.3.0

## Status
Accepted

This ADR **amends** ADR-010; it does not supersede it. Exactly one consequence of ADR-010 is retired — the paragraph reading "**`legion ship` cannot report ready for any R2 or R3 change until Phase D produces oracles and specs.** Most gates at those tiers have no producer, and an unevaluable required gate now blocks rather than passing quietly." Everything else in ADR-010 stands, including the two requirements its supersession rule protects: a task declares its blast radius, and acceptance criteria state how they are proven. Neither is weakened here; both are what the producers below write against.

The rule ADR-010 stated in the same breath is **preserved unchanged**: an unevaluable required gate still blocks. What changed is that the gates now have something to read, not that refusing became optional.

ADR-006 is the other ADR this one depends on. Its R2 and R3 gate lists are the specification every producer was built against, and its rejected-alternatives table is why the dogfood was given a recorded risk tier rather than a lower fallback: "Let implementers lower gates inline — this would allow the worker under review to weaken its own acceptance path."

ADR-010's body is left byte-identical, and a single "Amended by ADR-011" line is added to its `## Status`. An ADR is a dated record of what was decided; rewriting a consequence in place erases the reasoning this ADR exists to amend. But a reader who arrives at ADR-010 through search must not act on a retired consequence, so the pointer goes where that reader is. The repository had no precedent either way; this is the rule being set.

## Context
ADR-010 connected the risk gates to the workflow verbs and found that most of them had nothing to read. Ten of the twenty gates in `GATE_SCOPE` fell through `evaluateGate`'s `default:` arm and answered `unevaluable` for every input whatsoever, with the reason string "Legion does not yet produce evidence for this gate." Because an unevaluable required gate blocks — correctly — no R2 or R3 change could reach `ready`, and ADR-010 recorded that as a consequence to be lived with until producers existed.

The cost of living with it was larger than it looked. `scripts/dogfood-workflow.mjs` asserted `status: "blocked"` **as its success condition**, and `tests/workflow-dogfood.test.mjs` pinned `shipStatus === "blocked"` and `shipBlockedGates > 0`. So the repository's own end-to-end harness certified that Legion could not certify anything, and did it with two assertions that could not fail when the tool started refusing for a new reason, could not distinguish a change blocked on unproven gates from one blocked on a broken traceability chain, and would have gone green if a gate stopped being derived at all.

Ten releases closed the gap, one gate family at a time. This ADR records what they built, what a waiver may and may not do, and why the protocol version moves.

## Decision

### The producer table is total over `GATE_SCOPE`

Three counts of "the producers" are all true and all different: **ten writer verbs** (the distinct entries in the table's Producer column), **eleven gates that consume the change planes** (`loadShipGateChangeFacts`, `packages/cli/src/commands/workflow/ship.ts`), **fifteen case arms in `evaluateGate`** — twenty `case` labels grouped into fifteen bodies, plus a retained `default:`. Nine of those fifteen arms were written by this series: eight answering the ten gates that had no producer, and one splitting `explicit_human_approval` out of the shared review arm so it could read the approval plane instead of any accepted review.

An ADR that picks one number without naming its axis is the unfalsifiable claim this series has been closing, and the first draft of this paragraph said "twelve producing arms", which reproduces under no reading of the code — review counted 20, 15, 9 and 10 depending on what "arm" was taken to mean and could not tell which was intended. The correction is recorded rather than quietly made, because a count nobody can reproduce in a paragraph arguing against counts nobody can reproduce is the exact failure this series is about. The table below is total over a fourth axis: every key of `GATE_SCOPE`, which is a `Readonly<Record<RiskGateId, ShipGateScope>>` and therefore cannot be one row short. A reader can check all four against the code mechanically.

| Gate | Scope | Planes and artifacts the reader consults | Producer |
| --- | --- | --- | --- |
| `current_task_contract_or_small_change_record` | task | none — a planned task graph is the record | `legion plan` (structurally; the gate is a literal `satisfied`) |
| `task_contract` | task | none — same | `legion plan` (same) |
| `evidence_note` | task | evidence index | `legion build` |
| `evidence_bundle_or_log` | task | evidence index | `legion build` |
| `deterministic_verification` | task | evidence item `declared-verification` | `legion build` |
| `scoped_implementer_run` | task | evidence item `diff-reconciliation` | `legion build` |
| `lightweight_independent_review` | task | reviews | `legion review --accept` |
| `task_level_independent_review` | task | reviews | `legion review --accept` |
| `protected_oracle` | task | evidence item `oracle-verification` | `legion plan` writes the oracle; `legion build` executes it |
| `approved_delta_spec` | change | approvals (`spec.delta.approve`) + `bundle.deltas` | `legion approve spec` |
| `integration_or_real_interface_checks` | change | task contracts' and oracles' declared surfaces, the pin verifier, evidence item `integration-surface-check`, approvals | `legion plan` declares; `legion build` exercises; `legion approve surface` re-affirms a drifted pin (echoed — see **Echo** below) |
| `whole_change_acceptance_evidence` | change | `change.acceptance` + approvals + evidence acceptance instants + the clock | `legion review --accept --approver` |
| `explicit_human_approval` | task | approvals (`workflow.review.accept`) + reviews | `legion review --accept --approver` |
| `approved_spec_and_oracle` | change | deltas + oracles + approvals + run plane (`min(startedAt)`) | `legion approve oracle`, ordered against `legion build` |
| `architecture_or_security_review` | change | reviews (`domains`) **or** `architecture-review` attestations, plus run plane | `legion review --domain`; `legion attest architecture-review` |
| `protected_acceptance_tests` | task | oracles' `acceptancePaths` + evidence item `protected-acceptance-paths` + approvals (`oracle.protected-paths.modify`) + run plane | `legion plan` declares; `legion build`'s guarded harness observes; `legion approve protected-paths` permits |
| `independent_baseline` | change | attestations + pin verifier + source classifier + run plane | `legion attest independent-baseline` |
| `security_or_e2e_evaluator` | change | attestations + pin verifier + source classifier | `legion attest security-evaluation` / `e2e-evaluation` |
| `rollback_or_forward_fix_evidence` | change | attestations + pin verifier + source classifier | `legion attest rollback-evidence` / `forward-fix-evidence` |
| `release_observation_plan` | change | release plane (`release.json`) **or** `release-observation` attestations | `legion release plan`; `legion attest release-observation` |

Two entries are deliberately absent. `legion dev change repoint` writes no plane a gate reads — it repairs artifact-input pins that `legion review --accept` invalidated — and listing it as a producer would claim a governance record where there is none. And `evaluateGate`'s `default:` arm is **retained** although it now answers for no gate: it is the positive-checks rule made structural, so a gate id added later reports "Legion does not yet produce evidence for this gate" rather than falling into a satisfied arm. `tests/ship-risk-gates.test.mjs` asserts that no gate at any tier reaches it.

### Waivers, at both ends

A rule written only at the writer or only at the reader is the writer-weaker-than-reader defect this series paid for four times, so both are recorded.

**Writer — `legion attest` (`packages/cli/src/commands/workflow/attest.ts`).** `--verdict not_applicable` is refused without a `--waiver-reason` that is substantive: at least `WAIVER_REASON_MIN_LENGTH` characters and more than one word, because "a single word is not a reason, however long the word is." `--waiver-reason` is refused on every other verdict, because a waiver sentence attached to a `pass` reads as a waiver of that verdict. The attester must be a human decision owner recorded in `.legion/project/project.json`; no attester is ever inferred from the environment, from git config, or from a project happening to have exactly one owner.

**Reader — `shipGateWaivers` and the attestation gate arms (`packages/cli/src/workflow/ship-gates.ts`).** A `not_applicable` record whose attester is not `human`, or whose waiver reason is absent, does **not** satisfy. A valid one does, and only for the five gates in `ATTESTATION_GATE_KINDS`.

**Echo.** A gate satisfied by a person's decision rather than by a machine-checkable result is always visible in the payload, on five surfaces. A waiver is echoed as a `risk_gate_waived` warning and in `riskGates.waivedGates`, carrying the gate, the kind, the attester, the instant and the reason. The distinct claim — a person asserting something no report states — is echoed separately as `risk_gate_human_judgement` and in `riskGates.humanJudgementGates`, and has **two bases**:

- `basis: "attestation"` — a `pass` attestation for a kind whose evidence rule is `human-judgement`. Nothing machine-checkable exists for the question at all.
- `basis: "pin-reaffirmation"` — a declared verification surface whose pinned bytes drifted and were re-affirmed by `legion approve surface` rather than re-verified. A real `integration-surface-check` did run and did pass; it ran against the *earlier* bytes, and what stands between it and the current ones is a named human's decision.

**The second basis was missing when this release was first reviewed, and its absence made the sentence below false.** The dogfood was the counterexample: overwrite the compose file the declared surface pins with prose saying the integration environment no longer exists, run `legion approve surface --approver dogfood`, and `legion ship` returned `{"status":"ready","riskGates":{"satisfied":7,"unsatisfied":0,"unevaluable":0,"waivedGates":[],"humanJudgementGates":[]},"diagnostics":[]}`. The gate's own reason still read "was exercised, and every pinned reference still matches", which a re-affirmation reaches only by *not* matching. The choice was between narrowing the claim and moving the payload; the claim is the right one, so the payload moved.

**A gate satisfied by a decision is counted in `riskGates.satisfied`, so the count is never the claim**; the lists are what make the difference readable, and a harness that reads the count without them is the one reader ignoring the field built for it.

ADR-006's other escape is unchanged: a `risk.override` lowering the tier still requires a decision owner, evidence and `protectionsRetained`, and still cannot waive `protected_oracle` or `explicit_human_approval`.

### The dogfood certifies what the tool can establish

`scripts/dogfood-workflow.mjs` now drives a real intake session recording `risk-tier: R2` with one executable acceptance criterion carrying a declared `real-interface` surface, runs `legion approve spec --approver` and `legion review --accept --approver`, and asserts `legion ship` reports `ready` with seven satisfied gates and no human-judgement entry. It then edits the file the surface pins, asserts the ship blocks naming `integration_or_real_interface_checks`, runs the recovery that payload printed, and asserts the ship comes back — so the harness demonstrates both verdicts in one run and executes a recovery rather than asserting about its text.

**The recovered `ready` is asserted to differ from the earned one**, and that is what makes the earlier assertion mean anything. The first draft asserted `waivedGates: []` and `humanJudgementGates: []` and nothing else, which review measured to be unfalsifiable: only the five gates in `ATTESTATION_GATE_KINDS` could write either list, none of them is derived at R2, and a genuine `not_applicable` waiver recorded against the dogfood change moved neither. Two assertions that no product change could redden had been added in the same commit that retired `shipBlockedGates` for exactly that shape. `humanJudgementGates` is now writable at R2 — the pin re-affirmation puts `integration_or_real_interface_checks` into it — so the harness asserts it empty before the drift and equal to `["integration_or_real_interface_checks"]` after the repair, and asserts the matching `risk_gate_human_judgement` warning names the file and the approver. Measured by mutation: deleting the `judgement` the gate sets makes the harness fail with `expected "integration_or_real_interface_checks", got ""`. `waivedGates` is no longer asserted here at all, because this harness cannot reach a state that would move it; `tests/cli-attest.test.mjs` and the R3 milestone hold that claim where a waiver is reachable.

The R2 fallback in `phaseRiskProfile` is **bypassed, not lowered**. The hardcoded tier is reached only when no intake session recorded an enforcement tier; giving the dogfood a real interview supplies one. Lowering it is what ADR-006 forbids.

`tests/cli-workflow-ux.test.mjs` is deliberately left approving nothing, and still asserts a blocked ship naming three gates by id. It is the counterweight: the difference between the two fixtures is the claim.

### Protocol 0.3.0

`CURRENT_PROTOCOL_VERSION` moves to 0.3.0. `SUPPORTED_PROTOCOL_VERSIONS` is `["0.1.0", "0.2.0", "0.3.0"]`. An identity `legion.protocol.0-2-0.to.0-3-0` upcast is registered.

0.3.0 adds **no required field and removes none**. It adds two entity kinds (`attestation`, `release`) and optional fields on existing ones — `review.domains`, `oracle.acceptancePaths`, and the approval subjects and actions the approval plane grew. Every 0.2.0 document still validates unchanged.

The version moves anyway, because these are `z.strictObject`s: a 0.2.0 reader handed a document that exercises one of the new optional fields rejects it on the unknown key, and rejects it as *malformed* — with no way to tell "written by something newer" from "corrupt". That is the condition a version exists to signal, and ADR-010's rejected-alternatives table already refused shipping a changed shape under the old version because doing so "would make compatibility claims unfalsifiable and poison every downstream negotiation."

**The claim is narrow and is stated narrowly.** Nothing in this tree's production read path calls `negotiateProtocolVersion` or `versionIsSupported`; the sole caller of `upcastProtocolRecords` is `readJsonArtifact`, which upcasts and then validates. So the version is a signal to future and external readers, and `z.strictObject`'s unknown-key rule is what actually refuses. Writing "an older reader rejects a newer document" without that qualification would be false for every document that does not happen to use a new field.

**The identity migration is load-bearing, not decorative.** `findProtocolMigrationPath` is a breadth-first walk over registered edges and `applyMigrations` targets the registry's current version. With 0.3.0 current and no 0.2.0 → 0.3.0 edge there is no path from 0.1.0 to 0.3.0 at all: `applyMigrations` throws, `upcastProtocolRecords` swallows it, and the 0.1.0 document reaches the schema unmigrated. Bumping without the hop would make every 0.1.0 document on disk unreadable.

**`appliesToKinds` is `["requirement", "task-contract"]` — the same two the 0.1.0 hop claims, and no more.** The field is easy to misread as an enforcement point and is not one: `migratableKinds()` is a union across every registered migration, so removing a kind from the new migration's list changes nothing and reddens nothing. The falsifiable direction is widening, and `packages/protocol/test/migrations-0-3-0.test.mjs` asserts it by checking that a 0.2.0 `review` — a kind this series changed — comes back unchanged. Widening buys nothing, because entity schemas accept any semver and a 0.2.0 oracle already parses under 0.3.0; it costs a deep clone per record per read and renumbers more documents on disk. `taskgraph`, `change-artifact-manifest` and evidence-index envelopes are never claimed — ADR-010 records seventeen failing tests from a walk that rewrote them. Read-time migration does not disturb content addressing either way: `readJsonArtifact` hashes the original bytes for the artifact reference.

**One consequence nobody asked for, stated rather than discovered.** `repointProposalPins` reads the task graph through the upcasting reader and writes `taskGraph.document.tasks` straight back, and `legion review --accept` triggers it. From 0.3.0 onward an accept therefore flips every task contract's on-disk `schemaVersion` from `"0.2.0"` to `"0.3.0"` while the task graph envelope stays at `TASKGRAPH_SCHEMA_VERSION` — exactly the independent-versioning rule ADR-010 records. It is benign under an identity migration, but it is a real data write, and it happens only where re-pointing was needed, so a repository can end up with contracts at both versions.

## Consequences
An R2 change reaches `ready` end to end, and an R3 change reaches it with the full attestation, domain-review and release-plan set. The repository's own dogfood is the first witness for the R2 half and asserts it on every test run.

**What an R2 `ready` does not establish, stated because a reader will otherwise assume it.** R2 derives seven gates and `scoped_implementer_run` is not among them, so no diff reconciliation runs at this tier. Review measured the consequence: after `legion review --accept`, appending an unreviewed line to a source file and adding a whole new source file leaves `legion ship` reporting `ready` with seven satisfied, nothing unevaluable and no diagnostic. The verification-surface pin is the only post-acceptance integrity check R2 has, it covers only the files a declaration pinned, and `legion approve surface` is by design a way past it. That is ADR-006's tier design working as specified rather than a defect introduced here — R3 is where the run plane, the attestations and the ordering checks come in — and it is recorded so that "the dogfood ships `ready`" is not read as "an R2 `ready` means the tree was not touched afterwards".

`legion ship`'s counts stop being the whole story and the payload says so. `riskGates.waivedGates` and `riskGates.humanJudgementGates` name every gate whose `satisfied` rests on a named person's decision rather than on a result a program produced — an audited `not_applicable` waiver, a `human-judgement` attestation, or a re-affirmed verification-surface pin. So a reader who wants "seven gates were proven" rather than "seven gates were counted" has the fields to check.

**The boundary is which question the gate asks, and it needs stating because the first version of this sentence was wrong about it.** `explicit_human_approval`, `approved_delta_spec`, `approved_spec_and_oracle`, `whole_change_acceptance_evidence` and `protected_acceptance_tests` are all satisfied by a recorded human decision and none of them belongs in these lists: they *ask* whether a named human decided something, so the decision is direct evidence of the thing asked, and the approval plane's audit trail is the machine-checkable part. The lists name the other case — a gate that asks whether a check established something and was satisfied by a person's assertion instead. Three returns in `ship-gates.ts` are that shape today: the attestation waiver arm, the attestation human-judgement arm, and the surface pin re-affirmation. Nothing mechanically proves there is no fourth, which is why the rule is written here in terms a reviewer can hold a new `satisfied` arm against, rather than left implicit in the two arms that happened to exist first. Review found the third by driving the dogfood; that is the cost of leaving it implicit.

Ten verbs now write governance records. Every one of them calls the reader's own exported predicate to decide whether it has anything to write, rather than paraphrasing it — `isLiveDeltaSpecGrant`, `isLiveOracleGrant`, `isLiveSurfaceReaffirmation`, `isSatisfyingAttestation`, `isDomainReviewSatisfying`, `isSatisfyingReleasePlan`, `isLiveProtectedPathsModifyGrant`. A writer whose "done" is weaker than the reader's "satisfied" exits 0 while ship blocks forever, which happened four times in this series before the discipline was adopted.

Protocol 0.3.0 is what an external reader negotiates against. A 0.2.0 reader that does check versions now has a truthful signal; one that does not still fails closed on the unknown key rather than silently accepting a document it cannot represent.

Legacy state stays readable. A 0.1.0 record reaches 0.3.0 by chaining both hops, and its fail-safe budgets and `manual` criteria arrive annotated exactly as ADR-010 specified.

## Rejected Alternatives
| Alternative | Reason rejected | Revisit evidence |
| --- | --- | --- |
| Lower the hardcoded R2 fallback in `phaseRiskProfile` so the dogfood could ship | ADR-006 rejects letting implementers lower gates inline by name. The harness would then certify a tier nobody chose, and the fallback exists for changes with no recorded interview — weakening it weakens every one of them. | No planned revisit. |
| Keep the dogfood planning from its own hand-written roadmap and add an interview beside it | `resolvePhaseRequirement` resolves a requirement only through the anchor `renderRoadmap` emits, so planning would silently fall back to a stub with no executable criterion and no surface, and the change would block for a reason no assertion names. | No planned revisit. |
| Have the dogfood run `legion ship` before `approve spec` to demonstrate a blocked verdict | Measured: with no accepted review, ship returns `review_evidence_missing` and never evaluates a gate. The assertion would have been about a precondition. The pin-drift demonstration replaced it and reaches the gates. | Revisit if ship ever evaluates gates before the review precondition. |
| Report `shipBlockedGates: 0` in the dogfood summary instead of retiring the field | A field whose only value in a passing run is zero cannot fail — the same unfalsifiable shape as the `blocked` assertion being retired. | No planned revisit. |
| Narrow the **Echo** invariant to "every gate satisfied by an *attestation* with nothing behind it", leaving the surface re-affirmation unreported | Cheaper and false in the direction that matters. The operator's question is "what did nobody check", and the answer would have omitted the one gate in the whole R2 set where a human had waved a real drift through. A governance claim narrowed until the code satisfies it is not a governance claim. | No planned revisit. |
| Fold the pin re-affirmation into `waivedGates` instead of `humanJudgementGates` | `risk_gate_waived`'s sentence is "this check does not apply to this change". A re-affirmation says the opposite: the check applied, ran and passed — against bytes that have since moved. | No planned revisit. |
| Keep asserting `waivedGates.length === 0` in the dogfood | Unfalsifiable from an R2 fixture, measured: `ATTESTATION_GATE_KINDS` covers five gates, none in `DEFAULT_RISK_POLICY.gatesByTier.R2`, and an `attest architecture-review --verdict not_applicable` against the dogfood change left the list empty. | Revisit if the dogfood is ever raised to R3. |
| Add the satisfied gate ids to the ready ship payload so the dogfood could name all seven | A payload shape change in a release whose central claim is that no gate moved, adding a field with one reader. The tier, the task count and the three counts pin "seven is every R2 gate" instead. | Revisit if a second consumer needs the satisfied set. |
| Supersede ADR-010 rather than amend it | Only one consequence is retired. Superseding would discard the protocol revision, the fail-safe migration policy and the envelope-independence decision, all of which this release depends on. | No planned revisit. |
| Rewrite ADR-010's retired consequence in place | An ADR is a dated record; editing a consequence erases the reasoning that makes the amendment legible. A pointer in its `## Status` puts the correction where a searching reader lands without touching the argument. | No planned revisit. |
| Ship the 0.3.0 shapes under 0.2.0 | ADR-010 already rejected this for 0.2.0 under 0.1.0, and the reason has not changed: a version that does not move makes every compatibility claim unfalsifiable. | No planned revisit. |
| Register a 0.3.0 → 0.2.0 downcast to satisfy ADR-010's both-directions clause cheaply | This ADR amends rather than supersedes, so the clause is not triggered — and on the merits a renumber-only downcast produces a document claiming 0.2.0 that a 0.2.0 `z.strictObject` reader rejects on `domains` or `acceptancePaths`, so it would not achieve what a downcast is for; a field-stripping one would make `informationPreserving: true` a false declaration. A downcast's `appliesToKinds` is also unioned into the read-time walk, widening it for no reader. | Revisit when a real 0.3.0 → 0.2.0 consumer exists, and then only with a downcast that strips the new optional fields and declares itself lossy. |
| Claim every entity kind in the identity migration's `appliesToKinds` | It renumbers nothing, so it buys no readability; it costs a deep clone per record per read and renumbers more documents on disk. ADR-010 records the catastrophic version of this mistake. | No planned revisit. |
| Leave `LEGION_PROTOCOL_MIGRATIONS` in `legion-0-2-0.ts` | A file named for its target version would import its own successor. The array moved to `migrations/registry.ts`, re-exported by the barrel so no consumer changed. | No planned revisit. |

## Evidence
- PRs closing the ten producers, in order: change facts threaded to the evaluator; the approval plane and `explicit_human_approval`; `legion approve spec`; verification surfaces and `legion approve surface`; `updateChangeAcceptance` and `legion dev change repoint`; `legion approve oracle`; the `Attestation` entity and `legion attest`; `legion review --domain`; `legion approve protected-paths` and the guarded harness's acceptance-path observation; `legion release plan`.
- `tests/change-acceptance.test.mjs` — "an R2 change ships ready, end to end, for the first time": seven satisfied, one task, tier R2, and demoting the acceptance removes exactly one gate.
- `tests/change-r3-ordering.test.mjs` — "an R3 change carrying all ten gates ships ready, end to end through the real CLI".
- `tests/workflow-dogfood.test.mjs` — the harness now asserts `ready`, `R2`, one task, `{satisfied: 7, unsatisfied: 0, unevaluable: 0}`, both halves of the pin-drift demonstration, and `humanJudgementGates: ["integration_or_real_interface_checks"]` on the recovered ship.
- `tests/verification-surface-gate.test.mjs` — a re-affirmed pin's satisfied sentence no longer claims "every pinned reference still matches", carries its `pin-reaffirmation` judgement, and does not fire when the pins are clean or when a second surface is clean.
- `tests/cli-workflow-ux.test.mjs` — the unapproved fixture still blocks, naming `approved_delta_spec`, `integration_or_real_interface_checks` and `whole_change_acceptance_evidence`.
- `tests/ship-risk-gates.test.mjs` — the twenty-nine-scenario transcript, byte-identical across this release: no cell moved.
- `packages/protocol/test/migrations-0-3-0.test.mjs` — the chain from 0.1.0, the identity's field-for-field equality, the read-path renumber, the unclaimed-kind pass-through, and `negotiateProtocolVersion` — *that function specifically, which nothing in this tree's read path calls* — refusing a 0.3.0 document at a 0.2.0 reader.
- `tests/protocol-upcast-on-read.test.mjs` — envelopes still frozen at their own versions with their self-hashes intact.

## Reversal Conditions
Reverse the producer half only by a later accepted ADR that names ADR-011 and ADR-006 and either supplies a different mechanism by which each ADR-006 gate can be answered from recorded facts, or demonstrates with measured evidence that the recording costs more than the drift it prevents. Removing a producer without removing its gate returns that gate to `unevaluable`, which blocks — so a partial reversal fails closed, and that is the intended direction.

Reverse the protocol half by a later accepted ADR that names ADR-011 and ADR-010 and registers a real 0.3.0 → 0.2.0 downcast. No such downcast is registered here, and the omission is a decision rather than an oversight: ADR-010's supersession rule requires a migration path in both directions of anything that *supersedes* it, and this ADR amends a single consequence instead. The reasoning against registering one anyway is in the rejected-alternatives table above. Any future downcast must strip `review.domains` and `oracle.acceptancePaths` and declare itself lossy, because renumbering alone produces a document a 0.2.0 reader still refuses.

## Review And Approval
- Approver: dasbl
- Proposed: 2026-08-06
- Accepted: 2026-08-06
- Supersession rule: Supersede only by a later accepted ADR that names ADR-011, preserves the rule that an unevaluable required gate blocks rather than passing quietly, preserves the requirement that a waived gate name a human attester and a stated reason and be echoed in the ship payload, and states which producer answers each gate it leaves in `GATE_SCOPE`.
