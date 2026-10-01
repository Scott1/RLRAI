import type { RetrievalResult, SourceCitation, SourceMetadata } from "./types";

export const BOOK_DISPLAY_NAME = "Real Love Ready: A Guide to Relational Literacy by Robin Ducharme";
export const BOOK_URL = "https://www.realloveready.com/book";

export function sourceDisplayName(metadata: SourceMetadata): string {
  const prefix = metadata.type === "book"
    ? BOOK_DISPLAY_NAME
    : metadata.type === "podcast"
      ? metadata.series ?? "Let's Talk Love"
      : metadata.publication ?? "Real Love Ready article";
  const dated = metadata.date ? `${metadata.title} (${metadata.date})` : metadata.title;
  return `${prefix} - ${dated}`;
}

export function citationKey(index: number): string {
  return `S${index + 1}`;
}

export function buildCitations(results: RetrievalResult[]): SourceCitation[] {
  const byDocument = new Map<string, SourceCitation>();

  for (const result of results) {
    const id = result.metadata.id;
    const existing = byDocument.get(id);

    if (!existing) {
      byDocument.set(id, {
        key: citationKey(byDocument.size),
        metadata: result.metadata,
        score: result.score,
        filename: result.filename
      });
      continue;
    }

    if (typeof result.score === "number" && (existing.score === undefined || result.score > existing.score)) {
      existing.score = result.score;
    }
  }

  return [...byDocument.values()];
}

export function citedSources(answer: string, sources: SourceCitation[]): SourceCitation[] {
  const byKey = new Map(sources.map((source) => [source.key, source]));
  const cited: SourceCitation[] = [];
  const seen = new Set<string>();

  for (const match of answer.matchAll(/\[S\d+\]/g)) {
    const key = match[0].slice(1, -1);
    const source = byKey.get(key);
    if (source && !seen.has(key)) {
      cited.push(source);
      seen.add(key);
    }
  }

  return cited;
}

export function formatSourcesList(sources: SourceCitation[]): string {
  if (sources.length === 0) {
    return "Sources:\nNo sufficiently relevant approved RLR sources found.";
  }

  const lines = sources.map((source, index) => {
    const url = source.metadata.source_url ? ` (${source.metadata.source_url})` : "";
    return `${index + 1}. [${source.key}] ${sourceDisplayName(source.metadata)}${url}`;
  });

  return `Sources:\n${lines.join("\n")}`;
}

export function trimExcerpt(text: string, maxLength = 1200): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}
