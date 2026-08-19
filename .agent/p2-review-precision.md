# P2 review precision and concise summaries

## Work brief

- Type: improvement
- Branch: `ft/codex/p2-review-precision`
- Baseline: Enkii reviews the complete PR on every push. Keep that behavior.
- Evidence: Allies Cloud PR #9 ran code, security, and policy reviews on six pushes. Policy summaries were roughly 2,557–4,776 characters, including clean passes that replayed resolved findings. Earlier Allies PRs also accumulated repeated P2 findings and follow-up churn.

## Objective

Reduce low-value P2 churn and clean-review response length without weakening Enkii's ability to find genuine new bugs on later pushes.

## Scope

1. Tighten the bundled code and security P2 rubric so a P2 needs a concrete reachable trigger, a present changed-code risk, material impact, and relevance to the current PR.
2. Make candidate prompts inspect existing review comments. Do not silently suppress an unresolved P2 that remains in the current head: it must stay visible in the current review. Suppress resolved-history replay and duplicate prose; new P2 issues on later pushes remain eligible. P0/P1 handling is unchanged.
3. Add equivalent P2 qualification to policy review while preserving repository-owned finding and citation formats.
4. Require concise summaries: no inline-finding restatement, no resolved-finding replay, and compact clean/no-new-finding policy summaries even when the repository asks for several status sections. Repository policy owns required semantic content and citations; Enkii owns the concise presentation envelope.
5. Paginate existing issue and review comment retrieval so history-based guidance remains reliable on long review threads.
6. Add prompt and pagination regression tests, then run the existing test, typecheck, and formatting suites.

## Out of scope

- Reducing review frequency or reviewing only the latest commit.
- Suppressing or changing P0/P1 findings.
- A mandatory second model/validator pass, cross-lane coordinator, semantic database, or deterministic truncation of model output.
- Changing repository-owned policy rules or Allies workflow gating in this Enkii change.

## Acceptance criteria

- Every enabled lane still receives the complete PR context on every automatic push.
- P0/P1 methodology and posting behavior remain unchanged.
- P2 guidance requires a concrete reachable trigger, present changed-code risk, material impact, scope relevance, and a proportionate recommendation. Remediation cost alone cannot invalidate a real P2; a substantial correction may be dispositioned or followed up.
- Existing comments prevent resolved-history replay, but an unresolved P2 that still exists in the current head remains visible and cannot yield a false clean review. Genuinely new P2 findings remain eligible.
- Policy instructions remain authoritative for required semantic sections, citations, and finding bodies. Enkii controls summary presentation: a clean policy review uses compact labeled lines, ID ranges, and no resolved-finding recap.
- Clean code/security summaries target at most 100 words and three sentences. Clean/no-new-finding policy summaries target at most 180 words. Summaries with findings target at most 250 words and refer to inline comments rather than duplicating their full prose; required safety disclosures may exceed the target.
- Existing issue and review comments are fetched across all pages.
- Automated prompt tests cover the new P2, deduplication, and summary requirements.
- A before/after replay uses Cloud PR #9 clean policy output plus representative genuine and rejected P2 cases from the Allies audit. The change is acceptable only if clean policy output falls below 180 words, known genuine P2s remain findings, speculative/deferable P2s are rejected, and P0/P1 behavior is unchanged.

## Implementation plan

1. Update bundled code/security review methodologies with the narrower P2 gate and proportional-remediation rule.
2. Update code, security, policy, and validator prompts with explicit existing-comment lifecycle and summary contracts, including a compact policy template.
3. Paginate existing comment retrieval using the existing Octokit client.
4. Add focused prompt and artifact tests; do not add runtime services or new action inputs.
5. Run the targeted replay plus `bun test`, `bun run typecheck`, and `bun run format:check`.

## Risks and controls

- Risk: stricter language hides legitimate bugs. Control: scope the stricter gate and history guidance only to P2; use reachable risk rather than deterministic reproduction; preserve full-diff inspection and all P0/P1 behavior; replay known genuine findings.
- Risk: compact summaries omit required policy evidence. Control: repository-owned formats remain authoritative; compactness applies to prose and resolved-history repetition, not required citations or active findings.
- Risk: word limits become brittle. Control: use prompt-level guidance rather than truncating posted content.
- Risk: duplicate suppression creates a false 5/5. Control: never suppress a same-root-cause P2 while it remains present on the current head; repeat the current finding if necessary and only suppress historical recap.

## Adversarial review disposition

- Accepted: replace reproducibility/bounded-fix eligibility with reachable risk and proportional remediation.
- Accepted: preserve unresolved current-head P2s so deduplication cannot create a false clean score.
- Accepted: add numeric summary targets and a representative replay check.
- Accepted: define repository semantic-content versus Enkii presentation precedence and provide a compact template.
- Accepted: paginate comment history and cover it with a regression test.
