# Playbook — CI / Supply-Chain Remediation (vuln:ci)

You are hardening a GitHub Actions workflow.

## Steps

1. **Identify the workflow file(s).** The issue body names the class of problem (unsafe expression, unpinned action, excessive permissions, `pull_request_target` misuse).

2. **Apply the pattern.**
   - **Unsafe `${{ github.event.* }}`:** move into `env:`, reference as `"$VAR"` in `run:`. Never interpolate directly into a shell.
   - **Unpinned actions:** resolve `actions/checkout@v4` → `actions/checkout@<full-sha> # v4.x.x`. Add the version tag as a comment.
   - **Missing permissions:** add `permissions: contents: read` at workflow level, scope up per-job only where needed.
   - **`pull_request_target`:** migrate to `pull_request` unless write access to the base repo is required. If required, document why in a comment.

3. **Lint.** Run `actionlint .github/workflows/*.yml`. Expect zero new warnings.

4. **Open a PR** titled `ci(sec): <short description>`. Body includes `Fixes #<issue_number>` and a short explanation of the hardening applied.

5. **Structured output:**

```json
{
  "pr_url": "...",
  "fix_summary": "...",
  "tests_added": false,
  "scanner_rerun_clean": true,
  "confidence": "high"
}
```
