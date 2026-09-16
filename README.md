# Real Love Ready AI Companion v0.1

This repository is a small proof-of-concept for an AI companion grounded in approved Real Love Ready material. It includes a local browser UI and is being prepared for a small, access-controlled feedback preview. It does not yet include authentication, billing, voice, persistent user memory, agents, fine-tuning, browser access, database storage, or a public production deployment.

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
CLI response + citations
```

The app uses retrieval-augmented generation instead of fine-tuning because v0.1 needs source-grounded answers, inspectable citations, easy content updates, and a clear refusal path when the approved corpus does not support an answer. Fine-tuning would not give reliable source attribution and would make content updates slower.

Approved book and podcast material are treated as equal source material for the companion. The app should not automatically prefer the book over podcast transcripts.

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
- Manual evaluation harness with 28 seeded tests.
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
C:\Users\Scott\OneDrive\Documents\ChatGPT\rlr-ai-companion-corpus
```

```text
rlr-ai-companion-corpus/
├── content/
│   ├── raw/
│   │   ├── book/
│   │   └── podcasts/
│   ├── processed/
│   │   ├── book/
│   │   └── podcasts/
│   └── openai_upload/
│       ├── book/
│       └── podcasts/
└── manifests/
    ├── book-openai_file_attributes.jsonl
    └── podcasts-openai_file_attributes.jsonl
```

The `raw` folders preserve untouched source material. The `processed` folders preserve cleaned/auditable Markdown, including YAML front matter when helpful. The `openai_upload` folders should contain the plain Markdown sent to OpenAI, with metadata attached from JSONL manifest attributes instead of embedded into the retrieval text.

## Use A Private Corpus Repo

Point this app at the private corpus manifests:

```bash
RLR_UPLOAD_MANIFESTS=C:\Users\Scott\OneDrive\Documents\ChatGPT\rlr-ai-companion-corpus\manifests\book-openai_file_attributes.jsonl;C:\Users\Scott\OneDrive\Documents\ChatGPT\rlr-ai-companion-corpus\manifests\podcasts-openai_file_attributes.jsonl
RLR_UPLOAD_CONTENT_ROOTS=C:\Users\Scott\OneDrive\Documents\ChatGPT\rlr-ai-companion-corpus
```

Then run:

```bash
npm run ingest
```

When `RLR_UPLOAD_MANIFESTS` is set, ingestion uploads the manifest's `content/openai_upload/...` Markdown files and attaches the manifest's OpenAI vector-store file attributes. This avoids putting YAML audit front matter into retrieval text.

The ingestion command refuses any manifest record where `rights_status` is not exactly `approved`.

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

For a hosting-ready command, use:

```bash
npm start
```

Cloud hosts usually set `PORT` automatically. Use `RLR_WEB_HOST=0.0.0.0` in the host's environment settings and configure its health check to call `/healthz`.

See [DEPLOYMENT.md](DEPLOYMENT.md) before sharing the app outside your own machine.

## Inspect Retrieval

```bash
npm run retrieval -- "setting boundaries without guilt"
```

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

The API-backed commands require `OPENAI_API_KEY` and either a saved or configured vector store ID.
