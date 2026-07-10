# Policy Review

## Status

- Type: feature
- Execution mode: solo planning; implementation mode to be confirmed at approval
- Worktree manager: Forest
- Branch: `ft/codex/policy-review`
- Worktree path: `C:\Users\ASUS\Documents\DocSyde\Codebase\enkii\.forest\worktrees\ft\codex\policy-review`
- Created: 2026-07-10
- Target date: not specified
- Current phase: final plan readiness review

## Objective

Add an opt-in policy-review lane that runs automatically with code and security reviews on supported pull-request events. A repository-owned Markdown file supplies the complete policy-review instructions. That prompt can direct the agent to the team's engineering guide and define the team's preferred review and citation format.

## Context

Enkii currently has two concurrent lanes: general code review and security review. Teams also want repository-specific engineering-policy checks without replacing Enkii's generic code-review methodology.

The original issue proposed passing the engineering guide directly into a bundled style-review methodology. Product clarification changed that boundary:

- `.enkii/policy-review.md` is the policy agent's prompt/instructions.
- The engineering guide remains an ordinary repository document discoverable by engineers.
- The prompt tells the agent which guide or files to read and how to report findings.
- Both the prompt and referenced files are read through the agent's existing read-only repository tools from the checked-out PR HEAD.
- The first version is automatic-only and has no `/policy` command.
- Code, security, and policy lanes run concurrently without cross-lane deduplication.

## Requirements

- Add an optional repository-relative policy prompt input. An empty value disables the lane.
- Use the prompt path as the enablement switch; do not add a separate run-policy flag in v1.
- Load the configured policy prompt from the checked-out PR HEAD for same-repository PRs.
- Give the policy agent the existing read-only repository tools so its prompt can direct it to engineering guides and supporting context.
- Do not impose a policy-specific citation schema. The repository prompt owns review focus, rule references, title conventions, and summary format within Enkii's shared candidate schema.
- Preserve repository-defined finding and summary content through final GitHub posting. Enkii may wrap inline content with its marker, brand header, severity badge, and section heading, but must not rewrite the prompt-defined citation or semantic title/body. Policy reviews omit Enkii's derived mergeability score/verdict.
- Preserve complete policy finding bodies and citations in inline, spillover, unanchored, and summary-only retry paths; fallback rendering must not collapse policy findings to titles only.
- Run policy review concurrently with enabled code and security reviews on the same automatic PR events.
- Settle and post each enabled lane independently across prompt loading, model execution, validation, and GitHub posting. A failed lane must not discard or prevent later successful reviews; after all successes post, the overall action may still fail with lane-specific diagnostics.
- Post policy results as an independent GitHub PR Review with its own marker and action output.
- Preserve code- and security-review behavior when policy review is disabled.
- Keep the existing validator setting applicable to the policy lane.
- Document the governance implications of sourcing policy instructions from PR HEAD.
- Harden repository-relative path validation with boundary-safe containment and symlink-aware inspection rather than relying on string-prefix containment or `stat()` alone.

## Acceptance Criteria

- [ ] `policy_review_skill_path` can point to a committed repository-relative Markdown file such as `.enkii/policy-review.md`.
- [ ] Empty `policy_review_skill_path` disables policy review without errors or behavior changes in other lanes.
- [ ] Supported automatic PR events start code, security when enabled, and policy when configured in the same concurrent task group.
- [ ] Policy review has no dedicated slash command in v1.
- [ ] The policy agent can follow its prompt to read a referenced repository guide from PR HEAD.
- [ ] The repository prompt can define citation and output conventions without a hard-coded policy rule-ID contract.
- [ ] Final posted policy inline bodies and summary content preserve prompt-defined citations and semantic wording inside Enkii's documented presentation envelope.
- [ ] Policy reviews omit the generic mergeability score/verdict and preserve complete finding bodies through spillover, unanchored, and summary-only retry rendering.
- [ ] Policy review posts an independent review using `<!-- enkii-policy-review -->` and exposes `policy_review_id`.
- [ ] Policy review artifacts use distinct filenames and cannot collide with code/security artifacts.
- [ ] Policy review uses the configured policy model, with an empty model input inheriting `review_model`.
- [ ] Existing validator behavior works for policy candidates.
- [ ] Invalid, missing, oversized, absolute, traversal, and non-regular prompt paths fail safely with actionable errors.
- [ ] Documentation explains HEAD sourcing, fork behavior, CODEOWNERS guidance, configuration, cost, and automatic triggers.
- [ ] Tests cover enablement, prompt loading, concurrent dispatch, output selection, markers, posting labels, disabled behavior, and fork behavior.
- [ ] Policy runs only for automatic dispatch with a configured path; `/review`, `/benchmark`, `/security`, help, status, and unrelated comment events never select it.
- [ ] When policy loading or execution fails, successful code/security lanes still post; the action then reports the policy-specific failure.
- [ ] When any lane's GitHub posting fails, other successful lanes still post, their output IDs are retained, and the action fails afterward with lane-specific diagnostics.
- [ ] Path tests cover sibling-prefix escapes, symlinks, directories, absolute paths, traversal, missing files, and oversized files.

