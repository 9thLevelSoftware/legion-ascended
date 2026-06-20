# P01-T07 State Diagrams

Generated from the exported transition matrices in `packages/core/src/state-machines/index.ts`.

```mermaid
stateDiagram-v2
  [*] --> TaskQueued
  TaskQueued --> TaskReady: task.created.v1
  TaskReady --> TaskClaimed: task.claimed.v1
  TaskClaimed --> TaskRunning: task.heartbeat_recorded.v1
  TaskRunning --> TaskBlocked: task.blocked.v1
  TaskRunning --> TaskCompleted: task.completed.v1
  TaskRunning --> TaskNeedsReplan: review.submitted.v1 (fail)
  TaskBlocked --> TaskReady: task.retry_scheduled.v1
  TaskNeedsReplan --> TaskReady: task.retry_scheduled.v1
  TaskCompleted --> TaskReady: task.retry_scheduled.v1 (higher generation)
  TaskReady --> TaskInvalidated: task.invalidated.v1
  TaskClaimed --> TaskInvalidated: task.invalidated.v1
  TaskRunning --> TaskInvalidated: task.invalidated.v1
  TaskBlocked --> TaskInvalidated: task.invalidated.v1
```

```mermaid
stateDiagram-v2
  [*] --> ChangeDraft
  ChangeDraft --> ChangeProposed: change.proposed.v1
  ChangeProposed --> ChangeApproved: artifact_revision.recorded.v1
  ChangeApproved --> ChangePlanned: artifact_revision.recorded.v1

  [*] --> RunCreated
  RunCreated --> RunStarted: run.started.v1
  RunStarted --> RunSucceeded: run.finished.v1 (succeeded)
  RunStarted --> RunNeedsHuman: input.recorded.v1

  [*] --> ReviewRequested
  ReviewRequested --> ReviewAccepted: review.submitted.v1 (pass)
  ReviewRequested --> ReviewRejected: review.submitted.v1 (fail)

  [*] --> ApprovalRequested
  ApprovalRequested --> ApprovalGranted: approval.granted.v1
  ApprovalRequested --> ApprovalDenied: approval.denied.v1
```

```mermaid
stateDiagram-v2
  [*] --> IntegrationPending
  IntegrationPending --> IntegrationIntent: integration.outbox_intent_recorded.v1
  IntegrationIntent --> IntegrationSucceeded: integration.effect_succeeded.v1
  IntegrationIntent --> IntegrationFailed: integration.effect_failed.v1

  [*] --> ReleaseRequested
  ReleaseRequested --> ReleaseDeployed: release.deployed.v1
  ReleaseDeployed --> ReleaseHealthy: observation.recorded.v1 (healthy)
  ReleaseDeployed --> ReleaseRolledBack: release.rolled_back.v1

  [*] --> ObservationPending
  ObservationPending --> ObservationObserving: observation.recorded.v1
  ObservationObserving --> ObservationHealthy: observation.recorded.v1 (healthy)
  ObservationObserving --> ObservationFailed: observation.recorded.v1 (failed)
```
