import { ChatView } from "../../src/ui/chat-view";
import { freshChatTabState, type ChatTabWorkingState } from "../../src/ui/chat-tab-state";

/** One chat tab around a fake service, with a fresh working state plus overrides. */
export function chatTab<S>(
  service: S,
  state: Partial<ChatTabWorkingState> = {},
): { service: S; state: ChatTabWorkingState; unsubscribe: () => void } {
  return { service, state: { ...freshChatTabState(), ...state }, unsubscribe: () => {} };
}

/**
 * A ChatView built from its prototype (no Obsidian leaf, no DOM), with one open
 * tab. Pass `service` and `state` for that tab; any other field is assigned to
 * the view as-is, so a test can stub a collaborator method or DOM handle.
 * Tests read tab state through `view.tabs[0].state`, the same place ChatView does.
 */
export function chatViewHarness<T>(
  fields: { service?: unknown; state?: Partial<ChatTabWorkingState> } & Record<string, unknown> = {},
): T {
  const { service = {}, state, ...rest } = fields;
  return Object.assign(Object.create(ChatView.prototype), {
    tabs: [chatTab(service, state)],
    activeTabIndex: 0,
    closed: false,
    ...rest,
  }) as T;
}
