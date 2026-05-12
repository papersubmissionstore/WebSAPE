export interface ExperienceUsePromptInput {
  experiences: Array<{
    id: string;
    task: string;
    summary: string;
    lessons: string[];
  }>;
}

export function buildExperienceUsePrompt(input: ExperienceUsePromptInput): string {
  if (!input.experiences.length) return "";

  let payloadText: string;
  try {
    payloadText = JSON.stringify(input.experiences, null, 2);
  } catch {
    payloadText = String(input.experiences);
  }

  return [
    "# Prior Experience",
    "",
    "## Output Format Precedence (READ FIRST)",
    "- The output format required elsewhere in this conversation (e.g., the planner's `<root>...</root>` XML schema, or any JSON schema specified by the orchestrator) is MANDATORY and takes precedence over every instruction in this section.",
    "- Do NOT emit any text outside that required structure. Fold any experience-derived insight silently into the existing fields (e.g., `<thought>` for the planner XML, or `reasoning` for the orchestrator JSON) instead.",
    "- Never introduce new tags, fields, or out-of-format prose to accommodate experience.",
    "",
    "## How to Use",
    "- When planning, check if any experience matches the current task and adjust your approach accordingly.",
    "- When encountering errors, unexpected results, or difficult decisions, review the experience for relevant recovery strategies or critical-path guidance.",
    "- Experience provides key decision points and core steps, not necessarily the full end-to-end workflow. After completing the steps an experience suggests, always re-check the original task requirement: has the task's end-state been reached? If not, continue executing until the task is truly complete (e.g., if the task says 'buy', the end-state is a placed order, not just a filled cart).",
    "",
    "## Trust Policy",
    "- Experience is reference-only, not ground truth. It may be outdated, site-specific, or mismatched.",
    "- Site names in experience indicate where a pattern was observed, not which site you must use. Choose the best platform for the current task independently; experience patterns may transfer across similar platforms.",
    "- If page evidence contradicts what the experience predicted (error, page not found, stale UI, wrong workflow, or outcome mismatching expectations), abandon that experience path immediately and explore alternative approaches.",
    "- If an experience-suggested approach fails to reach the expected outcome after 2 consecutive attempts (e.g., constructed URLs land on wrong pages, filters return no relevant results, UI interactions produce errors), treat the approach itself as unsuitable for this scenario and switch to a simpler alternative (e.g., use site search instead of category navigation, broaden the query instead of adding filters).",
    "- For complex multi-element operations (selecting many checkboxes, configuring multiple settings), prefer incremental execution over bulk changes even if experience describes the complete set. Apply in small batches, verify each, then proceed.",
    "- A high-confidence 'no data found' (e.g., no reviews exist, no matching results, empty search) is a valid task outcome. Do not broaden the search beyond the task's constraints just to produce non-empty results.",
    "- When experience claims a UI feature is absent (e.g., 'no forward button', 'no sort option'), that judgment applies only to the original scenario described. For a different operation (e.g., reply-with-quote vs forward, filter vs sort), verify on the current page first before adopting the workaround.",
    "",
    "## Citation Contract",
    "- Cite a lesson immediately after the sentence it supports, only when that lesson actually informed your planning, reasoning, or tool_call decision. Format:",
    '  [experience:<id>] exact lesson: "<lesson text>"',
    "- Both <id> and <lesson text> must be copied verbatim from the payload below; never fabricate.",
    "",
    "## Selected Experience Payload",
    "```json",
    payloadText,
    "```",
  ].join("\n").trim();
}
