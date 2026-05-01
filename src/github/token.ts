/**
 * GitHub token resolution. Two modes:
 *
 *   1. Default: GITHUB_TOKEN provided via the `github_token` action input
 *      (typically `${{ github.token }}`). What 99% of consumers will use.
 *   2. Optional GitHub App: APP_ID + APP_PRIVATE_KEY env vars mint an
 *      installation token. Useful for higher rate limits or a custom bot
 *      identity.
 *
 * Fails fast if no token is available. Fork-safe degraded mode (token-less
 * runs for fork PRs) is a v1 feature.
 */

import * as core from "@actions/core";
import { createAppAuth } from "@octokit/auth-app";

async function getGitHubAppToken(
  appId: string,
  privateKey: string,
): Promise<string> {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error(
      "GitHub App auth requires GITHUB_REPOSITORY env var (set automatically by GitHub Actions).",
    );
  }
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(
      `GITHUB_REPOSITORY is malformed: "${repository}" (expected "owner/repo").`,
    );
  }

  const auth = createAppAuth({
    appId,
    privateKey,
  });

  // Find the installation for this repo, then mint a scoped installation token.
  const appAuth = await auth({ type: "app" });
  const appOctokitHeaders = {
    authorization: `Bearer ${appAuth.token}`,
    accept: "application/vnd.github.v3+json",
  };
  const installationResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/installation`,
    { headers: appOctokitHeaders },
  );
  if (!installationResp.ok) {
    throw new Error(
      `Could not find a GitHub App installation for ${owner}/${repo}. ` +
        `Status: ${installationResp.status}. ` +
        `Make sure your GitHub App is installed on this repo.`,
    );
  }
  const installation = (await installationResp.json()) as { id: number };

  const installationAuth = await auth({
    type: "installation",
    installationId: installation.id,
  });
  return installationAuth.token;
}

export async function setupGitHubToken(): Promise<string> {
  try {
    const providedToken = process.env.OVERRIDE_GITHUB_TOKEN;
    if (providedToken && providedToken.trim() !== "") {
      console.log("Using provided GITHUB_TOKEN for authentication");
      core.setOutput("GITHUB_TOKEN", providedToken);
      return providedToken;
    }

    const appId = process.env.APP_ID;
    const privateKey = process.env.APP_PRIVATE_KEY;
    if (appId && privateKey) {
      console.log("Using GitHub App credentials for authentication");
      const token = await getGitHubAppToken(appId, privateKey);
      core.setOutput("GITHUB_TOKEN", token);
      return token;
    }

    throw new Error(
      "enkii could not authenticate to GitHub. Cause: no token available. " +
        "Fix: pass `github_token: ${{ github.token }}` in the action's `with:` block, " +
        "OR set APP_ID + APP_PRIVATE_KEY env vars for GitHub App auth.",
    );
  } catch (error) {
    core.setFailed(
      `Failed to setup GitHub token: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
