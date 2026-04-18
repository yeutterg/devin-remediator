# Playbook — Frontend Performance (fe:perf)

You are reducing bundle size or improving runtime cost.

## Steps

1. **Measure first.** Before changing anything, capture a baseline: `npm run bundle:analyze` or equivalent. Save the number.
2. **Apply the change** described in the issue (library swap, code-splitting, memoization).
3. **Measure after.** Record the new number.
4. **Guardrails.** Ensure no visible behavior change: run `npm run test -- --runInBand`; for visual components, compare a Storybook snapshot.
5. **PR.** Include before/after numbers in the description. Title: `perf(<area>): <short>`.

Structured output format same as the security playbook, plus a `notes` field containing the before/after metric.
