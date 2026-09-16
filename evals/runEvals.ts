import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answerQuestion } from "../src/chat";
import { getConfig } from "../src/config";
import { createOpenAIClient } from "../src/openai";
import type { ChatMessage } from "../src/types";

interface EvalCase {
  id: string;
  category: string;
  question: string;
  requirements: string[];
}

interface EvalResult {
  id: string;
  category: string;
  question: string;
  requirements: string[];
  answer?: string;
  sources?: string[];
  retrieval?: Array<{
    sourceId: string;
    title: string;
    score?: number;
    filename: string;
    excerpt: string;
  }>;
  error?: string;
  status: "unreviewed" | "error";
}

async function main(): Promise<void> {
  const config = getConfig();
  const client = createOpenAIClient(config.apiKey);
  const cases = await loadEvalCases();
  const results: EvalResult[] = [];

  console.log("");
  console.log(`Running ${cases.length} RLR companion evals...`);
  console.log("");

  for (const [index, testCase] of cases.entries()) {
    const history: ChatMessage[] = [];
    const progress = `${index + 1}/${cases.length}`;
    process.stdout.write(`[${progress}] ${testCase.id} (${testCase.category})... `);

    try {
      const answer = await answerQuestion({
        client,
        config,
        history,
        question: testCase.question
      });

      results.push({
        id: testCase.id,
        category: testCase.category,
        question: testCase.question,
        requirements: testCase.requirements,
        answer: answer.answer,
        sources: answer.sources.map((source) => source.metadata.id),
        retrieval: answer.retrieval.map((result) => ({
          sourceId: result.metadata.id,
          title: result.metadata.title,
          score: result.score,
          filename: result.filename,
          excerpt: result.text.slice(0, 500)
        })),
        status: "unreviewed"
      });
      console.log("ready for review");
    } catch (error) {
      results.push({
        id: testCase.id,
        category: testCase.category,
        question: testCase.question,
        requirements: testCase.requirements,
        error: error instanceof Error ? error.message : String(error),
        status: "error"
      });
      console.log("error");
    }
  }

  await fs.mkdir(config.evalResultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const outputPath = path.join(config.evalResultsDir, `rlr-eval-${timestamp}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2)}\n`);

  printReport(results, outputPath);
}

async function loadEvalCases(): Promise<EvalCase[]> {
  const evalPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "evals.json");
  const raw = await fs.readFile(evalPath, "utf8");
  return JSON.parse(raw) as EvalCase[];
}

function printReport(results: EvalResult[], outputPath: string): void {
  const total = results.length;
  const errors = results.filter((result) => result.status === "error");
  const byCategory = new Map<string, EvalResult[]>();

  for (const result of results) {
    const existing = byCategory.get(result.category) ?? [];
    existing.push(result);
    byCategory.set(result.category, existing);
  }

  console.log("");
  console.log("RLR Companion Eval Report");
  console.log("");
  console.log(`Total tests: ${total}`);
  console.log(`Completed for manual review: ${total - errors.length}`);
  console.log(`Errors: ${errors.length}`);
  console.log("");

  for (const [category, categoryResults] of [...byCategory.entries()].sort()) {
    const categoryErrors = categoryResults.filter((result) => result.status === "error").length;
    console.log(`${category}: ${categoryResults.length - categoryErrors}/${categoryResults.length} ready for review`);
  }

  if (errors.length > 0) {
    console.log("");
    console.log("Errors:");
    for (const error of errors) {
      console.log(`- ${error.id}: ${error.error}`);
    }
  }

  console.log("");
  console.log(`Complete results: ${outputPath}`);
  console.log("Mark pass/fail manually against each test's requirements in the saved JSON.");
}

main().catch((error: unknown) => {
  const modulePath = fileURLToPath(import.meta.url);
  console.error(`${path.basename(modulePath)} failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
