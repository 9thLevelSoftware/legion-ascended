import { listReviewDecisionsForChange, listTaskRunsForChange } from "@legion/artifacts";

/**
 * Work that stopped and needed a human, counted from committed records.
 *
 * `escalated` exists in the repository only inside `packages/board/**`, an
 * event-sourced projection no workflow command writes to. The obvious fix — emit
 * board events from build, review and ship — puts the answer in
 * `.legion/var/board.sqlite`, which is operational state that `.gitignore`
 * excludes and `validateProject` actively requires be excluded. A retrospective
 * reading escalations from there would report zero on a fresh checkout, on CI,
 * and for anyone but the machine that ran the build.
 *
 * So escalations are derived from what is committed: a task run that ended
 * `blocked` carries the reason it stopped, and a review finding marked
 * `blocking` is a reviewer refusing to pass work. Both survive a clone, which is
 * the property a retrospective needs and the board cannot offer.
 *
 * The board remains the right home for the live operational view. This is not
 * that.
 */

export interface Escalation {
  readonly kind: "task_blocked" | "review_blocking_finding";
  readonly id: string;
  /** Why it stopped: a task-run error code, or a finding title. */
  readonly reason: string;
  readonly at: string;
}

export interface EscalationSummary {
  readonly total: number;
  readonly byKind: Readonly<Record<Escalation["kind"], number>>;
  readonly escalations: readonly Escalation[];
}

export async function collectEscalations(input: {
  readonly repositoryRoot: string;
  readonly changeId: string;
}): Promise<EscalationSummary> {
  const escalations: Escalation[] = [];

  const runs = await listTaskRunsForChange({
    repositoryRoot: input.repositoryRoot,
    changeId: input.changeId
  });
  if (runs.ok) {
    for (const run of runs.taskRuns) {
      if (run.document.status !== "blocked") continue;
      escalations.push({
        kind: "task_blocked",
        id: run.document.id,
        // The error code names what stopped it — diff reconciliation, a failed
        // verification, an executor refusal — which is the distinction that
        // makes a count of these worth reading.
        reason: run.document.error?.code ?? "blocked",
        at: run.document.createdAt
      });
    }
  }

  const reviews = await listReviewDecisionsForChange({
    repositoryRoot: input.repositoryRoot,
    changeId: input.changeId
  });
  if (reviews.ok) {
    for (const review of reviews.reviews) {
      for (const finding of review.document.findings) {
        if (finding.severity !== "blocking") continue;
        escalations.push({
          kind: "review_blocking_finding",
          id: `${review.document.id}:${finding.id}`,
          reason: finding.title,
          at: review.document.createdAt
        });
      }
    }
  }

  escalations.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
  return {
    total: escalations.length,
    byKind: {
      task_blocked: escalations.filter((entry) => entry.kind === "task_blocked").length,
      review_blocking_finding: escalations.filter((entry) => entry.kind === "review_blocking_finding").length
    },
    escalations
  };
}
