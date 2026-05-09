import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts"],
    plugins: { obsidianmd, "@typescript-eslint": tseslint },
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      "obsidianmd/ui/sentence-case": ["error", { "brands": ["iOS","iPadOS","macOS","Windows","Android","Linux","Obsidian","Obsidian Sync","Obsidian Publish","Google","Gemini","Vertex AI","OpenAI","GPT","Anthropic","Claude","Microsoft","Google Drive","Dropbox","OneDrive","iCloud Drive","YouTube","Slack","Discord","Telegram","WhatsApp","Twitter","X","Readwise","Zotero","Excalidraw","Mermaid","Markdown","LaTeX","JavaScript","TypeScript","Node.js","npm","pnpm","Yarn","Git","GitHub","GitLab","Notion","Evernote","Roam Research","Logseq","Anki","Reddit","VS Code","Visual Studio Code","IntelliJ IDEA","WebStorm","PyCharm","React","Svelte","CalDAV","CardDAV","WebDAV","Feynman","Feynman Learning","Ollama"] }],
      "obsidianmd/ui/sentence-case-json": ["error", { "brands": ["iOS","iPadOS","macOS","Windows","Android","Linux","Obsidian","Obsidian Sync","Obsidian Publish","Google","Gemini","Vertex AI","OpenAI","GPT","Anthropic","Claude","Microsoft","Google Drive","Dropbox","OneDrive","iCloud Drive","YouTube","Slack","Discord","Telegram","WhatsApp","Twitter","X","Readwise","Zotero","Excalidraw","Mermaid","Markdown","LaTeX","JavaScript","TypeScript","Node.js","npm","pnpm","Yarn","Git","GitHub","GitLab","Notion","Evernote","Roam Research","Logseq","Anki","Reddit","VS Code","Visual Studio Code","IntelliJ IDEA","WebStorm","PyCharm","React","Svelte","CalDAV","CardDAV","WebDAV","Feynman","Feynman Learning","Ollama"] }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { "checksVoidReturn": true }],
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "no-unused-expressions": "error",
    },
  },
  {
    files: ["manifest.json"],
    plugins: { obsidianmd },
    rules: {
      "obsidianmd/ui/sentence-case-json": "error",
    },
  },
];
