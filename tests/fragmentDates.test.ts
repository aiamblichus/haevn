import { afterEach, describe, expect, it } from "vitest";
import { formatChatDate, formatRoughDate, roughDateOf } from "../src/model/roughDate";
import { parseRoughDate } from "../src/providers/fragment";

// HVN-163: the date forms of a fragment, their ranges and their labels.

const utc = (iso: string) => Date.parse(iso);

function dated(value: unknown) {
  const result = parseRoughDate(value);
  if (!result.ok) throw new Error(`not a date: ${String(value)}: ${result.message}`);
  return result;
}

describe("parseRoughDate: each form of the table", () => {
  const cases: Array<{
    value: unknown;
    precision: string;
    approximate: boolean;
    from: number;
    to: number | null;
    timestamp: number;
  }> = [
    {
      value: "2024",
      precision: "year",
      approximate: false,
      from: utc("2024-01-01T00:00:00Z"),
      to: utc("2025-01-01T00:00:00Z"),
      timestamp: Math.floor((utc("2024-01-01T00:00:00Z") + utc("2025-01-01T00:00:00Z")) / 2),
    },
    {
      value: "2024-03",
      precision: "month",
      approximate: false,
      from: utc("2024-03-01T00:00:00Z"),
      to: utc("2024-04-01T00:00:00Z"),
      timestamp: Math.floor((utc("2024-03-01T00:00:00Z") + utc("2024-04-01T00:00:00Z")) / 2),
    },
    {
      // a day is noon UTC: the same calendar day almost everywhere
      value: "2024-03-15",
      precision: "day",
      approximate: false,
      from: utc("2024-03-15T00:00:00Z"),
      to: utc("2024-03-16T00:00:00Z"),
      timestamp: utc("2024-03-15T12:00:00Z"),
    },
    {
      value: "~2024-03",
      precision: "month",
      approximate: true,
      from: utc("2024-03-01T00:00:00Z"),
      to: utc("2024-04-01T00:00:00Z"),
      timestamp: Math.floor((utc("2024-03-01T00:00:00Z") + utc("2024-04-01T00:00:00Z")) / 2),
    },
    {
      value: "2023-11..2024-02",
      precision: "range",
      approximate: false,
      from: utc("2023-11-01T00:00:00Z"),
      to: utc("2024-03-01T00:00:00Z"),
      timestamp: Math.floor((utc("2023-11-01T00:00:00Z") + utc("2024-03-01T00:00:00Z")) / 2),
    },
    {
      // the two ends may be in different forms
      value: "2023..2024-02-10",
      precision: "range",
      approximate: false,
      from: utc("2023-01-01T00:00:00Z"),
      to: utc("2024-02-11T00:00:00Z"),
      timestamp: Math.floor((utc("2023-01-01T00:00:00Z") + utc("2024-02-11T00:00:00Z")) / 2),
    },
    {
      // not before: it sorts at its floor, the one number that is not invented
      value: "2024-03..",
      precision: "after",
      approximate: false,
      from: utc("2024-03-01T00:00:00Z"),
      to: null,
      timestamp: utc("2024-03-01T00:00:00Z"),
    },
    {
      value: "~2024..",
      precision: "after",
      approximate: true,
      from: utc("2024-01-01T00:00:00Z"),
      to: null,
      timestamp: utc("2024-01-01T00:00:00Z"),
    },
  ];

  it.each(cases)("$value", ({ value, precision, approximate, from, to, timestamp }) => {
    const result = dated(value);
    expect(result.roughDate).toEqual({ text: value, precision, approximate, from, to });
    expect(result.timestamp).toBe(timestamp);
  });

  it("an exact time has no rough date: the timestamp says it all", () => {
    expect(dated("2024-03-15T14:30:00Z")).toEqual({
      ok: true,
      timestamp: utc("2024-03-15T14:30:00Z"),
    });
    expect(dated("2024-03-15T14:30:00+02:00").timestamp).toBe(utc("2024-03-15T12:30:00Z"));
    expect(dated("2024-03-15T14:30:00+14:00").timestamp).toBe(utc("2024-03-15T00:30:00Z"));
    expect(dated("2024-03-15T14:30:00-12:00").timestamp).toBe(utc("2024-03-16T02:30:00Z"));
    expect(dated("2024-03-15T14:30:00+0530").timestamp).toBe(utc("2024-03-15T09:00:00Z"));
    expect(dated("2024-03-15 14:30").timestamp).toBe(utc("2024-03-15T14:30:00Z"));
    expect(dated("2024-03-15T14:30:00.5Z").timestamp).toBe(utc("2024-03-15T14:30:00.500Z"));
    expect(dated("2024-03-15T14:30:00Z").roughDate).toBeUndefined();
  });

  it.each([undefined, null, "", "  ", "unknown", "Unknown"])("%j is not known", (value) => {
    const result = dated(value);
    expect(result.timestamp).toBe(0);
    expect(result.roughDate).toMatchObject({ precision: "unknown", from: 0, to: 0 });
  });

  it("reads a YAML number and a string alike", () => {
    expect(dated(2024)).toEqual(dated("2024"));
  });

  it("reads a Date a YAML 1.1 reader makes: midnight is the day, any other time is an instant", () => {
    expect(dated(new Date("2024-03-15T00:00:00Z")).roughDate).toMatchObject({
      precision: "day",
      text: "2024-03-15",
    });
    expect(dated(new Date("2024-03-15T14:30:00Z"))).toEqual({
      ok: true,
      timestamp: utc("2024-03-15T14:30:00Z"),
    });
  });

  it("reads a year before 1970 and a year before 100", () => {
    expect(dated("1969-07-20").timestamp).toBe(utc("1969-07-20T12:00:00Z"));
    expect(dated("0099").roughDate?.from).toBe(new Date("0099-01-01T00:00:00Z").getTime());
  });
});

