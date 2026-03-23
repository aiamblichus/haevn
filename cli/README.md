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
- `-c, --context <chars>` - Context around match (default: 150)
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

### `install` - Set up native messaging

```bash
haevn install -e <chrome-extension-id>
```

Options:
- `-e, --extension-id <id>` - Chrome extension ID (required)
- `-b, --browser <name>` - Browser (chrome, chromium, edge)

## Data Sources

### Phase 1: File-based

```bash
haevn -F ./archive.json search "query"
```

Works with exported HAEVN JSON files.

### Phase 2: Native Messaging

After running `haevn install`, the CLI communicates directly with the extension:

```bash
# One-time setup
haevn install -e abcdefghijklmnopqrstuvwxyz

# Then use normally (reads from extension's IndexedDB)
haevn search "query"
```

## Output Formats

### Text (default)

Human-readable output with colors and formatting:

```
━━━ chat_abc123 ━━━ "React Hooks Deep Dive"
┌─ msg_m4k9x ────────────────────────────────────┐
│ The key insight with useEffect is that it...  │
│                    ↑ match: "useEffect"       │
└───────────────────────────────────────────────┘
  Claude • 2h ago • branch: root→a3→m4k9x
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
│   │   └── export.ts
│   ├── native/           # Native messaging
│   │   ├── host.ts       # Host mode handler
│   │   ├── install.ts    # Install command
│   │   └── protocol.ts   # Chrome protocol
│   ├── formatters/       # Output formatting
│   │   ├── markdown.ts
│   │   └── json.ts
│   └── utils/            # Utilities
│       ├── tree.ts       # Branch traversal
│       └── output.ts     # Pretty printing
└── package.json
```

## Native Messaging Flow

```
┌─────────────────┐                      ┌─────────────────┐
│  HAEVN          │  sendNativeMessage   │  haevn CLI      │
│  Extension      │ ────────────────────►│  (native host)  │
│  (IndexedDB)    │                      │                 │
│                 │◄──────────────────── │                 │
└─────────────────┘   JSON response      └─────────────────┘
```

1. Extension calls `chrome.runtime.sendNativeMessage('com.haevn.cli', request)`
2. Chrome launches CLI with `--native-host` flag
3. CLI reads request from stdin (length-prefixed JSON)
4. CLI queries extension's IndexedDB
5. CLI writes response to stdout
6. Extension receives response via callback
