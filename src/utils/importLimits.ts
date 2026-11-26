/**
 * Up to this many chats are indexed one by one as they are saved, so search keeps answering.
 * A bigger batch switches the index to bulk mode: the chats are indexed once, in one pass at the
 * end, and search keeps answering from the index as it was. One incremental add is one small
 * transaction, so the limit now only bounds how much work a save does before it returns.
 *
 * Here and not in the batch so that the archive page, which says when search catches up, can read
 * it without bundling the batch (HVN-163).
 */
export const INCREMENTAL_INDEX_MAX_CHATS = 20;
