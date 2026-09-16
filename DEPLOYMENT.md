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

## Access Control

Choose one of these before deployment:

- **Invite-only email login:** Recommended for named RLR reviewers. Each person is individually invited and can be removed later.
- **RLR-managed access layer:** Best when RLR can provide a preview subdomain and administer access through its existing identity provider or access gateway.
- **Shared preview code:** Suitable only for a very short, highly trusted test. It cannot revoke an individual reviewer and should not be used for a broader release.

Authentication is intentionally not implemented yet because the right choice depends on who will manage reviewer identities and whether RLR can provide a preview domain.

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
