# Real Love Ready AI Companion v0.1

This repository is a proof-of-concept for an AI companion grounded in approved Real Love Ready material. It includes a browser UI, password-based preview accounts, and persistent feedback storage with an admin review dashboard. An access-controlled team preview is hosted on Railway. It does not yet include public signup, billing, voice, persistent saved conversations, fine-tuning, or web browsing.

The core product question for v0.1 is simple: can a companion grounded in the Real Love Ready body of work produce conversations useful enough that readers and the RLR team want to keep using it?

## Architecture

```text
Approved RLR content
        |
OpenAI Vector Store
        |
Vector Store Search / Retrieval
        |
Frontier LLM via Responses API
        |
RLR system rules
        |
Browser / CLI response + citations
```

The app uses retrieval-augmented generation instead of fine-tuning because v0.1 needs source-grounded answers, inspectable citations, easy content updates, and a clear refusal path when the approved corpus does not support an answer. Fine-tuning would not give reliable source attribution and would make content updates slower.

Approved book, podcast, and article material are treated as equal source material for the companion. The app should not automatically prefer one medium over another.

## What Is Included

- TypeScript and Node.js CLI app.
- OpenAI Responses API for answer generation.
- OpenAI file uploads and vector stores for retrieval.
- Manifest-based uploads for a separate private corpus repo.
- Metadata validation for approved content.
- Local vector store state in `.rlr/vector-store.json`.
- Current-session-only chat history.
- Local browser UI for the same chat pipeline.
- Retrieval debugging command.
- Manual evaluation harness with 35 seeded tests.
- Basic application-level safety routing.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```bash
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-5.2
```

Optional:

```bash
RLR_VECTOR_STORE_ID=vs_...
# or, for multiple stores:
RLR_VECTOR_STORE_IDS=vs_book;vs_podcasts
RLR_RETRIEVAL_MAX_RESULTS=6
RLR_MIN_RETRIEVAL_SCORE=0.25
```

If `RLR_VECTOR_STORE_ID` / `RLR_VECTOR_STORE_IDS` are not set, the app reads vector store IDs saved by `npm run ingest`.

## Recommended Repo Split

Use two git repositories:

```text
rlr-ai-companion/          public app repo
rlr-ai-companion-corpus/   private licensed content repo
```

Keep this app repo public-safe: source code, README, `.env.example`, and tests only. Licensed RLR content should stay out of this repo.

Keep the corpus repo private and track both raw and processed material:

Current local corpus repo:

```text
C:\path\to\rlr-ai-companion-corpus
```

```text
rlr-ai-companion-corpus/
├── content/
│   ├── raw/
│   │   ├── book/
│   │   ├── podcasts/
│   │   ├── real-love-ready-series/
│   │   └── substack/
│   ├── processed/
│   │   ├── book/
│   │   ├── podcasts/
│   │   ├── real-love-ready-series/
│   │   └── substack/
│   └── openai_upload/
│       ├── book/
│       ├── podcasts/
│       ├── real-love-ready-series-assemblyai/
│       └── substack-cleaned/
└── manifests/
    ├── book-openai_file_attributes.jsonl
    ├── podcasts-openai_file_attributes.jsonl
    ├── series-assemblyai-openai_approved.jsonl
    ├── substack-cleaned-openai_approved.jsonl
    └── replacement-vector-store_approved.jsonl
```

The `raw` folders preserve untouched source material. The `processed` folders preserve cleaned/auditable Markdown, including YAML front matter when helpful. The `openai_upload` folders should contain the plain Markdown sent to OpenAI, with metadata attached from JSONL manifest attributes instead of embedded into the retrieval text.

## Use A Private Corpus Repo

Point this app at the private corpus manifests:

```bash
RLR_UPLOAD_MANIFESTS=C:\path\to\rlr-ai-companion-corpus\manifests\book-openai_file_attributes.jsonl;C:\path\to\rlr-ai-companion-corpus\manifests\podcasts-openai_file_attributes.jsonl
RLR_UPLOAD_CONTENT_ROOTS=C:\path\to\rlr-ai-companion-corpus
```

