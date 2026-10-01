import { sha256, type CleanFragment, type SourceSpan } from "./cleanup";

export interface DialogueTurn { speaker: string; text: string; source_spans: SourceSpan[] }
export interface DialogueReview {
  schema_version: 1;
  slug: string;
  reviewed_by: string;
  source_copy_sha256: string;
  baseline_sha256: string;
  first_original_id: string;
  last_original_id: string;
  turns: DialogueTurn[];
  review_notes: string[];
  previous_artifacts: Record<string, string>;
}

// This deliberately accepts only the simple speaker-labelled Markdown used by our drafts.
export function parseDialogue(markdown: string): { speaker: string; text: string }[] {
  const marker = "\n## Conversation\n";
  const normalized = markdown.replace(/\r\n/g, "\n");
  const start = normalized.indexOf(marker);
  if (start < 0 || normalized.indexOf(marker, start + 1) !== -1) throw new Error("Expected one Conversation section.");
  return normalized.slice(start + marker.length).trim().split(/\n\s*\n/).map(block => {
    const match = /^\*\*([^\n*]+):\*\*\s+([\s\S]+)$/.exec(block.trim());
    if (!match || !match[1].trim() || !match[2].trim()) throw new Error("Expected a bold speaker label on each paragraph.");
    return { speaker: match[1].trim(), text: match[2].trim() };
  });
}

export function applyDialogueReview(fragments: CleanFragment[], review: DialogueReview): CleanFragment[] {
  if (review.schema_version !== 1 || !review.reviewed_by?.trim() ||
      review.baseline_sha256 !== sha256(JSON.stringify(fragments)) ||
      !/^[a-f0-9]{64}$/.test(review.source_copy_sha256) ||
      !Array.isArray(review.review_notes) || !Array.isArray(review.turns) || !review.turns.length) {
    throw new Error("Missing or stale user dialogue review.");
  }
  const first = fragments.findIndex(item => item.original_id === review.first_original_id);
  const last = fragments.map(item => item.original_id).lastIndexOf(review.last_original_id);
  if (first < 0 || last < first) throw new Error("Unknown or reversed review range.");
  let previousIndex = -1, previousEnd = -1;
  const turns = review.turns.map(turn => {
    if (!turn.speaker?.trim() || !turn.text?.trim() || !Array.isArray(turn.source_spans) || !turn.source_spans.length) {
      throw new Error("Reviewed turns require text, a speaker and original source spans.");
    }
    const originals = turn.source_spans.map(span => {
      const index = fragments.findIndex((item, number) => number >= first && number <= last &&
        item.original_id === span.original_id && span.char_from >= item.char_from && span.char_to <= item.char_to);
      if (index < 0 || !Number.isInteger(span.char_from) || !Number.isInteger(span.char_to) || span.char_from >= span.char_to ||
          index < previousIndex || (index === previousIndex && span.char_from < previousEnd)) {
        throw new Error("Invalid, overlapping or out-of-order reviewed source spans.");
      }
      previousIndex = index; previousEnd = span.char_to;
      return fragments[index];
    });
    return { start: originals[0].start, end: originals.at(-1)!.end, speaker: turn.speaker, text: turn.text,
      ...turn.source_spans[0], source_spans: turn.source_spans, speaker_review: "user_reviewed" as const };
  });
  return [...fragments.slice(0, first), ...turns, ...fragments.slice(last + 1)];
}

export function verifyReviewCopy(copy: string, review: DialogueReview, fragments: CleanFragment[]) {
  if (sha256(copy) !== review.source_copy_sha256) throw new Error("User review copy changed; create a new review.");
  const expected = fragments.filter(item => item.text.trim()).map(item => ({ speaker: item.speaker ?? "Unknown speaker", text: item.text.trim() }));
  if (JSON.stringify(parseDialogue(copy)) !== JSON.stringify(expected)) {
    throw new Error("Reviewed dialogue does not reproduce the user's copy exactly.");
  }
}
