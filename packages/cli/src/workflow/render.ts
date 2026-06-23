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
      const entry = diagnostic as {
        readonly code?: unknown;
        readonly message: unknown;
        readonly path?: unknown;
        readonly source?: { readonly path?: unknown };
      };
      const code = typeof entry.code === "string" && entry.code.length > 0 ? `[${entry.code}] ` : "";
      const diagnosticPath = typeof entry.path === "string"
        ? entry.path
        : typeof entry.source?.path === "string"
          ? entry.source.path
          : undefined;
      const pathSuffix = diagnosticPath === undefined ? "" : ` (${diagnosticPath})`;
      return `- ${code}${String(entry.message)}${pathSuffix}`;
    }
    return `- ${String(diagnostic)}`;
  }).join("\n");
}
