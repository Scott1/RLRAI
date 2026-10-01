import { createHash } from "node:crypto";
import { attributesEqual } from "./syncAttributes";

export interface LocalSyncFile {
  sourceId: string;
  title: string;
  type: string;
  path: string;
  relativePath: string;
  uploadFilename: string;
  attributes: Record<string, string | number | boolean>;
  sha256: string;
}

export interface RemoteSyncFile {
  sourceId: string;
  fileId: string;
  status: string;
  attributes: Record<string, string | number | boolean>;
  sha256?: string;
}

export type SyncAction = "add" | "replace" | "metadata" | "remove" | "unchanged";

export interface SyncPlanItem {
  action: SyncAction;
  sourceId: string;
  local?: LocalSyncFile;
  remote?: RemoteSyncFile;
}

export interface SyncPlan {
  storeId: string;
  items: SyncPlanItem[];
  digest: string;
}

export function createSyncPlan(
  storeId: string,
  localFiles: LocalSyncFile[],
  remoteFiles: RemoteSyncFile[],
  removeSourceIds: string[]
): SyncPlan {
  const local = uniqueBySourceId(localFiles, "selected manifests");
  const remote = uniqueBySourceId(remoteFiles, "vector store");
  const removals = new Set(removeSourceIds);
  if (removals.size !== removeSourceIds.length) {
    throw new Error("A source ID was repeated in --remove arguments.");
  }

  const items: SyncPlanItem[] = [];
  for (const [sourceId, file] of [...local].sort(([a], [b]) => a.localeCompare(b))) {
    if (removals.has(sourceId)) {
      throw new Error(`Source ${sourceId} cannot be selected for upload and removal together.`);
    }
    const existing = remote.get(sourceId);
    if (!existing) {
      items.push({ action: "add", sourceId, local: file });
      continue;
    }
    if (existing.status !== "completed") {
      throw new Error(`Source ${sourceId} is ${existing.status} in the vector store; wait or resolve it first.`);
    }
    if (!existing.sha256) {
      throw new Error(`Could not compare uploaded content for ${sourceId}.`);
    }
    const action = existing.sha256 !== file.sha256
      ? "replace"
      : attributesEqual(existing.attributes, file.attributes) ? "unchanged" : "metadata";
    items.push({ action, sourceId, local: file, remote: existing });
  }

  for (const sourceId of [...removals].sort()) {
    const existing = remote.get(sourceId);
    if (!existing) {
      throw new Error(`Cannot remove ${sourceId}: it is not in vector store ${storeId}.`);
    }
    items.push({ action: "remove", sourceId, remote: existing });
  }

  const digest = createHash("sha256").update(JSON.stringify({
    storeId,
    items: items.map((item) => ({
      action: item.action,
      sourceId: item.sourceId,
      localSha256: item.local?.sha256,
      uploadFilename: item.local?.uploadFilename,
      localAttributes: item.local && sortedAttributes(item.local.attributes),
      oldFileId: item.remote?.fileId,
      remoteStatus: item.remote?.status,
      remoteSha256: item.remote?.sha256,
      remoteAttributes: item.remote && sortedAttributes(item.remote.attributes)
    }))
  })).digest("hex");

  return { storeId, items, digest };
}

function uniqueBySourceId<T extends { sourceId: string }>(files: T[], location: string): Map<string, T> {
  const output = new Map<string, T>();
  for (const file of files) {
    if (!file.sourceId) {
      throw new Error(`A file in ${location} has no source ID.`);
    }
    if (output.has(file.sourceId)) {
      throw new Error(`Duplicate source ID ${file.sourceId} in ${location}. Resolve this before syncing.`);
    }
    output.set(file.sourceId, file);
  }
  return output;
}

function sortedAttributes(attributes: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b)));
}
