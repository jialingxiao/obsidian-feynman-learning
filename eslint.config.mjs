import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

const BRANDS = ["iOS","iPadOS","macOS","Windows","Android","Linux","Obsidian","Obsidian Sync","Obsidian Publish","Google","Gemini","Vertex AI","OpenAI","GPT","Anthropic","Claude","Microsoft","Google Drive","Dropbox","OneDrive","iCloud Drive","YouTube","Slack","Discord","Telegram","WhatsApp","Twitter","X","Readwise","Zotero","Excalidraw","Mermaid","Markdown","LaTeX","JavaScript","TypeScript","Node.js","npm","pnpm","Yarn","Git","GitHub","GitLab","Notion","Evernote","Roam Research","Logseq","Anki","Reddit","VS Code","Visual Studio Code","IntelliJ IDEA","WebStorm","PyCharm","React","Svelte","CalDAV","CardDAV","WebDAV","Feynman","Feynman Learning","Ollama","DeepSeek"];

export default [
  {
    files: ["src/**/*.ts"],
    plugins: { obsidianmd, "@typescript-eslint": tseslint },
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      // ── obsidianmd rules (from recommended config) ──────────────────────────
      "obsidianmd/ui/sentence-case": ["error", { "brands": BRANDS, "enforceCamelCaseLower": true }],
      "obsidianmd/ui/sentence-case-json": ["error", { "brands": BRANDS, "enforceCamelCaseLower": true }],
      "obsidianmd/commands/no-command-in-command-id": "error",
      "obsidianmd/commands/no-command-in-command-name": "error",
      "obsidianmd/commands/no-default-hotkeys": "error",
      "obsidianmd/commands/no-plugin-id-in-command-id": "error",
      "obsidianmd/commands/no-plugin-name-in-command-name": "error",
      "obsidianmd/settings-tab/no-manual-html-headings": "error",
      "obsidianmd/settings-tab/no-problematic-settings-headings": "error",
      "obsidianmd/vault/iterate": "error",
      "obsidianmd/detach-leaves": "error",
      "obsidianmd/editor-drop-paste": "error",
      "obsidianmd/hardcoded-config-path": "error",
      "obsidianmd/no-forbidden-elements": "error",
      "obsidianmd/no-plugin-as-component": "error",
      "obsidianmd/no-sample-code": "error",
      "obsidianmd/no-tfile-tfolder-cast": "error",
      "obsidianmd/no-view-references-in-plugin": "error",
      "obsidianmd/no-static-styles-assignment": "error",
      "obsidianmd/object-assign": "error",
      "obsidianmd/platform": "error",
      "obsidianmd/prefer-abstract-input-suggest": "error",
      "obsidianmd/prefer-active-doc": "error",
      "obsidianmd/prefer-create-el": "error",
      "obsidianmd/prefer-file-manager-trash-file": "error",
      "obsidianmd/prefer-instanceof": "error",
      "obsidianmd/prefer-active-window-timers": "error",
      "obsidianmd/prefer-get-language": "error",
      "obsidianmd/regex-lookbehind": "error",
      "obsidianmd/sample-names": "error",
      "obsidianmd/validate-manifest": "error",
      "obsidianmd/validate-license": "error",
      "obsidianmd/rule-custom-message": "error",
      "obsidianmd/no-unsupported-api": "error",
      "obsidianmd/no-nodejs-modules": "error",
      // ── @typescript-eslint rules ─────────────────────────────────────────────
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { "checksVoidReturn": true }],
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/restrict-template-expressions": "error",
      // ── core rules ───────────────────────────────────────────────────────────
      "no-unused-expressions": "error",
    },
  },
  {
    files: ["manifest.json"],
    plugins: { obsidianmd },
    rules: {
      "obsidianmd/ui/sentence-case-json": ["error", { "brands": BRANDS, "enforceCamelCaseLower": true }],
    },
  },
];
