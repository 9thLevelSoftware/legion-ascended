# P01-T07 Transition Coverage

## Source under test

- `packages/core/src/state-machines/index.ts`
- `packages/core/src/transition.ts`
- `packages/core/test/state-machines.test.mjs`

## Coverage map

| Aggregate | State catalog | Matrix export | Reducer | Command decision |
| --- | --- | --- | --- | --- |
| Change | `CHANGE_LIFECYCLE_STATES` | `CHANGE_TRANSITION_MATRIX` | `reduceChangeState` | Future change-specific task |
| Task | `TASK_LIFECYCLE_STATES` | `TASK_TRANSITION_MATRIX` | `reduceTaskState`, `reduceTaskEvents` | `decideTaskCommand` |
| TaskRun | `TASK_RUN_LIFECYCLE_STATES` | `TASK_RUN_TRANSITION_MATRIX` | `reduceTaskRunState` | Future run-specific task |
| Review | `REVIEW_LIFECYCLE_STATES` | `REVIEW_TRANSITION_MATRIX` | `reduceReviewState` | Future review-specific task |
| Approval | `APPROVAL_LIFECYCLE_STATES` | `APPROVAL_TRANSITION_MATRIX` | `reduceApprovalState` | Future approval-specific task |
| Integration | `INTEGRATION_LIFECYCLE_STATES` | `INTEGRATION_TRANSITION_MATRIX` | `reduceIntegrationState` | Future integration-specific task |
| Release | `RELEASE_LIFECYCLE_STATES` | `RELEASE_TRANSITION_MATRIX` | `reduceReleaseState` | Future release-specific task |
| Observation | `OBSERVATION_LIFECYCLE_STATES` | `OBSERVATION_TRANSITION_MATRIX` | `reduceObservationState` | Future observation-specific task |

## Executable checks

- `P01-T07 lifecycle state catalogs include explicit control and terminal states`
- `P01-T07 transition matrices are exported for every aggregate`
- `P01-T07 legal transition table moves each aggregate through its protocol facts`
- `P01-T07 illegal transitions preserve state and emit no synthetic facts`
- `P01-T07 task completion command requires expected generation, evidence, and passed review`
- `P01-T07 task replay is deterministic and equivalent from genesis`
- `P01-T07 terminal tasks do not resume without a higher-generation retry event`

Raw result: `core-test.log`
