import type { SourceDocument, SourceMetadata } from "../types";
import { discoverContentFiles, loadSourceDocument } from "./metadata";

const requiredFields = ["id", "type", "title", "canonicality", "rights_status"] as const;

export interface ValidationIssue {
  filePath: string;
  message: string;
}

export function validateMetadata(metadata: Partial<SourceMetadata>, filePath = "document"): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const field of requiredFields) {
    if (!metadata[field]) {
      issues.push({ filePath, message: `Missing required metadata field: ${field}` });
    }
  }

  if (metadata.type && metadata.type !== "book" && metadata.type !== "podcast") {
    issues.push({ filePath, message: "Metadata field type must be either book or podcast" });
  }

  if (
    metadata.canonicality &&
    metadata.canonicality !== "primary" &&
    metadata.canonicality !== "secondary" &&
    metadata.canonicality !== "peer"
  ) {
    issues.push({ filePath, message: "Metadata field canonicality must be primary, secondary, or peer" });
  }

  if (metadata.rights_status && metadata.rights_status !== "approved") {
    issues.push({ filePath, message: "Refusing to ingest because rights_status is not approved" });
  }

  if (metadata.type === "podcast" && metadata.participants && metadata.participants.length === 0) {
    issues.push({ filePath, message: "participants must not be empty when provided" });
  }

  return issues;
}

export async function loadApprovedDocuments(contentDir: string, rootDir: string): Promise<SourceDocument[]> {
  const files = await discoverContentFiles(contentDir);
  const documents: SourceDocument[] = [];
  const issues: ValidationIssue[] = [];
  const seenIds = new Set<string>();

  for (const file of files) {
    try {
      const document = await loadSourceDocument(file, rootDir);
      const documentIssues = validateMetadata(document.metadata, document.relativePath);

      if (seenIds.has(document.metadata.id)) {
        documentIssues.push({
          filePath: document.relativePath,
          message: `Duplicate source id: ${document.metadata.id}`
        });
      }

      if (documentIssues.length > 0) {
        issues.push(...documentIssues);
        continue;
      }

      seenIds.add(document.metadata.id);
      documents.push(document);
    } catch (error) {
      issues.push({
        filePath: file,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (issues.length > 0) {
    const summary = issues.map((issue) => `- ${issue.filePath}: ${issue.message}`).join("\n");
    throw new Error(`Content validation failed:\n${summary}`);
  }

  return documents;
}
