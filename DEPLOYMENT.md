# Preview Deployment

This guide prepares the Real Love Ready Companion for a small, private feedback group. It is not a public launch checklist.

## Preview Architecture

```text
Approved RLR corpus (private repository)
                  |
                  | Ingested from a trusted local/admin environment
                  v
OpenAI preview project and vector store
                  ^
                  | Server-side API key held by the host's secret manager
                  |
Access-controlled hosted companion
                  ^
                  |
             Invited RLR reviewers
```

The licensed corpus repository is never deployed. The hosted app needs only its source code plus its server-side configuration. It sends questions and retrieved excerpts to OpenAI, then returns the generated answer and source references to the reviewer.

## Before You Deploy

1. Create an OpenAI project named something like `RLR Companion Preview`.
2. Create a server-only API key for that project. Do not share it in email, source control, browser code, or chat.
3. Ingest the approved corpus into a vector store owned by the preview project. Copy the resulting vector store ID into the host's secret settings.
4. Configure project model permissions, rate limits, and spend notifications for the preview group.
5. Choose an access-control approach before inviting anyone. A shareable link alone is not adequate for the private corpus.

## Host Configuration

Any Node.js web-service host that supports environment secrets and HTTPS can run this app. Configure it with:

```text
Build command: npm ci && npm run build
Start command: npm start
Health check: /healthz
```

Set these values in the host's secret or environment configuration, never in a committed `.env` file:

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-luna
RLR_VECTOR_STORE_ID=vs_...
RLR_RETRIEVAL_MAX_RESULTS=6
RLR_MIN_RETRIEVAL_SCORE=0.25
RLR_WEB_HOST=0.0.0.0
```

The host normally supplies `PORT` itself. The app uses it automatically, falling back to `RLR_WEB_PORT` or `3000` for local development.

## Railway Preview

The repository includes `railway.toml`, so Railway will build with `npm run build`, start with `npm start`, and verify the release at `/healthz`. When the Railway project is connected, generate its Railway-provided HTTPS domain.

The temporary URL will follow this pattern:

```text
https://<service-name>.up.railway.app
```

Set every value from this document in Railway Variables. Do not upload `.env`, the `.rlr` folder, or the private corpus repository.

The feedback controls require persistent private storage. Attach a Railway volume to the Companion service at `/data`. Railway supplies `RAILWAY_VOLUME_MOUNT_PATH` automatically, and the app saves an append-only `feedback.jsonl` there. Feedback is disabled on Railway until a volume is attached. Check that a test submission remains visible in the admin dashboard after a redeploy before inviting reviewers to use the controls. The file contains reviewer usernames, submitted notes, reported answers, and review decisions; restrict access, enable volume backups, and plan a retention/deletion policy. Use one service replica with this file-based store.

## Manual Reviewer Accounts

The app supports a small set of manually configured reviewer accounts. Each reviewer signs in with a username and password, then receives a signed, HTTP-only browser session. Removing an account or changing its password ends any existing session for that reviewer on its next request.

Configure these additional host secrets:

```text
RLR_AUTH_MODE=password
RLR_AUTH_SECRET=<long random secret>
RLR_AUTH_SECURE_COOKIES=true
RLR_PREVIEW_ACCOUNTS=reviewer-01|<long-password>;reviewer-02|<long-password>;reviewer-03|<long-password>;reviewer-04|<long-password>;reviewer-05|<long-password>
RLR_ADMIN_ACCOUNT=scott|<unique-long-password>
```

Use unique reviewer passwords of at least 12 characters and an admin password of at least 20 characters. Treat both account variables as Railway secrets, never as repository content. `RLR_ADMIN_ACCOUNT` creates a separate Scott login with access to `/admin`; reviewer accounts cannot open it. Add, remove, or rotate accounts by editing the relevant variable and redeploying. Local development keeps `RLR_AUTH_MODE=off` by default.

The admin dashboard lists feedback and reports, records review status and private notes, and can export curated eval cases. A case is exported only when the admin explicitly marks it as a candidate and writes a sanitized question and expected behavior. The export does not include raw reviewer messages or reported answers. Review the downloaded file before adding selected cases to the repository's eval suite.

The app has a small in-memory limit of five failed sign-in attempts per reviewer account per 15 minutes. This is appropriate for one small preview instance, not a public-scale abuse-prevention system.

## Privacy And Operations

- Keep preview chat data out of analytics and application logs unless reviewers have been told what is collected and why.
- Keep the existing educational and crisis boundaries visible in the interface.
- Review source links to ensure they do not reveal private files or administrative URLs.
- Use a dedicated preview OpenAI project rather than a personal development key.
- Review OpenAI's current data-retention and data-residency terms before inviting reviewers, especially if the group may enter sensitive relationship or health information.
- Rotate the preview API key and archive the deployment when the feedback round ends.

## Deployment Verification

Before sending an invite, verify all of the following from the deployed URL:

1. `/healthz` returns `{"status":"ok"}`.
2. The page loads over HTTPS.
3. A test question returns sources from the preview vector store.
4. The browser has no OpenAI key in its page source or network payloads.
5. An unauthorised visitor cannot access the app once access control is enabled.
6. A tester can see the boundary notice and a clear way to send feedback.
