# enkii

> Open-source GitHub Action for AI-powered pull request reviews. Bring your own OpenRouter key. No vendor lock-in.

**Status:** alpha (v0.5 / beta in active development). Not ready for production yet. Star the repo if you want to follow along.

Named after the Mesopotamian god of knowledge, caution, and foresight. Enki was the wise advisor who warned the other gods before they did dumb things, which is roughly the job description for a code review bot.

## What it is

A small GitHub Action that runs LLM-powered code reviews on pull requests. Same shape as Greptile / CodeRabbit / Devin Review / Factory Droid Review, except:

- **You bring the inference.** It points at OpenRouter with your API key. Default model is DeepSeek V4 Pro; override with any OpenRouter model ID.
- **No vendor backend.** enkii has no servers, no auth, no billing. Runs entirely on your GitHub Actions minutes + your OpenRouter spend.
- **Open weights by default.** OSS-friendly stack: OpenCode harness, OpenRouter routing, DeepSeek V4 Pro (or any OSS model you prefer).
- **Methodology is the product.** The reviewer's behavior is defined by markdown skill files (`review.md`, `security-review.md`) bundled in this repo. Override with your own `.enkii/review.md` to teach it your team's conventions.

## How it'll work (when shipped)

```yaml
# .github/workflows/enkii-review.yml
name: enkii review
on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]

permissions:
  pull-requests: write
  contents: read
  issues: write

concurrency:
  group: enkii-pr-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: Timmyy3000/enkii@v0.5
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
```

Triggers:

- `pull_request` (opened/synchronize/reopened) — automatic code review (skipped on draft PRs)
- Comment `@enkii /review` — re-run code review
- Comment `@enkii /security` — separate security review
- Comment `@enkii` alone — replies with help

## Why this exists

Greptile, CodeRabbit, Devin Review, and Factory Droid Review are good products. They're also commercial, vendor-locked, and varying degrees of opaque about what they actually run.

enkii is the side-project answer for people who want:

- Self-hosted OSS code reviews
- Their own model choice (any OpenRouter-supported model)
- Their own review methodology (markdown skill files, MIT-licensed)
- No per-seat pricing or proprietary cloud dependency

It's not trying to be the best reviewer on the market. It's trying to be a useful one with no lock-in. If you want best-in-class commercial review, use Greptile or CodeRabbit. If you want something you control, use this.

## Related projects

- [`pr-agent`](https://github.com/qodo-ai/pr-agent) (Qodo, Apache 2.0) — closest OSS alternative; mature, multi-model, similar pitch. If pr-agent works for you, use pr-agent. enkii differs mainly in skill markdown as the customization unit + runtime-agnostic methodology.
- [`Factory-AI/droid-action`](https://github.com/Factory-AI/droid-action) (MIT) — Factory's open-sourced action plumbing. enkii borrows the GitHub auth + PR data fetching + prompt scaffolding from here, replaces the closed `droid` CLI runtime with OpenCode + OpenRouter.
- [GitHub Copilot Code Review](https://docs.github.com/copilot) — native to GitHub. Use this if you're on a Copilot plan and don't need self-hosted.

## License

MIT. See [LICENSE](LICENSE).

## Contributing

Project is in early development, contribution guide coming once the v0.5 beta lands. Issues + ideas welcome.
