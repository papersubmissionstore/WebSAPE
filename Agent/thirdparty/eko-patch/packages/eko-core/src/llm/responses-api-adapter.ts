/**
 * Responses API Adapter
 * 
 * This module provides a fetch adapter that converts between OpenAI Chat Completions API
 * format and OpenAI Responses API format. This enables using the Responses API with
 * libraries that expect the Chat Completions API format.
 * 
 * Key transformations:
 * - Request: Chat Completions messages → Responses API input items
 * - Response: Responses API output → Chat Completions format
 * - Streaming: Responses API SSE events → Chat Completions SSE chunks
 * - Tool calls: call_XXX IDs → fc_XXX IDs (and back)
 */

/**
 * Configuration for the Responses API adapter
 */
export interface ResponsesApiAdapterConfig {
  /** API version to use for the Responses API (default: 2025-04-01-preview) */
  apiVersion?: string;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Creates a fetch function that adapts Chat Completions API requests to Responses API
 * and transforms the responses back to Chat Completions format.
 * 
 * @param config - Optional configuration for the adapter
 * @returns A fetch function compatible with the fetch API
 */
export function createResponsesApiAdapter(config: ResponsesApiAdapterConfig = {}): typeof fetch {
  const apiVersion = config.apiVersion || '2025-04-01-preview';
  const debug = config.debug ?? true;
  
  const log = (...args: any[]) => {
    if (debug) console.log('[DEBUG]', ...args);
  };
  
  const logError = (...args: any[]) => {
    if (debug) console.error('[DEBUG]', ...args);
  };

  return async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    log('Responses API enabled. Original URL:', url);
    
    // The @ai-sdk/openai-compatible SDK appends "/chat/completions" to the baseURL
    // Replace it with "/responses" endpoint for Responses API
    const finalUrl = url.replace('/chat/completions', `/responses?api-version=${apiVersion}`);
    log('Transformed URL:', finalUrl);
    
    // Transform request body from Chat Completions format to Responses API format
    let modifiedOptions = options;
    let isStreaming = false;
    let requestModel = '';
    
    // Map to track call_id transformations (Chat Completions ID -> Responses API ID)
    const callIdMap = new Map<string, string>();
    
    // Helper to transform call_id from Chat Completions format to Responses API format
    // Responses API requires IDs that begin with 'fc'
    const toResponsesApiCallId = (chatCallId: string): string => {
      if (!chatCallId) return chatCallId;
      if (chatCallId.startsWith('fc')) {
        return chatCallId; // Already in correct format
      }
      // Transform 'call_XXX' to 'fc_XXX' for Responses API
      const fcId = chatCallId.replace(/^call_/, 'fc_');
      callIdMap.set(chatCallId, fcId);
      return fcId;
    };
    
    // Helper to transform call_id from Responses API format back to Chat Completions format
    const toChatCompletionsCallId = (fcCallId: string): string => {
      if (!fcCallId) return fcCallId;
      if (fcCallId.startsWith('call_')) {
        return fcCallId; // Already in Chat Completions format
      }
      // Transform 'fc_XXX' back to 'call_XXX' for Chat Completions
      return fcCallId.replace(/^fc_/, 'call_');
    };
    
    if (options?.body) {
      try {
        const bodyStr = typeof options.body === 'string' ? options.body : await new Response(options.body).text();
        const chatBody = JSON.parse(bodyStr);
        // log('Original request body:', JSON.stringify(chatBody, null, 2));
        
        isStreaming = chatBody.stream === true;
        requestModel = chatBody.model || '';
        
        // Transform to Responses API format
        const responsesBody = transformChatCompletionsToResponsesApi(chatBody, toResponsesApiCallId);

        log('Finishing transforming Responses API request body');
        
        // log('Transformed Responses API body:', JSON.stringify(responsesBody, null, 2));
        
        modifiedOptions = {
          ...options,
          body: JSON.stringify(responsesBody)
        };
      } catch (e) {
        logError('Failed to transform request body:', e);
      }
    }
    
    const response = await fetch(finalUrl, modifiedOptions);
    
    // Handle non-OK responses with detailed logging
    if (!response.ok) {
      const statusText = response.statusText || 'Unknown error';
      logError(`API Error: ${response.status} ${statusText}`);
      try {
        const errorBody = await response.clone().text();
        logError('API Error Body:', errorBody);
      } catch (e) {
        logError('Could not read error body:', e);
      }
      return response;
    }
    
    // Handle streaming responses
    if (isStreaming && response.body) {
      log('Handling streaming response');
      return transformStreamingResponse(response, requestModel, toChatCompletionsCallId, log, logError);
    }
    
    // Handle non-streaming responses
    return transformNonStreamingResponse(response, toChatCompletionsCallId, log);
  };
}

