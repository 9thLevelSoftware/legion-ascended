# Scenario security-sensitive.v1

Starting from the frozen v8 baseline, harden handling for sensitive values printed during workflow evidence capture. Ensure common token, API key, password, and bearer-token shapes are redacted before evidence logs are retained. Do not suppress errors or weaken validation to hide secrets.

Expected public verification: run the existing v8 validation command set plus the scenario-specific smoke or regression evidence named in the run manifest.
