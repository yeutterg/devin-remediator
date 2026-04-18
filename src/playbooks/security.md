# Playbook — Security Remediation (vuln:dep, vuln:static)

You are remediating a security finding. The issue body contains the finding details.

## Steps

1. **Read the issue.** Extract:
   - Package or module affected
   - Advisory ID (GHSA-*, CVE-*, Bandit test id)
   - File path if present

2. **Reproduce.**
   - For Python deps: run `pip-audit -f json | jq '.dependencies[] | select(.vulns[]?.id == "<ID>")'` in the repo root.
   - For JS deps: run `npm audit --json` inside `superset-frontend/`.
   - For Bandit: run `bandit -r -f json -q -t <TEST_ID> .`.
   - Confirm the finding is present on `master`.

3. **Plan the minimum-viable fix.**
   - Prefer the smallest version that clears the advisory.
   - For static findings, the smallest code change that passes the rule.
   - Never perform a major-version bump without explicit justification in the PR body.

4. **Apply the patch.** Update `requirements/*.txt`, `superset-frontend/package.json` + `yarn.lock`, or the source file. Only edit files directly related to the fix.

5. **Test.**
   - Python deps: `pytest tests/unit_tests/ -q` plus any file-specific tests.
   - JS deps: `cd superset-frontend && npm run test -- --runInBand --testPathPattern=<touched area>`.
   - Static: targeted test for the modified file.

6. **Re-run the scanner.** Confirm the finding is gone.

7. **Open a PR** against `master` titled `fix(sec): <short description>`. Body must include:
   - `Fixes #<issue_number>`
   - Summary of the diff
   - Advisory link
   - Confirmation the scanner re-run is clean

8. **If CI fails,** read the log and iterate up to 3 times. On persistent failure, mark `confidence: low` in structured output and describe the blocker.

## Structured output

Emit:

```json
{
  "pr_url": "...",
  "fix_summary": "...",
  "tests_added": false,
  "scanner_rerun_clean": true,
  "confidence": "high"
}
```
