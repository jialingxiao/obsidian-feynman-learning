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
  requestUrl,
} from "obsidian";
import {
  MASTERY_LEVELS,
  REVIEW_INTERVALS,
  calcNextInterval,
  parseApiError,
  parseExtractedConcepts,
  parseReviewVerdict,
  sanitizeFilename,
  truncate,
  yamlStr,
} from "./utils";

const VIEW_TYPE = "feynman-learning-view";
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
  // Notion property names — configurable so users with different database schemas don't get 400 errors
  notionPropTitle: string;    // Title property (concept name)
  notionPropMastery: string;  // Select property for mastery level
  notionPropStatus: string;   // Select property for learning status
  notionPropSubject: string;  // Select property for subject/domain
  reviewIntervals: number[];   // [retry, phase1, phase2] in days, e.g. [1, 7, 30]
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
  notionPropTitle:   "概念名称",
  notionPropMastery: "掌握程度",
  notionPropStatus:  "状态",
  notionPropSubject: "学科领域",
  reviewIntervals: [1, 7, 30],
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

interface DueConcept { file: TFile; concept: string; reviewCount: number; reviewDate: string; mastery: string; }
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


// ─── View ────────────────────────────────────────────────────────────────────

class FeynmanView extends ItemView {
  private plugin: FeynmanPlugin;
  private state: FeynmanState = emptyState();
  private browsing = false;
  private browseSearch = "";
  private browseFilter = "全部";
  private reviewSort: "due" | "mastery" | "name" = "due";
  private batchMode = false;
  private batchIndex = 0;
  private batchQueue: DueConcept[] = [];   // frozen snapshot, set when batch starts

  constructor(leaf: WorkspaceLeaf, plugin: FeynmanPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "费曼学习法"; }
  getIcon() { return "brain"; }

