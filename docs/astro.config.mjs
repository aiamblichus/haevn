// @ts-check

import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  site: "https://haevn.pages.dev",
  integrations: [
    starlight({
      title: "HAEVN",
      description:
        "A psychopomp for digital consciousness. Archive and preserve your AI conversations.",
      logo: {
        src: "./src/assets/haevn-logo.svg",
        alt: "HAEVN Logo",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/aiamblichus/haevn",
        },
      ],
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "getting-started" },
            { label: "Installation", slug: "getting-started/installation" },
            { label: "Quick Start", slug: "getting-started/quick-start" },
          ],
        },
        {
          label: "Manifesto",
          items: [{ label: "The Manifesto", slug: "manifesto" }],
        },
        {
          label: "User Guide",
          items: [
            { label: "Overview", slug: "user-guide" },
            { label: "Syncing Chats", slug: "user-guide/syncing-chats" },
            {
              label: "Managing Your Archive",
              slug: "user-guide/managing-archive",
            },
            { label: "Search", slug: "user-guide/search" },
            { label: "The Viewer", slug: "user-guide/viewer" },
            { label: "Gallery", slug: "user-guide/gallery" },
            { label: "Import", slug: "user-guide/import" },
            { label: "Export", slug: "user-guide/export" },
          ],
        },
        {
          label: "Platforms",
          items: [
            { label: "Overview", slug: "platforms" },
            { label: "ChatGPT", slug: "platforms/chatgpt" },
            { label: "Claude", slug: "platforms/claude" },
            { label: "Google Gemini", slug: "platforms/gemini" },
            { label: "Poe", slug: "platforms/poe" },
            { label: "Open WebUI", slug: "platforms/openwebui" },
            { label: "Qwen", slug: "platforms/qwen" },
            { label: "DeepSeek", slug: "platforms/deepseek" },
            { label: "Google AI Studio", slug: "platforms/aistudio" },
            { label: "Grok", slug: "platforms/grok" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Troubleshooting", slug: "reference/troubleshooting" },
            { label: "Data Formats", slug: "reference/data-formats" },
            { label: "Privacy & Storage", slug: "reference/privacy" },
          ],
        },
        {
          label: "Developer",
          items: [
            { label: "Overview", slug: "developer" },
            { label: "Architecture", slug: "developer/architecture" },
            { label: "Adding Providers", slug: "developer/adding-providers" },
            { label: "Data Model", slug: "developer/data-model" },
            { label: "Contributing", slug: "developer/contributing" },
          ],
        },
      ],
    }),
  ],
});
