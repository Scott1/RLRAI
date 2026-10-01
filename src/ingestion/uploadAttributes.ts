import { createHash } from "node:crypto";

type Attributes = Record<string, string | number | boolean>;

export function uploadAttributes(attributes: Attributes, bytes: Buffer): Attributes {
  if (attributes.content_sha256 !== undefined) {
    throw new Error("content_sha256 is generated from the uploaded file, not supplied by a manifest.");
  }

  const result = { ...attributes };
  if (result.type === "book") {
    delete result.source_filename;
  } else if (result.type === "podcast") {
    delete result.episode_id;
  }

  result.content_sha256 = createHash("sha256").update(bytes).digest("hex");
  if (Object.keys(result).length > 16) {
    throw new Error(`Upload attributes exceed OpenAI's 16-key limit (${Object.keys(result).length}).`);
  }
  return result;
}
