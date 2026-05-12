/**
 * Qwen Fetch Adapter
 * 
 * Converts Qwen's text-based tool call responses to OpenAI-compatible format.
 * Qwen models may return tool invocations as JSON text in the response content
 * rather than in the structured tool_calls format that @ai-sdk/openai-compatible expects.
 * 
 * This adapter intercepts the response and converts text-based tool calls to proper format.
 * 
 * Handles multiple Qwen output formats:
 * 1. Raw JSON: {"name": "tool_name", "arguments": {...}}
 * 2. Tagged format: <tool_call>{"name": "tool_name", "arguments": {...}}</tool_call>
 * 3. Malformed tagged: <tool_call>\n{"name": "...", "arguments":{...}},{"extra": "data"}</tool_call>
 */
function extractToolCallTagContents(text: string): string[] {
  const contents: string[] = [];
  const tagPattern = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match;
  
  while ((match = tagPattern.exec(text)) !== null) {
    contents.push(match[1].trim());
  }
  
  return contents;
}

/**
 * Strips <tool_call> tags from text and returns the inner content
 */
function stripToolCallTags(text: string): string {
  // Remove <tool_call> and </tool_call> tags (with optional whitespace)
  return text
    .replace(/<tool_call>\s*/gi, '')
    .replace(/\s*<\/tool_call>/gi, '');
}

/**
 * Extracts tool calls from text that contains JSON tool call objects.
 * Searches for {"name": "...", "arguments": {...}} patterns in text.
 * Uses brace counting to extract complete nested JSON objects.
 * 
 * Handles multiple formats:
 * - Raw JSON objects
 * - Content wrapped in <tool_call> tags
 * - Malformed JSON with extra properties at the end
 */
export function extractToolCallsFromText(text: string): Array<{name: string; arguments: any; originalJson: string}> {
  const toolCalls: Array<{name: string; arguments: any; originalJson: string}> = [];
  
  // First, check if there are <tool_call> tags and extract their contents
  const tagContents = extractToolCallTagContents(text);
  
  // Process both tagged content and the original text (with tags stripped)
  const textsToProcess = tagContents.length > 0 
    ? [...tagContents, stripToolCallTags(text)]
    : [text];
  
  for (const processText of textsToProcess) {
    extractToolCallsFromString(processText, toolCalls);
  }
  
  // Normalize all extracted tool calls: fix tool names and argument structure
  return toolCalls.map(tc => {
    const normalizedName = normalizeToolName(tc.name);
    const normalizedArgs = normalizeToolArguments(normalizedName, tc.arguments);
    return {
      name: normalizedName,
      arguments: normalizedArgs,
      originalJson: tc.originalJson
    };
  });
}

/**
 * Extracts tool calls from a single string and adds them to the toolCalls array
 * Handles multiple formats:
 * 1. Standard: {"name": "tool_name", "arguments": {...}}
 * 2. Shorthand: {"tool_name": {...}}  (tool name as key, args as value)
 */
function extractToolCallsFromString(
  text: string, 
  toolCalls: Array<{name: string; arguments: any; originalJson: string}>
): void {
  // First, try to extract standard format: {"name": "...", "arguments": {...}}
  extractStandardToolCalls(text, toolCalls);
  
  // Then, try to extract shorthand format: {"tool_name": {...}}
  extractShorthandToolCalls(text, toolCalls);
}

