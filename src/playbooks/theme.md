# Playbook — Frontend Theming (fe:theme)

You are adding or updating a Superset theme variant.

## Steps

1. **Find the theme provider.** Look for files under `superset-frontend/src/` that export theme objects or use a `ThemeProvider`. Superset uses Ant Design + a custom design-token layer.

2. **Enumerate the palette.** The issue body lists the target palette (e.g. VS Code Default Dark+). Map every specified color to the corresponding design token.

3. **Add the variant.** Prefer extending the existing theme configuration (do not copy-paste an entire theme). Expose the new variant as a selectable option in `Settings → Appearance` if applicable.

4. **Audit hardcoded colors.** `rg '#[0-9a-fA-F]{6}' superset-frontend/plugins/ | head -n 40` — any hit inside a chart component means that chart will not respect the new theme. Fix the three most visible offenders (not scope creep — stop at three).

5. **Storybook.** Add or update a story that renders core components under the new theme. Take a screenshot and attach it to the PR.

6. **Tests.** Run `cd superset-frontend && npm run test -- --runInBand --testPathPattern=theme` to confirm no snapshot regressions. Update snapshots intentionally where expected.

7. **PR.** Title: `feat(theme): <name>`. Body includes `Fixes #<issue_number>` and the screenshot.

8. **Structured output:**

```json
{
  "pr_url": "...",
  "fix_summary": "...",
  "tests_added": true,
  "scanner_rerun_clean": true,
  "confidence": "high"
}
```