Then run:

```bash
npm run ingest
```

When `RLR_UPLOAD_MANIFESTS` is set, ingestion uploads the manifest's `content/openai_upload/...` Markdown files and attaches their attributes. The app computes `content_sha256` from the exact uploaded Markdown bytes. To stay within OpenAI's 16-attribute limit, it omits `source_filename` from book uploads and `episode_id` from podcast uploads; both remain in the private manifests. This avoids putting YAML audit front matter into retrieval text.

The ingestion command refuses any manifest record where `rights_status` is not exactly `approved`.

The team-review collection contains 200 documents: 20 book chapters, 125 Let's Talk Love transcripts, 22 Real Love Ready: The Series transcripts, and 33 Substack articles. RLR authorized use of the new sources; manual quality review and speaker verification remain pending. The private corpus preserves this distinction in its approval and review records.

Use approved manifests only. Historical candidate manifests deliberately retain `rights_status=review_required` and ingestion refuses them. Do not combine overlapping individual and combined manifests. `replacement-vector-store_approved.jsonl` selects the entire collection; `new-source-upload_approved.jsonl` selects only the 55 additions. `npm run ingest` creates a new store from all manifests supplied; it does not append to the existing store.

To package the newer cleaned AssemblyAI Series transcripts and existing Substack
articles without making API calls:

```text
npx tsx scripts/prepareNewSourceUploads.ts --corpus-root ../rlr-ai-companion-corpus
```

