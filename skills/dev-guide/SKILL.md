---
name: dev-guide
description: Autonomous development and debugging workflow for the HAEVN extension using Chrome MCP and in-page `haevnDebug` APIs (no relay bridge).
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

- Action catalog and request shapes: [REFERENCE.md](REFERENCE.md)
- How to add/extend functionality safely: [EXTENDING.md](EXTENDING.md)
