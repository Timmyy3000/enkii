# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|-----------------|--------------------|
| 2026-05-05 | self | Used `New-Item` to create `.agent/napkin.md` even though manual file edits should use `apply_patch`. | Use `apply_patch` for creating or editing repo files; shell commands are fine only for inspection or filesystem setup. |
| 2026-05-05 | self | Tried `bun -e` with a JavaScript template literal inside PowerShell double quotes; PowerShell consumed the backticks and broke the script. | For PowerShell `bun -e` smoke tests, avoid JS template literals or put code in a real script file. |

## User Preferences
- Do not add unnecessary tests for tiny presentation-only changes; keep verification proportional.

## Patterns That Work
- Use `rg --files` first when a user-provided path is missing, then search parent directories if needed.
- For the Pi spike, `@mariozechner/pi-ai` has native `openrouter` provider support. `@preset/enkii` is not in the static model registry, so clone the `deepseek/deepseek-v4-pro` OpenRouter model config and override `id`.
- When using OpenRouter presets such as `@preset/enkii`, do not set `compat.openRouterRouting.sort = "price"` on the cloned model. That overrides preset/provider routing and defeats provider preferences.
- For custom/preset OpenRouter ids cloned from a base model, set `compat.supportsDeveloperRole = false` unless you have confirmed the routed provider accepts `developer` messages; otherwise OpenRouter can fail before the first tool call.
- 2026-05-05 Pi/OpenRouter spike succeeded with `@preset/enkii`: model called `read_file`, then `submit_review`; `CandidatesPassSchema` parsed; inline sample completed in 27.4s.
- 2026-05-05 production `runReview` smoke with temp artifacts succeeded through Pi runtime: read artifacts, used tools, called `submit_review`, wrote candidates/validated in 65.0s.
- `enkii: agent did not call submit_review` means the agent loop returned without invoking the required submit tool; this is distinct from schema-validation failures, which only happen after the submit tool is called.
- `runAgent` now retries missing-submit exits separately from transient provider errors, appending a stricter tool-call reminder on retry; tune with `ENKII_AGENT_MISSING_OUTPUT_RETRIES` if needed.
- The review/security prompts must never mention "do not submit review" while also requiring the local `submit_review` tool; the model interprets that literally and exits after reads.
- GitHub review comments cannot rely on custom CSS for colored severity chips; use markdown image badges from shields.io and bold the parsed title mechanically in the post step.
- Pi's SDK package (`@mariozechner/pi-coding-agent`) exports reusable `createReadOnlyTools(cwd)` / `createReadTool` / `createGrepTool` factories compatible with `pi-agent-core` `AgentTool`; use those instead of maintaining local duplicate read/grep/list tools.
- For `issue_comment` PR commands, first fetch `refs/pull/<number>/head`, detach checkout the current PR head SHA, and fetch the diff from GitHub's PR diff media endpoint. `actions/checkout` leaves comment-triggered jobs on the base/default branch.
- In workflows that support both `pull_request` and `issue_comment`, workflow-level `concurrency.cancel-in-progress: true` keyed only by PR number lets unrelated PR comments spawn an `issue_comment` run that cancels the in-flight PR run before the job-level `if:` can skip it.

## Patterns That Don't Work
- Assuming user-provided plan paths are relative to the current repo root without checking.
- An invalid/stale OpenRouter key presents as `401 User not found`; verify with `/api/v1/auth/key` before debugging Pi/tool code.
- Posting a batched GitHub PR review with even one unresolved inline line makes the whole `createReview` request fail with 422. Check anchors against `pulls.listFiles().patch`, summarize unresolved findings, and keep a summary-only retry.
- Using local `git diff merge-base..HEAD` for `issue_comment` runs can produce a 0-byte diff because `HEAD` is the base branch, not the PR head.

## Domain Notes
- Current workspace root is `E:\Users\Oluwatimilehin\Documents\DocSyde\Codebase\main\enkii`.
