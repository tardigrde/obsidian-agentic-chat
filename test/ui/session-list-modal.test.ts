import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { SessionInfo } from "../../src/session/session-manager";
import { SessionListModal, type SessionListCallbacks } from "../../src/ui/session-list-modal";
import { shownNotices } from "./support/obsidian-dom";
import { settle } from "./support/mount-chat-view";

/** The conversation history modal: titles, search, load, rename, delete. */

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `sessions/${id}.jsonl`,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    messageCount: 2,
    firstMessage: `first message of ${id}`,
    ...overrides,
  };
}

function callbacks(overrides: Partial<SessionListCallbacks> = {}): SessionListCallbacks & {
  load: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
} {
  return {
    load: vi.fn(),
    delete: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    ...overrides,
  } as never;
}

let modal: SessionListModal | null = null;

function open(sessions: SessionInfo[], cb = callbacks(), activePath: string | null = null): ReturnType<typeof callbacks> {
  modal = new SessionListModal({} as App, sessions, activePath, cb);
  modal.open();
  return cb as ReturnType<typeof callbacks>;
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-session-row"));
const titles = () => rows().map((row) => row.querySelector(".agentic-chat-session-title")?.textContent ?? "");

afterEach(() => {
  modal?.close();
  modal = null;
  vi.useRealTimers();
});

describe("SessionListModal", () => {
  it("lists sessions by display name or first prompt, with a count line and the active row marked", () => {
    open([session("a", { name: "Weekly plan", messageCount: 1 }), session("b")], callbacks(), "sessions/b.jsonl");
    expect(document.querySelector(".modal-title")?.textContent).toBe("Conversations");
    expect(titles()).toEqual(["Weekly plan", "first message of b"]);
    expect(rows()[0].querySelector(".agentic-chat-session-meta")?.textContent).toMatch(/^1 message · /);
    expect(rows()[1].querySelector(".agentic-chat-session-meta")?.textContent).toMatch(/^2 messages · /);
    expect(rows().map((row) => row.classList.contains("is-active"))).toEqual([false, true]);
  });

  it("shows the empty message and no search box when there is nothing to search", () => {
    open([]);
    expect(document.querySelector(".agentic-chat-session-search")).toBeNull();
    expect(document.querySelector(".agentic-chat-session-empty")?.textContent).toBe("No saved conversations yet.");
  });

  it("filters on a debounced search and says when nothing matches", () => {
    vi.useFakeTimers();
    open([session("a", { name: "Garden notes" }), session("b", { name: "Tax return" })]);
    const search = document.querySelector<HTMLInputElement>(".agentic-chat-session-search");
    expect(search).not.toBeNull();
    search!.value = "tax";
    search!.dispatchEvent(new Event("input"));
    expect(titles()).toHaveLength(2);
    vi.advanceTimersByTime(150);
    expect(titles()).toEqual(["Tax return"]);

    search!.value = "nothing like this";
    search!.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(150);
    expect(document.querySelector(".agentic-chat-session-empty")?.textContent).toBe("No conversations match your search.");
  });

  it("loads a session on row click and closes", () => {
    const cb = open([session("a"), session("b")]);
    rows()[1].querySelector<HTMLElement>(".agentic-chat-session-main")?.click();
    expect(cb.load).toHaveBeenCalledWith(expect.objectContaining({ path: "sessions/b.jsonl" }));
    expect(document.querySelector(".modal-container")).toBeNull();
  });

  it("deletes optimistically and puts the row back with a notice when the delete fails", async () => {
    const cb = open([session("a"), session("b"), session("c")], callbacks({ delete: vi.fn(async () => { throw new Error("disk"); }) }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    rows()[1].querySelector<HTMLButtonElement>(".agentic-chat-session-delete")?.click();
    expect(titles()).toEqual(["first message of a", "first message of c"]);
    await settle();
    expect(cb.delete).toHaveBeenCalledTimes(1);
    expect(titles()).toEqual(["first message of a", "first message of b", "first message of c"]);
    expect(shownNotices).toContain("Failed to delete conversation.");
  });

  it("removes the row for good when the delete succeeds", async () => {
    const cb = open([session("a"), session("b")]);
    rows()[0].querySelector<HTMLButtonElement>(".agentic-chat-session-delete")?.click();
    await settle();
    expect(cb.delete).toHaveBeenCalledWith(expect.objectContaining({ path: "sessions/a.jsonl" }));
    expect(titles()).toEqual(["first message of b"]);
    expect(cb.load).not.toHaveBeenCalled();
  });

  it("renames inline on Enter, keeps the modal open, and does not load the row", async () => {
    const cb = open([session("a", { name: "Old name" }), session("b")]);
    rows()[0].querySelector<HTMLButtonElement>(".agentic-chat-session-rename")?.click();
    const input = document.querySelector<HTMLInputElement>(".agentic-chat-session-rename-input");
    expect(input?.value).toBe("Old name");
    input!.value = "New name";
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await settle();
    expect(cb.rename).toHaveBeenCalledWith(expect.objectContaining({ path: "sessions/a.jsonl" }), "New name");
    expect(titles()[0]).toBe("New name");
    expect(cb.load).not.toHaveBeenCalled();
    expect(document.querySelector(".modal-container")).not.toBeNull();
  });

  it("Escape cancels a rename and a failed rename keeps the old title with a notice", async () => {
    const failing = callbacks({ rename: vi.fn(async () => { throw new Error("disk"); }) });
    open([session("a", { name: "Keep me" }), session("b")], failing);
    vi.spyOn(console, "error").mockImplementation(() => {});

    rows()[0].querySelector<HTMLButtonElement>(".agentic-chat-session-rename")?.click();
    let input = document.querySelector<HTMLInputElement>(".agentic-chat-session-rename-input")!;
    input.value = "ignored";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();
    expect(failing.rename).not.toHaveBeenCalled();
    expect(titles()[0]).toBe("Keep me");

    rows()[0].querySelector<HTMLButtonElement>(".agentic-chat-session-rename")?.click();
    input = document.querySelector<HTMLInputElement>(".agentic-chat-session-rename-input")!;
    input.value = "Will fail";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await settle();
    expect(titles()[0]).toBe("Keep me");
    expect(shownNotices).toContain("Failed to rename conversation.");
  });
});
