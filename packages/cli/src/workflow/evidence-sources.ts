/**
 * Reading a verdict out of a report this repository produces but does not own.
 *
 * `legion attest` refuses to record `pass` over a file whose own contents say
 * otherwise, and the three gates that read attestations re-derive the same
 * answer at ship time rather than trusting the writer. Both need one function
 * that turns bytes into "recognised and clean", "recognised and blocking",
 * "recognised and never evidence of a pass", or "not recognised at all" — and it
 * has to be one function, because a writer whose idea of a clean report is
 * weaker than the reader's is PR 2's defect in mirror image.
 *
 * **This is the first content-based reader of these documents in the tree, and
 * the instruction to "reuse the existing adapters" is not executable.**
 * `threatModel()` in `commands/evals/index.ts` and `rollbackVerify()` in
 * `commands/release/index.ts` spawn a child process and run `parseJsonVerdict`
 * over its stdout. Neither reads a file, neither contains a shape recogniser,
 * and neither can be called with bytes. What is reused from them is the fact of
 * the envelope, below.
 *
 * **Recognition is structural, and it has to be said out loud that this is not
 * fastidiousness.** No document here carries a `kind`, `tool`, `producer` or
 * `$schema` naming its report type. `schema_version: 1` is shared by the threat
 * model, the A/B comparison, a run score and a run manifest.
 * `rollback-policy.json`'s top-level `kind` names the *backup manifest's*
 * flavour ("codex-legion-migration-backup"), not the report. And the one
 * existing consumer, `scripts/release/release-checklist.mjs`, recognises by
 * hard-coded path — `path.join(evidenceRoot, "P13-T02", "threat-model.json")` —
 * which is exactly the inference this release exists not to make. So each shape
 * is identified by a key tuple unique to its producer in this repository, and
 * the next author who reaches for the filename should read this paragraph first.
 *
 * **The blocking predicate is per shape, and the asymmetry between them is
 * deliberate in the producers rather than an accident.** A single shared
 * `ok !== true || findings.length > 0` rule is correct for exactly one of the
 * four shapes below, and it was measured against the committed bytes before
 * being rejected: `docs/next/evidence/P13-T03/rollback-policy.json` — the only
 * green rollback artefact this repository ships — has `ok: true` and one finding
 * whose `severity` is `"info"`, which `rollback-policy.mjs:374` itself excludes
 * from its verdict. A severity-blind shared helper would make
 * `rollback_or_forward_fix_evidence` unsatisfiable against the repository's own
 * evidence. Each predicate below mirrors its own producer's blocking rule and
 * nothing else's.
 *
 * **A report's summary field is never read alone, and the reason is the same one
 * the envelope paragraph gives further down.** These documents carry their
 * verdict in three places — a top-level `ok`, a `findings[]` array, and a
 * `checks` map whose entries carry their own `ok` — and the producers compute the
 * first from the third. Reading only the first is a fail-open against a
 * hand-edited file, and it is the identical mistake to reading an envelope's `ok`
 * without descending into `.verdict`, one level lower. Every predicate below
 * descends into `checks`, and a `findings` field that is present but is not an
 * array is a malformed report rather than a report with no findings: the
 * `?? []` that would make `{"0": {...}}` count as zero is the fail-open this
 * series has now paid for six times.
 *
 * **A rollback verdict names the filesystem tree it was taken in, and this
 * module compares it to the tree being shipped.** `rollback-policy.mjs` writes
 * `repository_root` and copies the audited manifest's `repositoryRoot`, and its
 * own `manifest_repository_root_match` check is blocking — so the same audit
 * re-run against a different root is `ok: false`. Without the comparison, a
 * verdict produced against *any other checkout* reads green here, and a report
 * produced by pointing the script at a scratch directory holding a hand-made
 * backup manifest launders identically. The committed
 * `docs/next/evidence/P13-T03/rollback-policy.json` is exactly that document: its
 * `repository_root` is `/var/folders/.../tmpamcjw11f`, a macOS temp directory
 * that has never existed in this repository. It is `blocking` here, and that is
 * the honest answer — see `ADMISSIBLE_SOURCE_SHAPES` in `ship-gates.ts` for what
 * that leaves `rollback_or_forward_fix_evidence` satisfiable by.
 */

