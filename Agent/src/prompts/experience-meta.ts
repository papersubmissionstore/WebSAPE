/**
 * Meta Experience — universal lessons injected into every scraping run.
 * These are not query-specific and do not go through LLM select.
 * They follow the same format as selected experience for consistent citation.
 */

export const META_EXPERIENCE_ID = "mandatory_meta_experience";

export function buildExperienceMetaPrompt(): string {
  const metaExperience = {
    id: META_EXPERIENCE_ID,
    task: "Universal operational guidelines for all web automation tasks",
    summary: "Error recovery strategy: detect and handle repeated failures.",
    lessons: [
      "When the same error occurs 3 or more times in a row (same error type, same element or similar selector), stop retrying the same approach. Switch to an alternative strategy: use a different selector (index instead of text, or vice versa), try direct URL navigation, or use a completely different UI path to achieve the same goal.",
    ],
  };

  const payloadText = JSON.stringify([metaExperience], null, 2);

  return [
    "# Meta Experience (Always Applied)",
    "These are universal operational lessons that apply to every task. Cite them the same way as selected experience when they help your decision.",
    "```json",
    payloadText,
    "```",
  ].join("\n").trim();
}
