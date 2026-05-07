# Feynman Learning — Obsidian Plugin

Learn anything deeply using the **Feynman Technique**: explain it simply, find the gaps, and fill them. This plugin guides you through all four steps inside Obsidian, with AI assistance powered by any OpenAI-compatible API (DeepSeek, GPT-4o, Claude, local models via Ollama, etc.).

## Screenshots

> **To add screenshots**: open the plugin panel in Obsidian, take a screenshot of each major view, and place the images in a `docs/` folder. Then replace the placeholders below.

| Dashboard | Review session | Concept extraction |
|-----------|---------------|-------------------|
| *(dashboard.png)* | *(review.png)* | *(extract.png)* |

## Features

- **4-step guided workflow** — Select concept → Explain simply → Identify gaps → Simplify & analogize
- **AI tutor** — Follow-up questioning, gap analysis, quiz generation, and learning recommendations
- **Text extraction + learning queue** — Paste an article; AI extracts 3–8 concepts. Add any or all to a queue and work through them in order from the dashboard
- **Filename preview** — Edit the save filename before writing to vault (Step 4)
- **Spaced repetition review** — Intervals at 1 / 7 / 30 days with three quality tiers:
  - All ✓ ("很熟练") → interval × 1.3
  - Any △ (partial) → interval × 0.6
  - Fail → retry tomorrow
- **3-dimension AI judgment** — Reviews scored on 语言简洁 / 核心机制 / 举例说明 (✓ △ ✗) before advancing mastery
- **Weak-point drill** — After a failed or partial review, click "🎯 专项练习" to get AI-generated targeted questions for the exact weak dimensions, with per-question feedback
- **Weak-point tracking** — Failed review dimensions are saved to the note and surfaced on the next review session
- **Mastery tracking** — Four levels: 初识 → 理解 → 掌握 → 精通, upgraded only after passing AI evaluation
- **Review pass rate** — Per-concept and overall historical pass rate in the dashboard and concept browser
- **Dashboard** — Streak, total concepts, due count, mastery distribution bar, activity heatmap, weekly report
- **Concept browser** — Search, filter by mastery level, see pass rates at a glance
- **Concept connections** — AI finds related concepts from your library and optionally adds wiki-links to notes
- **Notion sync** — Push each completed learning session to a Notion database
- **Auto-save notes** — Every session is saved as a Markdown note with YAML frontmatter

## Requirements

- An API key from any OpenAI-compatible service (see [Supported APIs](#supported-apis))
- Obsidian v0.15.0 or later
- (Optional) A Notion integration token and database ID for Notion sync

## Supported APIs

The plugin works with any service that implements the OpenAI Chat Completions API format. Configure the endpoint in **Settings → Feynman Learning**:

| Service | API Base URL | Model example |
|---------|-------------|---------------|
| DeepSeek *(default)* | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| Anthropic (via proxy) | your proxy URL | `claude-3-5-sonnet-20241022` |
| Ollama (local) | `http://localhost:11434/v1` | `llama3` |
| Any compatible service | your endpoint | your model name |

## Setup

1. Install the plugin from Obsidian's Community Plugins browser.
2. Open **Settings → Feynman Learning** and configure:
   - **API Key** — your API key
   - **API Base URL** — endpoint URL (default: `https://api.deepseek.com/v1`)
   - **Model name** — model to use (default: `deepseek-chat`)
   - **Temperature** — response creativity, 0–1 (default: `0.8`)
   - **Notes folder** — where learning notes will be saved (default: `费曼笔记`)
   - **Index file** — path to a concept index note
   - **Notion Token** *(optional)* — your Notion integration secret
   - **Notion Database ID** *(optional)* — the ID of your Notion database

## Usage

Click the brain icon (🧠) in the left ribbon to open the Feynman Learning panel.

### Learning a new concept

1. **Step 1 — Select**: Enter the concept name and why you want to learn it. Or click **📄 从原文提取概念** to paste an article and let AI suggest concepts.
2. **Step 2 — Explain**: Write your explanation as if teaching a 12-year-old. The AI will ask follow-up questions to probe your understanding.
3. **Step 3 — Gaps**: The AI identifies weak spots; you fill them in. AI verifies your final explanation covers each gap before you advance.
4. **Step 4 — Simplify**: Refine your explanation and create an analogy. Optionally take an AI quiz or discover concept connections.
5. **Done** — The session is saved as a note. Optionally sync to Notion.

### Reviewing concepts

Due concepts appear in the **Review** section of the dashboard. The AI scores your re-explanation on three dimensions and decides whether to advance the mastery level. If a previous review failed, those weak dimensions are shown above the input so you know what to focus on.

Review intervals adjust dynamically:

| Result | Next interval | Button appears |
|--------|--------------|----------------|
| All ✓ (很熟练) | × 1.3 (longer) | — |
| Any △ (partial pass) | × 0.6 (shorter) | 🎯 强化弱点 |
| Fail | 1 day | 🎯 专项练习 |

Clicking **🎯 专项练习 / 🎯 强化弱点** opens an inline drill: the AI generates 2–3 targeted questions for the specific weak or partial dimensions. Submit answers for per-question feedback, or retry as many times as needed.

### Weekly report

Click **📊 生成本周报告** in the dashboard to generate a Markdown summary of the week: concepts learned, reviews completed, pass rate, streak, and an AI-written reflection.

## Note format

Each session creates a Markdown file with YAML frontmatter:

```yaml
---
概念: "Newton's Laws"
日期: "2025-01-01"
掌握程度: "理解"
review_date: "2025-01-08"
review_count: 1
---
```

Failed reviews append a `## 复习记录` section with dimension scores and evaluation so subsequent sessions have a clear target.

## Privacy

Your API key is stored locally in Obsidian's plugin data file and is never sent anywhere except the configured API endpoint.

## License

MIT © Xiaoxiaoqi
