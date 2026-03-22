# Extending HAEVN with an MCP-First Workflow

This guide describes how to add new capability to HAEVN and validate it using Chrome MCP + `haevnDebug`.

## Design Rules

1. Extend existing message contracts instead of adding parallel pathways.
2. Keep handlers focused: parse input, call service, return structured response.
3. Return machine-friendly payloads (`counts`, `ids`, `status`, `details`) for deterministic checks.
4. Log enough context to debug failures without dumping sensitive content.
5. Add tests for deterministic logic (parsers, reducers, transforms, state transitions).

## Implementation Flow

### 1. Define/Update Message Contract

Edit `src/types/messaging.ts` and add a new action to `BackgroundRequest`.

Example:

```typescript
| { action: "checkMediaIntegrity"; chatId?: string }
```

### 2. Implement Handler

Choose the right domain file under `src/background/handlers/`.

Example skeleton:

```typescript
export async function handleCheckMediaIntegrity(
  message: Extract<BackgroundRequest, { action: "checkMediaIntegrity" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const result = await runIntegrityCheck(message.chatId);
    sendResponse({ success: true, data: result });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Integrity check failed",
    });
  }
}
```

### 3. Register Handler

Edit `src/background/handlers/index.ts` and map the new action.

### 4. Wire UI Trigger (if needed)

If user-facing, add caller code in `src/options` or other UI surface.

## Validation Loop

1. `npm run build`
2. Reload extension (`haevnDebug.reload()` from options page)
3. Trigger scenario via MCP UI automation
4. Validate with `haevnDebug`:
   - logs (`getLogs`)
   - resulting data (`db`, search, media)
   - storage/OPFS as relevant
5. Re-run related workflows for regressions

## MCP Script Patterns

Use these from `evaluate_script` in options page:

```js
// invoke background action directly
() => chrome.runtime.sendMessage({ action: "checkMediaIntegrity" })

// inspect logs after action
() => window.haevnDebug.getLogs(100, { match: "Integrity" })

// inspect storage state
() => window.haevnDebug.getStorage()
```

## Best Practices

### Response Shape

Prefer structured responses that make automated assertions easy:

```typescript
sendResponse({
  success: true,
  data: {
    checked: 150,
    issues: 3,
    details: [{ chatId: "abc", issue: "Missing media" }],
  },
});
```

### Long-Running Work

- Return immediately with acknowledged start.
- Stream progress through logs/events.
- Keep operations cancellable where possible.

### Data Safety

- For destructive actions, require explicit scope (`chatId`, `chatIds`) and log summary before execution.
- Use soft-delete patterns when available.

### Observability

- Use consistent log prefixes (`[Sync]`, `[Import]`, `[Search]`, `[Media]`).
- Include identifiers needed for correlation (`chatId`, provider, job id).

## Common Failure Modes

- Contract mismatch: action added in type but not handler map.
- UI mismatch: state updated but not re-fetched/re-rendered.
- Index drift: search index stale after large data mutation.
- OPFS drift: metadata updated but file operations failed.

When in doubt: verify contract -> handler -> persistence -> UI, in that order.
