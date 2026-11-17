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
| The CLI | `skills/haevn-cli/SKILL.md`, `cli/README.md` |
| Current work | `gnomon ticket view working --namespace HVN`, `gnomon ticket view active --namespace HVN` |
| Blocked on a human | `gnomon ticket view needs_human --namespace HVN` |
| The lane's memory | `gnomon note list --dir-prefix /project/haevn/workstreams` |
| The working agreement (worktrees, branches, merges) | `gnomon read /studio/dev/skills/dev-workflow` |

The KB is being bootstrapped (HVN-1). Until `/project/haevn/architecture/` exists, the old maps in `charter/` (gitignored, local to one machine, last written 2026-01-30) are a source, not the truth: they predate the CLI daemon, metadata, starmap, the exporter registry and the Codex and Pi providers. `charter/` and `planning/` will be deleted once their content is in the KB.

## Knowledge and identity

- The KB is the Gnomon workspace `hive`, reached with the `gnomon` CLI in Bash and nothing else (no gnomon MCP). This project is the namespace `/project/haevn`; its ticket prefix is `HVN`.
- Run `gnomon whoami` before your first write. If your brief names a profile, act as it with `GNOMON_PROFILE=<handle> gnomon …`, on every call. `unbound` (exit 5) means no identity reached the call: stop and report; never borrow another profile.
- Long text goes in from a file or stdin (`--body-file -`, `--description-file -`), never inside shell quotes.
- Method skills are KB notes, loaded on demand: `/studio/dev/skills/*` (this studio's protocols), `/domain/dev/skills/*` (the craft), `/project/haevn/skills/*` (this system's manual), `/global/skills/*`.

## Studio seats

The dev studio is summoned with Goetia from `/studio/dev`, not maintained in this repository.

- **Claude Code**: `as-claude prior` from the repository root starts the Prior (`tessera`); other seats work the same way (`as-claude <role|persona>`).
- **pi**: `as-pi prior`.
- Builders and journeymen run in isolated worktrees under `.claude/worktrees/` (gitignored), which start from committed state. A fresh worktree needs `pnpm install` (and `pnpm -C cli install` for CLI work) before any gate.

## Completion gate

A task is done when these pass on the final tree:

```bash
npx vitest run               # tests, single run (`pnpm test` is watch mode)
pnpm run lint                # biome, src/ only
pnpm run build               # the extension, into dist/
pnpm -C cli run typecheck    # when cli/ changed
pnpm -C cli run lint         # when cli/ changed
```

Known gaps, each with a ticket rather than a workaround:

- The root has no typecheck in the gate. `npx tsc --noEmit` reports errors today, most from a `jsx` setting that disagrees with the esbuild build; esbuild does not type-check, so CI cannot see them.
- `pnpm -C cli run lint` is red on `main` (formatting and import order), and CI does not lint the CLI.
- The CLI has no tests.

CI (`.github/workflows/ci.yml`) runs `lint`, `test` and `build` on every push to `main`. The pre-push hook runs the extension build and the docs build. A change the user sees in the UI is also checked in the running extension (`skills/dev-guide/SKILL.md`): rebuild, reload, drive it, read `haevnDebug.getLogs()`.

## Commits and releases

Every commit references its ticket: `type(scope): summary`, then a `Refs: HVN-12` trailer (`Refs: none (reason)` when there is none). The scope is the area: `extension`, `cli`, `search`, `providers`, `export`, `metadata`, `starmap`, `docs`, `repo`. Merges carry `Refs:` too, and `Changelog:` when users should read the change. The full rule: `gnomon read /studio/dev/skills/commit-format`.

- The only remote is `upstream` (`github.com/aiamblichus/haevn`). Integrate on `upstream/main`, not on a stale local `main`.
- Pushing to `main` runs CI only. Tags release: `v*.*.*` runs `release.yml` (the extension), `cli-v*.*.*` runs `publish-cli.yml` (npm). Cutting a release is αιamblichus's call.

## Generated and local-only

- Do not edit `dist/`, `cli/dist/`, `docs/dist/` or `node_modules/`.
- `skills/*/SKILL.md` will be generated from `/project/haevn/skills/*` by a sync target (HVN-1): once it lands, edit the KB note and re-sync, never the file. `.claude/skills/dev-guide` is a symlink to `skills/dev-guide`.
- Gitignored and local-only: `charter/`, `planning/`, `transcripts/`, `openai_export/`, `gemini-md/`, `*.zip`. Nothing there is shared or backed up.
- Secrets (API keys, the CLI daemon's key) never go in a commit, a note or a ticket.

---

## Core technologies

- **Language:** TypeScript 5.9 (strict mode), about 50k lines in `src/`
- **Build:** esbuild (multi-entry bundling, one IIFE per context and worker)
- **Runtime:** Chrome Extension MV3 (service worker)
- **Frontend:** React 18.3, Tailwind CSS, shadcn/ui, Radix UI primitives
- **Persistence:** Dexie (IndexedDB, schema in `src/services/db.ts`) + OPFS for media
- **State:** Zustand (UI state), event-driven architecture (`chrome.runtime` messaging)
- **Search:** Lunr.js in a Web Worker
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

A soft-delete flag gives instant UX; the Janitor service does the expensive cleanup every 30 minutes. Compound indexes filter deleted items at query time.

### 6. Event-driven UI updates

The background service worker is the source of truth. UI components subscribe to events (`chatSynced`, `bulkSync*`, `importProgress`, `providerStatsUpdated`) for real-time updates.

## Conventions

### Code style (enforced by Biome)

- 2-space indentation, 100-character lines
- Double quotes, trailing commas
- camelCase for functions and variables, PascalCase for components and types
- `fireAndForget()` for non-critical async work, not a bare `.catch(() => {})`

### Architecture rules

- **Persistence goes through the services** (`syncService`, `chatRepository`, `metadataRepository`, …), never Dexie directly from a handler. (`metadataHandlers.ts` imports `db` today; that is a finding, not a precedent.)
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
8. **CLI bridge** (`src/background/wsBridge.ts`, `cli/`): the terminal's view of the archive; exports go through the extension's exporter registry (`src/background/export/exporters.ts`)

### Data flows

- **Single chat sync:** popup → handler → content script → extractor → transformer → repository → index → event
- **Bulk sync:** orchestrator → offscreen (iframe) → chat ids → alarm loop → fetch (API or navigation) → transform → save → event
- **Search:** UI → handler → offscreen → worker (Lunr) → streaming results → UI
- **Export:** handler → worker → ZIP → browser API bridge → download

### Adding a platform

- Create `src/providers/{platform}/` with extractor, transformer, model and provider
- Register it in `src/background/init.ts`
- Add the host permission in `src/manifest.json`
- Update `src/utils/platform.ts` for detection