describe("parseRoughDate: what is refused, because a lost claim would be lost in silence", () => {
  it.each([
    "..2024-03", // not-after is not built: no file needs it
    "March",
    "2024-13",
    "2024-00",
    "2024-02-30",
    "2024-03-15T25:00:00Z",
    "2024-03-15T14:30:00+99:99", // no zone is a hundred hours away
    "2024-03-15T14:30:00+14:01", // the furthest zone is 14:00
    "2024-03-15T14:30:00-12:60", // a minute is under 60
    "2024-03-15T14:30:00+1500",
    "2024-03..2024-02", // ends before it starts
    "2024-03..2024-05..2025",
    "2024-03-1",
    "~2024-03-15T10:00:00Z", // `~` means nothing on an instant
    "24",
    "c. 2024",
    true,
    ["2024"],
    { year: 2024 },
    2024.5,
  ])("%j", (value) => {
    expect(parseRoughDate(value).ok).toBe(false);
  });
});

describe("a date means the same in every time zone", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it("gives one timestamp whatever TZ is", () => {
    const values = ["2024", "2024-03-15", "2024-03-15T14:30:00", "2023-11..2024-02", "2024-03.."];
    const results = ["Pacific/Auckland", "America/Los_Angeles"].map((zone) => {
      process.env.TZ = zone;
      return values.map((value) => JSON.stringify(dated(value)));
    });
    expect(results[0]).toEqual(results[1]);
  });
});

describe("formatChatDate", () => {
  const label = (value: unknown) => formatRoughDate(dated(value).roughDate as never);

  it.each([
    ["2024", "2024"],
    ["2024-03", "Mar 2024"],
    ["2024-03-15", "15 Mar 2024"],
    ["2023-11..2024-02", "Nov 2023 to Feb 2024"],
    ["2023..2024-02-10", "2023 to 10 Feb 2024"],
    ["~2024-03", "c. Mar 2024"],
    ["~2024-03-05", "c. 5 Mar 2024"],
    ["2024-03..", "Mar 2024 or later"],
    ["~2024..", "c. 2024 or later"],
    ["unknown", "undated"],
    [undefined, "undated"],
  ])("%j is %j", (value, expected) => {
    expect(label(value)).toBe(expected);
  });

  it("shows a chat with no rough date as the archive always did", () => {
    const chat = { params: {}, providerLastModifiedTimestamp: 1_700_000_000_000 };
    expect(formatChatDate(chat)).toBe(new Date(1_700_000_000_000).toLocaleString());
    expect(formatChatDate({ params: {}, lastSyncedTimestamp: 1_700_000_000_000 })).toBe(
      new Date(1_700_000_000_000).toLocaleString(),
    );
    expect(formatChatDate({})).toBe("—");
  });

  it("shows a chat with a rough date by it, not by its sort timestamp", () => {
    const { roughDate, timestamp } = dated("~2024-03");
    expect(
      formatChatDate({ params: { roughDate }, providerLastModifiedTimestamp: timestamp }),
    ).toBe("c. Mar 2024");
    const undated = dated(undefined);
    expect(
      formatChatDate({
        params: { roughDate: undated.roughDate },
        providerLastModifiedTimestamp: 0,
      }),
    ).toBe("undated");
  });

  it("ignores a rough date that is malformed", () => {
    expect(roughDateOf({ params: { roughDate: { precision: "century", from: 1, to: 2 } } })).toBe(
      undefined,
    );
    expect(roughDateOf({ params: { roughDate: "2024" } })).toBe(undefined);
    expect(roughDateOf({ params: { roughDate: { precision: "year", from: "x", to: 2 } } })).toBe(
      undefined,
    );
    expect(roughDateOf(undefined)).toBe(undefined);
  });
});
