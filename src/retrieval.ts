import type OpenAI from "openai";
import { buildCitations, citationKey, trimExcerpt } from "./citations";
import type { RetrievalResult, SourceCitation, SourceMetadata } from "./types";

interface SearchOptions {
  vectorStoreIds: string[];
  maxResults: number;
}

interface RawSearchResult {
  file_id?: string;
  filename?: string;
  score?: number;
  attributes?: Record<string, unknown> | null;
  content?: Array<{ type?: string; text?: string }>;
}

export async function searchRlrContent(
  client: OpenAI,
  query: string,
  options: SearchOptions
): Promise<RetrievalResult[]> {
  const perStoreMax = Math.max(options.maxResults, 1);
  const pages = await Promise.all(options.vectorStoreIds.map(async (vectorStoreId) => {
    const page = await client.vectorStores.search(vectorStoreId, {
      query,
      max_num_results: perStoreMax,
      rewrite_query: true
    });

    const data = Array.isArray((page as { data?: unknown }).data)
      ? ((page as { data: RawSearchResult[] }).data)
      : [];

    return data.map((result, index) => mapSearchResult(result, index, vectorStoreId));
  }));

  return pages
    .flat()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, options.maxResults);
}

export function hasAdequateSupport(results: RetrievalResult[], minScore: number): boolean {
  if (results.length === 0) {
    return false;
  }

  const topScore = results
    .map((result) => result.score)
    .filter((score): score is number => typeof score === "number")
    .sort((a, b) => b - a)[0];

  return topScore === undefined ? true : topScore >= minScore;
}

export function buildRetrievalContext(results: RetrievalResult[]): { context: string; sources: SourceCitation[] } {
  const sources = buildCitations(results);
  const sourceKeyById = new Map(sources.map((source) => [source.metadata.id, source.key]));

  const blocks = results.map((result) => {
    const key = sourceKeyById.get(result.metadata.id) ?? citationKey(0);
    const metadata = result.metadata;
    const score = typeof result.score === "number" ? result.score.toFixed(3) : "n/a";

    return [
      `[${key}]`,
      `Title: ${metadata.title}`,
      `Type: ${metadata.type}`,
      `Canonicality: ${metadata.canonicality}`,
      `Source URL: ${metadata.source_url ?? "n/a"}`,
      `Score: ${score}`,
      "Passage:",
      trimExcerpt(result.text)
    ].join("\n");
  });

  return {
    context: blocks.join("\n\n---\n\n"),
    sources
  };
}

function mapSearchResult(result: RawSearchResult, index: number, vectorStoreId: string): RetrievalResult {
  const attributes = result.attributes ?? {};
  const metadata = metadataFromAttributes(attributes);
  const text = result.content
    ?.map((part) => part.text)
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n")
    .trim() ?? "";

  return {
    id: `${metadata.id}:${index}`,
    fileId: result.file_id ?? "",
    filename: result.filename ?? "",
    score: result.score,
    text,
    metadata,
    vectorStoreId
  };
}

function metadataFromAttributes(attributes: Record<string, unknown>): SourceMetadata {
  const type = attributes.type === "podcast" ? "podcast" : "book";
  const canonicality = stringAttribute(attributes.canonicality, "peer") as SourceMetadata["canonicality"];
  const participants = typeof attributes.participants === "string" && attributes.participants.length > 0
    ? attributes.participants.split(",").map((participant) => participant.trim()).filter(Boolean)
    : undefined;

  return {
    ...attributes,
    id: stringAttribute(attributes.id ?? attributes.source_id ?? attributes.section_id ?? attributes.episode_id, "unknown-source"),
    type,
    title: stringAttribute(attributes.title, "Untitled source"),
    canonicality,
    rights_status: "approved",
    source_url: optionalStringAttribute(attributes.source_url),
    participants,
    date: optionalStringAttribute(attributes.date)
  };
}

function stringAttribute(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function optionalStringAttribute(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
