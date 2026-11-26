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
  type FragmentFile,
  type FragmentLookup,
  type FragmentParams,
  type FragmentPlanEntry,
  fragmentChatId,
  type HashedFragment,
  planFragmentImport,
  transformFragmentToHaevnChat,
} from "../../providers/fragment";
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
    load: async () => ({ chat: transformFragmentToHaevnChat(fragment) }),
  }));
  const imported = await importChatBatch(items, {
    overwrite: options.overwrite,
    index: options.index,
  });

  if (options.overwrite) {
    await writeGivenMetadata(
      importable.filter(({ entry }) => entry.state === "changed").map(({ fragment }) => fragment),
    );
  }
  return { plan: entries, imported };
}
