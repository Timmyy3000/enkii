# Contributing to enkii

Thanks for contributing.

## Development setup

```bash
bun install --frozen-lockfile
bun run test
bun run typecheck
```

## Pull request rules

- Use a branch off `main`
- Keep PRs focused and small
- Include tests for behavior changes
- Update docs/README when setup or behavior changes
- Add changelog entry in `CHANGELOG.md` under the next unreleased section

## Commit style

Use concise, scoped commit messages, e.g.:

- `fix: prevent self-cancel race in workflow`
- `docs: clarify OpenRouter setup`

## Security-sensitive changes

If a change touches auth, secrets, workflow tokens, or prompt loading from untrusted sources, call that out explicitly in the PR description.

## Getting help

Open a GitHub issue with logs and repro steps. For security issues, use `SECURITY.md` instead of public issues.
