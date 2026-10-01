import assert from "node:assert/strict";
import test from "node:test";
import { validateSeriesEpisodes, transcriptionFingerprint, auditTranscript } from "./series";
import { transcriptionOptions } from "./assemblyAi";
import { createHash } from "node:crypto";

const episode = { slug: "test", title: "Episode", host: "Robin", guests: ["Guest"], episode_number: 1,
  speakers_expected: 2, audio_url: "https://example.com/audio.mp3", feed_duration_seconds: 120,
  page_url: "https://www.realloveready.com/real-love-ready-series/test" };

test("series metadata requires unique known participants, matching counts and canonical URLs", () => {
  assert.deepEqual(validateSeriesEpisodes([episode]), [episode]);
  for (const item of [{ ...episode, slug: "../bad" }, { ...episode, speakers_expected: 3 },
    { ...episode, guests: ["Robin"] }, { ...episode, audio_url: "http://example.com/audio.mp3" },
    { ...episode, page_url: "https://example.com/test" }, { ...episode, feed_duration_seconds: 0 },
    { ...episode, speaker_count_review_required: "false" }]) {
    assert.throws(() => validateSeriesEpisodes([item]));
  }
  assert.throws(() => validateSeriesEpisodes([episode, episode]));
  assert.throws(() => validateSeriesEpisodes([]));
});

test("batch fingerprints match existing pilots and change when audio or participants change", () => {
  const hash = "a".repeat(64);
  const expected = createHash("sha256").update(JSON.stringify({ sha256: hash, options: transcriptionOptions(episode, 2) })).digest("hex");
  assert.equal(transcriptionFingerprint(hash, episode), expected);
  assert.notEqual(transcriptionFingerprint("b".repeat(64), episode), expected);
  assert.notEqual(transcriptionFingerprint(hash, { ...episode, guests: ["Other"] }), expected);
});

test("transcript audit flags attribution mismatch and timing issues without approving identities", () => {
  const good = [{ start: 1000, end: 40_000, speaker: "Robin", text: "Question" },
    { start: 40_000, end: 119_000, speaker: "Guest", text: "Answer" }];
  assert.deepEqual(auditTranscript(episode, good, 120), []);
  assert.match(auditTranscript(episode, [{ ...good[0], speaker: "A" }, good[1]], 120).join(" "), /names/);
  assert.match(auditTranscript(episode, [good[1], good[0]], 120).join(" "), /timestamps/);
  assert.match(auditTranscript(episode, good, 200).join(" "), /30 seconds/);
});
