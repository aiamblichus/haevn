---
name: haevn-cli
description: How to use the HAEVN CLI to search, inspect branches, and export chats efficiently
---

<!-- generated from /project/haevn/skills/haevn-cli by pnpm run skills:sync; edit the KB note, not this file -->
# haevn-cli — Agent Reference

`haevn` is the terminal interface to HAEVN, a local archive for AI conversations across multiple platforms.  
Use it to quickly find relevant chats, inspect branch structure, and extract exactly the thread you need.

HAEVN supports providers like Claude, ChatGPT, Gemini, Poe, Open WebUI, Qwen, DeepSeek, AI Studio, and Grok.

---

## Core idea

Treat `haevn` as a layered workflow:

1. `list` to find candidate chats.
2. `search` to find exact message hits.
3. `branches` to understand branch topology.
4. `get` to extract the exact branch you want.
5. `export` for a full copy of one chat (the whole archive is `backup`, Happy path 7).

---

## Message refs (important)

HAEVN CLI uses short message refs in output (stable hash-based IDs), e.g. `a1b2c3d4e5f6`.

- Use these refs with `haevn get -m <ref>` to target a branch.
- Full raw message IDs still work.
- `branches --show-ids` can reveal raw IDs when needed.

---

## Happy path 1 — Find relevant conversations

```bash
haevn list
haevn list --platform claude --limit 50
haevn list --sort messageCount
haevn list --limit 50 --offset 50   # the next page
```

Notes:

- List output includes `msgs` and `br` (branch count).
- Page with `--offset` plus `--limit`; JSON output has `total` and `hasMore`. `--after` filters within each page.
- `branched` badge flags chats with heavy branching.

---

## Happy path 2 — Search and inspect context

```bash
haevn search "model welfare inner experience"
haevn search "emergence" --platform claude --limit 100
haevn search "memory leak" --context 220
haevn search "memory leak" --category "AI Emergence"
```

Useful flags:

- `--context` controls snippet window size.
- `--after` / `--before` constrain time.
- `--format json` for scripting pipelines.

```bash
haevn search "ai consciousness" --format json | jq '.results[0]'
```

### Search syntax (important)

HAEVN search is term-based by default.

- A multi-word query like `haevn search "you may not recognize me"` is **not** an exact phrase search.
- Every word is required (AND). There is no stemming; accents are folded (`cafe` finds `café`), and a hyphen or interior `*` splits a word the way a space does.
- For exact phrase matching, pass inner quotes:

```bash
haevn search '"you may not recognize me"'
```

The CLI now prints a hint for unquoted multi-word queries to reduce confusion.

#### Operators

HAEVN parses the query itself (SQLite FTS5 underneath; a query never reaches the engine as raw text):

| Operator | Example          | Description                      |
| -------- | ---------------- | -------------------------------- |
| (none)   | `term1 term2`    | Multi-term query (default term matching) |
| `"..."`  | `"exact phrase"` | Phrase must appear consecutively |
| `-`      | `-exclude`       | Term must NOT be present         |
| `*`      | `react*`         | Prefix/wildcard match            |
| `~`      | `roam~2`         | Near spellings (edit distance, capped at 2) |
| `^`      | `api^10`         | Accepted and ignored (no per-word boost) |

A leading `-` before a quoted phrase is refused ("Leaving out a phrase is not supported"), and a query is limited to 100 words and phrases; both exit 1 with `BAD_QUERY`. `--limit` counts chats, and JSON has `hasMore` when more matched.

#### Examples

```bash
# Multi-word term search (NOT exact phrase)
haevn search "you may not recognize me"

# Exact phrase (recommended shell-safe form)
haevn search '"you may not recognize me"'

# Exclude terms
haevn search "react hooks -class"

# Fuzzy (catches typos)
haevn search "kubernates~2"

# Prefix matching
haevn search "async* await*"

```

#### JSON output hint field

When the query is multi-word and does not contain an explicit quoted phrase,
`haevn search --format json` includes a top-level `hint` field:

```json
{
  "results": [...],
  "total": 8,
  "hint": "Tip: multi-word search matches terms (AND), not an exact phrase..."
}
```

If strict AND-style matching returns nothing, HAEVN auto-retries with relaxed prefix matching (OR).

---

## Happy path 3 — Navigate branches

```bash
haevn branches <chatId>
haevn branches <chatId> --show-ids
haevn branches <chatId> --format json
```

Notes:

- Tree output is compressed: linear user/assistant runs stay flat.
- Indentation appears mainly at real fork points.
- JSON output includes structured tree content plus short refs.

---

