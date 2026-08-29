import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  assessmentEffortSchema,
  assessmentIdSchema,
  type ArtifactPath,
  type BrownfieldAssessment
} from "@legion/protocol";

import {
  failure,
  hasFlag,
  helpResult,
  stringOption,
  success,
  usageError,
  type CliContext,
  type CliResult
} from "../../runtime.js";
import {
  createBrownfieldAssessment,
  readBrownfieldAssessment,
  updateBrownfieldAssessmentState
} from "../../workflow/brownfield-assessment.js";
import { collectBrownfieldSignals, type BrownfieldSignals } from "../../workflow/brownfield-signals.js";
import {
  runBrownfieldSpecialists,
  type BrownfieldSpecialistsResult
} from "../../workflow/brownfield-specialists.js";
import { synthesizeBrownfieldDesign, type BrownfieldDesign } from "../../workflow/brownfield-synthesis.js";
import { discoverLatestStructuralCodeIndex } from "../../workflow/codebase-map.js";
import { nextAction, renderNextAction } from "../../workflow/render.js";

const REFRESH_ACTION = "legion map --refresh --profile structural";

const ASSESS_HELP = `legion assess [--effort 1|2|3|4|5] [--scope <path>] [--resume <assessment-id>]

Run a read-only brownfield assessment from a fresh structural code index. The
assessment bundle is written under .legion/project/assessment/<assessment-id>;
source files, manifests, and runtime configuration are never modified.

--effort <1|2|3|4|5>  Scale the specialist roster. Defaults to 1.
--scope <path>       Assess the scope covered by the structural map.
--resume <id>        Continue an existing assessment from its persisted phase.
                      The assessment id is required.

If no fresh structural map exists, run:
  legion map --refresh --profile structural

Examples:
  legion assess
  legion assess --effort 3 --scope src
  legion assess --resume assess_0123456789abcdef01234567 --json`;

const ASSESS_REVIEW_NEXT_ACTION = nextAction(
  "legion status",
  "Review the evidence-bound assessment bundle before planning source changes."
);

type AssessmentBundlePaths = {
  readonly root: ArtifactPath;
  readonly state: ArtifactPath;
  readonly signals: ArtifactPath;
  readonly assumptions: ArtifactPath;
  readonly findings: ArtifactPath;
  readonly synthesis: ArtifactPath;
  readonly review: ArtifactPath;
};

