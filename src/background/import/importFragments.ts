/**
 * Import fragments (HVN-163): the one operation behind `haevn import --format fragment` (and, in a
 * later slice, the archive's drop zone). It reads what the archive holds, plans the files, and
 * unless this is a dry run hands the `new` and `changed` ones to `importChatBatch`, which holds the
 * operation lock, saves through `ImportService`, queues metadata and brings the index up to date.
 *
 * Not the import worker: that takes one staged file a job and exists for ZIPs that must not block
 * the service worker. Fragments are many small text files, and parsing them is cheap.
 */

import type { Chat } from "../../model/haevn_model";
import {
  assertReassembles,
  type FragmentFile,
  type FragmentLookup,
  type FragmentParams,
  type FragmentPlanEntry,
  fragmentChatId,
  givesMetadata,
  type HashedFragment,
  planFragmentImport,
  transformFragmentToHaevnChat,
} from "../../providers/fragment";
import * as MetadataRepository from "../../services/metadataRepository";
import { setManualMetadata } from "../../services/metadataService";
import { SyncService } from "../../services/syncService";
import { log } from "../../utils/logger";
import { errorShape } from "../../utils/logShape";
import { type ImportBatchItem, type ImportBatchResult, importChatBatch } from "./importBatch";

export interface ImportFragmentsOptions {
  /** Plan only: nothing is written */
  dryRun: boolean;
  /** false leaves a `changed` fragment as it is */
  overwrite: boolean;
  /** false saves without indexing */
  index: boolean;
}

export interface ImportFragmentsResult {
  /** One entry per file, in the order the files came */
  plan: FragmentPlanEntry[];
  /** What the batch did with the `new` and `changed` files; absent for a dry run or when there were none */
  imported?: ImportBatchResult;
}

function fragmentParamsOf(chat: Chat | undefined): Partial<FragmentParams> | undefined {
  const params = chat?.params?.fragment;
  return params && typeof params === "object" ? (params as Partial<FragmentParams>) : undefined;
}

/** What the archive holds, as the plan asks for it. The rows of every fragment are read once, on demand. */
function archiveLookup(): FragmentLookup {
  let byBody: Promise<Map<string, { id: string; fileName: string }>> | undefined;
  const bodies = () => {
    byBody ??= SyncService.getChatsBySource("fragment").then((rows) => {
      const map = new Map<string, { id: string; fileName: string }>();
      for (const row of rows) {
        const params = fragmentParamsOf(row);
        if (params?.bodySha256 && !map.has(params.bodySha256)) {
          map.set(params.bodySha256, { id: row.sourceId, fileName: params.fileName ?? "" });
        }
      }
      return map;
    });
    return byBody;
  };

  return {
    stored: async (id) => {
      const params = fragmentParamsOf(await SyncService.getChat(fragmentChatId(id)));
      if (!params?.fileSha256) return undefined;
      return { fileSha256: params.fileSha256, v: params.v ?? 0 };
    },
    withBody: async (bodySha256) => (await bodies()).get(bodySha256),
  };
}

/** What a `changed` fragment was before the import replaced it. */
interface Before {
  title: string;
  /** The file said `generate: false` */
  exempt: boolean;
}

async function beforeImport(changed: HashedFragment[]): Promise<Map<string, Before>> {
  const before = new Map<string, Before>();
  for (const fragment of changed) {
    const chatId = fragmentChatId(fragment.id);
    const row = await SyncService.getChat(chatId);
    if (row) {
      before.set(chatId, {
        title: row.title ?? "",
        exempt: fragmentParamsOf(row)?.generate === false,
      });
    }
  }
  return before;
}

/**
 * A file that no longer says `generate: false` (and gives no metadata of its own) puts the chat
 * back among those that can be generated. The record the old file made, the title it gave and
 * nothing else, is taken away for it: the queue passes over any record that is not `unset`, so
 * without this the chat would keep a stale title and never be generated. A record that holds
 * more than the old file gave is the person's, and stays.
 */
async function releaseGeneration(
  changed: HashedFragment[],
  before: Map<string, Before>,
): Promise<void> {
  for (const fragment of changed) {
    if (fragment.fields.generate === false || givesMetadata(fragment)) continue;
    const chatId = fragmentChatId(fragment.id);
    const previous = before.get(chatId);
    if (!previous?.exempt) continue;
    try {
      const record = await MetadataRepository.get(chatId);
      if (
        record?.source === "manual" &&
        !record.description &&
        !record.synopsis &&
        record.categories.length === 0 &&
        record.keywords.length === 0 &&
        (record.title === "" || record.title === previous.title)
      ) {
        await MetadataRepository.remove(chatId);
      }
    } catch (err) {
      log.warn("[ImportFragments] Failed to hand a fragment back to metadata generation", {
        error: errorShape(err),
      });
    }
  }
}

/**
 * A `changed` fragment writes the metadata fields its file gives over the record: the file is the
 * source of truth, and `seedFromChat` never writes over a record, which is right for a HAEVN export
 * and wrong here. Fields the file does not give are left as they are. Only for a fragment that
 * was saved, which its stored hash says.
 */
async function writeGivenMetadata(changed: HashedFragment[]): Promise<void> {
  for (const fragment of changed) {
    const { title, description, synopsis, categories, keywords } = fragment.fields;
    const given = {
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(synopsis ? { synopsis } : {}),
      ...(categories.length > 0 ? { categories } : {}),
      ...(keywords.length > 0 ? { keywords } : {}),
    };
    if (Object.keys(given).length === 0) continue;
    const chatId = fragmentChatId(fragment.id);
    try {
      const saved = fragmentParamsOf(await SyncService.getChat(chatId));
      if (saved?.fileSha256 !== fragment.fileSha256) continue;
      await setManualMetadata(chatId, given);
    } catch (err) {
      log.warn("[ImportFragments] Failed to write the metadata a changed fragment gives", {
        error: errorShape(err),
      });
    }
  }
}

export async function importFragments(
  files: FragmentFile[],
  options: ImportFragmentsOptions,
): Promise<ImportFragmentsResult> {
  const { entries, importable } = await planFragmentImport(files, archiveLookup());
  if (options.dryRun || importable.length === 0) return { plan: entries };

  const items: ImportBatchItem[] = importable.map(({ entry, fragment }) => ({
    name: entry.name,
    load: async () => {
      const chat = transformFragmentToHaevnChat(fragment);
      await assertReassembles(chat, fragment);
      return { chat };
    },
  }));
  const changed = options.overwrite
    ? importable.filter(({ entry }) => entry.state === "changed").map(({ fragment }) => fragment)
    : [];
  const before = await beforeImport(changed);
  const imported = await importChatBatch(items, {
    overwrite: options.overwrite,
    index: options.index,
    // Under the batch's operation lock, and before the saved chats are queued for generation
    afterSave: async (savedIds) => {
      const saved = new Set(savedIds);
      const kept = changed.filter((fragment) => saved.has(fragmentChatId(fragment.id)));
      await releaseGeneration(kept, before);
      await writeGivenMetadata(kept);
    },
  });
  return { plan: entries, imported };
}
