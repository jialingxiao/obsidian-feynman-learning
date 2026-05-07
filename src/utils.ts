// ─── Domain constants ────────────────────────────────────────────────────────

export const REVIEW_INTERVALS = [1, 7, 30];
export const MASTERY_LEVELS = ["初识", "理解", "掌握", "精通"];

// ─── Pure utility functions ───────────────────────────────────────────────────

export function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}

export function yamlStr(value: string): string {
  if (/[:#\[\]{}&*!|>'"@`]/.test(value) || value.startsWith(" ") || value.endsWith(" ")) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

export function truncate(text: string, max = 1900): string {
  return text.length > max ? text.slice(0, max) + "…（已截断）" : text;
}

export function parseApiError(status: number, body: any): string {
  const msg: string = body?.error?.message ?? body?.message ?? "";
  if (status === 401) return "API Key 无效或已过期，请检查设置中的 Key";
  if (status === 403) return "无权限访问该模型，请检查 Key 或模型名称";
  if (status === 404) return "接口地址或模型不存在，请检查 API Base URL 和模型名称";
  if (status === 429) return "请求过于频繁或余额不足，请稍后再试";
  if (status >= 500)  return "AI 服务暂时不可用，请稍后再试";
  if (/model/.test(msg))                              return `模型不存在或无权限：${msg}`;
  if (/quota|balance|insufficient|credit/.test(msg)) return `余额不足：${msg}`;
  return msg || `请求失败（HTTP ${status}）`;
}

/**
 * Calculate the next review interval in days after a review attempt.
 *
 * @param reviewCount  - review_count value before this attempt
 * @param passed       - whether the review was judged as passed
 * @param partialPass  - passed but some dimensions were △ → 0.6× interval
 * @param expertPass   - passed with all dimensions ✓ → 1.3× interval
 * @returns days until next review, or null when fully mastered (no more reviews)
 */
export function calcNextInterval(
  reviewCount: number,
  passed: boolean,
  partialPass: boolean,
  expertPass: boolean,
): number | null {
  if (!passed) return 1;                                    // retry tomorrow
  const raw: number | null = REVIEW_INTERVALS[reviewCount + 1] ?? null;
  if (raw === null) return null;                            // fully mastered
  if (expertPass)   return Math.round(raw * 1.3);
  if (partialPass)  return Math.max(1, Math.round(raw * 0.6));
  return raw;
}
