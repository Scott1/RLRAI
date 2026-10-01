import { createHash } from "node:crypto";
import { PilotEpisode, transcriptionOptions, Utterance } from "./assemblyAi";

export interface SeriesEpisode extends PilotEpisode {
  episode_number: number;
  speakers_expected: number;
  audio_url: string;
  feed_duration_seconds: number;
  speaker_count_review_required?: boolean;
}

export function validateSeriesEpisodes(value: unknown): SeriesEpisode[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("No series episodes in inventory.");
  const slugs = new Set<string>(), numbers = new Set<number>();
  for (const item of value) {
    if (!item || !/^[a-z0-9-]+$/.test(item.slug) || typeof item.title !== "string" || !item.title.trim() ||
        typeof item.host !== "string" || !item.host.trim() || !Array.isArray(item.guests) ||
        !item.guests.length || item.guests.some((name: unknown) => typeof name !== "string" || !name.trim()) ||
        !Number.isInteger(item.episode_number) || item.episode_number < 1 ||
        !Number.isInteger(item.speakers_expected) || item.speakers_expected !== item.guests.length + 1 ||
        new Set([item.host, ...item.guests]).size !== item.speakers_expected ||
        !Number.isFinite(item.feed_duration_seconds) || item.feed_duration_seconds <= 0) {
      throw new Error("Invalid episode metadata or unconfirmed speaker count.");
    }
    if (item.speaker_count_review_required !== undefined && typeof item.speaker_count_review_required !== "boolean") {
      throw new Error("Speaker-review flag must be boolean.");
    }
    const page = new URL(item.page_url), audio = new URL(item.audio_url);
    if (page.origin !== "https://www.realloveready.com" || page.pathname !== `/real-love-ready-series/${item.slug}` ||
        audio.protocol !== "https:" || audio.username || audio.password) throw new Error("Unexpected episode URL.");
    if (slugs.has(item.slug) || numbers.has(item.episode_number)) throw new Error("Duplicate series episode.");
    slugs.add(item.slug); numbers.add(item.episode_number);
  }
  return value as SeriesEpisode[];
}

export function transcriptionFingerprint(audioSha256: string, episode: SeriesEpisode): string {
  return createHash("sha256").update(JSON.stringify({ sha256: audioSha256,
    options: transcriptionOptions(episode, episode.speakers_expected) })).digest("hex");
}

export function auditTranscript(episode: SeriesEpisode, utterances: Utterance[], durationSeconds: number): string[] {
  const flags: string[] = [];
  const expected = new Set([episode.host, ...episode.guests]);
  const labels = new Set(utterances.map(item => item.speaker));
  if (labels.size !== expected.size || [...labels].some(label => label === null || !expected.has(label))) {
    flags.push("Returned speaker names differ from the supplied participants.");
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) flags.push("Missing or invalid provider duration.");
  for (const [index, item] of utterances.entries()) {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end < item.start ||
        item.end > durationSeconds * 1000 + 1000 || (index > 0 && item.start < utterances[index - 1].start)) {
      flags.push("Invalid, out-of-order, or out-of-recording utterance timestamps."); break;
    }
  }
  const lastEnd = Math.max(...utterances.map(item => item.end));
  if (durationSeconds * 1000 - lastEnd > 30_000) flags.push("Final speech ends more than 30 seconds before recording end; check silence versus omissions.");
  return flags;
}
