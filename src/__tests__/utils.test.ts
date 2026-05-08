import {
  calcNextInterval, parseApiError, sanitizeFilename, yamlStr, truncate,
  REVIEW_INTERVALS, parseReviewVerdict, parseExtractedConcepts,
} from "../utils";

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

// ─── parseReviewVerdict ───────────────────────────────────────────────────────

describe("parseReviewVerdict", () => {
  const validJson = JSON.stringify({
    passed: true,
    dimensions: [
      { label: "语言简洁", score: "✓", note: "表达清晰" },
      { label: "核心机制", score: "△", note: "缺少细节" },
      { label: "举例说明", score: "✓", note: "例子恰当" },
    ],
    feedback: "整体不错",
  });

  test("parses clean JSON correctly", () => {
    const result = parseReviewVerdict(validJson);
    expect(result.passed).toBe(true);
    expect(result.dimensions).toHaveLength(3);
    expect(result.dimensions[0]).toEqual({ label: "语言简洁", score: "✓", note: "表达清晰" });
    expect(result.feedback).toBe("整体不错");
  });

  test("parses JSON wrapped in markdown fences", () => {
    const fenced = "```json\n" + validJson + "\n```";
    const result = parseReviewVerdict(fenced);
    expect(result.passed).toBe(true);
    expect(result.dimensions).toHaveLength(3);
  });

  test("invalid score value defaults to ✗", () => {
    const bad = JSON.stringify({
      passed: false,
      dimensions: [{ label: "语言简洁", score: "INVALID", note: "" }],
      feedback: "",
    });
    const result = parseReviewVerdict(bad);
    expect(result.dimensions[0].score).toBe("✗");
  });

  test("falls back to regex parsing when no valid JSON", () => {
    const text = "判定：通过\n语言简洁：✓ 不错\n核心机制：△ 需加强\n举例说明：✓ 好\n评价：总体良好";
    const result = parseReviewVerdict(text);
    expect(result.passed).toBe(true);
    expect(result.dimensions.find(d => d.label === "语言简洁")?.score).toBe("✓");
    expect(result.dimensions.find(d => d.label === "核心机制")?.score).toBe("△");
    expect(result.feedback).toBe("总体良好");
  });

  test("regex fallback: fail verdict", () => {
    const text = "判定：未通过\n核心机制：✗ 解释不到位\n评价：继续努力";
    const result = parseReviewVerdict(text);
    expect(result.passed).toBe(false);
    expect(result.dimensions.find(d => d.label === "核心机制")?.score).toBe("✗");
  });
});

// ─── parseExtractedConcepts ───────────────────────────────────────────────────

describe("parseExtractedConcepts", () => {
  const validArr = JSON.stringify([
    { name: "复利", reason: "核心财务概念" },
    { name: "边际效用", reason: "经济学基础" },
  ]);

  test("parses clean JSON array correctly", () => {
    const result = parseExtractedConcepts(validArr);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: "复利", reason: "核心财务概念" });
  });

  test("parses JSON array wrapped in markdown fences", () => {
    const fenced = "```json\n" + validArr + "\n```";
    const result = parseExtractedConcepts(fenced);
    expect(result).toHaveLength(2);
    expect(result[1].name).toBe("边际效用");
  });

  test("filters out items without a name", () => {
    const arr = JSON.stringify([{ reason: "no name here" }, { name: "保留", reason: "" }]);
    const result = parseExtractedConcepts(arr);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("保留");
  });

  test("caps at 8 items", () => {
    const arr = JSON.stringify(
      Array.from({ length: 12 }, (_, i) => ({ name: `概念${i}`, reason: "" }))
    );
    const result = parseExtractedConcepts(arr);
    expect(result).toHaveLength(8);
  });

  test("falls back to text parsing with 「」 format", () => {
    const text = "「复利」— 利滚利\n「边际效用」— 递减规律";
    const result = parseExtractedConcepts(text);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("复利");
    expect(result[0].reason).toBe("利滚利");
  });

  test("text fallback: plain lines without 「」", () => {
    const text = "复利\n边际效用";
    const result = parseExtractedConcepts(text);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("复利");
    expect(result[0].reason).toBe("");
  });
});
