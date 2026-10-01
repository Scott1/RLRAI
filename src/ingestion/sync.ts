import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { toFile } from "openai";
import { getConfig, readVectorStoreState, writeVectorStoreState, type VectorStoreState } from "../config";
import { createOpenAIClient } from "../openai";
import { loadManifestUploadDocuments } from "./manifest";
import { createSyncPlan, type LocalSyncFile, type RemoteSyncFile, type SyncPlanItem } from "./syncPlan";
import { uploadAttributes } from "./uploadAttributes";
import { attributesEqual as sameAttributes } from "./syncAttributes";

interface Args {
  storeId?: string;
  manifests: string[];
  removals: string[];
  apply: boolean;
  expectedPlan?: string;
  help: boolean;
}

const usage = `Usage:
  npm run sync:content -- --store vs_... [--manifest PATH ...] [--remove SOURCE_ID ...]
  npm run sync:content -- --store vs_... [same options] --apply --plan PLAN_HASH

Preview is read-only. It uses RLR_UPLOAD_MANIFESTS if no --manifest or --remove is supplied.
When --remove is supplied without --manifest, only the named sources are removed.
Omitting a source from a selected manifest never removes it from the store.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage);
    return;
  }
  if (!args.storeId) {
    throw new Error(`Specify the exact target vector store with --store.\n\n${usage}`);
  }
  if (args.apply && !args.expectedPlan) {
    throw new Error("--apply requires the plan hash printed by a preview run: --plan HASH.");
  }
  if (!args.apply && args.expectedPlan) {
    throw new Error("--plan is only used with --apply.");
  }

  const config = getConfig();
  if (!config.apiKey) {
    throw new Error("OPENAI_API_KEY is required to inspect a vector store.");
  }
  const manifestPaths = args.manifests.length > 0
    ? args.manifests.map((item) => path.resolve(config.rootDir, item))
    : args.removals.length > 0 ? [] : config.uploadManifests;
  if (manifestPaths.length === 0 && args.removals.length === 0) {
    throw new Error("Select at least one approved manifest or an explicit --remove source ID.");
  }

  // Validate every selected file before making a network request.
  const documents = await loadManifestUploadDocuments(manifestPaths, config.uploadContentRoots);
  const localFiles: LocalSyncFile[] = await Promise.all(documents.map(async (document) => {
    const sourceId = requiredAttribute(document.attributes.source_id ?? document.attributes.id, "source_id", document.path);
    const title = requiredAttribute(document.attributes.title, "title", document.path);
    const type = requiredAttribute(document.attributes.type, "type", document.path);
    if (type !== "book" && type !== "podcast" && type !== "article") {
      throw new Error(`${document.path} has unsupported source type ${type}.`);
    }
    const bytes = await fsp.readFile(document.path);
    if (bytes.length === 0) {
      throw new Error(`${document.path} is empty.`);
    }
    return {
      sourceId, title, type, path: document.path, relativePath: document.relativePath,
      uploadFilename: document.uploadFilename, attributes: uploadAttributes(document.attributes, bytes),
      sha256: sha256(bytes)
    };
  }));
  const localIds = new Set(localFiles.map((file) => file.sourceId));
  if (localIds.size !== localFiles.length) {
    throw new Error("Selected manifests contain duplicate source IDs.");
  }

  const client = createOpenAIClient(config.apiKey);
  const remoteFiles: RemoteSyncFile[] = [];
  for await (const file of client.vectorStores.files.list(args.storeId, { limit: 100 })) {
    const attributes = file.attributes ?? {};
    const sourceId = attributes.source_id ?? attributes.id;
    if (typeof sourceId !== "string" || !sourceId.trim()) {
      throw new Error(`File ${file.id} has no source_id/id attribute. This command only syncs managed stores.`);
    }
    remoteFiles.push({ sourceId, fileId: file.id, status: file.status, attributes });
  }

  const selectedIds = new Set(localFiles.map((file) => file.sourceId));
  for (const remote of remoteFiles) {
    if (!selectedIds.has(remote.sourceId) || remote.status !== "completed") {
      continue;
    }
    const storedHash = remote.attributes.content_sha256;
    if (typeof storedHash === "string" && /^[a-f0-9]{64}$/.test(storedHash)) {
      remote.sha256 = storedHash;
      continue;
    }
    const parts: string[] = [];
    for await (const part of client.vectorStores.files.content(remote.fileId, { vector_store_id: args.storeId })) {
      if (part.type !== "text" || typeof part.text !== "string") {
        throw new Error(`Unexpected parsed content for ${remote.sourceId}; no changes were applied.`);
      }
      parts.push(part.text);
    }
    if (parts.length === 0) {
      throw new Error(`No parsed content returned for ${remote.sourceId}; no changes were applied.`);
    }
    remote.sha256 = sha256(Buffer.from(parts.join(""), "utf8"));
  }

  const plan = createSyncPlan(args.storeId, localFiles, remoteFiles, args.removals);
  const changes = plan.items.filter((item) => item.action !== "unchanged");
  const count = (action: SyncPlanItem["action"]) => plan.items.filter((item) => item.action === action).length;
  console.log(`Vector store: ${args.storeId}`);
  console.log(`Selected: ${localFiles.length} approved files; ${remoteFiles.length} files currently in store.`);
  console.log("Content comparison uses OpenAI's parsed vector-store text for these Markdown files.");
  console.log(`Plan: ${count("add")} add, ${count("replace")} replace, ${count("metadata")} metadata-only, ${count("remove")} remove, ${count("unchanged")} unchanged.`);
  for (const item of changes) {
    console.log(`  ${item.action.toUpperCase().padEnd(8)} ${item.sourceId}${item.remote ? ` (old ${item.remote.fileId})` : ""}`);
  }
  console.log(`Plan hash: ${plan.digest}`);

  if (!args.apply) {
    console.log("Preview only. Nothing was uploaded, updated, or removed.");
    if (changes.length > 0) {
      console.log("To apply, repeat the same selection with --apply --plan <hash above>.");
    }
    return;
  }
  if (args.expectedPlan !== plan.digest) {
    throw new Error("The plan changed since preview. No changes were applied; review the new plan hash first.");
  }
  if (changes.length === 0) {
    console.log("Nothing to sync.");
    return;
  }

  const currentState = readVectorStoreState(config.statePath);
  const state = currentState && stateBelongsToStore(currentState, args.storeId) ? currentState : undefined;
  if (state) {
    const backup = `${config.statePath}.before-sync-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(config.statePath, backup);
    console.log(`Local state backup: ${backup}`);
  } else {
    console.log("Local vector-store state does not identify this single store; it will not be modified.");
  }

  const journalPath = path.join(config.rootDir, ".rlr", "content-sync.jsonl");
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const runId = `${new Date().toISOString()}-${plan.digest.slice(0, 12)}`;
  appendJournal(journalPath, { runId, event: "start", storeId: args.storeId, planHash: plan.digest });

  for (const item of changes) {
    let newFileId: string | undefined;
    try {
      if (item.remote) {
        const current = await client.vectorStores.files.retrieve(item.remote.fileId, { vector_store_id: args.storeId });
        if (current.status !== item.remote.status || !sameAttributes(current.attributes ?? {}, item.remote.attributes)) {
          throw new Error(`Old file ${item.remote.fileId} changed after planning. Preview again.`);
        }
      }
      if (item.action === "add" || item.action === "replace") {
        const local = item.local!;
        const bytes = await fsp.readFile(local.path);
        if (sha256(bytes) !== local.sha256) {
          throw new Error(`Local file ${local.path} changed after planning. Preview again.`);
        }
        const uploaded = await client.files.create({
          file: await toFile(bytes, local.uploadFilename),
          purpose: "assistants"
        });
        newFileId = uploaded.id;
        const attached = await client.vectorStores.files.createAndPoll(args.storeId, {
          file_id: uploaded.id, attributes: local.attributes
        });
        if (attached.status !== "completed") {
          throw new Error(`New file ${uploaded.id} was not indexed: ${attached.status} ${attached.last_error?.message ?? ""}`);
        }
        if (item.action === "replace") {
          const detached = await client.vectorStores.files.delete(item.remote!.fileId, { vector_store_id: args.storeId });
          if (!detached.deleted) {
            throw new Error(`OpenAI did not confirm removal of old file ${item.remote!.fileId}.`);
          }
        }
      } else if (item.action === "metadata") {
        const updated = await client.vectorStores.files.update(item.remote!.fileId, {
          vector_store_id: args.storeId, attributes: item.local!.attributes
        });
        if (!sameAttributes(updated.attributes ?? {}, item.local!.attributes)) {
          throw new Error(`OpenAI did not confirm the desired attributes for ${item.sourceId}.`);
        }
      } else if (item.action === "remove") {
        const detached = await client.vectorStores.files.delete(item.remote!.fileId, { vector_store_id: args.storeId });
        if (!detached.deleted) {
          throw new Error(`OpenAI did not confirm removal of ${item.remote!.fileId}.`);
        }
      }

      appendJournal(journalPath, {
        runId, event: "completed", action: item.action, sourceId: item.sourceId,
        oldFileId: item.remote?.fileId, newFileId
      });
      if (state) {
        updateLocalState(state, item, newFileId);
        writeVectorStoreState(config.statePath, state);
      }
      console.log(`Completed ${item.action}: ${item.sourceId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendJournal(journalPath, {
        runId, event: "failed", action: item.action, sourceId: item.sourceId,
        oldFileId: item.remote?.fileId, newFileId, message
      });
      throw new Error(`Sync stopped at ${item.sourceId}: ${message}. Check ${journalPath} before retrying.`);
    }
  }
  appendJournal(journalPath, { runId, event: "finish" });
  console.log(`Sync complete. Audit log: ${journalPath}`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { manifests: [], removals: [], apply: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--store" || arg === "--manifest" || arg === "--remove" || arg === "--plan") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.`);
      }
      if (arg === "--store") args.storeId = value;
      if (arg === "--manifest") args.manifests.push(value);
      if (arg === "--remove") args.removals.push(value);
      if (arg === "--plan") args.expectedPlan = value;
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage}`);
    }
  }
  return args;
}

function requiredAttribute(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${filePath} is missing required string attribute ${field}.`);
  }
  return value.trim();
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stateBelongsToStore(state: VectorStoreState, storeId: string): boolean {
  const ids = state.vectorStoreIds ?? (state.vectorStoreId ? [state.vectorStoreId] : []);
  return ids.length === 1 && ids[0] === storeId;
}

function updateLocalState(state: VectorStoreState, item: SyncPlanItem, newFileId?: string): void {
  state.files = state.files.filter((file) => file.id !== item.sourceId);
  if (item.action !== "remove") {
    const local = item.local!;
    state.files.push({
      id: item.sourceId, title: local.title, type: local.type,
      fileId: newFileId ?? item.remote?.fileId, relativePath: local.relativePath
    });
  }
  state.documentCount = state.files.length;
  state.bookCount = state.files.filter((file) => file.type === "book").length;
  state.podcastCount = state.files.filter((file) => file.type === "podcast").length;
  state.articleCount = state.files.filter((file) => file.type === "article").length;
}

function appendJournal(filePath: string, value: Record<string, unknown>): void {
  fs.appendFileSync(filePath, `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`, "utf8");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
