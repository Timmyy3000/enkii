import { execFileSync } from "child_process";
import { writeFile, mkdir } from "fs/promises";
import type { Octokits } from "../api/client";
import { GITHUB_SERVER_URL } from "../api/config";
import type { ReviewArtifacts } from "../../prompts/types";

const DIFF_MAX_BUFFER = 50 * 1024 * 1024; // 50MB buffer for large diffs

type DiffOptions = {
  githubToken?: string;
  prNumber?: number;
  octokit?: Octokits;
  owner?: string;
  repo?: string;
  expectedBaseSha?: string;
  expectedHeadSha?: string;
  cwd?: string;
};

/**
 * Compute the PR diff and store it on disk.
 *
 * Prefer GitHub's PR diff. Its 406 response (including the line limit) uses
 * a complete local merge-base diff of the verified PR commits instead.
 */
export async function computeAndStoreDiff(
  baseRef: string,
  tempDir: string,
  options?: DiffOptions,
): Promise<string> {
  const promptsDir = `${tempDir}/enkii-prompts`;
  await mkdir(promptsDir, { recursive: true });

  let diff: string | Buffer;
  if (options?.octokit && options.owner && options.repo && options.prNumber) {
    try {
      diff = await fetchPullRequestDiff({
        octokit: options.octokit,
        owner: options.owner,
        repo: options.repo,
        prNumber: options.prNumber,
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 406
      ) {
        console.warn(
          "GitHub diff API returned 406; using verified local git diff",
        );
        diff = computeLocalDiff(baseRef, options);
      } else {
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
    }
  } else {
    diff = computeLocalDiff(baseRef, options);
  }

  const diffBytes = Buffer.byteLength(diff, "utf8");
  if (diffBytes > DIFF_MAX_BUFFER) {
    throw new Error(
      "PR diff exceeds the 50 MiB limit; refusing to store a partial review artifact",
    );
  }
  const diffPath = `${promptsDir}/pr.diff`;
  await writeFile(diffPath, diff);
  console.log(`Stored PR diff (${diffBytes} bytes) at ${diffPath}`);
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
  const diff = execFileSync("gh", command, {
    encoding: "utf8",
    maxBuffer: DIFF_MAX_BUFFER,
    env: { ...process.env, GH_TOKEN: args.githubToken },
  });
  if (diff.length === 0) {
    throw new Error(`gh returned an empty diff for PR #${args.prNumber}`);
  }
  return diff;
}

function computeLocalDiff(baseRef: string, options?: DiffOptions): Buffer {
  const baseSha = options?.expectedBaseSha;
  const headSha = options?.expectedHeadSha;
  const fullSha = /^[0-9a-f]{40}$/;
  if (
    !baseSha ||
    !headSha ||
    !fullSha.test(baseSha) ||
    !fullSha.test(headSha)
  ) {
    throw new Error(
      "Local PR diff requires full immutable base and head commit SHAs",
    );
  }

  const owner = options?.owner;
  const repo = options?.repo;
  if (
    !owner ||
    !repo ||
    !/^[A-Za-z0-9_-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repo) ||
    repo === "." ||
    repo === ".."
  ) {
    throw new Error(
      "Local PR diff requires a valid base repository owner and name",
    );
  }
  const server = new URL(GITHUB_SERVER_URL);
  if (
    server.protocol !== "https:" ||
    server.username ||
    server.password ||
    server.search ||
    server.hash
  ) {
    throw new Error(
      "Local PR diff requires an HTTPS GitHub server URL without credentials, query, or fragment",
    );
  }
  // origin may be a contributor's fork without the target's base commit.
  const baseRepository = `${server.href.replace(/\/$/, "")}/${owner}/${repo}.git`;

  const git = (args: string[]) =>
    execFileSync("git", ["--no-replace-objects", ...args], {
      stdio: "pipe",
      maxBuffer: DIFF_MAX_BUFFER,
      cwd: options?.cwd,
    });
  const actualHead = git(["rev-parse", "--verify", "HEAD^{commit}"])
    .toString("utf8")
    .trim();
  if (actualHead !== headSha) {
    throw new Error(
      `Local PR diff refused: checked out ${actualHead}, expected PR head ${headSha}`,
    );
  }
  if (
    git(["rev-parse", "--is-shallow-repository"]).toString("utf8").trim() ===
    "true"
  ) {
    throw new Error(
      "Local PR diff requires full history; configure actions/checkout with fetch-depth: 0",
    );
  }

  // Without --refetch, Git can report success for a cached SHA without even
  // contacting the server. Reuse Git's scoped checkout credentials/helpers;
  // never put tokens in the URL, arguments, or persistent configuration.
  git([
    "fetch",
    "--refetch",
    "--no-tags",
    "--no-recurse-submodules",
    baseRepository,
    baseSha,
  ]);
  if (git(["cat-file", "-t", baseSha]).toString("utf8").trim() !== "commit") {
    throw new Error(`Local PR diff refused: base ${baseSha} is not a commit`);
  }
  const mergeBase = git(["merge-base", "--all", headSha, baseSha])
    .toString("utf8")
    .trim();
  if (!fullSha.test(mergeBase)) {
    throw new Error(
      `Local PR diff refused: no unique merge-base for ${baseRef}`,
    );
  }

  const diff = git([
    "--no-pager",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-relative",
    "--binary",
    "--full-index",
    "--no-renames",
    "--ignore-submodules=none",
    "--submodule=short",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    `${mergeBase}..${headSha}`,
    "--",
  ]);
  if (diff.length === 0) {
    throw new Error(`Local PR diff was empty for ${baseRef}`);
  }
  return diff;
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
    octokit.rest.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    }),
    octokit.rest.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  ]);

  const comments = {
    issueComments,
    reviewComments,
  };

  const commentsPath = `${promptsDir}/existing_comments.json`;
  await writeFile(commentsPath, JSON.stringify(comments, null, 2));
  console.log(
    `Stored existing comments (${issueComments.length} issue, ${reviewComments.length} review) at ${commentsPath}`,
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
  expectedBaseSha?: string;
  expectedHeadSha?: string;
  ignoreExistingComments?: boolean;
}): Promise<ReviewArtifacts> {
  const [diffPath, commentsPath, descriptionPath] = await Promise.all([
    computeAndStoreDiff(opts.baseRef, opts.tempDir, {
      githubToken: opts.githubToken,
      prNumber: opts.prNumber,
      octokit: opts.octokit,
      owner: opts.owner,
      repo: opts.repo,
      expectedBaseSha: opts.expectedBaseSha,
      expectedHeadSha: opts.expectedHeadSha,
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
