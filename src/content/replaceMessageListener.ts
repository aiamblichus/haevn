// One live `chrome.runtime.onMessage` listener per tab, however many times content.js is injected.
//
// content.js is a manifest content script and is also injected again by `executeScript` (after a
// navigation, in a retry, from the popup). Every injection runs the bundle in the SAME isolated
// world, so a bare `addListener` at module top level adds one more listener each time, and one
// request then runs one handler per listener, all on the same DOM (HVN-161).
//
// The newest injection REPLACES the previous listener instead of yielding to it. A guard that
// skips `addListener` when a flag is already set would leave a tab dead after an extension reload:
// the orphaned script's globals may survive in the world, its listener is wired to the old,
// invalidated extension context and will never be called, and the flag would stop the new script
// from listening. Replacing has no such case: the new script always registers its own listener,
// and the old one is removed when it still belongs to this context (a no-op, or a throw we
// swallow, when it does not).

type MessageListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];

// A registered symbol: the key is the same on every evaluation of the bundle in this world.
const LISTENER_KEY = Symbol.for("haevn.content.messageListener");

type WorldState = { [LISTENER_KEY]?: MessageListener };

export function replaceMessageListener(listener: MessageListener): void {
  const world = globalThis as WorldState;
  const previous = world[LISTENER_KEY];
  if (previous) {
    try {
      chrome.runtime.onMessage.removeListener(previous);
    } catch {
      // The previous listener belongs to an invalidated context: it is dead, nothing to remove.
    }
  }
  chrome.runtime.onMessage.addListener(listener);
  world[LISTENER_KEY] = listener;
}
