import { expect, test } from "bun:test";
import { parseEnkiiCommand } from "./command-parser";

test("parses benchmark command", () => {
  expect(parseEnkiiCommand("@enkii /benchmark")?.command).toBe("benchmark");
});

test("parses review command", () => {
  expect(parseEnkiiCommand("@enkii /review")?.command).toBe("review");
});

test("parses bare mention as default", () => {
  expect(parseEnkiiCommand("@enkii")?.command).toBe("default");
});
