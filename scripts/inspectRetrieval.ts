import { getConfig } from "../src/config";
import { sourceDisplayName, trimExcerpt } from "../src/citations";
import { createOpenAIClient } from "../src/openai";
import { searchRlrContent } from "../src/retrieval";

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    throw new Error('Usage: npm run retrieval -- "setting boundaries without guilt"');
  }

  const config = getConfig();
  if (config.vectorStoreIds.length === 0) {
    throw new Error("Missing vector store ID. Run npm run ingest or set RLR_VECTOR_STORE_ID/RLR_VECTOR_STORE_IDS.");
  }

  const client = createOpenAIClient(config.apiKey);
  const results = await searchRlrContent(client, query, {
    vectorStoreIds: config.vectorStoreIds,
    maxResults: config.retrievalMaxResults
  });

  console.log("");
  console.log("Query:");
  console.log(query);
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
