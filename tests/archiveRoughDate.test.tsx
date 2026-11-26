import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { ChatTableRow } from "../src/options/components/ArchiveView/ChatTableRow";
import { ChatPreviewCard } from "../src/options/components/shared/ChatPreviewCard";
import type { ChatMeta } from "../src/options/types";
import { parseRoughDate } from "../src/providers/fragment";
import { registerAllProviders } from "../src/providers/index";

// HVN-163, special case 1: the archive's date column and the preview card show the date a fragment
// was given, not the time it sorts at. Without it an undated fragment would show "1 Jan 1970".

function fragmentMeta(date: unknown): ChatMeta {
  const parsed = parseRoughDate(date);
  if (!parsed.ok) throw new Error(parsed.message);
  return {
    id: "fragment:1",
    source: "fragment",
    title: "A fragment",
    sourceId: "1",
    lastSyncedTimestamp: Date.UTC(2026, 10, 26, 15, 0, 0),
    providerLastModifiedTimestamp: parsed.timestamp,
    params: parsed.roughDate ? { roughDate: parsed.roughDate } : {},
  };
}

const row = (chat: ChatMeta) =>
  renderToStaticMarkup(
    <ChatTableRow chat={chat} isSelected={false} onToggleSelect={() => {}} onAction={() => {}} />,
  );

const card = (chat: ChatMeta) =>
  renderToStaticMarkup(<ChatPreviewCard chat={chat} isLoading={false} data={null} />);

describe("the date of a fragment in the archive (HVN-163)", () => {
  beforeAll(() => {
    registerAllProviders();
    (
      globalThis as unknown as { chrome: { runtime: { getURL: (p: string) => string } } }
    ).chrome.runtime.getURL = (path: string) => `chrome-extension://test/${path}`;
  });

  it.each([
    ["~2024-03", "c. Mar 2024"],
    ["2024", "2024"],
    ["2023-11..2024-02", "Nov 2023 to Feb 2024"],
    ["2024-03..", "Mar 2024 or later"],
    [undefined, "undated"],
  ])("the date column shows %j as %j", (date, label) => {
    const markup = row(fragmentMeta(date));
    expect(markup).toContain(`>${label}<`);
    expect(markup).not.toContain("1970");
  });

  it("shows the preview card's date once, and not the times it sorts at", () => {
    const markup = card(fragmentMeta("~2024-03"));
    expect(markup).toContain("Date");
    expect(markup).toContain("c. Mar 2024");
    expect(markup).not.toContain("Updated");
    expect(markup).not.toContain("Created");
  });

  it("shows an undated fragment as undated on the card, and no 1970", () => {
    const markup = card(fragmentMeta(undefined));
    expect(markup).toContain("undated");
    expect(markup).not.toContain("1970");
  });

  it("shows any other chat the time it always showed", () => {
    const modified = Date.UTC(2025, 5, 1, 9, 30, 0);
    const chat: ChatMeta = {
      id: "claude-1",
      source: "claude",
      title: "A chat",
      sourceId: "1",
      providerLastModifiedTimestamp: modified,
      lastSyncedTimestamp: 1,
    };
    expect(row(chat)).toContain(`>${new Date(modified).toLocaleString()}<`);
    expect(card(chat)).toContain("Updated");
  });
});
