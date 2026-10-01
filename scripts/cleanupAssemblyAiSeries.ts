import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { validateSeriesEpisodes } from "../src/transcription/series";
import { validateUtterances } from "../src/transcription/assemblyAi";
import { applyCuts, renderCleanTranscript, resolveCuts, sha256, utteranceId, type CleanupCut } from "../src/transcription/cleanup";
import { applyDialogueReview, verifyReviewCopy, type DialogueReview } from "../src/transcription/dialogueReview";

const { values } = parseArgs({ options: {
  root: { type: "string", default: ".rlr/assemblyai-series" },
  output: { type: "string", default: ".rlr/assemblyai-series-cleanup" },
  episode: { type: "string" }, render: { type: "boolean", default: false },
  scan: { type: "boolean", default: false }, "local-plan": { type: "string" }
}});
const root = path.resolve(values.root!), output = path.resolve(values.output!);
const encoded = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
async function json(file: string) { return JSON.parse(await fs.readFile(file, "utf8")); }
async function save(file: string, value: unknown) {
  await fs.writeFile(file + ".tmp", encoded(value));
  await fs.rename(file + ".tmp", file);
}

async function main() {
  if (root === output) throw new Error("Cleanup output must be separate from original transcripts.");
  if (values.scan && (values.render || values["local-plan"])) throw new Error("Scan and review/render are separate stages.");
  const inventory = await json(path.join(root, "source-inventory.json"));
  const all = validateSeriesEpisodes(inventory.episodes);
  const episodes = all.filter(item => !values.episode || values.episode === item.slug);
  if (!episodes.length) throw new Error("No matching episode.");
  if (!values.render && !values.scan && !values["local-plan"]) {
    console.log(`${episodes.length} episodes; --scan for review candidates; --local-plan PATH --render to apply reviewed exact cuts. No API calls.`);
    return;
  }
  await fs.mkdir(output, { recursive: true });
  const lock = await fs.open(path.join(output, ".lock"), "wx");
  try {
    const localPlan = values["local-plan"] ? await json(path.resolve(values["local-plan"])) : undefined;
    const totals: any[] = [];
    for (const episode of episodes) {
      const inputFile = path.join(root, "transcripts", `${episode.slug}-speakers-${episode.speakers_expected}`, "segments.json");
      const inputBytes = await fs.readFile(inputFile);
      const input = JSON.parse(inputBytes.toString("utf8"));
      const utterances = validateUtterances(input.utterances);
      const dir = path.join(output, episode.slug);
      await fs.mkdir(dir, { recursive: true });
      if (values.scan) {
        const candidates = utterances.flatMap((item, index) => {
          const matches = item.text.match(/sponsor\w*|betterhelp|nespresso|scotiabank|westjet|private wealth|disney|marvel|bloomberg|spotify ads|CBC Gem|IKEA|onstar|edc\.ca|timhortons|\bpromo\w*|subscribe|production|edited by|produced by|rate and review|this podcast|brought to you|terms and conditions|limited time|percent off|% off|visit .*\.com/gi);
          if (!matches && index > 3 && index < utterances.length - 5) return [];
          return [{ id: utteranceId(index), start: item.start, end: item.end, speaker: item.speaker,
            matches: matches ?? [], text: item.text }];
        });
        await save(path.join(dir, "local-review-candidates.json"), { slug: episode.slug, input_sha256: sha256(inputBytes), candidates });
        console.log(`Local review candidates ${episode.slug}: ${candidates.length}`);
        continue;
      }
      const proposalFile = path.join(dir, "proposal.json");
      if (localPlan) {
        const selected = localPlan.episodes.find((item: any) => item.slug === episode.slug);
        if (!selected || selected.input_sha256 !== sha256(inputBytes) || !Array.isArray(selected.review_notes)) {
          throw new Error(`Missing or stale episode in local review plan: ${episode.slug}`);
        }
        resolveCuts(utterances, selected.cuts);
        const proposal = { fingerprint: sha256(JSON.stringify(selected)), input_sha256: sha256(inputBytes),
          origin: "Codex local transcript review; no API call", model: null, usage: null,
          cuts: selected.cuts, review_notes: selected.review_notes };
        await save(proposalFile, proposal);
        await save(path.join(dir, "reviewed-cuts.json"), { input_sha256: proposal.input_sha256,
          proposal_sha256: sha256(await fs.readFile(proposalFile)), reviewed_by: "Codex text-context review",
          cuts: selected.cuts, review_notes: selected.review_notes });
        if (!values.render) { console.log(`Saved local reviewed cuts: ${episode.slug}`); continue; }
      }
      const proposal = await json(proposalFile);
      if (proposal.input_sha256 !== sha256(inputBytes)) throw new Error("Original transcript changed after cleanup review.");
      const review = await json(path.join(dir, "reviewed-cuts.json"));
      if (review.proposal_sha256 !== sha256(await fs.readFile(proposalFile)) || review.input_sha256 !== sha256(inputBytes) ||
          review.reviewed_by !== "Codex text-context review" || !Array.isArray(review.review_notes)) {
        throw new Error("Missing or stale explicit text-context review.");
      }
      const result = applyCuts(utterances, review.cuts as CleanupCut[]);
      const dialogueBytes = await fs.readFile(path.join(dir, "reviewed-dialogue.json")).catch(error => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      const dialogue: DialogueReview | undefined = dialogueBytes ? JSON.parse(dialogueBytes.toString("utf8")) : undefined;
      if (dialogue && dialogue.slug !== episode.slug) throw new Error("Dialogue review belongs to a different episode.");
      const fragments = dialogue ? applyDialogueReview(result.fragments, dialogue) : result.fragments;
      if (dialogue) verifyReviewCopy(await fs.readFile(path.join(dir, "user-reviewed-copy.md"), "utf8"), dialogue, fragments);
      const notes = [...review.review_notes, "Speaker names and possible word errors require audio review; cleanup does not verify attribution.",
        ...(dialogue ? dialogue.review_notes : episode.speaker_count_review_required ? ["Live audience Q&A is preserved, but audience/host/expert turns are merged or mislabeled in the original transcription. Do not use this section as attributed expert teaching until reviewed."] : [])];
      const segments = { episode, audio_sha256: input.audio_sha256, input_sha256: sha256(inputBytes),
        review_required: true, rights_status: "review_required", speaker_identity_verified: false,
        timestamp_unit: "milliseconds", timestamp_basis: "original utterance boundaries; fragments are not retimed",
        ...(dialogue ? { dialogue_review_sha256: sha256(dialogueBytes!) } : {}),
        review_notes: notes, utterances: fragments };
      const cleaned = renderCleanTranscript(episode, fragments, notes);
      const timestamped = renderCleanTranscript(episode, fragments, notes, true);
      try {
        const existing = await fs.readFile(path.join(dir, "cleaned.md"));
        const previous = await json(path.join(dir, "cleanup-audit.json"));
        if (sha256(existing) !== previous.cleaned_sha256) throw new Error(`Hand-edited cleaned draft; preserve/review before rerender: ${episode.slug}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await save(path.join(dir, "cleaned.segments.json"), segments);
      await fs.writeFile(path.join(dir, "cleaned.md"), cleaned);
      await fs.writeFile(path.join(dir, "review.md"), timestamped);
      const audit = { schema_version: 1, slug: episode.slug, input_sha256: sha256(inputBytes),
        proposal_sha256: review.proposal_sha256, review_sha256: sha256(await fs.readFile(path.join(dir, "reviewed-cuts.json"))),
        cleaned_sha256: sha256(cleaned), timestamped_sha256: sha256(timestamped),
        segments_sha256: sha256(await fs.readFile(path.join(dir, "cleaned.segments.json"))),
        review_required: true, speaker_identity_verified: false, reviewed_by: review.reviewed_by,
        original_characters: result.originalCharacters, kept_characters: result.keptCharacters,
        removed_characters: result.removedCharacters, cuts: result.cuts, review_notes: notes,
        ...(dialogue ? { dialogue_review: { reviewed_by: dialogue.reviewed_by, review_sha256: sha256(dialogueBytes!),
          source_copy_sha256: dialogue.source_copy_sha256, character_counts_basis: "before user dialogue edits",
          final_characters: fragments.reduce((sum, item) => sum + item.text.length, 0),
          first_original_id: dialogue.first_original_id, last_original_id: dialogue.last_original_id } } : {}) };
      await save(path.join(dir, "cleanup-audit.json"), audit);
      totals.push({ slug: episode.slug, title: episode.title, cuts: result.cuts.length,
        partial_cuts: result.cuts.filter(cut => cut.kind === "span").length,
        removed_characters: result.removedCharacters, original_characters: result.originalCharacters,
        input_sha256: audit.input_sha256, cleaned_sha256: audit.cleaned_sha256 });
      console.log(`Cleaned ${episode.slug}: ${result.cuts.length} cuts; ${dialogue ? "user-reviewed dialogue reproduced exactly" : "all retained dialogue exact"}.`);
    }
    if (values.render && !values.episode) {
      const summary = { schema_version: 1, review_required: true, speaker_identity_verified: false, episodes: totals,
        total_cuts: totals.reduce((sum, item) => sum + item.cuts, 0),
        total_partial_cuts: totals.reduce((sum, item) => sum + item.partial_cuts, 0) };
      await save(path.join(output, "cleanup-summary.json"), summary);
      await fs.writeFile(path.join(output, "CLEANUP-REVIEW.md"), ["# Real Love Ready: The Series - ad/clutter cleanup", "",
        `${totals.length} cleaned review drafts. ${summary.total_cuts} reviewed deletions, including ${summary.total_partial_cuts} partial-utterance cuts.`, "",
        "Original audio, provider responses, and uncleaned drafts are untouched. Ad/clutter cleanup keeps exact substrings. Any subsequent user dialogue corrections are recorded separately in reviewed-dialogue.json with original source spans and a preserved review copy.",
        "Timestamp-free cleaned.md is a review draft, NOT an approved vector-store upload. review.md retains original utterance boundaries for checking, not exact clipped segment times.",
        "Every cleanup-audit.json records exact removed text and UTF-16 character offsets into the original utterance. The ad/clutter-stage kept and removed character counts add up to the original; later user edits have separate provenance.",
        "All drafts still need attribution, word accuracy, and rights review. Where a user dialogue review is present, corrected turns remain traceable to the original audio boundaries; this is not full speaker or rights verification.",
        "This cleanup was reviewed locally in Codex. No additional transcription or cleanup API calls were made.", "",
        "| Episode | Deletions | Partial cuts | Text removed |", "| --- | ---: | ---: | ---: |",
        ...totals.map(item => `| ${item.title} | ${item.cuts} | ${item.partial_cuts} | ${(100 * item.removed_characters / item.original_characters).toFixed(1)}% |`), ""].join("\n"));
    }
  } finally { await lock.close(); await fs.unlink(path.join(output, ".lock")); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
