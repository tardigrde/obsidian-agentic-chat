import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Agentic Chat",
  description: "Privacy-first agent-led AI chat for Obsidian.",
  base: "/obsidian-agentic-chat/",
  lastUpdated: true,
  head: [
    ["meta", { name: "theme-color", content: "#46648f" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Agentic Chat for Obsidian" }],
    ["meta", { property: "og:description", content: "Agent-led AI chat that can read, search, and edit your Obsidian vault through visible tool calls." }],
  ],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/install" },
      { text: "Features", link: "/features/" },
      { text: "Reference", link: "/reference/vault-tools" },
      { text: "Development", link: "/development/" },
    ],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Overview", link: "/" },
          { text: "Install", link: "/guide/install" },
          { text: "Setup", link: "/guide/setup" },
          { text: "Daily usage", link: "/guide/usage" },
          { text: "Privacy model", link: "/guide/privacy" },
        ],
      },
      {
        text: "Features",
        items: [
          { text: "Feature map", link: "/features/" },
          { text: "Context and control", link: "/features/context-and-control" },
          { text: "Web, MCP, and observability", link: "/features/web-mcp-observability" },
          { text: "Project workspaces", link: "/features/projects" },
          { text: "Memory", link: "/features/memory" },
          { text: "Semantic retrieval", link: "/features/semantic-retrieval" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Vault tools", link: "/reference/vault-tools" },
          { text: "Slash commands", link: "/reference/slash-commands" },
          { text: "Settings", link: "/reference/settings" },
          { text: "Publishing docs", link: "/reference/publishing-docs" },
        ],
      },
      {
        text: "Development",
        items: [
          { text: "Development guide", link: "/development/" },
          { text: "Testing", link: "/development/testing" },
          { text: "Live dogfood harness", link: "/development/live-dogfood" },
        ],
      },
    ],
    search: {
      provider: "local",
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/tardigrde/obsidian-agentic-chat" },
    ],
    editLink: {
      pattern: "https://github.com/tardigrde/obsidian-agentic-chat/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 tardigrde",
    },
  },
});
