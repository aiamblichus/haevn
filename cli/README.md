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
- `-l, --limit <n>` - Max chats to scan (default: 20)
- `-c, --context <chars>` - Context around match (default: 120)
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

HAEVN uses **Lunr.js** query syntax with these operators:

| Operator | Example | Description |
|----------|---------|-------------|
| (none) | `term1 term2` | Multi-term query (default term matching) |
| `"..."` | `"exact phrase"` | Phrase must appear consecutively |
| `-` | `-exclude` | Term must NOT be present |
| `*` | `react*` | Prefix/wildcard — matches `react`, `reactive`, etc. |
| `~` | `roam~2` | Fuzzy match with edit distance 2 |
| `^` | `api^10` | Boost term relevance |

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

# Boost important terms
haevn search "api^5 design documentation"
```

If a strict AND query returns no results, HAEVN automatically retries with relaxed prefix matching (OR semantics).

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
```

Options:
- `-p, --platform <name>` - Filter by platform
- `-l, --limit <n>` - Max results (default: 20)
- `--sort <field>` - Sort by (lastSynced, title, messageCount)
- `-f, --format <fmt>` - Output format (text, json)
- `--after <date>` - Only chats after date

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

# Import multiple files in one run
haevn import --format claude_code ./sessions/*.jsonl

# Skip existing chat IDs, don't overwrite
haevn import --format claude_code --no-overwrite ./sessions/*.jsonl

# Save without indexing for search
haevn import --format claude_code --skip-index ./sessions/*.jsonl
```

Options:
- `--format <fmt>` - Input format (`claude_code`, `codex`, `pi`)
- `--no-overwrite` - Skip chats that already exist (default: overwrite existing IDs)
- `--skip-index` - Save the chats without indexing them for search; they are not searchable until the extension next rebuilds its index (default: index them as they are saved; more than 20 files rebuild the index once at the end)

Notes:
- An import takes the extension's operation lock. While a bulk sync, another import or a bulk export runs, `haevn import` exits 1 with "Another operation is running"; run it again when that ends.
- `claude_code`, `codex`, and `pi` are import-only providers (no live sync).
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
