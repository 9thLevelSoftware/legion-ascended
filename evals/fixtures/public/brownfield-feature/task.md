# Scenario brownfield-feature.v1

Starting from the frozen v8 baseline, extend an existing workflow command so it records a compact evidence summary path when the command finishes. Preserve the current command name, existing arguments, and default behavior when the new option is not supplied.

Expected public verification: run the existing v8 validation command set plus the scenario-specific smoke or regression evidence named in the run manifest.
