import assert from "node:assert/strict";
import test from "node:test";
import { applyCuts, resolveCuts, renderCleanTranscript, type CleanupCut } from "./cleanup";

const original = [{ start: 100, end: 5000, speaker: "Guest", text: "Yeah. Buy things now. What did you learn?" },
  { start: 5000, end: 8000, speaker: "Host", text: "Therapy helped me. My book explores boundaries." }];
const cut: CleanupCut = { utterance_id: "u0000", kind: "span", first_text: "Buy things", last_text: "now.",
  category: "advertisement", reason: "Sponsor interruption" };

test("partial cleanup preserves exact adjacent dialogue, speaker labels and original timing", () => {
  const result = applyCuts(original, [cut]);
  assert.deepEqual(result.fragments.map(item => item.text), ["Yeah. ", " What did you learn?", original[1].text]);
  assert.equal(result.originalCharacters, result.removedCharacters + result.keptCharacters);
  assert.equal(result.fragments[0].speaker, original[0].speaker);
  assert.equal(result.fragments[1].start, original[0].start);
  assert.equal(result.fragments[1].end, original[0].end);
  assert.equal(result.cuts[0].removed_text, "Buy things now.");
});

test("cleanup rejects ambiguous, stale, reversed, overlapping and invalid cuts", () => {
  for (const invalid of [{ ...cut, first_text: "missing" }, { ...cut, utterance_id: "u0007" },
    { ...cut, first_text: "What did", last_text: "Yeah." }, { ...cut, kind: "whole" as const },
    { ...cut, utterance_id: "u00" }]) assert.throws(() => resolveCuts(original, [invalid]));
  assert.throws(() => resolveCuts(original, [cut, cut]));
  assert.throws(() => resolveCuts([{ ...original[0], text: "Buy things now. Buy things now." }], [cut]));
});

test("whole cuts require explicit selection; rendering remains unapproved and timestamp-free", () => {
  const whole: CleanupCut = { ...cut, kind: "whole", first_text: "", last_text: "" };
  assert.deepEqual(applyCuts(original, [whole]).fragments.map(item => item.text), [original[1].text]);
  const rendered = renderCleanTranscript({ slug: "test", title: "Test", host: "Host", guests: ["Guest"],
    page_url: "https://example.com" }, applyCuts(original, [cut]).fragments, ["Speaker review needed"]);
  assert.match(rendered, /speaker_identity_verified: false/);
  assert.match(rendered, /review_required: true/);
  assert.doesNotMatch(rendered, /\[00:/);
  assert.match(rendered, /Therapy helped me/);
  assert.doesNotMatch(rendered, /Speaker review needed/);
  assert.match(rendered, /\*\*Guest:\*\* Yeah\./);
  assert.match(rendered, /\*\*Host:\*\* Therapy helped me\./);
});

test("bold speaker formatting changes only speaker markers, not dialogue or review timestamps", () => {
  const episode = { slug: "test", title: "Test", host: "Robin Ducharme", guests: ["Guest"], page_url: "https://example.com" };
  const fragments = applyCuts([{ start: 1000, end: 2000, speaker: "Robin Ducharme", text: "Keep **this** emphasis." },
    { start: 2000, end: 3000, speaker: null, text: "Unverified voice." }], []).fragments;
  for (const timestamped of [false, true]) {
    const plain = renderCleanTranscript(episode, fragments, ["Needs review"], timestamped, false);
    const bold = renderCleanTranscript(episode, fragments, ["Needs review"], timestamped);
    assert.equal(bold, plain.replace("Robin Ducharme: Keep", "**Robin Ducharme:** Keep")
      .replace("Unknown speaker: Unverified", "**Unknown speaker:** Unverified"));
    assert.match(bold, /Keep \*\*this\*\* emphasis\./);
  }
});

test("multiple partial cuts preserve intervening dialogue and reject deleting all dialogue", () => {
  const mixed = [{ start: 100, end: 9000, speaker: "Guest", text: "Intro. AD ONE. Teaching. AD TWO. Question?" }];
  const cuts: CleanupCut[] = [{ ...cut, first_text: "AD ONE.", last_text: "AD ONE." },
    { ...cut, first_text: "AD TWO.", last_text: "AD TWO." }];
  assert.deepEqual(applyCuts(mixed, cuts).fragments.map(item => item.text), ["Intro. ", " Teaching. ", " Question?"]);
  assert.throws(() => applyCuts(mixed, [{ ...cut, kind: "whole", first_text: "", last_text: "" }]));
});
