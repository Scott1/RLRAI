import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { validateSeriesEpisodes } from "../src/transcription/series";
import { validateUtterances } from "../src/transcription/assemblyAi";
import { applyCuts, renderCleanTranscript, sha256 } from "../src/transcription/cleanup";
import { applyDialogueReview, verifyReviewCopy, type DialogueReview } from "../src/transcription/dialogueReview";

const { values } = parseArgs({ options: {
  root: { type: "string", default: ".rlr/assemblyai-series" },
  cleanup: { type: "string", default: ".rlr/assemblyai-series-cleanup" },
  "corpus-root": { type: "string", default: "../rlr-ai-companion-corpus" },
  archive: { type: "boolean", default: false },
  "refresh-formatting": { type: "boolean", default: false },
  "refresh-reviewed-dialogue": { type: "boolean", default: false }
}});
const root = path.resolve(values.root!), cleanup = path.resolve(values.cleanup!), corpus = path.resolve(values["corpus-root"]!);
const json = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));

async function main() {
  if (values["refresh-formatting"] && !values.archive) throw new Error("Formatting refresh requires --archive.");
  if (values["refresh-reviewed-dialogue"] && !values.archive) throw new Error("Dialogue refresh requires --archive.");
  if (values["refresh-formatting"] && values["refresh-reviewed-dialogue"]) throw new Error("Refresh one kind of edit at a time.");
  const episodes = validateSeriesEpisodes((await json(path.join(root, "source-inventory.json"))).episodes);
  const summary = await json(path.join(cleanup, "cleanup-summary.json"));
  if (summary.episodes.length !== episodes.length || summary.review_required !== true || summary.speaker_identity_verified !== false) {
    throw new Error("Cleanup summary is incomplete or improperly approved.");
  }
  const files: { file: string; data: Buffer }[] = [];
  const validated: any[] = [];
  const permittedPrevious = new Map<string, string>();
  const previousCleanedHashes = new Map<string, string>();
  const reviewedEpisodes: string[] = [];
  const permit = (relative: string, bytes: string | Buffer) => permittedPrevious.set(path.resolve(corpus, relative), sha256(bytes));
  const add = async (from: string, relative: string) => {
    const file = path.resolve(corpus, relative);
    if (!file.startsWith(corpus + path.sep)) throw new Error("Cleanup archive escaped corpus root.");
    files.push({ file, data: await fs.readFile(from) });
  };
  for (const episode of episodes) {
    const original = await fs.readFile(path.join(root, "transcripts", `${episode.slug}-speakers-${episode.speakers_expected}`, "segments.json"));
    const input = JSON.parse(original.toString("utf8"));
    const dir = path.join(cleanup, episode.slug);
    const reviewBytes = await fs.readFile(path.join(dir, "reviewed-cuts.json"));
    const review = JSON.parse(reviewBytes.toString("utf8"));
    const audit = await json(path.join(dir, "cleanup-audit.json"));
    const segmentsBytes = await fs.readFile(path.join(dir, "cleaned.segments.json"));
    const segments = JSON.parse(segmentsBytes.toString("utf8"));
    const computed = applyCuts(validateUtterances(input.utterances), review.cuts);
    const dialogueBytes = await fs.readFile(path.join(dir, "reviewed-dialogue.json")).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const dialogue: DialogueReview | undefined = dialogueBytes ? JSON.parse(dialogueBytes.toString("utf8")) : undefined;
    if (dialogue && dialogue.slug !== episode.slug) throw new Error("Dialogue review belongs to a different episode.");
    const fragments = dialogue ? applyDialogueReview(computed.fragments, dialogue) : computed.fragments;
    if (dialogue) {
      verifyReviewCopy(await fs.readFile(path.join(dir, "user-reviewed-copy.md"), "utf8"), dialogue, fragments);
      if (segments.dialogue_review_sha256 !== sha256(dialogueBytes!) ||
          !isDeepStrictEqual(audit.dialogue_review, { reviewed_by: dialogue.reviewed_by, review_sha256: sha256(dialogueBytes!),
            source_copy_sha256: dialogue.source_copy_sha256, character_counts_basis: "before user dialogue edits",
            final_characters: fragments.reduce((sum, item) => sum + item.text.length, 0),
            first_original_id: dialogue.first_original_id, last_original_id: dialogue.last_original_id }) ||
          !dialogue.review_notes.every(note => segments.review_notes.includes(note))) {
        throw new Error("User dialogue review provenance mismatch.");
      }
      reviewedEpisodes.push(episode.slug);
    } else if (audit.dialogue_review || segments.dialogue_review_sha256) throw new Error("Missing dialogue review record.");
    const cleanBytes = await fs.readFile(path.join(dir, "cleaned.md"));
    const timestampedBytes = await fs.readFile(path.join(dir, "review.md"));
    const tracked = summary.episodes.find((item: any) => item.slug === episode.slug);
    if (review.input_sha256 !== sha256(original) || audit.input_sha256 !== sha256(original) ||
        segments.input_sha256 !== sha256(original) || tracked?.input_sha256 !== sha256(original) ||
        audit.review_sha256 !== sha256(reviewBytes) || audit.proposal_sha256 !== review.proposal_sha256 ||
        review.proposal_sha256 !== sha256(await fs.readFile(path.join(dir, "proposal.json"))) ||
        audit.segments_sha256 !== sha256(segmentsBytes) || audit.cleaned_sha256 !== sha256(cleanBytes) ||
        audit.timestamped_sha256 !== sha256(timestampedBytes) || tracked.cleaned_sha256 !== sha256(cleanBytes)) {
      throw new Error(`Changed/stale cleanup artifact: ${episode.slug}`);
    }
    if (segments.review_required !== true || segments.speaker_identity_verified !== false ||
        segments.rights_status !== "review_required" || segments.audio_sha256 !== input.audio_sha256 ||
        !isDeepStrictEqual(segments.episode, episode) || !isDeepStrictEqual(fragments, segments.utterances) ||
        !isDeepStrictEqual(computed.cuts, audit.cuts) || audit.original_characters !== computed.originalCharacters ||
        audit.kept_characters !== computed.keptCharacters || audit.removed_characters !== computed.removedCharacters ||
        !isDeepStrictEqual(segments.review_notes, audit.review_notes) ||
        cleanBytes.toString("utf8") !== renderCleanTranscript(episode, fragments, audit.review_notes) ||
        timestampedBytes.toString("utf8") !== renderCleanTranscript(episode, fragments, audit.review_notes, true)) {
      throw new Error(`Cleanup text/provenance conservation failed: ${episode.slug}`);
    }
    if (episode.slug === "lori-gottlieb" && !dialogue) {
      const originalQandA = input.utterances.filter((item: any) => item.start >= 3263305 && item.start <= 3888648);
      const keptQandA = segments.utterances.filter((item: any) => item.start >= 3263305 && item.start <= 3888648);
      if (!isDeepStrictEqual(originalQandA.map((item: any) => item.text), keptQandA.map((item: any) => item.text)) ||
          !segments.review_notes.some((note: string) => /audience.*merged|merged.*audience/i.test(note))) {
        throw new Error("Live audience Q&A was changed or attribution warning was lost.");
      }
    }
    if (values.archive) {
      const privateOriginal = await fs.readFile(path.join(corpus, "content/processed/real-love-ready-series/assemblyai", `${episode.slug}.segments.json`));
      if (sha256(privateOriginal) !== sha256(original)) throw new Error("Private original archive no longer matches cleanup source; do not overwrite it.");
    }
    const base = `content/processed/real-love-ready-series/assemblyai-cleaned/${episode.slug}`;
    if (dialogue) {
      const manifest = `manifests/assemblyai-series-cleanup/${episode.slug}`;
      await add(path.join(dir, "reviewed-dialogue.json"), `${manifest}/reviewed-dialogue.json`);
      await add(path.join(dir, "user-reviewed-copy.md"), `${manifest}/user-reviewed-copy.md`);
      const allowedPrevious = new Set([`${base}.md`, `${base}.review.md`, `${base}.segments.json`,
        `${manifest}/cleanup-audit.json`, ...["cleanup-summary.json", "validation.json", "CLEANUP-REVIEW.md"]
          .map(name => `manifests/assemblyai-series-cleanup/${name}`)]);
      for (const [relative, hash] of Object.entries(dialogue.previous_artifacts)) {
        if (!allowedPrevious.has(relative) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid previous dialogue artifact.");
        const snapshot = path.join(dir, "before-dialogue-review", path.basename(relative));
        if (sha256(await fs.readFile(snapshot)) !== hash) throw new Error("Previous dialogue snapshot changed.");
        await add(snapshot, `${manifest}/before-dialogue-review/${path.basename(relative)}`);
        if (values["refresh-reviewed-dialogue"]) permittedPrevious.set(path.resolve(corpus, relative), hash);
      }
    }
    if (values["refresh-formatting"]) {
      const auditRelative = `manifests/assemblyai-series-cleanup/${episode.slug}/cleanup-audit.json`;
      const priorBytes = await fs.readFile(path.join(corpus, auditRelative));
      const prior = JSON.parse(priorBytes.toString("utf8"));
      const plain = renderCleanTranscript(episode, fragments, audit.review_notes, false, false);
      const plainReview = renderCleanTranscript(episode, fragments, audit.review_notes, true, false);
      if (!isDeepStrictEqual(prior, { ...audit, cleaned_sha256: sha256(plain), timestamped_sha256: sha256(plainReview) }) &&
          !isDeepStrictEqual(prior, audit)) {
        throw new Error(`Archive differs beyond speaker formatting: ${episode.slug}`);
      }
      permit(`${base}.md`, plain);
      permit(`${base}.review.md`, plainReview);
      permit(auditRelative, priorBytes);
      previousCleanedHashes.set(episode.slug, prior.cleaned_sha256);
    }
    await add(path.join(dir, "cleaned.md"), `${base}.md`);
    await add(path.join(dir, "review.md"), `${base}.review.md`);
    await add(path.join(dir, "cleaned.segments.json"), `${base}.segments.json`);
    for (const file of ["cleanup-audit.json", "reviewed-cuts.json", "proposal.json", "local-review-candidates.json"]) {
      await add(path.join(dir, file), `manifests/assemblyai-series-cleanup/${episode.slug}/${file}`);
    }
    validated.push({ slug: episode.slug, input_sha256: sha256(original), cleaned_sha256: sha256(cleanBytes),
      cuts: computed.cuts.length, partial_cuts: computed.cuts.filter(cut => cut.kind === "span").length,
      original_characters: computed.originalCharacters, kept_characters: computed.keptCharacters,
      removed_characters: computed.removedCharacters });
  }
  const validation = { schema_version: 1, checked_episodes: validated.length, review_required: true,
    speaker_identity_verified: false, character_conservation_verified: true,
    ...(reviewedEpisodes.length ? { character_counts_basis: "ad/clutter cleanup before user dialogue edits",
      user_reviewed_dialogue_episodes: reviewedEpisodes } : {}),
    original_q_and_a_preserved: !reviewedEpisodes.includes("lori-gottlieb"),
    total_cuts: validated.reduce((sum, item) => sum + item.cuts, 0),
    total_partial_cuts: validated.reduce((sum, item) => sum + item.partial_cuts, 0), episodes: validated };
  if (validation.total_cuts !== summary.total_cuts || validation.total_partial_cuts !== summary.total_partial_cuts) {
    throw new Error("Cleanup total mismatch.");
  }
  if (values["refresh-formatting"]) {
    for (const [name, current] of [["cleanup-summary.json", summary], ["validation.json", validation]] as const) {
      const relative = `manifests/assemblyai-series-cleanup/${name}`;
      const previousBytes = await fs.readFile(path.join(corpus, relative));
      const previous = JSON.parse(previousBytes.toString("utf8"));
      const expected = { ...current, episodes: current.episodes.map((item: any) => ({ ...item,
        cleaned_sha256: previousCleanedHashes.get(item.slug) })) };
      if (!isDeepStrictEqual(previous, expected)) throw new Error(`Archive summary differs beyond speaker formatting: ${name}`);
      permit(relative, previousBytes);
    }
  }
  await fs.writeFile(path.join(cleanup, "validation.json"), JSON.stringify(validation, null, 2) + "\n");
  for (const file of ["CLEANUP-REVIEW.md", "cleanup-summary.json", "local-decisions.json", "local-review-plan.json", "validation.json"]) {
    await add(path.join(cleanup, file), `manifests/assemblyai-series-cleanup/${file}`);
  }
  console.log(`Validated ${validated.length} episodes: ${validation.total_cuts} deletions (${validation.total_partial_cuts} partial); ${reviewedEpisodes.length} user dialogue reviews replayed and verified.`);
  if (!values.archive) { console.log("Validation only; no corpus files written, no API calls or vector-store changes."); return; }
  if (root === corpus || cleanup === corpus || !await fs.stat(path.join(corpus, ".git")).then(() => true, () => false)) {
    throw new Error("Archive target must be the existing separate private corpus checkout.");
  }
  // Refreshes accept only recorded prior artifact hashes, never arbitrary overwrites.
  for (const { file, data } of files) {
    try {
      const existing = sha256(await fs.readFile(file));
      if (existing !== sha256(data) && existing !== permittedPrevious.get(file)) throw new Error(`Archive destination already differs: ${file}`);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const { file, data } of files) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, data, { flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = sha256(await fs.readFile(file));
      if (existing !== sha256(data)) {
        if (existing !== permittedPrevious.get(file)) throw new Error(`Archive changed after preflight: ${file}`);
        await fs.writeFile(file + ".refresh.tmp", data, { flag: "wx" });
        await fs.rename(file + ".refresh.tmp", file);
      }
    }
    if (sha256(await fs.readFile(file)) !== sha256(data)) throw new Error("Archived cleanup hash mismatch.");
  }
  console.log(`Archived and verified ${files.length} cleaned drafts/audit files in the private corpus repo. Originals untouched; no ingestion or commits.`);
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
