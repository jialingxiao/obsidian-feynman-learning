// ─── AI response types ───────────────────────────────────────────────────────

export interface ReviewDimension {
  label: string;
  score: "✓" | "△" | "✗";
  note: string;
}

export interface ReviewVerdict {
  passed: boolean;
  dimensions: ReviewDimension[];
  feedback: string;
}

export interface ExtractedConcept {
  name: string;
  reason: string;
}

// ─── Domain constants ────────────────────────────────────────────────────────

export const REVIEW_INTERVALS = [1, 7, 30];
export const MASTERY_LEVELS = ["初识", "理解", "掌握", "精通"];

// ─── Pure utility functions ───────────────────────────────────────────────────

export function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}

export function yamlStr(value: string): string {
  if (/[:#[\]{}&*!|>'"@`]/.test(value) || value.startsWith(" ") || value.endsWith(" ")) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

export function truncate(text: string, max = 1900): string {
  return text.length > max ? text.slice(0, max) + "…（已截断）" : text;
}

export function parseApiError(status: number, body: Record<string, unknown>): string {
  const errObj = body?.error as Record<string, unknown> | undefined;
  const rawMsg = errObj?.message ?? body?.message;
  const msg: string = typeof rawMsg === "string" ? rawMsg : "";
  if (status === 401) return "API Key 无效或已过期，请检查设置中的 Key";
  if (status === 403) return "无权限访问该模型，请检查 Key 或模型名称";
  if (status === 404) return "接口地址或模型不存在，请检查 API Base URL 和模型名称";
  if (status === 429) return "请求过于频繁或余额不足，请稍后再试";
  if (status >= 500)  return "AI 服务暂时不可用，请稍后再试";
  if (/model/.test(msg))                              return `模型不存在或无权限：${msg}`;
  if (/quota|balance|insufficient|credit/.test(msg)) return `余额不足：${msg}`;
  return msg || `请求失败（HTTP ${status}）`;
}

// ─── AI response parsers ──────────────────────────────────────────────────────

/**
 * Parse a raw AI text response into a structured ReviewVerdict.
 * Tries JSON first (handles markdown fences); falls back to regex.
 */
export function parseReviewVerdict(text: string): ReviewVerdict {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const raw = JSON.parse(jsonMatch[0]);
      if (Array.isArray(raw?.dimensions) && raw.dimensions.length > 0) {
        return {
          passed: !!raw.passed,
          dimensions: (raw.dimensions as { label?: unknown; score?: unknown; note?: unknown }[]).map(d => ({
            label: typeof d.label === "string" ? d.label : "",
            score: (["✓", "△", "✗"].includes(String(d.score)) ? String(d.score) : "✗") as "✓" | "△" | "✗",
            note: typeof d.note === "string" ? d.note : "",
          })),
          feedback: String(raw.feedback ?? ""),
        };
      }
    } catch { /* fall through */ }
  }
  // Fallback: regex parsing
  console.warn("[feynman] parseReviewVerdict: no valid JSON, falling back to regex");
  const passed = text.includes("判定：通过");
  const dimensions: ReviewDimension[] = [];
  for (const label of ["语言简洁", "核心机制", "举例说明"] as const) {
    const m = text.match(new RegExp(`${label}：([✓△✗])(.*)`, "m"));
    if (m) dimensions.push({ label, score: m[1] as "✓" | "△" | "✗", note: m[2].trim() });
  }
  const feedback = text.match(/评价：([\s\S]*)/)?.[1]?.trim() ?? "";
  return { passed, dimensions, feedback };
}

/**
 * Parse a raw AI text response into an array of ExtractedConcepts.
 * Tries JSON array first; falls back to line-by-line text parsing.
 */
export function parseExtractedConcepts(text: string): ExtractedConcept[] {
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const raw = JSON.parse(arrMatch[0]);
      if (Array.isArray(raw) && raw.length > 0) {
        const concepts = (raw as { name?: unknown; reason?: unknown }[])
          .filter(c => c?.name)
          .map(c => ({ name: (typeof c.name === "string" ? c.name : "").trim(), reason: (typeof c.reason === "string" ? c.reason : "").trim() }))
          .filter(c => c.name.length > 0)
          .slice(0, 8);
        if (concepts.length > 0) return concepts;
      }
    } catch { /* fall through */ }
  }
  console.warn("[feynman] parseExtractedConcepts: no valid JSON array, falling back to text parsing");
  return text
    .split("\n")
    .filter(l => l.trim())
    .map(l => {
      const m = l.match(/「(.+?)」[—\-–]\s*(.*)/);
      return m
        ? { name: m[1].trim(), reason: m[2].trim() }
        : { name: l.replace(/「|」/g, "").trim(), reason: "" };
    })
    .filter(c => c.name.length > 0)
    .slice(0, 8);
}

/**
 * Calculate the next review interval in days after a review attempt.
 *
 * @param reviewCount  - review_count value before this attempt
 * @param passed       - whether the review was judged as passed
 * @param partialPass  - passed but some dimensions were △ → 0.6× interval
 * @param expertPass   - passed with all dimensions ✓ → 1.3× interval
 * @param intervals    - custom interval ladder (defaults to REVIEW_INTERVALS)
 * @returns days until next review, or null when fully mastered (no more reviews)
 */
export function calcNextInterval(
  reviewCount: number,
  passed: boolean,
  partialPass: boolean,
  expertPass: boolean,
  intervals: readonly number[] = REVIEW_INTERVALS,
): number | null {
  if (!passed) return 1;                                    // retry tomorrow
  const raw: number | null = intervals[reviewCount + 1] ?? null;
  if (raw === null) return null;                            // fully mastered
  if (expertPass)   return Math.round(raw * 1.3);
  if (partialPass)  return Math.max(1, Math.round(raw * 0.6));
  return raw;
}
