import assert from "node:assert/strict";
import test from "node:test";
import { approvePreparedRecords } from "./approval";

const candidate = { openai_upload_filename: "episode.md", file_path: "content/openai_upload/episode.md",
  attributes: { source_id: "series-1", rights_status: "review_required", type: "podcast",
    manual_review: true, speaker_identity_verified: false, canonicality: "peer" } };

test("rights approval changes only the upload gate, preserving quality flags and the original candidate", () => {
  const approved = approvePreparedRecords([candidate])[0];
  assert.equal(approved.attributes.rights_status, "approved");
  assert.equal(approved.attributes.manual_review, true);
  assert.equal(approved.attributes.speaker_identity_verified, false);
  assert.deepEqual({ ...approved, attributes: { ...approved.attributes, rights_status: "review_required" } }, candidate);
  assert.equal(candidate.attributes.rights_status, "review_required");
});

test("rights approval refuses empty, repeated and already-approved selections", () => {
  assert.throws(() => approvePreparedRecords([]));
  assert.throws(() => approvePreparedRecords([candidate, candidate]));
  assert.throws(() => approvePreparedRecords([{ ...candidate, attributes: { ...candidate.attributes, rights_status: "approved" } }]));
});
