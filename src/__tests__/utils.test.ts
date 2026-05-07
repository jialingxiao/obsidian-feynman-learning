import { calcNextInterval, parseApiError, sanitizeFilename, yamlStr, truncate, REVIEW_INTERVALS } from "../utils";

// ─── calcNextInterval ─────────────────────────────────────────────────────────

describe("calcNextInterval", () => {
  test("fail always returns 1 day", () => {
    expect(calcNextInterval(0, false, false, false)).toBe(1);
    expect(calcNextInterval(2, false, false, false)).toBe(1);
  });

  test("normal pass returns the next interval", () => {
    // count=0 → next slot is index 1 → 7 days
    expect(calcNextInterval(0, true, false, false)).toBe(REVIEW_INTERVALS[1]);
    // count=1 → next slot is index 2 → 30 days
    expect(calcNextInterval(1, true, false, false)).toBe(REVIEW_INTERVALS[2]);
  });

  test("expert pass applies ×1.3 multiplier", () => {
    // count=0, next raw=7 → Math.round(7×1.3)=9
    expect(calcNextInterval(0, true, false, true)).toBe(Math.round(7 * 1.3));
  });

  test("partial pass applies ×0.6 multiplier", () => {
    // count=0, next raw=7 → Math.max(1, Math.round(7×0.6))=4
    expect(calcNextInterval(0, true, true, false)).toBe(Math.max(1, Math.round(7 * 0.6)));
  });

  test("returns null when fully mastered (no more intervals)", () => {
    // count=2 is the last valid entry; count=3 → beyond array → null
    expect(calcNextInterval(2, true, false, false)).toBeNull();
  });
});

// ─── parseApiError ────────────────────────────────────────────────────────────

describe("parseApiError", () => {
  test("401 returns key error message", () => {
    expect(parseApiError(401, {})).toContain("API Key");
  });

  test("404 returns endpoint error message", () => {
    expect(parseApiError(404, {})).toContain("接口地址");
  });

  test("429 returns rate limit message", () => {
    expect(parseApiError(429, {})).toContain("频繁");
  });

  test("500+ returns service unavailable", () => {
    expect(parseApiError(500, {})).toContain("不可用");
    expect(parseApiError(503, {})).toContain("不可用");
  });

  test("quota message in body triggers balance error", () => {
    const result = parseApiError(400, { error: { message: "insufficient quota" } });
    expect(result).toContain("余额不足");
  });

  test("unknown error falls back to HTTP status", () => {
    expect(parseApiError(418, {})).toContain("418");
  });
});

// ─── sanitizeFilename ─────────────────────────────────────────────────────────

describe("sanitizeFilename", () => {
  test("replaces forbidden chars with dash", () => {
    expect(sanitizeFilename("foo/bar:baz")).toBe("foo-bar-baz");
  });

  test("collapses multiple spaces", () => {
    expect(sanitizeFilename("foo  bar")).toBe("foo bar");
  });

  test("trims leading/trailing whitespace", () => {
    expect(sanitizeFilename("  hello  ")).toBe("hello");
  });
});

// ─── yamlStr ─────────────────────────────────────────────────────────────────

describe("yamlStr", () => {
  test("plain strings are returned as-is", () => {
    expect(yamlStr("hello")).toBe("hello");
  });

  test("strings with colons are quoted", () => {
    const result = yamlStr("key: value");
    expect(result.startsWith('"')).toBe(true);
  });

  test("double quotes inside are escaped", () => {
    const result = yamlStr('say "hi"');
    expect(result).toContain('\\"');
  });
});

// ─── truncate ─────────────────────────────────────────────────────────────────

describe("truncate", () => {
  test("short strings pass through unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  test("long strings are cut and appended with ellipsis", () => {
    const result = truncate("abcdef", 3);
    expect(result.startsWith("abc")).toBe(true);
    expect(result).toContain("…");
  });
});
