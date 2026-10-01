import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendFeedback, buildEvalCases, listFeedback, parseFeedbackSubmission, parseReviewSubmission, resolveFeedbackFile, saveFeedbackReview } from "./feedback";

test("accepts an idea and trims its text", () => {
  assert.deepEqual(parseFeedbackSubmission({ kind: "idea", category: "feature_request", comment: "  A bookmark option  " }), {
    kind: "idea",
    category: "feature_request",
    comment: "A bookmark option",
    responseId: undefined,
    includeQuestion: false
  });
});

test("accepts a response report without requiring a written note", () => {
  const responseId = "759d2848-bef3-4a72-a23e-e1741017c369";
  assert.deepEqual(parseFeedbackSubmission({ kind: "report", category: "safety_concern", comment: "", responseId, includeQuestion: true }), {
    kind: "report",
    category: "safety_concern",
    comment: "",
    responseId,
    includeQuestion: true
  });
});

test("accepts positive response feedback with optional notes and opt-in question sharing", () => {
  const responseId = "759d2848-bef3-4a72-a23e-e1741017c369";
  const submission = parseFeedbackSubmission({ kind: "report", category: "good_response", comment: "", responseId });
  assert.equal(submission.category, "good_response");
  assert.equal(submission.includeQuestion, false);
  assert.equal(submission.responseId, responseId);
  assert.throws(() => parseFeedbackSubmission({ kind: "idea", category: "good_response", comment: "Helpful" }));
  assert.throws(() => parseFeedbackSubmission({ kind: "report", category: "good_response", comment: "" }));
});

test("positive examples persist and require curation before privacy-safe eval export", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rlr-positive-feedback-test-"));
  const filePath = path.join(directory, "feedback.jsonl");
  const id = "759d2848-bef3-4a72-a23e-e1741017c369";
  try {
    await appendFeedback(filePath, { id, createdAt: "2026-10-01T00:00:00.000Z", username: "reviewer",
      kind: "report", category: "good_response", comment: "Helpful source explanation", response: "Private answer" });
    assert.deepEqual(buildEvalCases(await listFeedback(filePath)), []);
    await saveFeedbackReview(filePath, id, "scott", { status: "in_review", evalCandidate: true,
      adminNote: "Check citations", evalQuestion: "", requirements: "" });
    assert.deepEqual(buildEvalCases(await listFeedback(filePath)), []);
    await saveFeedbackReview(filePath, id, "scott", { status: "resolved", evalCandidate: true,
      adminNote: "Verified", evalQuestion: "How does RLR describe boundaries?", requirements: "Explains the cited teaching\nAvoids prescribing a decision" });
    const records = await listFeedback(filePath);
    assert.equal(records[0]?.category, "good_response");
    assert.equal(records[0]?.question, undefined);
    assert.deepEqual(buildEvalCases(records), [{ id: `feedback-${id}`, category: "good_response",
      question: "How does RLR describe boundaries?", requirements: ["Explains the cited teaching", "Avoids prescribing a decision"] }]);
    assert.equal(JSON.stringify(buildEvalCases(records)).includes("Private answer"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("rejects unknown categories, blank ideas, and oversized comments", () => {
  assert.throws(() => parseFeedbackSubmission({ kind: "report", category: "anything", comment: "", responseId: "759d2848-bef3-4a72-a23e-e1741017c369" }));
  assert.throws(() => parseFeedbackSubmission({ kind: "idea", category: "general_idea", comment: " " }));
  assert.throws(() => parseFeedbackSubmission({ kind: "idea", category: "general_idea", comment: "x".repeat(2001) }));
});

test("uses a Railway volume instead of temporary deployment storage", () => {
  assert.equal(resolveFeedbackFile("/app", "0.0.0.0", { RAILWAY_PROJECT_ID: "project" }), undefined);
  assert.equal(resolveFeedbackFile("/app", "0.0.0.0", { RAILWAY_PROJECT_ID: "project", RAILWAY_VOLUME_MOUNT_PATH: "/data" }), path.join("/data", "feedback.jsonl"));
  assert.equal(resolveFeedbackFile("/app", "127.0.0.1", { NODE_ENV: "development" }), path.resolve("/app", ".rlr/feedback.jsonl"));
});

test("keeps review events durable and exports only curated eval cases", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rlr-feedback-test-"));
  const filePath = path.join(directory, "feedback.jsonl");
  try {
    await appendFeedback(filePath, {
      id: "cb126e80-54ba-44dd-adff-7c5655b58c3c",
      createdAt: "2026-09-26T00:00:00.000Z",
      username: "reviewer",
      kind: "report",
      category: "inaccurate_source",
      comment: "The source is out of context.",
      response: "A private answer",
      question: "A private question"
    });
    const review = parseReviewSubmission({
      status: "in_review",
      evalCandidate: true,
      adminNote: "Follow up with RLR.",
      evalQuestion: "What is a careful response to a source mismatch?",
      requirements: "uses the source in context\nacknowledges uncertainty"
    });
    await saveFeedbackReview(filePath, "cb126e80-54ba-44dd-adff-7c5655b58c3c", "scott", review);

    const records = await listFeedback(filePath);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.review.status, "in_review");
    assert.equal(records[0]?.review.updatedBy, "scott");
    assert.deepEqual(buildEvalCases(records), [{
      id: "feedback-cb126e80-54ba-44dd-adff-7c5655b58c3c",
      category: "inaccurate_source",
      question: "What is a careful response to a source mismatch?",
      requirements: ["uses the source in context", "acknowledges uncertainty"]
    }]);
    assert.equal(JSON.stringify(buildEvalCases(records)).includes("A private"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
