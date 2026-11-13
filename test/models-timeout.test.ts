import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestUrl: () => new Promise(() => undefined),
}));

import { listOpenRouterModels } from "../src/llm/models";

describe("listOpenRouterModels — requestUrl path", () => {
  it("reports a hung request as a 408 timeout", async () => {
    await expect(listOpenRouterModels("key", { timeoutMs: 5 })).rejects.toMatchObject({
      name: "ModelListError",
      status: 408,
      message: "Timed out while listing models.",
    });
  });
});
