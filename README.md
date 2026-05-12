# enkii

Open-source AI code review for GitHub pull requests.

Built by [@timithechef](https://x.com/timithechef).

Enkii is a **Greptile / CodeRabbit-style alternative** built on **PI + GitHub Actions** with a simple model: bring your own OpenRouter key, keep prompts editable, and run reviews in your own repo.

## Name origin

The name **Enkii** is inspired by **Enki** — the Sumerian god associated with wisdom, craft, and problem-solving.

## Why enkii exists

Most AI review tools are useful but closed, expensive, or hard to tune. Enkii is for teams that want:

- No vendor lock-in
- Editable review behavior (markdown skill files)
- Transparent, repo-native automation
- Bring-your-own model/provider via OpenRouter

## What enkii does today

- Automatic code review on PR open/sync/reopen
- On-demand commands in PR comments:
  - `@enkii /review` — re-run code review
  - `@enkii /benchmark` — fresh review ignoring prior PR comments
  - `@enkii /security` — focused security review
  - `@enkii` or `@enkii help` — help reply
  - `@enkii status` — status reply
- Optional two-pass validation pipeline (`enable_validator=true`)
- Inline comments + resilient summary fallback for unanchorable comments

## Quick start (5 minutes)

### 1) Add OpenRouter key

Create a repo secret:

- Name: `OPENROUTER_API_KEY`
- Value: your key from <https://openrouter.ai/keys>

### 2) Add workflow

Create `.github/workflows/enkii-review.yml`:

```yaml
name: enkii review

on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

concurrency:
  group: enkii-pr-${{ github.event.pull_request.number || github.event.issue.number || github.run_id }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run enkii
        uses: Timmyy3000/enkii@v0.2.0-beta.1
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
```

> Yes, `actions/checkout` is required.
>
> Avoid adding `pull_request_review: submitted` to this workflow with `cancel-in-progress: true` — it can self-cancel when enkii posts its own review.

### 3) Open a PR

enkii runs automatically. You can then comment with:

- `@enkii /review`
- `@enkii /security`
- `@enkii /benchmark`

## Model configuration

By default, enkii uses:

- `review_model: "@preset/enkii"`
- `security_model: "@preset/enkii"`

That means your OpenRouter account should have a preset named `enkii`.

### Recommended preset path

Create OpenRouter preset `enkii` and set:

- model: your preferred model
- provider order: your preferred primary/fallback providers
- allow fallbacks: enabled

### Direct model override path

You can skip presets and set model IDs directly:

```yaml
- name: Run enkii
  uses: Timmyy3000/enkii@v0.2.0-beta.1
  with:
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    review_model: deepseek/deepseek-chat-v4.1
    security_model: deepseek/deepseek-chat-v4.1
```

## Action inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `openrouter_api_key` | yes | — | OpenRouter API key |
| `github_token` | no | workflow `github.token` | Override token (advanced) |
| `review_model` | no | `@preset/enkii` | Model for code review |
| `security_model` | no | `@preset/enkii` | Model for security review |
| `review_skill_path` | no | `""` | Custom review skill path |
| `security_skill_path` | no | `""` | Custom security skill path |
| `enable_validator` | no | `"false"` | Two-pass review validation |
| `run_security` | no | `"true"` | Auto-run security review on PR events |

## Action outputs

| Output | Description |
|---|---|
| `contains_trigger` | Whether the current event matched enkii trigger logic |
| `code_review_id` | GitHub review ID for code review post (if posted) |
| `security_review_id` | GitHub review ID for security review post (if posted) |

## Customizing review behavior

Enkii’s behavior is prompt/skill-driven.

Bundled defaults:

- `skills/review.md`
- `skills/security-review.md`

To customize in your repo:

1. Create `.enkii/review.md` and/or `.enkii/security-review.md`
2. Point workflow inputs:

```yaml
with:
  openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
  review_skill_path: .enkii/review.md
  security_skill_path: .enkii/security-review.md
```

## AI-agent setup notes (copy/paste context)

If you’re asking an AI agent to set up enkii in a repository, give it this checklist:

1. Create secret `OPENROUTER_API_KEY`
2. Create `.github/workflows/enkii-review.yml` using the workflow above
3. Ensure workflow has `actions/checkout@v4` with `fetch-depth: 0`
4. Ensure permissions include `pull-requests: write`, `issues: write`, `contents: read`
5. Open a test PR and verify enkii posts a review
6. Comment `@enkii /security` and verify a security review thread appears
7. (Optional) add `.enkii/review.md` and wire `review_skill_path`

## Reliability notes

- enkii now updates its tracking comment when a run fails, instead of silently leaving a dangling “working…” state.
- If inline anchors fail, enkii preserves findings in summary notes rather than dropping the entire review.

## Related projects (attribution)

Enkii is part of an ecosystem of AI code review tools. Big respect to projects that pushed the category forward:

- [Factory](https://factory.ai)
- [PR-Agent](https://github.com/Codium-ai/pr-agent)
- [Greptile](https://greptile.com)
- [CodeRabbit](https://www.coderabbit.ai)

## Current status

Early-stage and actively evolving. Useful now, still opinionated, and open to contributions.

## Contributing

Issues and PRs are welcome.

## License

MIT — see [LICENSE](LICENSE).
