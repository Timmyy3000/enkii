import { describe, expect, test } from "bun:test";
import { CLAUDE_MODELS, priceUsage } from "./claude-models";

const usage = (
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("priceUsage", () => {
  test("prices a Haiku 5.5 request at or under 100K prompt tokens on the low card", () => {
    const cost = priceUsage(
      CLAUDE_MODELS["claude-haiku-5-5"]!,
      usage(1_000, 90_000, 9_000, 20_000),
    );
    expect(cost.total).toBeCloseTo(0.0001 + 0.0009 + 0.001125 + 0.01, 8);
  });

  test("prices the whole request on the high card once the prompt passes 100K", () => {
    const cost = priceUsage(
      CLAUDE_MODELS["claude-haiku-5-5"]!,
      usage(1_000, 100_000, 0, 20_000),
    );
    expect(cost.output).toBeCloseTo(0.05, 8);
    expect(cost.cacheRead).toBeCloseTo(0.005, 8);
    expect(cost.total).toBeCloseTo(0.0005 + 0.005 + 0.05, 8);
  });
});
