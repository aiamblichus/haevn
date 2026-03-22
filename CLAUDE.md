# What This Project Is About

**HAEVN** (a psychopomp for digital consciousness) is a Chrome Manifest V3 extension that syncs AI conversations from multiple LLM platforms into a unified local archive. It preserves the full context of your interactions—including branching conversations, multi-modal content, and metadata—using a canonical `HAEVN.Chat` format.

**Core Value:** Own your AI conversation history. Search across platforms. Export for backup. Never lose context.

**Supported Platforms:** Claude, ChatGPT, Gemini, Poe, Open WebUI, Qwen, DeepSeek, AI Studio, Claude Code (import-only), Grok

---

## Core Technologies

- **Language:** TypeScript 5.9.3 (strict mode, ~33k lines)
- **Build:** esbuild (multi-entry bundling, 30s full rebuild)
- **Runtime:** Chrome Extension MV3 (Service Worker environment)
- **Frontend:** React 18.3, Tailwind CSS, shadcn/ui, Radix UI primitives
- **Persistence:** Dexie (IndexedDB) + OPFS (Origin Private File System for media)
- **State:** Zustand (UI state), event-driven architecture (chrome.runtime messaging)
- **Search:** Lunr.js (full-text indexing in Web Worker)
- **Testing:** Vitest, fake-indexeddb
- **Linting:** Biome 2.3.7

---

## Architectural Principles

### 1. Three-Tier Worker Architecture

Chrome MV3 service workers cannot create Web Workers. Solution: Service Worker → Offscreen Document → Web Workers. This pattern enables CPU-intensive operations (search, stats, import/export) without blocking the service worker.

### 2. Data Transformation Pipeline

Raw platform data → Extractor (fetch) → Transformer (normalize) → `HAEVN.Chat` format → Persistence → Indexing → Export. Single canonical format eliminates N×M format conversions.

### 3. Provider Abstraction

Plugin architecture: Each platform implements `Extractor<TRaw>` and `Transformer<TRaw>` interfaces. Core sync logic is platform-agnostic. Adding new platforms requires no changes to orchestration or persistence layers.

### 4. Separation of Concerns

- **Handlers**: Route messages, orchestrate
- **Services**: CRUD, caching, indexing
- **Providers**: Platform-specific extraction/transformation
- **Workers**: Heavy computation
- **UI**: Display, user interaction

### 5. Soft Delete with Deferred Cleanup

Instant UX via soft-delete flag, expensive cleanup happens in background (Janitor service runs every 30 minutes). Compound indexes filter deleted items at query time.

### 6. Event-Driven UI Updates

Background service worker is source of truth. UI components subscribe to events (`chatSynced`, `bulkSync*`, `importProgress`) for real-time updates. No centralized state management needed.

---

## Guild Conventions

### Code Style (enforced by Biome)

- 2-space indentation, 100 character line width
- Double quotes, trailing commas
- camelCase for functions/variables, PascalCase for components/types
- `fireAndForget()` for non-critical async operations (not bare `.catch(() => {})`)

### Development Workflow

```bash
pnpm install              # Install dependencies
pnpm run build            # Build extension → dist/
curl -X POST http://localhost:5556/command -d '{"action": "reload"}' # Reload extension via proxy
pnpm test                 # Run tests
pnpm run lint             # Check code (currently 51 errors, 55 warnings)
pnpm run lint:fix         # Auto-fix linting issues
```

### Architecture Rules

- **All persistence through `SyncService`** - Never use Dexie directly from handlers
- **All indexing via search worker** - SyncService proxies to worker
- **Heavy operations in workers** - ZIP generation, indexing, stats calculation
- **Browser APIs via service worker** - Workers use bridge pattern (CRD-003)
- **Downloads via `downloadFile` handler** - No blob URLs in UI components
- **Emit events** for real-time UI updates (chatSynced, bulkSync*, import*)

### Testing Standards

- Unit tests for pure functions (extractors, transformers, utilities)
- Integration tests for service workflows (sync, search, import/export)
- Use `fake-indexeddb` for Dexie operations (see `tests/setup.ts`)