/**
 * Maps abbreviated/alternate tool names to their canonical names.
 * This ensures tools like 'click' get mapped to 'click_element'.
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  // Click variants
  'click': 'click_element',
  'tap': 'click_element',
  
  // Input variants
  'input': 'input_text',
  'type': 'input_text',
  'enter_text': 'input_text',
  'fill': 'input_text',
  
  // Navigate variants
  'navigate': 'navigate_to',
  'goto': 'navigate_to',
  'go_to': 'navigate_to',
  'open': 'navigate_to',
  'open_url': 'navigate_to',
  
  // Scroll variants
  'scroll_down': 'scroll',
  'scroll_up': 'scroll',
  'scroll_to': 'scroll',
  'scroll_element': 'scroll',
  
  // Screenshot variants
  'take_screenshot': 'screenshot',
  'capture': 'screenshot',
  'capture_screenshot': 'screenshot',
  
  // Send keys variants
  'key': 'send_keys',
  'keys': 'send_keys',
  'press': 'send_keys',
  'keyboard': 'send_keys',
  
  // Select variants
  'select': 'select_option',
  
  // Tab/window variants
  'switch': 'switch_tab',
  'switch_window': 'switch_tab',
  'new_window': 'new_tab',
  'close_window': 'close_tab',
  'close': 'close_tab',
  
  // Navigation variants
  'back': 'go_back',
  'forward': 'go_forward',
  
  // Completion variants
  'done': 'finish',
  'complete': 'finish',
  'end': 'finish',
  'stop': 'finish',
  
  // Help variants
  'help': 'human_help',
  
  // Extract/content variants
  'extract': 'extract_data',
  'get_content': 'get_page_content',
  'page_content': 'get_page_content',
  'get_text': 'get_page_content',
  'get_html': 'get_page_content',
  
  // Scroll - map to a no-op or existing tool
  // Note: if scroll doesn't exist in the system, this won't help
  // but at least the name will be consistent
  'scroll_page': 'scroll',
};

/**
 * Normalizes a tool name to its canonical form.
 */
function normalizeToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] || name;
}

/**
 * Normalizes tool arguments to match expected schema.
 * Handles common argument structure issues from LLM output.
 */
function normalizeToolArguments(toolName: string, args: any): any {
  if (!args || typeof args !== 'object') return args;
  
  const normalized = { ...args };
  
  // Remove null/undefined values - LLM often outputs "coordinate_x": null which is useless
  for (const key of Object.keys(normalized)) {
    if (normalized[key] === null || normalized[key] === undefined) {
      delete normalized[key];
    }
  }
  
  // Fix: paramsources -> param_sources (common typo)
  if ('paramsources' in normalized && !('param_sources' in normalized)) {
    normalized.param_sources = normalized.paramsources;
    delete normalized.paramsources;
  }
  
  // Fix: selectoor -> selector (common typo from LLM)
  if ('selectoor' in normalized && !('selector' in normalized)) {
    normalized.selector = normalized.selectoor;
    delete normalized.selectoor;
  }
  
  // Fix: seletor -> selector (another common typo)
  if ('seletor' in normalized && !('selector' in normalized)) {
    normalized.selector = normalized.seletor;
    delete normalized.seletor;
  }
  
  // Fix: LLM sometimes puts index in param_sources array instead of selector
  // e.g., {"param_sources": [{"index": {"number": 10}}]} instead of {"selector": {"index": 10}}
  if (!('selector' in normalized) && Array.isArray(normalized.param_sources)) {
    for (const ps of normalized.param_sources) {
      if (ps && typeof ps === 'object') {
        // Check for {"index": {"number": N}} pattern
        if (ps.index && typeof ps.index === 'object' && 'number' in ps.index) {
          normalized.selector = { index: ps.index.number };
          break;
        }
        // Check for {"index": N} pattern directly in param_sources
        if ('index' in ps && typeof ps.index === 'number') {
          normalized.selector = { index: ps.index };
          break;
        }
      }
    }
  }
  
  // For click_element: wrap bare 'index' in 'selector' object
  // coordinate_x, coordinate_y, force stay at top level (not inside selector)
  if (toolName === 'click_element' || toolName === 'hover') {
    if ('index' in normalized && !('selector' in normalized)) {
      // Only put index in selector, coordinates stay at top level
      normalized.selector = { index: normalized.index };
      delete normalized.index;
    }
  }
  
  // For input_text: wrap bare 'index' in 'selector' object
  if (toolName === 'input_text') {
    if ('index' in normalized && !('selector' in normalized)) {
      normalized.selector = { index: normalized.index };
      delete normalized.index;
    }
    // Also extract text from param_sources if present
    if (!('text' in normalized) && Array.isArray(normalized.param_sources)) {
      for (const ps of normalized.param_sources) {
        if (ps && typeof ps === 'object' && 'text' in ps) {
          normalized.text = ps.text;
          break;
        }
      }
    }
    // Extract enter from param_sources if present
    if (!('enter' in normalized) && Array.isArray(normalized.param_sources)) {
      for (const ps of normalized.param_sources) {
        if (ps && typeof ps === 'object' && 'enter' in ps) {
          normalized.enter = ps.enter;
          break;
        }
      }
    }
  }
  
  // For select_option: wrap bare 'index' in 'selector' object
  if (toolName === 'select_option') {
    if ('index' in normalized && !('selector' in normalized)) {
      normalized.selector = { index: normalized.index };
      delete normalized.index;
    }
  }
  
  return normalized;
}

