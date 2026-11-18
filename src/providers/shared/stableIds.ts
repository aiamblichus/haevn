// src/providers/shared/stableIds.ts

/**
 * Message ids that come out the same every time the same chat is transformed.
 *
 * A message id names the media files of that message (`media/{chatId}/{messageId}_{n}.{ext}`),
 * so an id minted afresh on each sync writes every image again under a new name and leaves the old
 * files behind (HVN-90). Providers whose raw data carries no usable id derive one from what it does
 * carry.
 */

/**
 * One id per seed, in order. A seed names a message in the provider's own terms: its id when the
 * raw data has one, otherwise where it sits in the conversation. The id is a hash of the chat id
 * and the seed, shaped like a UUID so everything that expects one keeps working.
 *
 * Two messages with the same seed still get different ids (the second is told apart by how many
 * came before it), so ids stay unique within a chat; they stay the same between runs because the
 * order of seeds does.
 */
export async function stableMessageIds(chatId: string, seeds: string[]): Promise<string[]> {
  const seen = new Map<string, number>();
  const ids: string[] = [];
  for (const seed of seeds) {
    const key = `${chatId}\u0000${seed}`;
    const earlier = seen.get(key) ?? 0;
    seen.set(key, earlier + 1);
    ids.push(await hashToUuid(earlier === 0 ? key : `${key}\u0000#${earlier}`));
  }
  return ids;
}

async function hashToUuid(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest).slice(0, 16);
  // Version 5 and the RFC variant: the shape of a name-based UUID, which this is.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
