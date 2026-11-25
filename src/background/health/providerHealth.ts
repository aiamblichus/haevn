// src/background/health/providerHealth.ts
//
// providerHealth (HVN-107, step 2 of /project/haevn/architecture/provider-health).
//
// For each web provider the user is signed in to: open the provider's list page in a background
// tab, list the chats, fetch the first two the way bulk sync fetches them, transform each with
// media skipped, run `checkChat`, and report one row per provider.
//
// STRICTLY READ-ONLY (decision 3 of /project/haevn/decisions/2026-11-19-provider-health-decisions):
// nothing here imports a save, a queue, an index or the media store, and the transform is called
// with `media: "skip"`. The only write of ours is the operation lock, a flag in the storage
// adapter. Not covered by "read-only": loading a provider's tab fires the credential-capture
// listeners that browsing the site fires (the same writes to chrome.storage.local), and ChatGPT's
// extractor loads a chat's images into memory (nothing is stored). Neither touches the archive.
//
// NO CHAT TEXT, TITLE OR ID reaches the report. A row holds counts, the names of rules, and
// errors scrubbed of ids, URLs and quoted text. The sampled chats' ids are held in memory for
// the length of one provider's check, to scrub them out of any error message that quotes them.

import type { Chat } from "../../model/haevn_model";
import { getAllProviders, type Provider } from "../../providers/provider";
import {
  type ChatShape,
  checkChat,
  describeChat,
  type Finding,
  type FindingCode,
  type FindingLevel,
} from "../../providers/shared/chatInvariants";
import { log } from "../../utils/logger";
import { acquireOperationLock, getActiveOperation, releaseOperationLock } from "../state";

// ─── Types ───────────────────────────────────────────────────────────────────

export type HealthStatus =
  /** Every sampled chat passed every rule. */
  | "ok"
  /** The chats were fetched and transformed; a rule that only warns was broken. */
  | "warn"
  /** A step broke, or a rule that fails was broken. */
  | "fail"
  /** The site answered but the user is not signed in. Not a failure. */
  | "not-signed-in"
  /** The site did not answer. Not a verdict on the provider. */
  | "unreachable"
  /** The provider did not finish inside its time limit. */
  | "timeout"
  /** Not checked, and the note says why (no Open WebUI address, out of run time). */
  | "skipped";

/** What the operation itself can find, beside the chat rules. */
export type OperationCode =
  | "open.failed"
  | "list.failed"
  | "list.empty"
  | "fetch.failed"
  | "validate.failed"
  | "transform.threw"
  | "transform.empty"
  | "check.crashed";

export interface HealthFinding {
  code: FindingCode | OperationCode;
  level: FindingLevel;
  message: string;
  /** Places that broke the rule, summed over the sampled chats. */
  count: number;
  /** How many of the sampled chats broke it. */
  chats: number;
}

export interface ProviderHealthRow {
  provider: string;
  /** true when the list answered; false when the site wanted a sign-in; null when not known. */
  signedIn: boolean | null;
  /** How many chats the list held; null when it was not read. */
  listed: number | null;
  /** How many chats were fetched, transformed and checked. */
  checked: number;
  status: HealthStatus;
  findings: HealthFinding[];
  /** Counts and kinds for each checked chat, so a report shows what the ruler looked at. */
  shapes: ChatShape[];
  /** A short reason, scrubbed of ids, URLs and quoted text. */
  note?: string;
  /** Milliseconds this provider took. */
  ms: number;
}

export interface ProviderHealthReport {
  extensionVersion: string;
  /** ISO time the run began. */
  startedAt: string;
  ms: number;
  rows: ProviderHealthRow[];
}

export interface ProviderHealthOptions {
  /** Provider names to check; omitted means every web provider. */
  providers?: string[];
  /** Chats to fetch from the head of each provider's list (default 2, at most 5). */
  chats?: number;
  /**
   * The limit for one provider, in ms (5 s to 120 s). Omitted, each provider gets its default: 120 s
   * for a navigation provider (Gemini, AI Studio), 40 s for the rest.
   */
  timeoutMs?: number;
  /** The limit for the whole run, in ms (default 240 s). */
  totalMs?: number;
}

