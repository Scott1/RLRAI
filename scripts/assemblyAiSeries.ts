import "dotenv/config";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { validateUtterances } from "../src/transcription/assemblyAi";
import { auditTranscript, SeriesEpisode, transcriptionFingerprint, validateSeriesEpisodes } from "../src/transcription/series";

const { values } = parseArgs({ options: {
  run: { type: "boolean", default: false },
  prepare: { type: "boolean", default: false },
  root: { type: "string", default: ".rlr/assemblyai-series" },
  ffmpeg: { type: "string" },
  concurrency: { type: "string", default: "2" },
  "max-estimated-usd": { type: "string", default: "20" }
}});
const root = path.resolve(values.root!);
const output = path.join(root, "transcripts");
const pilotInput = path.resolve(".rlr/published-audio-pilot");
const pilotOutput = path.resolve(".rlr/assemblyai-pilot");
const ffmpeg = values.ffmpeg ?? process.env.FFMPEG_PATH ?? path.resolve(".rlr/audio-tools/node_modules/ffmpeg-static/ffmpeg.exe");
const rate = 0.33;
const concurrency = Number(values.concurrency);
const budget = Number(values["max-estimated-usd"]);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3 || !Number.isFinite(budget) || budget <= 0) {
  throw new Error("Use concurrency 1-3 and a positive estimated budget.");
}

async function json(file: string): Promise<any | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
async function save(file: string, value: unknown) {
  await fs.writeFile(file + ".tmp", JSON.stringify(value, null, 2) + "\n");
  await fs.rename(file + ".tmp", file);
}
async function exists(file: string) { return fs.access(file).then(() => true, () => false); }
async function sha(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function slugDirectory(episode: SeriesEpisode) { return `${episode.slug}-speakers-${episode.speakers_expected}`; }
async function execute(binary: string, args: string[], onLine?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true });
    let text = "", pending = "";
    const consume = (chunk: Buffer) => {
      const part = chunk.toString(); text += part;
      if (onLine) {
        pending += part;
        const lines = pending.split(/\r?\n/); pending = lines.pop()!;
        for (const line of lines) if (line.trim()) onLine(line);
      }
    };
    child.stdout.on("data", consume); child.stderr.on("data", consume);
    child.on("error", reject);
    child.on("close", code => {
      if (onLine && pending.trim()) onLine(pending);
      if (code === 0) resolve(text);
      else reject(new Error(`${path.basename(binary)} exited ${code}; see the recorded episode error/progress.`));
    });
  });
}

async function prepare(episode: SeriesEpisode) {
  const dir = path.join(root, "raw", episode.slug), source = path.join(dir, "source.mp3");
  await fs.mkdir(dir, { recursive: true });
  if (!await exists(source)) {
    const priorSource = path.join(pilotInput, "raw", episode.slug, "source.mp3");
    if (await exists(priorSource)) {
      const prior = await json(path.join(pilotInput, "raw", episode.slug, "audio-preparation.json"));
      if (!prior?.source_sha256 || await sha(priorSource) !== prior.source_sha256) throw new Error("Prior original recording hash mismatch.");
      await fs.copyFile(priorSource, source + ".part");
      await fs.rename(source + ".part", source);
      console.log(`[${episode.episode_number}] Reused original pilot audio: ${episode.slug}`);
    } else {
      console.log(`[${episode.episode_number}] Downloading original audio: ${episode.slug}`);
      const response = await fetch(episode.audio_url, { signal: AbortSignal.timeout(20 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`Audio download returned HTTP ${response.status}.`);
      const declaredBytes = Number(response.headers.get("content-length"));
      if (declaredBytes > 2_200_000_000) throw new Error("Recording exceeds upload limit.");
      let bytes = 0;
      const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > 2_200_000_000 ? new Error("Recording exceeds upload limit.") : null, chunk);
      }});
      await pipeline(Readable.fromWeb(response.body as any), limit, createWriteStream(source + ".part"));
      if (!bytes || (declaredBytes > 0 && bytes !== declaredBytes)) throw new Error("Incomplete audio download.");
      await fs.rename(source + ".part", source);
    }
  }
  const sourceHash = await sha(source);
  const previous = await json(path.join(dir, "audio-preparation.json"));
  if (previous && previous.source_sha256 !== sourceHash) throw new Error("Saved original recording changed; refusing to reuse transcription.");
  if (previous?.audio_url && previous.audio_url !== episode.audio_url) throw new Error("RSS enclosure changed; review source provenance before reuse.");
  const info = await execute(ffmpeg, ["-hide_banner", "-i", source, "-map", "0:a:0", "-t", "0", "-f", "null", "-"]);
  const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info);
  if (!match) throw new Error("Cannot determine original audio duration.");
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  if (seconds <= 0 || seconds > 3 * 3600) throw new Error("Unexpected recording duration; review before paid submission.");
  const result = { schema_version: 1, source_sha256: sourceHash, audio_url: episode.audio_url,
    acquisition: await exists(path.join(pilotInput, "raw", episode.slug, "source.mp3")) ? "reused_original_pilot_audio" : "official_rss_enclosure",
    duration_seconds: seconds, bytes: (await fs.stat(source)).size,
    compression: "none; original MP3 bytes", prepared_at: new Date().toISOString() };
  await save(path.join(dir, "audio-preparation.json"), result);
  console.log(`[${episode.episode_number}] Audio ready: ${(seconds / 60).toFixed(1)} minutes, ${(result.bytes / 1e6).toFixed(2)} MB`);
  return result;
}

