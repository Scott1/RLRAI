import { getConfig } from "../src/config";
import { sourceDisplayName, trimExcerpt } from "../src/citations";
import { createOpenAIClient } from "../src/openai";
import { searchRlrContent, selectDiversePassages } from "../src/retrieval";
import { parseArgs } from "node:util";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: {
    limit: { type: "string" }, chat: { type: "boolean", default: false }
  }, allowPositionals: true });
  const config = getConfig();
  const query = positionals.join(" ").trim();
  const limit = Number(values.limit ?? (values.chat ? config.retrievalCandidateResults : 20));
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("--limit must be an integer between 1 and 50.");
  }
  if (!query) {
    throw new Error('Usage: npm run retrieval -- "setting boundaries without guilt" [--limit 20] [--chat]');
  }

  if (config.vectorStoreIds.length === 0) {
    throw new Error("Missing vector store ID. Run npm run ingest or set RLR_VECTOR_STORE_ID/RLR_VECTOR_STORE_IDS.");
  }

  const client = createOpenAIClient(config.apiKey);
  const diagnostics: Array<{ vectorStoreId: string; searchQuery: unknown; returnedPassages: number }> = [];
  const candidates = await searchRlrContent(client, query, {
    vectorStoreIds: config.vectorStoreIds,
    maxResults: values.chat ? limit * config.vectorStoreIds.length : limit,
    candidateMaxResults: limit,
    onSearchDiagnostics: (entry) => diagnostics.push(entry)
  });
  const results = values.chat ? selectDiversePassages(candidates, config.retrievalMaxResults,
    config.retrievalMaxPassagesPerDocument, config.minRetrievalScore) : candidates;

  console.log("");
  console.log("Query:");
  console.log(query);
  for (const entry of diagnostics) {
    console.log(`Store: ${entry.vectorStoreId}`);
    console.log(`OpenAI search query: ${entry.searchQuery === undefined ? "Not provided by API" : JSON.stringify(entry.searchQuery)}`);
    console.log(`Returned passages: ${entry.returnedPassages}`);
  }
  if (values.chat) {
    console.log(`Chat selection: ${results.length}/${config.retrievalMaxResults} passages; at most ${config.retrievalMaxPassagesPerDocument} per document; minimum score ${config.minRetrievalScore}.`);
    console.log("Candidate ranking:");
    candidates.forEach((result, index) => console.log(`${index + 1}. ${results.includes(result) ? "[selected]" : "[omitted]"} ${result.score?.toFixed(3) ?? "n/a"} ${sourceDisplayName(result.metadata)}`));
    console.log("Selected excerpts:");
  } else {
    console.log(`Showing ${results.length} raw passages (limit ${limit}). Use --chat to inspect the diverse chat selection.`);
  }
  console.log("");

  if (results.length === 0) {
    console.log("No results found.");
    return;
  }

  results.forEach((result, index) => {
    const score = typeof result.score === "number" ? result.score.toFixed(3) : "n/a";
    console.log(`${index + 1}. ${sourceDisplayName(result.metadata)}`);
    console.log(`Score: ${score}`);
    console.log("Excerpt:");
    console.log(trimExcerpt(result.text, 700));
    console.log("");
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
