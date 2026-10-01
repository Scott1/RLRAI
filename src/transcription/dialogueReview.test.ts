import assert from "node:assert/strict";
import test from "node:test";
import { applyCuts, renderCleanTranscript, sha256 } from "./cleanup";
import { applyDialogueReview, parseDialogue, verifyReviewCopy, type DialogueReview } from "./dialogueReview";

const fragments = applyCuts([
  { start: 0, end: 100, speaker: "Host", text: "Before." },
  { start: 100, end: 200, speaker: "Guest", text: "Question? Answer." },
  { start: 200, end: 300, speaker: "Host", text: "After." }
], []).fragments;
const copy = "# Draft\n\n## Conversation\n\n**Host:** Before.\n\n**Audience member 1:** Question?\n\n**Guest:** Answer.\n\n**Host:** After.\n";
const review: DialogueReview = { schema_version: 1, slug: "test", reviewed_by: "Scott",
  source_copy_sha256: sha256(copy), baseline_sha256: sha256(JSON.stringify(fragments)),
  first_original_id: "u0001", last_original_id: "u0001", previous_artifacts: {}, review_notes: ["User-reviewed Q&A"],
  turns: [{ speaker: "Audience member 1", text: "Question?", source_spans: [{ original_id: "u0001", char_from: 0, char_to: 9 }] },
    { speaker: "Guest", text: "Answer.", source_spans: [{ original_id: "u0001", char_from: 10, char_to: 17 }] }] };

test("user dialogue review splits speakers, preserves outside scope and retains original provenance", () => {
  const result = applyDialogueReview(fragments, review);
  assert.deepEqual(result[0], fragments[0]);
  assert.deepEqual(result[3], fragments[2]);
  assert.equal(result[1].speaker, "Audience member 1");
  assert.equal(result[1].start, 100);
  assert.equal(result[1].end, 200);
  assert.equal(result[1].speaker_review, "user_reviewed");
  verifyReviewCopy(copy, review, result);
  const md = renderCleanTranscript({ slug: "test", title: "Test", host: "Host", guests: ["Guest"], page_url: "https://example.com" }, result, review.review_notes, true);
  assert.match(md, /user-reviewed dialogue edits/);
  assert.match(md, /speaker_identity_verified: false/);
  assert.match(md, /u0001; chars 0:9/);
});

test("dialogue review rejects stale inputs, invalid scope, bad offsets, reordering and overlap", () => {
  assert.throws(() => applyDialogueReview(fragments, { ...review, baseline_sha256: "stale" }));
  assert.throws(() => applyDialogueReview(fragments, { ...review, first_original_id: "u0009" }));
  for (const span of [{ original_id: "u0000", char_from: 0, char_to: 3 },
    { original_id: "u0001", char_from: 0, char_to: 100 },
    { original_id: "u0001", char_from: -1, char_to: 3 },
    { original_id: "u0001", char_from: 0.5, char_to: 3 }]) {
    assert.throws(() => applyDialogueReview(fragments, { ...review, turns: [{ ...review.turns[0], source_spans: [span] }] }));
  }
  assert.throws(() => applyDialogueReview(fragments, { ...review, turns: [...review.turns].reverse() }));
  assert.throws(() => applyDialogueReview(fragments, { ...review, turns: [review.turns[0], review.turns[0]] }));
});

test("preserved user copy must match both fingerprint and every rendered speaker/text turn", () => {
  const result = applyDialogueReview(fragments, review);
  assert.throws(() => verifyReviewCopy(copy + "changed", review, result));
  assert.throws(() => verifyReviewCopy(copy, review, [{ ...result[0], speaker: "Guest" }, ...result.slice(1)]));
  assert.deepEqual(parseDialogue(copy.replace(/\n/g, "\r\n")), parseDialogue(copy));
  assert.throws(() => parseDialogue("No conversation"));
  assert.throws(() => parseDialogue("\n## Conversation\n\nUnlabelled dialogue."));
});
