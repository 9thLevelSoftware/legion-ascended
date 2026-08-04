/**
 * Milestone phase ranges.
 *
 * `legion milestone --define MVP --phases 1-3` stored `"1-3"` verbatim and
 * nothing ever parsed it. The consequence was not cosmetic: with no
 * milestone-to-phase path, `milestone --status` could not report progress,
 * `--complete` could not gate on whether the phases were done, and `retro
 * --milestone` had no set of changes to gather evidence from. All three were
 * recorded as open gaps against the same missing parser.
 *
 * The grammar is the one the help text already advertises, plus the comma form
 * a caller would reasonably try: `1-3`, `1,2,5`, `1-3,7`, `4`.
 */

export interface PhaseRangeSuccess {
  readonly ok: true;
  readonly phases: readonly number[];
}

export interface PhaseRangeFailure {
  readonly ok: false;
  readonly reason: string;
}

export type PhaseRangeResult = PhaseRangeSuccess | PhaseRangeFailure;

// A roadmap with more phases than this is not a roadmap. The bound is well
// below Number.MAX_SAFE_INTEGER so no arithmetic below can lose precision.
const MAX_PHASE = 10_000;

const EXAMPLE = 'Use a range or list of phase numbers, such as "1-3", "1,2,5" or "1-3,7".';

/**
 * Phases are returned sorted and deduplicated, so `3,1,1-2` and `1-3` describe
 * the same milestone. A caller comparing two milestones' coverage compares
 * sets, not the strings someone happened to type.
 */
export function parsePhaseRange(value: string): PhaseRangeResult {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, reason: `A phase range cannot be empty. ${EXAMPLE}` };

  const phases = new Set<number>();
  for (const rawPart of trimmed.split(",")) {
    const part = rawPart.trim();
    if (part.length === 0) {
      return { ok: false, reason: `"${trimmed}" has an empty entry. ${EXAMPLE}` };
    }
    const bounds = part.split("-");
    if (bounds.length > 2) {
      return { ok: false, reason: `"${part}" is not a phase or a range. ${EXAMPLE}` };
    }
    const parsed: number[] = [];
    for (const bound of bounds) {
      const text = bound.trim();
      // The whole value, not a parseInt prefix: "1.5" and "1foo" both parse to
      // 1, which would silently define a milestone over a phase the caller did
      // not name.
      if (!/^[1-9]\d*$/.test(text)) {
        return { ok: false, reason: `"${text}" is not a phase number. ${EXAMPLE}` };
      }
      const value = Number.parseInt(text, 10);
      // Past 2^53 an integer no longer has a distinct successor, so `phase += 1`
      // leaves the loop below at the same value forever and the CLI hangs.
      // Longer digit strings parse to Infinity and do the same. The digit regex
      // above accepts both, so the ceiling has to be checked here.
      if (!Number.isSafeInteger(value) || value > MAX_PHASE) {
        return { ok: false, reason: `"${text}" is larger than any real phase number. ${EXAMPLE}` };
      }
      parsed.push(value);
    }
    const [start, end = start] = parsed as [number, number?];
    if (end < start) {
      return { ok: false, reason: `"${part}" runs backwards. ${EXAMPLE}` };
    }
    // A milestone spanning hundreds of phases is a typo, not a plan, and
    // expanding it would put an unbounded list into a committed artifact.
    if (end - start > 512) {
      return { ok: false, reason: `"${part}" spans more than 512 phases. ${EXAMPLE}` };
    }
    for (let phase = start; phase <= end; phase += 1) phases.add(phase);
  }

  return { ok: true, phases: [...phases].sort((left, right) => left - right) };
}
