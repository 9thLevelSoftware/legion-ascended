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
  /**
   * How many attempts each task needed, keyed by task id.
   *
   * Gathered on the same walk as the blocked runs rather than by a second pass:
   * `listTaskRunsForChange` is already read here, and a task's attempt count is
   * the same record's `attempt` field. A retrospective asking "did this phase
   * go smoothly" needs the retries as much as the refusals — three tasks that
   * each passed on their fourth attempt is a different phase from three that
   * passed first time, and escalations alone cannot tell them apart.
   */
  readonly attemptsByTask: Readonly<Record<string, number>>;
  /** Findings a reviewer wrote, with their bodies rather than only a count. */
  readonly reviewFindings: readonly ReviewFindingRecord[];
}

export interface ReviewFindingRecord {
  readonly reviewId: string;
  readonly taskId?: string;
  readonly title: string;
  readonly body: string;
  readonly severity: string;
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
  const attemptsByTask: Record<string, number> = {};
  if (runs.ok) {
    for (const run of runs.taskRuns) {
      // Every run, not only the blocked ones: the highest attempt a task reached
      // is what says how many cycles it took.
      const taskId = run.document.taskId;
      if (typeof taskId === "string") {
        attemptsByTask[taskId] = Math.max(attemptsByTask[taskId] ?? 0, run.document.attempt);
      }
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
  const reviewFindings: ReviewFindingRecord[] = [];
  if (reviews.ok) {
    for (const review of reviews.reviews) {
      for (const finding of review.document.findings) {
        // Recorded at every severity. A blocking finding is an escalation; a
        // major one is a reviewer saying something is wrong and passing anyway,
        // which is exactly what a retrospective is for and what a count of
        // escalations cannot show.
        reviewFindings.push({
          reviewId: review.document.id,
          ...(review.document.taskId === undefined ? {} : { taskId: review.document.taskId }),
          title: finding.title,
          body: finding.body,
          severity: finding.severity
        });
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
    escalations,
    attemptsByTask,
    reviewFindings
  };
}
