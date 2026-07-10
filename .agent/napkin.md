# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|-----------------|--------------------|
| 2026-05-05 | self | Used `New-Item` to create `.agent/napkin.md` even though manual file edits should use `apply_patch`. | Use `apply_patch` for creating or editing repo files; shell commands are fine only for inspection or filesystem setup. |
| 2026-05-05 | self | Tried `bun -e` with a JavaScript template literal inside PowerShell double quotes; PowerShell consumed the backticks and broke the script. | For PowerShell `bun -e` smoke tests, avoid JS template literals or put code in a real script file. |
| 2026-07-10 | self | Treated the napkin in the new worktree as absent because hidden files were omitted from discovery output, then replaced its contents. | Check `Test-Path` and read the worktree napkin directly before patching; always append to existing notes. |
| 2026-07-10 | self | Added unescaped Markdown backticks inside a TypeScript template literal, causing parser errors. | Escape every Markdown backtick inside prompt template literals and run the focused prompt test immediately. |

## User Preferences
- (accumulate here as learned)
- Keep policy review automatic-only in the first version; no dedicated slash command.
- Treat the repository-owned policy review Markdown as the agent prompt, not as the engineering guide itself.
- Allow the policy prompt to define how findings are formatted and how the referenced standards are cited.

## Patterns That Work
- Use `rg --files` first when a user-provided path is missing, then search parent directories if needed.
- For the Pi spike, `@mariozechner/pi-ai` has native `openrouter` provider support. `@preset/enkii` is not in the static model registry, so clone the `deepseek/deepseek-v4-pro` OpenRouter model config and override `id`.
- 2026-05-05 Pi/OpenRouter spike succeeded with `@preset/enkii`: model called `read_file`, then `submit_review`; `CandidatesPassSchema` parsed; inline sample completed in 27.4s.
- 2026-05-05 production `runReview` smoke with temp artifacts succeeded through Pi runtime: read artifacts, used tools, called `submit_review`, wrote candidates/validated in 65.0s.
- GitHub review comments cannot rely on custom CSS for colored severity chips; use markdown image badges from shields.io and bold the parsed title mechanically in the post step.
- Pi's SDK package (`@mariozechner/pi-coding-agent`) exports reusable `createReadOnlyTools(cwd)` / `createReadTool` / `createGrepTool` factories compatible with `pi-agent-core` `AgentTool`; use those instead of maintaining local duplicate read/grep/list tools.
- For `issue_comment` PR commands, first fetch `refs/pull/<number>/head`, detach checkout the current PR head SHA, and fetch the diff from GitHub's PR diff media endpoint. `actions/checkout` leaves comment-triggered jobs on the base/default branch.
- Model policy review as a third concurrent review lane alongside code and security.

## Patterns That Don't Work
- Assuming user-provided plan paths are relative to the current repo root without checking.
- An invalid/stale OpenRouter key presents as `401 User not found`; verify with `/api/v1/auth/key` before debugging Pi/tool code.
- Posting a batched GitHub PR review with even one unresolved inline line makes the whole `createReview` request fail with 422. Check anchors against `pulls.listFiles().patch`, summarize unresolved findings, and keep a summary-only retry.
- Using local `git diff merge-base..HEAD` for `issue_comment` runs can produce a 0-byte diff because `HEAD` is the base branch, not the PR head.
- Conflating the policy-review prompt with the engineering standards document it tells the agent to inspect.

## Domain Notes
- Current workspace root is `E:\Users\Oluwatimilehin\Documents\DocSyde\Codebase\main\enkii`.
- Policy review is opt-in through a repository-relative prompt path such as `.enkii/policy-review.md`.
- The prompt and referenced guide are intentionally read from the checked-out PR HEAD for same-repository PRs.
- `bun run format:check` currently fails on 33 untouched baseline TypeScript files; format changed files individually and report the baseline failure without rewriting unrelated files.
- Detect fork PRs by comparing head/base repository identity, not `head.repo.fork`; a repository can itself be a fork while receiving a same-repository PR.
