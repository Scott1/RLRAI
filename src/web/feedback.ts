import fs from "node:fs/promises";
import path from "node:path";

export type FeedbackKind = "idea" | "report";

export interface FeedbackSubmission {
  kind: FeedbackKind;
  category: string;
  comment: string;
  responseId?: string;
  includeQuestion: boolean;
}

export type ReviewStatus = "new" | "in_review" | "resolved";

export interface FeedbackReview {
  status: ReviewStatus;
  evalCandidate: boolean;
  adminNote: string;
  evalQuestion: string;
  requirements: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface FeedbackRecord {
  id: string;
  createdAt: string;
  username: string;
  kind: FeedbackKind;
  category: string;
  comment: string;
  model?: string;
  responseId?: string;
  response?: string;
  question?: string;
  sources?: Array<{ key: string; id: string; title: string; sourceUrl?: string }>;
  review: FeedbackReview;
}

export interface ReviewSubmission {
  status: ReviewStatus;
  evalCandidate: boolean;
  adminNote: string;
  evalQuestion: string;
  requirements: string;
}

const categories: Record<FeedbackKind, Set<string>> = {
  idea: new Set(["feature_request", "general_idea", "other_feedback"]),
  report: new Set(["good_response", "inaccurate_source", "overconfident_advice", "safety_concern", "not_rlr", "other"])
};

export function parseFeedbackSubmission(value: unknown): FeedbackSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Feedback must be an object.");
  }

  const input = value as Record<string, unknown>;
  const kind = input.kind;
  if (kind !== "idea" && kind !== "report") {
    throw new Error("Choose a feedback type.");
  }
  if (typeof input.category !== "string" || !categories[kind].has(input.category)) {
    throw new Error("Choose a feedback category.");
  }
  if (typeof input.comment !== "string") {
    throw new Error("Feedback text must be a string.");
  }
  const comment = input.comment.trim();
  if (comment.length > 2000 || (kind === "idea" && comment.length === 0)) {
    throw new Error("Feedback must be between 1 and 2,000 characters for ideas, or at most 2,000 characters for reports.");
  }
  if (kind === "report" && (typeof input.responseId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.responseId))) {
    throw new Error("This response is no longer available to report. Please try a new answer.");
  }

  return {
    kind,
    category: input.category,
    comment,
    responseId: kind === "report" ? input.responseId as string : undefined,
    includeQuestion: kind === "report" && input.includeQuestion === true
  };
}

export function parseReviewSubmission(value: unknown): ReviewSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Review must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (input.status !== "new" && input.status !== "in_review" && input.status !== "resolved") {
    throw new Error("Choose a review status.");
  }
  if (typeof input.evalCandidate !== "boolean") {
    throw new Error("Eval candidate must be true or false.");
  }
  const adminNote = boundedText(input.adminNote, 4000, "Admin note");
  const evalQuestion = boundedText(input.evalQuestion, 2000, "Eval question");
  const requirements = boundedText(input.requirements, 2000, "Expected behavior");
  return { status: input.status, evalCandidate: input.evalCandidate, adminNote, evalQuestion, requirements };
}

export function resolveFeedbackFile(rootDir: string, host: string, environment = process.env): string | undefined {
  if (environment.RAILWAY_ENVIRONMENT_ID || environment.RAILWAY_PROJECT_ID) {
    const mountPath = environment.RAILWAY_VOLUME_MOUNT_PATH?.trim();
    return mountPath ? path.join(mountPath, "feedback.jsonl") : undefined;
  }
  if (environment.RLR_FEEDBACK_FILE?.trim()) {
    return path.resolve(rootDir, environment.RLR_FEEDBACK_FILE.trim());
  }
  return environment.NODE_ENV !== "production" && (host === "127.0.0.1" || host === "localhost")
    ? path.resolve(rootDir, ".rlr/feedback.jsonl")
    : undefined;
}

let writeQueue = Promise.resolve();

export function appendFeedback(filePath: string, record: unknown): Promise<void> {
  const write = writeQueue.then(async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  });
  writeQueue = write.catch(() => undefined);
  return write;
}

export async function listFeedback(filePath: string): Promise<FeedbackRecord[]> {
  await writeQueue;
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records = new Map<string, FeedbackRecord>();
  const reviews = new Map<string, FeedbackReview>();
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`Feedback storage has an invalid entry on line ${index + 1}.`);
    }
    if (entry.event === "review" && typeof entry.feedbackId === "string") {
      reviews.set(entry.feedbackId, {
        status: entry.status as ReviewStatus,
        evalCandidate: entry.evalCandidate === true,
        adminNote: typeof entry.adminNote === "string" ? entry.adminNote : "",
        evalQuestion: typeof entry.evalQuestion === "string" ? entry.evalQuestion : "",
        requirements: typeof entry.requirements === "string" ? entry.requirements : "",
        updatedAt: typeof entry.createdAt === "string" ? entry.createdAt : undefined,
        updatedBy: typeof entry.admin === "string" ? entry.admin : undefined
      });
    } else if (typeof entry.id === "string" && (entry.kind === "idea" || entry.kind === "report")) {
      records.set(entry.id, {
        ...entry,
        id: entry.id,
        createdAt: String(entry.createdAt),
        username: String(entry.username),
        kind: entry.kind,
        category: String(entry.category),
        comment: String(entry.comment),
        review: defaultReview()
      } as FeedbackRecord);
    }
  }

  return [...records.values()]
    .map((record) => ({ ...record, review: reviews.get(record.id) ?? defaultReview() }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function saveFeedbackReview(
  filePath: string,
  feedbackId: string,
  admin: string,
  review: ReviewSubmission
): Promise<FeedbackRecord | undefined> {
  const record = (await listFeedback(filePath)).find((item) => item.id === feedbackId);
  if (!record) {
    return undefined;
  }
  const event = { event: "review", feedbackId, createdAt: new Date().toISOString(), admin, ...review };
  await appendFeedback(filePath, event);
  return { ...record, review: { ...review, updatedAt: event.createdAt, updatedBy: admin } };
}

export function buildEvalCases(records: FeedbackRecord[]): Array<{ id: string; category: string; question: string; requirements: string[] }> {
  return records
    .filter((record) => record.review.evalCandidate && record.review.evalQuestion && record.review.requirements)
    .map((record) => ({
      id: `feedback-${record.id}`,
      category: record.category,
      question: record.review.evalQuestion,
      requirements: record.review.requirements.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    }));
}

function defaultReview(): FeedbackReview {
  return { status: "new", evalCandidate: false, adminNote: "", evalQuestion: "", requirements: "" };
}

function boundedText(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters.`);
  }
  return value.trim();
}
