# Changelog

All notable changes to **Feynman Learning** are documented here.

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
