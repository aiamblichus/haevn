---
name: browser-check
description: "How to drive HAEVN in a real Chrome: the hard rules (scripts/browsers.sh check; test profile on /tmp/surf-dev.sock with the haevn DevTools server for extension pages; αιamblichus's Chrome on /tmp/surf-prod.sock, read-only), setting up the dev profile, the check loop, fixtures, HAEVN's traps and CLI checks. The general parts are in browser-walk and extension-dev."
---

<!-- generated from /project/haevn/skills/browser-check by pnpm run skills:sync; edit the KB note, not this file -->
# Browser check: seeing HAEVN run

How to drive HAEVN in a real Chrome, check a change there, and record the verdict. `dev-guide` covers what to do inside the extension (`haevnDebug`, logs, state). The general part lives in two notes: **which Chrome you may touch and how** (the two sockets, the rules for his Chrome, surf's manual): `/domain/ui/skills/browser-walk`, section "Reaching a real browser"; **running an extension in a browser** (why surf cannot open its pages, the DevTools server, the reload loop, the traps any extension has): `/domain/dev/skills/extension-dev`. This note is what is true only of HAEVN. Add to it whenever a check teaches you something.

## The hard rules

- **Before any browser command:** `scripts/browsers.sh check`. It exits 1 if a browser is unreachable.
- **Test profile** (dummy data; anything goes): `SURF_SOCKET=/tmp/surf-dev.sock surf …` for web pages, and `mcp__chrome-devtools-haevn__*` for the extension's own `chrome-extension://` pages, which surf refuses.
- **αιamblichus's Chrome** (his logins and archive): `SURF_SOCKET=/tmp/surf-prod.sock surf …`. Read-only, with his say-so, in a session of your own, `--no-diff`, no `semantic.*`, no AI-site commands, raw network output never pasted. There is no DevTools server for it: read the extension there through `haevn logs`, not the archive page. His chats are the subject: counts and shapes go into tickets, text and titles do not.
- **A brief that names no browser means the test profile.** Unreachable: stop and report, never fall back to the other. A bare `surf` that answers: stop and tell the Prior (DOT-90 manages the wrappers).
- **Do not use `mcp__chrome-devtools__*`** (no `haevn` in the name): a user-level `--autoConnect` server that is not tied to either socket.

## The dev profile (once per machine)

Directory `~/.local/share/haevn-dev-chrome`, DevTools port 9223, surf socket `/tmp/surf-dev.sock`. `scripts/browsers.sh start-dev` starts it.

1. In its window, `chrome://extensions`, developer mode, "Load unpacked" → `~/Code/active/haevn/dist`.
2. surf in that profile, by hand until DOT-90: load surf unpacked there, write `~/.local/share/haevn-dev-chrome/surf-host-wrapper.sh` (a copy of the default wrapper, `~/Library/Application Support/surf-cli/host-wrapper.sh`, with `export SURF_SOCKET=/tmp/surf-dev.sock`) and `NativeMessagingHosts/surf.browser.host.json` pointing at it (allowed origin `chrome-extension://oaclimdkkglbnpekeignmjenkodkaaka/`). His Chrome's wrapper exports `/tmp/surf-prod.sock`. A surf install or update rewrites only the default manifest: re-check both wrappers after one.
3. The DevTools server entry in `.mcp.json` at the repository root (local, gitignored), so write it on a new machine:
   ```json
   { "mcpServers": { "chrome-devtools-haevn": { "command": "npx", "args": ["chrome-devtools-mcp@latest", "--browserUrl=http://127.0.0.1:9223", "--categoryExtensions"] } } }
   ```

The extension ID for `/Users/goran/Code/active/haevn/dist` is `fbdcbacjgcnpbjbngofmmjkgnejadimb`; for another path, `list_extensions` or the snippet in `extension-dev`. After a reboot: start his Chrome, check that Surf is still in its extensions, `scripts/browsers.sh start-dev` if the test profile is needed, then `scripts/browsers.sh check`.

## The loop for a check

1. `pnpm run build` in the primary checkout, on the commit you mean (a worktree's `dist/` is not what the profile loaded).
2. `reload_extension` with the ID: the service worker keeps old code until then.
3. Open `chrome-extension://<ID>/options.html` (the archive); the viewer is `viewer.html`, the popup `popup.html` (trap below).
4. Seed fixtures, do the check, and read `haevnDebug.getLogs()` and `list_console_messages` for the page and for `sw-1` after each step.
5. Record a verdict on each ticket: pass, fail, or not checkable, with what you did, what you saw, and the evidence. Failures and new defects become tickets; a check never changes code.

## Fixtures

`scripts/fixtures/browser-fixtures.py [N_FILLER=300] [OUT_DIR]` writes `fixtures.zip` (a HAEVN export ZIP: named test chats plus filler chats, some with PNG attachments) and `late_chat.json` into `transcripts/browser-check/` (gitignored). Import the ZIP through the archive's Import modal with `upload_file`. The named chats are commented in the script by the ticket they serve: hostile markup next to "pineapple" (HVN-56), long and multi-match messages (HVN-20), a forked chat whose `currentId` is on a later branch (HVN-51), a chat to delete (HVN-33). Add a fixture there when a new check needs one, and say which ticket it serves. Delete `transcripts/browser-check/` when the check is done; the dev profile can keep its archive.

## Traps we have hit (HAEVN only; the rest are in `extension-dev`)

- **The popup opened as a tab answers every runtime message with `null`** while it is open (HVN-67): close it before checking anything else.
- **The Import dialog swaps its file input** when the provider changes. Choose the provider, take a fresh snapshot, then `upload_file` to the new "Choose File" uid.
- **Fast jobs:** a 300-chat export finishes in about 4 s. Read `activeOperation` in `chrome.storage.local` instead of waiting on status text.
- **Expected noise:** `WebSocket connection to 'ws://localhost:5517/ws' failed` every 30 s when the CLI bridge is on and no daemon runs (leave the bridge off unless the check is about the CLI). CSP "inline event handler" errors in the viewer when a chat contains inline handlers (HVN-69): nothing runs.
- **Not checkable in the dev profile:** the starmap (it needs AI metadata and embeddings) and a bulk sync (it needs a platform login there).
- **The search worker's logs do not reach `haevnDebug.getLogs()` or the MCP.** The index is a SQLite FTS5 file in an OPFS pool at `.haevn-search/` (opaque names; `media/` sits beside it and must survive anything search does). A rebuild writes the other of two slots and swaps, so search keeps answering and a rebuild is not visible as a pause: listen in the page for `indexRebuildProgress` and `indexRebuildComplete` (`workerMessage` broadcasts). The old `lunrIndex` table is gone (Dexie 21, HVN-89); a bulk sync's catch-up window is the `search:bulk-window` row of the `cache` table (HVN-88).
- **After a merge that changes `background.js`,** `reload_extension` (dev profile), or ask αιamblichus to reload HAEVN in his Chrome, before judging behaviour there. `haevn logs` answering "update the extension" means he has not reloaded since the verb landed.
- **The CLI daemon reaches whatever archive is connected.** While `haevn daemon` runs against his real Chrome, any seat with a shell can read his real archive through `haevn search/list/get`. Do not run `haevn` against it, and do not copy chat text out of it, without his say-so; text pulled for a spike is private data: delete it when the spike ends.

## CLI checks

The daemon talks to whichever extension has the CLI bridge on with the same key. If the prod profile has the bridge on, turn it off there, or use a different port in the dev profile, before running `haevn daemon` for a dev-profile check, or the two extensions replace each other (close code 4002, HVN-44). Install the CLI from the repo as `cli/README.md` says (`pnpm build`, `pnpm link --global`; on fish, `PNPM_HOME` must be on the PATH).
