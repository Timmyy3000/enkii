import { execFileSync, execSync } from "child_process";
import { writeFile, mkdir } from "fs/promises";
import type { Octokits } from "../api/client";
import type { ReviewArtifacts } from "../../prompts/types";

const DIFF_MAX_BUFFER = 50 * 1024 * 1024; // 50MB buffer for large diffs

/**
 * Compute the PR diff and store it on disk.
 *
 * Tries git merge-base first (requires sufficient history). When that
 * fails (e.g. shallow clone without unshallow support) it falls back
 * to `gh pr diff` which always works.
 */
export async function computeAndStoreDiff(
  baseRef: string,
  tempDir: string,
  options?: {
    githubToken?: string;
    prNumber?: number;
    octokit?: Octokits;
    owner?: string;
    repo?: string;
  },
): Promise<string> {
  const promptsDir = `${tempDir}/enkii-prompts`;
  await mkdir(promptsDir, { recursive: true });

  let diff: string;
  if (options?.octokit && options.owner && options.repo && options.prNumber) {
    try {
      diff = await fetchPullRequestDiff({
        octokit: options.octokit,
        owner: options.owner,
        repo: options.repo,
        prNumber: options.prNumber,
      });
    } catch (error) {
      if (!options.githubToken) throw error;
      console.warn(
        `GitHub diff API failed, falling back to gh pr diff: ${error instanceof Error ? error.message : String(error)}`,
      );
      diff = fetchGhPullRequestDiff({
        githubToken: options.githubToken,
        owner: options.owner,
        repo: options.repo,
        prNumber: options.prNumber,
      });
    }
  } else {
    diff = computeLocalDiff(baseRef, options);
  }

  const diffPath = `${promptsDir}/pr.diff`;
  await writeFile(diffPath, diff);
  console.log(`Stored PR diff (${diff.length} bytes) at ${diffPath}`);
  return diffPath;
}

async function fetchPullRequestDiff(args: {
  octokit: Octokits;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<string> {
  console.log(`Fetching PR diff from GitHub for #${args.prNumber}`);
  const response = await args.octokit.rest.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    {
      owner: args.owner,
      repo: args.repo,
      pull_number: args.prNumber,
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
    },
  );
  const data: unknown = response.data;
  if (typeof data !== "string") {
    throw new Error(
      `GitHub returned ${typeof data} instead of a text diff for PR #${args.prNumber}`,
    );
  }
  const diff = data;
  if (diff.length === 0) {
    throw new Error(`GitHub returned an empty diff for PR #${args.prNumber}`);
  }
  return diff;
}

function fetchGhPullRequestDiff(args: {
  githubToken: string;
  owner?: string;
  repo?: string;
  prNumber: number;
}): string {
  const command = ["pr", "diff", String(args.prNumber)];
  if (args.owner && args.repo) {
    command.push("--repo", `${args.owner}/${args.repo}`);
  }
  return execFileSync("gh", command, {
    encoding: "utf8",
    maxBuffer: DIFF_MAX_BUFFER,
    env: { ...process.env, GH_TOKEN: args.githubToken },
  });
}

function computeLocalDiff(
  baseRef: string,
  options?: { githubToken?: string; prNumber?: number },
): string {
  try {
    // Unshallow the repo if it's a shallow clone (needed for merge-base)
    try {
      execSync("git rev-parse --is-shallow-repository", {
        encoding: "utf8",
        stdio: "pipe",
      }).trim() === "true" &&
        execFileSync("git", ["fetch", "--unshallow"], {
          encoding: "utf8",
          stdio: "pipe",
        });
      console.log("Unshallowed repository");
    } catch {
      console.log("Repository already has full history");
    }

    // Fetch the base branch (it may not exist locally yet)
    try {
      execFileSync(
        "git",
        ["fetch", "origin", `${baseRef}:refs/remotes/origin/${baseRef}`],
        {
          encoding: "utf8",
          stdio: "pipe",
        },
      );
      console.log(`Fetched base branch: ${baseRef}`);
    } catch {
      console.log(`Base branch fetch skipped (may already exist): ${baseRef}`);
    }

    const mergeBase = execSync(
      `git merge-base HEAD refs/remotes/origin/${baseRef}`,
      { encoding: "utf8" },
    ).trim();

    return execSync(`git --no-pager diff ${mergeBase}..HEAD`, {
      encoding: "utf8",
      maxBuffer: DIFF_MAX_BUFFER,
    });
  } catch {
    // Fallback: use gh CLI to get the diff (works even with shallow clones)
    if (options?.githubToken && options?.prNumber) {
      console.log(
        "Git merge-base failed, falling back to gh pr diff for PR diff",
      );
      return fetchGhPullRequestDiff({
        githubToken: options.githubToken,
        prNumber: options.prNumber,
      });
    } else {
      throw new Error(
        "Git merge-base failed and no fallback credentials provided",
      );
    }
  }
}

export async function fetchAndStoreComments(
  octokit: Octokits,
  owner: string,
  repo: string,
  prNumber: number,
  tempDir: string,
): Promise<string> {
  const promptsDir = `${tempDir}/enkii-prompts`;
  await mkdir(promptsDir, { recursive: true });

  const [issueComments, reviewComments] = await Promise.all([
    octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    }),
    octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  ]);

  const comments = {
    issueComments: issueComments.data,
    reviewComments: reviewComments.data,
  };

  const commentsPath = `${promptsDir}/existing_comments.json`;
  await writeFile(commentsPath, JSON.stringify(comments, null, 2));
  console.log(
    `Stored existing comments (${issueComments.data.length} issue, ${reviewComments.data.length} review) at ${commentsPath}`,
  );
  return commentsPath;
}

