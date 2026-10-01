import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { validateSeriesEpisodes } from "../src/transcription/series";

const { values } = parseArgs({ options: {
  root: { type: "string", default: ".rlr/assemblyai-series" },
  "corpus-root": { type: "string", default: "../rlr-ai-companion-corpus" }
}});
const root = path.resolve(values.root!), corpus = path.resolve(values["corpus-root"]!);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const encoded = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

async function main() {
  if (root === corpus || !await fs.stat(path.join(corpus, ".git")).then(() => true, () => false)) {
    throw new Error("Archive target must be the existing separate private corpus checkout.");
  }
  const inventory = JSON.parse(await fs.readFile(path.join(root, "source-inventory.json"), "utf8"));
  const progress = JSON.parse(await fs.readFile(path.join(root, "batch-progress.json"), "utf8"));
  const episodes = validateSeriesEpisodes(inventory.episodes);
  const destinations: { file: string; data: string | Buffer }[] = [];
  const files: { slug: string; response_sha256: string; archived_response_sha256: string; audio_sha256: string }[] = [];
  const omittedFields = ["audio_url", "webhook_url", "webhook_auth_header_name", "webhook_auth_header_value"];
  const add = (relative: string, data: string | Buffer) => {
    const file = path.resolve(corpus, relative);
    if (!file.startsWith(corpus + path.sep)) throw new Error("Archive path escaped corpus root.");
    destinations.push({ file, data });
  };
  for (const episode of episodes) {
    const tracked = progress.episodes.find((item: { slug: string; status: string }) => item.slug === episode.slug);
    if (!tracked?.status.startsWith("completed")) throw new Error(`Episode not completed: ${episode.slug}. No files were archived.`);
    const out = path.join(root, "transcripts", `${episode.slug}-speakers-${episode.speakers_expected}`);
    const raw = `content/raw/real-love-ready-series/assemblyai/${episode.slug}`;
    const processed = `content/processed/real-love-ready-series/assemblyai/${episode.slug}`;
    const responseBytes = await fs.readFile(path.join(out, "response.json"));
    const response = JSON.parse(responseBytes.toString("utf8"));
    if (response.status !== "completed") throw new Error("Raw provider response is not completed.");
    for (const key of omittedFields) delete response[key];
    const archivedBytes = encoded(response);
    const request = JSON.parse(await fs.readFile(path.join(out, "request.json"), "utf8"));
    const audio = JSON.parse(await fs.readFile(path.join(root, "raw", episode.slug, "audio-preparation.json"), "utf8"));
    if (request.audio_sha256 !== audio.source_sha256) throw new Error("Archive audio provenance mismatch.");
    add(`${raw}/response.json`, archivedBytes);
    add(`${raw}/request.json`, encoded({ episode: request.episode, options: request.options,
      bytes: request.bytes, audio_sha256: request.audio_sha256, estimated_usd: request.estimated_usd }));
    for (const name of ["request.json", "response.json"]) {
      try {
        const recovery = JSON.parse(await fs.readFile(path.join(out, "identification-retry", name), "utf8"));
        for (const key of [...omittedFields, "input"]) delete recovery[key];
        add(`${raw}/identification-retry/${name}`, encoded(recovery));
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    add(`${raw}/summary.json`, await fs.readFile(path.join(out, "summary.json")));
    add(`${raw}/audio-preparation.json`, encoded(audio));
    add(`${raw}/source.json`, await fs.readFile(path.join(root, "raw", episode.slug, "source.json")));
    add(`${raw}/episode-page.json`, await fs.readFile(path.join(root, "raw", episode.slug, "episode-page.json")));
    add(`${raw}/episode-page-text.txt`, await fs.readFile(path.join(root, "raw", episode.slug, "episode-page-text.txt")));
    add(`${raw}/archive-provenance.json`, encoded({ provider: "assemblyai", transcript_id: response.id,
      response_sha256: digest(responseBytes), archived_response_sha256: digest(archivedBytes),
      omitted_response_fields: omittedFields, omitted_request_fields: ["input"],
      audio_sha256: audio.source_sha256, review_required: true, speaker_identity_verified: false,
      original_audio_location: "Companion app local cache: .rlr/assemblyai-series/raw/<slug>/source.mp3",
      original_response_location: "Companion app local cache: .rlr/assemblyai-series/transcripts/<slug>-speakers-N/response.json" }));
    add(`${processed}.md`, await fs.readFile(path.join(out, "transcript.md")));
    add(`${processed}.segments.json`, await fs.readFile(path.join(out, "segments.json")));
    add(`${processed}.audit.json`, await fs.readFile(path.join(out, "structural-audit.json")));
    try { add(`${processed}.review.md`, await fs.readFile(path.join(out, "CONTENT-REVIEW.md"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    files.push({ slug: episode.slug, response_sha256: digest(responseBytes),
      archived_response_sha256: digest(archivedBytes), audio_sha256: audio.source_sha256 });
  }
  for (const file of ["source-inventory.json", "batch-progress.json", "BATCH-REVIEW.md"]) {
    add(`manifests/assemblyai-series/${file}`, await fs.readFile(path.join(root, file)));
  }
  try { add("manifests/assemblyai-series/CONTENT-REVIEW.md", await fs.readFile(path.join(root, "CONTENT-REVIEW.md"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { add("manifests/assemblyai-series/validation.json", await fs.readFile(path.join(root, "validation.json"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const file of await fs.readdir(path.join(root, "discovery"))) {
    if (!/^(index-page-\d+\.json|podcast-feed\.xml)$/.test(file)) continue;
    add(`content/raw/real-love-ready-series/assemblyai/discovery/${file}`, await fs.readFile(path.join(root, "discovery", file)));
  }
  add("manifests/assemblyai-series/archive-manifest.json", encoded({ schema_version: 1, provider: "assemblyai",
    review_required: true, speaker_identity_verified: false, episodes: files,
    excluded: ["original MP3s", "vendor upload URLs and job state", "credentials", "absolute local request paths"] }));
  add("manifests/assemblyai-series/README.md", [
    "# AssemblyAI full-series review drafts", "",
    "This archive contains published Real Love Ready: The Series recordings transcribed from the original audio with known interview participants.",
    "Raw responses preserve provider wording, utterances, word timestamps and metadata, except private audio/webhook URLs and webhook credentials.",
    "The original byte-for-byte vendor responses and MP3s remain in the Companion app's ignored `.rlr/assemblyai-series` cache.",
    "Response and audio hashes in the archive manifest/provenance files establish which originals were used.", "",
    "`content/raw/real-love-ready-series/assemblyai/`: provider results, source metadata, audio hashes and website/feed snapshots.",
    "`content/processed/real-love-ready-series/assemblyai/`: readable timestamped review drafts, segments and structural audits.",
    "These drafts retain ads. They are not cleaned, human-approved, rights-approved, or added to an ingestion manifest.",
    "Speaker names are inferred and remain unverified; exact speaker counts can mislabel advertising voices and brief interjections.",
    "Keep this private archive separate from existing Drive-derived, OpenAI pilot and upload-ready files.",
    "Do not commit large original MP3s to ordinary Git; use private media storage or Git LFS for remote audio archival.", ""
  ].join("\n"));

  // Preflight every destination to preserve any previously archived or hand-edited drafts.
  for (const { file, data } of destinations) {
    try {
      const existing = await fs.readFile(file);
      if (digest(existing) !== digest(data)) throw new Error(`Archive destination already differs: ${file}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const { file, data } of destinations) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, data, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  console.log(`Archived ${episodes.length} review drafts and ${destinations.length} supporting files into the separate corpus repo.`);
  console.log("No original audio, private vendor URLs, credentials, vector-store updates or commits were included.");
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
