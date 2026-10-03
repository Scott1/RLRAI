import type OpenAI from "openai";
import { BOOK_URL, buildCitations, citationKey } from "./citations";
import type { RetrievalResult, SourceCitation, SourceMetadata } from "./types";

interface SearchOptions {
  vectorStoreIds: string[];
  maxResults: number;
  candidateMaxResults?: number;
  maxPassagesPerDocument?: number;
  minScore?: number;
  onSearchDiagnostics?: (diagnostics: { vectorStoreId: string; searchQuery: unknown; returnedPassages: number }) => void;
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
  const perStoreMax = Math.min(50, Math.max(options.candidateMaxResults ?? options.maxResults, 1));
  const pages = await Promise.all(options.vectorStoreIds.map(async (vectorStoreId) => {
    const request = client.vectorStores.search(vectorStoreId, {
      query,
      max_num_results: perStoreMax,
      rewrite_query: true
    });
    // The SDK's Page wrapper omits search_query; inspection reads the raw response.
    const page = options.onSearchDiagnostics
      ? await (await request.asResponse()).json() as { data?: RawSearchResult[]; search_query?: unknown }
      : await request;

    const data = Array.isArray((page as { data?: unknown }).data)
      ? ((page as { data: RawSearchResult[] }).data)
      : [];

    options.onSearchDiagnostics?.({ vectorStoreId,
      searchQuery: (page as unknown as { search_query?: unknown }).search_query,
      returnedPassages: data.length });

    return data.map((result, index) => mapSearchResult(result, index, vectorStoreId));
  }));

  const ranked = pages
    .flat()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return options.maxPassagesPerDocument === undefined
    ? ranked.slice(0, options.maxResults)
    : selectDiversePassages(ranked, options.maxResults, options.maxPassagesPerDocument, options.minScore ?? 0);
}

export function selectDiversePassages(
  results: RetrievalResult[], maxResults: number, maxPerDocument: number, minScore: number
): RetrievalResult[] {
  if (!Number.isInteger(maxResults) || maxResults < 1 || !Number.isInteger(maxPerDocument) || maxPerDocument < 1 ||
      !Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    throw new Error("Passage limits must be positive integers and the minimum score must be between 0 and 1.");
  }
  const counts = new Map<string, number>();
  const seen = new Map<string, Set<string>>();
  const selected: RetrievalResult[] = [];
  for (const result of [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    if (typeof result.score !== "number" || !Number.isFinite(result.score) || result.score < minScore || !result.text.trim()) continue;
    const document = result.metadata.id !== "unknown-source" && result.metadata.id
      ? `source:${result.metadata.id}`
      : `file:${result.fileId || `${result.vectorStoreId ?? ""}:${result.filename || result.id}`}`;
    const count = counts.get(document) ?? 0;
    const texts = seen.get(document) ?? new Set<string>();
    if (count >= maxPerDocument || texts.has(result.text.trim())) continue;
    selected.push(result);
    counts.set(document, count + 1);
    texts.add(result.text.trim());
    seen.set(document, texts);
    if (selected.length === maxResults) break;
  }
  return selected;
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
      ...(metadata.series ? [`Series: ${metadata.series}`] : []),
      ...(metadata.publication ? [`Publication: ${metadata.publication}`] : []),
      ...(metadata.author ? [`Author: ${metadata.author}`] : []),
      `Canonicality: ${metadata.canonicality}`,
      `Source URL: ${metadata.source_url ?? "n/a"}`,
      `Score: ${score}`,
      "Passage:",
      result.text.trim()
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
  const type = attributes.type === "podcast" ? "podcast" : attributes.type === "article" ? "article" : "book";
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
    source_url: type === "podcast"
      ? optionalStringAttribute(attributes.podcast_page_url)
        ?? optionalStringAttribute(attributes.source_url)
        ?? optionalStringAttribute(attributes.transcript_url)
      : type === "book" ? BOOK_URL : optionalStringAttribute(attributes.source_url),
    series: optionalStringAttribute(attributes.series),
    publication: optionalStringAttribute(attributes.publication),
    author: optionalStringAttribute(attributes.author),
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