/**
 * Known tool names for shorthand format detection.
 * Includes both full names and common abbreviated variants.
 */
const KNOWN_TOOL_NAMES = [
  // Full tool names
  'navigate_to', 'click_element', 'input_text', 'scroll', 'screenshot',
  'get_page_content', 'wait', 'hover', 'select_option', 'send_keys',
  'extract_data', 'evaluate', 'get_elements', 'drag_and_drop',
  'upload_file', 'download_file', 'switch_tab', 'close_tab', 'new_tab',
  'go_back', 'go_forward', 'refresh', 'get_cookies', 'set_cookie',
  'delete_cookies', 'get_local_storage', 'set_local_storage',
  'human_help', 'finish',
  // Abbreviated/alternate names that models may use
  'click', 'input', 'navigate', 'type', 'press', 'key', 'keys',
  'scroll_down', 'scroll_up', 'scroll_to', 'scroll_element',
  'get_content', 'page_content', 'extract', 'select',
  'drag', 'drop', 'upload', 'download',
  'back', 'forward', 'goto', 'go_to', 'open', 'open_url',
  'get_text', 'get_html', 'get_attribute', 'get_value',
  'set_value', 'clear', 'focus', 'blur', 'submit',
  'wait_for', 'wait_for_element', 'wait_for_navigation',
  'take_screenshot', 'capture', 'capture_screenshot',
  'execute', 'execute_script', 'run_script',
  'switch_frame', 'switch_window', 'new_window', 'switch',
  'close', 'close_window', 'quit',
  'help', 'done', 'complete', 'end', 'stop'
];

/**
 * Extracts standard format tool calls: {"name": "tool_name", "arguments": {...}}
 */
function extractStandardToolCalls(
  text: string,
  toolCalls: Array<{name: string; arguments: any; originalJson: string}>
): void {
  // Look for {"name": pattern
  const namePattern = /"name"\s*:\s*"([^"]+)"/g;
  let match;

  while ((match = namePattern.exec(text)) !== null) {
    const toolName = match[1];
    const startIndex = match.index;
    
    // Find the opening { before "name"
    let objectStart = -1;
    for (let i = startIndex - 1; i >= 0; i--) {
      if (text[i] === '{') {
        objectStart = i;
        break;
      }
      if (text[i] === '}' || text[i] === ']') {
        break;
      }
    }
    
    if (objectStart === -1) continue;
    
    // Extract full JSON object using brace counting
    let braceCount = 0;
    let objectEnd = -1;
    
    for (let i = objectStart; i < text.length; i++) {
      if (text[i] === '{') braceCount++;
      if (text[i] === '}') {
        braceCount--;
        if (braceCount === 0) {
          objectEnd = i;
          break;
        }
      }
    }
    
    if (objectEnd === -1) continue;
    
    try {
      let jsonStr = text.substring(objectStart, objectEnd + 1);
      
      // Try to fix common JSON issues before parsing
      jsonStr = fixMalformedJson(jsonStr);
      
      const toolCall = JSON.parse(jsonStr);
      
      if (toolCall.name && toolCall.arguments) {
        const normalizedName = normalizeToolName(toolCall.name);
        const isDuplicate = toolCalls.some(
          tc => tc.name === normalizedName && 
                JSON.stringify(tc.arguments) === JSON.stringify(toolCall.arguments)
        );
        
        if (!isDuplicate) {
          toolCalls.push({
            name: normalizedName,
            arguments: toolCall.arguments,
            originalJson: jsonStr
          });
        }
      }
    } catch (e) {
      // JSON parsing failed - try to extract a partial/malformed tool call
      tryExtractMalformedToolCall(text, objectStart, objectEnd, toolName, toolCalls);
    }
  }
}

