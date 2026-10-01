import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { approvePreparedRecords, type PreparedUploadRecord } from "../src/ingestion/approval";
import { loadManifestUploadDocuments } from "../src/ingestion/manifest";
import { uploadAttributes } from "../src/ingestion/uploadAttributes";
import { sha256 } from "../src/transcription/cleanup";

const { values } = parseArgs({ options: {
  "corpus-root": { type: "string", default: "../rlr-ai-companion-corpus" },
  output: { type: "string", default: ".rlr/new-source-approval" },
  "confirm-rights": { type: "boolean", default: false },
  "write-corpus": { type: "boolean", default: false }
}});
const corpus = path.resolve(values["corpus-root"]!), output = path.resolve(values.output!);
const recordFile = "manifests/new-source-rights-approval.json";
const encoded = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const jsonl = (records: PreparedUploadRecord[]) => records.map(record => JSON.stringify(record)).join("\n") + "\n";
function inside(root: string, relative: string) {
  const resolved = path.resolve(root, relative);
  if (path.isAbsolute(relative) || !resolved.startsWith(root + path.sep)) throw new Error("Approval path escaped its root.");
  return resolved;
}
async function readRecords(relative: string) {
  const bytes = await fs.readFile(inside(corpus, relative));
  return { bytes, records: bytes.toString("utf8").split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as PreparedUploadRecord) };
}
async function main() {
  if (!values["confirm-rights"]) throw new Error("Run only after explicit source-use authorization, with --confirm-rights.");
  if (output === corpus || output.startsWith(corpus + path.sep) || corpus.startsWith(output + path.sep) ||
      !await fs.stat(path.join(corpus, ".git")).then(() => true, () => false)) throw new Error("Use a separate approval output and the existing private corpus.");
  const candidates = await readRecords("manifests/new-source-upload_candidates.jsonl");
  const preparationBytes = await fs.readFile(inside(corpus, "manifests/new-source-upload-preparation.json"));
  const preparation = JSON.parse(preparationBytes.toString("utf8"));
  if (preparation.approved_for_upload !== false || preparation.new_documents !== candidates.records.length ||
      preparation.sources.length !== candidates.records.length) throw new Error("Incomplete candidate preparation audit.");
  const approved = approvePreparedRecords(candidates.records);
  for (const record of approved) {
    const tracked = preparation.sources.find((item: any) => item.attributes.source_id === record.attributes.source_id);
    const original = candidates.records.find(item => item.attributes.source_id === record.attributes.source_id)!;
    const file = inside(corpus, record.file_path), real = await fs.realpath(file);
    if (!real.startsWith(corpus + path.sep)) throw new Error("Upload source escaped private corpus.");
    const bytes = await fs.readFile(file);
    if (!tracked || tracked.content_sha256 !== sha256(bytes) || tracked.file_path !== record.file_path ||
        !isDeepStrictEqual(tracked.attributes, original.attributes)) throw new Error("Prepared content changed since review; prepare a new selection.");
    uploadAttributes(record.attributes, bytes);
  }
  const byId = new Map(approved.map(record => [record.attributes.source_id, record]));
  const replacement = await readRecords("manifests/replacement-vector-store_candidates.jsonl");
  let replacements = 0;
  const allApproved = replacement.records.map(record => {
    const updated = byId.get(record.attributes.source_id);
    if (updated) {
      const original = candidates.records.find(item => item.attributes.source_id === record.attributes.source_id)!;
      if (!isDeepStrictEqual(original, record)) throw new Error("Replacement selection differs from prepared additions.");
      replacements++;
      return updated;
    }
    if (record.attributes.rights_status !== "approved") throw new Error("Replacement contains an unauthorized source outside the selected batch.");
    return record;
  });
  if (replacements !== approved.length || new Set(allApproved.map(record => record.attributes.source_id)).size !== allApproved.length) {
    throw new Error("Replacement selection has missing or duplicate sources.");
  }
  const priorBytes = await fs.readFile(inside(output, recordFile)).catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const prior = priorBytes ? JSON.parse(priorBytes.toString("utf8")) : undefined;
  if (prior && prior.candidate_manifest_sha256 !== sha256(candidates.bytes)) throw new Error("Approval output belongs to a different selection; choose a fresh output.");
  const approval = { schema_version: 1, confirmed_at: prior?.confirmed_at ?? new Date().toISOString(),
    confirmed_by: "Scott", approval_basis: "Scott confirmed that the RLR team approved use of all prepared Series and blog sources in the Companion for team performance review.",
    rights_status: "approved", manual_quality_review_pending: true, speaker_identity_verified: false,
    candidate_manifest_path: "manifests/new-source-upload_candidates.jsonl", candidate_manifest_sha256: sha256(candidates.bytes),
    preparation_audit_sha256: sha256(preparationBytes), new_documents: approved.length,
    series_episodes: approved.filter(record => record.attributes.type === "podcast").length,
    substack_articles: approved.filter(record => record.attributes.type === "article").length,
    sources: approved.map(record => ({ source_id: record.attributes.source_id, file_path: record.file_path,
      content_sha256: preparation.sources.find((item: any) => item.attributes.source_id === record.attributes.source_id).content_sha256 })) };
  const files = new Map<string, Buffer>();
  const add = (relative: string, data: string) => files.set(relative, Buffer.from(data));
  add("manifests/new-source-upload_approved.jsonl", jsonl(approved));
  add("manifests/series-assemblyai-openai_approved.jsonl", jsonl(approved.filter(record => record.attributes.type === "podcast")));
  add("manifests/substack-cleaned-openai_approved.jsonl", jsonl(approved.filter(record => record.attributes.type === "article")));
  add("manifests/replacement-vector-store_approved.jsonl", jsonl(allApproved));
  add(recordFile, encoded(approval));
  add("manifests/NEW-SOURCE-APPROVAL-README.md", ["# Source-use approval for team review", "",
    `${approval.series_episodes} Series transcripts and ${approval.substack_articles} articles are approved for use in the Companion based on Scott's confirmation of RLR team authorization.`,
    "This is source-use approval, not a claim that all words or speaker assignments have been manually verified. manual_review=true and speaker_identity_verified=false remain intact.", "",
    "The original candidate manifests and preparation audit are preserved as the pre-approval snapshot. The current operative approval is in new-source-rights-approval.json and the *_approved.jsonl selections.",
    "Use new-source-upload_approved.jsonl to sync just the additions to the existing store. Use replacement-vector-store_approved.jsonl only when intentionally rebuilding the entire store. Do not combine overlapping selections.",
    "No source dialogue, processed-source hashes or quality-review notes were changed by approval. The preparation report's approved_for_upload=false describes the earlier preparation snapshot, not this later authorization.", ""
  ].join("\n"));
  const roots = values["write-corpus"] ? [output, corpus] : [output];
  for (const root of roots) for (const [relative, bytes] of files) {
    try {
      if (sha256(await fs.readFile(inside(root, relative))) !== sha256(bytes)) throw new Error(`Approval destination differs: ${relative}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const root of roots) for (const [relative, bytes] of files) {
    const file = inside(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, bytes, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (sha256(await fs.readFile(file)) !== sha256(bytes)) throw new Error("Approval write verification failed.");
  }
  const approvedManifest = inside(values["write-corpus"] ? corpus : output, "manifests/new-source-upload_approved.jsonl");
  const loaded = await loadManifestUploadDocuments([approvedManifest], [corpus]);
  if (loaded.length !== approved.length) throw new Error("Approved manifest did not load the full selection.");
  console.log(`${approved.length} new sources rights-approved; ${allApproved.length} in approved full replacement selection.`);
  console.log("Approved manifest passed the actual ingestion loader. Quality flags and candidate snapshots preserved. No network requests.");
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
