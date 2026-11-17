import { describe, expect, it } from "vitest";
import {
  renderActionPanel,
  renderErrorPanel,
  renderInfoPanel,
  renderSummaryPanel,
} from "../../src/ui/info-panel-renderer";

function root(): HTMLElement {
  return document.createElement("div");
}

describe("info panel renderer", () => {
  it("renders info rows with the shared transcript classes", () => {
    const parent = root();

    const panel = renderInfoPanel(parent, "Status", [["Mode", "Safe"], ["Model", "test"]]);

    expect(panel.className).toContain("agentic-chat-info");
    expect(panel.textContent).toContain("Status");
    expect(panel.textContent).toContain("Mode");
    expect(panel.textContent).toContain("— Safe");
    expect(panel.textContent).toContain("Model");
    expect(panel.textContent).toContain("— test");
  });

  it("renders action panels and wires row clicks", () => {
    const parent = root();
    let clicked = 0;

    const panel = renderActionPanel(parent, "Projects", "Pick one.", [
      { label: "Vault-wide", detail: "current", icon: "folder", onClick: () => clicked += 1 },
    ]);

    expect(panel.textContent).toContain("Projects");
    expect(panel.textContent).toContain("Pick one.");
    expect(panel.textContent).toContain("Vault-wide");
    panel.querySelector<HTMLElement>(".agentic-chat-action-row")?.click();
    expect(clicked).toBe(1);
  });

  it("renders summary panels from tagged or plain text", () => {
    const tagged = renderSummaryPanel(root(), "<conversation-summary>\nEarlier context.\n</conversation-summary>");
    const plain = renderSummaryPanel(root(), "Plain summary.");

    expect(tagged.textContent).toContain("Summarized earlier conversation");
    expect(tagged.textContent).toContain("Earlier context.");
    expect(plain.textContent).toContain("Plain summary.");
  });

  it("renders error panels with the error class", () => {
    const panel = renderErrorPanel(root(), "Something failed.");

    expect(panel.className).toContain("agentic-chat-info-error");
    expect(panel.textContent).toContain("Error");
    expect(panel.textContent).toContain("Something failed.");
  });
});
