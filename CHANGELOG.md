# Changelog

All notable changes to **Feynman Learning** are documented here.

## [1.3.0] — 2026-05-08

### Added
- **Notion field name mapping** — four core Notion property names (title, mastery, status, subject) are now configurable in Settings; default values preserve backward compatibility; error message on 400 now tells users to check field name alignment
- **Settings export / import** — "数据管理" section in Settings lets users copy all settings to clipboard as JSON, then paste and merge on another device; import is sandboxed to known keys from DEFAULT_SETTINGS to prevent injection
- **Batch review progress persistence** — batch state (`filePaths` + current index) is saved to disk via `savePendingBatch()`; if Obsidian closes mid-batch, a resume banner appears on the dashboard on next open; "放弃此次批量" clears the saved state

### Fixed
- Notion sync error message now reads "请检查数据库字段名是否与插件设置一致" instead of a raw HTTP status when field names mismatch

## [1.2.0] — 2026-05-08

### Added
- **First-use onboarding card** — when no API key is configured, the panel shows a guided setup card with step-by-step instructions and an "Open Settings" button instead of an empty dashboard
- **Notes folder self-check** — Settings now shows a live ✓/✗ status for the configured notes folder; a "一键创建" button appears when the folder is missing
- **Mobile & touch support** — `@media (pointer: coarse)` raises all buttons to 44 px minimum tap targets; `@media (max-width: 480px)` fixes iOS auto-zoom on inputs (font-size forced to 1 rem), reduces card padding, and stacks review/queue button rows on narrow screens

### Fixed
- **iOS Safari auto-zoom** — text inputs and textareas previously used `font-size: 0.88rem` (≈ 14 px), triggering unwanted zoom on focus; now clamped to `1rem` on narrow screens
- **Settings "Open Settings" button on mobile** — gracefully falls back to a Notice with manual navigation instructions when Obsidian's private settings API is unavailable

### Changed
- **`tags` frontmatter format** — new notes now write `tags` as a YAML block list (`tags:\n  - 费曼学习法`) instead of an inline flow sequence (`tags: [费曼学习法]`), which Obsidian's core tag system and Dataview both handle more reliably
- **`getAllConcepts()` is now cached** — result is memoised and invalidated automatically via `vault.on('create'/'delete'/'rename')` and `metadataCache.on('changed')`; repeated calls within a render cycle no longer re-scan the vault
- **Unified AI button error handling** — all AI-triggered buttons (`judgeBtn`, `summaryBtn`, `evalBtn`, `submitBtn`, `继续追问`) now go through a single `withAiBtn` helper that disables the button during the request, logs failures to `console.error`, and shows a `Notice`; a new `keepDisabledOnSuccess` option handles buttons whose post-success state differs from the default

### Refactored
- **`parseReviewVerdict()` and `parseExtractedConcepts()`** extracted from `main.ts` into `utils.ts` as pure functions; both use JSON-first parsing with regex/text fallback
- **Unit tests expanded** — 19 → 30 tests; new tests cover JSON, fenced-markdown, invalid-score, and all fallback paths; `console.warn` calls in fallback tests are silenced via `jest.spyOn`

## [1.1.0] — 2026-05-07

### Added
- **Review sorting** — sort due list by due-date (most overdue first), mastery level, or concept name; overdue-days badge on each item
- **Batch review mode** — 🚀 button (≥2 due) cycles through all due concepts with a X/N progress bar, skip, and exit; summary screen at the end
- **Configurable review intervals** — three number inputs in Settings control the 1/7/30-day ladder; changes apply immediately to new notes and future reviews
- **"Review current note" command** — available in the command palette when the active file is a due feynman note; auto-opens the review session

### Fixed
- Batch review no longer skips items: the due-concept list is frozen as a snapshot when batch starts, so `markReviewed()` shrinking the live list doesn't cause index drift
- New notes now use the user-configured initial review interval (index 0 of `reviewIntervals`) instead of the hardcoded constant
- Settings labels clarified: "保存→首次复习 / 首次通过→二次复习 / 二次通过→三次复习" reflects actual algorithm semantics