export async function handleAssessWorkflow(context: CliContext): Promise<CliResult> {
  if (hasFlag(context, "help") || context.args.positionals[0] === "help") {
    return helpResult(ASSESS_HELP);
  }
  if (context.args.positionals.length > 0) {
    return usageError("legion assess does not take positional arguments. Use --scope <path> to narrow the assessment.");
  }

  const effort = parseEffort(context);
  if (typeof effort !== "number") return effort;
  const scope = parseOptionalValue(context, "scope");
  if (isCliResultValue(scope)) return scope;
  const resume = parseResume(context);
  if (isCliResultValue(resume)) return resume;

  let discovery;
  try {
    discovery = await discoverLatestStructuralCodeIndex(context.repositoryRoot);
  } catch (error) {
    return blockedAssessment(`Unable to discover a structural code index: ${errorMessage(error)}.`);
  }
  if (discovery.record === undefined) {
    return blockedAssessment(
      "No usable structural code index exists. Run legion map --refresh --profile structural first.",
      discovery.diagnostics
    );
  }

  try {
    let assessmentId: string;
    let paths: AssessmentBundlePaths;
    let loaded: { readonly state: BrownfieldAssessment; readonly paths: AssessmentBundlePaths };

    if (resume !== undefined) {
      loaded = await readBrownfieldAssessment({
        repositoryRoot: context.repositoryRoot,
        assessmentId: resume
      });
      if (scope !== undefined && scope !== loaded.state.scope) {
        return usageError(
          `--scope ${JSON.stringify(scope)} does not match the resumed assessment scope ${JSON.stringify(loaded.state.scope)}.`
        );
      }
      assessmentId = resume;
      paths = loaded.paths;
    } else {
      const created = await createBrownfieldAssessment({
        repositoryRoot: context.repositoryRoot,
        effort,
        snapshot: discovery.record,
        ...(scope === undefined ? {} : { scope })
      });
      assessmentId = created.assessmentId;
      paths = created.paths;
      loaded = await readBrownfieldAssessment({
        repositoryRoot: context.repositoryRoot,
        assessmentId
      });
    }

    let state = loaded.state;
    if (resume !== undefined && discovery.record.snapshot.snapshotId !== loaded.state.snapshotId) {
      return usageError(
        `Resumed assessment was bound to snapshot ${loaded.state.snapshotId}, but the current structural map is ${discovery.record.snapshot.snapshotId}. Run "legion assess" (without --resume) to start a fresh assessment, or restore the previous map.`
      );
    }
    if (resume !== undefined && context.args.options.has("effort") && effort !== loaded.state.effort) {
      return usageError(
        `--effort ${effort} does not match the resumed assessment effort ${loaded.state.effort}.`
      );
    }
    if (state.phase === "blocked") {
      return failure(
        {
          ok: false,
          status: "blocked",
          workflow: "assess",
          assessmentId,
          bundlePaths: paths,
          diagnostics: [{ code: "assessment_blocked", message: "The persisted assessment is in terminal blocked state." }],
          nextAction: nextAction(REFRESH_ACTION, "Start a new assessment after refreshing the structural map.")
        },
        ["Brownfield assessment is blocked.", `Assessment: ${assessmentId}`, renderNextAction(nextAction(REFRESH_ACTION, "Start a new assessment after refreshing the structural map."))].join("\n")
      );
    }
    if (state.phase === "complete") {
      return completedAssessment(
        assessmentId,
        paths,
        state,
        undefined,
        await readCompletedDesign(context.repositoryRoot, paths.synthesis)
      );
    }

    let signals: BrownfieldSignals | undefined;
    let specialists: BrownfieldSpecialistsResult | undefined;
    let design: BrownfieldDesign | undefined;

    if (state.phase === "setup") {
      signals = await collectBrownfieldSignals({
        repositoryRoot: context.repositoryRoot,
        snapshot: discovery.record.snapshot,
        sqlitePath: discovery.record.semanticSqliteArtifactPath
      });
      await updateBrownfieldAssessmentState({
        repositoryRoot: context.repositoryRoot,
        assessmentId,
        phase: "signals_complete",
        signals
      });
      loaded = await readBrownfieldAssessment({ repositoryRoot: context.repositoryRoot, assessmentId });
      state = loaded.state;
    }

    if (signals === undefined) {
      signals = await readAssessmentArtifact<BrownfieldSignals>(context.repositoryRoot, paths.signals);
    }

    if (state.phase === "signals") {
      specialists = await runBrownfieldSpecialists({
        repositoryRoot: context.repositoryRoot,
        assessmentId,
        snapshot: discovery.record.snapshot,
        signals,
        effort: state.effort
      });
      await updateBrownfieldAssessmentState({
        repositoryRoot: context.repositoryRoot,
        assessmentId,
        phase: "specialists_complete",
        findings: specialists.findings,
        assumptions: specialists.assumptions,
        review: specialistStatusArtifact(specialists)
      });
      loaded = await readBrownfieldAssessment({ repositoryRoot: context.repositoryRoot, assessmentId });
      state = loaded.state;
    }

    if (state.phase === "specialists" || state.phase === "assumptions") {
      if (specialists === undefined) {
        const findings = await readAssessmentArtifact<BrownfieldSpecialistsResult["findings"]>(context.repositoryRoot, paths.findings);
        const assumptions = await readAssessmentArtifact<BrownfieldSpecialistsResult["assumptions"]>(context.repositoryRoot, paths.assumptions);
        const specialistStatus = await readAssessmentArtifact<unknown>(context.repositoryRoot, paths.review);
        specialists = persistedSpecialists(findings, assumptions, specialistStatus);
      }
      design = synthesizeBrownfieldDesign({ signals, specialists });
      await updateBrownfieldAssessmentState({
        repositoryRoot: context.repositoryRoot,
        assessmentId,
        phase: "synthesis_complete",
        findings: design.prioritizedFindings,
        assumptions: design.assumptionsRequiringInput,
        synthesis: design
      });
      loaded = await readBrownfieldAssessment({ repositoryRoot: context.repositoryRoot, assessmentId });
      state = loaded.state;
    }

    if (state.phase === "synthesis" || state.phase === "review") {
      if (design === undefined) design = await readAssessmentArtifact<BrownfieldDesign>(context.repositoryRoot, paths.synthesis);
      const review = {
        schemaVersion: 1,
        kind: "brownfield_assessment_review",
        assessmentId,
        status: "complete",
        findingCount: design.prioritizedFindings.length,
        assumptionCount: design.assumptionsRequiringInput.length,
        behavioralProofGaps: design.behavioralProofGaps,
        openQuestions: design.openQuestions
      };
      await updateBrownfieldAssessmentState({
        repositoryRoot: context.repositoryRoot,
        assessmentId,
        phase: "review_complete",
        review
      });
      loaded = await readBrownfieldAssessment({ repositoryRoot: context.repositoryRoot, assessmentId });
      state = loaded.state;
    }

    if (state.phase !== "complete") {
      throw new Error(`Brownfield assessment stopped before completion at phase ${state.phase}.`);
    }
    return completedAssessment(assessmentId, paths, state, specialists, design);
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes(REFRESH_ACTION) || /fresh structural|structural snapshot|code index/iu.test(message)) {
      return blockedAssessment(`Brownfield assessment is blocked: ${message}`);
    }
    return usageError(`Unable to run brownfield assessment: ${message}`);
  }
}

