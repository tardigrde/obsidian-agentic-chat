import path from "node:path";
import process from "node:process";
import { isCodeFile, readBaseline, relativePath, scanComments } from "../scripts/lib/comments.mjs";

let cachedBaseline;

function budgetFor(file) {
  cachedBaseline ??= readBaseline(path.join(process.cwd(), "config", "comment-baseline.json"));
  return cachedBaseline.files?.[file] ?? 0;
}

const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Warn when a file has more code comments than its frozen ratchet count. Warnings never fail the lint lane; delete a comment or move its rationale to an ADR.",
    },
    schema: [],
    messages: {
      overBudget:
        "Comment budget exceeded: this file has {{current}} comments, baseline {{budget}}. Delete a comment or move the rationale to docs/adr; run `npm run lint:comments -- --update` only when the deletion is intended.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? "";
    const file = relativePath(path.isAbsolute(filename) ? filename : path.join(process.cwd(), filename), process.cwd());
    if (!file.startsWith("src/") && !file.startsWith("test/") && !file.startsWith("scripts/")) return {};
    if (!isCodeFile(file)) return {};
    const budget = budgetFor(file);
    return {
      "Program:exit"() {
        const all = context.sourceCode.getAllComments();
        // Fast path: functional directives make the raw count an upper bound.
        if (all.length <= budget) return;
        const comments = scanComments(context.sourceCode.text, file);
        if (comments.length <= budget) return;
        const firstNew = comments[Math.min(budget, comments.length - 1)];
        context.report({
          loc: { line: firstNew.line, column: 1 },
          messageId: "overBudget",
          data: { current: comments.length, budget },
        });
      },
    };
  },
};

export default rule;
