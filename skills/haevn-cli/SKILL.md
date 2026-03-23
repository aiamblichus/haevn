---
name: haevn-cli
description: How to use the HAEVN CLI to search, inspect branches, and export chats efficiently
---

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
5. `export` for full chat backup.

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
```

Notes:

- List output includes `msgs` and `br` (branch count).
- `branched` badge flags chats with heavy branching.

---

## Happy path 2 — Search and inspect context

```bash
haevn search "model welfare inner experience"
haevn search "emergence" --platform claude --limit 100
haevn search "memory leak" --context 220
```

Useful flags:

- `--context` controls snippet window size.
- `--after` / `--before` constrain time.
- `--format json` for scripting pipelines.

```bash
haevn search "ai consciousness" --format json | jq '.results[0]'
```

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
haevn export <chatId> -o ./chat-with-media.json --include-media
```

Use export for archival fidelity; use `get` for readable branch extraction.

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
- Keep `--include-media` off unless required (smaller payloads, faster runs).
- For automations and scripts, prefer `--format json` + `jq`.
