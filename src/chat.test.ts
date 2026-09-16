import assert from "node:assert/strict";
import test from "node:test";
import { renderAnswer } from "./chat";

test("does not append sources to blocked safety responses", () => {
  const rendered = renderAnswer({
    answer: "I can't help with that request.",
    retrieval: [],
    sources: [],
    safetyCategory: "prompt-injection",
    insufficientEvidence: false
  });

  assert.equal(rendered, "I can't help with that request.");
});
