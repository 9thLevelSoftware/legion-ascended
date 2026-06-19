# Scenario bug-fix.v1

Starting from the frozen v8 baseline, fix a resume-flow defect where an interrupted workflow can record a stale active task after the user restarts the session. Keep the fix scoped to resume state reconciliation and add regression coverage at the closest existing test layer.

Expected public verification: run the existing v8 validation command set plus the scenario-specific smoke or regression evidence named in the run manifest.
