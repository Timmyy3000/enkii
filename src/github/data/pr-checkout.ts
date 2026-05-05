import { execFileSync } from "child_process";

export function checkoutPullRequestHead(args: {
  prNumber: number;
  headSha: string;
}): void {
  const remoteRef = `refs/remotes/origin/enkii/pr-${args.prNumber}`;
  console.log(
    `enkii: fetching PR #${args.prNumber} head ${args.headSha} for local review context...`,
  );

  execFileSync(
    "git",
    [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/pull/${args.prNumber}/head:${remoteRef}`,
    ],
    { encoding: "utf8", stdio: "pipe" },
  );

  execFileSync("git", ["checkout", "--detach", args.headSha], {
    encoding: "utf8",
    stdio: "pipe",
  });

  const actualSha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
  if (actualSha !== args.headSha) {
    throw new Error(
      `enkii: checked out ${actualSha}, expected PR head ${args.headSha}`,
    );
  }

  console.log(`enkii: checked out PR head ${actualSha}`);
}
