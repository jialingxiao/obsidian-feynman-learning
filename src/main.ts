import {
  App,
  Editor,
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  moment,
} from "obsidian";

const VIEW_TYPE = "feynman-learning-view";
const REVIEW_INTERVALS = [1, 7, 30];
const MASTERY_LEVELS = ["初识", "理解", "掌握", "精通"];
const MASTERY_COLORS: Record<string, string> = {
  "初识": "#aaa", "理解": "#e07b39", "掌握": "#1a6fa8", "精通": "#2d6a4f",
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface FeynmanSettings {
  apiKey: string;
  apiBase: string;
  model: string;
  temperature: number;
  notesFolder: string;
  indexFile: string;
  notionToken: string;
  notionDatabaseId: string;
}

const DEFAULT_SETTINGS: FeynmanSettings = {
  apiKey: "",
  apiBase: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  temperature: 0.8,
  notesFolder: "01.读书笔记/费曼笔记",
  indexFile: "01.读书笔记/费曼学习索引.md",
  notionToken: "",
  notionDatabaseId: "",
};

interface FeynmanState {
  step: number;
  concept: string;
  why: string;
  explanation: string;
  aiHistory: { role: string; content: string }[];
  gaps: string;
  finalExplanation: string;
  analogy: string;
  quizQuestions: string[];
  quizAnswers: string[];
  quizFeedback: string;
  recommendations: string[];
  savedStem: string;  // actual filename stem used when the note was last saved
}

interface DueConcept { file: TFile; concept: string; reviewCount: number; }
interface ConceptMeta { concept: string; date: string; mastery: string; subject: string; file: TFile; }
interface ReviewRecord { date: string; concept: string; passed: boolean; }

function emptyState(): FeynmanState {
  return {
    step: 0, concept: "", why: "", explanation: "",
    aiHistory: [], gaps: "", finalExplanation: "", analogy: "",
    quizQuestions: [], quizAnswers: [], quizFeedback: "", recommendations: [],
    savedStem: "",
  };
}

function truncate(text: string, max = 1900): string {
  return text.length > max ? text.slice(0, max) + "…（已截断）" : text;
}

function parseApiError(status: number, body: any): string {
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

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}

function yamlStr(value: string): string {
  if (/[:#\[\]{}&*!|>'"@`]/.test(value) || value.startsWith(" ") || value.endsWith(" ")) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

// ─── View ────────────────────────────────────────────────────────────────────

class FeynmanView extends ItemView {
  private plugin: FeynmanPlugin;
  private state: FeynmanState = emptyState();
  private browsing = false;
  private browseSearch = "";
  private browseFilter = "全部";

  constructor(leaf: WorkspaceLeaf, plugin: FeynmanPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "费曼学习法"; }
  getIcon() { return "brain"; }

  async onOpen() { this.render(); }
  async onClose() {}

  // ─── Core render ──────────────────────────────────────────────────────────

  render() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("feynman-view");

    if (this.browsing) {
      this.renderBrowser(containerEl);
      return;
    }

    this.renderProgress(containerEl);
    switch (this.state.step) {
      case 0: this.renderStep0(containerEl); break;
      case 1: this.renderStep1(containerEl); break;
      case 2: this.renderStep2(containerEl); break;
      case 3: this.renderStep3(containerEl); break;
      case 4: this.renderStep4(containerEl); break;
      case 5: this.renderStep5(containerEl); break;
    }
  }

  private renderProgress(parent: HTMLElement) {
    const steps = ["首页", "简单解释", "找出漏洞", "简化类比", "总结", "测验"];
    const wrap = parent.createDiv("feynman-progress");
    const labels = wrap.createDiv("feynman-progress-labels");
    steps.forEach((s, i) => {
      labels.createSpan({
        cls: `feynman-step-label ${i === this.state.step ? "active" : i < this.state.step ? "done" : ""}`,
        text: s,
      });
    });
    const pct = [0, 20, 40, 60, 80, 100][Math.min(this.state.step, 5)];
    wrap.createDiv("feynman-progress-bar")
      .createDiv({ cls: "feynman-progress-fill", attr: { style: `width:${pct}%` } });
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────

  private badge(p: HTMLElement, t: string) { p.createDiv({ cls: "feynman-badge", text: t }); }
  private hint(p: HTMLElement, t: string) { p.createDiv({ cls: "feynman-hint", text: t }); }
  private tip(p: HTMLElement, t: string) { p.createDiv({ cls: "feynman-tip", text: t }); }
  private lbl(p: HTMLElement, t: string) { p.createEl("label", { cls: "feynman-label", text: t }); }

  private ta(p: HTMLElement, placeholder: string, value = ""): HTMLTextAreaElement {
    const el = p.createEl("textarea", { cls: "feynman-textarea", attr: { placeholder } });
    el.value = value;
    return el;
  }

  private inp(p: HTMLElement, placeholder: string, value = ""): HTMLInputElement {
    const el = p.createEl("input", { cls: "feynman-input", attr: { type: "text", placeholder } }) as HTMLInputElement;
    el.value = value;
    return el;
  }

  private btnRow(p: HTMLElement) { return p.createDiv("feynman-btn-row"); }

  private btn(p: HTMLElement, text: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = p.createEl("button", { cls: `feynman-btn feynman-btn-${cls}`, text });
    b.addEventListener("click", onClick);
    return b;
  }

  // ─── Step 0: Dashboard + History + Start ──────────────────────────────────

  private renderStep0(parent: HTMLElement) {
    this.renderDashboard(parent);
    this.renderQueue(parent);
    this.renderDueReviews(parent);
    this.renderHistory(parent);
    this.renderStartCard(parent);
  }

  private renderDashboard(parent: HTMLElement) {
    const stats = this.plugin.getStats();
    const card = parent.createDiv("feynman-card feynman-dashboard");
    card.createEl("h3", { cls: "feynman-dashboard-title", text: "学习概览" });

    const reviewStats = this.plugin.getOverallReviewStats();
    const grid = card.createDiv("feynman-stat-grid");
    for (const { label, value, sub } of [
      { label: "已学概念", value: stats.total, sub: `本周 +${stats.thisWeek}` },
      { label: "待复习", value: stats.dueCount, sub: "" },
      { label: "连续学习", value: stats.streak + " 天", sub: "" },
      { label: "复习通过率", value: reviewStats.rate, sub: reviewStats.total > 0 ? `${reviewStats.passed}/${reviewStats.total} 次` : "暂无记录" },
    ]) {
      const cell = grid.createDiv("feynman-stat-cell");
      cell.createDiv({ cls: "feynman-stat-value", text: String(value) });
      cell.createDiv({ cls: "feynman-stat-label", text: label });
      if (sub) cell.createDiv({ cls: "feynman-stat-sub", text: sub });
    }

    // Weekly heatmap (last 14 days)
    this.renderHeatmap(card);

    // Mastery bar
    if (stats.total > 0) {
      const barWrap = card.createDiv("feynman-mastery-wrap");
      barWrap.createDiv({ cls: "feynman-mastery-label", text: "掌握程度分布" });
      const bar = barWrap.createDiv("feynman-mastery-bar");
      for (const [level, color] of Object.entries(MASTERY_COLORS).reverse()) {
        const count = stats.mastery[level] ?? 0;
        if (count === 0) continue;
        bar.createDiv({
          cls: "feynman-mastery-seg",
          attr: { style: `width:${(count / stats.total * 100).toFixed(1)}%;background:${color}`, title: `${level}: ${count}` },
        });
      }
      const legend = barWrap.createDiv("feynman-mastery-legend");
      for (const [level, color] of Object.entries(MASTERY_COLORS).reverse()) {
        const count = stats.mastery[level] ?? 0;
        if (count === 0) continue;
        const item = legend.createSpan({ cls: "feynman-legend-item" });
        item.createSpan({ cls: "feynman-legend-dot", attr: { style: `background:${color}` } });
        item.createSpan({ text: `${level} ${count}` });
      }
    }

    const reportRow = card.createDiv("feynman-btn-row");
    this.btn(reportRow, "📊 生成本周报告", "secondary", async () => {
      await this.generateWeeklyReport();
    });
  }

  private renderHeatmap(parent: HTMLElement) {
    const wrap = parent.createDiv("feynman-heatmap-wrap");
    wrap.createDiv({ cls: "feynman-mastery-label", text: "近 14 天学习记录" });
    const grid = wrap.createDiv("feynman-heatmap");
    const dates = this.plugin.learningDates;
    for (let i = 13; i >= 0; i--) {
      const d = moment().subtract(i, "days").format("YYYY-MM-DD");
      const active = dates.includes(d);
      const cell = grid.createDiv({
        cls: `feynman-heatmap-cell ${active ? "active" : ""}`,
        attr: { title: d + (active ? " ✓" : "") },
      });
    }
  }

  private renderQueue(parent: HTMLElement) {
    const queue = this.plugin.learningQueue;
    if (queue.length === 0) return;
    const card = parent.createDiv("feynman-card feynman-queue-card");
    this.badge(card, `📋 学习队列 · ${queue.length} 个`);
    card.createEl("h2", { text: "准备学习的概念" });
    const list = card.createDiv("feynman-queue-list");
    for (const concept of [...queue]) {
      const row = list.createDiv("feynman-queue-item");
      row.createSpan({ cls: "feynman-queue-name", text: concept });
      const btns = row.createDiv("feynman-queue-btns");
      this.btn(btns, "开始学习 →", "primary", async () => {
        await this.plugin.removeFromQueue(concept);
        this.state = emptyState();
        this.state.concept = concept;
        this.state.step = 1;
        this.render();
      });
      this.btn(btns, "✕", "secondary", async () => {
        await this.plugin.removeFromQueue(concept);
        row.remove();
        if (list.children.length === 0) card.remove();
      });
    }
  }

  private renderDueReviews(parent: HTMLElement) {
    const due = this.plugin.getDueConcepts();
    if (due.length === 0) return;
    const card = parent.createDiv("feynman-card feynman-review-card");
    this.badge(card, `📅 待复习 · ${due.length} 个`);
    card.createEl("h2", { text: "这些概念到了复习时间" });
    const list = card.createDiv("feynman-review-list");

    for (const item of due) {
      const itemWrap = list.createDiv("feynman-review-item-wrap");
      const row = itemWrap.createDiv("feynman-review-item");
      const info = row.createDiv("feynman-review-info");
      info.createSpan({ cls: "feynman-review-name", text: item.concept });
      const next = REVIEW_INTERVALS[item.reviewCount] ?? null;
      const rStats = this.plugin.getConceptReviewStats(item.concept);
      const histText = rStats.total > 0 ? `历史通过率 ${rStats.rate} (${rStats.passed}/${rStats.total})` : "首次复习";
      info.createSpan({
        cls: "feynman-review-sub",
        text: next ? `第 ${item.reviewCount + 1} 次 · 通过升级为「${MASTERY_LEVELS[Math.min(item.reviewCount + 1, 3)]}」 · ${histText}` : "已完成所有复习阶段",
      });

      const btns = row.createDiv("feynman-review-btns");
      this.btn(btns, "打开笔记", "secondary", () => this.app.workspace.getLeaf("tab").openFile(item.file));

      if (next !== null) {
        this.btn(btns, "开始复习 →", "primary", async () => {
          await this.renderReviewSession(itemWrap, item);
        });
      }
    }
  }

  private async renderReviewSession(wrap: HTMLElement, item: DueConcept) {
    wrap.querySelector(".feynman-review-session")?.remove();
    const session = wrap.createDiv("feynman-review-session");

    // Load context from note (single read)
    let previousGaps = "";
    let previousWeakDims: string[] = [];
    try {
      const content = await this.app.vault.read(item.file);
      const gapsMatch = content.match(/## 第二步：知识漏洞\n+([\s\S]*?)(?=\n## )/);
      previousGaps = gapsMatch?.[1]?.trim() ?? "";
      if (previousGaps === "（未填写）") previousGaps = "";
      const recSection = content.match(/## 复习记录\n([\s\S]*)/)?.[1] ?? "";
      const lastFail = recSection.match(/### .+? · ✗ 未通过\n([\s\S]*?)(?=\n###|$)/)?.[1] ?? "";
      previousWeakDims = (lastFail.match(/- .+?：✗[^\n]*/g) ?? []).map(l => l.replace(/^- /, "").trim());
    } catch { /* optional */ }

    session.createDiv({ cls: "feynman-review-session-hint", text: `不看笔记，用自己的话重新解释「${item.concept}」，AI 会从三个维度评判你的掌握程度。` });

    if (previousWeakDims.length > 0 || previousGaps) {
      const gapsEl = session.createDiv("feynman-review-gaps");
      if (previousWeakDims.length > 0) {
        gapsEl.createDiv({ cls: "feynman-ai-label", text: "⚠️ 上次未通过的维度（重点补强）" });
        gapsEl.createDiv({ cls: "feynman-review-session-hint", text: previousWeakDims.join("\n") });
      } else {
        gapsEl.createDiv({ cls: "feynman-ai-label", text: "📌 上次记录的知识漏洞" });
        gapsEl.createDiv({ cls: "feynman-review-session-hint", text: previousGaps });
      }
    }

    const expTA = this.ta(session, "用最简单的语言解释……");

    const resultEl = session.createDiv("feynman-review-result");
    resultEl.style.display = "none";

    let lastDimensions: { label: string; score: string; note: string }[] = [];
    let lastEvalText = "";
    let partialPass = false;

    const row = this.btnRow(session);
    this.btn(row, "取消", "secondary", () => { session.remove(); });

    const judgeBtn = this.btn(row, "AI 评判 →", "primary", async () => {
      const exp = expTA.value.trim();
      if (!exp) { new Notice("请先写出你的解释"); return; }

      judgeBtn.disabled = true;
      judgeBtn.textContent = "AI 评判中…";
      resultEl.style.display = "none";

      try {
        const gapsContext = previousGaps ? `\n\n上次学习时记录的知识漏洞：\n${previousGaps}` : "";
        const verdict = await this.callDeepSeek([
          {
            role: "system",
            content: `你是一个严格但友善的学习评估老师。学生正在复习「${item.concept}」这个概念。
从以下三个维度评判，然后给出总体判定。输出格式（严格按照，每行一条）：
语言简洁：✓ 或 △ 或 ✗（一句话说明）
核心机制：✓ 或 △ 或 ✗（一句话说明）
举例说明：✓ 或 △ 或 ✗（一句话说明）
判定：通过 或 判定：未通过
评价：（1-2句话综合评价）`,
          },
          { role: "user", content: `学生对「${item.concept}」的重新解释：\n${exp}${gapsContext}` },
        ]);

        const passed = verdict.includes("判定：通过");

        // Parse dimensions
        const SCORE_ICON: Record<string, string> = { "✓": "✓", "△": "△", "✗": "✗" };
        const SCORE_CLS: Record<string, string> = { "✓": "dim-pass", "△": "dim-partial", "✗": "dim-fail" };
        const dimensions: { label: string; score: string; note: string }[] = [];
        for (const label of ["语言简洁", "核心机制", "举例说明"]) {
          const re = new RegExp(`${label}：([✓△✗])(.*)`, "m");
          const m = verdict.match(re);
          if (m) dimensions.push({ label, score: m[1], note: m[2].trim() });
        }
        const evalText = verdict.match(/评价：([\s\S]*)/)?.[1]?.trim() ?? "";

        resultEl.style.display = "block";
        resultEl.empty();

        resultEl.createDiv({
          cls: `feynman-verdict ${passed ? "feynman-verdict-pass" : "feynman-verdict-fail"}`,
          text: passed ? "✓ 通过" : "✗ 需要再练习",
        });

        if (dimensions.length > 0) {
          const dimGrid = resultEl.createDiv("feynman-dim-grid");
          for (const d of dimensions) {
            const item2 = dimGrid.createDiv(`feynman-dim-item ${SCORE_CLS[d.score] ?? ""}`);
            item2.createSpan({ cls: "feynman-dim-score", text: d.score });
            const right = item2.createDiv("feynman-dim-right");
            right.createSpan({ cls: "feynman-dim-label", text: d.label });
            if (d.note) right.createSpan({ cls: "feynman-dim-note", text: d.note });
          }
        }

        if (evalText) resultEl.createDiv({ cls: "feynman-verdict-feedback", text: evalText });

        lastDimensions = dimensions;
        lastEvalText = evalText;
        const allPerfect = passed && dimensions.length > 0 && dimensions.every(d => d.score === "✓");
        partialPass = passed && !allPerfect && dimensions.some(d => d.score !== "✓");
        await this.plugin.recordReview(item.concept, passed);

        const actionRow = this.btnRow(resultEl);
        if (passed) {
          const nextMastery = MASTERY_LEVELS[Math.min(item.reviewCount + 1, 3)];
          const rawNextDays: number | null = REVIEW_INTERVALS[item.reviewCount + 1] ?? null;
          let actualNextDays: number | null;
          if (rawNextDays === null) {
            actualNextDays = null;
          } else if (allPerfect) {
            actualNextDays = Math.round(rawNextDays * 1.3);
          } else if (partialPass) {
            actualNextDays = Math.max(1, Math.round(rawNextDays * 0.6));
          } else {
            actualNextDays = rawNextDays;
          }

          let btnLabel: string;
          if (allPerfect && actualNextDays !== null) {
            btnLabel = `很熟练！升级为「${nextMastery}」（${actualNextDays} 天后复习）→`;
          } else if (partialPass && actualNextDays !== null) {
            btnLabel = `升级为「${nextMastery}」（部分掌握，${actualNextDays} 天后复习）→`;
          } else {
            btnLabel = `升级为「${nextMastery}」→`;
          }

          this.btn(actionRow, btnLabel, "primary", async () => {
            await this.plugin.markReviewed(item.file, item.reviewCount, true, partialPass, allPerfect);
            new Notice(actualNextDays !== null
              ? `「${item.concept}」已升级为「${nextMastery}」，${actualNextDays} 天后再提醒${allPerfect ? " 🎉" : ""}`
              : `「${item.concept}」已达到精通！🎉`
            );
            this.render();
          });

          if (partialPass) {
            this.btn(actionRow, "🎯 强化弱点", "secondary", async () => {
              await this.renderWeakPointDrill(resultEl, item.concept, lastDimensions);
            });
          }
        } else {
          this.btn(actionRow, "明天再试", "warn", async () => {
            await this.plugin.markReviewed(item.file, item.reviewCount, false);
            await this.saveFailedReviewToNote(item.file, lastDimensions, lastEvalText);
            new Notice(`「${item.concept}」明天再复习一次`);
            this.render();
          });
          this.btn(actionRow, "🎯 专项练习", "secondary", async () => {
            await this.renderWeakPointDrill(resultEl, item.concept, lastDimensions);
          });
          this.btn(actionRow, "再解释一次", "secondary", () => {
            expTA.value = "";
            resultEl.style.display = "none";
            judgeBtn.disabled = false;
            judgeBtn.textContent = "AI 评判 →";
            expTA.focus();
          });
        }
      } catch (e: any) {
        new Notice("AI 请求失败：" + e.message);
        judgeBtn.disabled = false;
        judgeBtn.textContent = "AI 评判 →";
      }
    });
  }

  private renderHistory(parent: HTMLElement) {
    const concepts = this.plugin.getRecentConcepts(5);
    if (concepts.length === 0) return;
    const card = parent.createDiv("feynman-card");
    const header = card.createDiv("feynman-section-header");
    header.createEl("h3", { cls: "feynman-section-title", text: "最近学习" });
    this.btn(header, "📚 概念库", "secondary", () => { this.browsing = true; this.render(); });

    for (const c of concepts) {
      const row = card.createDiv("feynman-history-item");
      const info = row.createDiv("feynman-history-info");
      info.createSpan({ cls: "feynman-history-name", text: c.concept });
      info.createSpan({ cls: "feynman-history-meta", text: `${c.date}  ·  ${c.mastery}` });
      row.createDiv({ cls: `feynman-mastery-tag feynman-mastery-${c.mastery}`, text: c.mastery });
      row.addEventListener("click", () => this.app.workspace.getLeaf("tab").openFile(c.file));
    }
  }

  private renderStartCard(parent: HTMLElement) {
    const card = parent.createDiv("feynman-card");
    this.badge(card, "开始新概念");
    card.createEl("h2", { text: "你想学什么概念？" });
    this.hint(card, "费曼学习法：选概念 → 简单解释 → 找漏洞 → 简化总结 → AI 测验");

    this.lbl(card, "概念名称");
    const nameInp = this.inp(card, "例如：量子纠缠、复利、贝叶斯定理……", this.state.concept);
    this.lbl(card, "学习动机（可选）");
    const whyInp = this.inp(card, "例如：想理解为什么巴菲特说复利是第八大奇迹", this.state.why);

    // Show AI recommendations if any
    if (this.state.recommendations.length > 0) {
      const recCard = card.createDiv("feynman-rec-wrap");
      recCard.createDiv({ cls: "feynman-ai-label", text: "💡 AI 推荐接下来学" });
      for (const rec of this.state.recommendations) {
        const chip = recCard.createDiv({ cls: "feynman-rec-chip", text: rec });
        chip.addEventListener("click", () => { nameInp.value = rec; });
      }
    }

    const row = this.btnRow(card);
    this.btn(row, "开始学习 →", "primary", () => {
      const name = nameInp.value.trim();
      if (!name) { new Notice("请输入概念名称"); return; }
      this.state.concept = name;
      this.state.why = whyInp.value.trim();
      this.state.step = 1;
      this.render();
    });

    // Text extraction section
    const extractToggle = card.createDiv("feynman-extract-toggle");
    extractToggle.createSpan({ cls: "feynman-extract-toggle-label", text: "📄 从原文提取概念" });
    let extractOpen = false;
    const extractBody = card.createDiv("feynman-extract-body");
    extractBody.style.display = "none";
    extractToggle.addEventListener("click", () => {
      extractOpen = !extractOpen;
      extractBody.style.display = extractOpen ? "block" : "none";
      extractToggle.toggleClass("open", extractOpen);
    });

    const textTA = this.ta(extractBody, "粘贴文章、课堂笔记、书摘……");
    const extractRow = this.btnRow(extractBody);
    const extractBtn = this.btn(extractRow, "AI 提取概念", "primary", async () => {
      const text = textTA.value.trim();
      if (!text) { new Notice("请先粘贴原文"); return; }
      extractBtn.disabled = true; extractBtn.textContent = "提取中…";
      try {
        const result = await this.callDeepSeek([
          { role: "system", content: "从给定文本中提取3-8个值得用费曼学习法深入理解的核心概念，按建议学习顺序排列。每行一个，格式：「概念名」— 一句话说明为什么值得学。不要编号。" },
          { role: "user", content: text.slice(0, 3000) },
        ], 500);

        const concepts = result.split("\n").filter(l => l.trim()).map(l => {
          const m = l.match(/「(.+?)」[—\-–]\s*(.*)/);
          return m ? { name: m[1].trim(), reason: m[2].trim() } : { name: l.replace(/「|」/g, "").trim(), reason: "" };
        }).filter(c => c.name).slice(0, 8);

        extractBody.querySelector(".feynman-extract-results")?.remove();
        if (concepts.length === 0) { new Notice("未能提取到概念，请换一段文本"); return; }

        const results = extractBody.createDiv("feynman-extract-results");
        const headerRow = results.createDiv("feynman-extract-header");
        headerRow.createDiv({ cls: "feynman-ai-label", text: `提取到 ${concepts.length} 个概念` });
        const addAllBtn = headerRow.createEl("button", { cls: "feynman-btn feynman-btn-secondary feynman-extract-add-all", text: "全部加入队列" });
        addAllBtn.addEventListener("click", async () => {
          for (const c of concepts) await this.plugin.addToQueue(c.name);
          addAllBtn.textContent = `✓ 已加入 ${concepts.length} 个`;
          addAllBtn.disabled = true;
          new Notice(`已将 ${concepts.length} 个概念加入学习队列`);
        });
        for (const c of concepts) {
          const chip = results.createDiv({ cls: "feynman-extract-chip" });
          const info = chip.createDiv({ cls: "feynman-extract-chip-info" });
          info.createSpan({ cls: "feynman-extract-name", text: c.name });
          if (c.reason) info.createSpan({ cls: "feynman-extract-reason", text: c.reason });
          info.addEventListener("click", () => { nameInp.value = c.name; nameInp.scrollIntoView({ behavior: "smooth" }); });
          const addBtn = chip.createEl("button", { cls: "feynman-btn feynman-extract-add", text: "＋" });
          addBtn.title = "加入学习队列";
          addBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await this.plugin.addToQueue(c.name);
            addBtn.textContent = "✓";
            addBtn.disabled = true;
          });
        }
      } catch (e: any) {
        new Notice("AI 请求失败：" + e.message);
      } finally {
        extractBtn.disabled = false; extractBtn.textContent = "AI 提取概念";
      }
    });
  }

  // ─── Concept Browser ──────────────────────────────────────────────────────

  private renderBrowser(parent: HTMLElement) {
    const header = parent.createDiv("feynman-browser-header");
    this.btn(header, "← 返回", "secondary", () => { this.browsing = false; this.render(); });
    header.createEl("h2", { cls: "feynman-browser-title", text: "概念库" });

    const card = parent.createDiv("feynman-card");

    // Search input
    const searchInp = card.createEl("input", {
      cls: "feynman-input feynman-search-input",
      attr: { type: "text", placeholder: "搜索概念名称…" },
    }) as HTMLInputElement;
    searchInp.value = this.browseSearch;

    // Filter tabs
    const filters = card.createDiv("feynman-filter-tabs");
    const filterList = ["全部", ...MASTERY_LEVELS];
    for (const f of filterList) {
      const tab = filters.createDiv({
        cls: `feynman-filter-tab ${this.browseFilter === f ? "active" : ""}`,
        text: f,
      });
      tab.addEventListener("click", () => { this.browseFilter = f; renderList(); });
    }

    // Results container
    const listEl = card.createDiv("feynman-browser-list");

    const renderList = () => {
      listEl.empty();
      const search = searchInp.value.trim().toLowerCase();
      const all = this.plugin.getAllConcepts();
      const filtered = all.filter(c => {
        const matchSearch = !search || c.concept.toLowerCase().includes(search);
        const matchFilter = this.browseFilter === "全部" || c.mastery === this.browseFilter;
        return matchSearch && matchFilter;
      });

      // Update filter tab counts
      filters.querySelectorAll(".feynman-filter-tab").forEach((el, i) => {
        const f = filterList[i];
        const count = f === "全部" ? all.length : all.filter(c => c.mastery === f).length;
        el.textContent = `${f} ${count}`;
        el.classList.toggle("active", this.browseFilter === f);
      });

      if (filtered.length === 0) {
        listEl.createDiv({ cls: "feynman-browser-empty", text: search ? `没有找到「${search}」` : "还没有任何概念" });
        return;
      }

      for (const c of filtered) {
        const row = listEl.createDiv("feynman-browser-item");
        const info = row.createDiv("feynman-browser-info");
        info.createSpan({ cls: "feynman-history-name", text: c.concept });
        info.createSpan({ cls: "feynman-history-meta", text: `${c.date}  ·  ${c.subject || ""}` });
        const right = row.createDiv("feynman-browser-right");
        const rStat = this.plugin.getConceptReviewStats(c.concept);
        if (rStat.total > 0) right.createDiv({ cls: "feynman-browser-rate", text: rStat.rate });
        right.createDiv({ cls: `feynman-mastery-tag feynman-mastery-${c.mastery}`, text: c.mastery });
        row.addEventListener("click", () => this.app.workspace.getLeaf("tab").openFile(c.file));
      }
    };

    searchInp.addEventListener("input", () => { this.browseSearch = searchInp.value; renderList(); });
    renderList();

    // Stats footer
    const all = this.plugin.getAllConcepts();
    card.createDiv({ cls: "feynman-browser-footer", text: `共 ${all.length} 个概念` });
  }

  // ─── Step 1 ───────────────────────────────────────────────────────────────

  private renderStep1(parent: HTMLElement) {
    const card = parent.createDiv("feynman-card");
    this.badge(card, "第一步 · 简单解释");
    card.createEl("h2", { text: `解释「${this.state.concept}」` });
    this.tip(card, "💡 假设你在向一个完全不懂的朋友解释。不能用术语，只用日常语言，想到什么写什么。");

    this.lbl(card, "我的解释");
    const expTA = this.ta(card, "用自己的话写出来……", this.state.explanation);

    const row = this.btnRow(card);
    this.btn(row, "← 返回", "secondary", () => { this.state.step = 0; this.render(); });
    const aiBtn = this.btn(row, "让 AI 来追问我 →", "primary", async () => {
      const exp = expTA.value.trim();
      if (!exp) { new Notice("请先写出你的解释"); return; }
      this.state.explanation = exp;
      this.state.aiHistory = [];
      aiBtn.disabled = true; aiBtn.textContent = "AI 思考中…";
      await this.doAskAI(parent);
      aiBtn.disabled = false; aiBtn.textContent = "再次追问";
    });

    if (this.state.aiHistory.length > 0) this.renderAIChat(parent);
  }

  private async doAskAI(parent: HTMLElement) {
    if (!this.plugin.settings.apiKey) { new Notice("请先在插件设置中填写 DeepSeek API Key"); return; }
    this.state.aiHistory = [
      { role: "system", content: "你是一个对所有领域都一无所知的普通人，正在听别人解释一个概念。基于对方的解释，找出最让你困惑的地方，提出1-2个追问。用口语化语气，真的从不懂的角度提问，不评价，用中文。" },
      { role: "user", content: `我在解释的概念是：${this.state.concept}\n\n我的解释是：\n${this.state.explanation}` },
    ];
    try {
      const reply = await this.callDeepSeek(this.state.aiHistory);
      this.state.aiHistory.push({ role: "assistant", content: reply });
      this.renderAIChat(parent);
    } catch (e: any) { new Notice("AI 请求失败：" + e.message); }
  }

  private renderAIChat(parent: HTMLElement) {
    parent.querySelector(".feynman-ai-card")?.remove();
    const card = parent.createDiv("feynman-card feynman-ai-card");
    const lastAI = [...this.state.aiHistory].reverse().find(m => m.role === "assistant");
    if (!lastAI) return;

    card.createDiv({ cls: "feynman-ai-label", text: "🤖 AI 扮演「完全不懂的人」" });
    const msgEl = card.createDiv({ cls: "feynman-ai-message", text: lastAI.content });

    this.lbl(card, "我的回答");
    const replyTA = this.ta(card, "回答 AI 的追问……");

    const row = this.btnRow(card);
    this.btn(row, "继续追问", "secondary", async () => {
      const reply = replyTA.value.trim();
      if (!reply) { new Notice("请先回答 AI 的问题"); return; }
      this.state.aiHistory.push({ role: "user", content: reply });
      msgEl.textContent = "思考中…";
      try {
        const aiReply = await this.callDeepSeek(this.state.aiHistory);
        this.state.aiHistory.push({ role: "assistant", content: aiReply });
        msgEl.textContent = aiReply; replyTA.value = "";
      } catch (e: any) { new Notice("AI 请求失败：" + e.message); msgEl.textContent = lastAI.content; }
    });

    const summaryBtn = this.btn(row, "AI 总结我的漏洞", "warn", async () => {
      summaryBtn.disabled = true; summaryBtn.textContent = "分析中…";
      try {
        const gaps = await this.callDeepSeek([
          { role: "system", content: "你是一个学习教练。根据以下对话，列出学生最可能还没搞清楚的3个知识点。格式：每点一行，前面加「·」，简洁，用中文。" },
          { role: "user", content: `概念：${this.state.concept}\n\n对话：\n${this.state.aiHistory.filter(m => m.role !== "system").map(m => `${m.role === "user" ? "学生" : "提问者"}：${m.content}`).join("\n\n")}` },
        ]);
        this.state.gaps = gaps; // pre-populate step 2 regardless of which button user clicks
        parent.querySelector(".feynman-gap-summary")?.remove();
        const gc = parent.createDiv("feynman-card feynman-gap-summary");
        gc.createDiv({ cls: "feynman-ai-label", text: "🔍 AI 分析的可能漏洞" });
        gc.createDiv({ cls: "feynman-ai-message", text: gaps });
        const gr = this.btnRow(gc);
        this.btn(gr, "带着这些漏洞继续 →", "primary", () => { this.state.step = 2; this.render(); });
      } catch (e: any) { new Notice("AI 请求失败：" + e.message); }
      finally { summaryBtn.disabled = false; summaryBtn.textContent = "AI 总结我的漏洞"; }
    });

    this.btn(row, "已找到漏洞 →", "primary", () => { this.state.step = 2; this.render(); });
  }

  // ─── Step 2 ───────────────────────────────────────────────────────────────

  private renderStep2(parent: HTMLElement) {
    const card = parent.createDiv("feynman-card");
    this.badge(card, "第二步 · 找出漏洞");
    card.createEl("h2", { text: "哪里还不清楚？" });
    this.hint(card, "诚实列出没说清楚、说错了、或绕开的地方，然后去原材料里补上这些漏洞。");

    if (this.state.explanation) {
      const ref = card.createEl("details", { cls: "feynman-ref-details" });
      ref.createEl("summary", { cls: "feynman-ref-summary", text: "📝 查看第一步的原始解释" });
      ref.createDiv({ cls: "feynman-ref-content", text: this.state.explanation });
    }

    this.lbl(card, "知识漏洞清单");
    const gapsTA = this.ta(card, "例如：\n- 我不知道为什么量子纠缠不能用来传递信息\n- 我对「叠加态」的解释太模糊了", this.state.gaps);
    const row = this.btnRow(card);
    this.btn(row, "← 返回", "secondary", () => { this.state.step = 1; this.render(); });
    this.btn(row, "漏洞已补全 →", "primary", () => { this.state.gaps = gapsTA.value.trim(); this.state.step = 3; this.render(); });
  }

  // ─── Step 3 ───────────────────────────────────────────────────────────────

  private renderStep3(parent: HTMLElement) {
    const card = parent.createDiv("feynman-card");
    this.badge(card, "第三步 · 简化与类比");
    card.createEl("h2", { text: "用最简单的方式重新解释" });
    this.hint(card, "把解释精简到核心，加入类比或故事，让一个 10 岁的孩子也能听懂。");
    this.lbl(card, "最终简化版解释");
    const finalTA = this.ta(card, "把概念解释到极简……", this.state.finalExplanation);
    this.lbl(card, "类比 / 故事 / 例子");
    const analogyTA = this.ta(card, "例如：量子纠缠就像一双手套……", this.state.analogy);
    const row = this.btnRow(card);
    this.btn(row, "← 返回", "secondary", () => { this.state.step = 2; this.render(); });
    const completeBtn = this.btn(row, "完成 →", "primary", async () => {
      const final = finalTA.value.trim();
      if (!final) { new Notice("请写出最终简化版解释"); return; }
      this.state.finalExplanation = final;
      this.state.analogy = analogyTA.value.trim();

      const gaps = this.state.gaps?.trim();
      if (gaps && gaps !== "（未填写）") {
        completeBtn.disabled = true;
        completeBtn.textContent = "AI 验证中…";
        await this.verifyGapsCovered(card, completeBtn);
      } else {
        this.state.step = 4;
        this.render();
      }
    });
  }

  private async verifyGapsCovered(parent: HTMLElement, triggerBtn: HTMLButtonElement) {
    parent.querySelector(".feynman-gap-verify")?.remove();
    const verifyCard = parent.createDiv("feynman-gap-verify");
    verifyCard.createDiv({ cls: "feynman-ai-label", text: "✅ AI 检查漏洞覆盖情况" });

    try {
      const result = await this.callDeepSeek([
        {
          role: "system",
          content: "你是一个严格的学习检查员。根据学生之前列出的知识漏洞清单，逐条检查他的最终解释是否覆盖了每个漏洞。每条漏洞输出一行：「· [漏洞简述] → ✓已覆盖 / △部分覆盖 / ✗未覆盖」。最后一行输出：总结：（一句话）",
        },
        {
          role: "user",
          content: `概念：${this.state.concept}\n\n知识漏洞清单：\n${this.state.gaps}\n\n最终解释：\n${this.state.finalExplanation}`,
        },
      ], 400);

      verifyCard.createDiv({ cls: "feynman-ai-message", text: result });

      const allCovered = !result.includes("✗未覆盖");
      const btnRow = verifyCard.createDiv("feynman-btn-row");
      this.btn(btnRow, "← 继续完善", "secondary", () => {
        verifyCard.remove();
        triggerBtn.disabled = false;
        triggerBtn.textContent = "完成 →";
      });
      this.btn(btnRow, allCovered ? "全部覆盖，完成 →" : "已经够好了，继续 →", "primary", () => {
        this.state.step = 4;
        this.render();
      });
    } catch (e: any) {
      verifyCard.createDiv({ cls: "feynman-hint", text: "AI 验证失败：" + e.message });
      triggerBtn.disabled = false;
      triggerBtn.textContent = "完成 →";
    }
  }

  // ─── Step 4: Summary ──────────────────────────────────────────────────────

  private renderStep4(parent: HTMLElement) {
    const card = parent.createDiv("feynman-card");
    this.badge(card, "完成 🎉");
    card.createEl("h2", { text: `「${this.state.concept}」学习总结` });

    const grid = card.createDiv("feynman-summary-grid");
    for (const { label, value } of [
      { label: "概念", value: this.state.concept + (this.state.why ? `\n学习动机：${this.state.why}` : "") },
      { label: "第一步解释", value: this.state.explanation },
      { label: "知识漏洞", value: this.state.gaps || "（未填写）" },
      { label: "最终简化版", value: this.state.finalExplanation },
      { label: "类比 / 例子", value: this.state.analogy || "（未填写）" },
    ]) {
      const row = grid.createDiv("feynman-summary-item");
      row.createEl("label", { text: label });
      row.createEl("p", { text: value });
    }

    const checkWrap = card.createDiv("feynman-checklist-wrap");
    checkWrap.createEl("p", { cls: "feynman-checklist-title", text: "自检清单" });
    for (const c of ["我能不看笔记解释这个概念", "我的解释全程没有用术语", "我知道自己哪里还不够懂", "我能举一个现实中的例子", "我能回答「为什么」这个概念是这样的"]) {
      const li = checkWrap.createDiv("feynman-check-item");
      li.createEl("input", { attr: { type: "checkbox" } });
      li.createSpan({ text: c });
    }

    const row = this.btnRow(card);
    this.btn(row, "💾 保存到 vault", "primary", () => { this.showSavePreview(card, parent); });
    this.btn(row, "🧪 AI 测验", "warn", async () => { await this.startQuiz(parent); });
    this.btn(row, "📋 复制", "secondary", () => {
      navigator.clipboard.writeText(this.buildNoteContent(moment().format("YYYY-MM-DD")));
      new Notice("笔记已复制到剪贴板");
    });
    this.btn(row, "🔗 概念关联", "secondary", async () => {
      await this.findConceptConnections(this.state.concept, parent);
    });
    this.btn(row, "学下一个 →", "secondary", () => { this.state = emptyState(); this.render(); });

    // Show recommendations if already fetched
    if (this.state.recommendations.length > 0) {
      this.renderRecommendations(parent);
    }
  }

  private showSavePreview(card: HTMLElement, parent?: HTMLElement) {
    card.querySelector(".feynman-save-preview")?.remove();
    const preview = card.createDiv("feynman-save-preview");
    preview.createDiv({ cls: "feynman-ai-label", text: "💾 确认文件名" });
    const date = moment().format("YYYY-MM-DD");
    const defaultStem = this.state.savedStem || `${date} ${sanitizeFilename(this.state.concept)}`;
    preview.createDiv({ cls: "feynman-hint", text: `保存位置：${this.plugin.settings.notesFolder}/` });
    this.lbl(preview, "文件名（.md 自动添加）");
    const nameInp = this.inp(preview, "文件名……", defaultStem);
    const btnRow = this.btnRow(preview);
    this.btn(btnRow, "取消", "secondary", () => preview.remove());
    const confirmBtn = this.btn(btnRow, "确认保存", "primary", async () => {
      const stem = nameInp.value.trim();
      if (!stem) { new Notice("请输入文件名"); return; }
      confirmBtn.disabled = true; confirmBtn.textContent = "保存中…";
      await this.saveNote(parent, stem);
      confirmBtn.textContent = "✓ 已保存";
    });
  }

  private renderRecommendations(parent: HTMLElement) {
    parent.querySelector(".feynman-rec-card")?.remove();
    const card = parent.createDiv("feynman-card feynman-rec-card");
    card.createDiv({ cls: "feynman-ai-label", text: "💡 接下来可以学" });
    const chips = card.createDiv("feynman-rec-chips");
    for (const rec of this.state.recommendations) {
      const chip = chips.createDiv({ cls: "feynman-rec-chip", text: rec });
      chip.addEventListener("click", () => {
        this.state = emptyState();
        this.state.concept = rec;
        this.state.step = 1;
        this.render();
      });
    }
  }

  // ─── Step 5: Quiz ─────────────────────────────────────────────────────────

  private async startQuiz(parent: HTMLElement) {
    if (!this.plugin.settings.apiKey) { new Notice("请先在插件设置中填写 DeepSeek API Key"); return; }
    const btn = parent.querySelector(".feynman-btn-warn") as HTMLButtonElement;
    if (btn) { btn.disabled = true; btn.textContent = "出题中…"; }
    try {
      const result = await this.callDeepSeek([
        { role: "system", content: "你是一个出题老师，只输出题目，不做任何其他解释。每道题独立一行，格式：1. 题目内容" },
        { role: "user", content: `根据以下关于「${this.state.concept}」的笔记，出3道理解型测验题（考察理解而非死记硬背）：\n${this.state.finalExplanation}\n${this.state.analogy}` },
      ]);
      this.state.quizQuestions = result.split("\n").filter(l => l.trim().match(/^\d+\./)).map(l => l.replace(/^\d+\.\s*/, "").trim()).slice(0, 3);
      if (this.state.quizQuestions.length === 0) this.state.quizQuestions = result.split("\n").filter(l => l.trim()).slice(0, 3);
      this.state.quizAnswers = new Array(this.state.quizQuestions.length).fill("");
      this.state.quizFeedback = "";
      this.state.step = 5;
      this.render();
    } catch (e: any) {
      new Notice("AI 请求失败：" + e.message);
      if (btn) { btn.disabled = false; btn.textContent = "🧪 AI 测验"; }
    }
  }

  private renderStep5(parent: HTMLElement) {
    const card = parent.createDiv("feynman-card");
    this.badge(card, "🧪 AI 测验");
    card.createEl("h2", { text: `测验：「${this.state.concept}」` });
    this.hint(card, "用自己的话回答，不用追求完美，AI 会给出反馈。");

    const answerEls: HTMLTextAreaElement[] = [];
    this.state.quizQuestions.forEach((q, i) => {
      const qWrap = card.createDiv("feynman-quiz-item");
      qWrap.createDiv({ cls: "feynman-quiz-q", text: `${i + 1}. ${q}` });
      answerEls.push(this.ta(qWrap, "写下你的回答……", this.state.quizAnswers[i] || ""));
    });

    if (this.state.quizFeedback) {
      const fb = card.createDiv("feynman-feedback-wrap");
      fb.createDiv({ cls: "feynman-ai-label", text: "📝 AI 评价" });
      fb.createDiv({ cls: "feynman-ai-message", text: this.state.quizFeedback });
    }

    const row = this.btnRow(card);
    this.btn(row, "← 返回总结", "secondary", () => { this.state.step = 4; this.render(); });
    const evalBtn = this.btn(row, "提交，让 AI 评价", "primary", async () => {
      const answers = answerEls.map(el => el.value.trim());
      if (answers.some(a => !a)) { new Notice("请回答所有问题"); return; }
      this.state.quizAnswers = answers;
      evalBtn.disabled = true; evalBtn.textContent = "AI 评价中…";
      try {
        const feedback = await this.callDeepSeek([
          { role: "system", content: "你是一个耐心的老师，给出建设性评价，鼓励为主。用中文。" },
          { role: "user", content: `学生学习的概念是「${this.state.concept}」。请逐题评价（对✓/部分正确△/需改进✗）并给一句话反馈，最后给总体建议。\n\n${this.state.quizQuestions.map((q, i) => `题目${i + 1}：${q}\n学生回答：${this.state.quizAnswers[i]}`).join("\n\n")}` },
        ]);
        this.state.quizFeedback = feedback;
        this.render();
      } catch (e: any) { new Notice("AI 请求失败：" + e.message); evalBtn.disabled = false; evalBtn.textContent = "提交，让 AI 评价"; }
    });
    if (this.state.quizFeedback) {
      this.btn(row, "💾 保存并结束", "primary", () => { this.showSavePreview(card, parent); });
    }
  }

  // ─── AI & Save helpers ────────────────────────────────────────────────────

  private async callDeepSeek(messages: { role: string; content: string }[], maxTokens = 800): Promise<string> {
    const { apiKey, apiBase, model, temperature } = this.plugin.settings;
    const base = apiBase.replace(/\/$/, "");
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(parseApiError(resp.status, body));
    }
    return (await resp.json()).choices[0].message.content as string;
  }

  private buildNoteContent(date: string): string {
    const reviewDate = moment(date).add(REVIEW_INTERVALS[0], "days").format("YYYY-MM-DD");
    const aiLog = this.state.aiHistory.filter(m => m.role !== "system")
      .map(m => `**${m.role === "user" ? "我" : "AI"}：** ${m.content}`).join("\n\n");
    const quizSection = this.state.quizQuestions.length > 0
      ? `\n## AI 测验\n\n${this.state.quizQuestions.map((q, i) => `**题目 ${i + 1}：** ${q}\n\n**我的回答：** ${this.state.quizAnswers[i] || "（未回答）"}`).join("\n\n")}\n\n**AI 评价：**\n\n${this.state.quizFeedback || "（未评价）"}\n`
      : "";

    return `---
tags: [费曼学习法]
概念: ${yamlStr(this.state.concept)}
日期: ${date}
掌握程度: 初识
review_date: ${reviewDate}
review_count: 0
---

# ${this.state.concept}

${this.state.why ? `> 学习动机：${this.state.why}\n` : ""}
## 第一步：简单解释

${this.state.explanation}

## AI 追问记录

${aiLog || "（未使用 AI 追问）"}

## 第二步：知识漏洞

${this.state.gaps || "（未填写）"}

## 第三步：最终简化版

${this.state.finalExplanation}

## 类比 / 例子

${this.state.analogy || "（未填写）"}
${quizSection}
## 自检清单

- [ ] 我能不看笔记解释这个概念
- [ ] 我的解释全程没有用术语
- [ ] 我知道自己哪里还不够懂
- [ ] 我能举一个现实中的例子
- [ ] 我能回答「为什么」这个概念是这样的
`;
  }

  private async saveNote(parent?: HTMLElement, customStem?: string) {
    const { vault } = this.app;
    const folder = this.plugin.settings.notesFolder;
    const date = moment().format("YYYY-MM-DD");
    const stem = customStem ?? `${date} ${sanitizeFilename(this.state.concept)}`;
    const filename = `${folder}/${stem}.md`;

    if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);

    const content = this.buildNoteContent(date);
    const existing = vault.getAbstractFileByPath(filename);
    existing instanceof TFile ? await vault.modify(existing, content) : await vault.create(filename, content);
    this.state.savedStem = stem;

    await this.updateIndex(stem, date);
    await this.plugin.recordLearningDate();

    // Notion sync
    if (this.plugin.settings.notionToken && this.plugin.settings.notionDatabaseId) {
      try { await this.syncToNotion(); new Notice(`「${this.state.concept}」已保存并同步到 Notion ✓`); }
      catch (e: any) { new Notice(`笔记已保存，Notion 同步失败：${e.message}`); }
    } else {
      new Notice(`「${this.state.concept}」已保存，明天提醒复习 ✓`);
    }

    // Open note
    const file = vault.getAbstractFileByPath(filename);
    if (file instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(file);

    // Fetch AI recommendations in background
    if (this.plugin.settings.apiKey) {
      this.fetchRecommendations(parent);
    }
  }

  private async fetchRecommendations(parent?: HTMLElement) {
    try {
      const all = this.plugin.getAllConcepts().map(c => c.concept);
      const existing = all.length > 0 ? `（已学过：${all.slice(0, 10).join("、")}，不要重复推荐）` : "";
      const result = await this.callDeepSeek([
        { role: "system", content: "你是一个学习顾问，推荐接下来值得学习的相关概念。只输出概念名称，每个名称一行，共3个，不要编号或解释。" },
        { role: "user", content: `刚学完「${this.state.concept}」${this.state.why ? `，学习动机是：${this.state.why}` : ""}。推荐3个接下来值得学习的相关概念。${existing}` },
      ], 200);
      this.state.recommendations = result.split("\n").map(l => l.trim()).filter(l => l && !l.match(/^\d+\./)).slice(0, 3);
      if (parent) this.renderRecommendations(parent);
    } catch {
      // Recommendations are optional, ignore errors
    }
  }

  private async updateIndex(stem: string, date: string) {
    const { vault } = this.app;
    const file = vault.getAbstractFileByPath(this.plugin.settings.indexFile);
    if (!(file instanceof TFile)) return;
    const noteLink = `[[${this.plugin.settings.notesFolder}/${stem}|${this.state.concept}]]`;
    const content = await vault.read(file);
    const updated = content.replace(/(\| *\n*$)/m, `| ${noteLink} | | 初识 | 进行中 | ${date} |\n$1`);
    if (updated !== content) await vault.modify(file, updated);
  }

  private async syncToNotion() {
    const { notionToken, notionDatabaseId } = this.plugin.settings;
    const resp = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: { "Authorization": "Bearer " + notionToken, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
      body: JSON.stringify({
        parent: { database_id: notionDatabaseId },
        properties: {
          "概念名称": { title: [{ text: { content: this.state.concept } }] },
          "学科领域": { select: { name: "其他" } },
          "掌握程度": { select: { name: "初识" } },
          "状态": { select: { name: "进行中" } },
          "第一步_概念描述": { rich_text: [{ text: { content: truncate(this.state.why || this.state.concept) } }] },
          "第二步_简单解释": { rich_text: [{ text: { content: truncate(this.state.explanation) } }] },
          "第三步_知识漏洞": { rich_text: [{ text: { content: truncate(this.state.gaps || "（未填写）") } }] },
          "第四步_类比简化": { rich_text: [{ text: { content: truncate((this.state.finalExplanation + "\n\n" + (this.state.analogy || "")).trim()) } }] },
        },
      }),
    });
    if (!resp.ok) { const err = await resp.json(); throw new Error(err.message || resp.statusText); }
  }

  private async saveFailedReviewToNote(
    file: TFile,
    dimensions: { label: string; score: string; note: string }[],
    evalText: string,
  ) {
    try {
      const content = await this.app.vault.read(file);
      const date = moment().format("YYYY-MM-DD");
      const dimLines = dimensions.map(d => `  - ${d.label}：${d.score}${d.note ? " — " + d.note : ""}`).join("\n");
      const entry = `\n### ${date} · ✗ 未通过\n${dimLines}${evalText ? `\n  > ${evalText}` : ""}`;
      const updated = content.includes("## 复习记录")
        ? content.replace("## 复习记录", `## 复习记录${entry}`)
        : content + `\n## 复习记录${entry}\n`;
      await this.app.vault.modify(file, updated);
    } catch { /* non-critical */ }
  }

  private async renderWeakPointDrill(
    container: HTMLElement,
    concept: string,
    dimensions: { label: string; score: string; note: string }[],
  ) {
    container.querySelector(".feynman-drill")?.remove();
    const drillCard = container.createDiv("feynman-drill");
    drillCard.createDiv({ cls: "feynman-ai-label", text: "🎯 弱点专项练习" });

    const weakDims = dimensions.filter(d => d.score === "✗" || d.score === "△");
    if (weakDims.length === 0) {
      drillCard.createDiv({ cls: "feynman-hint", text: "没有检测到弱点维度" });
      return;
    }

    const dimDesc = weakDims.map(d => `${d.label}（${d.score === "✗" ? "未掌握" : "部分掌握"}：${d.note || "需加强"}`).join("；");
    const loadingEl = drillCard.createDiv({ cls: "feynman-hint", text: "AI 生成针对性练习题中…" });

    try {
      const result = await this.callDeepSeek([
        {
          role: "system",
          content: "你是一个针对薄弱点出练习题的老师。根据学生存在不足的维度，生成2-3道针对性练习题。要求：每道题聚焦一个薄弱维度，考察理解而非死记硬背，难度适中。格式：每题独立一行，前加「Q：」。",
        },
        {
          role: "user",
          content: `概念：「${concept}」\n薄弱维度：${dimDesc}`,
        },
      ], 500);

      loadingEl.remove();

      const questions = result
        .split("\n")
        .filter(l => l.trim().match(/^Q[:：]/))
        .map(l => l.replace(/^Q[:：]\s*/, "").trim())
        .filter(Boolean)
        .slice(0, 3);

      if (questions.length === 0) {
        drillCard.createDiv({ cls: "feynman-hint", text: "未能生成练习题，请重试" });
        return;
      }

      const answerEls: HTMLTextAreaElement[] = [];
      for (const q of questions) {
        const qWrap = drillCard.createDiv("feynman-quiz-item");
        qWrap.createDiv({ cls: "feynman-quiz-q", text: q });
        answerEls.push(this.ta(qWrap, "写下你的回答……"));
      }

      const btnRow = this.btnRow(drillCard);
      const submitBtn = this.btn(btnRow, "提交答案，获取反馈", "primary", async () => {
        const answers = answerEls.map(el => el.value.trim());
        if (answers.some(a => !a)) { new Notice("请回答所有练习题"); return; }
        submitBtn.disabled = true; submitBtn.textContent = "AI 评价中…";
        try {
          const feedback = await this.callDeepSeek([
            {
              role: "system",
              content: "你是一个耐心的学习教练。学生刚完成了针对薄弱维度的专项练习。逐题给出简短评价，重点判断是否真正理解了该薄弱点（用✓/△/✗开头）。最后一行给一句鼓励。用中文，语气友好。",
            },
            {
              role: "user",
              content: `概念：「${concept}」\n薄弱维度：${dimDesc}\n\n${questions.map((q, i) => `题目：${q}\n回答：${answers[i]}`).join("\n\n")}`,
            },
          ], 500);

          drillCard.querySelector(".feynman-drill-feedback")?.remove();
          const fbEl = drillCard.createDiv("feynman-drill-feedback");
          fbEl.createDiv({ cls: "feynman-ai-label", text: "📝 练习反馈" });
          fbEl.createDiv({ cls: "feynman-ai-message", text: feedback });
          submitBtn.textContent = "再练一次";
          submitBtn.disabled = false;
          submitBtn.onclick = () => {
            answerEls.forEach(el => { el.value = ""; });
            drillCard.querySelector(".feynman-drill-feedback")?.remove();
          };
        } catch (e: any) {
          new Notice("AI 请求失败：" + e.message);
          submitBtn.disabled = false; submitBtn.textContent = "提交答案，获取反馈";
        }
      });
    } catch (e: any) {
      loadingEl.textContent = "AI 请求失败：" + e.message;
    }
  }

  private async generateWeeklyReport() {
    const weekData = this.plugin.getWeeklyData();
    const isoWeek = moment().isoWeek();
    const weekStr = `${moment().isoWeekYear()}-W${String(isoWeek).padStart(2, "0")}`;
    const weekStart = moment().startOf("isoWeek").format("YYYY-MM-DD");
    const weekEnd = moment().endOf("isoWeek").format("YYYY-MM-DD");

    new Notice("生成周报中…");

    let aiReflection = "";
    if (this.plugin.settings.apiKey) {
      try {
        const statsText = `本周新学概念 ${weekData.newConcepts.length} 个（${weekData.newConcepts.map(c => c.concept).join("、") || "无"}），复习 ${weekData.reviews.length} 次，通过率 ${weekData.passRate}，连续学习 ${this.plugin.calcStreak()} 天。`;
        aiReflection = await this.callDeepSeek([
          { role: "system", content: "你是一个温暖的学习教练。根据用户本周的学习数据，写一段简短的学习反思（100字以内），肯定进步，给出下周一个具体的学习建议。用中文，语气轻松友好。" },
          { role: "user", content: statsText },
        ], 300);
      } catch { /* optional */ }
    }

    const conceptSection = weekData.newConcepts.length > 0
      ? weekData.newConcepts.map(c => `- [[${this.plugin.settings.notesFolder}/${c.date} ${sanitizeFilename(c.concept)}|${c.concept}]] · ${c.mastery}`).join("\n")
      : "本周暂无新概念";

    const reviewRows = weekData.reviews.map(r =>
      `| ${r.concept} | ${r.date} | ${r.passed ? "✓ 通过" : "✗ 未通过"} |`
    ).join("\n");

    const content = `---
tags: [费曼周报]
week: ${weekStr}
---

# 📊 费曼学习周报 · ${moment().isoWeekYear()}年第${isoWeek}周
> ${weekStart} ～ ${weekEnd}

## 数据概览

| 指标 | 本周 |
|------|------|
| 新学概念 | ${weekData.newConcepts.length} 个 |
| 完成复习 | ${weekData.reviews.length} 次 |
| 复习通过率 | ${weekData.passRate} |
| 连续学习 | ${this.plugin.calcStreak()} 天 |

## 本周学习的概念

${conceptSection}

## 本周复习情况

${reviewRows ? `| 概念 | 日期 | 结果 |\n|------|------|------|\n${reviewRows}` : "本周暂无复习记录"}
${aiReflection ? `\n## AI 学习反思\n\n${aiReflection}\n` : ""}`;

    const folder = "费曼周报";
    const { vault } = this.app;
    if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
    const filename = `${folder}/${weekStr}.md`;
    const existing = vault.getAbstractFileByPath(filename);
    existing instanceof TFile ? await vault.modify(existing, content) : await vault.create(filename, content);
    const file = vault.getAbstractFileByPath(filename);
    if (file instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(file);
    new Notice(`周报已生成 ✓`);
  }

  private async findConceptConnections(concept: string, parent: HTMLElement) {
    const allConcepts = this.plugin.getAllConcepts().map(c => c.concept).filter(c => c !== concept);
    if (allConcepts.length < 2) {
      new Notice("至少需要学过 2 个其他概念才能发现关联");
      return;
    }

    parent.querySelector(".feynman-connections-card")?.remove();
    const card = parent.createDiv("feynman-card feynman-connections-card");
    card.createDiv({ cls: "feynman-ai-label", text: "🔗 分析关联中…" });

    try {
      const result = await this.callDeepSeek([
        { role: "system", content: "你是一个知识关联专家。从给定的已学概念列表中，找出与目标概念最相关的最多3个概念，并用一句话说明关联方式。严格按格式输出，每行：概念名 | 关联说明。不超过3行。如果确实没有相关概念就输出「无」。" },
        { role: "user", content: `目标概念：「${concept}」\n已学概念：${allConcepts.join("、")}` },
      ], 300);

      card.empty();
      card.createDiv({ cls: "feynman-ai-label", text: "🔗 相关概念" });

      if (result.trim() === "无" || !result.includes("|")) {
        card.createDiv({ cls: "feynman-hint", text: "暂时没有发现强关联，继续学习更多概念后再试" });
        return;
      }

      const connections: { name: string; desc: string }[] = [];
      for (const line of result.split("\n").filter(l => l.includes("|")).slice(0, 3)) {
        const parts = line.split("|");
        const name = parts[0].replace(/「|」/g, "").trim();
        const desc = parts[1]?.trim() ?? "";
        if (name && desc) connections.push({ name, desc });
      }

      if (connections.length === 0) {
        card.createDiv({ cls: "feynman-hint", text: "暂时没有发现强关联" });
        return;
      }

      const grid = card.createDiv("feynman-connections-grid");
      for (const conn of connections) {
        const item = grid.createDiv("feynman-connection-item");
        const match = this.plugin.getAllConcepts().find(c => c.concept === conn.name);
        const nameEl = item.createDiv({ cls: `feynman-connection-name${match ? " feynman-connection-link" : ""}`, text: conn.name });
        if (match) nameEl.addEventListener("click", () => this.app.workspace.getLeaf("tab").openFile(match.file));
        item.createDiv({ cls: "feynman-connection-desc", text: conn.desc });
      }

      const btnRow = card.createDiv("feynman-btn-row");
      this.btn(btnRow, "添加关联链接到笔记", "secondary", async () => {
        const stem = this.state.savedStem || `${moment().format("YYYY-MM-DD")} ${sanitizeFilename(concept)}`;
        const filename = `${this.plugin.settings.notesFolder}/${stem}.md`;
        const file = this.app.vault.getAbstractFileByPath(filename);
        if (!(file instanceof TFile)) { new Notice("请先保存笔记再添加关联"); return; }
        const content = await this.app.vault.read(file);
        if (content.includes("## 相关概念")) { new Notice("关联链接已存在"); return; }
        const links = connections.map(c => {
          const m = this.plugin.getAllConcepts().find(x => x.concept === c.name);
          return m ? `- [[${m.file.path}|${c.name}]]：${c.desc}` : `- ${c.name}：${c.desc}`;
        }).join("\n");
        await this.app.vault.modify(file, content + `\n## 相关概念\n\n${links}\n`);
        new Notice("关联链接已添加到笔记 ✓");
      });

    } catch (e: any) {
      card.empty();
      card.createDiv({ cls: "feynman-hint", text: "AI 请求失败：" + e.message });
    }
  }

  loadConcept(concept: string) {
    this.state = emptyState();
    this.state.concept = concept;
    this.state.step = 1;
    this.render();
  }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class FeynmanSettingTab extends PluginSettingTab {
  plugin: FeynmanPlugin;
  constructor(app: App, plugin: FeynmanPlugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "费曼学习法 设置" });

    containerEl.createEl("h3", { text: "AI 设置" });
    new Setting(containerEl).setName("API Key").setDesc("DeepSeek / OpenAI / 其他兼容服务的 API Key")
      .addText(t => t.setPlaceholder("sk-...").setValue(this.plugin.settings.apiKey)
        .then(t => { t.inputEl.type = "password"; })
        .onChange(async v => { this.plugin.settings.apiKey = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("API Base URL").setDesc("兼容 OpenAI 格式的接口地址")
      .addText(t => t.setPlaceholder("https://api.deepseek.com/v1").setValue(this.plugin.settings.apiBase)
        .onChange(async v => { this.plugin.settings.apiBase = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("模型名称").setDesc("例如 deepseek-chat、gpt-4o、claude-3-5-sonnet-20241022")
      .addText(t => t.setPlaceholder("deepseek-chat").setValue(this.plugin.settings.model)
        .onChange(async v => { this.plugin.settings.model = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Temperature").setDesc("生成随机性，0 最保守，1 最发散（默认 0.8）")
      .addSlider(s => s.setLimits(0, 1, 0.1).setValue(this.plugin.settings.temperature).setDynamicTooltip()
        .onChange(async v => { this.plugin.settings.temperature = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("测试连接").setDesc("用当前设置发送一次测试请求，确认 Key、地址、模型均正确")
      .addButton(b => b.setButtonText("测试连接").onClick(async () => {
        const { apiKey, apiBase, model } = this.plugin.settings;
        if (!apiKey) { new Notice("请先填写 API Key"); return; }
        b.setButtonText("测试中…").setDisabled(true);
        try {
          const base = apiBase.replace(/\/$/, "");
          const resp = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
            body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }], max_tokens: 1 }),
          });
          if (!resp.ok) {
            const body = await resp.json().catch(() => ({}));
            throw new Error(parseApiError(resp.status, body));
          }
          const data = await resp.json();
          new Notice(`✓ 连接成功（模型：${data.model ?? model}）`);
        } catch (e: any) {
          new Notice(`✗ ${e.message}`);
        } finally {
          b.setButtonText("测试连接").setDisabled(false);
        }
      }));

    containerEl.createEl("h3", { text: "笔记设置" });
    new Setting(containerEl).setName("笔记保存目录").setDesc("相对于 vault 根目录的路径")
      .addText(t => t.setPlaceholder("01.读书笔记/费曼笔记").setValue(this.plugin.settings.notesFolder)
        .onChange(async v => { this.plugin.settings.notesFolder = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("概念索引文件").setDesc("费曼学习索引文件的路径")
      .addText(t => t.setPlaceholder("01.读书笔记/费曼学习索引.md").setValue(this.plugin.settings.indexFile)
        .onChange(async v => { this.plugin.settings.indexFile = v; await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "Notion 同步" });
    containerEl.createEl("p", { cls: "feynman-settings-desc", text: "填写后保存笔记时自动同步到 Notion，留空则不同步。" });
    new Setting(containerEl).setName("Notion Integration Token").setDesc("在 notion.so/my-integrations 创建集成后获取")
      .addText(t => t.setPlaceholder("secret_...").setValue(this.plugin.settings.notionToken)
        .then(t => { t.inputEl.type = "password"; })
        .onChange(async v => { this.plugin.settings.notionToken = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Notion 数据库 ID").setDesc("填写后可同步到你的 Notion 数据库")
      .addText(t => t.setPlaceholder("数据库 ID").setValue(this.plugin.settings.notionDatabaseId)
        .onChange(async v => { this.plugin.settings.notionDatabaseId = v; await this.plugin.saveSettings(); }));
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class FeynmanPlugin extends Plugin {
  settings: FeynmanSettings;
  learningDates: string[] = [];
  reviewHistory: ReviewRecord[] = [];
  learningQueue: string[] = [];

  async onload() {
    await this.loadSettings();
    const data = await this.loadData();
    this.learningDates = data?.learningDates ?? [];
    this.reviewHistory = data?.reviewHistory ?? [];
    this.learningQueue = data?.learningQueue ?? [];

    this.registerView(VIEW_TYPE, leaf => new FeynmanView(leaf, this));
    this.addRibbonIcon("brain", "费曼学习法", () => this.activateView());

    this.addCommand({ id: "open-feynman-view", name: "打开费曼学习面板", callback: () => this.activateView() });
    this.addCommand({
      id: "feynman-quick-capture", name: "用费曼法学习选中文字",
      editorCallback: (editor: Editor) => {
        const selected = editor.getSelection().trim();
        if (!selected) { new Notice("请先选中一段文字"); return; }
        this.activateView().then(() => {
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
          if (leaves.length > 0) (leaves[0].view as FeynmanView).loadConcept(selected);
        });
      },
    });

    this.addSettingTab(new FeynmanSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => this.notifyDueReviews());
  }

  async onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE); }

  async activateView() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  // ─── Data ────────────────────────────────────────────────────────────────

  getAllConcepts(): ConceptMeta[] {
    const folder = this.settings.notesFolder;
    return this.app.vault.getMarkdownFiles()
      .filter(f => f.path.startsWith(folder + "/"))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .flatMap(file => {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!fm) return [];
        return [{ concept: fm.概念 || file.basename, date: fm.日期 || "", mastery: fm.掌握程度 || "初识", subject: fm.学科 || "", file }];
      });
  }

  getRecentConcepts(n: number): ConceptMeta[] {
    return this.getAllConcepts().slice(0, n);
  }

  getDueConcepts(): DueConcept[] {
    const today = moment().format("YYYY-MM-DD");
    const folder = this.settings.notesFolder;
    return this.app.vault.getMarkdownFiles()
      .filter(f => f.path.startsWith(folder + "/"))
      .flatMap(file => {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!fm?.review_date || fm.review_date === "completed" || fm.review_date > today) return [];
        return [{ file, concept: fm.概念 || file.basename, reviewCount: fm.review_count ?? 0 }];
      });
  }

  getStats() {
    const all = this.getAllConcepts();
    const weekStart = moment().startOf("isoWeek");
    const mastery: Record<string, number> = {};
    let thisWeek = 0;
    for (const c of all) {
      mastery[c.mastery] = (mastery[c.mastery] ?? 0) + 1;
      if (c.date && moment(c.date).isSameOrAfter(weekStart)) thisWeek++;
    }
    return { total: all.length, thisWeek, dueCount: this.getDueConcepts().length, streak: this.calcStreak(), mastery };
  }

  calcStreak(): number {
    const dates = [...new Set(this.learningDates)].sort().reverse();
    if (dates.length === 0) return 0;
    const today = moment().format("YYYY-MM-DD");
    const yesterday = moment().subtract(1, "day").format("YYYY-MM-DD");
    // Streak breaks if didn't learn today or yesterday
    if (dates[0] !== today && dates[0] !== yesterday) return 0;
    let streak = 0;
    let expected = moment(dates[0]);
    for (const d of dates) {
      if (moment(d).isSame(expected, "day")) { streak++; expected.subtract(1, "day"); }
      else break;
    }
    return streak;
  }

  async markReviewed(file: TFile, currentCount: number, passed: boolean, partialPass = false, expertPass = false) {
    const newCount = passed ? currentCount + 1 : currentCount;
    let nextInterval: number | null;
    if (!passed) {
      nextInterval = 1;
    } else {
      nextInterval = REVIEW_INTERVALS[newCount] ?? null;
      if (expertPass && nextInterval !== null) {
        nextInterval = Math.round(nextInterval * 1.3);
      } else if (partialPass && nextInterval !== null) {
        nextInterval = Math.max(1, Math.round(nextInterval * 0.6));
      }
    }
    const nextDate = (passed && nextInterval === null)
      ? "completed"
      : moment().add(nextInterval!, "days").format("YYYY-MM-DD");
    const content = await this.app.vault.read(file);
    const updated = content
      .replace(/^review_date: .+$/m, `review_date: ${nextDate}`)
      .replace(/^review_count: \d+$/m, `review_count: ${newCount}`)
      .replace(/^掌握程度: .+$/m, `掌握程度: ${MASTERY_LEVELS[Math.min(newCount, 3)]}`);
    await this.app.vault.modify(file, updated);
  }

  async recordLearningDate() {
    const today = moment().format("YYYY-MM-DD");
    if (!this.learningDates.includes(today)) {
      this.learningDates.push(today);
      await this.saveData({ ...(await this.loadData()), learningDates: this.learningDates });
    }
  }

  async recordReview(concept: string, passed: boolean) {
    this.reviewHistory.push({ date: moment().format("YYYY-MM-DD"), concept, passed });
    await this.saveData({ ...(await this.loadData()), reviewHistory: this.reviewHistory });
  }

  getConceptReviewStats(concept: string): { total: number; passed: number; rate: string } {
    const records = this.reviewHistory.filter(r => r.concept === concept);
    const passed = records.filter(r => r.passed).length;
    const rate = records.length === 0 ? "—" : `${Math.round(passed / records.length * 100)}%`;
    return { total: records.length, passed, rate };
  }

  getWeeklyData(): { newConcepts: ConceptMeta[]; reviews: ReviewRecord[]; passRate: string } {
    const weekStart = moment().startOf("isoWeek").format("YYYY-MM-DD");
    const newConcepts = this.getAllConcepts().filter(c => c.date >= weekStart);
    const reviews = this.reviewHistory.filter(r => r.date >= weekStart);
    const passed = reviews.filter(r => r.passed).length;
    const passRate = reviews.length === 0 ? "—" : `${Math.round(passed / reviews.length * 100)}%`;
    return { newConcepts, reviews, passRate };
  }

  getOverallReviewStats(): { total: number; passed: number; rate: string } {
    const passed = this.reviewHistory.filter(r => r.passed).length;
    const total = this.reviewHistory.length;
    const rate = total === 0 ? "—" : `${Math.round(passed / total * 100)}%`;
    return { total, passed, rate };
  }

  async addToQueue(concept: string) {
    if (!this.learningQueue.includes(concept)) {
      this.learningQueue.push(concept);
      await this.saveData({ ...(await this.loadData()), learningQueue: this.learningQueue });
    }
  }

  async removeFromQueue(concept: string) {
    this.learningQueue = this.learningQueue.filter(c => c !== concept);
    await this.saveData({ ...(await this.loadData()), learningQueue: this.learningQueue });
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData({ ...(await this.loadData()), ...this.settings }); }
  private notifyDueReviews() {
    const due = this.getDueConcepts();
    if (due.length > 0) new Notice(`📅 有 ${due.length} 个费曼概念待复习`, 8000);
  }
}
