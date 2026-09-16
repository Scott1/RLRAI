import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface ManifestUploadDocument {
  path: string;
  relativePath: string;
  uploadFilename: string;
  attributes: Record<string, string | number | boolean>;
}

interface ManifestRecord {
  openai_upload_filename?: unknown;
  file_path?: unknown;
  attributes?: unknown;
}

export async function loadManifestUploadDocuments(
  manifestPaths: string[],
  contentRoots: string[]
): Promise<ManifestUploadDocument[]> {
  const documents: ManifestUploadDocument[] = [];
  const seenPaths = new Set<string>();

  for (const manifestPath of manifestPaths) {
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifestDir = path.dirname(manifestPath);

    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) {
        continue;
      }

      const record = JSON.parse(line) as ManifestRecord;
      const filePath = resolveManifestFilePath(record, manifestDir, contentRoots);
      const attributes = normalizeAttributes(record.attributes);

      if (attributes.rights_status !== "approved") {
        throw new Error(`${manifestPath}:${index + 1} has rights_status other than approved`);
      }

      if (seenPaths.has(filePath)) {
        throw new Error(`Duplicate upload file in manifests: ${filePath}`);
      }

      seenPaths.add(filePath);
      documents.push({
        path: filePath,
        relativePath: path.relative(path.dirname(manifestPath), filePath).replaceAll("\\", "/"),
        uploadFilename: stringField(record.openai_upload_filename, path.basename(filePath)),
        attributes
      });
    }
  }

  return documents;
}

function resolveManifestFilePath(record: ManifestRecord, manifestDir: string, contentRoots: string[]): string {
  const filePath = stringField(record.file_path, "");
  if (!filePath) {
    throw new Error(`Manifest record is missing file_path near ${manifestDir}`);
  }

  const candidates = [
    path.resolve(manifestDir, "..", filePath),
    path.resolve(manifestDir, filePath),
    ...contentRoots.map((root) => path.resolve(root, filePath)),
    ...contentRoots.map((root) => path.resolve(root, filePath.replace(/^content[\\/]/, "")))
  ];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Could not resolve upload file for manifest path: ${filePath}`);
  }

  return path.resolve(found);
}

function normalizeAttributes(value: unknown): Record<string, string | number | boolean> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Manifest record attributes must be an object");
  }

  const output: Record<string, string | number | boolean> = {};
  for (const [key, attributeValue] of Object.entries(value)) {
    if (
      typeof attributeValue === "string" ||
      typeof attributeValue === "number" ||
      typeof attributeValue === "boolean"
    ) {
      output[key] = typeof attributeValue === "string" ? truncateAttribute(attributeValue) : attributeValue;
    } else if (attributeValue === null || attributeValue === undefined) {
      output[key] = "";
    } else {
      output[key] = truncateAttribute(JSON.stringify(attributeValue));
    }
  }

  return output;
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function truncateAttribute(value: string): string {
  return value.length <= 512 ? value : value.slice(0, 512);
}
