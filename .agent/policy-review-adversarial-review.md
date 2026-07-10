# Adversarial Review

## Verdict

Needs revision

## Accepted Findings

- Define explicit fork skip/fail/continue behavior with no bundled policy fallback.
- Harden path containment and reject symlinks using symlink-aware inspection.
- Test repository-authored citations and content after final GitHub formatting, not only in candidate JSON.
- Settle lanes independently so one failed lane cannot erase successful reviews.
- Add an explicit automatic-only dispatch matrix.
- Resolve the public action input name before implementation.

## Revision Outcome

- `policy_review_skill_path` is the selected public input.
- The plan now requires boundary-safe containment, `lstat`/realpath policy, and adversarial path tests.
- The plan defines Enkii's shared presentation envelope and preserves repository-authored semantic content within it.
- The plan now uses per-lane settlement, posts successes, then reports lane-specific failure.
- The plan includes an automatic-versus-explicit dispatch matrix.
- Fork behavior is resolved: skip policy only, continue code/security, leave the policy output empty, explain the skip in the tracking comment, and do not fail an otherwise successful run.
- The final readiness pass additionally required policy reviews to omit generic mergeability scoring, preserve full finding bodies in every fallback rendering path, and isolate GitHub posting failures between lanes. These requirements are incorporated into the accepted plan.
