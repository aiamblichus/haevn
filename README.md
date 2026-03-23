# HAEVN

<div align="center">

![HAEVN Logo](./assets/banner.png)

A Chrome extension for exporting and preserving conversations from various AI platforms including Gemini, ChatGPT, and Poe.

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=google-chrome&logoColor=white)](https://chrome.google.com/webstore)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Own your AI conversation history. Search across platforms. Export for backup. Never lose context.**

</div>

---

## Overview

HAEVN is a Chrome Manifest V3 extension that syncs AI conversations from multiple LLM platforms into a unified local archive. It preserves the full context of your interactions—including branching conversations, multi-modal content, and metadata—using a canonical `HAEVN.Chat` format.

### Why HAEVN?

- **🔒 Privacy First**: All data stored locally in your browser (IndexedDB + OPFS). No cloud, no servers, no tracking.
- **🌐 Multi-Platform**: Works with 10+ AI platforms from a single interface.
- **🔍 Full-Text Search**: Find any conversation instantly with Lunr.js-powered search.
- **📦 Export Anywhere**: Export to JSON, Markdown, or plain text. Create backups, migrate, or analyze your conversations.
- **🌳 Branch Support**: Preserves conversation trees, not just linear chats.
- **🖼️ Media Handling**: Images, documents, code execution results—all preserved.

---

## Supported Platforms

| Platform                                 | Single Sync | Bulk Sync | Method      |
| ---------------------------------------- | ----------- | --------- | ----------- |
| [Claude](https://claude.ai)              | ✅          | ✅        | API         |
| [ChatGPT](https://chatgpt.com)           | ✅          | ✅        | API         |
| [Gemini](https://gemini.google.com)      | ✅          | ✅        | DOM         |
| [Poe](https://poe.com)                   | ✅          | ✅        | API         |
| [DeepSeek](https://chat.deepseek.com)    | ✅          | ✅        | API         |
| [Qwen](https://chat.qwen.ai)             | ✅          | ✅        | API         |
| [AI Studio](https://aistudio.google.com) | ✅          | ✅        | DOM         |
| [Grok](https://grok.com)                 | ✅          | ✅        | API         |
| [Open WebUI](http://localhost:8080)      | ✅          | ✅        | API         |
| Claude Code                              | ❌          | ❌        | Import only |

---

## Features

### 🔄 Sync

- **Single Chat Sync**: Click the extension icon on any supported AI platform to save the current conversation
- **Bulk Sync**: Sync your entire conversation history from any platform with progress tracking and resume capability
- **Smart Detection**: Automatically detects which platform you're on and uses the appropriate extractor

### 🔍 Search

- **Full-Text Search**: Search across all your conversations instantly
- **Message-Level Results**: See exactly which messages match your query with context snippets
- **Streaming Results**: Results appear as they're found, no waiting for complete searches

### 📦 Export

- **Multiple Formats**: Export to JSON, Markdown, or plain text
- **Bulk Export**: Select multiple chats and export as a single ZIP file
- **Preserve Structure**: Branching conversations and media references maintained

### 📥 Import

- **HAEVN Archives**: Import previously exported HAEVN ZIP files
- **Platform Backups**: Import from ChatGPT, Claude, and other platform exports
- **Duplicate Detection**: Smart handling of existing conversations

### 🗂️ Archive Management

- **Soft Delete**: Delete chats with undo capability (7-day retention)
- **Provider Stats**: See conversation counts per platform
- **Storage Overview**: Track your archive size and media usage

---

## Installation

### From Release (Recommended for Users)

1. **Download the latest release**
   - Go to [Releases](https://github.com/aiamblichus/haevn/releases/latest)
   - Download `haevn-extension-vX.Y.Z.zip`

2. **Unzip the file**

   ```bash
   unzip haevn-extension-vX.Y.Z.zip -d haevn-extension
   ```

3. **Load in Chrome**
   - Open `chrome://extensions/`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked"
   - Select the extracted folder

### From Source (Development)

1. **Clone the repository**

   ```bash
   git clone https://github.com/aiamblichus/haevn.git
   cd haevn
   ```

2. **Install dependencies**

   ```bash
   pnpm install
   ```

3. **Build the extension**

   ```bash
   pnpm run build
   ```

4. **Load in Chrome**
   - Open `chrome://extensions/`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked"
   - Select the `dist/` folder

### Development Workflow

```bash
# Build after code changes
pnpm run build

# Reload extension (via debug proxy, if configured)
curl -X POST http://localhost:5556/command -d '{"action": "reload"}'

# Run tests
pnpm test

# Lint code
pnpm run lint
pnpm run lint:fix  # Auto-fix issues
```

---

## Usage

### Quick Start

1. **Navigate to a supported AI platform** (e.g., chatgpt.com, claude.ai)
2. **Click the HAEVN extension icon** in your toolbar
3. **Click "Sync Current Chat"** to save the conversation
4. **Open the Archive** (Options page) to view, search, and manage your saved chats

### Bulk Sync

1. Open the HAEVN Options page (right-click extension icon → Options)
2. Navigate to the "Providers" tab
3. Click "Bulk Sync" next to any platform
4. Watch the progress as your entire history is synced
5. If interrupted, you'll be prompted to resume

### Search

1. Open the Archive (Options page)
2. Use the search bar at the top
3. Results stream in real-time as you type
4. Click any result to open the full conversation in the viewer

### Export

1. In the Archive, select chats using checkboxes
2. Click "Export Selected"
3. Choose format (JSON, Markdown, TXT)
4. Download begins automatically as a ZIP file

### HAEVN CLI

HAEVN also includes a terminal CLI for fast retrieval and scripting.

```bash
# Help
haevn --help

# List chats with message + branch counts
haevn list -p chatgpt -l 10 --sort messageCount

# Search with configurable snippet context
haevn search "consciousness emergence poetry" -l 8 -c 180

# Inspect branch structure (short refs shown by default)
haevn branches <chatId>

# Fetch a specific branch by short ref
haevn get <chatId> -m <messageRef>
```

CLI highlights:
- **Short message refs** (12-char hash) for readable message addressing.
- **Branch-aware listing** (`msgs`, `br`, and branched chat indicator).
- **Context control** in search (`--context`).
- **Safer payloads** for `get` by default (media omitted unless explicitly requested).

See [CLI README](./cli/README.md) for full setup and command reference.

---

## Architecture

HAEVN uses a sophisticated three-tier architecture to work within Chrome MV3 constraints:

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Service       │     │   Offscreen      │     │   Web Workers   │
│   Worker        │────▶│   Document       │────▶│   (6 workers)   │
│   (Background)  │     │   (Worker Host)  │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

### Key Components

| Component          | Location                                    | Purpose                                     |
| ------------------ | ------------------------------------------- | ------------------------------------------- |
| **Message Router** | `src/background/handlers/`                  | Type-safe message dispatch (82 handlers)    |
| **Provider Layer** | `src/providers/`                            | Platform-specific extraction/transformation |
| **Persistence**    | `src/services/`                             | IndexedDB (Dexie) + OPFS for media          |
| **Worker Pool**    | `src/offscreen/`                            | Search, stats, export, import workers       |
| **UI Layer**       | `src/options/`, `src/viewer/`, `src/popup/` | React SPAs for user interaction             |

### Data Flow

```
Raw Platform Data
       ↓
   Extractor (fetch)
       ↓
   Transformer (normalize)
       ↓
   HAEVN.Chat (canonical format)
       ↓
   Persistence → Indexing → Export
```

### Canonical Format

All conversations are normalized to the `HAEVN.Chat` format, which supports:

- **Tree structure**: Branching conversations with parent/child relationships
- **Multi-modal content**: Text, images, audio, video, documents
- **Rich metadata**: Timestamps, model info, token usage, sync status
- **Extensibility**: Vendor-specific details preserved

See `src/model/haevn_model.ts` for the complete type definitions.

---

## Tech Stack

| Category        | Technology                        |
| --------------- | --------------------------------- |
| **Language**    | TypeScript 5.9 (strict mode)      |
| **Build**       | esbuild (30s full rebuild)        |
| **Runtime**     | Chrome Extension MV3              |
| **Frontend**    | React 18, Tailwind CSS, shadcn/ui |
| **Persistence** | Dexie (IndexedDB), OPFS (media)   |
| **State**       | Zustand, event-driven messaging   |
| **Search**      | Lunr.js (Web Worker)              |
| **Testing**     | Vitest, fake-indexeddb            |
| **Linting**     | Biome 2.3                         |

---

## Project Structure

```
haevn/
├── src/
│   ├── background/       # Service worker, handlers, orchestration
│   ├── providers/        # Platform-specific extractors/transformers
│   ├── services/         # Persistence, search, caching
│   ├── offscreen/        # Worker host and message routing
│   ├── options/          # Archive UI (React SPA)
│   ├── viewer/           # Chat viewer (React SPA)
│   ├── popup/            # Extension popup
│   ├── content/          # Content script (injected into platforms)
│   ├── model/            # HAEVN.Chat type definitions
│   └── utils/            # Shared utilities
├── tests/                # Unit and integration tests
├── charter/              # Architecture documentation
├── dist/                 # Built extension (load in Chrome)
└── assets/               # Static assets
```

---

## Debugging

### Debug Portal

Open the Options page and use the browser console to access `haevnDebug`:

```javascript
// View recent logs
haevnDebug.getLogs(100, { match: "Sync" });

// Enable debug logging
haevnDebug.setLogLevel(0);

// Search the archive
haevnDebug.search("your query");

// Get a specific chat
haevnDebug.getChat("chat-id");

// Rebuild search index
haevnDebug.rebuildIndex();

// Check OPFS storage
haevnDebug.opfs.usage();
```

### Logs Page

Navigate to `chrome-extension://<EXTENSION_ID>/logs.html` for structured background logs.

---

## Contributing

Contributions are welcome! Here's how to get started:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes following the code style (Biome enforces this)
4. Run tests (`pnpm test`) and lint (`pnpm run lint`)
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

### Adding a New Platform

1. Create `src/providers/{platform}/` with:
   - `extractor.ts` - Implements `Extractor<TRaw>`
   - `transformer.ts` - Implements `Transformer<TRaw>`
   - `model.ts` - Platform-specific types
   - `provider.ts` - Provider registration
2. Register in `src/background/init.ts`
3. Add host permissions in `manifest.json`
4. Add platform icon in `src/icons/`

---

## Releases & Versioning

HAEVN uses [Semantic Versioning](https://semver.org/) with automated releases via GitHub Actions.

### Download Releases

Download the latest release from [GitHub Releases](https://github.com/aiamblichus/haevn/releases/latest):

- **`haevn-extension-vX.Y.Z.zip`** - Ready-to-load extension package

### Creating Releases

For maintainers, creating a new release is simple:

```bash
# Quick release (bump version, commit, tag, push)
pnpm run release:patch  # Bug fixes (1.0.0 → 1.0.1)
pnpm run release:minor  # New features (1.0.0 → 1.1.0)
pnpm run release:major  # Breaking changes (1.0.0 → 2.0.0)
```

See [docs/RELEASE.md](docs/RELEASE.md) for detailed release documentation.

---

## Roadmap

- [ ] Firefox support (MV3 compatibility)
- [ ] Cloud sync (optional, end-to-end encrypted)
- [ ] AI-powered search and summarization
- [ ] Conversation analytics dashboard
- [ ] More platform support (Perplexity, etc.)

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## Acknowledgments

- Built with [shadcn/ui](https://ui.shadcn.com/) components
- Search powered by [Lunr.js](https://lunrjs.com/)
- Icons from respective platform brands

---

<div align="center">

**Made with ❤️ for the AI community**

[Report Bug](https://github.com/aiamblichus/haevn/issues) · [Request Feature](https://github.com/aiamblichus/haevn/issues)

</div>