export const DEFAULT_CHATS = 2;
export const MAX_CHATS = 5;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 40_000;
/** A navigation provider opens each chat's page: about 20 s, and 12 s more a chat (HVN-149). */
export const NAVIGATION_PROVIDER_TIMEOUT_MS = 120_000;
export const DEFAULT_TOTAL_MS = 240_000;

/** The request was malformed (an unknown provider name, a number out of range). */
export class HealthRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HealthRequestError";
  }
}

/** Another long operation holds the operation lock. */
export class HealthBusyError extends Error {
  constructor(readonly activeOperation: string) {
    super(
      `Another operation is running (${activeOperation}). Try the health check again when it ends.`,
    );
    this.name = "HealthBusyError";
  }
}

// ─── The seam: what the check needs from the browser ─────────────────────────

export interface FetchedChat {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * The browser side of the check. The default is built on chrome.tabs and the bulk-sync fetch
 * strategies; a test supplies a fake, so no tab and no site is needed.
 */
export interface HealthProbe {
  /**
   * Open `url` in a tab with the content script ready. `onTab` is called with the tab's id as
   * soon as it exists, so the caller can close it even when this never returns. A thrown error
   * is a `ProbeOpenError` when the tab's address is known.
   */
  open(url: string, foreground: boolean, onTab: (tabId: number) => void): Promise<number>;
  /** The address the tab is on now; undefined when the tab is gone or unreadable. */
  tabUrl(tabId: number): Promise<string | undefined>;
  /** The chat ids on the page, in the order the provider's extractor returns them. */
  listIds(tabId: number): Promise<string[]>;
  /** The raw payload of one chat, fetched as bulk sync fetches it. */
  fetchChat(
    tabId: number,
    provider: Provider,
    chatId: string,
    baseUrl: string | undefined,
  ): Promise<FetchedChat>;
  close(tabId: number): Promise<void>;
}

export interface HealthDeps {
  probe: HealthProbe;
  /** The address of the user's Open WebUI, or null when none is set. */
  openWebUIBaseUrl: () => Promise<string | null>;
  extensionVersion: () => string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

// ─── Scrubbing ───────────────────────────────────────────────────────────────

const MAX_NOTE_LENGTH = 200;

/** An identifier-like quoted word (a property name in a TypeError) is kept; other quotes are not. */
const KEEPABLE_QUOTED = /^[A-Za-z_$][\w$]{0,39}$/;

/**
 * Make an error message safe to put in a report: it must hold no chat id, no URL (the path or
 * query can carry an id), no quoted run of the payload (a JSON.parse error quotes the text it
 * choked on) and no long token (an organization id, a cursor).
 */
export function scrubMessage(message: string, knownIds: readonly string[] = []): string {
  let text = message;
  for (const id of knownIds) {
    if (id.length === 0) continue;
    for (const form of new Set([id, encodeURIComponent(id)])) {
      text = text.split(form).join("<id>");
    }
  }
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>");
  text = text.replace(/(['"`])((?:(?!\1).){0,400}?)\1/g, (whole, quote: string, inner: string) =>
    KEEPABLE_QUOTED.test(inner) ? whole : `${quote}…${quote}`,
  );
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>");
  text = text.replace(/[A-Za-z0-9_-]{20,}/g, "<id>");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > MAX_NOTE_LENGTH ? `${text.slice(0, MAX_NOTE_LENGTH)}…` : text;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name === "Error" ? "" : `${err.name}: `}${err.message}`;
  return String(err);
}

// ─── Telling the failures apart ──────────────────────────────────────────────

export type FailureKind = "not-signed-in" | "unreachable" | "other";

// "success=false" is not a sign-in by itself: Qwen sends it for a signed-in user's failed request
// too (HVN-115). An extractor that means "signed out" says so in words, as Qwen's does.
const SIGN_IN_MESSAGE =
  /\b40[13]\b|organizationId|log(?:ged)?[ -]?in|sign(?:ed)?[ -]?in|unauthori[sz]ed|not authenticated|authenticat|valid .{0,20}tokens?|access token|auth token/i;
const NETWORK_MESSAGE =
  /failed to fetch\s*$|networkerror|network error|net::|ERR_[A-Z_]+|timed out|timeout: tab|is not accessible|ECONNREFUSED|ENOTFOUND/i;
const SIGN_IN_HOSTS = /^(?:accounts\.google\.com|auth\.openai\.com|login\.[^/]+|auth\.[^/]+)$/i;
const SIGN_IN_PATH = /(?:^|\/)(?:log-?in|sign-?in|sign_in|signin|sso|auth|authenticate)(?:\/|$)/i;

/** Whether an address is a sign-in page. A bad address is not one. */
export function isSignInUrl(address: string | undefined): boolean {
  if (!address) return false;
  try {
    const url = new URL(address);
    return SIGN_IN_HOSTS.test(url.hostname) || SIGN_IN_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * Whether a failure says "not signed in", "the site did not answer", or neither. Judged from the
 * error text and the tab's address: an extractor has no single way to say it, so this reads what
 * the extractors throw today. A failure that is neither is reported as a failure of the provider.
 */
export function classifyFailure(message: string, tabUrl?: string): FailureKind {
  if (tabUrl?.startsWith("chrome-error:")) return "unreachable";
  if (isSignInUrl(tabUrl)) return "not-signed-in";
  const head = withoutAttemptSummaries(message);
  if (SIGN_IN_MESSAGE.test(head)) return "not-signed-in";
  if (NETWORK_MESSAGE.test(head)) return "unreachable";
  return "other";
}

// fetchWithTimeout ends its errors with `[GET https://…: 4 attempts: HTTP 401 3ms, …]` (HVN-120).
// Judge the failure by its own words: an earlier attempt's "HTTP 401" or "timed out" is history.
const ATTEMPT_SUMMARY = /\s*\[[A-Z]+ [^\]]*?: \d+ attempts?: [^\]]*\]/g;

function withoutAttemptSummaries(message: string): string {
  return message.replace(ATTEMPT_SUMMARY, "");
}

/** An open() failure that knows the tab's address. */
export class ProbeOpenError extends Error {
  constructor(
    message: string,
    readonly tabUrl: string | undefined,
  ) {
    super(message);
    this.name = "ProbeOpenError";
  }
}

// ─── One provider ────────────────────────────────────────────────────────────

class Cancelled extends Error {}

interface Tally {
  level: FindingLevel;
  message: string;
  count: number;
  chats: number;
}

function addFindings(into: Map<string, Tally>, findings: readonly Finding[]): void {
  for (const f of findings) {
    const entry = into.get(f.code) ?? { level: f.level, message: f.message, count: 0, chats: 0 };
    entry.count += f.count;
    entry.chats += 1;
    into.set(f.code, entry);
  }
}

function addOperationFinding(
  into: Map<string, Tally>,
  code: OperationCode,
  level: FindingLevel,
  message: string,
): void {
  const entry = into.get(code) ?? { level, message, count: 0, chats: 0 };
  entry.count += 1;
  entry.chats += 1;
  into.set(code, entry);
}

function toFindings(tally: Map<string, Tally>): HealthFinding[] {
  const rank = (level: FindingLevel) => (level === "fail" ? 0 : 1);
  return [...tally.entries()]
    .map(([code, t]) => ({ code: code as HealthFinding["code"], ...t }))
    .sort((a, b) => rank(a.level) - rank(b.level) || a.code.localeCompare(b.code));
}

function statusOf(findings: readonly HealthFinding[]): HealthStatus {
  if (findings.some((f) => f.level === "fail")) return "fail";
  if (findings.length > 0) return "warn";
  return "ok";
}

function needsForegroundTab(provider: Provider): boolean {
  return provider.name === "gemini" || !!provider.bulkSyncConfig?.requiresActiveTab;
}

/**
 * The providers whose failure blocks a release (decision 5 of the provider health decisions).
 * They are checked first, in this order, so a run that runs out of time skips the others and never
 * these. The CLI keeps the same list for its exit code (`cli/src/commands/health.ts`).
 */
export const RELEASE_BLOCKING_PROVIDERS: readonly string[] = ["claude", "chatgpt", "gemini"];

/**
 * The order a run takes: the release-blocking providers first; then the rest, the ones that fetch
 * through the API first (background tabs, quick) and the ones that scroll a list in a foreground
 * tab last, so a run out of time loses those and not the rest.
 */
export function runOrder(providers: readonly Provider[]): Provider[] {
  const rank = (p: Provider): number => {
    const blocking = RELEASE_BLOCKING_PROVIDERS.indexOf(p.name);
    return blocking >= 0
      ? blocking
      : RELEASE_BLOCKING_PROVIDERS.length + Number(needsForegroundTab(p));
  };
  return [...providers].sort((a, b) => rank(a) - rank(b));
}

interface Target {
  provider: Provider;
  baseUrl?: string;
}

async function checkProvider(
  target: Target,
  chats: number,
  timeoutMs: number,
  deps: HealthDeps,
): Promise<ProviderHealthRow> {
  const { provider, baseUrl } = target;
  const started = deps.now();
  const row: ProviderHealthRow = {
    provider: provider.name,
    signedIn: null,
    listed: null,
    checked: 0,
    status: "ok",
    findings: [],
    shapes: [],
    ms: 0,
  };
  const tally = new Map<string, Tally>();
  const knownIds: string[] = [];
  const holder: { tabId?: number } = {};
  const state: { cancelled: boolean; step: string } = {
    cancelled: false,
    step: "opening the page",
  };
  const stillGoing = () => {
    if (state.cancelled) throw new Cancelled();
  };

  const work = (async () => {
    // 1. The list page, with the content script ready.
    let tabId: number;
    try {
      tabId = await deps.probe.open(
        provider.getListUrl(baseUrl),
        needsForegroundTab(provider),
        (id) => {
          holder.tabId = id;
          // A tab that comes into being after the provider's time ran out (chrome.tabs.create
          // answering late) is past the `finally` that closes the tab: close it here.
          if (state.cancelled) {
            deps.probe.close(id).catch((err) => {
              log.warn(`[ProviderHealth] Could not close a late tab for ${provider.name}:`, err);
            });
          }
        },
      );
    } catch (err) {
      stillGoing();
      const tabUrl = err instanceof ProbeOpenError ? err.tabUrl : undefined;
      // The tab's address, when it explains the failure, is a better reason than the error text
      // (a content script that never answers on Google's sign-in page, on Chrome's error page).
      const text = err instanceof Error ? err.message : String(err);
      const kind = classifyFailure(text, tabUrl);
      const message =
        kind !== "other" && tabUrl && (isSignInUrl(tabUrl) || tabUrl.startsWith("chrome-error:"))
          ? isSignInUrl(tabUrl)
            ? "the site sent the tab to a sign-in page"
            : "the browser could not reach the site"
          : scrubMessage(text, knownIds);
      if (kind === "not-signed-in") {
        row.signedIn = false;
        row.status = "not-signed-in";
      } else if (kind === "unreachable") {
        row.status = "unreachable";
      } else {
        addOperationFinding(
          tally,
          "open.failed",
          "fail",
          "the list page or its content script did not open",
        );
      }
      row.note = message;
      return;
    }
    holder.tabId = tabId;
    stillGoing();

    const landed = await deps.probe.tabUrl(tabId);
    stillGoing();
    if (isSignInUrl(landed)) {
      row.signedIn = false;
      row.status = "not-signed-in";
      row.note = "the site sent the tab to a sign-in page";
      return;
    }

    // 2. The list.
    state.step = "listing the chats";
    let ids: string[];
    try {
      ids = await deps.probe.listIds(tabId);
    } catch (err) {
      stillGoing();
      const tabUrl = await deps.probe.tabUrl(tabId);
      const kind = classifyFailure(errorText(err), tabUrl);
      row.note = scrubMessage(errorText(err), knownIds);
      if (kind === "not-signed-in") {
        row.signedIn = false;
        row.status = "not-signed-in";
      } else if (kind === "unreachable") {
        row.status = "unreachable";
      } else if (/\bno .{0,40}(?:chats|conversations)\b.{0,10}found/i.test(errorText(err))) {
        row.listed = 0;
        addOperationFinding(tally, "list.empty", "warn", "the provider's list holds no chats");
      } else {
        addOperationFinding(tally, "list.failed", "fail", "the chat list could not be read");
      }
      return;
    }
    stillGoing();
    row.listed = ids.length;
    if (ids.length === 0) {
      // An empty list is the answer of a new account, of a signed-out page that still loads, and
      // of a sidebar the extractor could not find. The check cannot tell them apart.
      addOperationFinding(tally, "list.empty", "warn", "the provider's list holds no chats");
      return;
    }
    row.signedIn = true;

    // 3. The sample: the head of the list.
    const sample = ids.slice(0, chats);
    knownIds.push(...sample);
    for (let i = 0; i < sample.length; i++) {
      if (i > 0) {
        await deps.sleep(provider.bulkSyncConfig?.rateLimitDelayMs ?? 200);
        stillGoing();
      }
      state.step = `fetching chat ${i + 1}`;
      const fetched = await deps.probe.fetchChat(tabId, provider, sample[i], baseUrl);
      stillGoing();
      if (!fetched.success || fetched.data === undefined) {
        addOperationFinding(tally, "fetch.failed", "fail", "a chat could not be fetched");
        row.note ??= scrubMessage(fetched.error ?? "the fetch returned no data", knownIds);
        continue;
      }

      // 4. validate (reported, not trusted), then transform with media skipped, then the ruler.
      state.step = `transforming chat ${i + 1}`;
      try {
        const verdict = provider.transformer.validate?.(fetched.data);
        if (verdict && !verdict.valid) {
          addOperationFinding(
            tally,
            "validate.failed",
            "fail",
            `the provider's own validator refused the payload: ${scrubMessage(verdict.errors.join("; "), knownIds)}`,
          );
        }
      } catch (err) {
        addOperationFinding(
          tally,
          "validate.failed",
          "fail",
          `the provider's own validator threw: ${scrubMessage(errorText(err), knownIds)}`,
        );
      }

      let transformed: Chat[];
      try {
        transformed = await provider.transformer.transform(fetched.data, undefined, {
          media: "skip",
        });
      } catch (err) {
        addOperationFinding(
          tally,
          "transform.threw",
          "fail",
          `the transformer threw: ${scrubMessage(errorText(err), knownIds)}`,
        );
        continue;
      }
      if (!Array.isArray(transformed) || transformed.length === 0) {
        addOperationFinding(tally, "transform.empty", "fail", "the transformer returned no chat");
        continue;
      }
      row.checked++;
      addFindings(tally, checkChat(transformed, { now: deps.now() }));
      row.shapes.push(...transformed.map(describeChat));
    }
  })();

  // The provider's time limit. `work` cannot be cancelled, so it is told to stop at its next step
  // and its tab is closed below; its late rejection is swallowed.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([work.then(() => "done" as const), limit]);
    if (outcome === "timeout") {
      state.cancelled = true;
      work.catch(() => undefined);
      row.status = "timeout";
      row.note = `no answer within ${Math.round(timeoutMs / 1000)} s, while ${state.step}`;
    }
  } catch (err) {
    if (!(err instanceof Cancelled)) {
      // Anything the steps above did not expect: the check itself broke, which is a finding.
      addOperationFinding(
        tally,
        "check.crashed",
        "fail",
        "the check itself stopped on an unexpected error",
      );
      row.note = scrubMessage(errorText(err), knownIds);
    }
  } finally {
    if (timer) clearTimeout(timer);
    state.cancelled = true;
    const tabId = holder.tabId;
    if (tabId !== undefined) {
      try {
        await deps.probe.close(tabId);
      } catch (err) {
        log.warn(`[ProviderHealth] Could not close the tab for ${provider.name}:`, err);
      }
    }
  }

  row.findings = toFindings(tally);
  if (row.status === "ok") row.status = statusOf(row.findings);
  // A row whose list never gave the user as signed in keeps that unknown, never a guess.
  row.ms = Math.max(0, deps.now() - started);
  return row;
}

// ─── The operation ───────────────────────────────────────────────────────────

export interface ResolvedHealthOptions {
  providers?: string[];
  chats: number;
  /** undefined when the caller sent none: each provider then takes its own default. */
  timeoutMs?: number;
  totalMs: number;
}

/**
 * The limit one provider gets: the caller's when it sent one, else the provider's own default
 * (HVN-149). A navigation provider reads each chat by opening its page, so it is slow, not stuck.
 */
function providerTimeoutMs(provider: Provider, requested: number | undefined): number {
  if (requested !== undefined) return requested;
  return provider.bulkSyncConfig?.mode === "navigation"
    ? NAVIGATION_PROVIDER_TIMEOUT_MS
    : DEFAULT_PROVIDER_TIMEOUT_MS;
}

/** Turn what a caller sent into options in range; a bad value is a request error, not a default. */
export function normalizeHealthOptions(input: unknown): ResolvedHealthOptions {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const integer = <F extends number | undefined>(
    name: string,
    value: unknown,
    min: number,
    max: number,
    fallback: F,
  ): number | F => {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new HealthRequestError(`${name} must be a whole number from ${min} to ${max}`);
    }
    return value;
  };
  let providers: string[] | undefined;
  if (raw.providers !== undefined && raw.providers !== null) {
    if (!Array.isArray(raw.providers) || raw.providers.some((p) => typeof p !== "string")) {
      throw new HealthRequestError("providers must be a list of provider names");
    }
    providers = raw.providers as string[];
  }
  return {
    providers,
    chats: integer("chats", raw.chats, 1, MAX_CHATS, DEFAULT_CHATS),
    timeoutMs: integer("timeoutMs", raw.timeoutMs, 5_000, 120_000, undefined),
    totalMs: integer("totalMs", raw.totalMs, 5_000, 600_000, DEFAULT_TOTAL_MS),
  };
}

/**
 * Run the check. Holds the operation lock for its length (a bulk sync, an import and a bulk export
 * drive tabs and the content script in the same way, and the two must not interleave), and
 * releases it, and closes every tab it opened, whatever happens.
 */
export async function runProviderHealth(
  input: ProviderHealthOptions | undefined,
  deps: HealthDeps,
): Promise<ProviderHealthReport> {
  const options = normalizeHealthOptions(input);

  // Every registered web provider is a row; a name that is no web provider is an error, not a skip.
  const web = getAllProviders().filter((p) => !p.importOnly);
  let chosen = web;
  if (options.providers) {
    const names = new Set(options.providers);
    const unknown = [...names].filter((n) => !web.some((p) => p.name === n));
    if (unknown.length > 0) {
      throw new HealthRequestError(
        `Unknown web provider: ${unknown.join(", ")}. Expected one of: ${web.map((p) => p.name).join(", ")}`,
      );
    }
    chosen = web.filter((p) => names.has(p.name));
  }

  if (!(await acquireOperationLock("providerHealth"))) {
    throw new HealthBusyError(await getActiveOperation());
  }

  const started = deps.now();
  const startedAt = new Date(started).toISOString();
  try {
    const order = runOrder(chosen);
    const rows = new Map<string, ProviderHealthRow>();
    const skipped = (provider: Provider, note: string): ProviderHealthRow => ({
      provider: provider.name,
      signedIn: null,
      listed: null,
      checked: 0,
      status: "skipped",
      findings: [],
      shapes: [],
      note,
      ms: 0,
    });

    for (const provider of order) {
      if (deps.now() - started >= options.totalMs) {
        rows.set(
          provider.name,
          skipped(provider, "the run's time limit passed before this provider"),
        );
        continue;
      }
      let baseUrl: string | undefined;
      if (provider.name === "openwebui") {
        baseUrl = (await deps.openWebUIBaseUrl()) ?? undefined;
        if (!baseUrl) {
          rows.set(
            provider.name,
            skipped(provider, "no Open WebUI address is set in the settings"),
          );
          continue;
        }
      }
      // A provider's limit never runs past the run's: the whole check ends within `totalMs`
      // (the CLI's wait is sized to that), and the last provider gets what is left.
      const left = options.totalMs - (deps.now() - started);
      const row = await checkProvider(
        { provider, baseUrl },
        options.chats,
        Math.max(1_000, Math.min(providerTimeoutMs(provider, options.timeoutMs), left)),
        deps,
      );
      log.info(
        `[ProviderHealth] ${row.provider}: ${row.status} (${row.checked}/${options.chats} checked, ${row.ms} ms)`,
      );
      rows.set(provider.name, row);
    }

    // A report with fewer rows than providers asked for is a failure of the check, not a pass.
    const ordered = chosen.map((p) => rows.get(p.name));
    if (ordered.some((r) => r === undefined)) {
      throw new Error("The health check lost a provider's row; refusing to report a partial table");
    }
    return {
      extensionVersion: deps.extensionVersion(),
      startedAt,
      ms: Math.max(0, deps.now() - started),
      rows: ordered as ProviderHealthRow[],
    };
  } finally {
    await releaseOperationLock("providerHealth");
  }
}