## Happy path 4 — Extract the exact thread

```bash
# Primary branch
haevn get <chatId>

# Specific branch by short ref from search/branches output
haevn get <chatId> -m a1b2c3d4e5f6

# JSON for tooling
haevn get <chatId> -m a1b2c3d4e5f6 -f json

# Save markdown
haevn get <chatId> -m a1b2c3d4e5f6 -o ./thread.md

# Read only the first 20 messages (useful for large chats)
haevn get <chatId> --head 20

# Read only the last 20 messages
haevn get <chatId> --tail 20
```

By default, `get` excludes heavy binary payloads.  
Use `--include-media` only when explicitly needed.

---

## Happy path 5 — Export full chat

```bash
haevn export <chatId> -o ./chat.json
haevn export <chatId> -o ./chat.md -f haevn_markdown                  # the branch you are on
haevn export <chatId> -o ./chat-all.md -f haevn_markdown --all-branches   # every branch, as sections (reading only; the importer refuses it)
```

Use export for archival fidelity; use `get` for readable branch extraction.

---

## Happy path 6 — Check that the providers still sync

```bash
haevn health                      # every web provider the user is signed in to
haevn health -p claude,chatgpt    # only these
haevn health -n 3 --timeout 60    # three chats each, 60 s per provider
haevn health -f json              # the report as JSON
```

`health` asks the extension, **in the user's own Chrome**, to open a tab on each provider's site, list the chats, fetch the first two, convert them as a sync does (media skipped) and check them with `checkChat`: messages present, turns in order, no empty text, sane dates, a tree that leads to `currentId`. One row per provider: `ok`, `warn`, `fail`, `not signed in`, `unreachable`, `timeout` or `skipped`.

- **The archive is never changed.** Nothing is saved, queued, indexed or stored; the report holds no chat text, title or id, so it can be pasted into a ticket. Two things still happen, as when browsing: ChatGPT's images for the sampled chats are loaded into memory and discarded, and a loaded tab can refresh the stored sign-in details (credential caches in `chrome.storage.local`). The extension's log can mention a chat, as in a sync.
- **Not signed in, unreachable and skipped mean "not checked"**, not "passed". The last line counts the providers that were checked.
- It needs the sessions of a real browser, so a seat runs it only against a Chrome the user has signed in and has agreed to. The dev profile has no logins: every web provider answers `not signed in` there, which is the expected output of a smoke test. Open WebUI is checked only when its address is set.
- It takes seconds to minutes, opens tabs, and refuses to start while a sync, import or export runs (`BUSY`). Each provider gets 40 s (`--timeout`, up to 120) and the run 4 minutes; Claude, ChatGPT and Gemini (release-blocking) are checked first, so a slow run skips the others, never these. A big account can spend the 40 s on listing (`TIMEOUT`, "listing the chats"): re-run it alone, `haevn health -p chatgpt --timeout 120`.
- Exit code 1 when a provider failed or timed out, or when Claude, ChatGPT or Gemini was skipped for time.
- A `text.empty` on ChatGPT is probably a transformer finding (ticket it), not a site fault; a provider you know is signed in that reads `not signed in` is a failure of the check or of token capture (read its note).
- A `fail` row names the rule (`text.empty`, `tree.current-missing`, `transform.threw`, `fetch.failed`, `list.failed`, …) and how many chats broke it. Read it as "look at this provider", then open one chat in the viewer.

---

## Happy path 7 — Back up the whole archive

```bash
haevn backup ~/backups/haevn              # every live chat and its media, into that directory
haevn backup ~/backups/haevn --wait 120   # give Chrome two minutes to connect (default 60 s)
```

`backup` is for a scheduled job, not for reading chats: it writes `<dir>/manifest.json`, `index.jsonl` (id, file, size and SHA-256 of every chat and media file), `chats/<name>.jsonl` and `media/<name>/<file>`, byte for byte as the extension stores them. Settings and API keys are **not** in it, and neither are chats the user has deleted. It writes into `<dir>.partial` and swaps it in only when every file has arrived at the size the extension listed, so a failed run leaves the previous `<dir>` as it was and no `.partial`. The directory is your conversations in plain text. haevn sends it nowhere; put it where you would put the conversations themselves. `restore` (Happy path 8) puts it back.

