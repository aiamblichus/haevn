# @haevn/cli

CLI tool for searching and accessing HAEVN chat archives from the terminal.

## Installation

### From npm (recommended)

```bash
# npm
npm install --global @haevn/cli

# pnpm
pnpm add --global @haevn/cli

# yarn
yarn global add @haevn/cli
```

Or run without installing globally:

```bash
npx @haevn/cli --help
```

### From source (development)

```bash
# From the cli directory
pnpm install
pnpm build

# Link globally for development
pnpm link --global
```

## Commands

### `search` - Search for messages

```bash
haevn search "react hooks"
haevn search "useEffect" --platform claude --limit 10
haevn search "api design" --after 2024-01-01 --format json
```

Options:
- `-p, --platform <name>` - Filter by platform (claude, chatgpt, gemini, etc.)
- `-l, --limit <n>` - Max chats to return (default: 20), with at most 4 matching messages from each. `--platform`, `--category`, `--after` and `--before` narrow the chats first, so the limit counts the chats that pass them. When more chats matched, the text output ends with a line saying so and the JSON has `"hasMore": true`
- `-c, --context <chars>` - Context on each side of a match (default: 120); a result shows up to three such passages when matches are far apart
- `-f, --format <fmt>` - Output format (text, json)
- `--no-metadata` - Skip chat metadata in output (default includes metadata)
- `--after <date>` - Only messages after date (YYYY-MM-DD)
- `--before <date>` - Only messages before date

While the extension rebuilds its search index (after a bulk sync, or an import of more than 20 chats, including `haevn import`), `search` exits 1 with "Search index is rebuilding (N%). Try again shortly." rather than returning no results.

#### Search Syntax

HAEVN search is **term-based by default**.

- `haevn search "you may not recognize me"` is a multi-term query (not exact phrase mode).
- For exact phrase matching, use inner quotes:

```bash
haevn search '"you may not recognize me"'
```

When you run an unquoted multi-word query, CLI text output shows a tip, and JSON output includes a top-level `hint` field.

HAEVN reads these operators itself (it does not pass the query to the search index as typed). Nothing else is syntax: a colon, a plus sign or a bracket is a character like the others. A hyphen splits a word the way a space does, so `local-first` and `local first` find the same chats, and `c++ templates` is the words `c` and `templates`.

| Operator | Example | Description |
|----------|---------|-------------|
| (none) | `term1 term2` | Multi-term query (default term matching) |
| `"..."` | `"exact phrase"` | Phrase must appear consecutively |
| `-` | `-exclude` | Word must NOT be present. A phrase cannot be left out: `-"a phrase"` exits 1 with the reason |
| `*` | `react*` | Prefix at the end of a word: matches `react`, `reactive`, etc. A star inside a word splits it, like a hyphen |
| `~` | `roam~2` | Fuzzy match with edit distance 1 or 2 (a larger number counts as 2) |
| `^` | `api^10` | Accepted and ignored: a term has no weight of its own. The word is searched as if `^10` were not there |

**Examples:**

```bash
# Multi-word term search (NOT exact phrase)
haevn search "you may not recognize me"

# Exact phrase (shell-safe form)
haevn search '"machine learning"'

# Exclude unwanted terms
haevn search "react hooks -class"

# Fuzzy matching (catches typos)
haevn search "kubernates~2"

# Prefix/wildcard
haevn search "async* await*"
```

If a strict AND query returns no results, HAEVN automatically retries with relaxed prefix matching (OR semantics) on the words that say something: stop words such as `how` or `should` are left out of the retry.

A query with nothing to look for (only words to leave out, no words at all, or a phrase typed to be left out) exits 1 with the reason instead of printing no results.

### `get` - Fetch a chat branch

```bash
# Get primary branch (markdown)
haevn get chat_abc123

# Get specific branch containing a message
haevn get chat_abc123 --message msg_xyz789
# Or use short message ref shown by `haevn branches` / `haevn search`
haevn get chat_abc123 --message a1b2c3d4e5f6

# Output as JSON
haevn get chat_abc123 -f json

# Include full thinking blocks
haevn get chat_abc123 --include-thinking

# Skip system instructions in output
haevn get chat_abc123 --skip-system

# Write to file
haevn get chat_abc123 -o ./chat.md
```

