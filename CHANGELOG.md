# Changelog

All notable changes to enkii will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

## [0.1.0-alpha.6] — 2026-05-05

### Fixed

- Manual PR commands from issue comments now fetch and check out the current PR head SHA before review, so file reads inspect the branch under review instead of the base branch.
- PR diffs are now generated from GitHub's PR diff endpoint when PR metadata is available, avoiding empty diffs caused by `issue_comment` checkout context.
- Added a `gh pr diff --repo owner/repo` fallback if the GitHub diff API is unavailable.

## [0.1.0-alpha.5] — 2026-05-05

### Fixed

- Prevented GitHub `422 Line could not be resolved` failures from invalid inline anchors by checking candidate comments against the PR patch before posting.
- Comments that cannot be anchored to changed diff lines are now preserved under an `Unanchored notes` section in the review summary.
- Added a summary-only retry when GitHub still rejects inline review comments for line-resolution reasons.

## [0.1.0-alpha.4] — 2026-05-05

### Changed

- Switched the embedded Pi runtime to Pi's SDK read-only tools (`read`, `grep`, `find`, `ls`) via `@mariozechner/pi-coding-agent`.
- Removed enkii's duplicate local `read_file`, `grep`, `list_files`, and path-guard tool implementations.
- Updated review, security, benchmark, and validator prompts to use Pi's native read-only tool names and offset/limit chunking.

### Fixed

- Incomplete reviews that cannot inspect the PR diff now receive `Mergeability Score: 1/5` with manual-review guidance instead of being treated as safe to merge.

## [0.1.0-alpha.3] — 2026-05-05

### Added

- Added `@enkii /benchmark` to run a fresh code review without passing existing PR comments to the model, intended for replay benchmarks against older PRs.
- Added Greptile-style review summaries with a mechanical Mergeability Score and colored severity badges for inline findings.

### Changed

- Code and security reviews can run in parallel for automatic PR events.
- Review summaries now include merge guidance while leaving the numeric score to the post step.

## [0.1.0-alpha.2] — 2026-05-05

### Changed

- Replaced the Codex CLI runtime with embedded `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` on OpenRouter.
- Pass 1 and Pass 2 now use submit tools (`submit_review`, `submit_validation`) for structured output instead of parsing Codex final messages.
- Removed the GitHub Action's Node/Codex install step; setup now installs Bun dependencies and runs enkii directly.
- Single-pass review remains the default. The Pass 2 validator remains available behind `enable_validator`.

### Removed

- Removed the abandoned Docker image workflow and Docker files from the alpha.2 pivot.

## [0.1.0-alpha.1] — 2026-05-01

First end-to-end alpha. Code-complete on the v0.1 plan; not yet validated against real PRs (that happens next during docsyde / external-corpus testing).

### Added

- **GitHub Action manifest** (`action.yml`) with 8 inputs:
  - `openrouter_api_key` (required)
  - `github_token` (defaults to `${{ github.token }}`)
  - `review_model` / `security_model` (default `@preset/enkii`, override with any OpenRouter model id)
  - `review_skill_path` / `security_skill_path` (override the bundled methodology with a custom markdown file)
  - `exclude_paths` / `max_files` (TODO: wire these into the runtime; declared but not yet enforced)
  - `skip_drafts` (TODO: same)
- **Triggers**:
  - `pull_request: [opened, synchronize, reopened]` → automatic code review
  - `@enkii /review` → re-run code review
  - `@enkii /security` → run a separate security review (its own PR Review thread)
  - `@enkii help` / `@enkii status` / `@enkii` (alone) → mechanical help reply (non-LLM)
- **Two-pass review architecture** (Pass 1 candidates → Pass 2 validator) for both code review and security review. Validator re-checks each candidate before the post step submits.
- **Codex CLI runtime** invoked with `--sandbox read-only`, `--ignore-user-config`, and inline `-c` overrides for OpenRouter provider config. No reliance on the consumer's local `~/.codex/config.toml`.
- **Bundled skills** (`skills/review.md` + `skills/security-review.md`) — minimal v0.1 baselines covering severity rubric, anti-noise rules, and "verify the specific repro before posting" guidance. Iteration against real PRs happens post-launch.
- **Skill loader** (`src/skills/loader.ts`) supporting bundled defaults + consumer overrides via `review_skill_path`. Fork-safe: refuses overrides loaded from a fork PR's HEAD (uses bundled instead) since fork-controlled prompts run with the consumer's secrets and would otherwise be an exfil vector.
- **Non-LLM post step** that submits a single batched PR Review via octokit, capping inline comments at 20 (spillover summarized in the review body).

### Architecture & infrastructure

- GitHub plumbing borrowed from `Factory-AI/droid-action` (MIT) — see `NOTICE` for attribution. Token resolution (`src/github/token.ts`) and tag dispatch (`src/tag/index.ts`) rewritten with borrowed logic since the upstream versions assumed Factory-specific OIDC + bot identity.
- Codex's hardcoded ~10K-token system prompt is amortized via OpenRouter prompt caching when consumers route through a preset that pins providers (recommended in the README).

### Known limitations

- **Default skills are minimal v0.1 baselines.** Output quality on real PRs is unknown until the docsyde benchmark phase.
- `exclude_paths` / `max_files` / `skip_drafts` inputs are declared in `action.yml` but not yet enforced in the runtime. Land in a follow-up commit before `v0.1.0` (non-alpha).
- No real-PR benchmark numbers yet. Phase 6 of the v0.1 plan covers that.
- Latency is 5–15 minutes per pass on a real PR (so 10–30 minutes for the full two-pass review). Acceptable for a side project, slow vs commercial competitors.

### Internal

- 18 commits in the v0.1.0-alpha.1 stack on `main`. Repo published at https://github.com/Timmyy3000/enkii.
- `bun run typecheck` passes.

[0.1.0-alpha.6]: https://github.com/Timmyy3000/enkii/releases/tag/v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/Timmyy3000/enkii/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/Timmyy3000/enkii/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/Timmyy3000/enkii/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/Timmyy3000/enkii/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/Timmyy3000/enkii/releases/tag/v0.1.0-alpha.1
