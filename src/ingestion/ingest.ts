import fs from "node:fs";
import { getConfig, writeVectorStoreState } from "../config";
import { createOpenAIClient } from "../openai";
import type { SourceDocument } from "../types";
import { loadManifestUploadDocuments, type ManifestUploadDocument } from "./manifest";
import { metadataToAttributes } from "./metadata";
import { loadApprovedDocuments } from "./validate";

async function main(): Promise<void> {
  const config = getConfig();
  console.log("Loading approved RLR documents...");

  const documents = config.uploadManifests.length > 0
    ? await loadManifestUploadDocuments(config.uploadManifests, config.uploadContentRoots)
    : await loadApprovedDocuments(config.contentDir, config.rootDir);

  if (documents.length === 0) {
    throw new Error("No approved content documents found.");
  }

  const bookCount = documents.filter((document) => typeForDocument(document) === "book").length;
  const podcastCount = documents.filter((document) => typeForDocument(document) === "podcast").length;

  console.log(`Found ${documents.length} approved documents (${bookCount} book, ${podcastCount} podcast).`);
  console.log("Creating OpenAI vector store...");

  const client = createOpenAIClient(config.apiKey);
  const vectorStore = await client.vectorStores.create({
    name: `Real Love Ready Companion v0.1 - ${new Date().toISOString()}`
  });

  console.log(`Vector store created: ${vectorStore.id}`);
  console.log("");

  const uploadedFiles: Array<{
    id: string;
    title: string;
    type: string;
    fileId?: string;
    relativePath: string;
  }> = [];

  for (const [index, document] of documents.entries()) {
    const progress = `${index + 1}/${documents.length}`;
    console.log(`Uploading ${progress}: ${titleForDocument(document)}`);

    const file = await client.files.create({
      file: fs.createReadStream(document.path),
      purpose: "assistants"
    });

    console.log(`Attaching ${progress}: ${file.id}`);

    await client.vectorStores.files.createAndPoll(vectorStore.id, {
      file_id: file.id,
      attributes: attributesForDocument(document)
    });

    uploadedFiles.push({
      id: sourceIdForDocument(document),
      title: titleForDocument(document),
      type: typeForDocument(document),
      fileId: file.id,
      relativePath: document.relativePath
    });
  }

  writeVectorStoreState(config.statePath, {
    vectorStoreId: vectorStore.id,
    vectorStoreIds: [vectorStore.id],
    createdAt: new Date().toISOString(),
    documentCount: documents.length,
    bookCount,
    podcastCount,
    files: uploadedFiles
  });

  console.log("");
  console.log("RLR ingestion complete");
  console.log("");
  console.log(`Book chapters: ${bookCount}`);
  console.log(`Podcast transcripts: ${podcastCount}`);
  console.log(`Documents uploaded: ${documents.length}`);
  console.log(`Vector store: ${vectorStore.id}`);
  console.log(`State saved: ${config.statePath}`);
}

function attributesForDocument(document: SourceDocument | ManifestUploadDocument): Record<string, string | number | boolean> {
  if ("attributes" in document) {
    return document.attributes;
  }

  return metadataToAttributes(document.metadata, document.relativePath);
}

function sourceIdForDocument(document: SourceDocument | ManifestUploadDocument): string {
  if ("metadata" in document) {
    return document.metadata.id;
  }

  return String(document.attributes.source_id ?? document.attributes.id ?? document.uploadFilename);
}

function titleForDocument(document: SourceDocument | ManifestUploadDocument): string {
  if ("metadata" in document) {
    return document.metadata.title;
  }

  return String(document.attributes.title ?? document.uploadFilename);
}

function typeForDocument(document: SourceDocument | ManifestUploadDocument): string {
  if ("metadata" in document) {
    return document.metadata.type;
  }

  return String(document.attributes.type ?? "unknown");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
