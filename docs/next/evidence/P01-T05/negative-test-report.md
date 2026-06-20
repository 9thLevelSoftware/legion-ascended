# P01-T05 Negative Test Report

Result: PASS

Evidence:

- `docs/next/evidence/P01-T05/schema-test-report.log`
- `schemas/entities/fixtures/lifecycle-invalid.json`

Invalid fixture cases covered:

| Case | Schema | Expected rejection |
| --- | --- | --- |
| Task contract has overlapping write and forbidden scope | `taskContractSchema` | Write allowlist cannot overlap forbidden paths. |
| Task carries immutable contract objective | `taskSchema` | Operational task rows do not own intent fields. |
| Started task run lacks frozen manifest timestamp | `taskRunSchema` | Started runs require a frozen manifest. |
| Evidence bundle attempts to store secret material | `evidenceBundleSchema` | Secret material is not a valid evidence sensitivity class. |
| Blocking review finding omits evidence references | `reviewDecisionSchema` | Blocking findings require evidence references. |
| Approval has unspecified action targets | `approvalSchema` | Approval scope targets cannot be empty. |
| Forward-fix release omits forward-fix plan | `releaseSchema` | Forward-fix releases require a plan. |
| Rolled-back observation omits rollback evidence | `observationSchema` | Rolled-back observations require rollback evidence references. |

The protocol test suite also verifies unknown and not-verified outcomes remain representable for evidence and review records.
