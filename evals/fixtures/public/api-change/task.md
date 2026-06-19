# Scenario api-change.v1

Starting from the frozen v8 baseline, add an explicit machine-readable metadata field to the workflow status output while preserving the existing human-readable output. Treat this as a compatibility-sensitive API change and document migration behavior for callers.

Expected public verification: run the existing v8 validation command set plus the scenario-specific smoke or regression evidence named in the run manifest.
