import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { parseDocument } from "../src/ingestion/metadata";
import { cleanArticleUpload, renderSeriesUpload, validateCandidateAttributes } from "../src/ingestion/prepareUploads";
import { uploadAttributes } from "../src/ingestion/uploadAttributes";
import { applyCuts, renderCleanTranscript, sha256 } from "../src/transcription/cleanup";
import { validateUtterances } from "../src/transcription/assemblyAi";
import { applyDialogueReview, verifyReviewCopy, type DialogueReview } from "../src/transcription/dialogueReview";
import { validateSeriesEpisodes } from "../src/transcription/series";

type Attributes = Record<string, string | number | boolean>;
interface RecordLine { openai_upload_filename: string; file_path: string; attributes: Attributes }
const { values } = parseArgs({ options: {
  "corpus-root": { type: "string", default: "../rlr-ai-companion-corpus" },
  output: { type: "string", default: ".rlr/new-source-uploads" },
  "write-corpus": { type: "boolean", default: false }
}});
const corpus = path.resolve(values["corpus-root"]!), output = path.resolve(values.output!);
const encoded = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const jsonl = (records: RecordLine[]) => records.map(record => JSON.stringify(record)).join("\n") + "\n";
const pending = new Map<string, Buffer>();
const audits: any[] = [];
const json = async (relative: string) => JSON.parse(await fs.readFile(inside(corpus, relative), "utf8"));

function inside(root: string, relative: string) {
  if (path.isAbsolute(relative)) throw new Error("Preparation uses relative corpus paths only.");
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep)) throw new Error(`Path escaped corpus root: ${relative}`);
  return resolved;
}
async function read(relative: string) {
  const file = inside(corpus, relative);
  const real = await fs.realpath(file);
  if (!real.startsWith(corpus + path.sep)) throw new Error("Source symlink escaped corpus root.");
  return fs.readFile(file);
}
function add(relative: string, data: string) {
  inside(output, relative);
  if (pending.has(relative)) throw new Error(`Duplicate output path: ${relative}`);
  pending.set(relative, Buffer.from(data));
}
async function records(relative: string): Promise<RecordLine[]> {
  const lines = (await read(relative)).toString("utf8").split(/\r?\n/).filter(line => line.trim());
  return lines.map(line => JSON.parse(line));
}
function checkRecord(record: RecordLine, bytes: Buffer) {
  if (!record.attributes || typeof record.attributes !== "object" || Array.isArray(record.attributes) ||
      typeof record.file_path !== "string" || !record.file_path.startsWith("content/openai_upload/") ||
      typeof record.openai_upload_filename !== "string" || !/^[a-z0-9-]+\.md$/.test(record.openai_upload_filename) ||
      typeof record.attributes.source_id !== "string" || !record.attributes.source_id ||
      typeof record.attributes.title !== "string" || !record.attributes.title ||
      !["book", "podcast", "article"].includes(String(record.attributes.type)) ||
      !["approved", "review_required"].includes(String(record.attributes.rights_status))) {
    throw new Error("Incomplete or invalid upload record.");
  }
  if (!bytes.length || !bytes.toString("utf8").trim() || bytes.toString("utf8").startsWith("---\n")) {
    throw new Error("Upload text is empty or contains audit front matter.");
  }
  const attached = uploadAttributes(record.attributes, bytes);
  for (const [key, value] of Object.entries(attached)) {
    if (key.length > 64 || (typeof value === "string" ? value.length > 512 :
      typeof value === "number" ? !Number.isFinite(value) : typeof value !== "boolean")) {
      throw new Error(`Invalid or oversized attribute: ${key}`);
    }
  }
  return { content_sha256: attached.content_sha256, attribute_count: Object.keys(attached).length,
    bytes: bytes.length, words: bytes.toString("utf8").split(/\s+/).filter(Boolean).length };
}

