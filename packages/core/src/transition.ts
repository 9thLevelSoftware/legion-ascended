import type { EventAggregateReference, EventType } from "@legion/protocol";

export type TransitionRejectionCode =
  | "unexpected_generation"
  | "stale_generation"
  | "illegal_transition"
  | "terminal_state"
  | "missing_evidence"
  | "missing_review"
  | "aggregate_mismatch"
  | "unsupported_command"
  | "unsupported_event"
  | "missing_command_context"
  | "invalid_command_payload";

export interface TransitionRejectionCatalogEntry {
  readonly message: string;
  readonly retryable: boolean;
}

export const TRANSITION_REJECTION_CATALOG: Record<TransitionRejectionCode, TransitionRejectionCatalogEntry> = {
  unexpected_generation: {
    message: "The command expected a different aggregate generation.",
    retryable: true
  },
  stale_generation: {
    message: "The event is older than the aggregate generation and was ignored.",
    retryable: false
  },
  illegal_transition: {
    message: "The requested transition is not legal from the current state.",
    retryable: false
  },
  terminal_state: {
    message: "The aggregate is terminal for the current generation.",
    retryable: false
  },
  missing_evidence: {
    message: "Completion requires at least one evidence reference.",
    retryable: true
  },
  missing_review: {
    message: "Completion requires a passed review reference.",
    retryable: true
  },
  aggregate_mismatch: {
    message: "The command or event targets a different aggregate.",
    retryable: false
  },
  unsupported_command: {
    message: "The command is not supported by this state machine.",
    retryable: false
  },
  unsupported_event: {
    message: "The event is not supported by this state machine.",
    retryable: false
  },
  missing_command_context: {
    message: "The pure decision function needs caller-provided deterministic context.",
    retryable: true
  },
  invalid_command_payload: {
    message: "The command payload is missing a required transition field.",
    retryable: false
  }
};

export interface TransitionRejection {
  readonly code: TransitionRejectionCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface EventDraft<Payload extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  readonly type: EventType;
  readonly aggregate: EventAggregateReference;
  readonly generation: number;
  readonly payload: Payload;
}

export interface AcceptedTransition {
  readonly accepted: true;
  readonly events: readonly EventDraft[];
}

export interface RejectedTransition {
  readonly accepted: false;
  readonly rejection: TransitionRejection;
  readonly events: readonly [];
}

export type TransitionDecision = AcceptedTransition | RejectedTransition;

export interface VersionedMachineState {
  readonly generation: number;
}

export interface ExpectedGenerationInput {
  readonly expectedGeneration: number;
}

export function acceptTransition(events: readonly EventDraft[]): AcceptedTransition {
  return {
    accepted: true,
    events
  };
}

export function rejectTransition(code: TransitionRejectionCode, message?: string): RejectedTransition {
  const catalogEntry = TRANSITION_REJECTION_CATALOG[code];

  return {
    accepted: false,
    rejection: {
      code,
      message: message ?? catalogEntry.message,
      retryable: catalogEntry.retryable
    },
    events: []
  };
}

export function rejectIfGenerationMismatch(
  state: VersionedMachineState,
  input: ExpectedGenerationInput
): RejectedTransition | undefined {
  if (state.generation === input.expectedGeneration) return undefined;

  return rejectTransition(
    "unexpected_generation",
    `Expected generation ${input.expectedGeneration} but current generation is ${state.generation}.`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortStable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortStable(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [key, entryValue] of entries) {
    sorted[key] = sortStable(entryValue);
  }
  return sorted;
}

export function stableStateStringify(value: unknown): string {
  const serialized = JSON.stringify(sortStable(value));
  if (typeof serialized !== "string") {
    throw new TypeError("stableStateStringify requires a JSON-serializable value.");
  }
  return serialized;
}
