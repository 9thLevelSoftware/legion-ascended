# P01-T07 Property Test Results

## Property seeds

| Seed | Assertion | Test |
| --- | --- | --- |
| `task-happy-path-replay` | Same initial state and same event sequence produce stable byte-equivalent state. Replay from genesis equals incremental reduction. | `P01-T07 task replay is deterministic and equivalent from genesis` |
| `task-terminal-retry` | Terminal tasks ignore same-generation running/retry facts and resume only on a higher-generation retry event. | `P01-T07 terminal tasks do not resume without a higher-generation retry event` |
| `task-completion-gates` | Completion command rejects stale expected generation, missing evidence, and missing passed review before emitting a completion event draft. | `P01-T07 task completion command requires expected generation, evidence, and passed review` |
| `task-cross-aggregate-stale` | Cross-aggregate evidence and review facts cannot mutate a newer generation, wrong run, or terminal task projection. | `P01-T07 stale and mismatched cross-aggregate task events are ignored` |
| `task-retry-cross-aggregate-current-run` | Retried tasks can still collect current-run evidence and review facts whose own aggregate generations differ from the task generation. | `P01-T07 retried tasks accept current-run evidence and review aggregate facts` |
| `integration-effect-identity` | Integration effect completions must match the effect kind and target hash recorded by the side-effect intent. | `P01-T07 integration completions must match the recorded side-effect intent` |
| `task-command-routing` | Task command decisions reject mismatched envelope routing fields and terminal invalidation. | `P01-T07 task command decisions reject misrouted envelopes and terminal invalidation` |
| `release-stale-observation` | Release observation and rollback facts cannot bypass generation or state guards. | `P01-T07 release guards reject stale observations and invalid rollback states` |
| `stable-stringify` | Stable serialization sorts object keys bytewise and rejects non-serializable roots instead of returning undefined. | `P01-T07 stable state stringify sorts keys bytewise and rejects non-serializable roots` |

## Result

See `core-test.log` for the raw node:test output.