### Changed
- `calcNextInterval()` accepts an optional `intervals` parameter (backward-compatible); all callers pass the live settings value
- `DueConcept` interface now includes `reviewDate` and `mastery` fields for richer display and sorting

## [1.0.8] — 2026-04-28 (Phase 1 — foundation)

### Added
- **`src/utils.ts`** — pure utility module with no Obsidian dependency: `REVIEW_INTERVALS`, `MASTERY_LEVELS`, `sanitizeFilename`, `yamlStr`, `truncate`, `parseApiError`, `calcNextInterval`
- **`calcNextInterval()`** — single source of truth for spaced-repetition interval math (replaces duplicated logic in `markReviewed` and `renderReviewSession`)
- **Jest test suite** — 19 unit tests covering all utility functions; `tsconfig.test.json` for CommonJS Jest config
- **`RELEASE_CHECKLIST.md`** — step-by-step release process

### Fixed
- `saveNote()` idempotency: re-saving with a different filename no longer creates duplicate index rows or duplicate `learningDate` entries (`isNew` guard)
- Stale "DeepSeek" text removed from `doAskAI` and `startQuiz` error notices → "API Key"

### Changed
- `main.ts` imports all shared constants and utilities from `utils.ts`; local duplicate definitions removed

## [1.0.7] — 2026-04-20

### Fixed
- Concept connections now correctly find notes that were saved with a custom filename (uses `savedStem` from state instead of re-deriving the filename)
- Quiz save (Step 5) now goes through the filename-preview dialog instead of bypassing it

## [1.0.6] — 2026-04-15

### Added
- **Filename preview** — edit the save filename before writing to vault (Step 4); `savedStem` tracked in state
- **Learning queue** — add concepts from the extract-results list to a queue; dashboard shows the queue with start/remove controls
- **GitHub Actions auto-release** — push a semver tag (e.g. `1.0.6`) to trigger CI build and GitHub Release creation

## [1.0.5] — 2026-04-10

### Added
- **Expert-pass multiplier** — reviews where all three dimensions score ✓ ("很熟练") advance the next interval by ×1.3
- **Weak-point targeted drill** — after a failed or partial review, 🎯 button generates 2–3 AI questions for the specific failing dimensions, with per-question feedback

## [1.0.4] — 2026-04-05

### Added
- **API test button** in Settings — verifies key and endpoint; shows the active model name on success
- **Friendly API error messages** — HTTP 401/403/404/429/5xx mapped to human-readable Chinese strings
- **`scripts/version-bump.mjs`** — updates `package.json`, `manifest.json`, and `versions.json` in one command

## [1.0.3] — 2026-03-30

### Fixed
- Last-review notice incorrectly showed interval days instead of "已达到精通" for fully mastered concepts

## [1.0.2] — 2026-03-25

### Added
- Custom API settings (Base URL, model, temperature) — supports DeepSeek, OpenAI, Ollama, and any OpenAI-compatible service
- Text extraction from articles — AI suggests 3–8 concepts to learn from pasted text
- Weak-point review — previous failed dimensions surfaced at the start of the next review session

### Fixed
- Partial-pass interval display showed wrong next-review date
- Notion sync description was stale

## [1.0.1] — 2026-03-15

### Added
- Weekly report — AI-written summary of the week's learning activity
- Concept connections — AI finds related concepts in the vault and optionally adds wiki-links

### Fixed
- Three data-safety issues (duplicate entries, missing null checks)
- Three core UX gaps in the learning loop

## [1.0.0] — 2026-03-01

Initial release.

- 4-step Feynman workflow (Select → Explain → Gaps → Simplify)
- AI follow-up questioning and gap analysis
- Spaced repetition with 1/7/30-day intervals
- 3-dimension AI review scoring (语言简洁 / 核心机制 / 举例说明)
- Four mastery levels (初识 → 理解 → 掌握 → 精通)
- Dashboard with streak, heatmap, mastery distribution
- Concept browser with search and mastery filter
- Auto-save Markdown notes with YAML frontmatter
- Notion sync
