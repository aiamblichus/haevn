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

A chat that has only a rough date (a fragment dated `2024` or `~2024-03`, or one with no date) has no time for its messages. Its hits show the date as it was given, or `undated`, where the time would be, and `--format json` gives `dateLabel` and no `messageTimestamp` for them. A script that reads `messageTimestamp` gets nothing for such a chat.

While the extension rebuilds its search index (after a bulk sync, or an import of more than 20 chats, including `haevn import`), `search` exits 1 with "Search index is rebuilding (N%). Try again shortly." rather than returning no results.

#### Search Syntax

HAEVN search is **term-based by default**.

- `haevn search "you may not recognize me"` is a multi-term query (not exact phrase mode).
- For exact phrase matching, use inner quotes:

```bash
haevn search '"you may not recognize me"'
```

When you run an unquoted multi-word query, CLI text output shows a tip, and JSON output includes a top-level `hint` field.

HAEVN reads these operators itself (it does not pass the query to the search index as typed). Nothing else is syntax, except `model:` and `tag:` below: a colon, a plus sign or a bracket is a character like the others. A hyphen splits a word the way a space does, so `local-first` and `local first` find the same chats, and `c++ templates` is the words `c` and `templates`.

| Operator | Example | Description |
|----------|---------|-------------|
| (none) | `term1 term2` | Multi-term query (default term matching) |
| `"..."` | `"exact phrase"` | Phrase must appear consecutively |
| `-` | `-exclude` | Word must NOT be present. A phrase cannot be left out: `-"a phrase"` exits 1 with the reason |
| `*` | `react*` | Prefix at the end of a word: matches `react`, `reactive`, etc. A star inside a word splits it, like a hyphen |
| `~` | `roam~2` | Fuzzy match with edit distance 1 or 2 (a larger number counts as 2) |
| `^` | `api^10` | Accepted and ignored: a term has no weight of its own. The word is searched as if `^10` were not there |
| `model:` | `model:gpt-4o` | The chat has a model with these words. `model:sonnet` finds `claude-3-5-sonnet`; the words of `model:gpt-4` must be next to each other, in that order, so it finds `gpt-4` and not `gpt-4o` (write `model:gpt-4*` for both) |
| `tag:` | `tag:poetry`, `tag:"creative writing"` | The chat has a tag with these words. `-tag:draft` leaves out the chats that have it |

A plain word, and `-word`, are about what was said: they never look at a chat's models or tags (`haevn search poetry` does not find a chat only because it is tagged `poetry`, and `python -claude` does not drop the chats whose model is called `Claude`). Only `model:` and `tag:` look at the labels, and `-model:` and `-tag:` leave chats out by them. A hit on a label is shown as `model` or `tag` instead of a message. In JSON it has `label` set (`"model"` or `"tag"`) and no `messageRef`: its `messageId` is a name the index makes up (`haevn:model`, `haevn:tag`), not a message of the chat, so do not pass it to `haevn get`. A chat's models are the ones it names, the ones its messages name and the ones its replies name; its tags are the ones its provider or its file gave it. A chat has at most 50 models and 50 tags in the index (the first 50 of each); a later one is not found by `model:` or `tag:`.

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

# By the model or the tag of a chat
haevn search "model:claude-sonnet-4*"
haevn search "tag:poetry sunset"
```

If a strict AND query returns no results, HAEVN automatically retries with relaxed prefix matching (OR semantics) on the words that say something: stop words such as `how` or `should` are left out of the retry.

A query with nothing to look for (only words to leave out, no words at all, or a phrase typed to be left out) exits 1 with the reason instead of printing no results.

### `get` - Fetch a chat branch, or the whole chat

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

# Every branch in one file, with its media
haevn get chat_abc123 --all-branches --include-media -o ./chat.md
```

Options:
- `-m, --message <ref|id>` - Get branch containing this message (short ref or full ID)
- `--all-branches` - Get the whole chat, every branch once, instead of one branch (see below; not with `-m`, `--head` or `--tail`, which pick one branch and are refused)
- `-f, --format <fmt>` - Output format (markdown, json)
- `-o, --output <file>` - Write to file
- `--include-metadata` - Include timestamps/model info (default: true). For a chat with a rough date, the header gives its label (`c. Mar 2024`, `undated`) in place of a time
- `--include-media` - Save the images, videos, audio and files of what is shown (see below; default: false)
- `--include-thinking` - Include full thinking blocks (default: false, otherwise truncated preview)
- `--skip-system` - Skip system instructions in output (default: false)