Options:
- `-m, --message <ref|id>` - Get branch containing this message (short ref or full ID)
- `-f, --format <fmt>` - Output format (markdown, json)
- `-o, --output <file>` - Write to file
- `--include-metadata` - Include timestamps/model info (default: true)
- `--include-media` - Include image descriptions/links (default: false)
- `--include-thinking` - Include full thinking blocks (default: false, otherwise truncated preview)
- `--skip-system` - Skip system instructions in output (default: false)

### `list` - Browse chats

```bash
haevn list
haevn list --platform claude --limit 50
haevn list --sort title --format json
haevn list --limit 50 --offset 50 --format json
```

Options:
- `-p, --platform <name>` - Filter by platform
- `-l, --limit <n>` - Max results (default: 20)
- `--offset <n>` - Skip the first n chats, to read the next page (default: 0)
- `--sort <field>` - Sort by (lastSynced, title, messageCount)
- `-f, --format <fmt>` - Output format (text, json)
- `--after <date>` - Only chats after date

To read every chat, page with `--offset`. The JSON output has `hasMore`, which is true while chats follow the page; the next page starts at `--offset` plus `--limit`. `--after` filters the chats of each page, so a page can hold fewer than `--limit` chats while `hasMore` is still true.

### `branches` - Show tree structure

```bash
haevn branches chat_abc123
haevn branches chat_abc123 --format json
```

Options:
- `-f, --format <fmt>` - Output format (tree, json)
- `--show-ids` - Include raw message IDs (tree always shows short refs)

### `info` - View or edit chat metadata

```bash
# View current metadata
haevn info <chatId>

# Set title, description, synopsis
haevn info <chatId> --title "My Title"
haevn info <chatId> --description "A short summary"
haevn info <chatId> --synopsis "A paragraph-length overview"

# Set keywords and categories (comma-separated)
haevn info <chatId> --keywords "typescript,react,hooks"
haevn info <chatId> --categories "Coding,DevTools Automation"

# Trigger AI generation for this chat (requires AI config in Settings)
haevn info <chatId> --generate

# Output as JSON
haevn info <chatId> --format json
```

Options:
- `--title <text>` - Set the metadata title
- `-d, --description <text>` - Set the description
- `-s, --synopsis <text>` - Set the synopsis
- `-k, --keywords <list>` - Set keywords (comma-separated)
- `--categories <list>` - Set categories (comma-separated)
- `-g, --generate` - AI-generate metadata (requires AI config in Settings)
- `-f, --format <fmt>` - Output format (text, json)

### `export` - Export a single chat via extension exporters

```bash
# Canonical JSON (default)
haevn export chat_abc123 -o ./backup.json
haevn export chat_abc123 -o ./backup.json --format haevn_json

# Markdown transcript (the current branch)
haevn export chat_abc123 -o ./chat.md --format haevn_markdown

# Markdown transcript with every branch: the current branch, then each alternative as a section
haevn export chat_abc123 -o ./chat-all.md --format haevn_markdown --all-branches

# Pi session JSONL
haevn export chat_abc123 -o ./.pi/sessions/chat.jsonl --format pi_session_jsonl
```

Options:
- `-o, --output <file>` - Output file path (required)
- `-f, --format <fmt>` - Export format (`haevn_json`, `haevn_markdown`, `pi_session_jsonl`)
- `--all-branches` - Markdown only: also write the branches off the current one, each under a `## Branch N: at message M` heading (default: the current branch only). A file written with `--all-branches` is for reading; the Markdown importer refuses it

Notes:
- Markdown writes the path from the first message to the chat's current message. Its frontmatter says `branch: current` and, when the chat has other branches, `other_branches_omitted: N`. JSON keeps the whole tree.
- CLI export is intentionally **single-chat** and **no-assets** (to keep daemon requests predictable).
- Formatting is produced by the extension exporter pipeline (single source of truth), not reimplemented in CLI.

### `health` - Check that the web providers still sync

```bash
haevn health                     # every web provider you are signed in to
haevn health -p claude,chatgpt   # only these
haevn health -n 3 --timeout 60   # three chats each, 60 s per provider
haevn health -f json             # the report as JSON
```

The extension opens a tab on each provider's site (in your own Chrome), lists the chats, fetches the first few, converts them as a sync does, and checks them: messages present, turns in order, no empty text, sane dates, a tree that leads to the current message. **Your archive is never changed** (nothing is saved, no media is stored, nothing is indexed) and the report holds **no chat text, titles or ids**. Two things still happen, as when you browse the site: for ChatGPT, the images of the chats it fetches are loaded into memory and discarded, and loading a provider's tab can refresh the sign-in details HAEVN already keeps for that site.

