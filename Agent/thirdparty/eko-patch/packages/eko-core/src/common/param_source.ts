/**
 * Parameter Source Expression Format
 * 
 * This module defines the expression formats used to document where parameter values
 * come from for machine reproducibility. It provides utilities for:
 * - Expression format documentation (for prompts/LLMs)
 * - Parameter source analysis and validation
 * - Inference of parameter sources from context
 */

import { TracedEvent } from "./execution_tracer";

// ============================================================================
// Expression Format Documentation (for LLM prompts)
// ============================================================================

/**
 * The param_sources expression format documentation string.
 * Use this in agent prompts to explain the expected format.
 */
export const PARAM_SOURCES_PROMPT = `* param_sources Expression Format:
  The 'param_sources' parameter documents where each parameter value comes from for machine reproducibility.
  Use these expression formats:
  - from_llm(...sources): LLM derives the value from the specified sources. Sources can be:
    * 'any' - indicates value comes from user query, context, or LLM reasoning (not from tool outputs)
    * tool_call['<tool_call_id>'].outputs["<field>"] - references a specific field from a previous tool's result
    * Multiple sources can be combined, e.g., from_llm(tool_call['id1'].outputs["elements"], tool_call['id2'].outputs["data"], any)
  - string("<value>", "<pattern>"): String literal, optionally with a regex pattern (use null if no pattern)
  - number(<value>): Numeric literal value
  - boolean(<value>): Boolean literal (true/false)
  - enum("<value>"): String value from a fixed set of allowed values (e.g., enum("left"), enum("down"))
  - null / undefined: Null or undefined values
  - tool_call['<tool_call_id>'].outputs["<field>"]: Value is directly copied from a previous tool's output field (no LLM transformation)
  - selector(<selector_json>, ...sources): Selector object chosen by LLM. First param is the selector JSON, remaining params are sources LLM used to generate it:
    * tool_call['<tool_call_id>'].outputs["elements"] - references elements from a previous tool's result
    * 'any' - indicates additional reasoning from user query, context, or LLM knowledge
    * Example: selector({"id": "submit-btn"}, tool_call['toolu_abc'].outputs["elements"], tool_call['toolu_def'].outputs["elements"], any)
  - subset(tool_call['<tool_call_id>'].outputs["<field>"]): Value is a subset of previous tool's output array
  
  Examples:
  - url: string("https://example.com", null)
  - selector: selector({"id": "submit-btn"}, tool_call['toolu_abc123'].outputs["elements"], any)
  - selector with multiple sources: selector({"index": 5}, tool_call['toolu_abc'].outputs["elements"], tool_call['toolu_def'].outputs["elements"], any)
  - text: from_llm(any)
  - text from tool output: from_llm(tool_call['toolu_xyz'].outputs["title"], any)
  - tabId: tool_call['toolu_xyz789'].outputs["tabId"]
  - duration: number(500)
  - enter: boolean(true)`;

/**
 * Shortened param_sources description for tool parameter descriptions.
 */
export const PARAM_SOURCES_TOOL_DESCRIPTION = 
  "Documents where each parameter value comes from. See 'param_sources Expression Format' section above for available expressions (from_llm, string, number, boolean, enum, tool_call, selector, subset, etc.).";

// ============================================================================
// Known Enum Parameters
// ============================================================================

/**
 * Known enum parameters and their valid values.
 * Used to detect when a parameter value is from a fixed set of allowed values.
 */
export const ENUM_PARAMETERS: Record<string, Set<string>> = {
  button: new Set(["left", "right", "middle"]),
  direction: new Set(["up", "down"]),
};

/**
 * Checks if a value is a known enum value for the given parameter key.
 */
export function isEnumValue(key: string, value: any): boolean {
  if (typeof value !== "string") return false;
  const enumValues = ENUM_PARAMETERS[key];
  return enumValues ? enumValues.has(value) : false;
}

// ============================================================================
// Expression Builders
// ============================================================================

/**
 * Converts a primitive value to its expression format.
 * Returns null if the value is not a simple primitive.
 */
