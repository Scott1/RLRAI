import "dotenv/config";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { PilotEpisode, transcriptionOptions, selectSpeakerIdentification, renderTranscript } from "../src/transcription/assemblyAi";

interface State {
  fingerprint: string;
  upload_url?: string;
  transcript_id?: string;
  submission_started?: boolean;
}

async function loadJson(file: string): Promise<any | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}

async function save(file: string, value: unknown) {
  await fs.writeFile(file + ".tmp", JSON.stringify(value, null, 2) + "\n");
  await fs.rename(file + ".tmp", file);
}

async function main() {
  const { values } = parseArgs({ options: {
    run: { type: "boolean", default: false },
    episode: { type: "string", default: "what-is-love-really" },
    "speakers-expected": { type: "string" },
    "output-root": { type: "string", default: ".rlr/assemblyai-pilot" },
    "input-root": { type: "string", default: ".rlr/assemblyai-series" }
  }});
  const root = path.resolve(values["input-root"]!);
  const inventory = await loadJson(path.join(root, "source-inventory.json"));
  const episode: PilotEpisode | undefined = inventory?.episodes.find((item: PilotEpisode) => item.slug === values.episode);
  if (!episode || !/^[a-z0-9-]+$/.test(episode.slug)) throw new Error("Episode not found in the selected source inventory.");
  const input = path.join(root, "raw", episode.slug, "source.mp3");
  const size = (await fs.stat(input)).size;
  if (size > 2_200_000_000) throw new Error("Recording exceeds AssemblyAI's direct-upload limit.");
  const hash = createHash("sha256");
  for await (const part of createReadStream(input)) hash.update(part);
  const sha256 = hash.digest("hex");
  const preparation = await loadJson(path.join(root, "raw", episode.slug, "audio-preparation.json"));
  if (preparation?.source_sha256 && preparation.source_sha256 !== sha256) throw new Error("Original recording hash no longer matches the pilot.");
  const speakersExpected = values["speakers-expected"] === undefined ? undefined : Number(values["speakers-expected"]);
  const options = transcriptionOptions(episode, speakersExpected);
  const fingerprint = createHash("sha256").update(JSON.stringify({ sha256, options })).digest("hex");
  const hours = preparation?.duration_seconds / 3600;
  console.log(`Episode: ${episode.title}\nOriginal file: ${input}\nSize: ${(size / 1e6).toFixed(2)} MB`);
  console.log("Model: Universal-3.5 Pro; diarization + medium-effort speaker identification.");
  if (Number.isFinite(hours)) console.log(`Estimated API charge: USD $${(hours * 0.33).toFixed(2)} (list prices, before credits/tax).`);
  if (speakersExpected !== undefined) console.log(`Exact speaker constraint: ${speakersExpected}. Extra ad voices may be merged into these labels.`);
  const out = path.resolve(values["output-root"]!, episode.slug + (speakersExpected === undefined ? "" : `-speakers-${speakersExpected}`));
  console.log(`Results: ${out}`);
  if (!values.run) { console.log("Preview only. No API request. Add --run when your key is ready."); return; }
  const key = process.env.ASSEMBLYAI_API_KEY?.trim();
  if (!key) throw new Error("Add ASSEMBLYAI_API_KEY to your local .env file first.");
  await fs.mkdir(out, { recursive: true });
  const lockPath = path.join(out, "run.lock");
  const lock = await fs.open(lockPath, "wx").catch(() => { throw new Error(`Pilot already locked. Verify the PID in ${lockPath} has stopped before removing a stale lock.`); });
  await lock.writeFile(String(process.pid));
  try {
    const statePath = path.join(out, "state.json");
    const state: State = await loadJson(statePath) ?? { fingerprint };
    if (state.fingerprint !== fingerprint) throw new Error("Cached recording/settings changed; use a separate output directory before starting another paid job.");
    await save(path.join(out, "request.json"), { episode, input, bytes: size, audio_sha256: sha256, options, estimated_usd: Number.isFinite(hours) ? hours * 0.33 : null });
    const request = async (endpoint: string, init: RequestInit = {}, timeout = 120_000): Promise<any> => {
      const response = await fetch(`https://api.assemblyai.com/v2/${endpoint}`, {
        ...init, headers: { authorization: key, ...init.headers }, signal: AbortSignal.timeout(timeout), redirect: "error"
      });
      if (!response.ok) {
        // Vendor response bodies can contain URLs or credentials; keep console errors minimal.
        throw new Error(`AssemblyAI ${endpoint.split("/")[0]} returned HTTP ${response.status}. Check the vendor dashboard; no automatic submission retry was made.`);
      }
      return response.json();
    };
    if (!state.upload_url) {
      console.log("Uploading original recording, unchanged...");
      const result = await request("upload", {
        method: "POST", headers: { "content-type": "application/octet-stream" },
        body: createReadStream(input) as unknown as RequestInit["body"], duplex: "half"
      } as RequestInit, 30 * 60_000);
      if (typeof result.upload_url !== "string") throw new Error("Upload response missing URL.");
      state.upload_url = result.upload_url;
      await save(statePath, state);
    }
    if (!state.transcript_id) {
      if (state.submission_started) throw new Error("Prior submission outcome is uncertain. Check AssemblyAI's dashboard before retrying to avoid a duplicate paid job.");
      state.submission_started = true;
      await save(statePath, state);
      console.log("Submitting full-episode transcription job...");
      const result = await request("transcript", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio_url: state.upload_url, ...options })
      });
      if (typeof result.id !== "string") throw new Error("Submission response missing job ID.");
      state.transcript_id = result.id;
      await save(statePath, state);
    }
    const transcriptId = state.transcript_id;
    if (!transcriptId) throw new Error("Missing saved job ID.");
    console.log(`Job ID: ${transcriptId}. Rerun the same command to resume.`);
    let result = await loadJson(path.join(out, "response.json"));
    if (result && result.id !== transcriptId) throw new Error("Saved provider response belongs to a different job.");
    const deadline = Date.now() + 2 * 60 * 60_000;
    let previousStatus;
    while (result?.status !== "completed") {
      result = await request(`transcript/${encodeURIComponent(transcriptId)}`);
      if (result.id !== transcriptId) throw new Error("Provider returned a different transcript job.");
      if (result.status !== previousStatus) console.log(`Status: ${result.status}`);
      previousStatus = result.status;
      if (result.status === "completed" || result.status === "error") {
        await save(path.join(out, "response.json"), result);
        if (result.status === "error") throw new Error("AssemblyAI job failed. See the saved raw response and vendor dashboard; it will not be resubmitted automatically.");
        break;
      }
      if (Date.now() > deadline) throw new Error("Stopped waiting after two hours; saved job can be resumed.");
      await sleep(15_000);
    }
    const recoveryRequest = await loadJson(path.join(out, "identification-retry", "request.json"));
    const recoveryResponse = await loadJson(path.join(out, "identification-retry", "response.json"));
    const selected = selectSpeakerIdentification(result, recoveryRequest, recoveryResponse);
    const identified = selected.identification;
    const utterances = selected.utterances;
    if (selected.recoveryApplied) console.log("Applied successful identification-only recovery; original response preserved unchanged.");
    if (identified?.status !== "success") console.log("Warning: name identification did not report success. Review the raw response; speaker labels may still be generic.");
    await fs.writeFile(path.join(out, "transcript.md"), renderTranscript(episode, utterances));
    await save(path.join(out, "segments.json"), { episode, audio_sha256: sha256, review_required: true,
      speaker_identity_verified: false, timestamp_unit: "milliseconds", utterances });
    await save(path.join(out, "summary.json"), { transcript_id: result.id, audio_duration: result.audio_duration,
      model_used: result.speech_model_used, labels: [...new Set(utterances.map(item => item.speaker))],
      utterances: utterances.length, identification: identified ?? null,
      identification_recovery_applied: selected.recoveryApplied, review_required: true });
    await fs.writeFile(path.join(out, "REVIEW.md"), "# Review before ingestion\n\nCompare the start, middle and end against source.mp3. Check host/guest identities, ads and other voices, overlapping turns, guest names, quoted wording and timestamp coverage. Named labels are inferred, not verified. No ads were removed. No OpenAI upload was made. The raw response preserves vendor metadata and original output.\n");
    console.log("Saved raw response, timestamped transcript, segment records and review checklist. No vector-store changes.");
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
