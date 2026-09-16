import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { Canonicality, SourceDocument, SourceMetadata, SourceType } from "../types";

const frontMatterPattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const ingestibleExtensions = new Set([".md", ".markdown", ".txt"]);

type MetadataInput = Record<string, unknown>;

export interface ParsedDocument {
  raw: string;
  body: string;
  metadata: Partial<SourceMetadata> & Record<string, unknown>;
}

export function parseDocument(raw: string): ParsedDocument {
  const match = raw.match(frontMatterPattern);
  if (!match) {
    throw new Error("Missing YAML front matter delimited by ---");
  }

  const frontMatter = match[1] ?? "";
  const parsed = parse(frontMatter);
  if (!isRecord(parsed)) {
    throw new Error("YAML front matter must be a mapping/object");
  }

  return {
    raw,
    body: raw.slice(match[0].length).trim(),
    metadata: normalizeMetadata(parsed)
  };
}

export async function discoverContentFiles(contentDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      const baseName = path.basename(entry.name).toLowerCase();
      if (ingestibleExtensions.has(extension) && baseName !== "readme.md") {
        files.push(absolute);
      }
    }
  }

  await walk(contentDir);
  return files.sort();
}

export async function loadSourceDocument(filePath: string, rootDir: string): Promise<SourceDocument> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = parseDocument(raw);
  const metadata = parsed.metadata as SourceMetadata;

  return {
    path: filePath,
    relativePath: path.relative(rootDir, filePath).replaceAll("\\", "/"),
    raw: parsed.raw,
    body: parsed.body,
    metadata
  };
}

export function metadataToAttributes(metadata: SourceMetadata, relativePath: string): Record<string, string | number | boolean> {
  return {
    id: metadata.id,
    type: metadata.type,
    title: truncateAttribute(metadata.title),
    canonicality: metadata.canonicality ?? "peer",
    rights_status: metadata.rights_status,
    source_url: truncateAttribute(metadata.source_url ?? ""),
    participants: truncateAttribute(metadata.participants?.join(", ") ?? ""),
    date: metadata.date ?? "",
    source_path: truncateAttribute(relativePath)
  };
}

function normalizeMetadata(input: MetadataInput): Partial<SourceMetadata> & Record<string, unknown> {
  return {
    ...input,
    id: toOptionalString(input.id),
    type: toOptionalString(input.type) as SourceType | undefined,
    title: toOptionalString(input.title),
    canonicality: toOptionalString(input.canonicality) as Canonicality | undefined,
    rights_status: toOptionalString(input.rights_status) as "approved" | undefined,
    source_url: toOptionalString(input.source_url),
    participants: normalizeParticipants(input.participants),
    date: normalizeDate(input.date)
  };
}

function normalizeParticipants(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }

  return undefined;
}

function normalizeDate(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).trim();
}

function toOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const stringValue = String(value).trim();
  return stringValue.length > 0 ? stringValue : undefined;
}

function truncateAttribute(value: string): string {
  return value.length <= 512 ? value : value.slice(0, 512);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
