import assert from "node:assert/strict";
import test from "node:test";
import { buildCitations, formatSourcesList, trimExcerpt } from "./citations";
import type { RetrievalResult } from "./types";

const result: RetrievalResult = {
  id: "demo:0",
  fileId: "file_123",
  filename: "demo.md",
  score: 0.91,
  text: "A useful passage.",
  metadata: {
    id: "demo",
    type: "book",
    title: "Demo Chapter",
    canonicality: "primary",
    rights_status: "approved"
  }
};

test("deduplicates citations by source document", () => {
  const citations = buildCitations([result, { ...result, id: "demo:1", score: 0.83 }]);
  assert.equal(citations.length, 1);
  assert.equal(citations[0]?.key, "S1");
  assert.equal(citations[0]?.score, 0.91);
});

test("formats source list for humans", () => {
  const list = formatSourcesList(buildCitations([result]));
  assert.match(list, /\[S1\] Real Love Ready - Demo Chapter/);
});

test("trims long excerpts", () => {
  const excerpt = trimExcerpt("a ".repeat(1000), 50);
  assert.ok(excerpt.length <= 50);
  assert.ok(excerpt.endsWith("..."));
});
