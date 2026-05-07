# Feynman Learning — Obsidian Plugin

Learn anything deeply using the **Feynman Technique**: explain it simply, find the gaps, and fill them. This plugin guides you through all four steps inside Obsidian, with AI assistance powered by DeepSeek (or any OpenAI-compatible API).

## Features

- **4-step guided workflow** — Select concept → Explain simply → Identify gaps → Simplify & analogize
- **AI tutor** — DeepSeek-powered questioning, gap analysis, quiz generation, and recommendations
- **Spaced repetition review** — Due dates calculated at 1 / 7 / 30 day intervals; AI judges whether you've truly mastered a concept before advancing its level
- **Mastery tracking** — Four levels: 初识 → 理解 → 掌握 → 精通, upgraded only after passing AI evaluation
- **Review pass rate** — Per-concept and overall historical pass rate displayed in the dashboard and concept browser
- **Dashboard** — Streak, total concepts, due count, mastery distribution bar, activity heatmap
- **Concept browser** — Search, filter by mastery level, see pass rates at a glance
- **Notion sync** — Push each completed learning session to a Notion database
- **Auto-save notes** — Every session is saved as a Markdown note with YAML frontmatter in your chosen vault folder

## Requirements

- An API key from [DeepSeek](https://platform.deepseek.com/) (or any OpenAI-compatible endpoint)
- Obsidian v0.15.0 or later
- (Optional) A Notion integration token and database ID for Notion sync

## Setup

1. Install the plugin from Obsidian's Community Plugins browser.
2. Open **Settings → Feynman Learning** and enter:
   - **DeepSeek API Key** — your API key
   - **Notes folder** — where learning notes will be saved (default: `费曼笔记`)
   - **Index file** — path to a concept index note (default: `费曼学习索引.md`)
   - **Notion Token** *(optional)* — your Notion integration secret
   - **Notion Database ID** *(optional)* — the ID of your Notion database

## Usage

Click the brain icon (🧠) in the left ribbon to open the Feynman Learning panel.

### Learning a new concept

1. **Step 1 — Select**: Enter the concept name and why you want to learn it.
2. **Step 2 — Explain**: Write your explanation as if teaching a 12-year-old. The AI will ask follow-up questions to probe your understanding.
3. **Step 3 — Gaps**: The AI identifies weak spots in your explanation; you fill them in.
4. **Step 4 — Simplify**: Refine your explanation and create an analogy. Optionally take an AI quiz.
5. **Done** — The session is saved as a note. Optionally sync to Notion.

### Reviewing concepts

Due concepts appear in the **Review** section of the dashboard. The AI evaluates your re-explanation and decides whether to advance the mastery level or schedule another review.

## Note format

Each session creates a Markdown file with YAML frontmatter:

```yaml
---
概念: "Newton's Laws"
日期: "2025-01-01"
掌握程度: "理解"
review_date: "2025-01-08"
review_count: 1
subject: ""
---
```

## Privacy

Your API key is stored locally in Obsidian's plugin data file and is never sent anywhere except the configured API endpoint.

## License

MIT © Xiaoxiaoqi
