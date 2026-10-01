type Attributes = Record<string, string | number | boolean>;

export function attributesEqual(a: Attributes, b: Attributes): boolean {
  const entries = (attributes: Attributes) => Object.entries(attributes)
    .map(([key, value]) => [key, normalizeEpisodeNumber(key, value)])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  return JSON.stringify(entries(a)) === JSON.stringify(entries(b));
}

function normalizeEpisodeNumber(key: string, value: string | number | boolean) {
  // OpenAI returns numeric episode numbers as canonical decimal strings.
  if (key === "episode_number" && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return value;
}
