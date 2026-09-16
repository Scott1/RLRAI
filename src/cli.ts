import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getConfig } from "./config";
import { createOpenAIClient } from "./openai";
import { answerQuestion, renderAnswer } from "./chat";
import type { ChatMessage } from "./types";

async function main(): Promise<void> {
  const config = getConfig();
  const client = createOpenAIClient(config.apiKey);
  const history: ChatMessage[] = [];
  const rl = readline.createInterface({ input, output });

  console.log("Real Love Ready Companion v0.1");
  console.log("");
  console.log("This is an AI educational and reflection companion");
  console.log("grounded in approved Real Love Ready material.");
  console.log("");
  console.log("It is not therapy, diagnosis, crisis care, or professional advice.");
  console.log("");
  console.log("Type exit or quit to leave.");
  console.log("");

  while (true) {
    const question = (await rl.question("> ")).trim();

    if (!question) {
      continue;
    }

    if (question.toLowerCase() === "exit" || question.toLowerCase() === "quit") {
      break;
    }

    console.log("");
    console.log("Searching Real Love Ready...");
    console.log("");

    try {
      const answer = await answerQuestion({ client, config, history, question });
      const rendered = renderAnswer(answer);
      console.log("Answer:");
      console.log(rendered);
      console.log("");

      history.push({ role: "user", content: question });
      history.push({ role: "assistant", content: answer.answer });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      console.log("");
    }
  }

  rl.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
