import { isDeepStrictEqual } from "node:util";

export interface PilotEpisode {
  slug: string;
  title: string;
  host: string;
  guests: string[];
  page_url: string;
}

export interface Utterance {
  start: number;
  end: number;
  speaker: string | null;
  text: string;
  confidence?: number;
}

export function transcriptionOptions(episode: PilotEpisode, speakersExpected?: number) {
  if (speakersExpected !== undefined && (!Number.isInteger(speakersExpected) || speakersExpected < 1)) {
    throw new Error("Expected speaker count must be a positive integer.");
  }
  return {
    ...(speakersExpected === undefined ? {} : { speakers_expected: speakersExpected }),
    speech_models: ["universal-3-5-pro"],
    language_code: "en",
    speaker_labels: true,
    speech_understanding: {
      request: {
        speaker_identification: {
          speaker_type: "name",
          effort: "medium",
          speakers: [
            { name: episode.host, description: "RLR podcast host interviewing the guests; also reads introductions and some advertisements." },
            ...episode.guests.map(name => ({ name, description: "An invited guest participating in this episode's interview." }))
          ]
        }
      }
    }
  };
}

export function validateUtterances(value: unknown): Utterance[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("No speaker utterances returned; keep the raw response for review.");
  for (const item of value) {
    if (!item || typeof item.text !== "string" || !Number.isFinite(item.start) ||
        !Number.isFinite(item.end) || item.start < 0 || item.end < item.start ||
        !(typeof item.speaker === "string" || item.speaker === null)) {
      throw new Error("Invalid speaker utterance in API result.");
    }
  }
  return value as Utterance[];
}

export function selectSpeakerIdentification(original: any, recoveryRequest?: any, recoveryResponse?: any) {
  const identification = original.speech_understanding?.response?.speaker_identification;
  const utterances = validateUtterances(original.utterances);
  if (!recoveryRequest && !recoveryResponse) return { utterances, identification, recoveryApplied: false };
  if (!recoveryRequest || !recoveryResponse || recoveryRequest.transcript_id !== original.id ||
      !isDeepStrictEqual(recoveryRequest.speech_understanding?.request, original.speech_understanding?.request) ||
      recoveryResponse.speech_understanding?.response?.speaker_identification?.status !== "success") {
    throw new Error("Speaker-identification recovery is missing, unsuccessful, or belongs to different settings/job.");
  }
  const recovered = validateUtterances(recoveryResponse.utterances);
  if (recovered.length !== utterances.length || recovered.some((item, index) => item.text !== utterances[index].text ||
      item.start !== utterances[index].start || item.end !== utterances[index].end)) {
    throw new Error("Identification recovery changed dialogue or timing; review it separately instead of silently replacing the draft.");
  }
  return { utterances: recovered, identification: recoveryResponse.speech_understanding.response.speaker_identification,
    recoveryApplied: true };
}

const timestamp = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, "0")).join(":");
};

export function renderTranscript(episode: PilotEpisode, utterances: Utterance[]): string {
  return [
    "---", "provider: assemblyai", "review_required: true", "speaker_identity_verified: false",
    `title: ${JSON.stringify(episode.title)}`, `source_url: ${JSON.stringify(episode.page_url)}`,
    "---", "", `# ${episode.title}`, "",
    "Original complete recording; no additional compression or client-side splits. Names/labels are inferred by the service, not verified. Advertisements are retained. Timestamps refer to this downloaded recording, not YouTube.", "",
    ...utterances.flatMap(item => [
      `[${timestamp(item.start)}-${timestamp(item.end)}] ${item.speaker ?? "Unknown speaker"}: ${item.text}`, ""
    ])
  ].join("\n");
}