/**
 * Extracts shorthand format tool calls: {"tool_name": {...}}
 * where the tool name is a key and the arguments are the value object
 */
function extractShorthandToolCalls(
  text: string,
  toolCalls: Array<{name: string; arguments: any; originalJson: string}>
): void {
  // Look for known tool names as JSON keys
  for (const toolName of KNOWN_TOOL_NAMES) {
    const pattern = new RegExp(`"${toolName}"\\s*:\\s*\\{`, 'g');
    let match;
    
    while ((match = pattern.exec(text)) !== null) {
      const keyStart = match.index;
      
      // Find the opening { before the tool name key
      let objectStart = -1;
      for (let i = keyStart - 1; i >= 0; i--) {
        const char = text[i];
        if (char === '{') {
          objectStart = i;
          break;
        }
        // Skip whitespace and commas
        if (char !== ' ' && char !== '\n' && char !== '\r' && char !== '\t' && char !== ',') {
          break;
        }
      }
      
      if (objectStart === -1) continue;
      
      // Find where the arguments object starts (after "tool_name": )
      const argsStart = match.index + match[0].length - 1; // Position of opening { of args
      
      // Extract the arguments object using brace counting
      let braceCount = 0;
      let argsEnd = -1;
      
      for (let i = argsStart; i < text.length; i++) {
        if (text[i] === '{') braceCount++;
        if (text[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            argsEnd = i;
            break;
          }
        }
      }
      
      if (argsEnd === -1) continue;
      
      try {
        let argsStr = text.substring(argsStart, argsEnd + 1);
        
        // Try to fix common JSON issues before parsing
        argsStr = fixMalformedJson(argsStr);
        
        const args = JSON.parse(argsStr);
        const normalizedName = normalizeToolName(toolName);
        
        // Check if this is a duplicate
        const isDuplicate = toolCalls.some(
          tc => tc.name === normalizedName && 
                JSON.stringify(tc.arguments) === JSON.stringify(args)
        );
        
        if (!isDuplicate) {
          toolCalls.push({
            name: normalizedName,
            arguments: args,
            originalJson: `{"name": "${normalizedName}", "arguments": ${argsStr}}`
          });
        }
      } catch (e) {
        // JSON parsing failed, skip this one
      }
    }
  }
}

/**
 * Attempts to fix common JSON malformations from LLM output
 */
function fixMalformedJson(json: string): string {
  let fixed = json;
  
  // Fix: "key": "null" -> "key": null (unquoted null)
  // But be careful not to break actual string values
  fixed = fixed.replace(/:\s*"null"\s*([,}])/g, ': null$1');
  
  // Fix: trailing commas before } or ]
  fixed = fixed.replace(/,\s*}/g, '}');
  fixed = fixed.replace(/,\s*]/g, ']');
  
  // Fix: missing value after colon (e.g., "key":} )
  fixed = fixed.replace(/:\s*([}\]])/g, ': null$1');
  
  // Fix: double commas
  fixed = fixed.replace(/,\s*,/g, ',');
  
  return fixed;
}

/**
 * Attempts to extract tool call from malformed JSON
 * Handles cases like: {"name": "tool", "arguments":{...}},{"extra": ...}
 * where extra data is appended after the tool call
 */
