import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "../src/config";
import { createOpenAIClient } from "../src/openai";

interface EpisodeTitle {
  source_id: string;
  podcast_page_url: string;
  podcast_page_title: string;
  mapping_status: string;
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) throw new Error("Provide a JSON export of the episode crosswalk; add --apply to update live titles.");
  const rows = JSON.parse((await fs.readFile(input, "utf8")).replace(/^\uFEFF/, "")) as EpisodeTitle[];
  const titles = new Map(rows.filter((row) => row.mapping_status === "verified" && row.podcast_page_title?.trim())
    .map((row) => [row.source_id, row]));
  if (titles.size === 0) throw new Error("No verified episode titles found.");
  const config = getConfig();
  if (config.vectorStoreIds.length !== 1) throw new Error("Expected exactly one configured vector store.");
  const store = config.vectorStoreIds[0];
  const client = createOpenAIClient(config.apiKey);
  const changes = [];
  for await (const file of client.vectorStores.files.list(store)) {
    const before = file.attributes ?? {};
    const row = titles.get(String(before.source_id));
    if (!row || before.type !== "podcast") continue;
    if (before.podcast_page_url !== row.podcast_page_url) {
      throw new Error(`Episode URL mismatch for ${row.source_id}; refusing to update.`);
    }
    const title = row.podcast_page_title.trim();
    if (title.length > 512) throw new Error(`Title exceeds attribute limit: ${row.source_id}`);
    if (before.title !== title) changes.push({ fileId: file.id, before, after: { ...before, title } });
  }
  const directory = path.resolve(".rlr/podcast-title-updates", new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "plan.json"), JSON.stringify({ store, changes }, null, 2));
  console.log(`${changes.length} title updates planned; backup: ${directory}`);
  if (!process.argv.includes("--apply")) return;
  for (const [index, change] of changes.entries()) {
    await client.vectorStores.files.update(change.fileId, { vector_store_id: store, attributes: change.after });
    let updated = await client.vectorStores.files.retrieve(change.fileId, { vector_store_id: store });
    for (let attempt = 0; attempt < 5 && updated.attributes?.title !== change.after.title; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      updated = await client.vectorStores.files.retrieve(change.fileId, { vector_store_id: store });
    }
    if (JSON.stringify(updated.attributes) !== JSON.stringify(change.after)) {
      // Attribute ordering is not significant; compare each saved property instead.
      if (Object.keys(updated.attributes ?? {}).length !== Object.keys(change.after).length ||
          Object.entries(change.after).some(([key, value]) => updated.attributes?.[key] !== value)) {
        throw new Error(`Metadata verification failed for ${change.fileId}`);
      }
    }
    await fs.appendFile(path.join(directory, "applied.jsonl"), JSON.stringify(change) + "\n");
    console.log(`Updated and verified ${index + 1}/${changes.length}`);
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
