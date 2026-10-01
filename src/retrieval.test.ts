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
              title: "Book chapter"
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

test("preserves article links and includes publication and Series attribution in context", async () => {
  const articleUrl = "https://realloveready.substack.com/p/example-article";
  const episodeUrl = "https://www.realloveready.com/real-love-ready-series/example-episode";
  const client = {
    vectorStores: {
      search: async () => ({
        data: [
          {
            attributes: {
              source_id: "rlr-substack-example",
              type: "article",
              title: "Example article",
              publication: "Real Love Ready on Substack",
              author: "Robin Ducharme",
              source_url: articleUrl
            },
            content: [{ text: "Article passage." }]
          },
          {
            attributes: {
              source_id: "rlr-series-example",
              type: "podcast",
              title: "Example episode",
              series: "Real Love Ready: The Series",
              participants: "Robin Ducharme, Example Guest",
              source_url: episodeUrl
            },
            content: [{ text: "Series passage." }]
          }
        ]
      })
    }
  } as unknown as OpenAI;

  const results = await searchRlrContent(client, "relationships", {
    vectorStoreIds: ["vs_test"],
    maxResults: 2
  });
  assert.equal(results[0]?.metadata.type, "article");
  assert.equal(results[0]?.metadata.source_url, articleUrl);
  assert.equal(results[0]?.metadata.author, "Robin Ducharme");
  assert.equal(results[1]?.metadata.source_url, episodeUrl);
  assert.deepEqual(results[1]?.metadata.participants, ["Robin Ducharme", "Example Guest"]);
  const { context, sources } = buildRetrievalContext(results);
  assert.equal(sources.length, 2);
  assert.match(context, /Type: article\nPublication: Real Love Ready on Substack\nAuthor: Robin Ducharme/);
  assert.match(context, /Series: Real Love Ready: The Series/);
});
