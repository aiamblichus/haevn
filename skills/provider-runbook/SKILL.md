---
name: provider-runbook
description: "The hand check that every HAEVN provider still works before a release: nine web providers synced one chat each by αιamblichus in his own Chrome, six import formats run by a peer in the dev profile, what counts as working, the known issues to ignore, and the results table and blocking rule for the release ticket."
---

<!-- generated from /project/haevn/skills/provider-runbook by pnpm run skills:sync; edit the KB note, not this file -->
# Provider runbook: one pass before a release

A hand check that every provider still works against today's sites and today's file formats. Our gates see only our code; a site changes without telling us. This is step 1 of `/project/haevn/architecture/provider-health` (decisions: `/project/haevn/decisions/2026-11-19-provider-health-decisions`). When `haevn health` exists (HVN-107) it replaces most of the web half.

It has two halves and they do not wait for each other:

| Half | Who | Where | Time (estimate, not measured) |
| --- | --- | --- | --- |
| Web providers (nine) | αιamblichus | His own Chrome, signed in | about 40 minutes |
| Import-only formats (six) | A peer | The dev profile, `chrome-devtools-haevn` only | about 25 minutes |

The rules that do not bend:

- A seat never drives αιamblichus's Chrome for this and never signs in to a provider in the dev profile. The web half is his.
- Real session files and exports are private. They are staged under `transcripts/provider-check/` (gitignored), never committed, never quoted in a ticket, and deleted when the pass ends.
- A result is counts and a verdict. No chat text, title or id goes into the results table.

## What "works" means

One chat a provider, compared with its source by eye:

1. **It arrived**: the chat is in the archive with the title the site (or file) shows, not "(Untitled)".
2. **All turns are there**: the first and the last turn match the source, and the number of turns looks right.
3. **Roles are right**: what you wrote is under User, what the model wrote is under Assistant, and they alternate as on the site.
4. **Timestamps are real**: the dates on the bubbles are the dates of the conversation, not today's date on every turn.
5. **The extras the chat has are there**: a THINKING block where the model reasoned, images where the chat has images, and a `1 / 2` branch switch where the site has an edited or regenerated turn (only for providers that carry branches; see the tables).
6. **A second run does not duplicate**: syncing or importing the same thing again leaves one chat, not two.

The viewer shows text, thinking and attachments only. **It does not draw tool calls or tool results**, so a Claude Code, Codex or Pi session looks shorter in the viewer than in the terminal. That is not breakage; the peer checks tool parts by count (below).

## Web half (αιamblichus, his own Chrome)

### Before the first provider (5 minutes)

