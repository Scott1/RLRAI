import { createHash } from "node:crypto";
import type { PilotEpisode, Utterance } from "./assemblyAi";

export const cleanupCategories = ["advertisement", "production_chatter", "credits", "generic_promotion"] as const;
export interface CleanupCut {
  utterance_id: string;
  kind: "whole" | "span";
  first_text: string;
  last_text: string;
  category: typeof cleanupCategories[number];
  reason: string;
}
export interface ResolvedCut extends CleanupCut {
  cut_id: string;
  index: number;
  from: number;
  to: number;
  removed_text: string;
}
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const utteranceId = (index: number) => `u${String(index).padStart(4, "0")}`;
export interface SourceSpan { original_id: string; char_from: number; char_to: number }
export interface CleanFragment extends Utterance, SourceSpan {
  source_spans?: SourceSpan[];
  speaker_review?: "user_reviewed";
}

function uniqueIndex(text: string, anchor: string): number {
  const index = text.indexOf(anchor);
  if (!anchor || index === -1 || text.indexOf(anchor, index + 1) !== -1) {
    throw new Error(`Missing or ambiguous exact cleanup anchor: ${JSON.stringify(anchor)}`);
  }
  return index;
}

export function resolveCuts(utterances: Utterance[], cuts: CleanupCut[]): ResolvedCut[] {
  if (!Array.isArray(cuts)) throw new Error("Cleanup cuts must be an array.");
  const resolved = cuts.map((cut, number) => {
    if (!cut || !cleanupCategories.includes(cut.category) || !cut.reason?.trim() ||
        !/^u\d{4,}$/.test(cut.utterance_id) || typeof cut.first_text !== "string" || typeof cut.last_text !== "string") {
      throw new Error("Invalid cleanup cut.");
    }
    const index = Number(cut.utterance_id.slice(1));
    const original = utterances[index];
    if (!original || utteranceId(index) !== cut.utterance_id) throw new Error("Unknown cleanup utterance ID.");
    let from = 0, to = original.text.length;
    if (cut.kind === "span") {
      from = uniqueIndex(original.text, cut.first_text);
      to = uniqueIndex(original.text, cut.last_text) + cut.last_text.length;
      if (to <= from || to - cut.last_text.length < from) throw new Error("Reversed cleanup anchors.");
    } else if (cut.kind !== "whole" || cut.first_text || cut.last_text) {
      throw new Error("Whole-utterance cuts must have empty anchors.");
    }
    return { ...cut, cut_id: `c${String(number).padStart(3, "0")}`, index, from, to,
      removed_text: original.text.slice(from, to) };
  });
  const sorted = [...resolved].sort((a, b) => a.index - b.index || a.from - b.from);
  sorted.forEach((cut, index) => {
    const previous = sorted[index - 1];
    if (previous?.index === cut.index && previous.to > cut.from) throw new Error("Overlapping cleanup cuts.");
  });
  return resolved;
}

export function applyCuts(utterances: Utterance[], cuts: CleanupCut[]) {
  const resolved = resolveCuts(utterances, cuts);
  const fragments: CleanFragment[] = [];
  utterances.forEach((original, index) => {
    let cursor = 0;
    const removed = resolved.filter(cut => cut.index === index).sort((a, b) => a.from - b.from);
    const keep = (from: number, to: number) => {
      if (to > from) fragments.push({ start: original.start, end: original.end, speaker: original.speaker,
        text: original.text.slice(from, to), original_id: utteranceId(index), char_from: from, char_to: to });
    };
    for (const cut of removed) { keep(cursor, cut.from); cursor = cut.to; }
    keep(cursor, original.text.length);
  });
  const originalCharacters = utterances.reduce((sum, item) => sum + item.text.length, 0);
  const removedCharacters = resolved.reduce((sum, cut) => sum + cut.removed_text.length, 0);
  const keptCharacters = fragments.reduce((sum, item) => sum + item.text.length, 0);
  if (originalCharacters !== removedCharacters + keptCharacters || !fragments.some(item => item.text.trim())) {
    throw new Error("Cleanup failed character conservation or removed the entire transcript.");
  }
  return { fragments, cuts: resolved, originalCharacters, removedCharacters, keptCharacters };
}

export function renderCleanTranscript(episode: PilotEpisode, fragments: ReturnType<typeof applyCuts>["fragments"],
  notes: string[], timestamped = false, boldSpeakers = true): string {
  const time = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(part => String(part).padStart(2, "0")).join(":");
  };
  return ["---", "provider: assemblyai", "review_required: true", "rights_status: review_required",
    "speaker_identity_verified: false", "cleanup_status: reviewed_text_cuts",
    `title: ${JSON.stringify(episode.title)}`, `source_url: ${JSON.stringify(episode.page_url)}`,
    `host: ${JSON.stringify(episode.host)}`, `guests: ${JSON.stringify(episode.guests)}`, "---", "",
    `# ${episode.title}`, "", fragments.some(item => item.speaker_review)
      ? "Cleaned review draft. Includes user-reviewed dialogue edits; other speaker names and wording still need review. Not approved for ingestion."
      : "Cleaned review draft. Dialogue is not rewritten; names remain inferred and unverified. Not approved for ingestion.", "",
    ...(timestamped ? ["Times below are the ORIGINAL utterance boundaries, not exact cut/fragment times or YouTube timestamps.", ""] : []),
    ...(timestamped && notes.length ? ["## Review Notes", "", ...notes.map(note => `- ${note}`), ""] : []),
    "## Conversation", "", ...fragments.filter(item => item.text.trim()).flatMap(item => [
      `${timestamped ? `[${time(item.start)}-${time(item.end)}; ${(item.source_spans ?? [item]).map(span => `${span.original_id}; chars ${span.char_from}:${span.char_to}`).join(" | ")}] ` : ""}${boldSpeakers ? "**" : ""}${item.speaker ?? "Unknown speaker"}:${boldSpeakers ? "**" : ""} ${item.text.trim()}`, ""
    ])].join("\n");
}