function tryExtractMalformedToolCall(
  text: string,
  objectStart: number,
  objectEnd: number,
  toolName: string,
  toolCalls: Array<{name: string; arguments: any; originalJson: string}>
): void {
  // Try to find "arguments" and extract just that portion
  const argsPattern = /"arguments"\s*:\s*\{/g;
  const textSlice = text.substring(objectStart, objectEnd + 1);
  const argsMatch = argsPattern.exec(textSlice);
  
  if (!argsMatch) return;
  
  const argsStart = argsMatch.index + argsMatch[0].length - 1; // Position of opening {
  
  // Count braces to find the end of the arguments object
  let braceCount = 0;
  let argsEnd = -1;
  
  for (let i = argsStart; i < textSlice.length; i++) {
    if (textSlice[i] === '{') braceCount++;
    if (textSlice[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        argsEnd = i;
        break;
      }
    }
  }
  
  if (argsEnd === -1) return;
  
  try {
    const argsStr = textSlice.substring(argsStart, argsEnd + 1);
    const args = JSON.parse(argsStr);
    const normalizedName = normalizeToolName(toolName);
    
    const isDuplicate = toolCalls.some(
      tc => tc.name === normalizedName && 
            JSON.stringify(tc.arguments) === JSON.stringify(args)
    );
    
    if (!isDuplicate) {
      toolCalls.push({
        name: normalizedName,
        arguments: args,
        originalJson: `{"name": "${normalizedName}", "arguments": ${argsStr}}`
      });
    }
  } catch (e) {
    // Still failed, give up on this one
  }
}

/**
 * Cleans tool call content from the response text.
 * Removes:
 * - <tool_call>...</tool_call> blocks entirely
 * - Standalone JSON tool call objects {"name": "...", "arguments": {...}}
 * - Shorthand format tool calls {"tool_name": {...}}
 * - Trailing commas and malformed fragments
 */
function cleanToolCallContent(content: string, debug: boolean = false): string {
  let cleaned = content;
  
  // First, remove all <tool_call>...</tool_call> blocks (including partial/incomplete ones)
  cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');
  
  // Also remove incomplete tool_call tags (e.g., "<tool_call>\n}" at the end)
  cleaned = cleaned.replace(/<tool_call>[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/^[\s\S]*<\/tool_call>/gi, '');
  
  const regionsToRemove: Array<{start: number; end: number}> = [];
  
  // Remove standard format: {"name": "...", "arguments": {...}}
  const namePattern = /"name"\s*:\s*"[^"]+"/g;
  let match;
  
  while ((match = namePattern.exec(cleaned)) !== null) {
    const startIndex = match.index;
    
    // Find the opening { before "name"
    let objectStart = -1;
    for (let i = startIndex - 1; i >= 0; i--) {
      if (cleaned[i] === '{') {
        objectStart = i;
        break;
      }
      if (cleaned[i] === '}' || cleaned[i] === ']') {
        break;
      }
    }
    
    if (objectStart === -1) continue;
    
    // Check if this looks like a tool call by checking for "arguments"
    const afterName = cleaned.substring(startIndex, Math.min(startIndex + 200, cleaned.length));
    if (!/"arguments"\s*:/.test(afterName)) continue;
    
    // Extract full JSON object
    let braceCount = 0;
    let objectEnd = -1;
    
    for (let i = objectStart; i < cleaned.length; i++) {
      if (cleaned[i] === '{') braceCount++;
      if (cleaned[i] === '}') {
        braceCount--;
        if (braceCount === 0) {
          objectEnd = i;
          break;
        }
      }
    }
    
    if (objectEnd !== -1) {
      regionsToRemove.push({ start: objectStart, end: objectEnd + 1 });
    }
  }
  
  // Remove shorthand format: {"tool_name": {...}}
  for (const toolName of KNOWN_TOOL_NAMES) {
    const pattern = new RegExp(`"${toolName}"\\s*:\\s*\\{`, 'g');
    
    while ((match = pattern.exec(cleaned)) !== null) {
      const keyStart = match.index;
      
      // Find the opening { before the tool name key
      let objectStart = -1;
      for (let i = keyStart - 1; i >= 0; i--) {
        const char = cleaned[i];
        if (char === '{') {
          objectStart = i;
          break;
        }
        if (char !== ' ' && char !== '\n' && char !== '\r' && char !== '\t' && char !== ',') {
          break;
        }
      }
      
      if (objectStart === -1) continue;
      
      // Find the end of the outer object
      let braceCount = 0;
      let objectEnd = -1;
      
      for (let i = objectStart; i < cleaned.length; i++) {
        if (cleaned[i] === '{') braceCount++;
        if (cleaned[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            objectEnd = i;
            break;
          }
        }
      }
      
      if (objectEnd !== -1) {
        // Check if this region overlaps with existing regions
        const overlaps = regionsToRemove.some(
          r => (objectStart >= r.start && objectStart < r.end) || 
               (objectEnd >= r.start && objectEnd < r.end)
        );
        if (!overlaps) {
          regionsToRemove.push({ start: objectStart, end: objectEnd + 1 });
        }
      }
    }
  }
  
  // Remove regions from end to start to preserve indices
  regionsToRemove.sort((a, b) => b.start - a.start);
  for (const region of regionsToRemove) {
    cleaned = cleaned.substring(0, region.start) + cleaned.substring(region.end);
  }
  
  // Clean up any remaining artifacts
  cleaned = cleaned
    .replace(/,\s*,/g, ',')        // Remove double commas
    .replace(/^\s*,/gm, '')        // Remove leading commas
    .replace(/,\s*$/gm, '')        // Remove trailing commas
    .replace(/\[\s*,/g, '[')       // Remove comma after opening bracket
    .replace(/,\s*\]/g, ']')       // Remove comma before closing bracket
    .replace(/\{\s*,/g, '{')       // Remove comma after opening brace
    .replace(/,\s*\}/g, '}')       // Remove comma before closing brace
    .replace(/^\s*\}\s*\]\s*\}?\s*$/gm, '') // Remove trailing }]} fragments
    .trim();
  
  if (debug) {
    console.log('[Qwen Adapter] cleanToolCallContent: before length=', content.length, 'after length=', cleaned.length);
  }
  
  return cleaned;
}

