## Your Task

Review the changes being committed. Not to find problems because you think you should, but to catch things that will cause pain. **If the code is good, say so.** False positives waste everyone's time.

## Context

**Before starting your review, run these git commands to gather context:**

```bash
git diff --name-status --cached   # See what files are staged
git diff --staged                 # See the full staged diff
```

Read the actual changes. Understand what they're trying to accomplish. Then evaluate whether they accomplish it cleanly.

---

## Review Lenses (in priority order)

### 1. Correctness & Safety 🔴

**Does this code do what it claims to do, and does it fail safely?**

- Logic errors that produce wrong results
- Type errors that TypeScript doesn't catch (strict mode is on — trust the compiler, but watch for `as` casts and `!` non-null assertions)
- Null/undefined access without checks
- Async operations without error handling
- Race conditions in concurrent operations
- Data corruption risks (writes without validation)
- Security issues (XSS, injection, insecure storage)
- Missing `await` on promises inside `try` blocks (a silent killer here)

**If you find issues here, they're likely MUST FIX.**

### 2. Integration & Compatibility 🟡

**Does this fit with the rest of the system?**

**HAEVN Architecture Rules — flag violations:**

- **Persistence boundary:** Dexie must never be used directly from handlers. All persistence flows through `SyncService` (facade → `chatRepository.ts`)
- **Indexing boundary:** Search index updates go through the search worker via `SearchIndexManager`. Never update Lunr directly or inline
- **Worker boundary:** CPU-intensive work (ZIP, stats, indexing) belongs in workers. Blocking the service worker causes extension degradation
- **OPFS boundary:** OPFS is unavailable in the service worker. OPFS operations must go through the offscreen document bridge (CRD-003)
- **Download boundary:** File downloads use the `downloadFile` handler. No blob URLs in UI components
- **Async cleanup:** Use `fireAndForget()` for non-critical async ops — never bare `.catch(() => {})` (failures must be logged)
- **Event-driven updates:** Background is source of truth. UI changes must be driven by events (`chatSynced`, `bulkSync*`, `importProgress`) — not polling or direct coupling
- **Message size:** Large payloads through `chrome.sendMessage` must go through `ensureSafeMessage()` (64MB limit)

**MV3 Constraints — things that will silently fail or crash:**

- Service workers can be terminated at any time — state must be persisted to `chrome.storage.local`, not held in memory
- Long-running operations must use `chrome.alarms` for tick-based orchestration (survives restarts)
- Service workers cannot spawn Web Workers directly — must go through the offscreen document
- Context matters: what's valid in a content script is different from a worker or service worker
- Missing host permission or manifest entry for new APIs

**Data model integrity:**

- Changes to `HAEVN.Chat` fields need to be backward-compatible or include a Dexie migration
- New IndexedDB schema changes require a new schema version and migration in `db.ts`
- Soft-delete semantics: `deleted=1` flag, not physical deletion — Janitor handles cleanup
- OPFS media storage must stay in sync with DB metadata references

**Provider abstraction:**

- New platforms must implement `Extractor<TRaw>` and `Transformer<TRaw>` interfaces
- Platform-specific logic must stay inside `providers/{platform}/` — no platform detection leaking into core
- Adding a platform should not require changes to the orchestration or persistence layers

**Issues here range from MUST FIX to SHOULD FIX depending on impact.**

### 3. Maintainability & Clarity 🟢

**Will this code make sense in six months?**

- Complex logic without explanation
- Misleading names or comments
- Missing error context that would help debugging (structured logs go a long way here — the `haevnDebug` surface depends on good logging)
- Hard-to-test code (tangled side effects)
- Duplicating logic that should be shared
- Creating tech debt without acknowledging it

**Most issues here are SHOULD FIX or OPTIONAL unless they obscure critical logic.**

### 4. Performance & Resources 🔵

**Does this waste time or memory in a way that matters?**

- Blocking operations in service worker or UI thread
- N+1 queries or unnecessary loops (especially over large chat histories)
- Loading entire datasets when you need one item (check Dexie query patterns)
- Memory leaks (unclosed resources, unbounded growth — especially in workers)
- Expensive operations without caching/memoization (`CacheService` with TTL exists for a reason)
- Worker messages with large payloads that could exceed the 64MB limit

**Only flag if the impact is real. Premature optimization is not a virtue.**

---

## Severity Levels

Use these markers. **Be honest about severity.**

### 🚨 MUST FIX

**Ship-blocking. This will break something or create data loss.**

Examples:

- Unhandled promise rejection in critical path
- Type assertion that will fail at runtime
- Race condition that corrupts state
- Security vulnerability
- Breaking change to `HAEVN.Chat` format without migration
- Dexie used directly from a handler (bypasses persistence contract)
- Service worker state held in memory (lost on termination)

