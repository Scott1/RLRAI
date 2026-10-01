import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { renderTranscript, selectSpeakerIdentification } from "../src/transcription/assemblyAi";
import { auditTranscript, transcriptionFingerprint, validateSeriesEpisodes } from "../src/transcription/series";

const { values } = parseArgs({ options: { root: { type: "string", default: ".rlr/assemblyai-series" } } });
const root = path.resolve(values.root!);
async function json(file: string): Promise<any> { return JSON.parse(await fs.readFile(file, "utf8")); }
async function optional(file: string) {
  try { return await json(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function sha(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const inventory = await json(path.join(root, "source-inventory.json"));
  const episodes = validateSeriesEpisodes(inventory.episodes);
  const progress = await json(path.join(root, "batch-progress.json"));
  const records = [];
  for (const episode of episodes) {
    const dir = path.join(root, "transcripts", `${episode.slug}-speakers-${episode.speakers_expected}`);
    const input = path.join(root, "raw", episode.slug);
    const request = await json(path.join(dir, "request.json"));
    const state = await json(path.join(dir, "state.json"));
    const response = await json(path.join(dir, "response.json"));
    const segments = await json(path.join(dir, "segments.json"));
    const summary = await json(path.join(dir, "summary.json"));
    const preparation = await json(path.join(input, "audio-preparation.json"));
    const recoveryRequest = await optional(path.join(dir, "identification-retry", "request.json"));
    const recoveryResponse = await optional(path.join(dir, "identification-retry", "response.json"));
    const selected = selectSpeakerIdentification(response, recoveryRequest, recoveryResponse);
    const actualHash = await sha(path.join(input, "source.mp3"));
    assert.equal(actualHash, preparation.source_sha256);
    assert.equal(actualHash, request.audio_sha256);
    assert.equal(actualHash, segments.audio_sha256);
    assert.equal(state.fingerprint, transcriptionFingerprint(actualHash, episode));
    assert.equal(response.id, state.transcript_id);
    assert.equal(response.status, "completed");
    assert.equal(response.speech_model_used, "universal-3-5-pro");
    assert.equal(request.options.speakers_expected, episode.speakers_expected);
    assert.deepEqual(segments.utterances, selected.utterances);
    assert.equal(segments.speaker_identity_verified, false);
    assert.equal(summary.identification.status, "success");
    assert.equal(summary.identification_recovery_applied, selected.recoveryApplied);
    assert.equal(summary.transcript_id, response.id);
    assert.equal(await fs.readFile(path.join(dir, "transcript.md"), "utf8"), renderTranscript(episode, selected.utterances));
    const flags = auditTranscript(episode, selected.utterances, response.audio_duration);
    assert.deepEqual(flags, []);
    assert.ok(Math.abs(preparation.duration_seconds - response.audio_duration) <= 5);
    assert.ok(progress.episodes.find((item: any) => item.slug === episode.slug)?.status.startsWith("completed"));
    const reused = await optional(path.join(dir, "reused-pilot.json"));
    records.push({ slug: episode.slug, transcript_id: response.id, audio_sha256: actualHash,
      duration_seconds: response.audio_duration, utterances: selected.utterances.length,
      names: summary.labels, reused_pilot: Boolean(reused), identification_recovery_applied: selected.recoveryApplied,
      additional_transcription_estimate_usd: reused ? 0 : response.audio_duration / 3600 * 0.33,
      identification_retry_estimate_usd: recoveryRequest?.estimated_usd ?? 0,
      speaker_count_review_required: Boolean(episode.speaker_count_review_required) });
    console.log(`[${episode.episode_number}/${episodes.length}] Validated audio hash, cached job and rendered draft: ${episode.slug}`);
  }
  const result = { checked_at: new Date().toISOString(), episodes: records, completed: records.length,
    reused_pilots: records.filter(item => item.reused_pilot).length,
    recovered_identification_jobs: records.filter(item => item.identification_recovery_applied).length,
    audience_speaker_review_required: records.filter(item => item.speaker_count_review_required).map(item => item.slug),
    total_audio_hours: records.reduce((sum, item) => sum + item.duration_seconds, 0) / 3600,
    additional_estimated_usd: records.reduce((sum, item) => sum + item.additional_transcription_estimate_usd + item.identification_retry_estimate_usd, 0),
    full_listening_review_performed: false, speaker_identity_verified: false, review_required: true };
  await fs.writeFile(path.join(root, "validation.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(`Validated ${result.completed} drafts; ${result.reused_pilots} reused pilots, ${result.recovered_identification_jobs} identification recovery, estimated additional USD $${result.additional_estimated_usd.toFixed(2)}.`);
  console.log("Structural validation does not verify exact wording or speaker identities. Ads and content review remain outstanding.");
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
