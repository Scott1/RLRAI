import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";
import { buildRetrievalContext, searchRlrContent } from "./retrieval";

test("prefers podcast episode pages and falls back to transcript pages", async () => {
  const client = {
    vectorStores: {
      search: async () => ({
        data: [
          {
            attributes: {
              source_id: "rlr-podcast-001",
              type: "podcast",
              title: "Episode with a page",
              source_url: "https://www.realloveready.com/old-transcript",
              transcript_url: "https://www.realloveready.com/transcript-1",
              podcast_page_url: "https://www.realloveready.com/lets-talk-love/episode-1"
            },
            content: [{ text: "First passage." }]
          },
          {
            attributes: {
              source_id: "rlr-podcast-002",
              type: "podcast",
              title: "Event without a page",
              transcript_url: "https://www.realloveready.com/transcript-2",
              podcast_page_url: ""
            },
            content: [{ text: "Second passage." }]
          },
          {
            attributes: {
              source_id: "rlr-book-001",
              type: "book",
              title: "Book chapter",
              source_url: "https://www.realloveready.com/book"
            },
            content: [{ text: "Third passage." }]
          }
        ]
      })
    }
  } as unknown as OpenAI;

  const results = await searchRlrContent(client, "relationships", {
    vectorStoreIds: ["vs_test"],
    maxResults: 3
  });

  assert.equal(results[0]?.metadata.source_url, "https://www.realloveready.com/lets-talk-love/episode-1");
  assert.equal(results[1]?.metadata.source_url, "https://www.realloveready.com/transcript-2");
  assert.equal(results[2]?.metadata.source_url, "https://www.realloveready.com/book");
  assert.match(buildRetrievalContext(results).context, /Source URL: https:\/\/www\.realloveready\.com\/lets-talk-love\/episode-1/);
});