export function createQwenFetchAdapter(debug: boolean = false): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const inputStr = typeof input === 'string' ? input : (input as any).url || input.toString();
    
    if (debug) {
      console.log('[Qwen Adapter] Intercepting request to:', inputStr);
    }
    
    // First, make the actual request
    const response = await fetch(input, init);
    
    if (debug) {
      console.log('[Qwen Adapter] Response status:', response.status);
      console.log('[Qwen Adapter] Response content-type:', response.headers.get('content-type'));
    }

    try {
      // Clone the response so we can read it
      const clonedResponse = response.clone();
      const contentType = response.headers.get('content-type') || '';
      
      // Handle both streaming and non-streaming responses
      if (contentType.includes('text/event-stream')) {
        if (debug) {
          console.log('[Qwen Adapter] Detected streaming response');
        }
        return processStreamingResponse(response, debug);
      }

      // For non-streaming responses, parse JSON
      let data;
      try {
        data = await clonedResponse.json();
      } catch (e) {
        if (debug) {
          console.error('[Qwen Adapter] Failed to parse JSON:', e);
        }
        return response;
      }

      if (debug) {
        console.log('[Qwen Adapter] Raw response:', JSON.stringify(data, null, 2));
      }

      // Check if this is a chat completion response
      if (data.choices && data.choices[0]?.message) {
        const message = data.choices[0].message;
        const contentStr = message.content || '';

        if (debug) {
          console.log('[Qwen Adapter] Message content:', contentStr);
        }

        // Extract tool calls (now returns {name, arguments} only)
        const toolCallMatches = extractToolCalls(contentStr, debug);
        
        if (toolCallMatches.length > 0) {
          const toolCalls: any[] = [];
          
          for (let i = 0; i < toolCallMatches.length; i++) {
            const toolCall = toolCallMatches[i];
            const normalizedName = normalizeToolName(toolCall.name);
            const normalizedArgs = normalizeToolArguments(normalizedName, toolCall.arguments);
            toolCalls.push({
              type: 'function',
              id: `call_${Date.now()}_${i}`,
              function: {
                name: normalizedName,
                arguments: JSON.stringify(normalizedArgs),
              },
            });

            if (debug) {
              console.log(`[Qwen Adapter] Converted tool call #${i + 1}: ${toolCall.name} -> ${normalizedName}`, normalizedArgs);
            }
          }

          // Remove the tool call content - use cleanToolCallContent which handles all formats
          let cleanedContent = cleanToolCallContent(contentStr, debug);

          if (debug) {
            console.log('[Qwen Adapter] Cleaned content:', cleanedContent);
            console.log('[Qwen Adapter] Total tool calls found:', toolCalls.length);
          }

          // Modify the response to include tool_calls
          data.choices[0].message = {
            ...message,
            content: cleanedContent || null,
            tool_calls: toolCalls,
          };

          // Update finish_reason if there are only tool calls
          if (!cleanedContent && toolCalls.length > 0) {
            data.choices[0].finish_reason = 'tool_calls';
          }

          if (debug) {
            console.log('[Qwen Adapter] Modified response:', JSON.stringify(data, null, 2));
          }
        } else {
          if (debug) {
            console.log('[Qwen Adapter] No tool calls found in response');
          }
        }
      }

      // Return modified response
      return new Response(JSON.stringify(data), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      if (debug) {
        console.error('[Qwen Adapter] Error processing response:', error);
      }
      // If anything goes wrong, return original response
      return response;
    }
  };
}