async function reusePilot(episode: SeriesEpisode, audioHash: string): Promise<boolean> {
  const dir = path.join(output, slugDirectory(episode));
  if (await exists(path.join(dir, "state.json"))) return false;
  const priorDir = path.join(pilotOutput, slugDirectory(episode));
  const request = await json(path.join(priorDir, "request.json"));
  const state = await json(path.join(priorDir, "state.json"));
  const response = await json(path.join(priorDir, "response.json"));
  if (request?.audio_sha256 !== audioHash || state?.fingerprint !== transcriptionFingerprint(audioHash, episode) ||
      response?.status !== "completed" || response.id !== state.transcript_id) return false;
  validateUtterances(response.utterances);
  await fs.mkdir(dir, { recursive: true });
  for (const name of ["state.json", "request.json", "response.json"]) await fs.copyFile(path.join(priorDir, name), path.join(dir, name));
  await save(path.join(dir, "reused-pilot.json"), { source_directory: priorDir, transcript_id: response.id,
    audio_sha256: audioHash, reused_at: new Date().toISOString(), additional_transcription_charge: 0 });
  console.log(`[${episode.episode_number}] Reused completed pilot job; no new transcription charge.`);
  return true;
}

interface Progress {
  slug: string; episode_number: number; title: string; speakers_expected: number;
  status: string; estimated_usd?: number; transcript_id?: string; flags?: string[]; error?: string;
}