/**
 * Transforms a Chat Completions API request body to Responses API format
 */
function transformChatCompletionsToResponsesApi(
  chatBody: any,
  toResponsesApiCallId: (id: string) => string
): any {
  // Convert messages to input format for Responses API
  const inputItems: any[] = [];
  
  if (chatBody.messages && Array.isArray(chatBody.messages)) {
    for (const msg of chatBody.messages) {
      if (msg.role === 'system') {
        // System messages become instructions in Responses API
        continue;
      }
      
      // Handle assistant messages with tool_calls
      if (msg.role === 'assistant' && msg.tool_calls) {
        // Add the assistant message
        const assistantItem: any = {
          type: 'message',
          role: 'assistant',
          content: []
        };
        if (msg.content) {
          assistantItem.content.push({
            type: 'output_text',
            text: typeof msg.content === 'string' ? msg.content : msg.content.map((c: any) => c.text || '').join('')
          });
        }
        inputItems.push(assistantItem);
        
        // Add function_call items for each tool call
        for (const toolCall of msg.tool_calls) {
          const fcCallId = toResponsesApiCallId(toolCall.id);
          inputItems.push({
            type: 'function_call',
            id: fcCallId,
            call_id: fcCallId,
            name: toolCall.function?.name,
            arguments: toolCall.function?.arguments || '{}'
          });
        }
        continue;
      }
      
      // Handle tool response messages
      if (msg.role === 'tool') {
        const fcCallId = toResponsesApiCallId(msg.tool_call_id);
        inputItems.push({
          type: 'function_call_output',
          call_id: fcCallId,
          output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        });
        continue;
      }
      
      // Handle assistant messages without tool_calls
      if (msg.role === 'assistant') {
        const assistantItem: any = {
          type: 'message',
          role: 'assistant',
          content: []
        };
        
        if (typeof msg.content === 'string' && msg.content) {
          assistantItem.content.push({
            type: 'output_text',
            text: msg.content
          });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text' && part.text) {
              assistantItem.content.push({
                type: 'output_text',
                text: part.text
              });
            }
          }
        }
        
        // Only add if there's content
        if (assistantItem.content.length > 0) {
          inputItems.push(assistantItem);
        }
        continue;
      }
      
      // Handle user messages
      const inputItem: any = {
        type: 'message',
        role: msg.role,
        content: []
      };
      
      if (typeof msg.content === 'string') {
        inputItem.content.push({
          type: 'input_text',
          text: msg.content
        });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            inputItem.content.push({
              type: 'input_text',
              text: part.text
            });
          } else if (part.type === 'image_url' || part.type === 'image') {
            inputItem.content.push({
              type: 'input_image',
              image_url: part.image_url?.url || part.url
            });
          }
        }
      }
      
      inputItems.push(inputItem);
    }
  }
  
  // Build Responses API request body
  const responsesBody: any = {
    model: chatBody.model,
    input: inputItems,
    store: false // Don't store responses by default
  };
  
  // Extract system message as instructions
  const systemMsg = chatBody.messages?.find((m: any) => m.role === 'system');
  if (systemMsg) {
    responsesBody.instructions = typeof systemMsg.content === 'string' 
      ? systemMsg.content 
      : systemMsg.content?.map((c: any) => c.text).join('\n');
  }
  
  // Map tools from Chat Completions format to Responses API format
  if (chatBody.tools && Array.isArray(chatBody.tools)) {
    responsesBody.tools = chatBody.tools.map((tool: any) => {
      if (tool.type === 'function') {
        return {
          type: 'function',
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
          strict: tool.function.strict
        };
      }
      return tool;
    });
  }
  
  // Map tool_choice - transform from Chat Completions format to Responses API format
  if (chatBody.tool_choice !== undefined) {
    // Chat Completions format: "auto", "none", "required", or {"type": "function", "function": {"name": "..."}}
    // Responses API format: "auto", "none", "required", or {"type": "function", "name": "..."}
    if (typeof chatBody.tool_choice === 'string') {
      responsesBody.tool_choice = chatBody.tool_choice;
    } else if (chatBody.tool_choice?.type === 'function' && chatBody.tool_choice?.function?.name) {
      // Transform nested function object to flat structure for Responses API
      responsesBody.tool_choice = {
        type: 'function',
        name: chatBody.tool_choice.function.name
      };
    } else {
      // Pass through as-is for other formats
      responsesBody.tool_choice = chatBody.tool_choice;
    }
  }
  
  // Map other parameters
  if (chatBody.max_tokens || chatBody.max_completion_tokens) {
    responsesBody.max_output_tokens = chatBody.max_completion_tokens || chatBody.max_tokens;
  }
  if (chatBody.temperature !== undefined) {
    responsesBody.temperature = chatBody.temperature;
  }
  if (chatBody.top_p !== undefined) {
    responsesBody.top_p = chatBody.top_p;
  }
  if (chatBody.stream !== undefined) {
    responsesBody.stream = chatBody.stream;
  }
  if (chatBody.parallel_tool_calls !== undefined) {
    responsesBody.parallel_tool_calls = chatBody.parallel_tool_calls;
  }
  
  return responsesBody;
}

