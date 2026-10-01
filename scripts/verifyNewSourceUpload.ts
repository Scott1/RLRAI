import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { getConfig } from "../src/config";
import { loadManifestUploadDocuments } from "../src/ingestion/manifest";
import { uploadAttributes } from "../src/ingestion/uploadAttributes";
import { attributesEqual } from "../src/ingestion/syncAttributes";
import { createOpenAIClient } from "../src/openai";
import { sha256 } from "../src/transcription/cleanup";

const { values } = parseArgs({ options: {
  store: { type: "string" }, "before-state": { type: "string" },
  "corpus-root": { type: "string", default: "../rlr-ai-companion-corpus" },
  archive: { type: "boolean", default: false }
}});
async function main() {
  if (!values.store || !values["before-state"]) throw new Error("Supply the exact --store and --before-state backup.");
  const config = getConfig(), client = createOpenAIClient(config.apiKey);
  const corpus = path.resolve(values["corpus-root"]!);
  const manifest = path.join(corpus, "manifests/new-source-upload_approved.jsonl");
  const documents = await loadManifestUploadDocuments([manifest], [corpus]);
  const beforeBytes = await fs.readFile(path.resolve(values["before-state"]!));
  const before = JSON.parse(beforeBytes.toString("utf8"));
  const beforeIds = before.vectorStoreIds ?? [before.vectorStoreId];
  if (beforeIds.length !== 1 || beforeIds[0] !== values.store || before.files.length !== before.documentCount) {
    throw new Error("Backup is incomplete or belongs to a different store.");
  }
  const remote = [];
  for await (const file of client.vectorStores.files.list(values.store, { limit: 100 })) remote.push(file);
  const byId = new Map(remote.map(file => [file.attributes?.source_id ?? file.attributes?.id, file]));
  if (byId.size !== remote.length || remote.length !== before.files.length + documents.length ||
      remote.some(file => file.status !== "completed")) throw new Error("Store has unexpected counts, duplicate sources or incomplete indexing.");
  for (const file of before.files) {
    if (byId.get(file.id)?.id !== file.fileId) throw new Error(`Original document changed or disappeared: ${file.id}`);
  }
  const uploaded = [];
  const attributeRepresentations = [];
  for (const document of documents) {
    const bytes = await fs.readFile(document.path);
    const expected = uploadAttributes(document.attributes, bytes);
    const file = byId.get(document.attributes.source_id);
    // OpenAI can return episode number 1 as "1" even after a numeric update.
    const actual = { ...file?.attributes };
    if (typeof expected.episode_number === "number" && actual.episode_number === String(expected.episode_number)) {
      attributeRepresentations.push({ source_id: document.attributes.source_id,
        attribute: "episode_number", expected: expected.episode_number, returned: actual.episode_number });
      actual.episode_number = expected.episode_number;
    }
    if (!file || !attributesEqual(actual, expected)) {
      const differences = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
        .filter(key => actual[key] !== expected[key])
        .map(key => ({ key, expected: expected[key], actual: actual[key] }));
      throw new Error(`Uploaded hash/metadata mismatch: ${document.attributes.source_id}: ${JSON.stringify(differences)}`);
    }
    uploaded.push({ source_id: document.attributes.source_id, file_id: file.id,
      content_sha256: sha256(bytes), source_url: document.attributes.source_url, type: document.attributes.type });
  }
  const smokeTests = [
    { sourceId: "rlr-series-vienna-pharaon", question: "How do origin wounds affect vulnerability and repair?" },
    { sourceId: "rlr-series-lori-gottlieb", question: "What does Lori say about intuition and chemistry when dating?" },
    { sourceId: "rlr-substack-186953469", question: "Why can setting boundaries trigger a fawn response?" }
  ];
  const retrieval = [];
  for (const test of smokeTests) {
    const result = await client.vectorStores.search(values.store, { query: test.question, max_num_results: 3,
      filters: { type: "eq", key: "source_id", value: test.sourceId } });
    if (!result.data.length || result.data.some(item => item.attributes?.source_id !== test.sourceId) ||
        !result.data.some(item => item.content.some(part => part.type === "text" && part.text.trim()))) {
      throw new Error(`Retrieval smoke test failed: ${test.sourceId}`);
    }
    retrieval.push({ source_id: test.sourceId, query: test.question, returned_passages: result.data.length,
      top_score: result.data[0].score, source_url: result.data[0].attributes?.source_url, passed: true });
  }
  const report = { schema_version: 1, verified_at: new Date().toISOString(), vector_store_id: values.store,
    original_documents_preserved: before.files.length, added_documents_verified: documents.length,
    total_documents: remote.length, book_chapters: remote.filter(file => file.attributes?.type === "book").length,
    podcast_transcripts: remote.filter(file => file.attributes?.type === "podcast").length,
    articles: remote.filter(file => file.attributes?.type === "article").length,
    indexing_completed: true, original_file_ids_unchanged: true, uploaded_hashes_and_attributes_match: true,
    attribute_representation_differences: attributeRepresentations,
    manual_quality_review_pending: true, before_state_sha256: sha256(beforeBytes),
    approved_manifest_sha256: sha256(await fs.readFile(manifest)), retrieval_smoke_tests: retrieval, sources: uploaded };
  const encoded = JSON.stringify(report, null, 2) + "\n";
  await fs.mkdir(path.join(config.rootDir, ".rlr"), { recursive: true });
  await fs.writeFile(path.join(config.rootDir, ".rlr/new-source-upload-verification.json"), encoded);
  if (values.archive) {
    if (!await fs.stat(path.join(corpus, ".git")).then(() => true, () => false)) throw new Error("Archive target is not the existing private corpus.");
    await fs.writeFile(path.join(corpus, "manifests/new-source-upload-verification.json"), encoded, { flag: "wx" });
  }
  console.log(`${documents.length} added sources verified; ${before.files.length} originals unchanged; ${remote.length} documents indexed.`);
  console.log(`${report.book_chapters} book chapters, ${report.podcast_transcripts} podcasts, ${report.articles} articles.`);
  console.log(`${retrieval.length} source-filtered retrieval smoke tests passed. All uploaded hashes, URLs and approval/quality attributes match.`);
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
