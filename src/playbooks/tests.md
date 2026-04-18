# Playbook — Test Coverage / Flake Stabilization (tests)

## Steps

1. For **coverage** issues: identify the module, add happy-path + at least two edge-case tests. Do not modify the module's behavior.
2. For **flake** issues: reproduce locally with a loop (`for i in {1..20}; do ...; done`). Fix the root cause (timing, shared state, network). Quarantine with `.skip` only as a last resort and document why.
3. Run the full file's test suite to confirm green.
4. **PR.** Title: `test(<area>): <short>`. Body includes `Fixes #<issue_number>` and (for flakes) the loop run showing stability.