- **The exit code is the contract.** `0` done. `75` not now, ask again later: no extension connected within `--wait` (Chrome closed or the CLI bridge off), the connection was lost and did not come back, the extension is busy (a restore is running), a restore began while the run was reading (the run is discarded and `<dir>` is as it was), or another `haevn backup` holds `<dir>.partial`. `1` failed, with one line on stderr naming the case: a wrong API key, an extension or daemon that is too old (restart the daemon), a disk error, a chat or file that could not be read. A runner defers on 75 and reports 1.
- **Strict.** One item that cannot be read fails the run. Two things are not failures: a chat deleted while the run goes (listed in the manifest's `vanished`), and a transfer that did not get through, which is tried again twice.
- It starts its own daemon when none listens on the port and stops it at the end; a standing daemon is used as it is. It needs the API key in `~/.haevn/config.json`, as `haevn daemon` does.
- **Do not run it against the user's real Chrome** to try it out: it reads the whole archive (gigabytes) through the extension. A check uses the dev profile, with a scratch `HOME` holding its own `config.json` (port and key of the dev extension), so the real config is never read.
- A directory that holds anything other than a previous backup is refused, not replaced.

---

## Happy path 8 — Put a backup back (`restore`)

```bash
haevn restore ~/backups/haevn --dry-run     # check the backup, say what would be replaced and added; writes nothing
haevn restore ~/backups/haevn               # shows that, asks [y/N], then restores
haevn restore ~/backups/haevn --chat <id>   # one chat (repeat the flag for more)
haevn restore ~/backups/haevn --yes         # no question: needed when there is no terminal
```

`restore` writes into the user's real archive, so it is the one verb here that an agent never runs against the user's own Chrome without being asked to. Its rules are three: a chat or media file whose id exists is replaced by the backup's copy; what is missing is added; nothing else is touched (the one other write is the derived chat count of each provider it touched). It deletes nothing, and **a chat deleted since the backup comes back**.

- **On an archive in use, a full restore is a rollback.** Each chat that is in both is replaced by the older copy: new messages, a corrected title and new AI metadata are lost from it. A web chat can be synced again; a Claude Code, Codex or Pi session whose file is gone cannot. Use `--chat` to bring back one chat, and read `--dry-run` first. The prompt says it with counts; the rollback paragraph shows only when something would be replaced.
- **A new machine** is: install the extension, switch on the CLI bridge, put its API key in `~/.haevn/config.json`, run `haevn restore`. Settings and keys are not in a backup (set the metadata endpoint and Open WebUI instances by hand). Search fills in as the index rebuilds; thumbnails return as they are made.
- **Checked before any write:** the manifest says `haevn-backup` and a version this CLI reads; the extension's archive schema is not older than the backup's; every file's size and SHA-256 match `index.jsonl`. A damaged backup is exit 1 with nothing written, and the line names the files.
- **No terminal, no `--yes`: exit 1**, naming `--dry-run` and `--yes`. `--dry-run` needs no consent.
- **The exit code:** `0` done. `75` not now: no extension within `--wait`, the extension busy (another operation holds its lock, or a restore is open), or the connection lost and not back. `1` failed, one line on stderr: a damaged or unknown backup, an older extension, no consent, a wrong key, a chat the extension refused.
- **An interrupted restore** leaves every chat restored or as it was. The line says so: run the same command again to finish it. Transfers that did not get through are tried again twice; `BUSY`, `BAD_REQUEST` and `NO_SESSION` never are. If every chat is in but the search index could not be brought up to date, the run exits 1 and says so: search may miss chats until it is rebuilt (`haevnDebug.rebuildIndex()` in the archive page's console, or run the same command again, which replaces the chats again with the backup's copy).
- It takes the extension's operation lock for the run, so a sync, an import or an export answers `BUSY` meanwhile. A check against the dev profile uses a scratch `HOME` and port, as for `backup`.
- `/pipe/in` carries the action in the `X-Haevn-Request` header, so every non-ASCII character of a chat id or media name is sent as `\uXXXX`.

---

## Common agent workflows

### Investigate a user-reported issue in a specific thread

```bash
haevn search "<error phrase>" --platform claude --limit 200
haevn get <chatId> -m <messageRef> -f markdown
```

### Compare branches in a heavily forked chat

```bash
haevn branches <chatId>
haevn get <chatId> -m <refA> -f json > /tmp/a.json
haevn get <chatId> -m <refB> -f json > /tmp/b.json
```

### Build scripts around results

```bash
haevn search "query" --format json | jq '.results[] | {chatId, messageRef, source, model, messageSnippet}'
```

---

## Practical guidance for agents

- Start broad with `list`/`search`, then narrow with `branches` and `get -m`.
- Prefer short refs in user communication; raw IDs are too noisy.
- Keep `get --include-media` off unless required (smaller payloads, faster runs); `export` never embeds media.
- For automations and scripts, prefer `--format json` + `jq`.