## Evidence And Sources

- GitHub issue: https://github.com/Timmyy3000/enkii/issues/6
- `action.yml`: current inputs and outputs are lane-specific.
- `src/entrypoints/main.ts`: determines desired lanes, loads prompts, starts concurrent tasks, and posts results.
- `src/skills/loader.ts`: current repository override safety rules and fork refusal.
- `src/tag/commands/review.ts`: current hard-coded code/security review kinds, prompt selection, and artifact prefixes.
- `src/post/index.ts`: current code/security markers, labels, and mergeability presentation.
- `src/github/utils/command-parser.ts` and `src/tag/index.ts`: no policy slash-command changes are required for v1.

## Decisions

- Name: policy review.
- Repository prompt and referenced engineering guide are separate artifacts.
- Same-repository policy prompt source: PR HEAD.
- Triggering: automatic supported PR events only.
- Concurrency: run policy beside code and security; no cross-lane deduplication.
- Citation and presentation rules: owned by the repository prompt, constrained only by Enkii's shared candidate contract.
- Presentation envelope: Enkii retains mechanical marker/branding/severity/section wrappers, while prompt-authored citation, complete finding title/body, and summary meaning remain intact. Policy reviews do not receive Enkii's generic mergeability score/verdict.
- Enablement: non-empty policy prompt path; no separate boolean flag.
- Public input names: `policy_review_skill_path` and `policy_review_model`.
- Dispatch: policy is selected only for `dispatch.command === "auto"` when its prompt path is non-empty.
- Failure semantics: all selected lanes settle independently through loading, execution, validation, and posting; successful reviews and output IDs are preserved even when another lane fails, and the action reports failure only after every eligible lane has attempted to post.
- Loader: policy has no bundled fallback. A configured prompt is either loaded safely or the lane is explicitly skipped/failed according to the trust rule.
- Fork behavior: skip only the policy lane for a fork-owned HEAD prompt, continue code/security, leave `policy_review_id` empty, add an actionable tracking-comment notice, and do not fail an otherwise successful run.

## Risks

- A PR can weaken the policy prompt or the guide used to review itself. This is intentional for HEAD sourcing but must be visible and governable through normal review and optional CODEOWNERS protection.
- Fork PRs are a stronger trust boundary. The recommended v1 behavior is to skip only policy review, continue code/security, leave `policy_review_id` empty, and add an actionable note to the tracking comment without failing an otherwise successful run.
- A third lane increases model cost and may increase total wall time when it becomes the slowest concurrent task.
- Free-form repository prompts produce flexible output but cannot mechanically guarantee rule IDs or a fixed summary structure.
- Post formatting and mergeability language currently assume only code/security and must be generalized without changing existing output.

## Open Questions

- None before implementation.

## Plan

- See `.lavish/policy-review-plan.html` for the interactive plan and approval surface.

## Execution Notes

- The plan is based on `origin/main` at `314b99bc6614ed1cb5d936a045229287dc7b7d97`.
- Two independent adversarial reviews completed on 2026-07-10. All major findings were incorporated into fork semantics, path safety, every final-rendering path, execution/posting failure isolation, and dispatch coverage.
- No implementation begins until the plan is approved.
