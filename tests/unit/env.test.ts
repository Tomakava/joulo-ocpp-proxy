import { describe, expect, it } from "vitest";

import { parsePositiveInteger } from "../../src/env";

describe("parsePositiveInteger", () => {
  it("returns fallback when value is undefined", () => {
    expect(parsePositiveInteger(undefined, 42)).toBe(42);
  });

  it("returns fallback when string is blank", () => {
    expect(parsePositiveInteger("   ", 12)).toBe(12);
  });

  it("returns fallback for non-positive numbers", () => {
    expect(parsePositiveInteger("0", 12)).toBe(12);
    expect(parsePositiveInteger("-8", 12)).toBe(12);
  });

  it("parses positive integers", () => {
    expect(parsePositiveInteger("7", 12)).toBe(7);
  });

  it("ignores leading/trailing whitespace", () => {
    expect(parsePositiveInteger("  13  ", 12)).toBe(13);
  });
});