Media. Without `--include-media`, an image, video, audio clip or file shows as `[image]`, `[video]`, `[audio]` or `[file]`. With it:

- Markdown with `-o chat.md`: each file is written to `chat-media/NN.<ext>` beside the output, numbered in message order (`01.png`, `02.mp4`, ...; the extension comes from the media type, `.bin` when it is unknown), and the Markdown links it where the stand-in was: `![image](chat-media/01.png)` for an image, `[video](chat-media/02.mp4)` for the rest. A medium the archive holds only as a web link is linked and not downloaded. If `chat-media` already exists the command stops before it writes anything (move it, or write to another file); it never mixes files with an earlier run's. A file that cannot be fetched keeps its stand-in, is named on stderr, and the command exits 1 after it writes the rest.
- Markdown on the terminal: no file is written. The stand-ins stay, with one note on stderr to add `-o FILE`.
- JSON: each message that has media gets a `media` array, one object per item: `kind`, `mediaType`, `name` (when the archive has one), and either `bytes` and `data` (the file as base64) or `url` (a link, nothing downloaded). An item over 32 MiB, or one that takes the media past 128 MiB in all, has `error` instead of `data` and the command exits 1; save such media as Markdown with `-o`.

With `--all-branches`, the media of every branch go in the one `chat-media` folder, numbered in the order the Markdown shows the messages (the trunk's first, then each branch whole). The rest is as above: the folder must be new, a file that cannot be fetched leaves no gap in the numbers, and without `-o` no file is written.

`export` and `branches` do not carry media.

**Every branch.** A chat that was edited or regenerated is a tree. `get` writes one branch of it; `--all-branches` writes all of it, each message once:

- Markdown: the trunk (the messages every branch shares), then at each fork one section per branch, in the order `haevn branches` lists them, headed `### Branch 2 of 3`. The branch that holds the chat's current message says `(current)`. A fork inside a branch numbers its own branches under it (`### Branch 2.1 of 2`), so every heading stays at one level and the messages stay `##`. Several roots (alternative beginnings) are the first branches, oldest first. A branch that holds only tool calls and results says so under its heading. `export --all-branches` writes the other shape on purpose for now: flat sections, `## Branch N: at message M`, the current branch first. The two are not the same document.
- JSON: the tree as stored. Top level: `chatId`, `title`, `platform`, `timestamp`, `system`, `currentRef` (`null` when the chat's current message is not in it), `branchCount`, `messageCount`, and `messages`, a list in reading order. For a chat with a rough date, `dateLabel` (`c. Mar 2024`, `undated`) takes the place of `timestamp` at the top and on each message, since its stored times are made up. Each message has what a branch's messages have (`ref`, `role`, `content`, `timestamp`, and `media` with `--include-media`) and `parentRef` (`null` for a root) and `childRefs`, in the order the chat stores them. The refs are the short refs `haevn branches` shows, so `get -m` takes them. Tool calls and results are listed here, so the links stay whole; with `--skip-system`, a skipped system message is not listed and the links to it stay.
- Tool calls and tool results (ChatGPT's `browser` and `python` returns and the like) are not conversation, so the Markdown leaves them out, as it does for one branch.

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

A message that holds only a tool call or a tool result (ChatGPT stores a tool's output as a message of its own) is listed as a `[tool]` row with `[tool call]` or `[tool result]` where its text would be, so a row is never blank. In the JSON, its `role` is as stored, its `preview` is the stand-in, and `isTool` is `true` (a script should test `isTool`, not the text).

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
- `--timeout <s>` - Seconds to give one provider (default 40, or 120 for Gemini and AI Studio, which open each chat's page; 5 to 120). A large account can spend its limit listing its chats (the row says `TIMEOUT`, `listing the chats`): run that provider alone, `haevn health -p chatgpt --timeout 120`
- `-f, --format <fmt>` - Output format (text, json)

Notes:
- A row is `ok`, `warn`, `fail`, `not signed in`, `unreachable`, `timeout` or `skipped`. A provider that is not signed in, unreachable or skipped was **not checked**; the last line counts them. A provider you know you are signed in to that shows `not signed in` is a failure of the check or of the stored sign-in details, not a pass: read its note.
- Claude, ChatGPT and Gemini are checked first, so a run that runs out of time (4 minutes in all, 40 s a provider or 120 s for Gemini and AI Studio) skips the others, never these.
- Exit code 1 when a provider failed or timed out, or when Claude, ChatGPT or Gemini was skipped because the run ran out of time; 0 otherwise.
- The run takes seconds to minutes and refuses to start while a sync, import or export holds the extension's operation lock.
- The same operation runs from the extension: `haevnDebug.providerHealth()` on the Options page.

### `logs` - Read the extension's log

```bash
haevn logs -n 200 --level warn                 # the newest WARN and ERROR entries
haevn logs --context background --match sync   # the service worker's entries that mention sync
haevn logs -f json                             # the entries as the extension holds them
```

Reads the extension's log buffer, the service worker's recent entries, through the daemon: the same entries as `haevnDebug.getLogs()` on the Options page, for an agent that cannot reach that page. The text output is one line per entry, `timestamp level context message`, oldest first.

Options:
- `-n, --limit <n>` - The newest entries to show, 1 to 1000 (default 200)
- `--level <level>` - Only entries at this level and above: `debug` (every entry), `info`, `warn` or `error`. `--level warn` gives WARN and ERROR, and leaves out INFO and DEBUG
- `--context <name>` - Only entries logged in this context, by exact name (`background`, `popup`, `offscreen`, `content-tab-<id>`)
- `--match <text>` - Only entries whose message, context or data contains the text (any case)
- `-f, --format <fmt>` - Output format (text, json); json gives each entry whole, with its data and stack

Notes:
- **No chat content.** A line names a chat by its id and a provider by its name, and gives sizes and counts instead of chat text, titles, search queries, file names or prompts. A provider's own short error message can still appear, so glance at the output before it goes into a ticket.
- The buffer keeps the last 1000 entries by default, so an older sync may have scrolled out of it.
- Exit code 1 when the daemon or the extension fails; 0 otherwise, also when nothing matches.

### `backup` - Back up the whole archive into a directory

```bash
haevn backup ~/backups/haevn            # the archive, into that directory
haevn backup ~/backups/haevn --wait 120 # give Chrome two minutes to connect
```

Every live chat becomes one JSON-lines file and every media file is copied as it is stored in the extension, so the directory holds the archive in full (chats, messages, media, AI metadata and embeddings; **not** settings or API keys, and not chats you have deleted). The directory is your conversations in plain text. haevn sends it nowhere; put it where you would put the conversations themselves.

The layout:

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
  There is no limit on the whole run: a connection that keeps dropping can cost up to `--wait` each time, so a scheduled job should be bounded by its runner's own time limit. A run that gets SIGTERM ends cleanly.

Exit code, for a scheduled job:

| Code | Meaning |
| --- | --- |
| 0 | Done: `<dir>` is complete |
| 75 | Not now, ask again later: no extension connected within `--wait` (Chrome closed or the bridge off); the connection was lost and did not return within `--wait`; the extension is busy (a restore is running); a restore began while the run was reading, so the run was discarded and `<dir>` is as it was (run it again); another `haevn backup` holds `<dir>.partial` |
| 1 | Failed: anything else, such as a wrong API key, an extension or daemon that is too old, a disk error, or a chat or file that could not be read. One line on stderr says which. A wrong key is told apart from "nobody came" only when `--wait` ends with no extension connected, so it costs the full wait |

`<dir>` must be empty, missing, or a previous backup, and not a symbolic link: a directory that holds anything else is refused (exit 1), and so are a `<dir>.old` or `<dir>.partial` that is not part of a haevn backup. Only files a backup writes are ever removed. A run that gets SIGINT or SIGTERM removes its `.partial` before it exits; one that is killed outright leaves it behind, and the next run removes it. A `.partial` whose `backup.pid` names a live process younger than 2 hours means another run is writing (exit 75); a run that lasts longer than 2 hours is treated as dead. Files are flushed with `fsync`, which on macOS does not force the disk's own cache: do not count on a backup surviving a power cut while it is being written; the next run makes a new one.

### `restore` - Put a backup back into the archive

```bash
haevn restore ~/backups/haevn --dry-run      # see what it would do
haevn restore ~/backups/haevn                # asks before it changes anything
haevn restore ~/backups/haevn --chat <id>    # bring back one chat
```

Restore puts the chats of a `haevn backup` directory back into the HAEVN of the Chrome this terminal is connected to. Every chat in the backup goes back to exactly how it was when the backup was taken: its messages and branches, its media, its AI title, description and category, its embedding, even the date it was last synced. Chats that are not in your archive (new to this browser, or deleted since the backup) are added, so **chats you deleted after the backup come back**. Chats that are not in the backup are left alone, and restore never deletes anything. Its three rules, and nothing else: a chat or media file whose id exists is replaced by the backup's copy; what is missing is added; nothing else is touched (the one other write is the derived chat count of each provider it touched).

**On an archive you are still using, a full restore rolls back.** A chat that is in both is replaced by the backup's older copy, and what it gained since (new messages, a title you corrected, new metadata) is lost. A web chat can be synced again; a Claude Code, Codex or Pi session whose file you no longer have cannot. To get one chat back, use `--chat`. Always look at `--dry-run` first: it says how many chats would be replaced and how many added.

**On a new machine:** install the extension, open the archive page, switch on the CLI bridge and copy its API key into `~/.haevn/config.json` (Settings, CLI bridge), then run `haevn restore`. Your settings and keys are not in a backup: set the metadata endpoint, Open WebUI instances and the rest again by hand. Search fills in as the index is rebuilt after the restore; thumbnails come back as they are made.

An interrupted restore leaves every chat either restored or as it was; run the same command again to finish it.

Before it writes anything it checks the backup: the manifest must say `haevn-backup` and a version this CLI reads, the extension's archive must not be older than the backup's, and every file's size and SHA-256 must match `index.jsonl`. A damaged backup is refused (exit 1) with nothing written, and the message names the files. Then it shows what it will do and asks:

```
Restore from /restored/haevn/archive
  backup taken 2026-11-23 03:00, 2,812 chats, 1.7 GB (haevn 1.9.0)

  1,204  chats are in your archive now: each is replaced by the backup's copy.
         37 of them were synced again since the backup.
         Anything that changed since the backup (new messages, edited titles,
         new AI metadata) is lost from these chats.
  1,608  chats are not in your archive now (new here, or deleted since the
         backup): each is added back.

  Chats that are not in the backup are not touched. Nothing is deleted.

Restore 2,812 chats into the haevn connected to this terminal? [y/N]
```

The rollback paragraph appears only when something would be replaced. A chat counts as "in your archive now" when it is live there, so a chat you deleted counts as added. "Changed since the backup" compares the chat's last-synced time with the backup's, so an edit that does not change it (a title you corrected by hand) is not counted, though it is still lost. The answer is no unless it is `y` or `yes`.

Options:
- `--chat <id>` - Restore only this chat; repeat the flag for more. An id the backup does not hold is refused before anything is written
- `--dry-run` - Check the backup and print the block above, without the question; writes nothing, exits 0. It still needs the extension, to know which chats are in the archive
- `--yes` - Do not ask. Required when there is no terminal: without it a restore that cannot ask exits 1 and names `--dry-run` and `--yes`
- `--wait <s>` - Seconds to wait for the extension to connect, or to come back after the connection was lost (default 60)

It needs Chrome open with the HAEVN extension and its CLI bridge on, and the API key saved in `~/.haevn/config.json`. It starts its own daemon when none is listening, as `backup` does. For each chat it sends the media files first and then the record; a transfer that did not get through is tried again twice before it counts. The extension holds its operation lock for the length of the run, so a sync, an import or an export waits.

Exit code:

| Code | Meaning |
| --- | --- |
| 0 | Done: every selected chat and media file is in the archive (with `--dry-run`: the backup is whole, nothing was written) |
| 75 | Not now, ask again later: no extension connected within `--wait`; the extension is busy (a sync, an import or another restore holds its lock); the connection was lost and did not return within `--wait` |
| 1 | Failed: anything else, such as a damaged or unknown backup, an extension older than the backup, no `--yes` without a terminal, an answer of no, a wrong API key, or a chat the extension refused. One line on stderr says which |

When a run ends after the extension had begun, whatever the code, the line says so: running the same command again finishes the restore.

If every chat is in but the extension could not bring its search index up to date, the run exits 1 and says so: search may miss chats until the index is rebuilt. Run `haevnDebug.rebuildIndex()` in the archive page's console, or run the same command again (it replaces the chats again with the backup's copy).

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

# Fragments: recovered chats, one .md file each (a folder is read flat). What would each file do?
haevn import --format fragment --dry-run ./recovered

# Fragments: give each file that has no id one (this changes your files), then import
haevn import --format fragment --assign-ids ./recovered

# Save without indexing for search
haevn import --format claude_code --skip-index ./sessions/*.jsonl
```

Options:
- `--format <fmt>` - Input format (`claude_code`, `codex`, `pi`, `openrouter`, `haevn_json`, `markdown`, `fragment`, `image`, `video`)
- `--dry-run` - `fragment` only: say what each file would do (its state, turns, date and warnings), write nothing. Any other format refuses it, so a dry run never imports
- `--assign-ids` - `fragment` only: write `id: <uuid>` into each file that has none, as the first line of its frontmatter (or a block holding only that line, in front of a file with none), and change nothing else; with `--dry-run` it changes no file and says which it would. This rewrites your files, so it is opt-in. An id goes only to a file the import would then accept, and a dry run decides the same: a file with an empty body or a bad date, a frontmatter that does not begin with a `key: value` line at the left margin, a read-only file, or a file saved while the command ran is left as it is, stays `no-id` in the plan, and says why. The file keeps its permissions. A symlink named on the command line is written through to its target; a symlink inside a folder is not read, and is counted
- `--no-overwrite` - Skip chats that already exist (default: overwrite existing IDs)
- `--skip-index` - Save the chats without indexing them for search; they are not searchable until the extension next rebuilds its index (default: index them as they are saved; more than 20 files rebuild the index once at the end)

Notes:
- If the chats are saved but the extension cannot bring its search index up to date, `haevn import` prints `index=failed (reason)` and exits 1; the chats are in the archive and the next rebuild of the search index picks them up.
- An import takes the extension's operation lock. While a bulk sync, another import or a bulk export runs, `haevn import` exits 1 with "Another operation is running"; run it again when that ends.
- `claude_code`, `codex`, `pi`, and `openrouter` are import-only providers (no live sync).
- An OpenRouter export file holds many chatrooms and gives one chat each, named after the chatroom's first message, so importing the same export again replaces the chats instead of duplicating them. `processed` and `total` count chats, not files. A file with no chat (every chatroom empty) prints "No chats found in the input" and exits 1.
- Codex reasoning blocks are encrypted in source logs and are skipped during import.
- `fragment` reads `.md` files with YAML frontmatter (the page is [Fragments](https://github.com/aiamblichus/haevn/blob/main/docs/src/content/docs/user-guide/fragments.mdx)). A directory is read flat: its `.md` files, no descent, dot-files skipped, and the other files are counted in one line; a file named outright that is not `.md` is refused. Every file gets one state in the plan (`new`, `changed`, `unchanged`, `same-file`, or refused: `no-id`, `bad-id`, `bad-date`, `unreadable`, `duplicate-id`); the last lines count the files by state and the warnings by kind. A refused file does not stop the others, and the exit status is 1 when any was refused, a chat failed to save, or the index could not be updated. A file that is `unchanged` writes nothing. A file that changed, or that declares `speakers.break` or `speakers.lead` and was stored by a reader that did not know them (the new form then reaches it with no edit), is `changed`: its chat is replaced under the same id, messages included, and the generated title and description are kept. Any other file stored by an older reader is `unchanged`. The dry run says which files would change.

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
haevn search "query" --format json | jq '[.results[] | select(.label | not)][0].messageRef'
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
