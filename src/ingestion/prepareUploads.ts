import { parseDialogue } from "../transcription/dialogueReview";
import type { CleanFragment } from "../transcription/cleanup";
import { parseDocument } from "./metadata";

const subscriptionParagraphs = new Set([
  "Keep learning with us! Subscribe for free.",
  "Stay in the conversation! Subscribe for free to receive new posts.",
  "This is what we explore every week. Subscribe for free to receive new posts.",
  "Thanks for reading! Subscribe for free to receive new posts.",
  "If this landed, there\u2019s more to explore! Subscribe for free to receive new posts.",
  "Want more? Subscribe for free!",
  "Enjoying our content? Subscribe for free to receive it in your inbox every week.",
  "Enjoying our content? Subscribe for free to receive new posts in your inbox every week."
]);

export function renderSeriesUpload(markdown: string, title: string, utterances: CleanFragment[]): string {
  const parsed = parseDocument(markdown);
  if (parsed.metadata.title !== title || String(parsed.metadata.rights_status) !== "review_required" ||
      parsed.metadata.speaker_identity_verified !== false || parsed.metadata.review_required !== true) {
    throw new Error("Expected an unapproved, review-required cleaned Series draft.");
  }
  const turns = parseDialogue(markdown);
  const expected = utterances.filter(item => item.text.trim()).map(item => ({
    speaker: item.speaker ?? "Unknown speaker", text: item.text.trim()
  }));
  if (JSON.stringify(turns) !== JSON.stringify(expected)) throw new Error("Series draft differs from structured dialogue.");
  return [`# ${title}`, "", "## Transcript", "",
    ...turns.flatMap(turn => [`**${turn.speaker}:** ${turn.text}`, ""])].join("\n");
}

export function cleanArticleUpload(markdown: string) {
  const paragraphs = markdown.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  const removed: { paragraph: number; text: string; reason: string }[] = [];
  const retained = paragraphs.filter((paragraph, index) => {
    if (!subscriptionParagraphs.has(paragraph.trim())) return true;
    removed.push({ paragraph: index + 1, text: paragraph, reason: "Standalone publication subscription prompt" });
    return false;
  });
  if (!retained.length || !retained[0].startsWith("# ") || retained.join(" ").length < 300) {
    throw new Error("Article is missing a title or substantial body.");
  }
  return { markdown: retained.join("\n\n") + "\n", removed };
}

export function validateCandidateAttributes(attributes: Record<string, unknown>, type: "podcast" | "article") {
  for (const key of ["source_id", "title", "source_url"]) {
    if (typeof attributes[key] !== "string" || !String(attributes[key]).trim()) throw new Error(`Missing ${key}.`);
  }
  if (attributes.type !== type || attributes.canonicality !== "peer" ||
      attributes.rights_status !== "review_required" || attributes.manual_review !== true) {
    throw new Error("Preparation must preserve peer weighting and outstanding review/rights gates.");
  }
  const url = new URL(String(attributes.source_url));
  if (url.protocol !== "https:" || url.username || url.password ||
      (type === "podcast" ? url.hostname !== "www.realloveready.com" || !url.pathname.startsWith("/real-love-ready-series/")
        : url.hostname !== "realloveready.substack.com" || !url.pathname.startsWith("/p/"))) {
    throw new Error("Unexpected canonical source URL.");
  }
  if (type === "podcast" && (attributes.podcast_page_url !== attributes.source_url ||
      typeof attributes.participants !== "string" || !attributes.participants.trim() ||
      attributes.speaker_identity_verified !== false)) throw new Error("Missing podcast participant/review metadata.");
}
