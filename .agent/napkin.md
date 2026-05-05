# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|-----------------|--------------------|
| 2026-05-05 | self | Used `New-Item` to create `.agent/napkin.md` even though manual file edits should use `apply_patch`. | Use `apply_patch` for creating or editing repo files; shell commands are fine only for inspection or filesystem setup. |
| 2026-05-05 | self | Tried `bun -e` with a JavaScript template literal inside PowerShell double quotes; PowerShell consumed the backticks and broke the script. | For PowerShell `bun -e` smoke tests, avoid JS template literals or put code in a real script file. |

## User Preferences
- (accumulate here as learned)

## Patterns That Work
- Use `rg --files` first when a user-provided path is missing, then search parent directories if needed.
- For the Pi spike, `@mariozechner/pi-ai` has native `openrouter` provider support. `@preset/enkii` is not in the static model registry, so clone the `deepseek/deepseek-v4-pro` OpenRouter model config and override `id`.
- 2026-05-05 Pi/OpenRouter spike succeeded with `@preset/enkii`: model called `read_file`, then `submit_review`; `CandidatesPassSchema` parsed; inline sample completed in 27.4s.
- 2026-05-05 production `runReview` smoke with temp artifacts succeeded through Pi runtime: read artifacts, used tools, called `submit_review`, wrote candidates/validated in 65.0s.
- GitHub review comments cannot rely on custom CSS for colored severity chips; use markdown image badges from shields.io and bold the parsed title mechanically in the post step.
- Pi's SDK package (`@mariozechner/pi-coding-agent`) exports reusable `createReadOnlyTools(cwd)` / `createReadTool` / `createGrepTool` factories compatible with `pi-agent-core` `AgentTool`; use those instead of maintaining local duplicate read/grep/list tools.

## Patterns That Don't Work
- Assuming user-provided plan paths are relative to the current repo root without checking.
- An invalid/stale OpenRouter key presents as `401 User not found`; verify with `/api/v1/auth/key` before debugging Pi/tool code.

## Domain Notes
- Current workspace root is `E:\Users\Oluwatimilehin\Documents\DocSyde\Codebase\main\enkii`.
