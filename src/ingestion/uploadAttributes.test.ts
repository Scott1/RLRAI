import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { uploadAttributes } from "./uploadAttributes";

const bytes = Buffer.from("Exact uploaded Markdown\n", "utf8");
const hash = createHash("sha256").update(bytes).digest("hex");

test("replaces the redundant book attribute with a hash of uploaded bytes", () => {
  const input = { type: "book", source_id: "rlr-book-001", source_filename: "book.pdf" };
  const result = uploadAttributes(input, bytes);
  assert.deepEqual(result, { type: "book", source_id: "rlr-book-001", content_sha256: hash });
  assert.equal(input.source_filename, "book.pdf");
});

test("replaces the redundant podcast attribute while preserving source identity", () => {
  const input = { type: "podcast", source_id: "rlr-podcast-001", episode_id: "001" };
  assert.deepEqual(uploadAttributes(input, bytes), {
    type: "podcast", source_id: "rlr-podcast-001", content_sha256: hash
  });
});

test("adds the hash without dropping attributes for articles", () => {
  assert.deepEqual(uploadAttributes({ type: "article", source_id: "article-1" }, bytes), {
    type: "article", source_id: "article-1", content_sha256: hash
  });
});

test("keeps a full podcast record at 16 attributes", () => {
  const input = Object.fromEntries([
    ["type", "podcast"], ["source_id", "rlr-podcast-001"], ["episode_id", "001"],
    ...Array.from({ length: 13 }, (_, index) => [`field_${index}`, "value"])
  ]);
  const result = uploadAttributes(input, bytes);
  assert.equal(Object.keys(input).length, 16);
  assert.equal(Object.keys(result).length, 16);
  assert.equal(result.episode_id, undefined);
  assert.equal(result.content_sha256, hash);
  assert.notEqual(uploadAttributes(input, Buffer.from("changed")).content_sha256, hash);
});

test("rejects a supplied hash or more than 16 upload attributes", () => {
  assert.throws(() => uploadAttributes({ type: "book", content_sha256: "stale" }, bytes), /generated/);
  const tooMany = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`field_${index}`, "x"]));
  assert.throws(() => uploadAttributes(tooMany, bytes), /16-key limit/);
});