  onOpen() { this.render(); }
  onClose() {}

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
    const el = p.createEl("input", { cls: "feynman-input", attr: { type: "text", placeholder } });
    el.value = value;
    return el;
  }

  private btnRow(p: HTMLElement) { return p.createDiv("feynman-btn-row"); }

  /**
   * Unified AI button state helper.
   * Disables the button and shows loadingText while fn() runs.
   * On error: logs to console + shows Notice (unless silent=true), then restores button.
   * On success: restores button unless keepDisabledOnSuccess=true, which lets fn() set
   *   its own post-success label/state before returning (e.g. "再练一次" or stay disabled).
   */
  private async withAiBtn(
    btn: HTMLButtonElement,
    loadingText: string,
    fn: () => Promise<void>,
    { silent = false, keepDisabledOnSuccess = false }: { silent?: boolean; keepDisabledOnSuccess?: boolean } = {}
  ): Promise<void> {
    const original = btn.textContent ?? "";
    btn.disabled = true;
    btn.textContent = loadingText;
    let succeeded = false;
    try {
      await fn();
      succeeded = true;
    } catch (e) {
      console.error("费曼插件 AI 请求失败", e);
      if (!silent) new Notice("AI 请求失败：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      if (!keepDisabledOnSuccess || !succeeded) {
        btn.disabled = false;
        btn.textContent = original;
      }
    }
  }

  private btn(p: HTMLElement, text: string, cls: string, onClick: () => void | Promise<void>): HTMLButtonElement {
    const b = p.createEl("button", { cls: `feynman-btn feynman-btn-${cls}`, text });
    b.addEventListener("click", () => { void onClick(); });
    return b;
  }

  // ─── Step 0: Dashboard + History + Start ──────────────────────────────────

  private renderStep0(parent: HTMLElement) {
    if (this.batchMode) {
      this.renderBatchReview(parent);
      return;
    }
    if (!this.plugin.settings.apiKey) {
      this.renderOnboarding(parent);
      return;
    }
    this.renderPendingBatchBanner(parent);
    this.renderDashboard(parent);
    this.renderQueue(parent);
    this.renderDueReviews(parent);
    this.renderHistory(parent);
    this.renderStartCard(parent);
  }

  /** Shows a resume prompt if there is a persisted in-progress batch. */
  private renderPendingBatchBanner(parent: HTMLElement) {
    const pb = this.plugin.pendingBatch;
    if (!pb || pb.filePaths.length === 0 || pb.index >= pb.filePaths.length) return;

    const banner = parent.createDiv("feynman-card feynman-resume-banner");
    banner.createDiv({
      cls: "feynman-resume-text",
      text: `📚 上次批量复习中断在第 ${pb.index + 1} / ${pb.filePaths.length} 个，要继续吗？`,
    });
    const row = this.btnRow(banner);
    this.btn(row, "继续复习 →", "primary", () => {
      // Rebuild DueConcept from stored file paths; skip missing/deleted files
      const queue: DueConcept[] = pb.filePaths.flatMap(path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return [];
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!fm) return [];
        return [{ file, concept: fm["概念"] || file.basename, reviewCount: fm.review_count ?? 0, reviewDate: fm.review_date ?? "", mastery: fm["掌握程度"] ?? "初识" }];
      });
      if (queue.length === 0) {
        void this.plugin.clearPendingBatch();
        this.render();
        return;
      }
      this.batchQueue = queue;
      this.batchIndex = Math.min(pb.index, queue.length - 1);
      this.batchMode = true;
      this.render();
    });
    this.btn(row, "放弃此次批量", "secondary", async () => {
      await this.plugin.clearPendingBatch();
      this.render();
    });
  }

  private renderOnboarding(parent: HTMLElement) {
    const card = parent.createDiv("feynman-card feynman-onboarding");

    card.createDiv({ cls: "feynman-onboarding-icon", text: "🧠" });
    card.createDiv({ cls: "feynman-onboarding-title", text: "欢迎使用费曼学习法！" });
    card.createEl("p", { cls: "feynman-onboarding-desc", text: "用「教会别人」的方式深度学习任何概念，AI 帮你找漏洞、做复习。" });

    card.createEl("p", { cls: "feynman-settings-desc", text: "开始之前，先完成一次性配置：" });
    const steps = card.createEl("ol", { cls: "feynman-onboarding-steps" });
    [
      "打开 设置 → 社区插件 → 费曼学习法",
      "填写 API key（推荐 DeepSeek，性价比高；也支持 OpenAI / 本地 Ollama 等）",
      "点击「测试连接」确认配置正确",
      "回到这里，输入第一个你想学习的概念！",
    ].forEach(text => steps.createEl("li", { text }));

    const btnRow = this.btnRow(card);
    this.btn(btnRow, "⚙️ 打开设置", "primary", () => {
      // Access the internal settings manager (undocumented private API, may not exist on mobile)
      const appSetting = (this.app as unknown as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
      if (appSetting?.open) {
        appSetting.open();
        appSetting.openTabById?.("feynman-learning");
      } else {
        // Mobile Obsidian: private API unavailable — guide the user manually
        new Notice("请前往 设置 → 社区插件 → 费曼学习法 完成配置");
      }
    });

    card.createEl("p", { cls: "feynman-onboarding-hint", text: "配置完成后，刷新此面板（点击左侧 🧠 图标）即可开始学习。" });
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
    const reportBtn = this.btn(reportRow, "📊 生成本周报告", "secondary",
      () => this.withAiBtn(reportBtn, "生成中…", () => this.generateWeeklyReport()));
  }

  private renderHeatmap(parent: HTMLElement) {
    const wrap = parent.createDiv("feynman-heatmap-wrap");
    wrap.createDiv({ cls: "feynman-mastery-label", text: "近 14 天学习记录" });
    const grid = wrap.createDiv("feynman-heatmap");
    const dates = this.plugin.learningDates;
    for (let i = 13; i >= 0; i--) {
      const d = moment().subtract(i, "days").format("YYYY-MM-DD");
      const active = dates.includes(d);
      grid.createDiv({
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
    const allDue = this.plugin.getDueConcepts();
    if (allDue.length === 0) return;

    // ── Sort ──────────────────────────────────────────────────────────────────
    const intervals = this.plugin.settings.reviewIntervals;
    const today = moment().format("YYYY-MM-DD");
    const MASTERY_ORDER: Record<string, number> = { "初识": 0, "理解": 1, "掌握": 2, "精通": 3 };
    const due = [...allDue].sort((a, b) => {
      if (this.reviewSort === "name")    return a.concept.localeCompare(b.concept, "zh");
      if (this.reviewSort === "mastery") return (MASTERY_ORDER[a.mastery] ?? 0) - (MASTERY_ORDER[b.mastery] ?? 0);
      // "due": most overdue first
      return a.reviewDate.localeCompare(b.reviewDate);
    });

    const card = parent.createDiv("feynman-card feynman-review-card");

    // ── Header row ────────────────────────────────────────────────────────────
    const headerRow = card.createDiv("feynman-review-header");
    this.badge(headerRow, `📅 待复习 · ${due.length} 个`);

    const controls = headerRow.createDiv("feynman-review-controls");
    // Sort tabs
    const sortWrap = controls.createDiv("feynman-sort-tabs");
    const sortOptions: { key: "due" | "mastery" | "name"; label: string }[] = [
      { key: "due", label: "按到期" },
      { key: "mastery", label: "按掌握" },
      { key: "name", label: "按名称" },
    ];
    for (const opt of sortOptions) {
      const tab = sortWrap.createDiv({
        cls: `feynman-sort-tab ${this.reviewSort === opt.key ? "active" : ""}`,
        text: opt.label,
      });
      tab.addEventListener("click", () => { this.reviewSort = opt.key; this.render(); });
    }
    // Batch button (only show when ≥2 items)
    if (due.length >= 2) {
      this.btn(controls, "🚀 批量复习", "primary", () => {
        this.batchQueue = [...due];   // freeze the current sorted list
        this.batchMode = true; this.batchIndex = 0;
        void this.plugin.savePendingBatch(due.map(d => d.file.path), 0);
        this.render();
      });
    }

    card.createEl("h2", { text: "这些概念到了复习时间" });
    const list = card.createDiv("feynman-review-list");

    // Consume pending review file (auto-open from command)
    const pendingPath = this.plugin.pendingReviewFilePath;
    this.plugin.pendingReviewFilePath = null;

    for (const item of due) {
      const itemWrap = list.createDiv("feynman-review-item-wrap");
      const row = itemWrap.createDiv("feynman-review-item");
      const info = row.createDiv("feynman-review-info");

      // Overdue badge
      const overdueDays = moment(today).diff(moment(item.reviewDate), "days");
      const nameEl = info.createDiv({ cls: "feynman-review-name-row" });
      nameEl.createSpan({ cls: "feynman-review-name", text: item.concept });
      if (overdueDays > 0) {
        nameEl.createSpan({ cls: "feynman-overdue-badge", text: `逾期 ${overdueDays} 天` });
      }

      const hasMore = (intervals[item.reviewCount] ?? null) !== null;
      const rStats = this.plugin.getConceptReviewStats(item.concept);
      const histText = rStats.total > 0 ? `通过率 ${rStats.rate}` : "首次复习";
      info.createSpan({
        cls: "feynman-review-sub",
        text: hasMore
          ? `${item.mastery} · 第 ${item.reviewCount + 1} 次 · ${histText}`
          : "已完成所有复习阶段",
      });

      const btns = row.createDiv("feynman-review-btns");
      this.btn(btns, "打开笔记", "secondary", () => this.app.workspace.getLeaf("tab").openFile(item.file));

      if (hasMore) {
        const startBtn = this.btn(btns, "开始复习 →", "primary", async () => {
          await this.renderReviewSession(itemWrap, item);
        });
        // Auto-open if triggered by "复习当前笔记" command
        if (pendingPath && item.file.path === pendingPath) {
          activeWindow.setTimeout(() => startBtn.click(), 150);
        }
      }
    }
  }

  // ── Batch review ─────────────────────────────────────────────────────────────

  private renderBatchReview(parent: HTMLElement) {
    const due = this.batchQueue;   // frozen at batch-start, never shrinks mid-session
    if (this.batchIndex >= due.length) {
      // Summary screen
      const card = parent.createDiv("feynman-card");
      card.createEl("h2", { text: "🎉 批量复习完成！" });
      card.createDiv({ cls: "feynman-hint", text: `共完成 ${due.length} 个概念的复习` });
      void this.plugin.clearPendingBatch();   // all done — remove persisted progress
      this.btn(this.btnRow(card), "返回首页", "primary", () => {
        this.batchMode = false; this.batchIndex = 0; this.batchQueue = []; this.render();
      });
      return;
    }

    const item = due[this.batchIndex];
    const total = due.length;

    const card = parent.createDiv("feynman-card feynman-batch-wrap");

    // Progress header
    const progressHeader = card.createDiv("feynman-batch-header");
    progressHeader.createSpan({ cls: "feynman-batch-progress-label", text: `${this.batchIndex + 1} / ${total}` });
    const barWrap = progressHeader.createDiv("feynman-progress-bar feynman-batch-bar");
    const pct = Math.round(this.batchIndex / total * 100);
    barWrap.createDiv({ cls: "feynman-progress-fill", attr: { style: `width:${pct}%` } });
    this.btn(progressHeader, "退出", "secondary", async () => {
      await this.plugin.clearPendingBatch();
      this.batchMode = false; this.batchIndex = 0; this.batchQueue = []; this.render();
    });

    // Skip button
    const skipRow = card.createDiv("feynman-batch-skip-row");
    this.btn(skipRow, "跳过 →", "secondary", () => {
      this.batchIndex++;
      void this.plugin.savePendingBatch(this.batchQueue.map(d => d.file.path), this.batchIndex);
      this.render();
    });

    // Render review session inline; onComplete advances to next item
    void this.renderReviewSession(card, item, async () => {
      this.batchIndex++;
      await this.plugin.savePendingBatch(this.batchQueue.map(d => d.file.path), this.batchIndex);
      this.render();
    });
  }

  private async renderReviewSession(wrap: HTMLElement, item: DueConcept, onComplete?: () => void | Promise<void>) {
    const done = onComplete ?? (() => this.render());
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
    } catch (e) { console.error("费曼插件：读取笔记上下文失败", e); }

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

    const resultEl = session.createDiv("feynman-review-result feynman-hidden");

    let lastDimensions: { label: string; score: string; note: string }[] = [];
    let lastEvalText = "";
    let partialPass = false;

    const row = this.btnRow(session);
    this.btn(row, "取消", "secondary", () => { session.remove(); });

    const judgeBtn = this.btn(row, "AI 评判 →", "primary", () => {
      const exp = expTA.value.trim();
      if (!exp) { new Notice("请先写出你的解释"); return; }
      resultEl.addClass("feynman-hidden");
      void this.withAiBtn(judgeBtn, "AI 评判中…", async () => {
        const gapsContext = previousGaps ? `\n\n上次学习时记录的知识漏洞：\n${previousGaps}` : "";
        const verdict = await this.plugin.callAI([
          {
            role: "system",
            content: `你是一个严格但友善的学习评估老师。学生正在复习「${item.concept}」这个概念。
从三个维度评判后，只返回如下 JSON，不要输出任何其他内容：
{"passed":true,"dimensions":[{"label":"语言简洁","score":"✓","note":""},{"label":"核心机制","score":"✓","note":""},{"label":"举例说明","score":"✓","note":""}],"feedback":""}
其中 score 只能是 "✓"、"△" 或 "✗"；passed 为 true 当且仅当没有任何维度是 "✗"；note 和 feedback 各一句话。`,
          },
          { role: "user", content: `学生对「${item.concept}」的重新解释：\n${exp}${gapsContext}` },
        ]);

        // Parse the AI response into a structured verdict
        const SCORE_CLS: Record<string, string> = { "✓": "dim-pass", "△": "dim-partial", "✗": "dim-fail" };
        const { passed, dimensions, feedback: evalText } = parseReviewVerdict(verdict);

        resultEl.removeClass("feynman-hidden");
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
          const intervals = this.plugin.settings.reviewIntervals;
          const actualNextDays = calcNextInterval(item.reviewCount, true, partialPass, allPerfect, intervals);

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
            void done();
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
            void done();
          });
          this.btn(actionRow, "🎯 专项练习", "secondary", async () => {
            await this.renderWeakPointDrill(resultEl, item.concept, lastDimensions);
          });
          this.btn(actionRow, "再解释一次", "secondary", () => {
            expTA.value = "";
            resultEl.addClass("feynman-hidden");
            judgeBtn.disabled = false;
            judgeBtn.textContent = "AI 评判 →";
            expTA.focus();
          });
        }
      }, { keepDisabledOnSuccess: true });
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
      row.addEventListener("click", () => { void this.app.workspace.getLeaf("tab").openFile(c.file); });
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

      // Check for duplicate concept
      const existing = this.plugin.getAllConcepts().find(c => c.concept === name);
      if (existing) {
        card.querySelector(".feynman-dup-warn")?.remove();
        const warn = card.createDiv("feynman-dup-warn");
        warn.createDiv({ cls: "feynman-hint", text: `已有「${name}」的学习笔记（当前掌握：${existing.mastery}）` });
        const warnRow = this.btnRow(warn);
        this.btn(warnRow, "打开原笔记", "secondary", () => {
          void this.app.workspace.getLeaf("tab").openFile(existing.file);
          warn.remove();
        });
        const isDue = this.plugin.getDueConcepts().find(d => d.file.path === existing.file.path);
        if (isDue) {
          this.btn(warnRow, "去复习它 →", "primary", () => {
            warn.remove();
            // Scroll the dashboard back to the due-review list
            this.render();
            activeWindow.setTimeout(() => {
              const el = this.containerEl.querySelector(".feynman-review-card");
              el?.scrollIntoView({ behavior: "smooth" });
            }, 100);
          });
        }
        this.btn(warnRow, "仍然新建", "warn", () => {
          warn.remove();
          this.state.concept = name;
          this.state.why = whyInp.value.trim();
          this.state.step = 1;
          this.render();
        });
        return;
      }

      this.state.concept = name;
      this.state.why = whyInp.value.trim();
      this.state.step = 1;
      this.render();
    });

    // Text extraction section
    const extractToggle = card.createDiv("feynman-extract-toggle");
    extractToggle.createSpan({ cls: "feynman-extract-toggle-label", text: "📄 从原文提取概念" });
    let extractOpen = false;
    const extractBody = card.createDiv("feynman-extract-body feynman-hidden");
    extractToggle.addEventListener("click", () => {
      extractOpen = !extractOpen;
      extractBody.toggleClass("feynman-hidden", !extractOpen);
      extractToggle.toggleClass("open", extractOpen);
    });

    const textTA = this.ta(extractBody, "粘贴文章、课堂笔记、书摘……");
    const extractRow = this.btnRow(extractBody);
    const extractBtn = this.btn(extractRow, "AI 提取概念", "primary", () => {
      const text = textTA.value.trim();
      if (!text) { new Notice("请先粘贴原文"); return; }
      void this.withAiBtn(extractBtn, "提取中…", async () => {
        const result = await this.plugin.callAI([
          { role: "system", content: "从给定文本中提取3-8个值得用费曼学习法深入理解的核心概念，按建议学习顺序排列。只返回 JSON 数组，不要输出任何其他内容：[{\"name\":\"概念名\",\"reason\":\"一句话说明为什么值得学\"},...]" },
          { role: "user", content: text.slice(0, 3000) },
        ], 500);

        const concepts = parseExtractedConcepts(result);

        extractBody.querySelector(".feynman-extract-results")?.remove();
        if (concepts.length === 0) { new Notice("未能提取到概念，请换一段文本"); return; }

        const results = extractBody.createDiv("feynman-extract-results");
        const headerRow = results.createDiv("feynman-extract-header");
        headerRow.createDiv({ cls: "feynman-ai-label", text: `提取到 ${concepts.length} 个概念` });
        const addAllBtn = headerRow.createEl("button", { cls: "feynman-btn feynman-btn-secondary feynman-extract-add-all", text: "全部加入队列" });
        addAllBtn.addEventListener("click", () => {
          void (async () => {
            for (const c of concepts) await this.plugin.addToQueue(c.name);
            addAllBtn.textContent = `✓ 已加入 ${concepts.length} 个`;
            addAllBtn.disabled = true;
            new Notice(`已将 ${concepts.length} 个概念加入学习队列`);
          })();
        });
        for (const c of concepts) {
          const chip = results.createDiv({ cls: "feynman-extract-chip" });
          const info = chip.createDiv({ cls: "feynman-extract-chip-info" });
          info.createSpan({ cls: "feynman-extract-name", text: c.name });
          if (c.reason) info.createSpan({ cls: "feynman-extract-reason", text: c.reason });
          info.addEventListener("click", () => { nameInp.value = c.name; nameInp.scrollIntoView({ behavior: "smooth" }); });
          const addBtn = chip.createEl("button", { cls: "feynman-btn feynman-extract-add", text: "＋" });
          addBtn.title = "加入学习队列";
          addBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            void (async () => {
              await this.plugin.addToQueue(c.name);
              addBtn.textContent = "✓";
              addBtn.disabled = true;
            })();
          });
        }
      });
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
    });
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
        row.addEventListener("click", () => { void this.app.workspace.getLeaf("tab").openFile(c.file); });
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
    if (!this.plugin.settings.apiKey) { new Notice("请先在插件设置中填写 API key"); return; }
    this.state.aiHistory = [
      { role: "system", content: "你是一个对所有领域都一无所知的普通人，正在听别人解释一个概念。基于对方的解释，找出最让你困惑的地方，提出1-2个追问。用口语化语气，真的从不懂的角度提问，不评价，用中文。" },
      { role: "user", content: `我在解释的概念是：${this.state.concept}\n\n我的解释是：\n${this.state.explanation}` },
    ];
    try {
      const reply = await this.plugin.callAI(this.state.aiHistory);
      this.state.aiHistory.push({ role: "assistant", content: reply });
      this.renderAIChat(parent);
    } catch (e) { new Notice("AI 请求失败：" + (e instanceof Error ? e.message : String(e))); }
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
    const followupBtn = row.createEl("button", { cls: "feynman-btn feynman-btn-secondary", text: "继续追问" });
    followupBtn.addEventListener("click", () => {
      const reply = replyTA.value.trim();
      if (!reply) { new Notice("请先回答 AI 的问题"); return; }
      this.state.aiHistory.push({ role: "user", content: reply });
      void this.withAiBtn(followupBtn, "追问中…", async () => {
        msgEl.textContent = "思考中…";
        try {
          const aiReply = await this.plugin.callAI(this.state.aiHistory);
          this.state.aiHistory.push({ role: "assistant", content: aiReply });
          msgEl.textContent = aiReply;
          replyTA.value = "";
        } catch (e) {
          msgEl.textContent = lastAI.content; // restore AI message on error
          throw e;                             // re-throw so withAiBtn logs + shows Notice
        }
      });
    });

    const summaryBtn = this.btn(row, "AI 总结我的漏洞", "warn", () => {
      void this.withAiBtn(summaryBtn, "分析中…", async () => {
        const gaps = await this.plugin.callAI([
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
      });
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
      const result = await this.plugin.callAI([
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
    } catch (e) {
      verifyCard.createDiv({ cls: "feynman-hint", text: "AI 验证失败：" + (e instanceof Error ? e.message : String(e)) });
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
      void navigator.clipboard.writeText(this.buildNoteContent(moment().format("YYYY-MM-DD")));
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
    if (!this.plugin.settings.apiKey) { new Notice("请先在插件设置中填写 API key"); return; }
    const btn = parent.querySelector(".feynman-btn-warn") as HTMLButtonElement;
    if (btn) { btn.disabled = true; btn.textContent = "出题中…"; }
    try {
      const result = await this.plugin.callAI([
        { role: "system", content: "你是一个出题老师，只输出题目，不做任何其他解释。每道题独立一行，格式：1. 题目内容" },
        { role: "user", content: `根据以下关于「${this.state.concept}」的笔记，出3道理解型测验题（考察理解而非死记硬背）：\n${this.state.finalExplanation}\n${this.state.analogy}` },
      ]);
      this.state.quizQuestions = result.split("\n").filter(l => l.trim().match(/^\d+\./)).map(l => l.replace(/^\d+\.\s*/, "").trim()).slice(0, 3);
      if (this.state.quizQuestions.length === 0) this.state.quizQuestions = result.split("\n").filter(l => l.trim()).slice(0, 3);
      this.state.quizAnswers = new Array(this.state.quizQuestions.length).fill("");
      this.state.quizFeedback = "";
      this.state.step = 5;
      this.render();
    } catch (e) {
      new Notice("AI 请求失败：" + (e instanceof Error ? e.message : String(e)));
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
    const evalBtn = this.btn(row, "提交，让 AI 评价", "primary", () => {
      const answers = answerEls.map(el => el.value.trim());
      if (answers.some(a => !a)) { new Notice("请回答所有问题"); return; }
      this.state.quizAnswers = answers;
      void this.withAiBtn(evalBtn, "AI 评价中…", async () => {
        const feedback = await this.plugin.callAI([
          { role: "system", content: "你是一个耐心的老师，给出建设性评价，鼓励为主。用中文。" },
          { role: "user", content: `学生学习的概念是「${this.state.concept}」。请逐题评价（对✓/部分正确△/需改进✗）并给一句话反馈，最后给总体建议。\n\n${this.state.quizQuestions.map((q, i) => `题目${i + 1}：${q}\n学生回答：${this.state.quizAnswers[i]}`).join("\n\n")}` },
        ]);
        this.state.quizFeedback = feedback;
        this.render(); // detaches evalBtn from DOM; finally restoring it is harmless
      });
    });
    if (this.state.quizFeedback) {
      this.btn(row, "💾 保存并结束", "primary", () => { this.showSavePreview(card, parent); });
    }
  }

  // ─── AI & Save helpers ────────────────────────────────────────────────────

  private buildNoteContent(date: string): string {
    const reviewDate = moment(date).add(this.plugin.settings.reviewIntervals[0] ?? REVIEW_INTERVALS[0], "days").format("YYYY-MM-DD");
    const aiLog = this.state.aiHistory.filter(m => m.role !== "system")
      .map(m => `**${m.role === "user" ? "我" : "AI"}：** ${m.content}`).join("\n\n");
    const quizSection = this.state.quizQuestions.length > 0
      ? `\n## AI 测验\n\n${this.state.quizQuestions.map((q, i) => `**题目 ${i + 1}：** ${q}\n\n**我的回答：** ${this.state.quizAnswers[i] || "（未回答）"}`).join("\n\n")}\n\n**AI 评价：**\n\n${this.state.quizFeedback || "（未评价）"}\n`
      : "";

    return `---
tags:
  - 费曼学习法
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
    const isNew = !(existing instanceof TFile);
    if (isNew) { await vault.create(filename, content); } else { await vault.modify(existing, content); }
    this.state.savedStem = stem;

    if (isNew) {
      await this.updateIndex(stem, date);
      await this.plugin.recordLearningDate();
    }

    // Notion sync
    if (this.plugin.settings.notionToken && this.plugin.settings.notionDatabaseId) {
      try { await this.syncToNotion(); new Notice(`「${this.state.concept}」已保存并同步到 Notion ✓`); }
      catch (e) { new Notice(`笔记已保存，Notion 同步失败：${e instanceof Error ? e.message : String(e)}`); }
    } else {
      new Notice(`「${this.state.concept}」已保存，明天提醒复习 ✓`);
    }

    // Open note
    const file = vault.getAbstractFileByPath(filename);
    if (file instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(file);

    // Fetch AI recommendations in background
    if (this.plugin.settings.apiKey) {
      void this.fetchRecommendations(parent);
    }
  }

  private async fetchRecommendations(parent?: HTMLElement) {
    try {
      const all = this.plugin.getAllConcepts().map(c => c.concept);
      const existing = all.length > 0 ? `（已学过：${all.slice(0, 10).join("、")}，不要重复推荐）` : "";
      const result = await this.plugin.callAI([
        { role: "system", content: "你是一个学习顾问，推荐接下来值得学习的相关概念。只输出概念名称，每个名称一行，共3个，不要编号或解释。" },
        { role: "user", content: `刚学完「${this.state.concept}」${this.state.why ? `，学习动机是：${this.state.why}` : ""}。推荐3个接下来值得学习的相关概念。${existing}` },
      ], 200);
      this.state.recommendations = result.split("\n").map(l => l.trim()).filter(l => l && !l.match(/^\d+\./)).slice(0, 3);
      if (parent) this.renderRecommendations(parent);
    } catch (e) {
      console.error("费曼插件：获取学习推荐失败（非关键功能）", e);
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
    const {
      notionToken, notionDatabaseId,
      notionPropTitle, notionPropMastery, notionPropStatus, notionPropSubject,
    } = this.plugin.settings;

    // Core properties — use user-configured field names so different database schemas work
    const properties: Record<string, unknown> = {
      [notionPropTitle]:   { title: [{ text: { content: this.state.concept } }] },
      [notionPropMastery]: { select: { name: "初识" } },
      [notionPropStatus]:  { select: { name: "进行中" } },
      [notionPropSubject]: { select: { name: "其他" } },
    };

    // Optional rich-text fields — use default names; silently omit any that
    // don't exist in the user's database (Notion returns 400 for unknown props,
    // but we only discover this after the fact, so we add them speculatively
    // and let the caller's try/catch surface the error with a clear message).
    properties["第一步_概念描述"] = { rich_text: [{ text: { content: truncate(this.state.why || this.state.concept) } }] };
    properties["第二步_简单解释"] = { rich_text: [{ text: { content: truncate(this.state.explanation) } }] };
    properties["第三步_知识漏洞"] = { rich_text: [{ text: { content: truncate(this.state.gaps || "（未填写）") } }] };
    properties["第四步_类比简化"] = { rich_text: [{ text: { content: truncate((this.state.finalExplanation + "\n\n" + (this.state.analogy || "")).trim()) } }] };

    const resp = await requestUrl({
      url: "https://api.notion.com/v1/pages",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + notionToken,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({ parent: { database_id: notionDatabaseId }, properties }),
      throw: false,
    });
    if (resp.status >= 400) {
      const err = (resp.json ?? {}) as Record<string, unknown>;
      const errMsg = typeof err.message === "string" ? err.message : `Notion 返回 ${resp.status}：请检查数据库字段名是否与插件设置一致`;
      throw new Error(errMsg);
    }
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
    } catch (e) { console.error("费曼插件：保存失败复习记录到笔记失败", e); }
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
      const result = await this.plugin.callAI([
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
      const submitBtn = this.btn(btnRow, "提交答案，获取反馈", "primary", () => {
        const answers = answerEls.map(el => el.value.trim());
        if (answers.some(a => !a)) { new Notice("请回答所有练习题"); return; }
        void this.withAiBtn(submitBtn, "AI 评价中…", async () => {
          const feedback = await this.plugin.callAI([
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
          // Set success state before returning — keepDisabledOnSuccess skips finally restore
          submitBtn.textContent = "再练一次";
          submitBtn.disabled = false;
          submitBtn.onclick = () => {
            answerEls.forEach(el => { el.value = ""; });
            drillCard.querySelector(".feynman-drill-feedback")?.remove();
          };
        }, { keepDisabledOnSuccess: true });
      });
    } catch (e) {
      loadingEl.textContent = "AI 请求失败：" + (e instanceof Error ? e.message : String(e));
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
        aiReflection = await this.plugin.callAI([
          { role: "system", content: "你是一个温暖的学习教练。根据用户本周的学习数据，写一段简短的学习反思（100字以内），肯定进步，给出下周一个具体的学习建议。用中文，语气轻松友好。" },
          { role: "user", content: statsText },
        ], 300);
      } catch (e) {
        console.error("费曼插件：周报 AI 反思生成失败", e);
        aiReflection = "";
      }
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
    if (existing instanceof TFile) { await vault.modify(existing, content); } else { await vault.create(filename, content); }
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
      const result = await this.plugin.callAI([
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
        if (match) nameEl.addEventListener("click", () => { void this.app.workspace.getLeaf("tab").openFile(match.file); });
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

    } catch (e) {
      card.empty();
      card.createDiv({ cls: "feynman-hint", text: "AI 请求失败：" + (e instanceof Error ? e.message : String(e)) });
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
    new Setting(containerEl).setName("费曼学习法 设置").setHeading();

    new Setting(containerEl).setName("AI 设置").setHeading();
    new Setting(containerEl).setName("Key").setDesc("兼容 OpenAI 格式的密钥")
      .addText(t => t.setPlaceholder("").setValue(this.plugin.settings.apiKey)
        .then(t => { t.inputEl.type = "password"; })
        .onChange(v => { this.plugin.settings.apiKey = v; void this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Endpoint").setDesc("兼容 OpenAI 格式的接口地址")
      .addText(t => t.setPlaceholder("").setValue(this.plugin.settings.apiBase)
        .onChange(v => { this.plugin.settings.apiBase = v.trim(); void this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("模型名称").setDesc("例如 GPT-4o")
      .addText(t => t.setPlaceholder("").setValue(this.plugin.settings.model)
        .onChange(v => { this.plugin.settings.model = v.trim(); void this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Temperature").setDesc("生成随机性，0 最保守，1 最发散（默认 0.8）")
      .addSlider(s => s.setLimits(0, 1, 0.1).setValue(this.plugin.settings.temperature).setDynamicTooltip()
        .onChange(v => { this.plugin.settings.temperature = v; void this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("测试连接").setDesc("用当前设置发送一次测试请求，确认 key、地址、模型均正确")
      .addButton(b => b.setButtonText("测试连接").onClick(async () => {
        const { apiKey, model } = this.plugin.settings;
        if (!apiKey) { new Notice("请先填写 API key"); return; }
        b.setButtonText("测试中…").setDisabled(true);
        try {
          const data = await this.plugin.requestAI([{ role: "user", content: "Hi" }], 1);
          new Notice(`✓ 连接成功（模型：${typeof data.model === "string" ? data.model : model}）`);
        } catch (e) {
          new Notice(`✗ ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          b.setButtonText("测试连接").setDisabled(false);
        }
      }));

    new Setting(containerEl).setName("复习设置").setHeading();
    containerEl.createEl("p", { cls: "feynman-settings-desc", text: "三个间隔（天）：保存后多久首次复习、首次通过后多久再复习、再次通过后多久最终复习。失败时固定 1 天后重试。" });
    const ivs = this.plugin.settings.reviewIntervals;
    const ivLabels = ["保存 → 首次复习（天）", "首次通过 → 二次复习（天）", "二次通过 → 三次复习（天）"];
    for (let i = 0; i < 3; i++) {
      new Setting(containerEl).setName(ivLabels[i])
        .addText(t => t
          .setValue(String(ivs[i] ?? [1, 7, 30][i]))
          .onChange(v => {
            const n = parseInt(v);
            if (!Number.isNaN(n) && n >= 1) {
              this.plugin.settings.reviewIntervals[i] = n;
              void this.plugin.saveSettings();
            }
          }));
    }

    new Setting(containerEl).setName("笔记设置").setHeading();
    new Setting(containerEl).setName("笔记保存目录").setDesc("相对于 vault 根目录的路径")
      .addText(t => t.setPlaceholder("01.读书笔记/费曼笔记").setValue(this.plugin.settings.notesFolder)
        .onChange(v => {
          this.plugin.settings.notesFolder = v;
          void this.plugin.saveSettings().then(() => { this.display(); });
        }));

    // Folder status + one-click create
    const folderPath = this.plugin.settings.notesFolder;
    const folderExists = !!this.app.vault.getAbstractFileByPath(folderPath);
    const folderStatusSetting = new Setting(containerEl)
      .setName("文件夹状态")
      .setDesc(folderExists ? "✓ 文件夹已存在" : "✗ 文件夹不存在，点击右侧按钮创建");
    if (!folderExists) {
      folderStatusSetting.addButton(b => b.setButtonText("一键创建").setCta().onClick(async () => {
        try {
          await this.app.vault.createFolder(folderPath);
          new Notice(`文件夹「${folderPath}」已创建 ✓`);
          this.display();
        } catch (e) { new Notice(`创建失败：${e instanceof Error ? e.message : String(e)}`); }
      }));
    }

    new Setting(containerEl).setName("概念索引文件").setDesc("费曼学习索引文件的路径（可选）")
      .addText(t => t.setPlaceholder("01.读书笔记/费曼学习索引.md").setValue(this.plugin.settings.indexFile)
        .onChange(v => { this.plugin.settings.indexFile = v; void this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Notion 同步").setHeading();
    containerEl.createEl("p", { cls: "feynman-settings-desc", text: "填写后保存笔记时自动同步到 Notion，留空则不同步。" });
    new Setting(containerEl).setName("Notion integration token").setDesc("在 Notion.so/my-integrations 创建集成后获取")
      .addText(t => t.setPlaceholder("").setValue(this.plugin.settings.notionToken)
        .then(t => { t.inputEl.type = "password"; })
        .onChange(v => { this.plugin.settings.notionToken = v; void this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Notion 数据库 ID").setDesc("填写后可同步到你的 Notion 数据库")
      .addText(t => t.setPlaceholder("数据库 ID").setValue(this.plugin.settings.notionDatabaseId)
        .onChange(v => { this.plugin.settings.notionDatabaseId = v; void this.plugin.saveSettings(); }));

    containerEl.createEl("p", { cls: "feynman-settings-desc", text: "Notion 字段名映射 — 若你的数据库列名与默认值不同，请在此修改（否则同步会 400 报错）。" });
    const notionProps: Array<[keyof FeynmanSettings, string, string]> = [
      ["notionPropTitle",   "标题字段名（概念名称）", "概念名称"],
      ["notionPropMastery", "掌握程度字段名",         "掌握程度"],
      ["notionPropStatus",  "状态字段名",             "状态"],
      ["notionPropSubject", "学科领域字段名",         "学科领域"],
    ];
    for (const [key, label, placeholder] of notionProps) {
      new Setting(containerEl).setName(label)
        .addText(t => t.setPlaceholder(placeholder).setValue(String(this.plugin.settings[key] ?? placeholder))
          .onChange(v => {
            Object.assign(this.plugin.settings, { [key]: v.trim() || placeholder });
            void this.plugin.saveSettings();
          }));
    }

    // ── Settings export / import ──────────────────────────────────────────────
    new Setting(containerEl).setName("数据管理").setHeading();
    containerEl.createEl("p", { cls: "feynman-settings-desc", text: "导出设置到剪贴板，或从剪贴板导入（可用于换设备、备份、排障）。API key 和 Notion token 包含在导出数据中，请妥善保管。" });

    new Setting(containerEl).setName("导出设置").setDesc("将当前所有设置复制为 JSON 到剪贴板")
      .addButton(b => b.setButtonText("📋 导出到剪贴板").onClick(async () => {
        const json = JSON.stringify(this.plugin.settings, null, 2);
        await navigator.clipboard.writeText(json);
        new Notice("设置已复制到剪贴板 ✓");
      }));

    new Setting(containerEl).setName("导入设置").setDesc("从剪贴板读取 JSON 并合并到当前设置（未包含的字段保持不变）")
      .addButton(b => b.setButtonText("📥 从剪贴板导入").onClick(async () => {
        try {
          const text = await navigator.clipboard.readText();
          const parsed = JSON.parse(text) as unknown;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("格式不正确");
          const parsedObj = parsed as Record<string, unknown>;
          // Merge: only overwrite keys that exist in DEFAULT_SETTINGS to avoid injecting unknown fields
          const safe = Object.fromEntries(
            Object.keys(DEFAULT_SETTINGS).filter(k => k in parsedObj).map(k => [k, parsedObj[k]])
          );
          Object.assign(this.plugin.settings, safe);
          await this.plugin.saveSettings();
          this.display();
          new Notice(`已导入 ${Object.keys(safe).length} 个设置项 ✓`);
        } catch (e) {
          new Notice("导入失败：" + (e instanceof Error ? e.message : "剪贴板内容不是有效的设置 JSON"));
        }
      }));
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class FeynmanPlugin extends Plugin {
  settings: FeynmanSettings;
  learningDates: string[] = [];
  reviewHistory: ReviewRecord[] = [];
  learningQueue: string[] = [];
  pendingReviewFilePath: string | null = null;
  /** Persisted batch progress: file paths + how far we got. Null = no in-progress batch. */
  pendingBatch: { filePaths: string[]; index: number } | null = null;
  private _conceptsCache: ConceptMeta[] | null = null;

  async onload() {
    await this.loadSettings();
    const data = await this.loadData();
    this.learningDates = data?.learningDates ?? [];
    this.reviewHistory = data?.reviewHistory ?? [];
    this.learningQueue = data?.learningQueue ?? [];
    this.pendingBatch   = data?.pendingBatch   ?? null;

    this.registerView(VIEW_TYPE, leaf => new FeynmanView(leaf, this));
    this.addRibbonIcon("brain", "费曼学习法", () => this.activateView());

    this.addCommand({ id: "open-feynman-view", name: "打开费曼学习面板", callback: () => this.activateView() });
    this.addCommand({
      id: "feynman-review-current-note",
      name: "复习当前费曼笔记",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file?.path.startsWith(this.settings.notesFolder + "/")) return false;
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const today = moment().format("YYYY-MM-DD");
        const isDue = fm?.review_date && fm.review_date !== "completed" && fm.review_date <= today;
        if (!isDue) return false;
        if (!checking) {
          this.pendingReviewFilePath = file.path;
          void this.activateView();
        }
        return true;
      },
    });
    this.addCommand({
      id: "feynman-quick-capture", name: "用费曼法学习选中文字",
      editorCallback: (editor: Editor) => {
        const selected = editor.getSelection().trim();
        if (!selected) { new Notice("请先选中一段文字"); return; }
        void this.activateView().then(() => {
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
          if (leaves.length > 0) (leaves[0].view as FeynmanView).loadConcept(selected);
        });
      },
    });

    this.addSettingTab(new FeynmanSettingTab(this.app, this));

    // Invalidate getAllConcepts() cache when vault files or their frontmatter change
    const invalidate = () => { this._conceptsCache = null; };
    this.registerEvent(this.app.vault.on("create", invalidate));
    this.registerEvent(this.app.vault.on("delete", invalidate));
    this.registerEvent(this.app.vault.on("rename", invalidate));
    this.registerEvent(this.app.metadataCache.on("changed", invalidate));

    this.app.workspace.onLayoutReady(() => this.notifyDueReviews());
  }

  async activateView() {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      void workspace.revealLeaf(leaves[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    void workspace.revealLeaf(leaf);
  }

  async requestAI(messages: { role: string; content: string }[], maxTokens = 800): Promise<Record<string, unknown>> {
    const { apiKey, apiBase, model, temperature } = this.settings;
    const base = apiBase.replace(/\/$/, "");
    const resp = await requestUrl({
      url: `${base}/chat/completions`,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      throw: false,
    });
    const body = (resp.json ?? {}) as Record<string, unknown>;
    if (resp.status >= 400) throw new Error(parseApiError(resp.status, body));
    return body;
  }

  async callAI(messages: { role: string; content: string }[], maxTokens = 800): Promise<string> {
    const data = await this.requestAI(messages, maxTokens);
    const choices = data.choices as { message?: { content?: string } }[] | undefined;
    return choices?.[0]?.message?.content ?? "";
  }
  // ─── Data ────────────────────────────────────────────────────────────────

  getAllConcepts(): ConceptMeta[] {
    if (this._conceptsCache) return this._conceptsCache;
    const folder = this.settings.notesFolder;
    this._conceptsCache = this.app.vault.getMarkdownFiles()
      .filter(f => f.path.startsWith(folder + "/"))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .flatMap(file => {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!fm) return [];
        return [{ concept: fm.概念 || file.basename, date: fm.日期 || "", mastery: fm.掌握程度 || "初识", subject: fm.学科 || "", file }];
      });
    return this._conceptsCache;
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
        return [{
          file,
          concept: fm.概念 || file.basename,
          reviewCount: fm.review_count ?? 0,
          reviewDate: fm.review_date as string,
          mastery: fm.掌握程度 || "初识",
        }];
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
    const nextInterval = calcNextInterval(currentCount, passed, partialPass, expertPass, this.settings.reviewIntervals);
    const nextDate = nextInterval === null
      ? "completed"
      : moment().add(nextInterval, "days").format("YYYY-MM-DD");
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

  async savePendingBatch(filePaths: string[], index: number) {
    this.pendingBatch = { filePaths, index };
    await this.saveData({ ...(await this.loadData()), pendingBatch: this.pendingBatch });
  }

  async clearPendingBatch() {
    this.pendingBatch = null;
    await this.saveData({ ...(await this.loadData()), pendingBatch: null });
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData({ ...(await this.loadData()), ...this.settings }); }
  private notifyDueReviews() {
    const due = this.getDueConcepts();
    if (due.length > 0) new Notice(`📅 有 ${due.length} 个费曼概念待复习`, 8000);
  }
}
