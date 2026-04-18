# Playbook — TypeScript Migration (ts:migrate)

## Steps

1. **Scope the change.** Only touch files listed in the issue. Do not expand scope.
2. **Rename** the file to `.ts` / `.tsx`. Fix imports in callers.
3. **Type it.** No `any`. No unchecked casts. Use inference where possible; define small types where not.
4. **Run the type checker.** `cd superset-frontend && npm run type` (or the repo's configured command) — expect no new errors.
5. **Run unit tests** affecting the touched module.
6. **PR.** Title: `chore(ts): migrate <file>`. Body includes `Fixes #<issue_number>` and a note that behavior is unchanged.
