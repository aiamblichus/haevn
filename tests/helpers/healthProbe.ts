/**
 * A fake browser for the provider health tests: a probe that stands where the tab, the content
 * script and the extractor are, and the scripts that say what each provider's site does.
 */
import { expect } from "vitest";
import type {
  FetchedChat,
  HealthDeps,
  HealthProbe,
} from "../../src/background/health/providerHealth";
import { ProbeOpenError } from "../../src/background/health/providerHealth";
import { getAllProviders, type Provider } from "../../src/providers/provider";
import { RAW_BY_PROVIDER, type Sentinels, sentinels } from "./healthFixtures";

export const OPENWEBUI_URL = "http://localhost:3000";

export type Hang = "hang";

export interface Script {
  /** open() throws this */
  open?: Error;
  /** the tab's address after open() */
  tabUrl?: string;
  /** the list: ids, an error to throw, or a promise that never settles */
  ids?: string[] | Error | Hang;
  /** per chat id: what the fetch answers */
  chats?: Record<string, FetchedChat | Hang>;
  /** the tab's address when read after a failure (a sign-in page, an error page) */
  tabUrlAfterFailure?: string;
}

export const WEB = () => getAllProviders().filter((p) => !p.importOnly);

export function idsFor(provider: string): string[] {
  return [0, 1, 2].map((n) => sentinels(`${provider}${n}`).id);
}

export function healthyScript(provider: string): Script {
  const ids = idsFor(provider);
  return {
    ids,
    chats: Object.fromEntries(
      ids.map((id, n) => {
        const s: Sentinels = { ...sentinels(`${provider}${n}`) };
        return [id, { success: true, data: RAW_BY_PROVIDER[provider](s) }];
      }),
    ),
  };
}

export class FakeProbe implements HealthProbe {
  scripts = new Map<string, Script>();
  nextTab = 100;
  tabs = new Map<number, string>();
  opened: number[] = [];
  closed: number[] = [];
  fetched: { provider: string; id: string }[] = [];
  listed: string[] = [];
  /** How many tabs were open at once, at most */
  maxOpen = 0;

  constructor() {
    for (const p of WEB()) this.scripts.set(p.name, healthyScript(p.name));
  }

  script(name: string, change: (s: Script) => void): void {
    const s = this.scripts.get(name) as Script;
    change(s);
  }

  private providerOf(tabId: number): string {
    return this.tabs.get(tabId) as string;
  }

  async open(url: string, _foreground: boolean, onTab: (id: number) => void): Promise<number> {
    const provider = WEB().find((p) => {
      try {
        return p.getListUrl(p.name === "openwebui" ? OPENWEBUI_URL : undefined) === url;
      } catch {
        return false;
      }
    });
    if (!provider) throw new Error(`no provider for ${url}`);
    const id = this.nextTab++;
    this.tabs.set(id, provider.name);
    this.opened.push(id);
    this.maxOpen = Math.max(this.maxOpen, this.opened.length - this.closed.length);
    onTab(id);
    const script = this.scripts.get(provider.name) as Script;
    if (script.open) {
      throw script.open instanceof ProbeOpenError
        ? script.open
        : new ProbeOpenError(script.open.message, script.tabUrlAfterFailure);
    }
    return id;
  }

  async tabUrl(tabId: number): Promise<string | undefined> {
    const script = this.scripts.get(this.providerOf(tabId)) as Script;
    return script.tabUrl ?? script.tabUrlAfterFailure;
  }

  async listIds(tabId: number): Promise<string[]> {
    const name = this.providerOf(tabId);
    this.listed.push(name);
    const ids = (this.scripts.get(name) as Script).ids;
    if (ids === "hang") return new Promise<string[]>(() => undefined);
    if (ids instanceof Error) throw ids;
    return ids ?? [];
  }

  async fetchChat(tabId: number, provider: Provider, chatId: string): Promise<FetchedChat> {
    expect(this.providerOf(tabId)).toBe(provider.name);
    this.fetched.push({ provider: provider.name, id: chatId });
    const answer = (this.scripts.get(provider.name) as Script).chats?.[chatId];
    if (answer === "hang") return new Promise<FetchedChat>(() => undefined);
    return answer ?? { success: false, error: "no such chat" };
  }

  async close(tabId: number): Promise<void> {
    this.closed.push(tabId);
  }
}

export function deps(probe: HealthProbe, overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    probe,
    openWebUIBaseUrl: async () => OPENWEBUI_URL,
    extensionVersion: () => "9.9.9",
    now: () => Date.now(),
    sleep: async () => undefined,
    ...overrides,
  };
}
