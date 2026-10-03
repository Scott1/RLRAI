import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";
import { buildRetrievalContext, searchRlrContent, selectDiversePassages } from "./retrieval";
import type { RetrievalResult } from "./types";

function passage(source: string, score: number | undefined, text: string): RetrievalResult {
  return { id: `${source}:${text}`, fileId: `file-${source}`, filename: `${source}.md`, text, score,
    metadata: { id: source, type: "podcast", title: source, rights_status: "approved" } };
}

test("diverse selection includes a relevant eighth-ranked episode after capping repeated documents", async () => {
  const candidates = [
    ...[0.99, 0.98, 0.97, 0.96].map((score, index) => passage("book", score, `Book ${index}`)),
    ...[0.95, 0.94, 0.93].map((score, index) => passage("article", score, `Article ${index}`)),
    passage("shaka", 0.92, "Forgiveness practice"), passage("other", 0.90, "Another perspective")
  ];
  let requested = 0;
  const client = { vectorStores: { search: async (_store: string, options: { max_num_results: number }) => {
    requested = options.max_num_results;
    return { data: candidates.map((item) => ({ file_id: item.fileId, filename: item.filename,
      score: item.score, attributes: item.metadata, content: [{ text: item.text }] })) };
  } } } as unknown as OpenAI;
  const selected = await searchRlrContent(client, "how do I practice forgiveness", {
    vectorStoreIds: ["vs_test"], maxResults: 6, candidateMaxResults: 20, maxPassagesPerDocument: 2, minScore: 0.25
  });
  assert.equal(requested, 20);
  assert.deepEqual(selected.map((item) => item.metadata.id), ["book", "book", "article", "article", "shaka", "other"]);
});

test("diversity does not fill slots with low scores, empty passages or duplicate text across stores", () => {
  const best = passage("episode", 0.9, "First teaching");
  const duplicate = { ...best, fileId: "another-upload", vectorStoreId: "vs_other", score: 0.89 };
  const second = passage("episode", 0.8, "Second teaching");
  assert.deepEqual(selectDiversePassages([best, duplicate, second,
    passage("episode", 0.79, "Third teaching"), passage("weak", 0.24, "Weak"),
    passage("empty", 0.95, " "), passage("unscored", undefined, "Unknown")], 6, 2, 0.25), [best, second]);
});

test("unknown source metadata falls back to file identity and caps apply across stores", () => {
  const first = { ...passage("unknown-source", 0.8, "A"), fileId: "file-a" };
  const second = { ...passage("unknown-source", 0.7, "B"), fileId: "file-b" };
  const source = passage("shared-source", 0.95, "Same document");
  assert.deepEqual(selectDiversePassages([first, second, source,
    { ...source, text: "Another chunk", score: 0.9, vectorStoreId: "vs_other" }], 6, 1, 0.25), [source, first, second]);
});

test("model context preserves guest teaching and qualifications after a long episode introduction", () => {
  const text = `**Robin Ducharme:** ${"Introduction. ".repeat(150)}\n\n**Shaka Senghor:** Forgiveness can involve releasing a repeated story.\n\nThis does not mean excusing what happened.`;
  const result = passage("shaka", 0.89, text);
  const { context, sources } = buildRetrievalContext([result]);
  assert.ok(text.indexOf("**Shaka Senghor:**") > 1200);
  assert.ok(context.endsWith(text));
  assert.equal(sources.length, 1);
});

test("inspection reads the actual rewritten query and requests more passages without changing ranking", async () => {
  const calls: unknown[] = [];
  const diagnostics: unknown[] = [];
  const client = { vectorStores: { search: (_store: string, options: unknown) => {
    calls.push(options);
    return { asResponse: async () => new Response(JSON.stringify({ search_query: ["forgiveness practices"],
      data: [{ score: 0.7, content: [{ text: "First" }] }, { score: 0.9, content: [{ text: "Second" }] }] })) };
  } } } as unknown as OpenAI;
  const results = await searchRlrContent(client, "forgiveness", { vectorStoreIds: ["vs_test"], maxResults: 20,
    onSearchDiagnostics: (entry) => diagnostics.push(entry) });
  assert.deepEqual(calls, [{ query: "forgiveness", max_num_results: 20, rewrite_query: true }]);
  assert.deepEqual(diagnostics, [{ vectorStoreId: "vs_test", searchQuery: ["forgiveness practices"], returnedPassages: 2 }]);
  assert.equal(results[0]?.text, "Second");
});

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