export function primitiveToExpression(key: string, value: any): string | null {
  if (typeof value === "boolean") {
    return `boolean(${value})`;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return `number(${value})`;
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  // Check for enum values
  if (isEnumValue(key, value)) {
    return `enum("${value}")`;
  }
  return null;
}

/**
 * Builds a selector expression.
 */
export function buildSelectorExpression(selectorValue: any, ...sources: string[]): string {
  const selectorJson = JSON.stringify(selectorValue);
  return `selector(${selectorJson}, ${sources.join(", ")})`;
}

/**
 * Builds a tool_call output reference.
 */
export function buildToolCallReference(toolId: string, field: string): string {
  return `tool_call['${toolId}'].outputs["${field}"]`;
}

/**
 * Builds a from_llm expression.
 */
export function buildFromLlmExpression(...sources: string[]): string {
  return `from_llm(${sources.join(", ")})`;
}

/**
 * Builds a subset expression.
 */
export function buildSubsetExpression(toolId: string, field: string): string {
  return `subset(tool_call['${toolId}'].outputs["${field}"])`;
}

/**
 * Builds a string expression with optional pattern.
 */
export function buildStringExpression(value: string, pattern: string | null): string {
  return `string("${value}", ${pattern ? `"${pattern}"` : "null"})`;
}

// ============================================================================
// Validation Types
// ============================================================================

export interface ValidationFailure {
  paramName: string;
  invalidToolCallId: string;
  validToolCallIds: string[];
  validToolCallsInfo?: { toolId: string; toolName: string; description: string }[];
  invalidOutputField?: string;
  availableOutputFields?: string[];
  outputFieldError?: string;
}

export interface ValidToolCallInfo {
  toolId: string;
  toolName: string;
  description: string;
}

export interface FieldValidationResult {
  valid: boolean;
  availableFields?: string[];
  errorMessage?: string;
}

// ============================================================================
// Parameter Source Analyzer
// ============================================================================

/**
 * Analyzes and validates parameter sources.
 * This class encapsulates all the logic for:
 * - Extracting param_sources from tool params
 * - Validating tool_call ID references
 * - Inferring sources when not provided
 */
export class ParamSourceAnalyzer {
  
  /**
   * Analyzes where each parameter value likely came from.
   * 
   * @param params The tool parameters
   * @param previousEvents Events that occurred before this tool call
   * @param extractToolResultContent Function to extract content from tool results
   * @returns Object with sources for each parameter, and optional __validationFailures
   */
  analyzeParameterSources(
    params: Record<string, any>,
    previousEvents: TracedEvent[],
    extractToolResultContent: (toolResult: any) => string
  ): Record<string, string> & { __validationFailures?: ValidationFailure[] } {
    // Check if param_sources is provided directly in the params object
    let llmSources: Record<string, string> | null = null;
    
    if (params.param_sources && typeof params.param_sources === 'object') {
      llmSources = params.param_sources as Record<string, string>;
      console.log(`[ParamSource] PARSE: Found param_sources in tool params: ${JSON.stringify(llmSources)}`);
    }
    
    // Build a set of all valid tool call IDs from previous events for validation
    const validToolCallsInfo = this.getValidToolCallsFromHistory(previousEvents);
    const validToolCallIds = new Set(validToolCallsInfo.map(tc => tc.toolId));
    
    // If LLM provided explicit sources, use them (with validation)
    if (llmSources && Object.keys(llmSources).length > 0) {
      return this.processExplicitSources(
        params,
        llmSources,
        previousEvents,
        validToolCallIds,
        validToolCallsInfo,
        extractToolResultContent
      );
    }
    
    // Fall back to inference if param_sources not provided
    return this.inferAllSources(params, previousEvents, extractToolResultContent);
  }

  /**
   * Processes explicit param_sources provided by LLM.
   */
  private processExplicitSources(
    params: Record<string, any>,
    llmSources: Record<string, string>,
    previousEvents: TracedEvent[],
    validToolCallIds: Set<string>,
    validToolCallsInfo: ValidToolCallInfo[],
    extractToolResultContent: (toolResult: any) => string
  ): Record<string, string> & { __validationFailures?: ValidationFailure[] } {
    console.log(`[ParamSource] PATH: EXPLICIT - Using param_sources from tool params`);
    const sources: Record<string, string> = {};
    const validationFailures: ValidationFailure[] = [];
    
    for (const [key] of Object.entries(params)) {
      // Skip param_sources itself - it's meta-information
      if (key === 'param_sources') {
        continue;
      }
      
      if (llmSources[key]) {
        const sourceValue = String(llmSources[key]);
        const paramValue = params[key];
        
        // Override: If LLM says "from_llm(any)" but the actual value is a primitive,
        // replace with the appropriate primitive expression
        if (sourceValue === "from_llm(any)") {
          const primitiveExpr = primitiveToExpression(key, paramValue);
          if (primitiveExpr) {
            console.log(`[ParamSource]   ${key}: LLM_PROVIDED from_llm(any) -> OVERRIDE to ${primitiveExpr}`);
            sources[key] = primitiveExpr;
            continue;
          }
        }
        
        // Validate tool_call references
        const validatedSource = this.validateAndProcessSource(
          key,
          sourceValue,
          previousEvents,
          validToolCallIds,
          validToolCallsInfo,
          validationFailures,
          extractToolResultContent
        );
        sources[key] = validatedSource;
      } else {
        // LLM didn't provide source for this param, fall back to inference
        console.log(`[ParamSource]   ${key}: MISSING -> falling back to inference`);
        sources[key] = this.inferParameterSource(key, params[key], previousEvents, extractToolResultContent);
      }
    }
    
    // Attach validation failures if any
    if (validationFailures.length > 0) {
      (sources as any).__validationFailures = validationFailures;
    }
    
    return sources;
  }

  /**
   * Validates a source expression and returns the validated (or marked invalid) source.
   */
  private validateAndProcessSource(
    key: string,
    sourceValue: string,
    previousEvents: TracedEvent[],
    validToolCallIds: Set<string>,
    validToolCallsInfo: ValidToolCallInfo[],
    validationFailures: ValidationFailure[],
    extractToolResultContent: (toolResult: any) => string
  ): string {
    // Check for tool_call ID references
    const toolCallIdMatch = sourceValue.match(/tool_call\['([^']+)'\]/);
    if (!toolCallIdMatch) {
      console.log(`[ParamSource]   ${key}: LLM_PROVIDED -> ${sourceValue}`);
      return sourceValue;
    }
    
    const referencedToolId = toolCallIdMatch[1];
    
    // Validate tool_call ID exists
    if (!validToolCallIds.has(referencedToolId)) {
      console.log(`[ParamSource]   ${key}: LLM_PROVIDED -> ${sourceValue}`);
      console.log(`[ParamSource]   ⚠️ WARNING: Referenced tool_call ID '${referencedToolId}' does NOT exist, marking as unknown`);
      console.log(`[ParamSource]   ⚠️ Valid tool_call IDs: [${Array.from(validToolCallIds).join(', ')}]`);
      
      // Mark as unknown and continue with tool execution instead of failing validation
      return `unknown`;
    }
    
    // For direct tool_call references (not wrapped in from_llm), validate output field
    const isDirectToolCallReference = sourceValue.match(/^tool_call\[/);
    const outputFieldMatch = sourceValue.match(/\.outputs\["([^"]+)"\]/);
    
    if (isDirectToolCallReference && outputFieldMatch) {
      const outputField = outputFieldMatch[1];
      const fieldValidation = this.validateToolCallOutputField(
        referencedToolId,
        outputField,
        previousEvents,
        extractToolResultContent
      );
      
      if (!fieldValidation.valid) {
        console.log(`[ParamSource]   ${key}: LLM_PROVIDED -> ${sourceValue}`);
        console.log(`[ParamSource]   ⚠️ WARNING: ${fieldValidation.errorMessage}, marking as unknown`);
        if (fieldValidation.availableFields) {
          console.log(`[ParamSource]   ⚠️ Available fields: [${fieldValidation.availableFields.join(', ')}]`);
        }
        
        // Mark as unknown and continue with tool execution instead of failing validation
        return `unknown`;
      }
      
      console.log(`[ParamSource]   ${key}: LLM_PROVIDED -> ${sourceValue} (✓ validated)`);
      return sourceValue;
    }
    
    // Tool call ID is valid, no field validation needed
    console.log(`[ParamSource]   ${key}: LLM_PROVIDED -> ${sourceValue} (✓ tool_call ID validated)`);
    return sourceValue;
  }

  /**
   * Infers sources for all parameters when param_sources is not provided.
   */
  private inferAllSources(
    params: Record<string, any>,
    previousEvents: TracedEvent[],
    extractToolResultContent: (toolResult: any) => string
  ): Record<string, string> {
    console.log(`[ParamSource] PATH: INFERENCE - No param_sources provided, inferring all`);
    const sources: Record<string, string> = {};
    
    for (const [key, value] of Object.entries(params)) {
      // Skip meta-parameters
      if (key === 'param_sources') {
        continue;
      }
      // Reason is always from LLM context
      if (key === 'reason') {
        sources[key] = 'from_llm(any)';
        continue;
      }
      sources[key] = this.inferParameterSource(key, value, previousEvents, extractToolResultContent);
    }
    
    return sources;
  }

  /**
   * Infers parameter source when not explicitly provided.
   */
  private inferParameterSource(
    key: string,
    value: any,
    previousEvents: TracedEvent[],
    extractToolResultContent: (toolResult: any) => string
  ): string {
    // 1. Handle primitives first (boolean, number, null, undefined, enum)
    const primitiveExpr = primitiveToExpression(key, value);
    if (primitiveExpr) {
      console.log(`[ParamSource]   ${key}: PRIMITIVE -> ${primitiveExpr}`);
      return primitiveExpr;
    }
    
    // 2. Handle string values
    if (typeof value === "string") {
      return this.inferStringSource(key, value, previousEvents, extractToolResultContent);
    }
    
    // 3. Handle selector/index parameters
    if (key === "selector" || key === "index" || key === "element_index" || key === "loginTriggerSelector") {
      return this.inferSelectorSource(key, value, previousEvents, extractToolResultContent);
    }
    
    // 4. Handle elements array (subset detection)
    if (key === "elements" && Array.isArray(value)) {
      return this.inferElementsSource(key, value, previousEvents, extractToolResultContent);
    }
    
    // 5. Check if value appears directly in previous tool results
    const valueStr = JSON.stringify(value);
    const toolResultRef = this.findValueInPreviousToolResults(valueStr, previousEvents, extractToolResultContent);
    if (toolResultRef) {
      console.log(`[ParamSource]   ${key}: DIRECT_TOOL_OUTPUT -> ${toolResultRef}`);
      return toolResultRef;
    }
    
    // 6. Default - LLM determined based on context
    console.log(`[ParamSource]   ${key}: DEFAULT_LLM -> from_llm(any)`);
    return `from_llm(any)`;
  }

  /**
   * Infers source for string parameters.
   */
  private inferStringSource(
    key: string,
    value: string,
    previousEvents: TracedEvent[],
    extractToolResultContent: (toolResult: any) => string
  ): string {
    // URL special handling
    if (key === "url") {
      try {
        new URL(value); // Validate it's a proper URL
        const urlPattern = this.generateUrlPattern(value);
        console.log(`[ParamSource]   ${key}: STRING_URL -> string with pattern`);
        return buildStringExpression(value, urlPattern);
      } catch {
        // Not a valid URL, treat as regular string
      }
    }
    
    // Check if URL-like value exists in previous tool results
    if (value.startsWith("http") || value.startsWith("www")) {
      const toolRef = this.findValueInPreviousToolResults(value, previousEvents, extractToolResultContent);
      if (toolRef) {
        console.log(`[ParamSource]   ${key}: STRING_URL_FROM_TOOL -> ${toolRef}`);
        return toolRef;
      }
    }
    
    // Default string handling
    console.log(`[ParamSource]   ${key}: STRING_LITERAL -> string`);
    return buildStringExpression(value, null);
  }

  /**
   * Infers source for selector/index parameters.
   */
  private inferSelectorSource(
    key: string,
    value: any,
    previousEvents: TracedEvent[],
    extractToolResultContent: (toolResult: any) => string
  ): string {
    const valueStr = JSON.stringify(value);
    
    // Check if the selector value appears in previous tool results
    const toolResultRef = this.findValueInPreviousToolResults(valueStr, previousEvents, extractToolResultContent);
    if (toolResultRef) {
      const result = buildSelectorExpression(value, toolResultRef, "any");
      console.log(`[ParamSource]   ${key}: SELECTOR_FROM_TOOL -> ${result}`);
      return result;
    }
    
    // Generate index source expression based on element matching
    const indexExpr = this.generateIndexSourceExpression(value, previousEvents, key, extractToolResultContent);
    console.log(`[ParamSource]   ${key}: SELECTOR_INFERRED -> ${indexExpr}`);
    return indexExpr;
  }

  /**
   * Infers source for elements array parameters (subset detection).
   */
  private inferElementsSource(
    key: string,
    value: any[],
    previousEvents: TracedEvent[],
    extractToolResultContent: (toolResult: any) => string
  ): string {
    console.log(`[ParamSource]   ${key}: CHECKING_SUBSET - array length ${value.length}`);
    
    const subsetResult = this.findSubsetRelationship(value, previousEvents, extractToolResultContent);
    if (subsetResult) {
      if (subsetResult.relationship === 'exact') {
        const result = buildToolCallReference(subsetResult.toolId, subsetResult.fieldName);
        console.log(`[ParamSource]   ${key}: EXACT_MATCH -> ${result}`);
        return result;
      } else if (subsetResult.relationship === 'subset') {
        const result = buildSubsetExpression(subsetResult.toolId, subsetResult.fieldName);
        console.log(`[ParamSource]   ${key}: SUBSET (${value.length}/${subsetResult.supersetLength}) -> ${result}`);
        return result;
      }
    }
    
    // Fallback - check for direct match in tool results
    const valueStr = JSON.stringify(value);
    const toolResultRef = this.findValueInPreviousToolResults(valueStr, previousEvents, extractToolResultContent);
    if (toolResultRef) {
      console.log(`[ParamSource]   ${key}: DIRECT_MATCH -> ${toolResultRef}`);
      return toolResultRef;
    }
    
    console.log(`[ParamSource]   ${key}: NO_MATCH -> from_llm(any)`);
    return `from_llm(any)`;
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Gets valid tool calls from history, filtering out failed tool calls.
   */
  getValidToolCallsFromHistory(previousEvents: TracedEvent[]): ValidToolCallInfo[] {
    const toolCalls = new Map<string, { toolName: string; hasResult: boolean; isError: boolean }>();
    
    // First pass: collect all tool_use events
    for (const event of previousEvents) {
      const msg = event.message as any;
      if (msg.type === "tool_use" && msg.toolId) {
        toolCalls.set(msg.toolId, {
          toolName: msg.toolName || "unknown",
          hasResult: false,
          isError: false
        });
      }
    }
    
    // Second pass: mark which ones have results and check for errors
    for (const event of previousEvents) {
      const msg = event.message as any;
      if (msg.type === "tool_result" && msg.toolId && toolCalls.has(msg.toolId)) {
        const info = toolCalls.get(msg.toolId)!;
        info.hasResult = true;
        info.isError = msg.toolResult?.isError === true;
      }
    }
    
    // Return only tool calls with successful results
    const validToolCalls: ValidToolCallInfo[] = [];
    for (const [toolId, info] of toolCalls) {
      if (info.hasResult && !info.isError) {
        validToolCalls.push({
          toolId,
          toolName: info.toolName,
          description: `${info.toolName}(${toolId})`
        });
      }
    }
    
    return validToolCalls;
  }

  /**
   * Validates that a referenced output field exists in a tool call's result.
   */
  validateToolCallOutputField(
    toolId: string,
    outputField: string,
    previousEvents: TracedEvent[],
    extractToolResultContent: (toolResult: any) => string
  ): FieldValidationResult {
    // Find the tool_result event for this tool_call
    for (const event of previousEvents) {
      const msg = event.message as any;
      if (msg.type === "tool_result" && msg.toolId === toolId) {
        const resultContent = extractToolResultContent(msg.toolResult);
        
        // Try to parse as JSON and check if the field exists
        try {
          const parsed = JSON.parse(resultContent);
          if (typeof parsed !== 'object' || parsed === null) {
            return {
              valid: false,
              errorMessage: `Tool result is not an object (type: ${typeof parsed})`
            };
          }
          
          const availableFields = Object.keys(parsed);
          
          if (outputField in parsed) {
            return { valid: true, availableFields };
          } else {
            return {
              valid: false,
              availableFields,
              errorMessage: `Field "${outputField}" does not exist. Available: [${availableFields.join(', ')}]`
            };
          }
        } catch {
          return {
            valid: false,
            errorMessage: `Tool result is not valid JSON, cannot validate field "${outputField}"`
          };
        }
      }
    }
    
    return {
      valid: false,
      errorMessage: `No tool_result found for tool_call '${toolId}'`
    };
  }

  /**
   * Searches previous tool results for a value.
   */
  private findValueInPreviousToolResults(
    value: string,
    events: TracedEvent[],
    extractToolResultContent: (toolResult: any) => string
  ): string | null {
    for (let i = events.length - 1; i >= 0; i--) {
      const msg = events[i].message as any;
      if (msg.type === "tool_result" && msg.toolId) {
        const resultContent = extractToolResultContent(msg.toolResult);
        
        // Try to parse as JSON and search field by field
        const fieldMatch = this.findValueInParsedResult(resultContent, value);
        if (fieldMatch) {
          return buildToolCallReference(msg.toolId, fieldMatch);
        }
        
        // Fallback: check if value appears in the raw content string
        if (resultContent.includes(value)) {
          const fieldName = this.detectFieldContainingValue(resultContent, value);
          return buildToolCallReference(msg.toolId, fieldName);
        }
      }
    }
    return null;
  }

  /**
   * Searches for a value within a parsed tool result object.
   */
  private findValueInParsedResult(content: string, value: string): string | null {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }
      return this.searchValueInObject(parsed, value);
    } catch {
      return null;
    }
  }

  /**
   * Recursively searches for a value in an object.
   */
  private searchValueInObject(obj: any, value: string): string | null {
    for (const [key, fieldValue] of Object.entries(obj)) {
      if (typeof fieldValue === 'string') {
        if (fieldValue === value || fieldValue.includes(value)) {
          return key;
        }
      } else if (typeof fieldValue === 'number' || typeof fieldValue === 'boolean') {
        if (String(fieldValue) === value) {
          return key;
        }
      } else if (Array.isArray(fieldValue)) {
        const arrayStr = JSON.stringify(fieldValue);
        if (arrayStr === value) {
          return key;
        }
        // Check for structural equality
        try {
          const parsedValue = JSON.parse(value);
          if (Array.isArray(parsedValue) && this.arraysEqual(fieldValue, parsedValue)) {
            return key;
          }
        } catch { /* ignore */ }
        
        // Search within array items
        for (const item of fieldValue) {
          if (typeof item === 'string' && (item === value || item.includes(value))) {
            return key;
          } else if (typeof item === 'object' && item !== null) {
            const nestedResult = this.searchValueInObject(item, value);
            if (nestedResult) return key;
          }
        }
        
        // Only allow substring matching for object-type values
        const isObjectValue = value.startsWith('{') || value.startsWith('[');
        if (isObjectValue && arrayStr.includes(value)) {
          return key;
        }
      } else if (typeof fieldValue === 'object' && fieldValue !== null) {
        const nestedResult = this.searchValueInObject(fieldValue, value);
        if (nestedResult) return key;
      }
    }
    return null;
  }

  /**
   * Detects which field contains the given value.
   */
  private detectFieldContainingValue(content: string, value: string): string {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [key, fieldValue] of Object.entries(parsed)) {
          const fieldStr = typeof fieldValue === "string" ? fieldValue : JSON.stringify(fieldValue);
          if (fieldStr.includes(value)) {
            return key;
          }
        }
      }
    } catch { /* ignore */ }
    
    // Heuristic detection
    if (value.startsWith("http") || value.startsWith("www")) return "url";
    if (content.includes(`"elements"`) && content.includes(value)) return "elements";
    if (content.includes(`"title"`) && content.includes(value)) return "title";
    return "elements";
  }

  /**
   * Finds subset relationship between an array and previous tool outputs.
   */
  private findSubsetRelationship(
    value: any[],
    events: TracedEvent[],
    extractToolResultContent: (toolResult: any) => string
  ): { toolId: string; fieldName: string; relationship: 'exact' | 'subset'; supersetLength: number } | null {
    for (let i = events.length - 1; i >= 0; i--) {
      const msg = events[i].message as any;
      if (msg.type === "tool_result" && msg.toolId) {
        const resultContent = extractToolResultContent(msg.toolResult);
        
        try {
          const parsed = JSON.parse(resultContent);
          if (typeof parsed !== 'object' || parsed === null) continue;
          
          for (const [fieldName, fieldValue] of Object.entries(parsed)) {
            if (Array.isArray(fieldValue)) {
              // Check for exact match
              if (this.arraysEqual(value, fieldValue)) {
                return { toolId: msg.toolId, fieldName, relationship: 'exact', supersetLength: fieldValue.length };
              }
              // Check for subset
              if (this.isArraySubset(value, fieldValue)) {
                return { toolId: msg.toolId, fieldName, relationship: 'subset', supersetLength: fieldValue.length };
              }
            }
          }
        } catch { /* ignore */ }
      }
    }
    return null;
  }

  /**
   * Generates index source expression based on element matching.
   */
  private generateIndexSourceExpression(
    indexValue: any,
    previousEvents: TracedEvent[],
    paramName: string,
    extractToolResultContent: (toolResult: any) => string
  ): string {
    // Find the last tool output with DOM elements
    let lastDomToolId: string | null = null;
    
    for (let i = previousEvents.length - 1; i >= 0; i--) {
      const msg = previousEvents[i].message as any;
      if (msg.type === "tool_result" && msg.toolId) {
        const content = extractToolResultContent(msg.toolResult);
        if (this.outputContainsDomElements(content)) {
          lastDomToolId = msg.toolId;
          break;
        }
      }
    }
    
    if (lastDomToolId) {
      return buildSelectorExpression(indexValue, buildToolCallReference(lastDomToolId, "elements"), "any");
    }
    
    // Fallback: use any last tool output
    for (let i = previousEvents.length - 1; i >= 0; i--) {
      const msg = previousEvents[i].message as any;
      if (msg.type === "tool_result" && msg.toolId) {
        return buildSelectorExpression(indexValue, buildToolCallReference(msg.toolId, "elements"), "any");
      }
    }
    
    return `from_llm(any)`;
  }

  /**
   * Checks if output content contains DOM element definitions.
   */
  private outputContainsDomElements(content: string): boolean {
    // Pattern: [N] followed by element-like content
    if (/\[\d+\]\s*[<\w]/.test(content)) return true;
    // Pattern: "index": N in JSON
    if (/"index"\s*:\s*\d+/.test(content)) return true;
    // Pattern: contains "elements" or "clickable_elements" array
    if (/"(?:elements|clickable_elements|selector_map)"\s*:/.test(content)) return true;
    // Pattern: HTML-like tags with indices
    if (/<(?:button|a|input|div|span|img)[^>]*>/.test(content) && /\[\d+\]/.test(content)) return true;
    return false;
  }

  /**
   * Generates a URL pattern for matching similar URLs.
   */
  private generateUrlPattern(url: string): string | null {
    try {
      const u = new URL(url);
      const proto = u.protocol.replace(":", "");
      const host = u.host;
      const path = u.pathname;
      
      const keys = Array.from(u.searchParams.keys());
      if (keys.length === 0) return null;
      
      const seen = new Set<string>();
      const requiredKeys = keys.filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
      
      const base = "^" + this.escapeRegex(proto) + ":\\/\\/" + 
        this.escapeRegex(host) + this.escapeRegex(path).replace(/\//g, "\\/") + "\\?";
      const required = requiredKeys.map((k) => `${this.escapeRegex(k)}=[^&]+`).join("&");
      const rest = "(&[^#]*)?$";
      
      return base + required + rest;
    } catch {
      return null;
    }
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ============================================================================
  // Array Comparison Utilities
  // ============================================================================

  private arraysEqual(arr1: any[], arr2: any[]): boolean {
    if (arr1.length !== arr2.length) return false;
    for (let i = 0; i < arr1.length; i++) {
      if (!this.deepEquals(arr1[i], arr2[i])) return false;
    }
    return true;
  }

  private isArraySubset(subset: any[], superset: any[]): boolean {
    if (subset.length >= superset.length) return false;
    for (const subsetItem of subset) {
      let found = false;
      for (const supersetItem of superset) {
        if (this.deepEquals(subsetItem, supersetItem)) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }

  private deepEquals(a: any, b: any): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;
    if (typeof a !== 'object') return a === b;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!this.deepEquals(a[i], b[i])) return false;
      }
      return true;
    }
    
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    
    for (const key of keysA) {
      if (!(key in b)) return false;
      if (!this.deepEquals(a[key], b[key])) return false;
    }
    return true;
  }
}

// Export a singleton instance for convenience
export const paramSourceAnalyzer = new ParamSourceAnalyzer();
