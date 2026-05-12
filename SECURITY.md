# Security Policy

## Supported Versions

enkii is early-stage. Security fixes are prioritized on the latest release tag and `main`.

## Reporting a Vulnerability

Do **not** open a public issue for vulnerabilities.

Report privately by emailing the maintainer or opening a private security advisory on GitHub:

- GitHub Security Advisories (preferred)
- Include: impact, repro steps, affected version/tag, and suggested mitigation if available

## Scope

High-priority areas:

- GitHub token handling
- Secret handling (`OPENROUTER_API_KEY`)
- Prompt/skill loading from untrusted sources (fork PR paths)
- Command injection or arbitrary file access paths

## Disclosure

After a fix is released, we’ll publish a changelog/security note with affected versions and remediation guidance.
