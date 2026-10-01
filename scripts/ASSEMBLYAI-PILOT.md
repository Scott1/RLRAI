# AssemblyAI original-audio pilot

This optional local experiment is separate from the Companion chat and OpenAI
ingestion. It uploads the complete original `source.mp3`, without re-encoding,
requests Universal-3.5 Pro, diarization and medium-effort speaker identification,
and keeps results in the ignored `.rlr/assemblyai-pilot/` directory.

Add `ASSEMBLYAI_API_KEY=your-key` to the app's local `.env`. Never put the key in
chat, a transcript or Git. No extra package installation is needed.

```text
npm run transcribe:assemblyai
npm run transcribe:assemblyai -- --run
```

The first command is preview-only and makes no API calls. The second starts the
paid test with Silvy Khoucasian and Bryan Reeves. Estimated list cost is about
USD $0.40 for this 72-minute episode: $0.21/hr transcription + $0.02/hr
diarization + $0.10/hr medium-effort name identification. Credits/tax may differ.

Other inventory choices:

```text
npm run transcribe:assemblyai -- --episode the-blueprints-we-inherit
npm run transcribe:assemblyai -- --episode sabrina-zohar
```

Add `--run` to submit those episodes. `--input-root PATH` selects a different
source folder with its source inventory and original recordings. It defaults to
`.rlr/assemblyai-series`, which is prepared by the full-series workflow below.
The superseded OpenAI chunking experiments are archived locally, not required.

## Resume and review

To compare an exact three-speaker constraint without changing the baseline:

```text
npm run transcribe:assemblyai -- --speakers-expected 3 --run
```

This saves to an episode directory ending in `-speakers-3`. The original audio
is unchanged and names/medium effort are identical to the baseline. Advertisements
contain extra voices, so this hard constraint can incorrectly merge those voices
into interview-speaker labels. Treat it as an experiment, not an approved setting.

Progress includes upload, saved job ID and status transitions. Rerun the same
command to resume the saved job instead of paying for a new one. An uncertain
submission is not retried automatically; check the dashboard first. If a killed
process leaves a lock, verify its recorded PID stopped before removing it.

Outputs per episode: raw `response.json`, `request.json`, `state.json`, readable
`transcript.md`, timestamped `segments.json`, `summary.json` and `REVIEW.md`.
State files may contain private vendor URLs; the entire output directory is
ignored. Original OpenAI results and the corpus are not overwritten.

Speaker names are inferred from conversation context, not verified voiceprints.
Check attribution and wording against the original recording before approval.
Ads remain present, including extra voices; the request does not force the
number of speakers to match the named interview participants. Timestamps are
relative to the downloaded audio and must not be used as YouTube timestamps
without alignment. This command never changes an OpenAI vector store.

AssemblyAI stores these jobs remotely; stopping the local process does not cancel
the remote job. Use the vendor dashboard to inspect/delete jobs and review its
data-retention/model-improvement settings before broader use.

## Official references

- https://www.assemblyai.com/docs/pre-recorded-audio/getting-started/transcribe-an-audio-file
- https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model
- https://www.assemblyai.com/docs/speech-understanding/speaker-identification
- https://www.assemblyai.com/pricing

## Full published series

The separate batch workflow snapshots the entire paginated RLR series catalog,
matches published series entries in the official RSS feed, and cross-checks guest
names with episode-page copy. It does not use Maia's transcripts as transcription
input. Discovery needs Python with BeautifulSoup installed.

Audience-Q&A cues in episode copy flag the speaker count for manual review. The
batch does not submit a new fixed-count job for a flagged episode. An already
completed result can be retained as a flagged draft, not accepted as correct
attribution. Named hosts/guests are not necessarily every voice in a live event.

A separately saved successful identification-only recovery under an episode's
`identification-retry/` directory can be applied when rendering. Its request must
match the original transcript ID and identification settings, and returned
utterance text/times must be unchanged. The original provider response remains
untouched; archives preserve both responses. This does not automatically submit
or retry a failed identification request.

```text
python scripts/discoverAssemblyAiSeries.py
npm run transcribe:series
npm run transcribe:series -- --prepare
npm run transcribe:series -- --run
npm run validate:series
```

The default batch directory is `.rlr/assemblyai-series`; `--root PATH` selects a
different batch. Preview makes no network requests. Prepare downloads the original
MP3s and probes duration with FFmpeg, without re-encoding or
splitting. Run prepares all recordings before paid submission, imports matching
completed named/count-constrained pilot jobs, then transcribes with concurrency 2.
The pilot CLI also accepts `--output-root PATH` so batch output stays separate.

Supply `--ffmpeg PATH` or set `FFMPEG_PATH` to an installed FFmpeg executable.
For compatibility, the existing Windows cache at
`.rlr/audio-tools/node_modules/ffmpeg-static/ffmpeg.exe` is the fallback. It is not
committed or installed by `npm install`; configure FFmpeg on a new machine.
Previously completed batch jobs remain cached and are not resubmitted just
because old pilot experiments have been archived.

Rerun the same run command to resume saved jobs. An uncertain submission is not
automatically retried. Cached audio and matching settings prevent accidental paid
resubmission. `--max-estimated-usd 20` is the default pre-submission budget guard
using the current $0.33/hr assumption, not a guaranteed billing cap. Review vendor
pricing and retention settings before running a batch. Existing cached recordings
are preserved even if the publisher's dynamically inserted ads later change.

