import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDB } from "../src/services/db";
import {
  BULK_WINDOW_KEY,
  endBulkWindow,
  openBulkWindow,
  readBulkWindow,
  settleBulkWindow,
} from "../src/services/searchBulkWindow";

// The record a search worker keeps of a bulk operation, so that a restart cannot lose it (HVN-88).
// The worker's use of it is tested in searchWorkerSuite.ts; these are its own rules.
describe("the bulk window record", () => {
  const db = () => getDB();

  beforeEach(async () => {
    await db().cache.clear();
  });

  it("is empty until an operation begins", async () => {
    expect(await readBulkWindow(db())).toBeNull();
  });

  it("starts at the time it is given, and an operation that begins again keeps the first", async () => {
    expect(await openBulkWindow(db(), 1000)).toEqual({ since: 1000, ended: false });
    expect(await openBulkWindow(db(), 5000)).toEqual({ since: 1000, ended: false });
    expect(await readBulkWindow(db())).toEqual({ since: 1000, ended: false });
  });

  it("ends only a window that is on record", async () => {
    expect(await endBulkWindow(db())).toBeNull();
    expect(await db().cache.get(BULK_WINDOW_KEY)).toBeUndefined();

    await openBulkWindow(db(), 1000);
    expect(await endBulkWindow(db())).toEqual({ since: 1000, ended: true });
    expect(await readBulkWindow(db())).toEqual({ since: 1000, ended: true });
  });

  it("clears an ended window once it is settled", async () => {
    await openBulkWindow(db(), 1000);
    const ended = (await endBulkWindow(db())) as NonNullable<
      Awaited<ReturnType<typeof endBulkWindow>>
    >;

    await settleBulkWindow(db(), ended, 9000);

    expect(await readBulkWindow(db())).toBeNull();
  });

  it("moves a window that has not ended forward when it is settled, never back", async () => {
    const open = await openBulkWindow(db(), 1000);

    await settleBulkWindow(db(), open, 9000);
    expect(await readBulkWindow(db())).toEqual({ since: 9000, ended: false });

    await settleBulkWindow(db(), { since: 9000, ended: false }, 2000);
    expect(await readBulkWindow(db())).toEqual({ since: 9000, ended: false });
  });

  it("leaves alone a window that an operation reopened while the catch-up ran", async () => {
    await openBulkWindow(db(), 1000);
    const ended = (await endBulkWindow(db())) as NonNullable<
      Awaited<ReturnType<typeof endBulkWindow>>
    >;

    // The next operation begins before the catch-up of the last one is done: its chats are not
    // caught up yet, and it keeps the older time, which covers the chats the first still owes.
    expect(await openBulkWindow(db(), 7000)).toEqual({ since: 1000, ended: false });
    await settleBulkWindow(db(), ended, 9000);

    expect(await readBulkWindow(db())).toEqual({ since: 1000, ended: false });
  });

  it("reads a row it does not understand as no window", async () => {
    await db().cache.put({ id: BULK_WINDOW_KEY, value: "garbage", lastUpdated: 1 });
    expect(await readBulkWindow(db())).toBeNull();
  });
});
