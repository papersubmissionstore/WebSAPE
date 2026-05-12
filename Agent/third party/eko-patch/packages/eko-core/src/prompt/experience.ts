export function buildExperienceSummarizationPrompt(input: {
  taskPrompt: string;
  existingExperienceText: string;
  newTrajectoryJson: string;
}): string {
  const { taskPrompt, existingExperienceText, newTrajectoryJson } = input;

  return [
    "You are maintaining a web-browsing agent's EXPERIENCE MEMORY.",
    "Your job: merge the NEW trajectory with EXISTING experience, deduplicate, and extract only actionable, reusable tips.",
    "",
    "Output MUST be strict JSON only (no markdown, no code fences):",
    '{"summary": string, "lessons": string[]}',
    "",
    "Guidelines:",
    "- Focus on actionable browsing tactics, pitfalls, and heuristics.",
    "- Prefer concrete, reusable advice (UI patterns, navigation strategies, form-filling gotchas).",
    "- Avoid restating the task verbatim; avoid generic platitudes.",
    "- If EXISTING already covers something, do not repeat it; only add/update with new details.",
    "- Keep summary <= 400 chars and lessons <= 8 items, each <= 180 chars.",
    "",
    "# Task",
    taskPrompt || "",
    "",
    "# Existing Experience (may be empty)",
    existingExperienceText || "",
    "",
    "# New Trajectory (JSON)",
    newTrajectoryJson || "{}",
  ].join("\n");
}
