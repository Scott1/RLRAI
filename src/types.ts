export type SourceType = "book" | "podcast";

export type Canonicality = "primary" | "secondary" | "peer";

export interface SourceMetadata {
  id: string;
  type: SourceType;
  title: string;
  canonicality?: Canonicality;
  rights_status: "approved";
  source_url?: string;
  participants?: string[];
  date?: string;
  [key: string]: unknown;
}

export interface SourceDocument {
  path: string;
  relativePath: string;
  raw: string;
  body: string;
  metadata: SourceMetadata;
}

export interface RetrievalResult {
  id: string;
  fileId: string;
  filename: string;
  score?: number;
  text: string;
  metadata: SourceMetadata;
  vectorStoreId?: string;
}

export interface SourceCitation {
  key: string;
  metadata: SourceMetadata;
  score?: number;
  filename?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatAnswer {
  answer: string;
  retrieval: RetrievalResult[];
  sources: SourceCitation[];
  safetyCategory?: string;
  insufficientEvidence: boolean;
}