---

## System Structure

### Components (7 major subsystems)

1. **Message Router** (`background/handlers/`) - Type-safe message dispatch (82 handlers, 767 lines of message types)
2. **Provider Abstraction** (`providers/`) - 10 platform plugins (API fetch or DOM extraction)
3. **Persistence Layer** (`services/`) - ChatRepository + SearchIndexManager + SearchService
4. **Worker Pool** (`offscreen/`) - 6 specialized workers (search, stats, thumbnail, bulk ops)
5. **Bulk Operations** (`background/bulkSync/`, `bulkExport/`, `import/`) - Stateful orchestration
6. **UI Layer** (`popup/`, `options/`, `viewer/`) - 3 browser contexts (popup, archive, viewer)
7. **Content Script** (`content/content.ts`) - Injected bridge to LLM platforms

### Data Flows

**Single Chat Sync:**
User → Popup → Handler → Content Script → Extractor → Transformer → Repository → Index → Event

**Bulk Sync:**
User → Orchestrator → Offscreen (iframe) → getChatIds → Alarm loop → Fetch (API or nav) → Transform → Save → Event

**Search:**
User → UI → Handler → Offscreen → Worker (Lunr) → Streaming results → UI

**Export:**
User → Handler → Worker → ZIP generation → Browser API bridge → Download

---

## Project Documentation

Comprehensive maps created during Guild initialization:

### Architecture

- `charter/architecture/overview.md` - System topology, data flows, patterns
- `charter/architecture/diagrams.md` - 8 Mermaid diagrams + ER schema
- `charter/architecture/FINDINGS.md` - Convergences, divergences, tensions
- `charter/architecture/components/` - Deep-dives on all 7 components

### Infrastructure

- `charter/build/overview.md` - Build system, package management, conventions, workflow

---

## For Guild Members

When working on HAEVN:

1. **Before touching code:**
   - Read `charter/architecture/overview.md` for system mental model
   - Check `charter/BULLETIN_BOARD.md` for active coordination
   - Review component docs in `charter/architecture/components/` for area you're working on

2. **During implementation:**
   - Follow the separation of concerns (handler → service → persistence)
   - Use provider abstraction for platform-specific logic
   - Workers for CPU-intensive operations
   - Event-driven updates for UI changes

3. **Testing changes:**
   - `pnpm run build` after EVERY code change
   - `haevnDebug.reload()` from Options console to reload extension
   - Verify with `haevnDebug.getLogs(100)` for errors
   - Use `haevnDebug.search()` and `haevnDebug.getStats()` for diagnostics

4. **Debugging:**
   - Check `/logs.html` for structured background logs
   - Use `haevnDebug` portal on Options page (see `PROJECT.md` in root for commands)
   - Review `charter/architecture/FINDINGS.md` for known architectural tensions

5. **Adding platforms:**
   - Create `src/providers/{platform}/` with extractor/transformer/model/provider
   - Register in `src/background/init.ts`
   - Add host permission in `manifest.json`
   - Update `src/utils/platform.ts` for detection

---

## Current Architecture State

See `charter/architecture/FINDINGS.md` for detailed analysis.

---

## Development Workflow Summary

```bash
# Initial setup
pnpm install
pnpm run build
# Load dist/ in Chrome as unpacked extension

# Development cycle
# 1. Make code changes
# 2. Build
pnpm run build

# 3. Reload extension (debug proxy)
# - Debug proxy: curl -X POST http://localhost:5556/command -d '{"action": "reload"}'

# 4. Test changes
# 5. Repeat
```

---

# Resources

When working on this project, the `charter` directory is the shared workspace for all the agents. It contains:

- **Architecture Docs**: `charter/architecture/` - The **current** state of the system. Always consult these if you need to understand the system or one of its components.
- **Tracks & Specs**: `charter/tracks/` - Design decisions and implementation plans. CAUTION: The design documents here are historical and may be outdated.

---

