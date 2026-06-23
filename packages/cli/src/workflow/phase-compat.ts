import { readFile } from "node:fs/promises";
import path from "node:path";

import { stringOption, type CliContext } from "../runtime.js";

export interface PhaseSource {
  readonly number: number;
  readonly name: string;
  readonly body: string;
  readonly sourcePath: string;
}

export interface PhaseSourceMissingDiagnostic {
  readonly code: "phase_source_missing";
  readonly message: string;
}

export type ResolvePhaseSourceResult =
  | { readonly ok: true; readonly phase: PhaseSource }
  | { readonly ok: false; readonly diagnostic: PhaseSourceMissingDiagnostic };

export async function resolvePhaseSource(
  context: CliContext,
  phaseNumber: number
): Promise<ResolvePhaseSourceResult> {
  for (const sourcePath of roadmapCandidates(context)) {
    const text = await readOptionalRoadmap(sourcePath);
    if (text === undefined) continue;

    const phase = parseRoadmapPhase(text, phaseNumber, sourcePath);
    if (phase !== undefined) {
      return { ok: true, phase };
    }
  }

  return {
    ok: false,
    diagnostic: {
      code: "phase_source_missing",
      message: `No phase ${phaseNumber} source was found. Run legion explore or pass --from-roadmap <path>.`
    }
  };
}

export function parseRoadmapPhase(
  text: string,
  phaseNumber: number,
  sourcePath: string
): PhaseSource | undefined {
  const normalized = text.replace(/\r\n?/g, "\n");
  const headingPattern = new RegExp(`^##\\s+Phase\\s+${phaseNumber}\\s*:\\s*(.+?)\\s*$`, "im");
  const match = headingPattern.exec(normalized);
  const phaseName = match?.[1];
  if (match === null || phaseName === undefined) return undefined;

  const headingEnd = match.index + match[0].length;
  const nextHeadingPattern = /^##\s+/gm;
  nextHeadingPattern.lastIndex = headingEnd;
  const nextHeading = nextHeadingPattern.exec(normalized);
  const bodyStart = normalized[headingEnd] === "\n" ? headingEnd + 1 : headingEnd;
  const bodyEnd = nextHeading?.index ?? normalized.length;

  return {
    number: phaseNumber,
    name: phaseName.trim(),
    body: normalized.slice(bodyStart, bodyEnd).trim(),
    sourcePath
  };
}

function roadmapCandidates(context: CliContext): readonly string[] {
  const fromRoadmap = stringOption(context, "from-roadmap");
  const candidates = [
    fromRoadmap === undefined ? undefined : resolveRoadmapPath(context.repositoryRoot, fromRoadmap),
    path.join(context.repositoryRoot, ".planning", "ROADMAP.md"),
    path.join(context.repositoryRoot, "ROADMAP.md")
  ];
  return candidates.filter((candidate): candidate is string => candidate !== undefined);
}

function resolveRoadmapPath(repositoryRoot: string, roadmapPath: string): string {
  return path.isAbsolute(roadmapPath) ? roadmapPath : path.resolve(repositoryRoot, roadmapPath);
}

async function readOptionalRoadmap(sourcePath: string): Promise<string | undefined> {
  try {
    return await readFile(sourcePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