/**
 * Process streaming responses line by line
 */
async function processStreamingResponse(response: Response, debug: boolean = false): Promise<Response> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return response;

    const decoder = new TextDecoder();
    const chunks: Uint8Array[] = [];
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const fullText = chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('');
    decoder.decode(); // Flush
    
    if (debug) {
      console.log('[Qwen Adapter] Streaming response text:', fullText.substring(0, 500) + '...');
    }

    // Look for JSON data in SSE format
    const lines = fullText.split('\n');
    const dataLines: any[] = [];
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const jsonStr = line.substring(6).trim();
        if (jsonStr && jsonStr !== '[DONE]') {
          try {
            const jsonData = JSON.parse(jsonStr);
            dataLines.push(jsonData);
          } catch (e) {
            if (debug) {
              console.log('[Qwen Adapter] Could not parse SSE line:', jsonStr);
            }
          }
        }
      }
    }
    
    if (debug) {
      console.log('[Qwen Adapter] Parsed streaming chunks:', dataLines.length);
    }

    // For streaming, just return as-is - tool calls will be in delta
    return response;
  } catch (error) {
    if (debug) {
      console.error('[Qwen Adapter] Error processing streaming response:', error);
    }
    return response;
  }
}

/**
 * Extract tool calls from content string
 * Handles nested JSON objects with multiple properties
 * Also handles <tool_call> tags and malformed JSON
 */
function extractToolCalls(content: string, debug: boolean = false): Array<{name: string; arguments: any}> {
  if (debug) {
    console.log('[Qwen Adapter] Extracting tool calls from content length:', content.length);
  }
  
  // Use the shared extraction function which handles all formats
  const extracted = extractToolCallsFromText(content);
  
  if (debug) {
    console.log('[Qwen Adapter] Extracted tool calls:', extracted.length);
    for (const tc of extracted) {
      console.log(`[Qwen Adapter] - ${tc.name}:`, tc.arguments);
    }
  }
  
  return extracted.map(tc => ({
    name: tc.name,
    arguments: tc.arguments
  }));
}