Options:
- `-p, --provider <list>` - Comma-separated provider names (default: every web provider)
- `-n, --chats <n>` - Chats to check per provider, from the head of its list (default 2, at most 5)
- `--timeout <s>` - Seconds to give one provider (default 40, 5 to 120). A large account can spend the 40 s listing its chats (the row says `TIMEOUT`, `listing the chats`): run that provider alone, `haevn health -p chatgpt --timeout 120`
- `-f, --format <fmt>` - Output format (text, json)

Notes:
- A row is `ok`, `warn`, `fail`, `not signed in`, `unreachable`, `timeout` or `skipped`. A provider that is not signed in, unreachable or skipped was **not checked**; the last line counts them. A provider you know you are signed in to that shows `not signed in` is a failure of the check or of the stored sign-in details, not a pass: read its note.
- Claude, ChatGPT and Gemini are checked first, so a run that runs out of time (4 minutes in all, 40 s a provider) skips the others, never these.
- Exit code 1 when a provider failed or timed out, or when Claude, ChatGPT or Gemini was skipped because the run ran out of time; 0 otherwise.
- The run takes seconds to minutes and refuses to start while a sync, import or export holds the extension's operation lock.
- The same operation runs from the extension: `haevnDebug.providerHealth()` on the Options page.

### `backup` - Back up the whole archive into a directory

```bash
haevn backup ~/backups/haevn            # the archive, into that directory
haevn backup ~/backups/haevn --wait 120 # give Chrome two minutes to connect
```

Every live chat becomes one JSON-lines file and every media file is copied as it is stored in the extension, so the directory holds the archive in full (chats, messages, media, AI metadata and embeddings; **not** settings or API keys, and not chats you have deleted):

```
<dir>/
  manifest.json        written last: its presence means the backup is complete
  index.jsonl          one line per chat: id, source, file, size, SHA-256, and its media files
  chats/<name>.jsonl   line 1 is the chat row with its metadata and embedding, then one line per message row
  media/<name>/<file>  the files of the chat's media folder, byte for byte
```

A run writes into `<dir>.partial` and swaps it for `<dir>` only when every file has arrived and its size matches what the extension said, so a failed run leaves the previous backup as it was and no `.partial` behind. One chat or file that cannot be read fails the whole run; a chat that you delete while the run is going is left out and listed in the manifest's `vanished`. A transfer that did not get through (a cut stream, a timeout) is tried again twice before it counts.

