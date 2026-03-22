# HAEVN Console Reference (`haevnDebug`-First)

Use this from the extension Options page console (or MCP `evaluate_script` in that page).

## Quick Start

```js
await haevnDebug.help();
await haevnDebug.getLogs(50);
await haevnDebug.setLogLevel(0); // DEBUG
```

## Principle

- Prefer dedicated helpers when available (`getLogs`, `search`, `getChat`, `rebuildIndex`, `opfs.*`, `reload`).
- For any background action that has no dedicated helper, use:

```js
await haevnDebug.send("actionName", { /* payload */ });
```

## Common Commands

### Logging and diagnostics

```js
await haevnDebug.getLogs(100, { match: "Sync" });
await haevnDebug.clearLogs();
await haevnDebug.setLogLevel(0);
await haevnDebug.getStorage();
```

### Chat and search

```js
await haevnDebug.getChat("<chatId>");
await haevnDebug.search("machine learning");
await haevnDebug.rebuildIndex();
```

### Media and files

```js
await haevnDebug.getStats();
await haevnDebug.opfs.usage();
await haevnDebug.opfs.ls("media");
await haevnDebug.opfs.tree("media", 3);
await haevnDebug.opfs.cat("path/to/file");
```

### Extension control

```js
await haevnDebug.reload();
```

## Generic Action Examples (`haevnDebug.send`)

Use these for operations not wrapped by dedicated helpers.

### Sync

```js
await haevnDebug.send("syncCurrentChat", { tabId: 123 });
await haevnDebug.send("syncChatByUrl", { url: "https://claude.ai/chat/abc-123" });
await haevnDebug.send("startBulkSync", { provider: "claude" });
await haevnDebug.send("cancelBulkSync");
await haevnDebug.send("getBulkSyncState");
await haevnDebug.send("resumeBulkSync", { provider: "claude" });
await haevnDebug.send("abandonBulkSync", { provider: "claude" });
await haevnDebug.send("forceResetBulkSync");
```

### Chat management

```js
await haevnDebug.send("getSyncedChatsMetadata", { offset: 0, limit: 50 });
await haevnDebug.send("getSyncedChatContent", { chatId: "abc123" });
await haevnDebug.send("deleteSyncedChats", { chatIds: ["id1", "id2"] });
await haevnDebug.send("existsChat", { chatId: "abc123" });
await haevnDebug.send("checkForChanges", { chatId: "abc123" });
await haevnDebug.send("checkCurrentChatSynced");
await haevnDebug.send("getProviderStats", { providerName: "claude" });
```

### Search

```js
await haevnDebug.send("searchChatsStreaming", { query: "python" });
await haevnDebug.send("cancelSearchStreaming", { query: "python" });
await haevnDebug.send("getAllMatchesForChat", { chatId: "abc123", query: "error" });
```

### Export and import

```js
await haevnDebug.send("exportSyncedChat", { chatId: "abc123", options: { format: "markdown" } });
await haevnDebug.send("startBulkExport", { chatIds: ["id1", "id2"], options: { format: "json" } });
await haevnDebug.send("pauseBulkExport");
await haevnDebug.send("resumeBulkExport");
await haevnDebug.send("cancelBulkExport");

await haevnDebug.send("startImportJob", {
  importType: "haevn_export_zip",
  stagedFilePath: "import-staging/file.zip",
  overwriteExisting: true,
});
await haevnDebug.send("pauseImportJob");
await haevnDebug.send("resumeImportJob");
await haevnDebug.send("cancelImportJob");
await haevnDebug.send("getImportJobState");
await haevnDebug.send("countImportConversations", {
  importType: "chatgpt_zip",
  stagedFilePath: "import-staging/file.zip",
});
```

### Gallery and media

```js
await haevnDebug.send("getGalleryMedia", { offset: 0, limit: 50 });
await haevnDebug.send("getGalleryContent", { chatId: "abc123", messageId: "m1" });
await haevnDebug.send("checkMissingThumbnails");
await haevnDebug.send("getMediaStats");
await haevnDebug.send("getMediaContent", { storagePath: "media/chatId/file.jpg" });
await haevnDebug.send("deleteMedia", { storagePath: "media/chatId/file.jpg" });
```

### Settings and misc

```js
await haevnDebug.send("getOpenWebUIBaseUrl");
await haevnDebug.send("setOpenWebUIBaseUrl", { baseUrl: "https://openwebui.example.com" });
await haevnDebug.send("clearOpenWebUIBaseUrl");

await haevnDebug.send("getLoggerConfig");
await haevnDebug.send("setLoggerConfig", { config: { minLevel: 0 } });
await haevnDebug.send("closeTab", { tabId: 123 });
```

## Notes

- This skill is MCP-first and console-first.
- No external relay/bridge workflow is required.
