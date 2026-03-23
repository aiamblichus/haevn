# @haevn/cli

CLI tool for searching and accessing HAEVN chat archives from the terminal.

## Installation

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
- `-l, --limit <n>` - Max results (default: 20)
- `-c, --context <chars>` - Context around match (default: 120)
- `-f, --format <fmt>` - Output format (text, json)
- `--after <date>` - Only chats after date (YYYY-MM-DD)
- `--before <date>` - Only chats before date

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

# Write to file
haevn get chat_abc123 -o ./chat.md
```

Options:
- `-m, --message <ref|id>` - Get branch containing this message (short ref or full ID)
- `-f, --format <fmt>` - Output format (markdown, json)
- `-o, --output <file>` - Write to file
- `--include-metadata` - Include timestamps/model info (default: true)
- `--include-media` - Include image descriptions/links (default: false)

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

### `export` - Export full chat

```bash
haevn export chat_abc123 -o ./backup.json
haevn export chat_abc123 -o ./backup.json --include-media
```

Options:
- `-o, --output <file>` - Output file path (required)
- `--include-media` - Embed base64 media (default: false)

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

# Import multiple files in one run
haevn import --format claude_code ./sessions/*.jsonl

# Skip existing chat IDs, don't overwrite
haevn import --format claude_code --no-overwrite ./sessions/*.jsonl

# Skip index rebuild after import
haevn import --format claude_code --skip-index ./sessions/*.jsonl
```

Options:
- `--format <fmt>` - Input format (`claude_code`, `codex`)
- `--no-overwrite` - Skip chats that already exist (default: overwrite existing IDs)
- `--skip-index` - Skip search indexing after import (default: rebuild index at end)

Notes:
- `claude_code` and `codex` are import-only providers (no live sync).
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