1. Check out the commit that will be tagged and build it: `pnpm install && pnpm run build`. The check tests the build it runs in.
2. In `chrome://extensions`, reload HAEVN (the unpacked one from this checkout's `dist/`). If your Chrome runs a released ZIP instead, say so in the table: the pass then tells you about the sites, not about the new build.
3. **Reload every provider tab you will use.** A tab opened before the extension reloaded has a dead content script, and Claude, ChatGPT and Poe capture their token from a request the page makes after the reload.
4. Do not start a bulk sync, import or export during the pass.

### The steps, the same for every provider (about 3 minutes; Gemini and AI Studio about 5)

1. Open the site, signed in, and open **one recent chat** of a few turns. Best is one the popup will call UNSYNCED, with something beyond plain text in it (thinking, an image, an edited turn).
2. Open the HAEVN popup. It must name the provider and show the chat's URL. "Unsupported Website" on a provider's chat page is a **fail** (detection broke).
3. Press **SYNC** (left button). The indicator under it says SYNCING, then **SYNCED** in green.
4. **The popup shows no error text.** A failed sync just puts the indicator back to what it was. So if the chat already said SYNCED before you pressed, the indicator proves nothing: send one more message on the site first, sync, and look for that new turn in the viewer.
5. Press **ARCHIVE** (top right of the popup), find the chat at the top of the list and click its title. It opens in the viewer.
6. Compare with the site, using the six points above. Thirty seconds of looking: first turn, last turn, roles, dates, the extras.
7. Write the row in the results table. On a fail, note what you saw in five words and move on; do not debug during the pass.

If a sync fails and you want the reason for the ticket: open the archive page, DevTools console, `await haevnDebug.getLogs(50, { match: "syncCurrentChat" })`. Copy the error line only, after checking it holds no token and no chat text.

### The nine

| Provider | Chat page looks like | How it reads the chat | Carries branches | Look for, beyond the six points | Minutes |
| --- | --- | --- | --- | --- | --- |
| **Claude** (blocks) | `claude.ai/chat/<id>` | API | yes | Thinking; an attached file or image; a chat with no text at all is skipped on purpose | 3 |
| **ChatGPT** (blocks) | `chatgpt.com/c/<id>` | API | yes | An image (uploaded or generated); a regenerated answer as `1 / 2` | 3 |
| **Gemini** (blocks) | `gemini.google.com/app/<id>` | The page itself | no | Thinking; a generated image. The page scrolls to the top and opens its thinking blocks by itself during the sync: that is the extractor. Keep the tab in front until SYNCED | 5 |
| Poe | `poe.com/chat/<id>` | API | no | An image or attachment; the bot's name as the model | 3 |
| Open WebUI | `<your host>/c/<id>` | API | yes | Thinking; a regenerated answer as `1 / 2`. Skip with "not run: no instance" if none is running | 3 |
| Qwen | `chat.qwen.ai/c/<id>` | API | yes | Thinking; an image | 3 |
| DeepSeek | `chat.deepseek.com/a/chat/s/<id>` | API | yes | Thinking (pick a DeepThink chat) | 3 |
| AI Studio | `aistudio.google.com/prompts/<id>` | The page itself | no | Thinking; an image or video. Keep the tab in front until SYNCED | 5 |
| Grok | `grok.com/c/<id>` | API | yes | Thinking; an attachment | 3 |

Total: seven at 3 minutes and two at 5, **31 minutes**, plus the 5 before and about 5 for the table: about 40.

### Known and open: do not count these as failures

- **HVN-16** (Gemini) and **HVN-15** (Grok): the chat *list* is short, so SYNC ALL misses chats. This pass syncs one chat and does not use the list.
- **HVN-17** (AI Studio): the text is taken from the rendered page, not from Raw Mode, so Markdown formatting can differ from what you typed. Missing turns or wrong roles are still a fail.
- Tool calls are not drawn in the viewer (see above).
- The date column in the archive is the provider's last-modified time, not the time of the sync.
- A row may show a Sync Now button on a chat that cannot be synced (HVN-102), and Grok is missing from some provider lists in the options page (HVN-103).
- **When you run `haevn health` (HVN-107) in place of the web half:** it checks the head of each list, read-only, and its findings are not all release blockers.
  - **`text.empty` on ChatGPT** is most likely a finding about our transformer (it reads `.text` of the `thoughts` and `reasoning_recap` nodes, which may carry their text elsewhere), not about the site. Open a ticket for it; it does not block the release. A `text.empty` on Claude or Gemini does block.
  - `title.fallback` on the newest chat, Poe `tree.multiple-roots` (a chat break makes a root by design) and ChatGPT or Gemini warns are warns: they never change the exit code and never block.
  - A provider you know you are signed in to that shows `not signed in` is a failure of the check or of token capture, not a pass: read its note, open the site in that Chrome, and run it again.
  - A large account can spend the 40 s on listing: `TIMEOUT` with `listing the chats`. Run that provider alone with `--timeout 120`.
  - Exit code 1 means a provider failed or timed out, or a release-blocking one (Claude, ChatGPT, Gemini) was skipped for time: check it alone with `-p`.

## Import-only half (a peer, the dev profile)

Read `skills/browser-check/SKILL.md` first (KB: `/project/haevn/skills/browser-check`): the dev profile, the loop, and the hard rule (only `mcp__chrome-devtools-haevn__*`, never `mcp__chrome-devtools__*`). Build the commit to be tagged in the primary checkout, `reload_extension`, open `options.html`.

### Where a sample comes from

| Format | Choose in the Import dialog | Sample | What "works" adds to the six points |
| --- | --- | --- | --- |
| Claude Code | Claude Code Session (.jsonl) | `~/.claude/projects/<project-slug>/<session-id>.jsonl`. Take a finished session **of this repository** (`-Users-goran-Code-active-haevn`), a recent one, so the installed version's format is the one tested | One file is one chat (Saved 1). Thinking shows where the session had it. Part kinds include `tool-call` and `tool-return` |
| Codex | Codex Session (.jsonl) | `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, the newest | One chat. **No thinking is expected**: Codex logs its reasoning encrypted and the importer leaves it out. `tool-call` and `tool-return` present |
| Pi | PI Session (.jsonl) | `~/.pi/agent/sessions/<cwd-slug>/<time>_<id>.jsonl`, the newest of a real session | One chat. Thinking shows where the session had it. `tool-call` and `tool-return` present |
| OpenRouter | OpenRouter Chats (.json) | αιamblichus's chatroom export (one `.json`, `"version": "orpg.3.0"`) | Saved equals the number of chatrooms that have a message. Readable reasoning shows as thinking |
| ChatGPT backup | ChatGPT Backup (.zip) | αιamblichus's export ZIP as ChatGPT mailed it (holds `conversations.json`, or `conversations-000.json` and on) | Saved equals the number of conversations. A chat with an uploaded or generated image shows it |
| Claude backup | Claude Backup (.zip) | αιamblichus's export ZIP as Claude mailed it (`conversations.json` at the top of the ZIP) | Saved equals the number of conversations. Thinking shows |

The three exports are αιamblichus's to request (once a quarter and on any user report, decision 8); he puts the file in `transcripts/provider-check/` himself. **No fresh export on hand is not a fail**: write "not run: no export since <date>" in the row. A peer does not go looking for one, does not zip `openai_export/`, and does not invent a synthetic file and call the format checked.

A session file is a private conversation too. Copy it, do not move it; one file a format; delete the copies at the end.

### The steps, for each format (about 3 minutes; an export about 4)

1. Copy the sample into `transcripts/provider-check/` (uploads work only from inside the working tree).
2. In the archive, press **Import** (the button beside the search box, not the one in the Providers view: HVN-101). Choose the format in **Provider**, then take a fresh snapshot, since the dialog swaps its file input, and `upload_file` to the new "Choose File".
3. Leave **Overwrite existing chats with the same ID** ticked. **Start Import**.
4. The dialog closes by itself half a second after the end, and "Import complete. Saved N, skipped M, errors K." in the header is replaced at once by "Loaded.". Do not rely on reading it. Read the counts with the script below instead. A red **Error** box in the dialog is a fail; copy its sentence.
5. Run the counts script. Check: chats went up by the number expected; both roles present; the first and last timestamps are the session's dates (a first timestamp of today means the importer found none and fell back to now: a fail); the part kinds the table names are there.
6. Open the chat in the viewer (click its title). Check the first and last turn against the file's first and last user and assistant text, and one THINKING block where one is expected.
7. **Import the same file again**, overwrite still ticked. Run the script: the chat count must not have moved, and the message count of the chat must be the same.
8. Read `haevnDebug.getLogs()` for errors, and `list_console_messages` for the page and `sw-1`.

The counts script, for `evaluate_script` on `options.html`. It returns numbers and part-kind names, no text. Set `SOURCE` to `claudecode`, `codex`, `pi`, `openrouter`, `chatgpt` or `claude`. It was written from the schema (`src/services/db.ts`, version 21) and has not been run; if it throws, `await haevnDebug.getChat("<id>")` prints the message and part counts to the console.

```js
async () => {
  const SOURCE = "claudecode";
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open("HaevnDB");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const all = (store, index, key) =>
    new Promise((res, rej) => {
      const r = db.transaction(store).objectStore(store).index(index).getAll(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  const chats = (await all("chats", "source", SOURCE)).filter((c) => !c.deleted);
  chats.sort((a, b) => (b.lastSyncedTimestamp ?? 0) - (a.lastSyncedTimestamp ?? 0));
  const chat = chats[0];
  if (!chat) {
    db.close();
    return { source: SOURCE, chats: 0 };
  }
  const messages = await all("chatMessages", "chatId", chat.id);
  db.close();
  const kinds = {};
  const roles = { request: 0, response: 0 };
  const times = [];
  for (const m of messages) {
    if (m.timestamp) times.push(m.timestamp);
    for (const mm of m.message ?? []) {
      roles[mm.kind] = (roles[mm.kind] ?? 0) + 1;
      for (const p of mm.parts ?? []) kinds[p.part_kind] = (kinds[p.part_kind] ?? 0) + 1;
    }
  }
  times.sort((a, b) => a - b);
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : null);
  return {
    source: SOURCE,
    chats: chats.length,
    newest: {
      messages: messages.length,
      roots: messages.filter((m) => !m.parentId).length,
      forks: messages.filter((m) => (m.childrenIds ?? []).length > 1).length,
      roles,
      kinds,
      models: (chat.models ?? []).length,
      first: day(times[0]),
      last: day(times[times.length - 1]),
    },
  };
};
```

### When the half is done

Delete `transcripts/provider-check/`. The dev profile may keep the imported chats, but they are αιamblichus's real sessions: delete them from the archive if the profile is shared with a seat that should not read them. Post the rows on the release ticket.

## The release section

Before a `v*.*.*` tag is pushed (decisions 2, 4 and 5):

1. Build the commit to be tagged, reload, run both halves. A pass older than a day, or on another commit, does not count.
2. Record this table as a comment on the release ticket.

```
Provider pass for <commit>, <date>, build: dist/ of this checkout | released ZIP <version>

| Provider      | Result                  | Ticket | Note (no chat text) |
| ---           | ---                     | ---    | ---                 |
| Claude        | pass / fail / not run   |        |                     |
| ChatGPT       |                         |        |                     |
| Gemini        |                         |        |                     |
| Poe           |                         |        |                     |
| Open WebUI    |                         |        |                     |
| Qwen          |                         |        |                     |
| DeepSeek      |                         |        |                     |
| AI Studio     |                         |        |                     |
| Grok          |                         |        |                     |
| Claude Code   |                         |        |                     |
| Codex         |                         |        |                     |
| Pi            |                         |        |                     |
| OpenRouter    |                         |        |                     |
| ChatGPT ZIP   |                         |        |                     |
| Claude ZIP    |                         |        |                     |
```

3. The rule:
   - **Claude, ChatGPT or Gemini fails: the release is blocked** until it is fixed and that provider is run again.
   - **Any other provider fails:** file a ticket (`area providers`), and name the provider and the ticket in the release notes as a known break. The release goes.
   - **Not run** (not signed in, no instance, no export) is written as not run with the reason, and the release notes say that provider was not checked. It is never written as pass.
4. The release notes can then say which providers were seen working, on which date.

Nothing enforces this: a tag is pushed by hand and no workflow can see his browser. It is a rule the Prior's release checklist keeps.

## What this pass does not check

- **The chat list and SYNC ALL.** One chat a provider says nothing about pagination (HVN-15, HVN-16). Optional, 2 minutes a provider: press SYNC ALL, compare the total it announces with the site's own list, press STOP SYNC after the first few.
- **Anything the chosen chat does not contain.** A new kind of content on a site is dropped in silence today (HVN-108 will log it); one plain chat will not show it. That is why step 1 asks for a chat with extras.
- **Media download in depth**, export, search and the CLI. They have their own tests and checks.

## Evidence

Written from the code at `996f37c`, with no browser driven and no site visited: `src/popup/popup.ts` and `popup.html` (the SYNC flow, the indicator, the empty `updateStatus`), `src/background/handlers/syncHandlers.ts` (`handleSyncCurrentChat`), each `src/providers/*/provider.ts` (URL shapes, `api` or page mode), the transformers (which set a real `parentId`, which emit thinking and tool parts), the importers, `src/options/components/Modals/ImportModal.tsx`, `src/background/import/import.worker.ts`, `src/viewer/viewer.tsx` (what a bubble draws, the branch switch) and `src/options/debug.ts`. The first real pass should correct this note wherever the page disagrees with it.
