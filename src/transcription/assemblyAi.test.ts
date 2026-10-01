import assert from "node:assert/strict";
import test from "node:test";
import { transcriptionOptions, validateUtterances, renderTranscript, selectSpeakerIdentification } from "./assemblyAi";

const episode = { slug: "test", title: "Test episode", host: "Robin", guests: ["Silvy", "Bryan"], page_url: "https://example.com/episode" };

test("requests exact model, whole-job diarization and medium effort with all supplied names", () => {
  const options = transcriptionOptions(episode);
  assert.deepEqual(options.speech_models, ["universal-3-5-pro"]);
  assert.equal(options.speaker_labels, true);
  assert.equal(options.speech_understanding.request.speaker_identification.effort, "medium");
  assert.deepEqual(options.speech_understanding.request.speaker_identification.speakers.map(item => item.name), ["Robin", "Silvy", "Bryan"]);
  assert.equal("speakers_expected" in options, false); // Ads can contain additional voices.
});

test("rejects malformed or absent utterances rather than manufacturing a speaker transcript", () => {
  for (const value of [undefined, [], [{ start: 5, end: 2, text: "test", speaker: "A" }], [{ start: NaN, end: 2, text: "test", speaker: "A" }]]) {
    assert.throws(() => validateUtterances(value));
  }
});

test("speaker-count experiment adds only the requested exact count", () => {
  assert.deepEqual(transcriptionOptions(episode, 3), { speakers_expected: 3, ...transcriptionOptions(episode) });
  for (const count of [0, -1, 1.5, NaN]) assert.throws(() => transcriptionOptions(episode, count));
});

test("renders millisecond timestamps without treating inferred names as verified", () => {
  const utterances = validateUtterances([{ start: 3_661_000, end: 3_665_000, speaker: "Robin", text: "Exact words." }, { start: 3_665_000, end: 3_666_000, speaker: null, text: "Yes." }]);
  const output = renderTranscript(episode, utterances);
  assert.match(output, /01:01:01-01:01:05/);
  assert.match(output, /Robin: Exact words\./);
  assert.match(output, /Unknown speaker: Yes\./);
  assert.match(output, /speaker_identity_verified: false/);
});

test("identification-only recovery must match the job/settings and preserve dialogue/times", () => {
  const config = { speaker_identification: { speaker_type: "name", speakers: [{ name: "Robin" }] } };
  const original = { id: "job", utterances: [{ start: 0, end: 5, speaker: "A", text: "Words." }],
    speech_understanding: { request: config, response: { speaker_identification: { status: "failure" } } } };
  const request = { transcript_id: "job", speech_understanding: { request: config } };
  const response = { utterances: [{ start: 0, end: 5, speaker: "Robin", text: "Words." }],
    speech_understanding: { response: { speaker_identification: { status: "success" } } } };
  assert.equal(selectSpeakerIdentification(original).recoveryApplied, false);
  assert.equal(selectSpeakerIdentification(original, request, response).recoveryApplied, true);
  assert.throws(() => selectSpeakerIdentification(original, { ...request, transcript_id: "other" }, response));
  assert.throws(() => selectSpeakerIdentification(original, request, { ...response, utterances: [{ start: 0, end: 6, speaker: "Robin", text: "Words." }] }));
  assert.throws(() => selectSpeakerIdentification(original, request, { ...response, utterances: [{ start: 0, end: 5, speaker: "Robin", text: "Different." }] }));
});