function parseEffort(context: CliContext): number | CliResult {
  const raw = stringOption(context, "effort");
  if (context.args.options.get("effort") === true || raw === "") {
    return usageError("Missing required value for --effort. Use one of 1, 2, 3, 4, or 5.");
  }
  if (raw === undefined) return 1;
  if (!/^[1-5]$/u.test(raw)) {
    return usageError(`Invalid --effort value ${JSON.stringify(raw)}. Use one of 1, 2, 3, 4, or 5.`);
  }
  return assessmentEffortSchema.parse(Number(raw));
}

function parseOptionalValue(context: CliContext, key: string): string | undefined | CliResult {
  const raw = stringOption(context, key);
  if (context.args.options.get(key) === true || raw === "") return usageError(`Missing required value for --${key}.`);
  return raw;
}

function parseResume(context: CliContext): string | undefined | CliResult {
  const raw = stringOption(context, "resume");
  if (context.args.options.get("resume") === true || raw === "") {
    return usageError("Missing required value for --resume. Use --resume <assessment-id>.");
  }
  if (raw === undefined) return undefined;
  const parsed = assessmentIdSchema.safeParse(raw);
  if (!parsed.success) return usageError(`Invalid assessment id ${JSON.stringify(raw)} for --resume.`);
  return parsed.data;
}

const SPECIALIST_STATUS_KIND = "brownfield_specialist_status";