### ⚠️ SHOULD FIX

**Not immediately broken, but will cause problems.**

Examples:

- Error swallowing that hides real issues
- Missing validation that allows bad states
- Unclear code in complex logic
- Coupling that makes future changes hard
- Missing tests for new critical paths
- `fireAndForget()` skipped in favor of silent `.catch()`

### 💡 OPTIONAL

**Would be better, but not urgent.**

Examples:

- Code could be more idiomatic
- Minor duplication that doesn't hurt yet
- Missing types where inference works
- Slightly verbose logic
- Comments could be clearer

### ✅ LOOKS GOOD

**No issues found. Code accomplishes its goals cleanly.**

---

## Response Format

### High-Level Assessment

**What is this commit trying to do?** [1-2 sentences]

**Does it succeed?** [Yes/No + brief why]

**Overall quality:** [Excellent / Good / Acceptable / Needs Work]

**Confidence in review:** [High / Medium / Low - do you understand the changes well enough to judge?]

---

### Specific Issues

For each issue you find:

```
[SEVERITY] Location: file.ts:line or function name

Problem: [What's wrong? Be specific.]

Impact: [What breaks or gets harder?]

Fix: [Concrete suggestion - show code if helpful]

---
```

**If no issues:** Simply state:

```
✅ No issues found. Code is clean and accomplishes its goals.
```

---

### Testing Check

**Are there new behaviors that need tests?** [Yes/No]

**If yes, what should be tested?**

- [Specific scenario 1]
- [Specific scenario 2]

**Testing notes for HAEVN:**

- Pure functions (extractors, transformers, utilities) → unit tests with Vitest
- Service workflows (sync, search, import/export) → integration tests with `fake-indexeddb`
- Worker logic → test the worker module directly, not through the offscreen bridge
- Avoid testing message routing boilerplate — test the actual behavior

**If no:** Briefly explain why (e.g., "only refactoring existing tested code")

---

## Critical Guidelines

### DO:

- ✅ Focus on real problems with real consequences
- ✅ Explain _why_ something matters, not just that it's "wrong"
- ✅ Consider the HAEVN architecture (MV3 constraints, worker tiers, provider abstraction)
- ✅ Distinguish between bugs and style preferences
- ✅ Say "this is fine" when it actually is fine
- ✅ Provide concrete fixes, not vague suggestions

### DON'T:

- ❌ Nitpick formatting (Biome handles that)
- ❌ Suggest patterns that fight against the established architecture
- ❌ Flag things as MUST FIX that are actually preferences
- ❌ Invent problems to seem thorough
- ❌ Judge code by abstract principles divorced from actual impact
- ❌ Ignore domain context (Chrome extensions aren't normal web apps)
- ❌ Suggest moving persistence logic into handlers or vice versa — the layering is intentional

---

## The Standard

**Not:** "This could theoretically be better"
**But:** "This will actually cause problems"

**Not:** "This violates a principle I learned"
**But:** "This makes debugging harder because..."

**Not:** "I would have written it differently"
**But:** "This approach has a concrete downside that matters"

---

## Examples

### Good Review (Issue Found)

```
🚨 MUST FIX - syncService.ts:145

Problem: await missing on saveChat() call inside try block.
Promise rejection will be unhandled.

Impact: If save fails, bulk sync continues without knowing,
leading to incorrect "synced" status and missing chats.

Fix:
  try {
-   syncService.saveChat(chat);
+   await syncService.saveChat(chat);
    return { success: true };
```

### Good Review (False Positive Avoided)

```
High-Level Assessment:
Adds retry logic to API-based sync operations. Clear improvement.

Overall quality: Good

Specific Issues: None found.

The code handles errors properly, includes exponential backoff,
and preserves the existing API contract. The added complexity
is justified by the reliability improvement.

Testing Check: No new tests needed - retry logic is covered by
existing error handling tests.

✅ LOOKS GOOD - Ready to commit.
```

### Bad Review (Nitpicking)

```
❌ DON'T DO THIS:

💡 OPTIONAL - transformer.ts:89

Problem: Variable name 'result' is too generic.

Fix: Consider 'transformedChat' for clarity.

[This is bikeshedding. Only flag naming if it's actually confusing.]
```

---

## Remember

Your job is to prevent pain, not enforce purity.

The code doesn't need to be perfect. It needs to:

- Work correctly
- Fail visibly
- Fit the system
- Be debuggable

If it does those things, **it's good enough to ship.**

Don't invent problems. Find real ones.

**Think hard. Judge fairly. Ship good code.**
