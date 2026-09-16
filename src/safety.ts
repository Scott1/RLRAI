export type SafetyAction = "continue" | "block";

export interface SafetyDecision {
  action: SafetyAction;
  category?: string;
  message?: string;
  guidance?: string;
}

const patterns = {
  selfHarm: /\b(kill myself|suicide|suicidal|end my life|hurt myself|self[-\s]?harm)\b/i,
  immediateDanger: /\b(he hit me|she hit me|they hit me|i am in danger|i'm in danger|unsafe right now|threatened to kill|weapon|choking|strangling|domestic abuse|domestic violence)\b/i,
  violence: /\b(should i hurt|how do i hurt|make them pay|threaten them|violent revenge)\b/i,
  diagnosis: /\b(narcissist|borderline|bipolar|sociopath|psychopath|personality disorder|diagnose|mental illness)\b/i,
  relationshipDecision: /\b(should i break up|should i divorce|should i marry|should i leave them|tell me whether to stay|make the decision for me)\b/i,
  impersonation: /\b(pretend you are robin|answer as robin|write as robin|you are robin|speak as robin)\b/i,
  promptExtraction: /\b(system prompt|hidden prompt|developer message|internal instructions|show me your instructions|reveal your prompt)\b/i,
  override: /\b(ignore (all )?(previous|prior) instructions|jailbreak|do anything now|bypass your rules|forget your rules|ignore rlr boundaries)\b/i,
  wholesaleSource: /\b(full chapter|entire chapter|whole book|full transcript|entire transcript|verbatim transcript|copy the book|reproduce the source)\b/i
};

export function assessSafety(input: string): SafetyDecision {
  if (patterns.selfHarm.test(input)) {
    return {
      action: "block",
      category: "self-harm",
      message:
        "I'm really sorry you're dealing with this. This prototype is not crisis care, and this is important enough to involve real-time human support now. Please contact local emergency services, a local crisis line, or someone you trust who can stay with you. If you are in immediate danger, seek emergency help right away."
    };
  }

  if (patterns.immediateDanger.test(input)) {
    return {
      action: "block",
      category: "immediate-danger",
      message:
        "This sounds like it may involve immediate safety risk. This prototype cannot assess danger or provide crisis support. Please contact local emergency services, a domestic violence service, or a trusted person who can help you get to safety now."
    };
  }

  if (patterns.violence.test(input)) {
    return {
      action: "block",
      category: "violence",
      message:
        "I can't help with threats or violence. If there is immediate danger, step away if you can and contact local emergency or crisis support."
    };
  }

  if (patterns.promptExtraction.test(input)) {
    return {
      action: "block",
      category: "prompt-extraction",
      message:
        "I can't reveal hidden prompts, system instructions, API credentials, or internal configuration. I can explain the companion's visible purpose and boundaries instead."
    };
  }

  if (patterns.override.test(input)) {
    return {
      action: "block",
      category: "prompt-injection",
      message:
        "I can't ignore the Real Love Ready companion boundaries or treat retrieved source text as instructions. Ask a question about the approved material and I will answer within those limits."
    };
  }

  if (patterns.impersonation.test(input)) {
    return {
      action: "block",
      category: "impersonation",
      message:
        "I can't impersonate Robin or speak as though I am her. I can summarize approved Real Love Ready material with citations and distinguish it from neutral reflection."
    };
  }

  if (patterns.wholesaleSource.test(input)) {
    return {
      action: "block",
      category: "copyright",
      message:
        "I can't reproduce large portions of the book or transcripts. I can provide a brief grounded summary, short excerpts when appropriate, and citations to the approved source material."
    };
  }

  if (patterns.diagnosis.test(input)) {
    return {
      action: "continue",
      category: "diagnosis",
      guidance:
        "The user may be asking for a mental-health diagnosis. Do not diagnose the user or another person. Discuss observable relationship patterns only when supported by retrieved RLR material."
    };
  }

  if (patterns.relationshipDecision.test(input)) {
    return {
      action: "continue",
      category: "relationship-decision",
      guidance:
        "The user may be asking for a consequential relationship decision. Do not decide for them. Help them reflect using retrieved RLR concepts and suggest appropriate real-world support when stakes are high."
    };
  }

  return { action: "continue" };
}