async function writeFiles(root: string) {
  // Check the complete bundle before writing; never overwrite differing files or human edits.
  for (const [relative, bytes] of pending) {
    try {
      if (sha256(await fs.readFile(inside(root, relative))) !== sha256(bytes)) throw new Error(`Destination differs: ${relative}. Prepare into a fresh output folder.`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const [relative, bytes] of pending) {
    const file = inside(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, bytes, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (sha256(await fs.readFile(file)) !== sha256(bytes)) throw new Error(`Written file differs: ${relative}`);
  }
}

async function main() {
  if (output === corpus || output.startsWith(corpus + path.sep) || corpus.startsWith(output + path.sep) ||
      !await fs.stat(path.join(corpus, ".git")).then(() => true, () => false)) {
    throw new Error("Use a separate staging output and the existing private corpus checkout.");
  }
  const inventory = await json("manifests/assemblyai-series/source-inventory.json");
  const episodes = validateSeriesEpisodes(inventory.episodes);
  const validation = await json("manifests/assemblyai-series-cleanup/validation.json");
  const summary = await json("manifests/assemblyai-series-cleanup/cleanup-summary.json");
  if (validation.checked_episodes !== episodes.length || validation.review_required !== true ||
      validation.speaker_identity_verified !== false || summary.episodes.length !== episodes.length) {
    throw new Error("Incomplete or improperly approved Series cleanup validation.");
  }
  const series: RecordLine[] = [];
  for (const episode of episodes) {
    const base = `content/processed/real-love-ready-series/assemblyai-cleaned/${episode.slug}`;
    const manifest = `manifests/assemblyai-series-cleanup/${episode.slug}`;
    const inputBytes = await read(`content/processed/real-love-ready-series/assemblyai/${episode.slug}.segments.json`);
    const input = JSON.parse(inputBytes.toString("utf8"));
    const bytes = await read(`${base}.md`), segmentBytes = await read(`${base}.segments.json`);
    const segments = JSON.parse(segmentBytes.toString("utf8"));
    const audit = await json(`${manifest}/cleanup-audit.json`);
    const cutBytes = await read(`${manifest}/reviewed-cuts.json`), cuts = JSON.parse(cutBytes.toString("utf8"));
    const baseline = applyCuts(validateUtterances(input.utterances), cuts.cuts);
    let fragments = baseline.fragments, dialogue: DialogueReview | undefined;
    if (audit.dialogue_review) {
      const reviewBytes = await read(`${manifest}/reviewed-dialogue.json`);
      dialogue = JSON.parse(reviewBytes.toString("utf8"));
      if (dialogue!.slug !== episode.slug || sha256(reviewBytes) !== audit.dialogue_review.review_sha256 ||
          sha256(reviewBytes) !== segments.dialogue_review_sha256) throw new Error("Stale user dialogue review.");
      fragments = applyDialogueReview(fragments, dialogue!);
      verifyReviewCopy((await read(`${manifest}/user-reviewed-copy.md`)).toString("utf8"), dialogue!, fragments);
    }
    if (audit.input_sha256 !== sha256(inputBytes) || segments.input_sha256 !== sha256(inputBytes) ||
        cuts.input_sha256 !== sha256(inputBytes) || audit.review_sha256 !== sha256(cutBytes) ||
        cuts.proposal_sha256 !== sha256(await read(`${manifest}/proposal.json`)) ||
        audit.proposal_sha256 !== cuts.proposal_sha256 ||
        audit.cleaned_sha256 !== sha256(bytes) || audit.segments_sha256 !== sha256(segmentBytes) ||
        validation.episodes.find((item: any) => item.slug === episode.slug)?.cleaned_sha256 !== sha256(bytes) ||
        summary.episodes.find((item: any) => item.slug === episode.slug)?.cleaned_sha256 !== sha256(bytes) ||
        segments.rights_status !== "review_required" || segments.review_required !== true ||
        segments.speaker_identity_verified !== false || segments.audio_sha256 !== input.audio_sha256 ||
        !isDeepStrictEqual(segments.episode, episode) || !isDeepStrictEqual(fragments, segments.utterances) ||
        !isDeepStrictEqual(baseline.cuts, audit.cuts) || !isDeepStrictEqual(segments.review_notes, audit.review_notes) ||
        bytes.toString("utf8") !== renderCleanTranscript(episode, fragments, audit.review_notes)) {
      throw new Error(`Stale or changed cleaned Series source: ${episode.slug}`);
    }
    const sourceMetadata = inventory.episodes.find((item: any) => item.slug === episode.slug);
    if (typeof sourceMetadata.publication_date !== "string" || sourceMetadata.series !== "Real Love Ready: The Series") {
      throw new Error("Missing publication date or Series identity.");
    }
    const date = new Date(sourceMetadata.publication_date);
    if (!Number.isFinite(date.getTime())) throw new Error("Invalid publication date.");
    const record: RecordLine = { openai_upload_filename: `rlr-series-${episode.slug}.md`,
      file_path: `content/openai_upload/real-love-ready-series-assemblyai/${episode.slug}.md`,
      attributes: { type: "podcast", canonicality: "peer", rights_status: "review_required",
        source_id: `rlr-series-${episode.slug}`, series: sourceMetadata.series, episode_number: episode.episode_number,
        date: date.toISOString().slice(0, 10), title: episode.title, source_url: episode.page_url,
        podcast_page_url: episode.page_url, participants: [episode.host, ...episode.guests].join(", "),
        manual_review: true, speaker_identity_verified: false, transcript_provider: "assemblyai" } };
    validateCandidateAttributes(record.attributes, "podcast");
    const upload = renderSeriesUpload(bytes.toString("utf8"), episode.title, fragments);
    const details = checkRecord(record, Buffer.from(upload));
    add(record.file_path, upload);
    series.push(record);
    audits.push({ ...record, ...details, processed_path: `${base}.md`, processed_sha256: sha256(bytes),
      cleanup_audit_path: `${manifest}/cleanup-audit.json`, cleanup_audit_sha256: sha256(await read(`${manifest}/cleanup-audit.json`)),
      audio_sha256: segments.audio_sha256, human_dialogue_review: Boolean(dialogue),
      review_notes: audit.review_notes.filter((note: string) => !dialogue || !note.startsWith("HIGH PRIORITY:")),
      excluded_from_upload: ["YAML front matter", "review notices", "timestamps", "audit records"] });
  }
  const articles: RecordLine[] = [];
  for (const candidate of await records("manifests/substack-openai_candidates.jsonl")) {
    validateCandidateAttributes(candidate.attributes, "article");
    const processed = `content/processed/substack/${path.basename(candidate.file_path)}`;
    const sourceBytes = await read(processed), parsed = parseDocument(sourceBytes.toString("utf8"));
    if (parsed.metadata.id !== candidate.attributes.source_id || parsed.metadata.title !== candidate.attributes.title ||
        parsed.metadata.type !== "article" || String(parsed.metadata.rights_status) !== "review_required" ||
        parsed.metadata.source_url !== candidate.attributes.source_url ||
        parsed.metadata.source_post_id === "186952756" ||
        !Array.isArray(parsed.metadata.manual_review_flags) || parsed.metadata.manual_review_flags.length ||
        parsed.body + "\n" !== (await read(candidate.file_path)).toString("utf8")) {
      throw new Error(`Article source/metadata mismatch or excluded post: ${processed}`);
    }
    const result = cleanArticleUpload(parsed.body);
    const record = { ...candidate, file_path: `content/openai_upload/substack-cleaned/${path.basename(candidate.file_path)}` };
    const details = checkRecord(record, Buffer.from(result.markdown));
    add(record.file_path, result.markdown);
    articles.push(record);
    audits.push({ ...record, ...details, processed_path: processed, processed_sha256: sha256(sourceBytes),
      previous_candidate_path: candidate.file_path, previous_candidate_sha256: sha256(await read(candidate.file_path)),
      removed_subscription_paragraphs: result.removed,
      review_notes: ["Existing published-article extraction reused; no new crawl or expert-quote verification.",
        "General content/rights review remains outstanding; source text is not treated as a verbatim podcast transcript."],
      remaining_interface_prompt: /share in the comments/i.test(result.markdown) });
  }
  const existing = [...await records("manifests/book-openai_file_attributes.jsonl"), ...await records("manifests/podcasts-openai_file_attributes.jsonl")];
  for (const record of existing) {
    if (record.attributes.rights_status !== "approved") throw new Error("Existing source approval unexpectedly changed.");
    checkRecord(record, await read(record.file_path));
  }
  const additions = [...series, ...articles], replacement = [...existing, ...additions];
  const ids = replacement.map(record => record.attributes.source_id);
  if (new Set(ids).size !== ids.length || new Set(replacement.map(record => record.file_path)).size !== replacement.length ||
      new Set(replacement.map(record => record.openai_upload_filename)).size !== replacement.length) {
    throw new Error("Duplicate source ID, path or upload filename in replacement selection.");
  }
  add("manifests/series-assemblyai-openai_candidates.jsonl", jsonl(series));
  add("manifests/substack-cleaned-openai_candidates.jsonl", jsonl(articles));
  add("manifests/new-source-upload_candidates.jsonl", jsonl(additions));
  add("manifests/replacement-vector-store_candidates.jsonl", jsonl(replacement));
  const report = { schema_version: 1, stage: "packaged_pending_review_and_rights_approval", network_requests: 0,
    rights_status: "review_required", review_required: true, approved_for_upload: false,
    series_episodes: series.length, substack_articles: articles.length, new_documents: additions.length,
    existing_documents: existing.length, full_replacement_documents: replacement.length,
    subscription_paragraphs_removed: audits.reduce((sum, item) => sum + (item.removed_subscription_paragraphs?.length ?? 0), 0),
    series_dialogue_verified_against_segments: true, canonical_source_links_validated: true,
    attributes_including_generated_hash_within_limit: true,
    max_new_source_attribute_count: Math.max(...audits.map(item => item.attribute_count)),
    old_drive_series_candidates_included: false, unpublished_drafts_included: false, welcome_post_included: false,
    sources: audits };
  add("manifests/new-source-upload-preparation.json", encoded(report));
  const columns = ["source_id", "type", "title", "date", "file_path", "source_url", "rights_status", "words", "bytes", "attribute_count", "content_sha256", "review_notes"];
  const csv = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  add("manifests/new-source-upload-review.csv", [columns.map(csv).join(","), ...audits.map(item => [
    item.attributes.source_id, item.attributes.type, item.attributes.title, item.attributes.date, item.file_path,
    item.attributes.source_url, item.attributes.rights_status, item.words, item.bytes, item.attribute_count,
    item.content_sha256, item.review_notes.join(" | ")
  ].map(csv).join(","))].join("\n") + "\n");
  add("manifests/NEW-SOURCE-UPLOAD-README.md", ["# New source upload preparation", "",
    `${series.length} cleaned Series transcripts + ${articles.length} Substack articles = ${additions.length} new documents.`,
    `Full replacement candidate: ${existing.length} existing documents + ${additions.length} additions = ${replacement.length} documents.`, "",
    "## What is packaged", "",
    "- Timestamp-free Series dialogue, preserving bold full speaker names and Scott's Lori Q&A corrections.",
    "- Article text with only exact standalone subscription prompts removed; expert perspectives, reflection questions and resource context remain.",
    "- Stable source IDs, published page links, titles, publication dates, participants/authors and peer canonicality for new sources.",
    "- SHA-256 fingerprints and traceable processed-source/cleanup records. The uploader computes content_sha256 from actual uploaded bytes, not from a supplied attribute.",
    "- Older Drive-derived Series candidates, unpublished drafts and the welcome post are NOT included.", "",
    "## Review and approval", "",
    "Packaging is complete, not editorial or legal approval. Every new record remains rights_status=review_required and manual_review=true. Speaker identities remain unverified. The app intentionally refuses these candidate manifests.",
    "See new-source-upload-review.csv for one row per source and new-source-upload-preparation.json for exact hashes, review notes and removed article paragraphs.",
    "The known Sabrina, Vanessa and Lori wording flags remain; no speculative transcription corrections were made. Scott reviewed Lori's Q&A turns only, not the entire episode.",
    "For an internal prototype upload, first explicitly confirm the permitted use and acceptance of remaining quality limitations, then create a SEPARATE approved manifest for selected records. Do not claim full speaker verification or erase the audit flags.", "",
    "## Choose one selection", "",
    "- new-source-upload_candidates.jsonl: just the new Series + Substack content for an incremental sync.",
    "- replacement-vector-store_candidates.jsonl: existing book + Let's Talk Love + new content for a fresh store.",
    "- series-assemblyai-openai_candidates.jsonl / substack-cleaned-openai_candidates.jsonl: separate selections if desired.",
    "Do not combine the combined manifest with its individual manifests; that would duplicate sources. Do not include older real-love-ready-series-openai_candidates.jsonl alongside these AssemblyAI transcripts.",
    "Use the existing sync:content preview/apply workflow after approval, or ingest from an approved full-replacement manifest. A fresh store requires an explicit app configuration change; this preparation does not switch local or Railway stores.", "",
    "Original sources and earlier candidates are preserved. No API calls, vector-store modifications, account changes or commits were made.", ""
  ].join("\n"));
  await writeFiles(output);
  if (values["write-corpus"]) await writeFiles(corpus);
  console.log(`${series.length} Series + ${articles.length} articles prepared; ${replacement.length} documents in full replacement candidate.`);
  console.log(`${report.subscription_paragraphs_removed} standalone subscription prompts removed; all new source hashes and metadata validated.`);
  console.log(`Bundle: ${values["write-corpus"] ? corpus : output}`);
  console.log("New sources remain review-required. No API calls, uploads, live-store changes or commits.");
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