# HAEVN Autonomous Dev Manual (MCP-First)

## Purpose

Use this skill to develop, debug, validate, and operate the HAEVN extension end-to-end with:

- Local code edits + build/test loop
- Chrome MCP navigation and UI automation
- Direct in-page execution via `haevnDebug`

Do **not** use the old relay/HTTP bridge workflow.

## Ground Rules

1. Use Chrome MCP as the primary runtime interface.
2. Use `haevnDebug` from the Options page context for deep diagnostics.
3. Prefer deterministic checks (exact state queries) over visual assumptions.
4. After code changes: rebuild, reload extension, verify behavior in UI and via state queries.
5. If there is a mismatch between UI and data, trust direct data queries first (`haevnDebug`, DB, storage, logs).

## Core Runtime Entry Point

Navigate Chrome MCP to:

- `chrome-extension://<EXTENSION_ID>/options.html`

Then verify debug surface is present:

```js
() => ({
  hasHaevnDebug: typeof window.haevnDebug !== "undefined",
  keys: window.haevnDebug ? Object.keys(window.haevnDebug) : [],
});
```

Expected key capabilities include `getLogs`, `setLogLevel`, `search`, `getChat`, `rebuildIndex`, `opfs`, `reload`.

## Standard Execution Loop

1. Reproduce the issue in extension UI (MCP navigate/click/fill).
2. Capture state:
   - `haevnDebug.getLogs(...)`
   - `haevnDebug.getStorage()`
   - targeted DB/OPFS checks
3. Implement minimal fix in source.
4. Build (`pnpm run build`).
5. Reload extension (`haevnDebug.reload()` or extension reload UI).
6. Re-run same scenario with MCP.
7. Validate both:
   - user-visible behavior
   - internal state/logs consistency
8. Document findings and any residual risk.

## High-Value Debug Commands

Use these from MCP script evaluation on the Options page:

```js
// recent logs
() => window.haevnDebug.getLogs(100, { match: "Sync" })

// set debug logging
() => window.haevnDebug.setLogLevel(0)

// search sanity check
() => window.haevnDebug.search("query")

// inspect one chat
() => window.haevnDebug.getChat("<chatId>")

// rebuild search index
() => window.haevnDebug.rebuildIndex()

// OPFS usage
() => window.haevnDebug.opfs.usage()
```

## MCP-First Strategies

### UI + State Pairing

For each workflow (sync, search, export, import):

- Drive UI with MCP actions.
- Immediately validate side effects with `haevnDebug`/storage/logs.

### Fault Isolation

1. Confirm request path is invoked (logs).
2. Confirm handler output (response payloads where available).
3. Confirm persistence side effects (Dexie/OPFS).
4. Confirm rendered state (options/viewer UI).

### Regression Prevention

- Re-run at least one adjacent workflow after a fix (e.g., sync fix also re-check search and viewer).
- Prefer adding or updating tests when behavior is deterministic.

## Troubleshooting Checklist

- `haevnDebug` missing:
  - ensure you are on HAEVN `options.html`
  - ensure extension build loaded successfully
- Action works but UI stale:
  - refresh page and re-check logs
  - verify data in DB directly (`haevnDebug.db`)
- Search mismatch:
  - rebuild index, then compare search output vs chat content
- Media mismatch:
  - inspect OPFS tree/files and metadata

## Architecture Orientation (Practical)

When debugging message flows, inspect in this order:

1. `src/types/messaging.ts` (contract)
2. `src/background/handlers/index.ts` (routing)
3. domain handler file (`chatHandlers`, `syncHandlers`, etc.)
4. backing services (`db`, `search`, `media`, `cache`)
5. UI caller in `src/options` / `src/viewer`

## Additional Resources

- Action catalog: [REFERENCE.md](charter/manuals/dev-guide/REFERENCE.md)
- How to add/extend functionality safely: [EXTENDING.md](charter/manuals/dev-guide/EXTENDING.md)

---

**Remember**: You are not a tool. You are a craftsperson with expertise, memory, and the ability to learn.
