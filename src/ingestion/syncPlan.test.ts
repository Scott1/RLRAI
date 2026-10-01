import assert from "node:assert/strict";
import test from "node:test";
import { createSyncPlan, type LocalSyncFile, type RemoteSyncFile } from "./syncPlan";
import { attributesEqual } from "./syncAttributes";

function local(sourceId: string, sha256 = "same", title = "Example"): LocalSyncFile {
  return {
    sourceId, title, type: "podcast", path: `${sourceId}.md`, relativePath: `${sourceId}.md`,
    uploadFilename: `${sourceId}.md`, sha256,
    attributes: { source_id: sourceId, title, type: "podcast", rights_status: "approved" }
  };
}

function remote(sourceId: string, sha256 = "same", title = "Example"): RemoteSyncFile {
  return {
    sourceId, fileId: `file-${sourceId}`, status: "completed", sha256,
    attributes: { source_id: sourceId, title, type: "podcast", rights_status: "approved" }
  };
}

test("plans additions, replacements, and metadata-only changes without removing omitted sources", () => {
  const plan = createSyncPlan("vs_test", [
    local("new"), local("changed", "new-hash"), local("metadata", "same", "New title"), local("same")
  ], [
    remote("changed", "old-hash"), remote("metadata"), remote("same"), remote("omitted")
  ], []);

  assert.deepEqual(plan.items.map((item) => [item.sourceId, item.action]), [
    ["changed", "replace"], ["metadata", "metadata"], ["new", "add"], ["same", "unchanged"]
  ]);
  assert.equal(plan.items.some((item) => item.sourceId === "omitted"), false);
});

test("removal is explicit and part of the reviewed plan", () => {
  const withoutRemoval = createSyncPlan("vs_test", [], [remote("old")], []);
  const withRemoval = createSyncPlan("vs_test", [], [remote("old")], ["old"]);
  assert.equal(withoutRemoval.items.length, 0);
  assert.deepEqual(withRemoval.items.map((item) => [item.sourceId, item.action]), [["old", "remove"]]);
  assert.notEqual(withoutRemoval.digest, withRemoval.digest);
});

test("plan hash changes if content, metadata, or existing file changes", () => {
  const baseline = createSyncPlan("vs_test", [local("episode")], [remote("episode")], []);
  assert.notEqual(baseline.digest, createSyncPlan("vs_test", [local("episode", "edited")], [remote("episode")], []).digest);
  assert.notEqual(baseline.digest, createSyncPlan("vs_test", [local("episode", "same", "New title")], [remote("episode")], []).digest);
  assert.notEqual(baseline.digest, createSyncPlan("vs_test", [local("episode")], [{ ...remote("episode"), fileId: "file-new" }], []).digest);
  const removal = createSyncPlan("vs_test", [], [remote("episode")], ["episode"]);
  const pendingRemoval = createSyncPlan("vs_test", [], [{ ...remote("episode"), status: "in_progress" }], ["episode"]);
  assert.notEqual(removal.digest, pendingRemoval.digest);
});

test("refuses duplicate source IDs and contradictory selections", () => {
  assert.throws(() => createSyncPlan("vs_test", [local("x"), local("x")], [], []), /Duplicate source ID/);
  assert.throws(() => createSyncPlan("vs_test", [], [remote("x"), remote("x")], []), /Duplicate source ID/);
  assert.throws(() => createSyncPlan("vs_test", [local("x")], [remote("x")], ["x"]), /upload and removal/);
  assert.throws(() => createSyncPlan("vs_test", [], [], ["missing"]), /not in vector store/);
});

test("numeric episode representations do not trigger metadata updates or fail confirmation", () => {
  const selected = local("episode"), uploaded = remote("episode");
  selected.attributes.episode_number = 22;
  uploaded.attributes.episode_number = "22";
  assert.equal(createSyncPlan("vs_test", [selected], [uploaded], []).items[0]?.action, "unchanged");
  assert.equal(attributesEqual(selected.attributes, uploaded.attributes), true);
  assert.equal(attributesEqual(uploaded.attributes, selected.attributes), true);
});

test("episode normalization does not weaken comparisons for other attributes or ambiguous numbers", () => {
  const attributes = { episode_number: 1, source_id: "episode", rights_status: "approved",
    source_url: "https://example.com/episode", content_sha256: "hash", manual_review: true };
  for (const changed of [
    { episode_number: "01" }, { episode_number: "1.0" }, { episode_number: " 1" }, { episode_number: "2" },
    { rights_status: "review_required" }, { source_url: "https://example.com/other" },
    { content_sha256: "changed" }, { manual_review: "true" }, { source_id: "other" }
  ]) assert.equal(attributesEqual(attributes, { ...attributes, ...changed }), false);
  assert.equal(attributesEqual(attributes, { ...attributes, extra: "value" }), false);
});
