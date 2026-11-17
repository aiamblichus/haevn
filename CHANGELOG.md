# Changelog

## [Unreleased]

### Added

- **Starmap**: an interactive 3D constellation of your chats in the archive, laid out from embeddings of their metadata (UMAP + clustering in a worker), with runtime controls, an embedding queue that can be paused, and rebuild controls.
- **Exporters**: single chats export as HAEVN JSON, HAEVN Markdown or Pi session JSONL (with thinking signatures); the CLI's exports go through the same exporters.
- **Search**: `id:` scoped queries in the archive.
- **Archive and viewer**: `g` opens a chat by id; the viewer header uses the metadata title; viewer widgets collapse; hover previews show the full metadata description.
- **CLI**: `haevn list --include-metadata` (`-m`) shows each chat's description, synopsis, categories or keywords; `haevn search` shows metadata (`--no-metadata` to hide it); formatted output includes the system prompt.

### Changed

- The Markdown export of a branched chat writes the current branch (from the first message to the chat's current message) instead of every branch interleaved by time; `haevn export --all-branches` adds the others as `## Branch N` sections (a reading format, not importable).
- The extension no longer loads fonts from Google: they ship with the extension.
- The docs, README and settings say exactly what leaves your machine: the AI platforms you sync from, and an AI metadata or embeddings endpoint only if you turn it on and set one.
- Imports report chats that failed as errors instead of counting them as skipped.
- A search during an index rebuild says the index is rebuilding instead of showing no results; the CLI's `haevn search` fails with `INDEX_REBUILDING` and asks you to retry.

### Fixed

- `haevn import` takes the operation lock (it fails with "Another operation is running" during a bulk sync or an import), indexes small imports as it saves them so search keeps answering, seeds metadata from HAEVN exports, and exits 1 with `index=failed` if indexing could not run; `haevn info` metadata edits queue the same embedding update as the archive.
- A failed search-index rebuild is no longer silent: search says the index is incomplete, and reloading the extension rebuilds it; a rebuild can no longer be corrupted by a pending index write or a second rebuild request.
- The CLI bridge stops reconnecting when another extension takes over the daemon connection, and retries slowly after a rejected key.
- Exports release the file only after Chrome has finished downloading it.
- ChatGPT and Open WebUI imports from the archive page now reach search (the bulk-indexing step failed silently).
- Deleted chats no longer appear in search or on the starmap.
- Hard delete removes a chat's embeddings and queue rows.
- The CLI daemon no longer fails your request when an unrelated connection closes.
- Claude Code tool results export with their tool name; Qwen token counts are saved under the right field; a chat in a HAEVN ZIP without an id gets one.
- Poe keeps inline images when attachments are missing; attachment types are inferred better for thumbnails; multi-word search behaves as documented; the Grok logo shows on the dark UI.

## [v1.2.1] - 2026-03-27

### Added

- Archive search result actions now include a direct "Edit metadata" shortcut.
- Metadata modal now shows failed queue item diagnostics with a "Reset and retry" action.

### Changed

- Metadata generation prompts are now budgeted and trimmed to avoid oversized LLM requests.
- Metadata failure events/status now include retry counters and terminal failure state.

### Fixed

- Metadata queue failures now become terminal after max retries instead of retrying forever.
- Terminal metadata failures are preserved across startup resets until explicitly reset.

## [v1.2.0] - 2026-03-26

### Added

- AI-powered chat metadata generation and management
- Descriptive metadata categories and category-aware archive filtering
- Metadata queue controls, including a rebuild-all action
- Chat hover preview popover in Options/archive views
- CLI `info` command with chat metadata management
- CLI bridge toggle and support for importing media formats
- Automated CLI npm publishing/release workflow support
- YAML frontmatter transcript output for markdown exports

### Changed

- Improved metadata conversation sampling and titles in search results
- Refined metadata queue controls and archive hover preview behavior
- Improved CLI `get` output with system prompt labeling and `--skip-system`
- Added staged lint/build git hooks to tighten pre-commit quality gates

### Fixed

- Metadata queue alarm synchronization in background scheduling
- Metadata modal category handling in settings/options flows
- Documentation fixes for search/import guidance and MDX rendering issues

## [v1.1.0] - 2026-03-23

### Added

#### CLI Integration (Major Feature)
- **WebSocket-based CLI daemon** - Query your HAEVN archive from the terminal
  - New `haevn` CLI tool with search, list, get, branches, export, and import commands
  - WebSocket daemon architecture for reliable extension communication
  - Configurable port and API key authentication
  - CLI settings UI in Options page (port configuration + API key management)
  - Self-managed daemon process independent of service worker lifecycle

#### Import Capabilities
- **CLI import command** - Ingest local conversation files into HAEVN archive
  - Support for Claude Code session transcripts (`--format claude_code`)
  - Support for PI format transcripts
  - Support for Codex format (stubbed, encrypted reasoning skipped)
  - Multiple file import with overwrite control
  - Optional index skip for bulk imports
- **Import-only providers** - New provider type for non-sync platforms
  - Claude Code provider card
  - PI provider card
  - Codex provider card

#### Search Enhancements
- **Relaxed matching** - More forgiving search with fuzzy term matching
- **Configurable snippet context** - Adjustable context window around search matches
- **Model information in results** - Shows AI model names in list and search output

#### CLI Output Improvements
- **Branch-aware metrics** - List shows branch counts and conversation complexity
- **Short message refs** - Compact message identifiers in branches/search/get output
- **Head/tail flags** - `--head N` and `--tail N` flags for get command to paginate long conversations
- **Model display** - Shows first model name alongside platform in list output
- **Include-thinking flag** - `--include-thinking` for get command with markdown thinking blocks

### Changed

#### Database Schema (Breaking Change)
- **Messages table extraction** - Migrated chat messages from monolithic storage to dedicated table
  - Eliminates service worker crashes when loading large chats (10-50 MB)
  - Two-phase lazy migration with background batch processor
  - New repository API: `getChat()` (metadata only), `getChatWithMessages()`, `getPrimaryBranchMessages()`, `getBranchMessages()`, `getChatMessagePage()`
  - Legacy fallback during migration period
  - **Note**: First startup after upgrade will trigger background migration

### Fixed

#### Bulk Sync
- **Concurrent tick race condition** - Fixed interleaved progress updates and duplicate processing
- **Stuck SYNCING indicator** - Indicator now reliably clears after cancel or completion

#### ChatGPT Platform
- **Stale authentication tokens** - Added 45-minute TTL with automatic refresh on 401 errors
- **Lost content script context** - Recovery logic re-establishes content script after SPA navigation
- **Message channel closed errors** - Automatic retry with content script re-injection

#### CLI
- **Service worker crash on large lists** - Streaming scan replaces memory-heavy toArray() for non-indexed sorts
- **List ID truncation** - Full chat IDs now displayed (was truncated to 14 chars)
- **Platform column width** - Widened to 10 chars to prevent clipping (e.g., 'openwebui')
- **Empty message rendering** - Filtered out tool calls and image-only uploads that showed as empty stubs
- **WebSocket reconnection** - Graduated retry schedule (2s/10s/20s) covering full alarm cycle
- **Header crash** - Fixed "Invalid count value" when chat ID + title exceeded 54 characters

#### Infrastructure
- **pnpm consistency** - Migrated all npm references to pnpm across GitHub Actions and scripts
- **Documentation build** - Fixed MDX syntax errors blocking documentation site builds
- **Git ignore** - Corrected gitignore patterns

### Technical

#### Architecture
- Replaced Chrome Native Messaging with WebSocket daemon (fixes lifecycle inversion)
- Added `wsBridge.ts` for outbound WebSocket client with alarm-based reconnect
- Removed `nativeMessaging.ts` and 'nativeMessaging' permission
- New message actions: `getCliSettings`, `setCliPort`, `regenerateCliApiKey`

#### Dependencies
- Added `ws` and `@types/ws` for WebSocket support
- New CLI package structure with daemon server, HTTP client, and config management

#### Documentation
- CLI user guide and developer documentation
- Import format documentation
- Track 05 spec for messages table extraction

All notable changes to HAEVN will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-01-XX

### Added
- Initial public release of HAEVN Chat Exporter
- Support for 10 LLM platforms: Claude, ChatGPT, Gemini, Poe, Qwen, DeepSeek, AI Studio, Grok, Open WebUI, and Claude Code (import)
- Unified local archive with canonical HAEVN.Chat format
- Full-text search across all conversations using Lunr.js
- Bulk sync from all supported platforms
- Export to multiple formats (JSON, Markdown, HTML)
- Import from various sources
- OPFS-based media storage for images and attachments
- Real-time sync status and progress tracking
- Advanced search with filters and sorting
- Conversation tree visualization for branched chats
- Gallery view for media attachments
- Statistics and analytics dashboard
- Automated cleanup with soft-delete and janitor service
- Debug portal for troubleshooting

### Technical
- Manifest V3 Chrome Extension
- TypeScript 5.9.3 with strict mode
- React 18.3 with Tailwind CSS and shadcn/ui
- Dexie for IndexedDB persistence
- Three-tier worker architecture (Service Worker → Offscreen → Web Workers)
- Event-driven UI updates
- Plugin architecture for platform providers

---

## Release Process

This project uses automated releases via GitHub Actions. To create a new release:

1. **Update version manually** in `package.json` and `src/manifest.json`
2. **Commit changes**: `git commit -am "chore: bump version to x.y.z"`
3. **Create and push tag**: 
   ```bash
   git tag -a vx.y.z -m "Release version x.y.z"
   git push origin vx.y.z
   ```
4. **GitHub Actions will**:
   - Run tests
   - Build the extension
   - Create a ZIP artifact
   - Generate changelog from commits
   - Create GitHub Release with attached ZIP
   - Update CHANGELOG.md

Or use the manual workflow dispatch from GitHub Actions UI.

---

For older releases and detailed commit history, see [GitHub Releases](https://github.com/YOUR_USERNAME/haevn/releases).
