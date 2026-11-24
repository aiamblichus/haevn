# AGENTS.md — haevn

**HAEVN** (a psychopomp for digital consciousness) is a Chrome Manifest V3 extension, plus a terminal CLI (`cli/`), that syncs AI conversations from many LLM platforms into one local archive. It keeps the full context of each conversation (branches, multi-modal content, metadata) in a canonical `HAEVN.Chat` format.

**Core value:** own your AI conversation history. Search across platforms. Export for backup. Never lose context.

**Providers** (`src/providers/`): Claude, ChatGPT, Gemini, Poe, Open WebUI, Qwen, DeepSeek, AI Studio, Grok (synced from the web), and Claude Code, Codex, Pi (imported from local session files).

This file holds what is true of this repository. Who you are, the studio's method and the project's knowledge live in the KB (below).

## Start here

| Need | Start here |
| --- | --- |
| The project's KB | `gnomon read /project/haevn/index`; `gnomon note list --dir-prefix /project/haevn` |
| Architecture | `gnomon read /project/haevn/architecture/index` |
| Product: who it is for, what is in and out | `gnomon read /project/haevn/product/index` |
| Run, drive and debug the extension | `skills/dev-guide/SKILL.md` (Chrome MCP + `haevnDebug`) |
| See a change run in a real browser: the dev and prod Chrome profiles, their MCP servers, fixtures, traps | `skills/browser-check/SKILL.md` (KB: `/project/haevn/skills/browser-check`) |
| Check every provider still works before a release (the runbook: import formats in the dev profile, web providers in αιamblichus's Chrome) | `skills/provider-runbook/SKILL.md` (KB: `/project/haevn/skills/provider-runbook`) |
| The CLI | `skills/haevn-cli/SKILL.md`, `cli/README.md` |
| Current work | `gnomon ticket view working --namespace HVN`, `gnomon ticket view active --namespace HVN` |
| Blocked on a human | `gnomon ticket view needs_human --namespace HVN` |
| The lane's memory | `gnomon note list --dir-prefix /project/haevn/workstreams` |
| The working agreement (worktrees, branches, merges) | `gnomon read /studio/dev/skills/dev-workflow` |

The project's maps, backlog and design history live only in the KB; there is no `charter/` or `planning/` any more (removed 2026-11-17, HVN-6). Brand assets are in `assets/brand/`.

## Knowledge and identity

- The KB is the Gnomon workspace `hive`, reached with the `gnomon` CLI in Bash and nothing else (no gnomon MCP). This project is the namespace `/project/haevn`; its ticket prefix is `HVN`.
- Run `gnomon whoami` before your first write. If your brief names a profile, act as it with `GNOMON_PROFILE=<handle> gnomon …`, on every call. `unbound` (exit 5) means no identity reached the call: stop and report; never borrow another profile.
- Long text goes in from a file or stdin (`--body-file -`, `--description-file -`), never inside shell quotes.
- Method skills are KB notes, loaded on demand: `/studio/dev/skills/*` (this studio's protocols), `/domain/dev/skills/*` (the craft), `/project/haevn/skills/*` (this system's manual), `/global/skills/*`.

## Studio seats

The dev studio is summoned with Goetia from `/studio/dev`, not maintained in this repository.

- **Claude Code**: `as-claude prior` from the repository root starts the Prior (`tessera`); other seats work the same way (`as-claude <role|persona>`).
- **pi**: `as-pi prior`.
- Builders and journeymen run in isolated worktrees under `.claude/worktrees/` (gitignored), which start from committed state. A fresh worktree needs `pnpm install` and `pnpm -C cli install` before any gate: the root `pnpm test` runs `tests/backupRoundTrip.test.ts`, which imports the CLI's sources and so its `ws`.

## Completion gate

A task is done when these pass on the final tree:

```bash
pnpm test                    # tests, single run (`pnpm run test:watch` watches); needs `pnpm -C cli install` first
pnpm run lint                # biome, src/ only
pnpm run typecheck           # tsc --noEmit over src/
pnpm run build               # the extension, into dist/
pnpm -C cli run typecheck    # when cli/ changed
pnpm -C cli run lint         # when cli/ changed
pnpm -C cli test             # when cli/ changed
```

CI (`.github/workflows/ci.yml`) runs `lint`, `typecheck`, `test`, the CLI's lint, typecheck and tests, and `build` on every push to `main`. The pre-push hook runs the typecheck, the extension build and the docs build. A change the user sees in the UI is also checked in the running extension, in the dev profile (`skills/browser-check/SKILL.md`): rebuild, reload, drive it, read `haevnDebug.getLogs()`.

## Commits and releases

Every commit references its ticket: `type(scope): summary`, then a `Refs: HVN-12` trailer (`Refs: none (reason)` when there is none). The scope is the area: `extension`, `cli`, `search`, `providers`, `export`, `metadata`, `starmap`, `docs`, `repo`. Merges carry `Refs:` too, and `Changelog:` when users should read the change. The full rule: `gnomon read /studio/dev/skills/commit-format`.

- The only remote is `upstream` (`github.com/aiamblichus/haevn`). Integrate on `upstream/main`, not on a stale local `main`.
- Pushing to `main` runs CI only. Tags release: `v*.*.*` runs `release.yml` (the extension), `cli-v*.*.*` runs `publish-cli.yml` (npm). Cutting a release is αιamblichus's call.

## Generated and local-only

- Do not edit `dist/`, `cli/dist/`, `docs/dist/` or `node_modules/`.
- `skills/` is generated from `/project/haevn/skills/*` (manifest `skills/sync.json`): edit the KB note, then `pnpm run skills:sync` and commit; `pnpm run skills:check` exits 1 when a file is stale. Never edit the files. `.claude/skills/dev-guide` and `.claude/skills/browser-check` are symlinks to their `skills/` folders, so Claude Code loads them.
- Gitignored and local-only: `transcripts/`, `openai_export/`, `gemini-md/`, `*.zip`, `.mcp.json` (the browser MCP servers; its contents are in the `browser-check` skill). Nothing there is shared or backed up.
- Secrets (API keys, the CLI daemon's key) never go in a commit, a note or a ticket.

---

## Core technologies

- **Language:** TypeScript 5.9 (strict mode), about 50k lines in `src/`
- **Build:** esbuild (multi-entry bundling, one IIFE per context and worker)
- **Runtime:** Chrome Extension MV3 (service worker)
- **Frontend:** React 18.3, Tailwind CSS, shadcn/ui, Radix UI primitives
- **Persistence:** Dexie (IndexedDB, schema in `src/services/db.ts`) + OPFS for media
- **State:** event-driven (`chrome.runtime` messaging); the service worker is the source of truth
- **Search:** SQLite FTS5 (WebAssembly) on an OPFS file, in a Web Worker
- **CLI:** citty, a WebSocket daemon bridged to the extension (`src/background/wsBridge.ts`)
- **Testing:** Vitest, fake-indexeddb
- **Linting:** Biome 2.3

## Architectural principles

### 1. Three-tier worker architecture

Chrome MV3 service workers cannot create Web Workers. Solution: service worker → offscreen document → Web Workers (search, stats, thumbnails, import, bulk export, bulk sync, starmap). CPU-heavy work never blocks the service worker.

### 2. Data transformation pipeline

Raw platform data → Extractor (fetch) → Transformer (normalize) → `HAEVN.Chat` → persistence → indexing → export. One canonical format removes N×M format conversions.

### 3. Provider abstraction

Each platform implements `Extractor<TRaw>` and `Transformer<TRaw>`. Core sync logic is platform-agnostic; adding a platform changes neither orchestration nor persistence.

### 4. Separation of concerns

- **Handlers**: route messages, orchestrate
- **Services**: CRUD, caching, indexing
- **Providers**: platform-specific extraction and transformation
- **Workers**: heavy computation
- **UI**: display, user interaction

### 5. Soft delete with deferred cleanup

A soft-delete flag gives instant UX; the Janitor service hard-deletes after a 5-minute grace, at start and every 30 minutes. Until then the archive offers an undo of the last delete ("Deleted N chats — Undo"). Compound indexes filter deleted items at query time.

### 6. Event-driven UI updates

The background service worker is the source of truth. UI components subscribe to events (`chatSynced`, `bulkSync*`, `importProgress`, `providerStatsUpdated`) for real-time updates.

The maps of each subsystem are in `/project/haevn/architecture/` (`gnomon read /project/haevn/architecture/index`); this file is the summary.

## Conventions

### Code style (enforced by Biome)

- 2-space indentation, 100-character lines
- Double quotes, trailing commas
- camelCase for functions and variables, PascalCase for components and types
- `fireAndForget()` for non-critical async work, not a bare `.catch(() => {})`

### Architecture rules

- **Persistence goes through the services** (`syncService`, `chatRepository`, `metadataRepository`, …), never Dexie directly from a handler or a page. Biome enforces it for `src/background/handlers/`, `src/background/wsBridge.ts`, `src/options/`, `src/popup/`, `src/viewer/` and `src/components/` (`biome.jsonc`, HVN-21): a value import of `services/db` fails `pnpm run lint`. A type-only import (`import type`) is fine. `src/options/debug.ts` is the one exception.
- **All indexing via the search worker**; the services proxy to it.
- **Heavy operations in workers**: ZIP generation, indexing, stats, layout.
- **Browser APIs via the service worker**; workers use the bridge pattern.
- **Downloads via the `downloadFile` handler**; no blob URLs in UI components.
- **Emit events** for real-time UI updates.

### Testing

- Unit tests for pure functions (extractors, transformers, utilities)
- Integration tests for service workflows (sync, search, import/export)
- `fake-indexeddb` for Dexie (see `tests/setup.ts`)

## System structure

1. **Message router** (`src/background/handlers/`, contract in `src/types/messaging.ts`): type-safe message dispatch
2. **Providers** (`src/providers/`): one plugin per platform, API fetch or DOM extraction
3. **Persistence** (`src/services/`): repositories, search index manager, search service, media storage
4. **Worker pool** (`src/offscreen/`, `*.worker.ts`): search, stats, thumbnail, import, bulk export, bulk sync, starmap
5. **Bulk operations** (`src/background/bulkSync/`, `bulkExport/`, `import/`): stateful orchestration under an operation lock
6. **UI** (`src/popup/`, `src/options/`, `src/viewer/`): popup, archive (options) and viewer
7. **Content script** (`src/content/content.ts`): injected bridge to the LLM platforms
8. **CLI bridge** (`src/background/wsBridge.ts`, `cli/`): the terminal's view of the archive. Each verb calls the same service-level operation as its UI handler; keep it that way when you add one

### Data flows

- **Single chat sync:** popup → handler → content script → extractor → transformer → repository → index → event
- **Bulk sync:** orchestrator → extraction tab → chat ids → alarm loop → fetch (API or navigation) → transform → save → event
- **Search:** UI → handler → offscreen → worker (FTS5) → streaming results → UI
- **Export:** handler → worker → ZIP → browser API bridge → download

### Adding a platform

- Create `src/providers/{platform}/` with extractor, transformer, model and provider
- Register it in `registerAllProviders()` (`src/providers/index.ts`), and give its provider definition `hosts` (the web hostnames a sync matches) or `importOnly: true`; `PROVIDERS` in `init.ts` and `getProviderByPlatform` both read the registry. Every JavaScript context that selects a provider calls `registerAllProviders()` first (service worker, content script, bulk-sync worker)
- Add the host permission in `src/manifest.json`
- Update `src/utils/platform.ts` for detection
