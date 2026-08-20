import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { browser, $ } from "@wdio/globals";
import { describe, it } from "mocha";

/**
 * Design-audit screenshot harness (gated on AGENTIC_CHAT_DESIGN_AUDIT=1):
 * drives one coherent chat conversation through handleAgentEvent so the
 * rendered DOM is deterministic, pauses at each visual state, and captures
 * full-window + element crops. Output lands in logs/design-audit/<ts>/.
 * No model key required. Not part of the default e2e suite.
 */

const VIEW_TYPE_AGENT_CHAT = "agentic-chat-chat-view";
const AUDIT_ROOT = path.resolve("logs/design-audit");

const ENABLED = process.env.AGENTIC_CHAT_DESIGN_AUDIT === "1";

async function emit(event: Record<string, unknown>): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, viewType, ev) => {
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
        handleAgentEvent?: (event: unknown) => void;
      };
      if (!view?.handleAgentEvent) throw new Error(`chat view missing handleAgentEvent for ${viewType}`);
      view.handleAgentEvent(ev);
    },
    VIEW_TYPE_AGENT_CHAT,
    event,
  );
}

function streamDelta(type: string, delta: string): Record<string, unknown> {
  return { type: "message_update", assistantMessageEvent: { type, delta } };
}

function toolStart(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { type: "tool_execution_start", toolCallId: id, toolName: name, args };
}

function toolEnd(id: string, result: unknown, isError = false): Record<string, unknown> {
  return { type: "tool_execution_end", toolCallId: id, result, isError };
}

function userEnd(text: string): Record<string, unknown> {
  return { type: "message_end", message: { role: "user", content: [{ type: "text", text }] } };
}

describe(ENABLED ? "agentic-chat design audit" : "agentic-chat design audit (disabled)", function () {
  if (!ENABLED) {
    it("skipped: set AGENTIC_CHAT_DESIGN_AUDIT=1 to capture design screenshots", async function () {
      // nothing to assert
    });
    return;
  }

  it("captures the full design journey screenshots", async function () {
    const dir = path.join(AUDIT_ROOT, new Date().toISOString().replace(/[:.]/g, "-"));
    mkdirSync(dir, { recursive: true });

    await browser.executeObsidianCommand("agentic-chat:open-chat");
    await $(".agentic-chat-view").waitForExist();
    try {
      await browser.setWindowSize(1440, 940);
    } catch {
      // window resizing is best-effort on the Obsidian runtime
    }

    const shot = async (name: string, cropSelector?: string): Promise<void> => {
      await browser.pause(120);
      await browser.saveScreenshot(path.join(dir, `${name}.full.png`));
      const view = await $(".agentic-chat-view");
      if (await view.isExisting()) await view.saveScreenshot(path.join(dir, `${name}.view.png`));
      if (cropSelector) {
        const el = await $(cropSelector);
        if (await el.isExisting()) await el.saveScreenshot(path.join(dir, `${name}.crop.png`));
      }
    };

    // 1. idle empty state + composer
    await shot("01-idle-empty");

    // 2. user bubble
    await emit(userEnd("Read the Welcome note and give me a three-line summary of it."));
    await shot("02-user-bubble");

    // 3. thinking loader (after the 150ms anti-flicker gate)
    await emit({ type: "agent_start" });
    await emit({ type: "message_start", message: { role: "assistant", content: [] } });
    await $(".agentic-chat-loading").waitForExist({ timeout: 2_000 });
    await shot("03-thinking-loader", ".agentic-chat-loading");

    // 4. live reasoning pill + trace
    await emit(streamDelta("thinking_delta", "I will read the Welcome note, extract its key sections, and summarise into three tight bullet lines."));
    await shot("04-reasoning-live", ".agentic-chat-reasoning-summary");

    // 5. running tool step
    await emit(toolStart("t-1", "read", { path: "Welcome.md" }));
    await emit({ type: "tool_execution_update", toolCallId: "t-1", partialResult: "streaming file contents…" });
    await shot("05-tool-running", ".agentic-chat-step");

    // 6. completed tool step (green check)
    await emit(toolEnd("t-1", { output: "# Welcome\nWelcome to your vault. This note is your starting point." }));
    await shot("06-tool-done", ".agentic-chat-step-header");

    // 7. second read + an errored tool call for the error step state
    await emit(toolStart("t-2", "read", { path: "Notes/Missing.md" }));
    await emit(toolEnd("t-2", { error: "File not found: Notes/Missing.md" }, true));
    await shot("07-tool-error", ".agentic-chat-step.is-error .agentic-chat-step-header");

    // 8. streamed rich markdown answer
    await emit(
      streamDelta(
        "text_delta",
        "## Welcome overview\n\nWelcome.md introduces three ideas:\n\n- A place to capture **quick thoughts**\n- A home for the vault's index\n- A scratchpad that grows\n\n```\nread: Welcome.md\n```\n\n> Use this note as the landing page.",
      ),
    );
    await shot("08-streaming-answer");

    // 9. settled answer with source chips + actions
    await emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "## Welcome overview\n\nWelcome.md introduces three ideas:\n\n- A place to capture **quick thoughts**\n- A home for the vault's index\n- A scratchpad that grows\n\n> Use this note as the landing page." }], errorMessage: undefined } });
    await $(".agentic-chat-source-chip").waitForExist({ timeout: 2_000 });
    await shot("09-final-answer", ".agentic-chat-sources");

    // 10. build out a short transcript for the overview shot
    await emit(userEnd("Thanks. Now list the top three daily habits from the vault?"));
    await emit({ type: "agent_start" });
    await emit({ type: "message_start", message: { role: "assistant", content: [] } });
    await emit(streamDelta("thinking_delta", "Scanning the vault for habit references…"));
    for (const line of ["1. **Daily review** — open the vault each morning.", "2. **Inbox zero** — file new notes same-day.", "3. **Weekly recap** — revisit the index on Sundays."]) {
      await emit(streamDelta("text_delta", `${line}\n`));
    }
    await emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "1. **Daily review** — open the vault each morning.\n2. **Inbox zero** — file new notes same-day.\n3. **Weekly recap** — revisit the index on Sundays." }] } });
    await emit({ type: "agent_end" });

    // 11. error state bubble
    await emit(userEnd("This prompt will fail on purpose"));
    await emit({ type: "agent_start" });
    await emit({ type: "message_start", message: { role: "assistant", content: [] } });
    await emit({ type: "message_end", message: { role: "assistant", content: [], errorMessage: "Connection error: the upstream provider returned 429 (rate limit reached)." } });
    await emit({ type: "agent_end" });
    await shot("10-error-state", ".agentic-chat-error");

    // 12. final transcript overview
    await browser.execute(() => {
      const messages = document.querySelector<HTMLElement>(".agentic-chat-messages");
      if (messages) messages.scrollTop = messages.scrollHeight;
    });
    await shot("11-transcript-overview");

    writeFileSync(path.join(dir, "manifest.txt"), "design audit capture complete\n", "utf8");
  });
});