export async function storeEmptyComments(tempDir: string): Promise<string> {
  const promptsDir = `${tempDir}/enkii-prompts`;
  await mkdir(promptsDir, { recursive: true });

  const commentsPath = `${promptsDir}/existing_comments.json`;
  await writeFile(
    commentsPath,
    JSON.stringify({ issueComments: [], reviewComments: [] }, null, 2),
  );
  console.log(
    `Stored empty existing comments for benchmark at ${commentsPath}`,
  );
  return commentsPath;
}

export async function storeDescription(
  title: string,
  body: string,
  tempDir: string,
): Promise<string> {
  const promptsDir = `${tempDir}/enkii-prompts`;
  await mkdir(promptsDir, { recursive: true });

  const content = `# ${title}\n\n${body}`;
  const descriptionPath = `${promptsDir}/pr_description.txt`;
  await writeFile(descriptionPath, content);
  console.log(
    `Stored PR description (${content.length} bytes) at ${descriptionPath}`,
  );
  return descriptionPath;
}

/**
 * Pre-compute all review artifacts (diff, comments, description) in parallel.
 */
export async function computeReviewArtifacts(opts: {
  baseRef: string;
  tempDir: string;
  octokit: Octokits;
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  body: string;
  githubToken?: string;
  ignoreExistingComments?: boolean;
}): Promise<ReviewArtifacts> {
  const [diffPath, commentsPath, descriptionPath] = await Promise.all([
    computeAndStoreDiff(opts.baseRef, opts.tempDir, {
      githubToken: opts.githubToken,
      prNumber: opts.prNumber,
      octokit: opts.octokit,
      owner: opts.owner,
      repo: opts.repo,
    }),
    opts.ignoreExistingComments
      ? storeEmptyComments(opts.tempDir)
      : fetchAndStoreComments(
          opts.octokit,
          opts.owner,
          opts.repo,
          opts.prNumber,
          opts.tempDir,
        ),
    storeDescription(opts.title, opts.body, opts.tempDir),
  ]);

  return { diffPath, commentsPath, descriptionPath };
}
