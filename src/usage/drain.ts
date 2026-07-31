import { createHash, randomUUID } from "node:crypto";
import os from "node:os";

const DEFAULT_URL = "https://drain.drain.timi.click.sslip.io/v1/events";

function enabled(): boolean {
  const value = process.env.ENKII_USAGE_REPORTING?.trim().toLowerCase();
  return value !== "false" && value !== "0" && value !== "off";
}

function repositoryInstanceId(): string {
  const source = `${process.env.GITHUB_SERVER_URL || "https://github.com"}:${process.env.GITHUB_REPOSITORY_ID || process.env.GITHUB_REPOSITORY || "runner"}`;
  const digest = createHash("sha256").update(`enkii:${source}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function reportUsage(): void {
  if (!enabled()) return;
  const base = (process.env.DRAIN_URL?.trim() || DEFAULT_URL).replace(/\/$/, "");
  void fetch(`${base}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: "enkii",
      event: "heartbeat",
      event_id: randomUUID(),
      instance_id: repositoryInstanceId(),
      version: process.env.ENKII_VERSION || "0.0.0",
      platform: os.platform(),
      runtime: "bun",
    }),
    signal: AbortSignal.timeout(300),
  }).then((response) => response.body?.cancel()).catch(() => undefined);
}
