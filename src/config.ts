import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

export interface VectorStoreState {
  vectorStoreId?: string;
  vectorStoreIds?: string[];
  createdAt: string;
  documentCount: number;
  bookCount: number;
  podcastCount: number;
  files: Array<{
    id: string;
    title: string;
    type: string;
    fileId?: string;
    relativePath: string;
  }>;
}

export interface AppConfig {
  rootDir: string;
  contentDir: string;
  statePath: string;
  apiKey?: string;
  model: string;
  vectorStoreId?: string;
  vectorStoreIds: string[];
  retrievalMaxResults: number;
  minRetrievalScore: number;
  evalResultsDir: string;
  uploadManifests: string[];
  uploadContentRoots: string[];
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getConfig(rootDir = process.cwd()): AppConfig {
  const contentDir = path.resolve(rootDir, process.env.RLR_CONTENT_DIR ?? "content");
  const statePath = path.resolve(rootDir, process.env.RLR_STATE_PATH ?? ".rlr/vector-store.json");
  const state = readVectorStoreState(statePath);
  const envVectorStoreIds = parsePathList(process.env.RLR_VECTOR_STORE_IDS);
  const singleEnvVectorStoreId = process.env.RLR_VECTOR_STORE_ID || undefined;
  const stateVectorStoreIds = state?.vectorStoreIds ?? (state?.vectorStoreId ? [state.vectorStoreId] : []);
  const vectorStoreIds = envVectorStoreIds.length > 0
    ? envVectorStoreIds
    : singleEnvVectorStoreId
      ? [singleEnvVectorStoreId]
      : stateVectorStoreIds;

  return {
    rootDir,
    contentDir,
    statePath,
    apiKey: process.env.OPENAI_API_KEY || undefined,
    model: process.env.OPENAI_MODEL || "gpt-5.2",
    vectorStoreId: vectorStoreIds[0],
    vectorStoreIds,
    retrievalMaxResults: parseNumber(process.env.RLR_RETRIEVAL_MAX_RESULTS, 6),
    minRetrievalScore: parseNumber(process.env.RLR_MIN_RETRIEVAL_SCORE, 0.25),
    evalResultsDir: path.resolve(rootDir, process.env.RLR_EVAL_RESULTS_DIR ?? "evals/results"),
    uploadManifests: parsePathList(process.env.RLR_UPLOAD_MANIFESTS).map((item) => path.resolve(rootDir, item)),
    uploadContentRoots: parsePathList(process.env.RLR_UPLOAD_CONTENT_ROOTS).map((item) => path.resolve(rootDir, item))
  };
}

function parsePathList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value.split(";").map((item) => item.trim()).filter(Boolean);
}

export function readVectorStoreState(statePath: string): VectorStoreState | undefined {
  if (!fs.existsSync(statePath)) {
    return undefined;
  }

  const raw = fs.readFileSync(statePath, "utf8");
  return JSON.parse(raw) as VectorStoreState;
}

export function writeVectorStoreState(statePath: string, state: VectorStoreState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