/**
 * Transforms a streaming Responses API response to Chat Completions SSE format
 */
function transformStreamingResponse(
  response: Response,
  requestModel: string,
  toChatCompletionsCallId: (id: string) => string,
  log: (...args: any[]) => void,
  logError: (...args: any[]) => void
): Response {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  
  const transformedStream = new ReadableStream({
    async start(controller) {
      let buffer = '';
      let responseId = '';
      let toolCallIndex = 0;
      const toolCallIds = new Map<string, number>(); // Map item_id to tool call index
      const toolCallData = new Map<string, { name: string, arguments: string, call_id: string }>();
      let hasToolCalls = false;
      let usageData: any = null;
      
      // Helper function to create a chunk
      const createChunk = (delta: any, finishReason: string | null = null) => ({
        id: responseId || 'chatcmpl-unknown',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: requestModel,
        choices: [{
          index: 0,
          delta,
          finish_reason: finishReason
        }],
        ...(finishReason && usageData ? { usage: usageData } : {})
      });
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          
          if (done) {
            // Send final [DONE] message
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer
          
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;
            
            // Handle event: lines (some SSE implementations use this)
            if (trimmedLine.startsWith('event:')) {
              continue; // Skip event type lines, we'll parse from data
            }
            
            if (trimmedLine.startsWith('data: ')) {
              const dataStr = trimmedLine.slice(6).trim();
              if (dataStr === '[DONE]') {
                controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                continue;
              }
              
              try {
                const eventData = JSON.parse(dataStr);
                const eventType = eventData.type;
                
                // Log all event types for debugging (except high-frequency delta events)
                if (eventType && !eventType.includes('.delta')) {
                  log('SSE Event:', eventType);
                }
                
                // ===== Response lifecycle events =====
                
                // response.created - Capture response ID
                if (eventType === 'response.created' && eventData.response?.id) {
                  responseId = eventData.response.id;
                  // Send initial chunk with role
                  const chunk = createChunk({ role: 'assistant', content: '' });
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                
                // response.completed - Final event, send finish_reason
                if (eventType === 'response.completed') {
                  // Extract usage data if available
                  if (eventData.response?.usage) {
                    usageData = {
                      prompt_tokens: eventData.response.usage.input_tokens,
                      completion_tokens: eventData.response.usage.output_tokens,
                      total_tokens: eventData.response.usage.total_tokens
                    };
                  }
                  
                  const finishReason = hasToolCalls ? 'tool_calls' : 'stop';
                  const chunk = createChunk({}, finishReason);
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                
                // response.failed - Handle errors
                if (eventType === 'response.failed') {
                  const errorInfo = eventData.response?.error || eventData.error || eventData;
                  logError('Response failed event:', JSON.stringify(errorInfo, null, 2));
                  const errorChunk = {
                    id: responseId || 'chatcmpl-error',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: requestModel,
                    choices: [{
                      index: 0,
                      delta: {},
                      finish_reason: 'error'
                    }],
                    error: errorInfo
                  };
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
                }
                
                // response.incomplete - Handle incomplete responses
                if (eventType === 'response.incomplete') {
                  const chunk = createChunk({}, 'length');
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                
                // ===== Output item events =====
                
                // response.output_item.added - New output item (message or function_call)
                if (eventType === 'response.output_item.added') {
                  const item = eventData.item;
                  
                  // Handle function_call items (tool calls)
                  if (item?.type === 'function_call') {
                    hasToolCalls = true;
                    const currentIndex = toolCallIndex++;
                    const itemId = item.id || `item_${currentIndex}`;
                    const chatCallId = toChatCompletionsCallId(item.call_id || item.id) || `call_${currentIndex}`;
                    toolCallIds.set(itemId, currentIndex);
                    toolCallData.set(itemId, {
                      name: item.name || '',
                      arguments: '',
                      call_id: chatCallId
                    });
                    
                    log('Tool call added:', item.name, 'index:', currentIndex, 'call_id:', chatCallId);
                    
                    // Send initial tool call chunk with name
                    // Include empty content to signal text stream is complete (matches OpenAI behavior)
                    const delta: any = {
                      tool_calls: [{
                        index: currentIndex,
                        id: chatCallId,
                        type: 'function',
                        function: {
                          name: item.name || '',
                          arguments: ''
                        }
                      }]
                    };
                    // Only include content field on the first tool call to signal text-end
                    if (currentIndex === 0) {
                      delta.content = null;
                    }
                    const chunk = createChunk(delta);
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  }
                }
                
                // response.output_item.done - Output item completed
                if (eventType === 'response.output_item.done') {
                  const item = eventData.item;
                  
                  // Handle completed function_call - in case we missed the added event
                  if (item?.type === 'function_call') {
                    const itemId = item.id || eventData.item_id;
                    let currentIndex = toolCallIds.get(itemId);
                    
                    // If we haven't seen this tool call yet, add it now (fallback)
                    if (currentIndex === undefined) {
                      hasToolCalls = true;
                      currentIndex = toolCallIndex++;
                      toolCallIds.set(itemId, currentIndex);
                      
                      const chatCallId = toChatCompletionsCallId(item.call_id || item.id) || `call_${currentIndex}`;
                      log('Tool call done (first seen):', item.name, 'index:', currentIndex, 'args:', item.arguments);
                      
                      // Send complete tool call
                      const chunk = createChunk({
                        tool_calls: [{
                          index: currentIndex,
                          id: chatCallId,
                          type: 'function',
                          function: {
                            name: item.name || '',
                            arguments: item.arguments || '{}'
                          }
                        }]
                      });
                      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                    }
                  }
                }
                
                // ===== Text content events =====
                
                // response.output_text.delta - Text content delta
                if (eventType === 'response.output_text.delta' && eventData.delta) {
                  const chunk = createChunk({ content: eventData.delta });
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                
                // ===== Function call argument events =====
                
                // response.function_call_arguments.delta - Function arguments delta
                if (eventType === 'response.function_call_arguments.delta' && eventData.delta) {
                  const itemId = eventData.item_id;
                  let currentIndex = toolCallIds.get(itemId);
                  
                  // If we haven't seen this tool call, create it
                  if (currentIndex === undefined) {
                    hasToolCalls = true;
                    currentIndex = toolCallIndex++;
                    toolCallIds.set(itemId, currentIndex);
                    toolCallData.set(itemId, {
                      name: '',
                      arguments: '',
                      call_id: `call_${currentIndex}`
                    });
                  }
                  
                  // Update stored arguments
                  const tcData = toolCallData.get(itemId);
                  if (tcData) {
                    tcData.arguments += eventData.delta;
                  }
                  
                  const chunk = createChunk({
                    tool_calls: [{
                      index: currentIndex,
                      function: {
                        arguments: eventData.delta
                      }
                    }]
                  });
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                
                // response.function_call_arguments.done - Function arguments completed
                // Send complete arguments if they weren't streamed via delta events
                if (eventType === 'response.function_call_arguments.done') {
                  const itemId = eventData.item_id;
                  let currentIndex = toolCallIds.get(itemId);
                  
                  if (currentIndex !== undefined && eventData.arguments) {
                    const tcData = toolCallData.get(itemId);
                    // Only send if we haven't already streamed the arguments
                    if (tcData && !tcData.arguments) {
                      tcData.arguments = eventData.arguments;
                      log('Function call arguments done (sending complete):', eventData.name, 'args:', eventData.arguments);
                      
                      const chunk = createChunk({
                        tool_calls: [{
                          index: currentIndex,
                          function: {
                            arguments: eventData.arguments
                          }
                        }]
                      });
                      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                    } else {
                      log('Function call arguments done (already streamed):', eventData.name);
                    }
                  } else {
                    log('Function call arguments done:', eventData.name, 'args:', eventData.arguments);
                  }
                }
                
                // ===== Refusal events =====
                
                // response.refusal.delta - Refusal text delta
                if (eventType === 'response.refusal.delta' && eventData.delta) {
                  const chunk = createChunk({ refusal: eventData.delta });
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                
                // ===== Error event =====
                if (eventType === 'error') {
                  // Log the full error data for debugging
                  const errorMessage = eventData.message || eventData.error?.message || JSON.stringify(eventData);
                  const errorCode = eventData.code || eventData.error?.code || 'unknown';
                  logError('SSE Error:', errorMessage);
                  logError('SSE Error Details:', JSON.stringify(eventData, null, 2));
                  const errorChunk = {
                    id: responseId || 'chatcmpl-error',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: requestModel,
                    choices: [{
                      index: 0,
                      delta: {},
                      finish_reason: 'error'
                    }],
                    error: {
                      code: errorCode,
                      message: errorMessage
                    }
                  };
                  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
                }
                
              } catch (parseError) {
                // Skip non-JSON data lines
                log('Skipping non-JSON SSE data:', dataStr.substring(0, 100));
              }
            }
          }
        }
      } catch (error) {
        logError('Stream transform error:', error);
        controller.error(error);
      }
    },
    cancel() {
      reader.cancel();
    }
  });
  
  return new Response(transformedStream, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive'
    }),
  });
}

/**
 * Transforms a non-streaming Responses API response to Chat Completions format
 */
async function transformNonStreamingResponse(
  response: Response,
  toChatCompletionsCallId: (id: string) => string,
  log: (...args: any[]) => void
): Promise<Response> {
  const responsesData = await response.json();
  log('Responses API response:', JSON.stringify(responsesData, null, 2));
  
  // Extract content and tool calls from Responses API format
  let textContent = '';
  let refusalContent: string | undefined;
  const toolCalls: any[] = [];
  
  if (responsesData.output && Array.isArray(responsesData.output)) {
    for (const item of responsesData.output) {
      // Handle message items
      if (item.type === 'message' && item.content && Array.isArray(item.content)) {
        for (const content of item.content) {
          if (content.type === 'output_text' && content.text) {
            textContent += content.text;
          }
          if (content.type === 'refusal' && content.refusal) {
            refusalContent = content.refusal;
          }
        }
      }
      
      // Handle function_call items (tool calls)
      if (item.type === 'function_call') {
        toolCalls.push({
          id: toChatCompletionsCallId(item.call_id || item.id),
          type: 'function',
          function: {
            name: item.name,
            arguments: item.arguments || '{}'
          }
        });
      }
    }
  }
  
  // Determine finish reason
  let finishReason = 'stop';
  if (responsesData.status === 'failed') {
    finishReason = 'error';
  } else if (responsesData.status === 'incomplete') {
    finishReason = responsesData.incomplete_details?.reason === 'max_tokens' ? 'length' : 'stop';
  } else if (toolCalls.length > 0) {
    finishReason = 'tool_calls';
  }
  
  // Build the message object
  const message: any = {
    role: 'assistant',
    content: textContent || null,
  };
  
  if (refusalContent) {
    message.refusal = refusalContent;
  }
  
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  
  // Transform to Chat Completions format
  const transformedData: any = {
    id: responsesData.id,
    object: 'chat.completion',
    created: responsesData.created_at,
    model: responsesData.model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
  };
  
  // Add usage data if available
  if (responsesData.usage) {
    transformedData.usage = {
      prompt_tokens: responsesData.usage.input_tokens,
      completion_tokens: responsesData.usage.output_tokens,
      total_tokens: responsesData.usage.total_tokens
    };
  }
  
  log('Transformed Chat Completions response:', JSON.stringify(transformedData, null, 2));
  
  return new Response(JSON.stringify(transformedData), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export default createResponsesApiAdapter;
