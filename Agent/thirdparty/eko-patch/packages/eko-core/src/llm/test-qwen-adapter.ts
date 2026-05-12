/**
 * Quick test script for qwen-fetch-adapter parsing logic
 * Run with: npx ts-node src/llm/test-qwen-adapter.ts
 * Or: npx tsx src/llm/test-qwen-adapter.ts
 */

import { extractToolCallsFromText } from './qwen-fetch-adapter';

// Test cases from actual progress.json files
const testCases = [
  {
    name: 'Standard format',
    input: '{"name": "navigate_to", "arguments": {"url": "https://www.ebay.com"}}',
  },
  {
    name: 'With tool_call tags',
    input: '<tool_call>{"name": "input_text", "arguments": {"selector": {"index": 13}, "text": "test"}}</tool_call>',
  },
  {
    name: 'Shorthand format - click_element',
    input: '{"click_element":{"reason":"Click the search button","selector":{"index":15}}}',
  },
  {
    name: 'Shorthand format - click',
    input: '{"click":{"index":56,"coordinate_x":null,"coordinate_y":null,"force":false}}',
  },
  {
    name: 'Shorthand format - input_text',
    input: '{"input_text":{"reason":"Input search query","selector":{"index":13},"text":"4 oz Mexican vanilla","enter":false}}',
  },
  {
    name: 'Malformed with trailing garbage',
    input: '<tool_call>\n,{"click_element":{"reason":"Click","selector":{"index":15}}}}]}',
  },
  {
    name: 'Empty tool_call tags',
    input: '<tool_call>\n</tool_call>',
  },
  {
    name: 'Incomplete tool_call',
    input: '<tool_call>\n}',
  },
  {
    name: 'Multiple tool calls',
    input: `<tool_call>
{"name": "input_text", "arguments":{"selector":{"index":14},"text":"4 oz mexican vanilla"}},{"text":"4 oz mexican vanilla","enter":true}}</tool_call>`,
  },
  {
    name: 'Real example from logs',
    input: '<tool_call>\n{\"click_element\":{\"reason\":\"Click the search button to execute the search on eBay.\",\"param_sources\":null,\"selector\":{\"index\":15}}}}]}',
  },
];

console.log('=== Qwen Fetch Adapter Test ===\n');

for (const testCase of testCases) {
  console.log(`Test: ${testCase.name}`);
  console.log(`Input: ${testCase.input.substring(0, 100)}${testCase.input.length > 100 ? '...' : ''}`);
  
  try {
    const result = extractToolCallsFromText(testCase.input);
    if (result.length === 0) {
      console.log('Result: No tool calls extracted ❌');
    } else {
      console.log(`Result: ${result.length} tool call(s) extracted ✓`);
      for (const tc of result) {
        console.log(`  - ${tc.name}: ${JSON.stringify(tc.arguments)}`);
      }
    }
  } catch (e) {
    console.log(`Error: ${e}`);
  }
  console.log('');
}