async function main() {
  const inventory = await json(path.join(root, "source-inventory.json"));
  const episodes = validateSeriesEpisodes(inventory?.episodes);
  const estimate = episodes.reduce((sum, episode) => sum + episode.feed_duration_seconds * rate / 3600, 0);
  console.log(`${episodes.length} published series episodes; ${inventory.blocked?.length ?? 0} blocked inventory items.`);
  console.log(`Full-series feed-based estimate: USD $${estimate.toFixed(2)}; reused jobs do not incur new charges.`);
  if (estimate > budget) throw new Error("Feed-based estimated charge exceeds the configured budget guard.");
  if (!values.run && !values.prepare) { console.log("Preview only. Use --prepare to download audio, or --run to prepare and transcribe."); return; }
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  const lockPath = path.join(root, "batch.lock");
  const lock = await fs.open(lockPath, "wx").catch(() => { throw new Error(`Batch locked. Verify the PID in ${lockPath} stopped before removing a stale lock.`); });
  await lock.writeFile(String(process.pid));
  const progress: Progress[] = episodes.map(episode => ({ slug: episode.slug, title: episode.title,
    episode_number: episode.episode_number, speakers_expected: episode.speakers_expected, status: "pending" }));
  let writing = Promise.resolve();
  const persist = () => {
    const snapshot = { updated_at: new Date().toISOString(), phase: values.run ? "transcribe" : "prepare",
      review_required: true, episodes: structuredClone(progress), blocked: inventory.blocked ?? [] };
    writing = writing.then(() => save(path.join(root, "batch-progress.json"), snapshot));
    return writing;
  };
  try {
    let next = 0;
    const preparation = new Map<string, any>();
    // Prepare every input before making paid requests, so total duration/cost is known.
    await Promise.all(Array.from({ length: Math.min(concurrency, episodes.length) }, async () => {
      while (next < episodes.length) {
        const index = next++, episode = episodes[index]; progress[index].status = "preparing";
        await persist();
        try {
          preparation.set(episode.slug, await prepare(episode)); progress[index].status = "audio_ready";
        } catch (error) {
          progress[index].status = "failed_preparation";
          progress[index].error = error instanceof Error ? error.message : String(error);
          console.error(`[${episode.episode_number}] Preparation failed: ${progress[index].error}`);
        }
        await persist();
      }
    }));
    await persist();
    const actualEstimate = [...preparation.values()].reduce((sum, audio) => sum + audio.duration_seconds * rate / 3600, 0);
    console.log(`Downloaded-audio full-series estimate: USD $${actualEstimate.toFixed(2)} before reused jobs, credits/tax.`);
    if (actualEstimate > budget) throw new Error("Downloaded-audio estimate exceeds budget guard; no new API submissions made.");
    let reused = 0;
    if (values.run) {
      for (const episode of episodes) {
        const audio = preparation.get(episode.slug);
        if (audio && await reusePilot(episode, audio.source_sha256)) reused++;
      }
      next = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, episodes.length) }, async () => {
        while (next < episodes.length) {
          const index = next++, episode = episodes[index];
          const audio = preparation.get(episode.slug);
          if (!audio) continue;
          const cached = await json(path.join(output, slugDirectory(episode), "response.json"));
          if (episode.speaker_count_review_required && cached?.status !== "completed") {
            progress[index].status = "blocked_speaker_review";
            progress[index].flags = ["Audience/Q&A voices need review before using an exact interview-speaker count."];
            await persist(); continue;
          }
          progress[index].status = "transcribing";
          await persist();
          try {
            await execute(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("scripts/assemblyAiPilot.ts"),
              "--episode", episode.slug, "--input-root", root, "--output-root", output,
              "--speakers-expected", String(episode.speakers_expected), "--run"], line => console.log(`[${episode.episode_number}] ${line}`));
            const dir = path.join(output, slugDirectory(episode));
            const response = await json(path.join(dir, "response.json"));
            const segments = await json(path.join(dir, "segments.json"));
            const summary = await json(path.join(dir, "summary.json"));
            if (response?.status !== "completed" || segments?.audio_sha256 !== audio.source_sha256) throw new Error("Completed output/hash verification failed.");
            const utterances = validateUtterances(segments.utterances);
            const flags = auditTranscript(episode, utterances, response.audio_duration);
            if (episode.speaker_count_review_required) flags.push("Audience/Q&A voices are not covered by the named interview-speaker count; review attribution before ingestion.");
            if (summary?.identification?.status !== "success") flags.push("Name identification did not report success.");
            if (Math.abs(response.audio_duration - audio.duration_seconds) > 5) flags.push("Provider duration differs from the downloaded audio by more than five seconds.");
            await save(path.join(dir, "structural-audit.json"), { checked_at: new Date().toISOString(),
              flags, utterances: utterances.length, expected_names: [episode.host, ...episode.guests],
              actual_labels: [...new Set(utterances.map(item => item.speaker))], review_required: true,
              speaker_identity_verified: false, full_listening_review_performed: false });
            progress[index].status = flags.length ? "completed_with_flags" : "completed_review_required";
            progress[index].transcript_id = response.id; progress[index].flags = flags;
            progress[index].estimated_usd = response.audio_duration * rate / 3600;
          } catch (error) {
            progress[index].status = "failed_transcription";
            progress[index].error = error instanceof Error ? error.message : String(error);
            console.error(`[${episode.episode_number}] Transcription failed; saved job state is retained.`);
          }
          await persist();
        }
      }));
    }
    await persist();
    const failures = progress.filter(item => item.status.startsWith("failed"));
    const completed = progress.filter(item => item.status.startsWith("completed"));
    const rows = progress.map(item => `| ${item.episode_number} | ${item.title.replace(/\|/g, "\\|")} | ${item.speakers_expected} | ${item.status} | ${item.flags?.join("; ") || item.error || ""} |`);
    await fs.writeFile(path.join(root, "BATCH-REVIEW.md"), [
      "# Real Love Ready series transcription batch", "",
      `Published episodes: ${episodes.length}. Completed transcripts: ${completed.length}. Failed: ${failures.length}.`,
      `Completed pilot jobs imported this run: ${reused}. Inventory items blocked: ${inventory.blocked?.length ?? 0}.`,
      `Original downloaded audio total: ${([...preparation.values()].reduce((sum, audio) => sum + audio.duration_seconds, 0) / 3600).toFixed(2)} hours.`,
      `Full-series estimated list cost (including reused pilots): USD $${actualEstimate.toFixed(2)} at $${rate}/hour. Not a vendor invoice.`, "",
      "Original audio preserved without compression or edits. Exact counts cover interview participants, not advertising voices.",
      "Raw transcripts retain ads and inferred names. Structural checks are not listening or accuracy verification.",
      "No Companion/vector-store changes. Text cleanup and attribution review remain required before ingestion.", "",
      "| Episode | Title | Interview speakers | Status | Structural flags / error |", "| --- | --- | --- | --- | --- |", ...rows, "",
      "## Files", "",
      "`raw/<slug>/source.mp3`: original audio and source/provenance metadata.",
      "`transcripts/<slug>-speakers-N/`: raw response, readable transcript, segments, request, saved job state and audit.",
      "`source-inventory.json`: episode-page/RSS matches, participant evidence and blocked items.",
      "`discovery/`: original catalog/feed snapshots.", "",
      "## Review and cleanup", "",
      "Remove ads and recording clutter from a separate text copy. Some utterances combine advertising with substantive discussion; use partial cuts.",
      "Keep useful introductions, qualifications, resource context and recap distinct from expert interview teaching.",
      "Spot-check audio for short/overlapping exchanges, names and uncertain wording. Never infer correctness from a clean label set alone.",
      "Retain timestamps and raw outputs for review; eventual upload dialogue can omit timestamps.", "",
      "Sources: https://www.realloveready.com/real-love-ready-series ; https://feeds.megaphone.fm/SBP3892967148 ; https://www.assemblyai.com/pricing", ""
    ].join("\n"));
    console.log(`Batch finished: ${completed.length}/${episodes.length} transcripts, ${failures.length} failures. Report: ${path.join(root, "BATCH-REVIEW.md")}`);
    if (failures.length) process.exitCode = 1;
  } finally { await lock.close(); await fs.unlink(lockPath); }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