It needs Chrome open with the HAEVN extension and its CLI bridge on, and the API key saved in `~/.haevn/config.json` (as for `haevn daemon`). It starts its own daemon when none is listening on the port, and stops it when it is done; a daemon that is already running is used as it is (it must be one of this CLI's version: restart it after an upgrade).

Options:
- `--wait <s>` - Seconds to wait for the extension to connect, or to come back after the connection was lost (default 60)

Exit code, for a scheduled job:

| Code | Meaning |
| --- | --- |
| 0 | Done: `<dir>` is complete |
| 75 | Not now, ask again later: no extension connected within `--wait` (Chrome closed or the bridge off); the connection was lost and did not return within `--wait`; the extension is busy (a restore is running); another `haevn backup` holds `<dir>.partial` |
| 1 | Failed: anything else, such as a wrong API key, an extension or daemon that is too old, a disk error, or a chat or file that could not be read. One line on stderr says which |

`<dir>` must be empty, missing, or a previous backup: a directory that holds anything else is not replaced. A run that gets SIGINT or SIGTERM removes its `.partial` before it exits; one that is killed outright leaves it behind, and the next run removes it.

### `daemon` - Start the local daemon

```bash
haevn daemon --api-key <key>
haevn daemon --api-key <key> --port 5517
```

Options:
- `-k, --api-key <key>` - API key from HAEVN extension settings
- `-p, --port <n>` - Port (default: 5517)

### `import` - Import transcript artifacts

```bash
# Import one Claude Code session JSONL
haevn import --format claude_code ~/.claude/projects/my-proj/session.jsonl

# Import one Codex session JSONL
haevn import --format codex ~/.codex/sessions/2026/03/23/rollout-2026-03-23T14-28-14-019d1ae1-bc2d-7d90-9834-6664505e81e8.jsonl

# Import one PI session JSONL
haevn import --format pi ~/.pi/sessions/2026-03-23T14-48-43-844Z_02c5dec9-40a7-4a9c-9856-417044063a6f.jsonl

# Import an OpenRouter chatroom export: one file, one chat per chatroom
haevn import --format openrouter ./open-router-chats.json

# Import multiple files in one run
haevn import --format claude_code ./sessions/*.jsonl

# Skip existing chat IDs, don't overwrite
haevn import --format claude_code --no-overwrite ./sessions/*.jsonl

# Save without indexing for search
haevn import --format claude_code --skip-index ./sessions/*.jsonl
```

Options:
- `--format <fmt>` - Input format (`claude_code`, `codex`, `pi`, `openrouter`, `haevn_json`, `markdown`, `image`, `video`)
- `--no-overwrite` - Skip chats that already exist (default: overwrite existing IDs)
- `--skip-index` - Save the chats without indexing them for search; they are not searchable until the extension next rebuilds its index (default: index them as they are saved; more than 20 files rebuild the index once at the end)

Notes:
- If the chats are saved but the extension cannot bring its search index up to date, `haevn import` prints `index=failed (reason)` and exits 1; the chats are in the archive and the next rebuild of the search index picks them up.
- An import takes the extension's operation lock. While a bulk sync, another import or a bulk export runs, `haevn import` exits 1 with "Another operation is running"; run it again when that ends.
- `claude_code`, `codex`, `pi`, and `openrouter` are import-only providers (no live sync).
- An OpenRouter export file holds many chatrooms and gives one chat each, named after the chatroom's first message, so importing the same export again replaces the chats instead of duplicating them. `processed` and `total` count chats, not files. A file with no chat (every chatroom empty) prints "No chats found in the input" and exits 1.
- Codex reasoning blocks are encrypted in source logs and are skipped during import.

## Setup

1. Open HAEVN extension Settings and copy your CLI API key.
2. In a terminal, start daemon:
   ```bash
   haevn daemon --api-key <your-key>
   ```
3. In another terminal, run CLI commands:
   ```bash
   haevn list -l 5
   ```

## Output Formats

### Text (default)

Human-readable output with colors and formatting:

```
━━━ 68937df7-e198-8325-973e-ed9528104e0c  "Emergence and consciousness research"
  ┌─ [d571468ee884]
  │ ...Emergence and consciousness research...
  └─ user · chatgpt · Aug 6, 2025, 06:08 PM
```

### JSON

Structured output for piping to other tools:

```bash
haevn search "query" --format json | jq '.results[0].messageRef'
```

## Development

```bash
pnpm install
pnpm build        # Build to dist/
pnpm dev          # Watch mode
pnpm start        # Run CLI
pnpm typecheck    # Type-check CLI
pnpm lint         # Check code
```

## Publishing (maintainers)

### Automated (recommended)

From repo root:

```bash
pnpm run cli:release:patch
# or: cli:release:minor / cli:release:major
```

This bumps `cli/package.json`, creates a `cli-vX.Y.Z` tag, and pushes it.
GitHub Actions workflow `.github/workflows/publish-cli.yml` then publishes to npm.

### Manual

```bash
cd cli
pnpm install
pnpm run build
npm publish
```

Notes:
- Package name: `@haevn/cli`
- Access: public (configured via `publishConfig.access`)
- `prepublishOnly` runs build + typecheck automatically
- CI publish requires repo secret `NPM_TOKEN`

## Architecture

```
cli/
├── src/
│   ├── index.ts          # Entry point (citty)
│   ├── commands/         # CLI commands
│   │   ├── search.ts
│   │   ├── get.ts
│   │   ├── list.ts
│   │   ├── branches.ts
│   │   ├── info.ts
│   │   ├── export.ts
│   │   ├── import.ts
│   │   └── daemon.ts
│   ├── daemon/           # Daemon client and config
│   │   ├── client.ts
│   │   ├── server.ts
│   │   └── config.ts
│   ├── formatters/       # Output formatting
│   │   ├── markdown.ts
│   │   └── json.ts
│   └── utils/            # Utilities
│       ├── tree.ts       # Branch traversal
│       ├── messageRefs.ts
│       └── output.ts     # Pretty printing
└── package.json
```
