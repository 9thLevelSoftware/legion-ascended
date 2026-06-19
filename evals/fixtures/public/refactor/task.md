# Scenario refactor.v1

Starting from the frozen v8 baseline, refactor duplicated command-dispatch validation into one local helper without changing command names, help text, adapter behavior, or published package contents. The end state should reduce duplication while preserving all current tests.

Expected public verification: run the existing v8 validation command set plus the scenario-specific smoke or regression evidence named in the run manifest.
