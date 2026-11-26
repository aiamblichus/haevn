/**
 * The archive page's one request for fragments (HVN-163, slice 3): the files, read once, go to
 * the service worker twice, as a dry run for the plan and again to import. The answer is told
 * from three kinds of failure, so that the dialog can say which: the worker did not answer, it
 * answered that another operation holds the lock, or it answered with an error.
 */

import type { FragmentFile } from "../../providers/fragment";
import type { BackgroundRequest, BackgroundResponse } from "../../types/messaging";
import type { FragmentImportReply } from "./fragmentPlanView";

export type FragmentAnswer =
  | { ok: true; reply: FragmentImportReply }
  | { ok: false; busy: string }
  | { ok: false; error: string };

export async function askFragments(
  files: FragmentFile[],
  options: { dryRun: boolean; overwrite: boolean },
): Promise<FragmentAnswer> {
  let response: BackgroundResponse | undefined;
  try {
    const request: BackgroundRequest = {
      action: "importFragmentFiles",
      files,
      dryRun: options.dryRun,
      overwrite: options.overwrite,
    };
    response = await chrome.runtime.sendMessage(request);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!response) return { ok: false, error: "the extension did not answer" };
  if (!response.success) {
    if ("errorCode" in response && response.errorCode === "BUSY" && "activeOperation" in response) {
      return { ok: false, busy: response.activeOperation };
    }
    return { ok: false, error: response.error };
  }
  const data = "data" in response ? (response.data as Partial<FragmentImportReply>) : undefined;
  if (!data || !Array.isArray(data.plan)) {
    return { ok: false, error: "the extension's answer held no plan" };
  }
  return { ok: true, reply: data as FragmentImportReply };
}
