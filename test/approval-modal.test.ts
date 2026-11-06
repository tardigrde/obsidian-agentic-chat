import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { ApprovalModal } from "../src/ui/approval-modal";

interface ModalHarness {
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeModal(onStop?: () => void): { modal: ApprovalModal; harness: ModalHarness } {
  const modal = new ApprovalModal(
    {} as App,
    {
      toolName: "write",
      label: "Write file",
      args: { path: "Notes/a.md", content: "hi" },
    },
    onStop,
  );
  const harness: ModalHarness = { open: vi.fn(), close: vi.fn() };
  Object.assign(modal, harness);
  return { modal, harness };
}

describe("ApprovalModal", () => {
  it("closes and settles with a denial when the turn aborts", async () => {
    const { modal, harness } = makeModal();
    const abort = new AbortController();

    const decision = modal.ask(abort.signal);
    expect(harness.open).toHaveBeenCalledTimes(1);
    abort.abort();

    await expect(decision).resolves.toEqual({
      approved: false,
      remember: false,
      reason: "The turn was stopped before approval.",
    });
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("settles once as denied when the modal stop button is used", async () => {
    const onStop = vi.fn();
    const { modal, harness } = makeModal(onStop);
    const stopTurn = (modal as unknown as { stopTurn: () => void }).stopTurn.bind(modal);

    const decision = modal.ask();
    stopTurn();

    await expect(decision).resolves.toEqual({
      approved: false,
      remember: false,
      reason: "The turn was stopped before approval.",
    });
    stopTurn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("settles without opening when the turn is already aborted", async () => {
    const { modal, harness } = makeModal();
    const abort = new AbortController();
    abort.abort();

    await expect(modal.ask(abort.signal)).resolves.toMatchObject({ approved: false });
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.close).not.toHaveBeenCalled();
  });
});
