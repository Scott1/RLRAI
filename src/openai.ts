import OpenAI from "openai";

export function createOpenAIClient(apiKey?: string): OpenAI {
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Copy .env.example to .env and set your key.");
  }

  return new OpenAI({ apiKey });
}

export function getResponseText(response: unknown): string {
  if (typeof response === "object" && response !== null && "output_text" in response) {
    const outputText = (response as { output_text?: unknown }).output_text;
    if (typeof outputText === "string") {
      return outputText.trim();
    }
  }

  const output = typeof response === "object" && response !== null && "output" in response
    ? (response as { output?: unknown }).output
    : undefined;

  if (!Array.isArray(output)) {
    return "";
  }

  const pieces: string[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null || !("content" in item)) {
      continue;
    }

    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (typeof part !== "object" || part === null) {
        continue;
      }

      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") {
        pieces.push(text);
      }
    }
  }

  return pieces.join("\n").trim();
}