Outputs include original audio, discovery snapshots, source inventory, saved job
state, readable transcripts, raw responses, structural audits, `batch-progress.json`
and `BATCH-REVIEW.md`. Structural audits flag unexpected names or timestamps; they
cannot verify voice identity or exact word accuracy. Every transcript remains a
review draft. No automatic ad removal, corpus replacement or vector-store upload
is performed. Raw/vendor-private data remains under the Git-ignored `.rlr` folder.

After the full batch completes, preserve a review-draft archive in the separate
private corpus checkout:

```text
npx tsx scripts/archiveAssemblyAiSeries.ts --corpus-root ../rlr-ai-companion-corpus
```

The archive keeps source snapshots, participant metadata, hashes, transcripts,
segments and provider results under separate `assemblyai` directories. It omits
large audio files, local request paths, saved vendor job state and private vendor
URLs; hashes identify the unchanged originals kept in the local cache. It refuses
to overwrite different existing archive files or hand-edited drafts. This is not
an ingestion step, and the archived transcripts still require ad cleanup and
attribution review.

`validate:series` checks every original-audio hash, saved job ID, request fingerprint,
rendered transcript, speaker-name set, timestamps and identification recovery. It
saves `validation.json`, including cached-pilot reuse and estimated incremental
API costs. Passing this check does not verify voices or approve source wording.

## Local ad and clutter cleanup

Cleanup is a separate, local text-review stage. It makes no API calls, does not
modify recordings/provider results, and never updates the vector store.

```text
npx tsx scripts/cleanupAssemblyAiSeries.ts --scan
npx tsx scripts/cleanupAssemblyAiSeries.ts --local-plan PATH_TO_REVIEWED_PLAN.json --render
npx tsx scripts/archiveAssemblyAiCleanup.ts
npx tsx scripts/archiveAssemblyAiCleanup.ts --archive --corpus-root ../rlr-ai-companion-corpus
```

`--scan` finds candidates, not automatic deletions. Review each candidate with
surrounding dialogue. The plan contains an `episodes` array; each entry has `slug`,
the SHA-256 of the original `segments.json` as `input_sha256`, `review_notes`, and
`cuts`. Cuts use stable zero-based utterance IDs (`u0000`, `u0001`, etc.), a
`category` (`advertisement`, `production_chatter`, `credits`, `generic_promotion`),
and a `reason`. A `kind: whole` cut uses empty `first_text`/`last_text`; a
`kind: span` cut uses unique verbatim start/end anchors, both inclusive.

Never delete a mixed utterance wholesale: sponsor reads often share a turn with
a useful question or answer. Preserve introductions, useful resources, host
reflections, qualifications and substantive discussions of therapy/books/brands.
Ambiguous content stays for review; no speaker relabeling or word corrections
are made in this stage. Ordinary conversational filler is intentionally retained.

The default output is `.rlr/assemblyai-series-cleanup/<slug>/`. `cleaned.md` has
timestamp-free dialogue; `review.md` includes review notes and ORIGINAL utterance
boundaries. Partial fragments are not retimed, and these are not YouTube times.
`cleaned.segments.json` and `cleanup-audit.json` retain original utterance IDs,
exact text, and UTF-16 character offsets (start inclusive, end exclusive).
`--render` alone replays saved reviewed cuts without another proposal step.

The archive command defaults to validation only. It recomputes every cut,
verifies exact retained text, hashes and character conservation, and checks that
the live audience Q&A in the Lori Gottlieb episode remains unchanged and flagged,
unless a separate user dialogue review is present and verifies against its copy.
`--archive` writes separate `assemblyai-cleaned` processed drafts and
`manifests/assemblyai-series-cleanup` logs into the private corpus, refusing to
overwrite different existing files. Original archived transcripts stay untouched.
All cleaned drafts remain review-required, with speaker identities unverified;
they are not added to an upload manifest or approved for ingestion.

Speaker headings use the same `**Full Name:**` Markdown format as Let's Talk Love.
To refresh an already archived plain-heading draft after rerendering, pass
`--archive --refresh-formatting` to the archive command. This permits only verified
generated plain-to-bold heading changes and their updated hashes; changes to
dialogue, attribution, cuts, review notes or hand-edited documents are rejected.

## User-reviewed dialogue corrections

Edit a separate copy of `cleaned.md`, not the generated canonical file. Preserve
the bold speaker headings and Conversation section. Corrections are recorded in
`reviewed-dialogue.json` alongside a preserved `user-reviewed-copy.md`. The record
identifies the reviewer, hashes the baseline and copy, limits replacement to an
explicit utterance range, and maps each reviewed turn to original character spans.
Split or merged turns still use approximate original audio boundaries, not exact
new speaker-change times. The original provider transcript is never rewritten.

Rerendering replays both the ad cuts and these reviewed turns, and refuses stale
inputs or a result that differs from the user's copy. Ad-cut character counts
remain separate from subsequent editorial changes. Unchanged drafts retain the
exact-substring checks; corrected drafts remain unapproved for ingestion.

To publish the first reviewed correction over an existing private cleaned archive,
use `--archive --refresh-reviewed-dialogue`. This permits only prior hashes recorded
in the review, with preserved before-review snapshots. It cannot be combined with
the formatting refresh. Ordinary `--archive` still refuses different existing files.
