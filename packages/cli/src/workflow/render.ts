export interface NextAction {
  readonly command: string;
  readonly reason: string;
}

export function nextAction(command: string, reason: string): NextAction {
  return { command, reason };
}

export function renderNextAction(action: NextAction): string {
  return `Next: ${action.command}\nReason: ${action.reason}`;
}

export function renderDiagnostics(diagnostics: readonly unknown[]): string {
  if (diagnostics.length === 0) return "";
  return diagnostics.map((diagnostic) => {
    if (diagnostic && typeof diagnostic === "object" && "message" in diagnostic) {
      return `- ${String((diagnostic as { message: unknown }).message)}`;
    }
    return `- ${String(diagnostic)}`;
  }).join("\n");
}