import path from "node:path";

export type EvidenceSourceShape =
  /** `scripts/baseline/threat-model.mjs`. Machine-checkable. */
  | "threat-model"
  /** `scripts/release/rollback-policy.mjs`. Machine-checkable. */
  | "rollback-policy"
  /** `scripts/baseline/compare-runs.mjs`. Machine-checkable, and usually red. */
  | "ab-comparison"
  /** `scripts/baseline/grade-run.mjs`. Recognised so it can be refused by name. */
  | "run-score";

export type EvidenceSourceVerdict =
  /** A recognised report whose own producer would call it green. */
  | { readonly kind: "clean"; readonly shape: EvidenceSourceShape; readonly enveloped: boolean }
  /** A recognised report that is red by its own rule, or that cannot carry a pass. */
  | {
      readonly kind: "blocking";
      readonly shape: EvidenceSourceShape;
      readonly enveloped: boolean;
      readonly reason: string;
    }
  /** Valid JSON in no shape this module knows. Never a pass. */
  | { readonly kind: "unrecognised" }
  /** Not JSON at all, or bytes nobody handed us. Never a pass. */
  | { readonly kind: "unread"; readonly reason: string };

/** Classify one pinned source. Total, and never throws. */
export type ClassifyEvidenceSource = (reference: { readonly path: string }) => EvidenceSourceVerdict;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function keySetEquals(value: unknown, expected: readonly string[]): boolean {
  const object = asObject(value);
  if (object === undefined) return false;
  const keys = Object.keys(object).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function isThreatModel(document: JsonObject): boolean {
  return (
    typeof document["ok"] === "boolean" &&
    typeof document["run_dir"] === "string" &&
    typeof document["output_root"] === "string" &&
    keySetEquals(document["checks"], ["sandbox", "retention", "redaction"])
  );
}

function isRollbackPolicy(document: JsonObject): boolean {
  return (
    typeof document["backup_manifest_path"] === "string" &&
    (document["status"] === "restorable" || document["status"] === "blocked") &&
    keySetEquals(document["checks"], ["manifest", "restore_target"])
  );
}

function isAbComparison(document: JsonObject): boolean {
  const inputs = asObject(document["inputs"]);
  return (
    asObject(document["v8_summary"]) !== undefined &&
    asObject(document["v9_summary"]) !== undefined &&
    asArray(document["scenarios"]) !== undefined &&
    inputs !== undefined &&
    typeof inputs["v8_dir"] === "string" &&
    typeof inputs["v9_dir"] === "string"
  );
}

function isRunScore(document: JsonObject): boolean {
  return (
    typeof document["run_id"] === "string" &&
    typeof document["scenario_id"] === "string" &&
    typeof document["deterministic_total"] === "number" &&
    typeof document["critical_failure"] === "boolean" &&
    asObject(document["dimensions"]) !== undefined
  );
}

function describeFindings(findings: readonly unknown[]): string {
  const codes = findings
    .map((finding) => asObject(finding)?.["code"])
    .filter((code): code is string => typeof code === "string");
  return codes.length === 0 ? "" : ` (${codes.join(", ")})`;
}

/** What one `findings` field is: a list, or a report that is malformed. */
type FindingsField =
  | { readonly ok: true; readonly findings: readonly unknown[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Read a `findings` field, positively.
 *
 * `asArray(value) ?? []` is the fail-open this exists to replace: it turns
 * `findings: {"0": {code: "canary_present_after_redaction"}}` into zero findings
 * and lets a hand-edited `ok: true` through the very redundancy that was
 * supposed to catch it. An absent field is a list of none — the producers of the
 * subcheck maps omit it — but a *present* field of the wrong type is a document
 * this module cannot count, and a document it cannot count is not one it can
 * call green.
 */
function findingsField(value: unknown, where: string): FindingsField {
  if (value === undefined) return { ok: true, findings: [] };
  const findings = asArray(value);
  if (findings === undefined) {
    return {
      ok: false,
      reason: `its ${where} field is ${
        value === null ? "null" : `a ${typeof value}`
      } rather than an array, so what it records cannot be counted and it cannot be read as green`
    };
  }
  return { ok: true, findings };
}

/**
 * Every subcheck in a `checks` map says `ok: true`, and says it in that shape.
 *
 * The producers compute the document's top-level `ok` as the conjunction of
 * these, so an honest report agrees with itself and this loop finds nothing. It
 * exists for the file where they disagree: `{ok: true, checks: {sandbox: {ok:
 * false}}}` is a document whose own subcheck reports a failure, and reading only
 * the summary would call it clean. `blocksSubcheck` decides which of a
 * subcheck's own findings count, so the severity asymmetry between the two
 * shapes is carried here as well as at the top level.
 */
function subchecksClean(
  checks: unknown,
  blocksSubcheck: (finding: unknown) => boolean
): { readonly clean: boolean; readonly reason: string } {
  const map = asObject(checks);
  if (map === undefined) {
    return { clean: false, reason: "its checks field is not a map of subchecks" };
  }
  for (const [name, value] of Object.entries(map)) {
    const check = asObject(value);
    if (check === undefined) {
      return { clean: false, reason: `its ${name} subcheck is not an object` };
    }
    if (check["ok"] !== true) {
      return {
        clean: false,
        reason: `its ${name} subcheck reports ok ${JSON.stringify(check["ok"])}, whatever the document's summary says`
      };
    }
    const findings = findingsField(check["findings"], `${name} subcheck's findings`);
    if (!findings.ok) return { clean: false, reason: findings.reason };
    const blocking = findings.findings.filter((finding) => blocksSubcheck(finding));
    if (blocking.length > 0) {
      return {
        clean: false,
        reason: `its ${name} subcheck reports ok true beside ${blocking.length} blocking finding${
          blocking.length === 1 ? "" : "s"
        }${describeFindings(blocking)}`
      };
    }
  }
  return { clean: true, reason: "" };
}

/**
 * Two filesystem paths naming the same tree.
 *
 * **Neither side is `path.resolve`d when it is already absolute**, and that is a
 * correctness rule rather than a shortcut. `path.resolve("/legion-ascended")` on
 * Windows yields `D:\legion-ascended` against the current drive, so resolving
 * the *report's* claim — which comes out of a JSON file somebody may have
 * written by hand — would let a POSIX-looking string alias onto this repository,
 * and resolving the *host's* root would make a report taken on a POSIX machine
 * unreadable on a Windows one for a reason having nothing to do with which tree
 * it audited. A relative host root is resolved, because that is a value this
 * process owns and can normalise honestly.
 *
 * The comparison itself is separator and case folding, which is what the two
 * case-insensitive platforms this repository is developed on actually do.
 */
function shippedRoot(repositoryRoot: string): string {
  return path.isAbsolute(repositoryRoot) ? repositoryRoot : path.resolve(repositoryRoot);
}

function sameTree(declared: string, repositoryRoot: string): boolean {
  const fold = (value: string): string => value.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return fold(declared) === fold(shippedRoot(repositoryRoot));
}

/**
 * The threat model's own rule: `ok` is `sandbox && retention && redaction`, and
 * a fail is expressed as `ok: false` plus a non-empty `findings[]`.
 *
 * All three expressions of that rule are checked rather than one. The producer
 * has no `severity` concept at all, so for an honest file they are equivalent —
 * and checking all three means a hand-edited `ok: true` sitting beside a
 * non-empty `findings` array, or beside a `checks.redaction.ok` of `false`,
 * still blocks. That last one is the case the descent exists for: `ok` is a
 * *derived* field here, and a reader that trusts a derived field over the values
 * it was derived from has stopped checking.
 */
function threatModelVerdict(document: JsonObject): { readonly clean: boolean; readonly reason: string } {
  const field = findingsField(document["findings"], "findings");
  if (!field.ok) return { clean: false, reason: field.reason };
  const findings = field.findings;
  if (document["ok"] !== true) {
    return {
      clean: false,
      reason: `its own ok is ${JSON.stringify(document["ok"])} and it records ${findings.length} finding${
        findings.length === 1 ? "" : "s"
      }${describeFindings(findings)}`
    };
  }
  if (findings.length > 0) {
    return {
      clean: false,
      reason: `its ok is true but it still records ${findings.length} finding${
        findings.length === 1 ? "" : "s"
      }${describeFindings(findings)}, which scripts/baseline/threat-model.mjs never emits together`
    };
  }
  // The threat model's subchecks carry no findings of their own — sandbox and
  // retention carry an `exit_code`, redaction only an `ok` — so every finding
  // this shape has counts, at both levels.
  const subchecks = subchecksClean(document["checks"], () => true);
  if (!subchecks.clean) return { clean: false, reason: subchecks.reason };
  return { clean: true, reason: "" };
}

/**
 * The rollback verifier's own rule, at `scripts/release/rollback-policy.mjs`:
 * `ok = blockingFindings.length === 0` where blocking means
 * `severity !== "info"`.
 *
 * The `severity` filter is the whole point of the finding count. Counting every
 * finding refuses a report whose only finding is the informational
 * `restore_target_absent`, which is what a greenfield migration produces.
 *
 * **And the verdict has to be about this repository.** `rollback-policy.mjs`
 * takes `--repository-root`, records it as `repository_root`, and raises the
 * blocking `manifest_repository_root_match` when the audited manifest's
 * `repositoryRoot` differs from it. So the document names the tree it is a
 * statement about, and a report that is green about *some other tree* says
 * nothing whatsoever about whether this change can be rolled back. Both fields
 * are required to be present, to be strings, and to name the repository being
 * shipped — positively, so a report that omits them falls out of `clean` rather
 * than into it. Without this, the committed
 * `docs/next/evidence/P13-T03/rollback-policy.json` — whose root is a macOS temp
 * directory, whose backup manifest was written in June 2026, and whose own
 * `restore_target_absent` finding says there is no `.legion` directory there —
 * satisfies `rollback_or_forward_fix_evidence` for every change in this
 * repository, precisely because the audit was run somewhere else.
 */
function rollbackPolicyVerdict(
  document: JsonObject,
  repositoryRoot: string | undefined
): { readonly clean: boolean; readonly reason: string } {
  const field = findingsField(document["findings"], "findings");
  if (!field.ok) return { clean: false, reason: field.reason };
  const blocksSubcheck = (finding: unknown): boolean => asObject(finding)?.["severity"] !== "info";
  const blocking = field.findings.filter((finding) => blocksSubcheck(finding));
  if (document["ok"] !== true || document["status"] !== "restorable") {
    return {
      clean: false,
      reason: `its own ok is ${JSON.stringify(document["ok"])} and its status is ${JSON.stringify(
        document["status"]
      )}, with ${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}${describeFindings(blocking)}`
    };
  }
  if (blocking.length > 0) {
    return {
      clean: false,
      reason: `its ok is true but it records ${blocking.length} finding${
        blocking.length === 1 ? "" : "s"
      } of severity above info${describeFindings(blocking)}`
    };
  }
  const subchecks = subchecksClean(document["checks"], blocksSubcheck);
  if (!subchecks.clean) return { clean: false, reason: subchecks.reason };

  if (repositoryRoot === undefined) {
    return {
      clean: false,
      reason:
        "the repository it was taken in could not be compared to the repository being shipped, because no repository " +
        "root reached this reader — and a rollback verdict that is green about some other filesystem tree says " +
        "nothing about this one"
    };
  }
  const declared: readonly (readonly [string, unknown])[] = [
    ["repository_root", document["repository_root"]],
    ["manifest.repositoryRoot", asObject(document["manifest"])?.["repositoryRoot"]]
  ];
  for (const [field_, value] of declared) {
    if (typeof value !== "string" || value.length === 0) {
      return {
        clean: false,
        reason: `it does not record a ${field_}, so which filesystem tree it is a verdict about is unstated`
      };
    }
    if (!sameTree(value, repositoryRoot)) {
      return {
        clean: false,
        reason:
          `its ${field_} is ${JSON.stringify(value)}, which is not the repository being shipped ` +
          `(${shippedRoot(repositoryRoot)}). scripts/release/rollback-policy.mjs raises the blocking ` +
          "manifest_repository_root_match for exactly this mismatch, so the same audit re-run here would be " +
          "ok: false — this report is green because it was taken somewhere else"
      };
    }
  }
  return { clean: true, reason: "" };
}

/**
 * The A/B comparison has no verdict field at all — `compare-runs.mjs` is an
 * aggregator that exits 0 on any readable corpus — so the predicate is over the
 * rows, and it is about the *baseline* side specifically.
 *
 * Against today's committed `ab-comparison.json` this refuses, and correctly:
 * `v8_summary.run_count` is 0 and every scenario row reads `v8_present: false`
 * with `v8_deterministic_total: null`. That file is a v9-only aggregate wearing
 * an A/B filename, and an `independent-baseline` attestation citing it would pin
 * a document positively stating that the baseline is absent.
 */
function abComparisonVerdict(document: JsonObject): { readonly clean: boolean; readonly reason: string } {
  const summary = asObject(document["v8_summary"]) ?? {};
  const runCount = summary["run_count"];
  if (typeof runCount !== "number" || runCount < 1) {
    return {
      clean: false,
      reason: `its baseline side is empty — v8_summary.run_count is ${JSON.stringify(
        runCount
      )} — so it is a single-sided aggregate rather than a comparison against a baseline`
    };
  }
  const rows = asArray(document["scenarios"]) ?? [];
  if (rows.length === 0) {
    return { clean: false, reason: "it compares no scenarios at all" };
  }
  const incomplete = rows.filter((row) => {
    const entry = asObject(row);
    if (entry === undefined) return true;
    return (
      entry["v8_present"] !== true ||
      entry["v9_present"] !== true ||
      entry["v8_score_missing"] === true ||
      entry["v9_score_missing"] === true
    );
  });
  if (incomplete.length > 0) {
    return {
      clean: false,
      reason: `${incomplete.length} of its ${rows.length} scenario rows are missing a run or a score on one side, so the comparison is not over a complete corpus`
    };
  }
  return { clean: true, reason: "" };
}

/**
 * The run score is recognised **so that it can be refused by name**, and this is
 * the sharpest shape-confusion hazard of the four.
 *
 * `grade-run.mjs` checks whether a run terminated and whether its artefacts are
 * present; it never inspects what the run produced. The proof is committed:
 * `docs/next/evidence/P13-T02/negative/tampered-run/score.json` reads
 * `critical_failure: false, total: 70, terminal_status: "dry-run"` — verdict-
 * identical to the passing run's score — over the run whose own threat model
 * reports `canary_present_after_redaction`. Its verdict field also has inverted
 * polarity (`false` is green), so a generic "read the truthy verdict field"
 * reader would pass exactly the failures.
 *
 * Left in the `unrecognised` bucket it would refuse a pass anyway. Naming it is
 * what lets the refusal say which file to cite instead.
 */
const RUN_SCORE_REFUSAL =
  "a run score records whether a run terminated and how the scaffold graded it, never what the run produced — " +
  "the tampered-run fixture in this repository scores identically to the clean one while its threat model reports " +
  "a leaked canary, so it cannot carry a pass";

function classifyDocument(
  document: JsonObject,
  enveloped: boolean,
  repositoryRoot: string | undefined
): EvidenceSourceVerdict {
  if (isThreatModel(document)) {
    const verdict = threatModelVerdict(document);
    return verdict.clean
      ? { kind: "clean", shape: "threat-model", enveloped }
      : { kind: "blocking", shape: "threat-model", enveloped, reason: verdict.reason };
  }
  if (isRollbackPolicy(document)) {
    const verdict = rollbackPolicyVerdict(document, repositoryRoot);
    return verdict.clean
      ? { kind: "clean", shape: "rollback-policy", enveloped }
      : { kind: "blocking", shape: "rollback-policy", enveloped, reason: verdict.reason };
  }
  if (isAbComparison(document)) {
    const verdict = abComparisonVerdict(document);
    return verdict.clean
      ? { kind: "clean", shape: "ab-comparison", enveloped }
      : { kind: "blocking", shape: "ab-comparison", enveloped, reason: verdict.reason };
  }
  if (isRunScore(document)) {
    return { kind: "blocking", shape: "run-score", enveloped, reason: RUN_SCORE_REFUSAL };
  }
  return { kind: "unrecognised" };
}

/**
 * Classify the bytes of one cited source.
 *
 * **The envelope is unwrapped exactly once, and never fallen back to.** The same
 * command produces two different documents: `legion dev evals threat-model
 * --json` yields the CLI envelope `{ok, status, verdict: <raw report>}`, while
 * `--report <path>` yields the raw payload. Both are plausible `--source`
 * arguments. Reading the envelope's top-level `ok` while never descending into
 * `.verdict.findings` is a fail-open that `release-checklist.mjs` already works
 * around by hand; here the inner document is what is classified, and if the
 * inner document is unrecognised then so is the whole thing.
 *
 * A shape this module does not know **refuses a pass** rather than falling
 * through to one. Positive checks, never negative: an unrecognised shape is not
 * a shape that passed.
 *
 * `context.repositoryRoot` is the tree being shipped. It is a required parameter
 * rather than an option with a default, because the one shape that reads it —
 * the rollback verdict — is worthless without it, and it is read defensively at
 * runtime so that a caller that reaches this from untyped code and passes
 * nothing gets `blocking` rather than a green verdict about somebody else's
 * filesystem. Omission fails closed in both directions.
 */
export function classifyEvidenceSource(
  bytes: string | undefined,
  context: { readonly repositoryRoot: string }
): EvidenceSourceVerdict {
  const repositoryRoot =
    typeof (context as { readonly repositoryRoot?: unknown } | undefined)?.repositoryRoot === "string"
      ? context.repositoryRoot
      : undefined;
  if (bytes === undefined) {
    return { kind: "unread", reason: "its bytes were not collected by this report" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (error) {
    return {
      kind: "unread",
      reason: `it is not JSON (${error instanceof Error ? error.message : String(error)})`
    };
  }
  const document = asObject(parsed);
  if (document === undefined) {
    return { kind: "unrecognised" };
  }

  const inner = asObject(document["verdict"]);
  if (inner !== undefined && typeof document["ok"] === "boolean") {
    return classifyDocument(inner, true, repositoryRoot);
  }
  return classifyDocument(document, false, repositoryRoot);
}

/** The producing command a refusal names, so the coupling is discoverable. */
export const EVIDENCE_SOURCE_PRODUCERS: Readonly<Record<EvidenceSourceShape, string>> = {
  "threat-model": "legion dev evals threat-model --report <path> (scripts/baseline/threat-model.mjs)",
  "rollback-policy":
    "legion dev release rollback-verify --backup-manifest <path> --report <path> " +
    "(scripts/release/rollback-policy.mjs), run in this repository — the verdict records the tree it audited and is " +
    "read here against the tree being shipped",
  "ab-comparison": "scripts/baseline/compare-runs.mjs",
  "run-score": "scripts/baseline/grade-run.mjs"
};

/** The sentence a refusal uses for a shape nobody recognises. */
export const UNRECOGNISED_SOURCE_HINT =
  "Legion recognises the threat-model report (scripts/baseline/threat-model.mjs), the rollback-policy report " +
  "(scripts/release/rollback-policy.mjs) and the A/B comparison (scripts/baseline/compare-runs.mjs). Recognition " +
  "is by document structure, never by filename or directory: none of these reports carries a field naming its own " +
  "type, and recognising them by path is the inference an attestation exists to replace.";
