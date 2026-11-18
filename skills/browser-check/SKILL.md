---
name: browser-check
description: "How to drive HAEVN in a real Chrome: the dev and prod profiles and their two MCP servers, setting up the dev profile, the check loop, fixtures, the traps we have hit, and CLI checks."
---

<!-- generated from /project/haevn/skills/browser-check by pnpm run skills:sync; edit the KB note, not this file -->
# Browser check: seeing HAEVN run

How to drive HAEVN in a real Chrome, check a change there, and record the verdict. `dev-guide` covers what to do inside the extension (`haevnDebug`, logs, state). This note covers which browser, how to reach it, how to seed it, and the traps. Add to it whenever a check teaches you something.

## Two profiles, two MCP servers

| | Dev (test) profile | Prod profile |
| --- | --- | --- |
| What | A throwaway Chrome profile with HAEVN loaded unpacked from this repo's `dist/` | αιamblichus's own Chrome: his tabs, logins and real archive |
| MCP server | `chrome-devtools-haevn` | `chrome-devtools` |
| How it connects | `--browserUrl=http://127.0.0.1:9223 --categoryExtensions` | `--autoConnect` (Chrome's `chrome://inspect` remote debugging) |
| Use it for | Every check: seed fixtures, delete, pause, cancel, break things | Only with his say-so, for something that needs his real data; read-only; never seed, delete or change settings there |

If a brief does not name the profile, it is the dev profile. A subagent that may drive a browser is told the hard rule in its brief: only `mcp__chrome-devtools-haevn__*`, never `mcp__chrome-devtools__*`.

## Setting up the dev profile (once per machine)

1. Start it:
   ```bash
   open -na "Google Chrome" --args --user-data-dir="$HOME/.local/share/haevn-dev-chrome" --remote-debugging-port=9223 --no-first-run
   ```
   A non-default `--user-data-dir` is what allows `--remote-debugging-port` on current Chrome.
2. In that window, open `chrome://extensions`, turn on developer mode, and choose "Load unpacked" → `~/Code/active/haevn/dist`. Current Chrome ignores `--load-extension`, so this is manual, but the profile remembers it.
3. The MCP entries live in `.mcp.json` at the repository root. It is local and gitignored, so write it on a new machine:
   ```json
   {
     "mcpServers": {
       "chrome-devtools": { "command": "npx", "args": ["chrome-devtools-mcp@latest", "--autoConnect"] },
       "chrome-devtools-haevn": { "command": "npx", "args": ["chrome-devtools-mcp@latest", "--browserUrl=http://127.0.0.1:9223", "--categoryExtensions"] }
     }
   }
   ```
   Without `--categoryExtensions`, the server refuses `chrome-extension://` URLs and has no extension tools. A changed entry takes effect only after the server restarts (`/mcp`, reconnect).

The extension ID of an unpacked load is derived from the absolute path of `dist/`. For `/Users/goran/Code/active/haevn/dist` it is `fbdcbacjgcnpbjbngofmmjkgnejadimb`. For another path, compute it:
```bash
python3 -c "import hashlib,sys; h=hashlib.sha256(sys.argv[1].encode()).hexdigest()[:32]; print(''.join(chr(97+int(c,16)) for c in h))" "$PWD/dist"
```
`list_extensions` on the haevn server shows it too.

## The loop for a check

1. Build what you are checking: `pnpm run build` in the checkout whose `dist/` the profile loads (the primary checkout, on the commit you mean). A worktree's `dist/` is not what the profile loaded.
2. `reload_extension` with the ID; the extension must run the new build.
3. Open `chrome-extension://<ID>/options.html` (the archive) with `new_page`. The viewer is `viewer.html`, the popup `popup.html` (see the trap about the popup below). `list_pages` also lists the service worker as `sw-1`.
4. Seed fixtures (next section), do the check, and read `haevnDebug.getLogs()` and `list_console_messages` for the page and for `sw-1` after each step.
5. Record a verdict on each ticket: pass, fail, or not checkable, with what you did, what you saw, and the evidence (screenshots, log lines, counts). Failures and new defects become tickets; a check never changes code.

## Fixtures

`scripts/fixtures/browser-fixtures.py [N_FILLER=300] [OUT_DIR]` writes `fixtures.zip` (a HAEVN export ZIP: named test chats plus filler chats, some with PNG attachments) and `late_chat.json` into `transcripts/browser-check/` (gitignored). Import the ZIP through the archive's Import modal with `upload_file`. The named chats are commented in the script by the ticket they serve: hostile markup next to "pineapple" (HVN-56), long and multi-match messages (HVN-20), a forked chat whose `currentId` is on a later branch (HVN-51), a chat to delete (HVN-33). Add a fixture there when a new check needs one, and say which ticket it serves.

Delete `transcripts/browser-check/` when the check is done. The dev profile can keep its archive between checks.

## Traps we have hit

- **`chrome://` pages cannot be opened through the MCP**, in either server. Extension pages need `--categoryExtensions`.
- **`Could not read DevToolsActivePort … EPERM`** on the prod server: macOS app-data protection on Chrome's profile folder, not a sandbox. The session's terminal process (herdr-core, launched by launchd) is the app asking. It went away once remote debugging was on in `chrome://inspect` and the server was started with `--autoConnect`. The `chrome://inspect` style serves no `/json` over HTTP, so `curl` on its port shows nothing; that is normal.
- **Uploads come only from inside the working tree.** Stage fixtures under the gitignored `transcripts/`, not the scratchpad.
- **Downloads land in `~/Downloads`, which a sandboxed seat cannot read.** To inspect an export ZIP, either set the dev profile's download folder to `transcripts/browser-check/downloads/` (Chrome settings → Downloads, once), or capture the bytes in the service worker by wrapping `chrome.downloads.download` and reload the extension afterwards to remove the wrapper. Test ZIPs left in `~/Downloads` are αιamblichus's to delete; say so.
- **The popup opened as a tab answers every runtime message with `null`** while it is open (HVN-67), so checks of the archive go wrong with `popup.html` open. Close it before checking anything else.
- **Expected noise:** `WebSocket connection to 'ws://localhost:5517/ws' failed` every 30 s when the CLI bridge is on and no daemon runs (leave the bridge off unless the check is about the CLI). CSP "inline event handler" errors in the viewer when a chat contains inline handlers (HVN-69): nothing runs.
- **Not checkable in the dev profile:** the starmap needs AI metadata and embeddings (a configured provider); a bulk sync needs a platform login in that profile.

## CLI checks

The daemon talks to whichever extension has the CLI bridge on with the same key. If the prod profile has the bridge on, turn it off there, or use a different port in the dev profile, before running `haevn daemon` for a dev-profile check, or the two extensions replace each other (close code 4002, HVN-44). Install the CLI from the repo as `cli/README.md` says (`pnpm build`, `pnpm link --global`; on fish, `PNPM_HOME` must be on the PATH).
