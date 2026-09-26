import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type OpenAI from "openai";
import { getConfig, readVectorStoreState } from "../src/config";
import { createOpenAIClient } from "../src/openai";

type Attributes = Record<string, string | number | boolean>;

interface PodcastUpdate {
  filename: string;
  sourceId: string;
  attributes: Attributes;
}

interface Attachment {
  id: string;
  status: string;
  attributes?: Attributes | null;
}

interface PlannedChange {
  fileId: string;
  update: PodcastUpdate;
  before: Attributes;
}

const expectedInputKeys = [
  "type", "canonicality", "rights_status", "content_domain", "source_id", "episode_id",
  "season", "episode_number", "date", "title", "transcript_url", "podcast_page_url",
  "has_guest", "is_live_event", "manual_review", "podcast_page_link_status"
].sort();

const preservedKeys = [
  "type", "canonicality", "rights_status", "source_id", "episode_id", "season",
  "episode_number", "date", "title", "has_guest", "is_live_event"
];

async function main(): Promise<void> {
  const { manifestPath, apply } = parseArgs(process.argv.slice(2));
  const updates = await loadUpdates(manifestPath);
  const config = getConfig();
  const state = readVectorStoreState(config.statePath);
  if (!state || config.vectorStoreIds.length !== 1) {
    throw new Error("Expected one configured vector store with a saved ingestion state.");
  }

  const vectorStoreId = config.vectorStoreIds[0];
  if (state.vectorStoreId !== vectorStoreId || state.files.length !== 145) {
    throw new Error("Configured vector store does not match the 145-file saved ingestion state.");
  }

  const podcastFiles = state.files.filter((file) => file.type === "podcast");
  if (podcastFiles.length !== 125 || updates.size !== podcastFiles.length) {
    throw new Error("Expected exactly 125 podcast files and 125 matching update records.");
  }

  const client = createOpenAIClient(config.apiKey);
  const before = await listAttachments(client, vectorStoreId);
  if (before.size !== state.files.length) {
    throw new Error(`Live store contains ${before.size} files, expected ${state.files.length}.`);
  }

  const stateIds = new Set(state.files.map((file) => file.fileId));
  if (stateIds.has(undefined) || stateIds.size !== before.size || [...before.keys()].some((id) => !stateIds.has(id))) {
    throw new Error("Live attachment IDs do not exactly match the saved ingestion state.");
  }

  const changes: PlannedChange[] = [];
  const matchedNames = new Set<string>();
  for (let start = 0; start < podcastFiles.length; start += 8) {
    const batch = podcastFiles.slice(start, start + 8);
    await Promise.all(batch.map(async (file) => {
      const fileId = file.fileId;
      if (!fileId) {
        throw new Error(`Missing uploaded file ID for ${file.id}.`);
      }

      const uploaded = await client.files.retrieve(fileId);
      const expectedFilename = path.basename(file.relativePath);
      if (uploaded.filename !== expectedFilename) {
        throw new Error(`Uploaded filename differs from saved state for ${fileId}.`);
      }

      const update = updates.get(uploaded.filename);
      const attachment = before.get(fileId);
      if (!update || update.sourceId !== file.id || !attachment?.attributes || attachment.status !== "completed") {
        throw new Error(`Missing or mismatched podcast attachment: ${uploaded.filename}.`);
      }

      for (const key of preservedKeys) {
        if (!isDeepStrictEqual(attachment.attributes[key], update.attributes[key])) {
          throw new Error(`Unexpected change to ${key} for ${uploaded.filename}.`);
        }
      }

      if (attachment.attributes.manual_review !== update.attributes.manual_review && file.id !== "rlr-podcast-074") {
        throw new Error(`Unexpected manual_review change for ${uploaded.filename}.`);
      }

      matchedNames.add(uploaded.filename);
      if (!isDeepStrictEqual(attachment.attributes, update.attributes)) {
        changes.push({ fileId, update, before: attachment.attributes });
      }
    }));
  }

  if (matchedNames.size !== updates.size) {
    throw new Error("Not every update record matched an uploaded podcast filename.");
  }

  console.log(`Store: ${vectorStoreId}`);
  console.log(`Matched podcast files: ${matchedNames.size}/125`);
  console.log(`Changes needed: ${changes.length}`);
  console.log(`Already current: ${125 - changes.length}`);

  if (!apply) {
    console.log("Dry run only. Add --apply to update the live vector store.");
    return;
  }

  if (changes.length > 0) {
    const backupPath = path.join(
      path.dirname(config.statePath),
      `podcast-link-attributes-before-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    );
    await fs.writeFile(backupPath, `${JSON.stringify({ vectorStoreId, files: changes }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
    console.log(`Previous attributes saved: ${backupPath}`);

    for (const [index, change] of changes.entries()) {
      const updated = await client.vectorStores.files.update(change.fileId, {
        vector_store_id: vectorStoreId,
        attributes: change.update.attributes
      });
      if (!isDeepStrictEqual(updated.attributes, change.update.attributes)) {
        throw new Error(`OpenAI did not return the expected attributes for ${change.update.filename}.`);
      }
      if ((index + 1) % 10 === 0 || index + 1 === changes.length) {
        console.log(`Updated ${index + 1}/${changes.length} podcast files`);
      }
    }
  }

  let mismatch = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const after = await listAttachments(client, vectorStoreId);
    mismatch = after.size === before.size ? "" : "attachment count";
    for (const file of state.files) {
      const fileId = file.fileId;
      if (!fileId) {
        throw new Error(`Missing uploaded file ID for ${file.id}.`);
      }
      const actual = after.get(fileId);
      const expected = file.type === "podcast"
        ? updates.get(path.basename(file.relativePath))?.attributes
        : before.get(fileId)?.attributes;
      if (!actual || !expected || !isDeepStrictEqual(actual.attributes, expected)) {
        mismatch = file.id;
        break;
      }
    }
    if (!mismatch) {
      break;
    }
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  if (mismatch) {
    throw new Error(`Post-update verification failed for ${mismatch}.`);
  }
  console.log("Verified all 125 podcast attributes and all 20 unchanged book attachments.");
}

function parseArgs(args: string[]): { manifestPath: string; apply: boolean } {
  let manifestPath = "";
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--manifest" && args[index + 1]) {
      manifestPath = path.resolve(args[index + 1]);
      index += 1;
    } else if (args[index] === "--apply") {
      apply = true;
    } else {
      throw new Error(`Unknown argument: ${args[index]}`);
    }
  }
  if (!manifestPath) {
    throw new Error("Usage: npm run update:podcast-links -- --manifest <updates.jsonl> [--apply]");
  }
  return { manifestPath, apply };
}

async function loadUpdates(manifestPath: string): Promise<Map<string, PodcastUpdate>> {
  const raw = await fs.readFile(manifestPath, "utf8");
  const updates = new Map<string, PodcastUpdate>();
  const sourceIds = new Set<string>();
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) {
      continue;
    }
    const record = JSON.parse(line) as Record<string, unknown>;
    const filename = record.openai_upload_filename;
    const sourceId = record.source_id;
    const filePath = record.file_path;
    const input = record.attributes;
    if (typeof filename !== "string" || path.basename(filename) !== filename || !filename.endsWith(".md")
      || typeof sourceId !== "string" || typeof filePath !== "string"
      || path.basename(filePath) !== filename || !isRecord(input)) {
      throw new Error(`Invalid update record at line ${index + 1}.`);
    }
    if (updates.has(filename) || sourceIds.has(sourceId)) {
      throw new Error(`Duplicate filename or source ID at line ${index + 1}.`);
    }
    if (!isDeepStrictEqual(Object.keys(input).sort(), expectedInputKeys)
      || Object.entries(input).some(([key, value]) => key.length > 64
        || !(typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        || (typeof value === "string" && value.length > 512))) {
      throw new Error(`Invalid 16-key attribute payload at line ${index + 1}.`);
    }
    if (input.type !== "podcast" || input.rights_status !== "approved"
      || input.content_domain !== "real_love_ready" || input.source_id !== sourceId) {
      throw new Error(`Unexpected source identity at line ${index + 1}.`);
    }

    const transcriptUrl = input.transcript_url;
    const podcastPageUrl = input.podcast_page_url;
    const status = input.podcast_page_link_status;
    if (typeof transcriptUrl !== "string" || !isRlrUrl(transcriptUrl)
      || typeof podcastPageUrl !== "string" || (podcastPageUrl !== "" && !isRlrUrl(podcastPageUrl))
      || typeof status !== "string") {
      throw new Error(`Invalid RLR URL or link status at line ${index + 1}.`);
    }
    if (!podcastPageUrl && !["not_applicable_non_podcast_event", "manual_review_no_canonical_page_link"].includes(status)) {
      throw new Error(`Missing podcast page without an exception status at line ${index + 1}.`);
    }

    // Keep source_url for the deployed app while retaining both new URLs within the 16-key limit.
    const attributes = Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== "content_domain")
    ) as Attributes;
    attributes.source_url = podcastPageUrl || transcriptUrl;
    if (Object.keys(attributes).length !== 16) {
      throw new Error(`Transformed attributes do not have 16 keys at line ${index + 1}.`);
    }
    updates.set(filename, { filename, sourceId, attributes });
    sourceIds.add(sourceId);
  }
  return updates;
}

async function listAttachments(client: OpenAI, vectorStoreId: string): Promise<Map<string, Attachment>> {
  const attachments = new Map<string, Attachment>();
  for await (const file of client.vectorStores.files.list(vectorStoreId, { limit: 100 })) {
    if (attachments.has(file.id)) {
      throw new Error(`Duplicate attachment ID: ${file.id}`);
    }
    attachments.set(file.id, file);
  }
  return attachments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRlrUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && ["realloveready.com", "www.realloveready.com"].includes(url.hostname)
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
