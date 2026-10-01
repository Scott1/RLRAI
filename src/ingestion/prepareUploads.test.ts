import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyCuts, renderCleanTranscript } from "../transcription/cleanup";
import { cleanArticleUpload, renderSeriesUpload, validateCandidateAttributes } from "./prepareUploads";
import { loadManifestUploadDocuments } from "./manifest";

test("Series upload strips audit prose and timing but preserves every named dialogue turn", () => {
  const episode = { slug: "test", title: "Test", host: "Robin Ducharme", guests: ["Guest"], page_url: "https://example.com" };
  const turns = applyCuts([{ start: 5000, end: 6000, speaker: "Audience member 1", text: "Question?" },
    { start: 6000, end: 7000, speaker: "Guest", text: "A qualified answer." }], []).fragments;
  const draft = renderCleanTranscript(episode, turns, ["Check voices"]);
  const upload = renderSeriesUpload(draft, episode.title, turns);
  assert.match(upload, /\*\*Audience member 1:\*\* Question\?/);
  assert.match(upload, /\*\*Guest:\*\* A qualified answer\./);
  assert.doesNotMatch(upload, /review_required|Check voices|00:|Not approved|Cleaned review/);
  assert.throws(() => renderSeriesUpload(draft.replace("Question?", "Rewritten question?"), episode.title, turns));
  assert.throws(() => renderSeriesUpload(draft.replace("rights_status: review_required", "rights_status: approved"), episode.title, turns));
});

test("article preparation removes only exact standalone CTAs and preserves expert/resource/reflection text", () => {
  const teaching = "Substantive teaching and reflection. ".repeat(12);
  const article = `# Article\n\n${teaching}\n\nWant more? Subscribe for free!\n\n## Go Deeper\n\nAn expert says subscribe to your own values, not someone else's.\n\nWhere do you feel connected?\n`;
  const result = cleanArticleUpload(article);
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].paragraph, 3);
  assert.match(result.markdown, /Go Deeper/);
  assert.match(result.markdown, /says subscribe to your own values/);
  assert.match(result.markdown, /Where do you feel connected/);
  assert.equal(cleanArticleUpload(result.markdown).markdown, result.markdown);
  assert.throws(() => cleanArticleUpload("# Empty\n\nWant more? Subscribe for free!"));
});

test("candidate metadata does not silently approve rights or introduce off-site links", () => {
  const article = { type: "article", source_id: "rlr-substack-1", title: "Title", canonicality: "peer",
    rights_status: "review_required", manual_review: true, source_url: "https://realloveready.substack.com/p/title" };
  validateCandidateAttributes(article, "article");
  for (const patch of [{ rights_status: "approved" }, { canonicality: "primary" },
    { source_url: "https://example.com/p/title" }, { manual_review: false }]) {
    assert.throws(() => validateCandidateAttributes({ ...article, ...patch }, "article"));
  }
});

test("packaged review-required candidates remain blocked by the actual ingestion loader", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rlr-candidate-gate-"));
  try {
    await fs.mkdir(path.join(root, "manifests"));
    await fs.writeFile(path.join(root, "article.md"), "# Test article\n");
    const manifest = path.join(root, "manifests", "candidates.jsonl");
    await fs.writeFile(manifest, JSON.stringify({ file_path: "article.md", openai_upload_filename: "article.md",
      attributes: { type: "article", source_id: "test", rights_status: "review_required" } }) + "\n");
    await assert.rejects(() => loadManifestUploadDocuments([manifest], [root]), /rights_status other than approved/);
  } finally {
    for (const file of [path.join(root, "article.md"), path.join(root, "manifests", "candidates.jsonl")]) await fs.unlink(file);
    await fs.rmdir(path.join(root, "manifests"));
    await fs.rmdir(root);
  }
});