function specialistStatusArtifact(specialists: BrownfieldSpecialistsResult): unknown {
  return {
    kind: SPECIALIST_STATUS_KIND,
    ok: specialists.ok,
    roster: specialists.roster,
    executionRecords: specialists.executionRecords,
    diagnostics: specialists.diagnostics
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function persistedSpecialists(
  findings: BrownfieldSpecialistsResult["findings"],
  assumptions: BrownfieldSpecialistsResult["assumptions"],
  status: unknown
): BrownfieldSpecialistsResult {
  if (isRecord(status) && status["kind"] === SPECIALIST_STATUS_KIND) {
    const roster = status["roster"];
    const executionRecords = status["executionRecords"];
    const diagnostics = status["diagnostics"];
    return {
      ok: status["ok"] === true,
      roster: Array.isArray(roster) ? roster as BrownfieldSpecialistsResult["roster"] : [],
      packs: [],
      findings,
      assumptions,
      executionRecords: Array.isArray(executionRecords)
        ? executionRecords as BrownfieldSpecialistsResult["executionRecords"]
        : [],
      diagnostics: Array.isArray(diagnostics)
        ? diagnostics.filter((entry): entry is string => typeof entry === "string")
        : []
    };
  }
  return {
    ok: true,
    roster: [],
    packs: [],
    findings,
    assumptions,
    executionRecords: [],
    diagnostics: []
  };
}

async function readCompletedDesign(
  repositoryRoot: string,
  synthesisPath: ArtifactPath
): Promise<BrownfieldDesign | undefined> {
  try {
    const design = await readAssessmentArtifact<BrownfieldDesign>(repositoryRoot, synthesisPath);
    if (!isRecord(design) || !Array.isArray(design["prioritizedFindings"]) || !Array.isArray(design["assumptionsRequiringInput"])) {
      return undefined;
    }
    return design;
  } catch {
    return undefined;
  }
}

async function readAssessmentArtifact<T>(repositoryRoot: string, artifactPath: ArtifactPath): Promise<T> {
  const absolutePath = path.join(repositoryRoot, ...artifactPath.split("/"));
  return JSON.parse(await readFile(absolutePath, "utf8")) as T;
}

function bundlePaths(paths: AssessmentBundlePaths): Record<string, ArtifactPath> {
  return {
    root: paths.root,
    state: paths.state,
    signals: paths.signals,
    assumptions: paths.assumptions,
    findings: paths.findings,
    synthesis: paths.synthesis,
    review: paths.review
  };
}

function completedAssessment(
  assessmentId: string,
  paths: AssessmentBundlePaths,
  state: BrownfieldAssessment,
  specialists: BrownfieldSpecialistsResult | undefined,
  design: BrownfieldDesign | undefined
): CliResult {
  const serializedPaths = bundlePaths(paths);
  const payload = {
    ok: true,
    status: "completed",
    workflow: "assess",
    assessmentId,
    paths: serializedPaths,
    bundlePaths: serializedPaths,
    phase: state.phase,
    scope: state.scope,
    effort: state.effort,
    snapshotId: state.snapshotId,
    sourceFingerprint: state.sourceFingerprint,
    ...(design === undefined ? {} : {
      findingCount: design.prioritizedFindings.length,
      assumptionCount: design.assumptionsRequiringInput.length,
      behavioralProofGapCount: design.behavioralProofGaps.length
    }),
    ...(specialists === undefined ? {} : {
      specialistsOk: specialists.ok,
      specialistDiagnostics: specialists.diagnostics
    }),
    nextAction: ASSESS_REVIEW_NEXT_ACTION,
    diagnostics: specialists?.diagnostics ?? []
  };
  return success(
    payload,
    [
      `Brownfield assessment complete: ${assessmentId}.`,
      `Bundle: ${paths.root}`,
      ...(design === undefined ? [] : [`Findings: ${design.prioritizedFindings.length}; assumptions requiring input: ${design.assumptionsRequiringInput.length}.`]),
      renderNextAction(ASSESS_REVIEW_NEXT_ACTION)
    ].join("\n")
  );
}

function blockedAssessment(message: string, diagnostics: readonly unknown[] = []): CliResult {
  const action = nextAction(REFRESH_ACTION, "A fresh structural map is required before a brownfield assessment can run.");
  const allDiagnostics = [
    ...diagnostics,
    { code: "assessment_structural_required", message }
  ];
  return failure(
    {
      ok: false,
      status: "blocked",
      workflow: "assess",
      diagnostics: allDiagnostics,
      nextAction: action
    },
    ["Brownfield assessment is blocked.", message, renderNextAction(action)].join("\n")
  );
}

function isCliResultValue(value: unknown): value is CliResult {
  return typeof value === "object" && value !== null && "exitCode" in value && "payload" in value && "human" in value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