This stages plain Markdown, hashes, a per-source review audit and candidate
manifests under `.rlr/new-source-uploads`. Add `--write-corpus` to save the same
bundle in the private corpus; differing existing files are never overwritten.
Series packaging preserves reviewed speaker turns (including Lori's audience Q&A)
and removes audit notices/front matter/timestamps from the retrieval text. Article
packaging removes only known standalone subscription prompts. Raw and processed
sources, earlier candidates and review flags remain intact.

Use `manifests/new-source-upload_candidates.jsonl` for the new content only, or
`manifests/replacement-vector-store_candidates.jsonl` for the existing book and
Let's Talk Love sources plus the additions. Do not combine these with each other,
their individual Series/Substack manifests, or the older Drive-derived Series
manifest. The package README, `NEW-SOURCE-UPLOAD-README.md`, describes the review
gate. New records remain unapproved and ingestion refuses them until a separate,
explicitly approved selection is created. Packaging never switches the local or
Railway vector store.

After explicit RLR source-use approval, preserve the candidate snapshot and make
approved upload selections with:

```text
npx tsx scripts/approveNewSourceUploads.ts --confirm-rights --write-corpus --corpus-root ../rlr-ai-companion-corpus
```

This changes only `rights_status` in separate `*_approved.jsonl` manifests; pending
manual-review and speaker-verification flags remain. The confirmation is recorded
in `manifests/new-source-rights-approval.json`. Use `new-source-upload_approved.jsonl`
with the incremental sync workflow below to add just the new sources to the existing
store, or intentionally select `replacement-vector-store_approved.jsonl` for a rebuild.

## Ingest Content

```bash
npm run ingest
```

v0.1 creates a fresh OpenAI vector store each run and saves the new ID locally. It does not delete older remote vector stores automatically.

The TypeScript ingestion command is the preferred uploader for this app because it keeps configuration, state, and retrieval assumptions in one codebase. The earlier Python uploader from corpus preparation can remain as a reference or fallback.

Expected output:

```text
Loading approved RLR documents...
Found 145 approved documents (20 book, 125 podcast).
Creating OpenAI vector store...
Vector store created: vs_xxxxx

Uploading 1/145: Foreword
Attaching 1/145: file_xxxxx
...

RLR ingestion complete

Book chapters: 20
Podcast transcripts: 125
Documents uploaded: 145
Vector store: vs_xxxxx
```

## Update Podcast Episode Links

The private corpus repo tracks the episode-page crosswalk and its audit under `manifests/podcast_episode_crosswalk/`. To check an existing 145-file vector store without changing it:

```bash
npm run update:podcast-links -- --manifest ../rlr-ai-companion-corpus/manifests/podcast_episode_crosswalk/openai_file_attribute_updates.jsonl
```

Add `--apply` to update the 125 podcast file attributes in place. The command matches uploaded filenames, saves the previous attributes under `.rlr/`, and verifies the result. It does not re-upload files or create a new vector store. The private corpus upload manifest carries the same episode-page URLs for future ingests, with `source_url` retained for deployed app compatibility. Sources without an episode page link to their transcript instead.

This is a one-time updater for the original 145-file store, not for stores rebuilt with `content_sha256`. New stores already receive the podcast links from the upload manifest.

## Sync Individual Sources

Use `sync:content` when an approved transcript or article changes and you want to update an existing vector store without rebuilding all of it. For files uploaded with `content_sha256`, it compares the local file's SHA-256 hash directly with the stored attribute. Older attachments without that attribute fall back to comparing OpenAI's parsed text, which is not a downloadable copy of the original file; review any proposed replacement. The first run is a read-only preview; it does not upload or remove anything. The target store ID is always explicit:

```bash
npm run sync:content -- --store vs_... --manifest ../rlr-ai-companion-corpus/manifests/approved-updates.jsonl
```

The preview prints an add / replace / metadata-only / remove plan and a plan hash. After reviewing it, repeat the same command with `--apply --plan HASH`. A different plan hash refuses the apply. Only sources in the selected approved manifest are added or changed; omission never deletes a source. Removal must name a source ID explicitly, for example:

```bash
npm run sync:content -- --store vs_... --remove rlr-series-example
```

`--remove` without `--manifest` previews only removals. Use both options to combine removals with additions or replacements. If no manifest or removal is specified, the command previews the manifests from `RLR_UPLOAD_MANIFESTS`. Candidate manifests marked `review_required` are rejected before any OpenAI request.

For replacement, the command indexes the new file first, then detaches the old one; for metadata-only changes it updates attributes without re-uploading text. This can briefly expose both versions to live retrieval, and OpenAI notes that removal is eventually consistent. The command backs up matching local store state and writes an audit trail to ignored `.rlr/content-sync.jsonl`. It does not globally delete the old uploaded OpenAI File, which could be attached to another store. If an apply stops partway through, inspect the audit trail and store before retrying. Syncing a store used by Railway affects that deployment without a code deploy; use a separate review store or a full rebuild-and-switch for larger changes.

## Chat

```bash
npm run chat
```

The CLI keeps conversation context only in memory for the current process. It does not save normal user conversations to disk.

## Web UI

```bash
npm run web
```

Open:

```text
http://localhost:3000
```

The web UI runs locally and uses the same retrieval, system prompt, safety checks, and answer generation path as the CLI. Conversation history is kept in memory by the local server and can be reset from the page.

Inline source numbers open the matching item below each answer. The list contains only sources cited in that answer, in the order first mentioned. Book sources link to the [Real Love Ready book page](https://www.realloveready.com/book); podcast sources use their episode page when available; article sources link to their public post. The **Share** action on a source row copies its link.

Reviewers can use **Share an idea** in the menu or **Rate this response** beside an answer, choosing **Good response** or a concern category. Local feedback is saved to the ignored `.rlr/feedback.jsonl` file. Response feedback saves that answer and its cited sources; the user's question is included only if they check the option. Other conversation turns are not saved. The private `/admin` dashboard shows submissions and lets the administrator track review status, notes, and eval candidates. Positive examples require the same admin review and sanitized question/expected behavior as concerns before eval export; a user's approval alone does not verify accuracy or grounding.

For the Railway preview, feedback stays disabled until a private volume is mounted on the service. The app writes to Railway's `RAILWAY_VOLUME_MOUNT_PATH` automatically. Do not use the deployment's temporary filesystem: reports would be lost after a restart. Confirm a submission survives a redeploy before inviting reviewers to use the controls. A separate `RLR_ADMIN_ACCOUNT` grants Scott access to the dashboard; other reviewer accounts have no access. The dashboard exports only admin-written, sanitized eval cases, never raw feedback automatically.

For a hosting-ready command, use:

```bash
npm start
```

Cloud hosts usually set `PORT` automatically. Use `RLR_WEB_HOST=0.0.0.0` in the host's environment settings and configure its health check to call `/healthz`.

See [DEPLOYMENT.md](DEPLOYMENT.md) before sharing the app outside your own machine.

## Inspect Retrieval

```bash
npm run retrieval -- "setting boundaries without guilt"
npm run retrieval -- "forgiveness" --limit 50
npm run retrieval -- "how do I practice forgiveness" --chat
```

Inspection defaults to 20 passages and accepts `--limit` from 1 to 50. It shows
the original query, OpenAI's returned search query and passage counts per store.
Results are passages, not necessarily distinct documents. This does not change
the chat's `RLR_RETRIEVAL_MAX_RESULTS` setting (six by default). Add `--chat` to
show the candidate ranking with selected/omitted markers and the passages chat
would use. `--limit` then overrides the candidate count for that inspection run.

Chat searches for up to 20 candidate passages per vector store
(`RLR_RETRIEVAL_CANDIDATES`), merges their scores and selects up to six passages
with at most two per source document (`RLR_RETRIEVAL_MAX_PER_DOCUMENT`). Each
selected passage must have a score at or above `RLR_MIN_RETRIEVAL_SCORE` (0.25 by
default) and contain text. Exact duplicate passages from the same source are
removed. Book chapters count as individual source documents. Selection does not
prefer any source type; the model cites only material it actually uses. If few
sources qualify, chat receives fewer passages rather than relaxing these rules.
The model receives the complete selected passages, including speaker turns and
qualifications; only the inspection command's printed excerpts are shortened.

This prints retrieved source titles, scores, and excerpts so retrieval failures can be separated from generation failures.

## Run Evals

```bash
npm run eval
```

The eval runner executes the seeded questions, saves full answers and retrieval metadata in `evals/results/`, and prints a manual review report. v0.1 does not depend on model-based grading.

During a run, it prints progress for each eval case:

```text
[1/28] grounding-001 (grounding)... ready for review
```

## Safety Boundaries

The prototype includes basic handling for diagnosis requests, major relationship decisions, self-harm, immediate danger, violence, Robin impersonation, prompt extraction, prompt injection, and requests to reproduce source material wholesale.

This is not a complete safety system. High-risk situations should be directed to real-time professional, emergency, or specialized support.

## Privacy Boundaries

- Normal CLI conversations are not persisted locally.
- Web conversation history is held in server memory. Feedback submissions are the exception and are stored as described above.
- Eval/debug runs save questions, answers, retrieval snippets, and citations.
- API keys are loaded from environment variables and are never logged intentionally.
- OpenAI receives the user question, recent in-memory chat turns, and retrieved source excerpts needed to generate the response.

## Intentionally Excluded From v0.1

- Production website
- Authentication
- Billing
- Voice
- Persistent user memory
- Multi-user support
- Fine-tuning
- Agents
- Browser access
- External tools
- Database
- Analytics

## Development Commands

```bash
npm run typecheck
npm run lint
npm test
```

The OpenAI-backed commands require `OPENAI_API_KEY` and either a saved or configured vector store ID.

## AssemblyAI Transcription Pilot

The optional original-audio comparison is separate from chat and vector-store ingestion.
Add `ASSEMBLYAI_API_KEY` to your local `.env`, then preview with
`npm run transcribe:assemblyai`. No API calls are made without `--run`.
See [pilot instructions](scripts/ASSEMBLYAI-PILOT.md) for running, resuming and reviewing results.

The same instructions cover the resumable full-series batch (`transcribe:series`),
published episode discovery, original-audio preservation, reuse of completed pilot
jobs, and review-draft archival into the separate private corpus repo. These
commands do not change the Companion's active vector store.
