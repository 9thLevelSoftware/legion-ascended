# Scenario interrupted-resumed.v1

Starting from the frozen v8 baseline, run a long workflow change through an intentional interruption and resume. The implementation should preserve task identity, avoid duplicate edits or duplicate review artifacts, and leave the run gradeable even if the resumed attempt fails.

Expected public verification: run the existing v8 validation command set plus the scenario-specific smoke or regression evidence named in the run manifest.
