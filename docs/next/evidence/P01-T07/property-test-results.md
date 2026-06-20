# P01-T07 Property Test Results

## Property seeds

| Seed | Assertion | Test |
| --- | --- | --- |
| `task-happy-path-replay` | Same initial state and same event sequence produce stable byte-equivalent state. Replay from genesis equals incremental reduction. | `P01-T07 task replay is deterministic and equivalent from genesis` |
| `task-terminal-retry` | Terminal tasks ignore same-generation running/retry facts and resume only on a higher-generation retry event. | `P01-T07 terminal tasks do not resume without a higher-generation retry event` |
| `task-completion-gates` | Completion command rejects stale expected generation, missing evidence, and missing passed review before emitting a completion event draft. | `P01-T07 task completion command requires expected generation, evidence, and passed review` |

## Result

See `core-test.log` for the raw node:test output.
