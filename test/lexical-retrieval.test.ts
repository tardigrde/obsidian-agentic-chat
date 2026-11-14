import { describe, expect, it } from "vitest";
import { tokenizeRetrievalQuery } from "../src/retrieval/lexical";

describe("tokenizeRetrievalQuery", () => {
  it("deduplicates query tokens and keeps non-English word tokens", () => {
    expect(tokenizeRetrievalQuery("OAuth oauth agent naplo")).toEqual(["oauth", "agent", "naplo"]);
  });
});
