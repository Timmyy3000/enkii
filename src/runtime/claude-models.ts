import type { Usage } from "@mariozechner/pi-ai";

type RateCard = {
  /** Largest prompt, in tokens, this card applies to. The last card has none. */
  promptUpTo?: number;
  input: number;
  output: number;
  cacheRead: number;
};

export type ClaudeModelSpec = {
  maxOutputTokens: number;
  contextWindow: number;
  /** USD per million tokens, ordered by `promptUpTo`. */
  rates: RateCard[];
};

const CACHE_WRITE_MULTIPLIER = 1.25;

const flat = (input: number, output: number, cacheRead: number): RateCard[] => [
  { input, output, cacheRead },
];

export const CLAUDE_MODELS: Record<string, ClaudeModelSpec> = {
  "claude-haiku-5-5": {
    maxOutputTokens: 128_000,
    contextWindow: 1_000_000,
    rates: [
      { promptUpTo: 100_000, input: 0.1, output: 0.5, cacheRead: 0.01 },
      { input: 0.5, output: 2.5, cacheRead: 0.05 },
    ],
  },
  "claude-sonnet-5-5": {
    maxOutputTokens: 128_000,
    contextWindow: 1_000_000,
    rates: flat(2, 10, 0.2),
  },
  "claude-sonnet-5": {
    maxOutputTokens: 128_000,
    contextWindow: 1_000_000,
    rates: flat(2, 10, 0.2),
  },
  "claude-opus-5-5": {
    maxOutputTokens: 128_000,
    contextWindow: 1_000_000,
    rates: flat(4, 20, 0.2),
  },
  "claude-opus-5": {
    maxOutputTokens: 128_000,
    contextWindow: 1_000_000,
    rates: flat(5, 25, 0.5),
  },
  "claude-fable-5-1": {
    maxOutputTokens: 128_000,
    contextWindow: 1_000_000,
    rates: flat(10, 50, 0.25),
  },
};

export function claudeModelSpec(modelId: string): ClaudeModelSpec | undefined {
  return CLAUDE_MODELS[modelId];
}

export function promptTokens(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** Prices one request. The rate card is chosen by that request's prompt size. */
export function priceUsage(spec: ClaudeModelSpec, usage: Usage): Usage["cost"] {
  const prompt = promptTokens(usage);
  const card =
    spec.rates.find((rate) => rate.promptUpTo === undefined || prompt <= rate.promptUpTo) ??
    spec.rates[spec.rates.length - 1]!;
  const perToken = (rate: number) => rate / 1_000_000;
  const cost = {
    input: usage.input * perToken(card.input),
    output: usage.output * perToken(card.output),
    cacheRead: usage.cacheRead * perToken(card.cacheRead),
    cacheWrite: usage.cacheWrite * perToken(card.input * CACHE_WRITE_MULTIPLIER),
    total: 0,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return cost;
}
