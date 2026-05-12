/**
 * Website Instruction Loader (Standalone - No Server Required)
 *
 * Loads website-specific navigation instructions to help the AI agent
 * understand and navigate different websites more effectively.
 *
 * Instructions are bundled with the extension in public/instructions/domains/
 * No server connection is required.
 */

import { logger } from './logger';

/**
 * Instruction metadata returned when loading instructions
 */
export interface InstructionInfo {
  /** Whether instructions were found for this URL */
  found: boolean;
  /** The domain/hostname that was matched */
  matchedDomain: string | null;
  /** The instruction content (if found) */
  content: string | null;
  /** A short display name for logging */
  displayName: string | null;
  /** The instruction version (folder name) used */
  version: string | null;
  /** Error message if loading failed */
  error?: string;
}

/**
 * URL to alias mapping for sites with IP addresses or non-standard domains.
 * Maps URL patterns (host:port) to friendly instruction file names.
 * 
 * This is useful for WebArena and other test environments that use IP addresses.
 */
const URL_ALIAS_MAP: Record<string, string> = {
  // WebArena sites - localhost (for local deployment)
  'localhost:8023': 'webarena-gitlab',
  'localhost:9999': 'webarena-reddit',
  'localhost:7770': 'webarena-shopping',
  'localhost:7780': 'webarena-shopping-admin',
  // WebArena sites - 127.0.0.1 (alternative localhost)
  '127.0.0.1:8023': 'webarena-gitlab',
  '127.0.0.1:9999': 'webarena-reddit',
  '127.0.0.1:7770': 'webarena-shopping',
  '127.0.0.1:7780': 'webarena-shopping-admin',
  // WorkArena sites - localhost
  'localhost:3100': 'workarena-scrumboard',
  'localhost:3101': 'workarena-outlook',
  'localhost:3102': 'workarena-teams',
  // WorkArena sites - 127.0.0.1
  '127.0.0.1:3100': 'workarena-scrumboard',
  '127.0.0.1:3101': 'workarena-outlook',
  '127.0.0.1:3102': 'workarena-teams',
  // Add more aliases as needed
};

/**
 * Reverse mapping from alias to host:port patterns
 * This helps when we have an IP address without port and need to find potential aliases
 */
const IP_TO_ALIASES: Record<string, string[]> = {};
for (const [hostPort, alias] of Object.entries(URL_ALIAS_MAP)) {
  const ip = hostPort.split(':')[0];
  if (!IP_TO_ALIASES[ip]) {
    IP_TO_ALIASES[ip] = [];
  }
  IP_TO_ALIASES[ip].push(alias);
}

/**
 * Extract IP:port patterns from text (e.g., from user queries)
 * Returns the first match like "128.24.92.146:8023"
 */
function extractIPPortFromText(text: string): string | null {
  const all = extractAllIPPortsFromText(text);
  return all.length > 0 ? all[0] : null;
}

/**
 * Extract ALL IP:port patterns from text.
 * Returns unique matches like ["127.0.0.1:9999", "127.0.0.1:8023", ...]
 */
function extractAllIPPortsFromText(text: string): string[] {
  const results = new Set<string>();
  
  // Match IP:port patterns in URLs
  const urlPattern = /https?:\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)/gi;
  let match;
  while ((match = urlPattern.exec(text)) !== null) {
    results.add(`${match[1]}:${match[2]}`);
  }
  
  // Match standalone IP:port
  const standalonePattern = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)/g;
  while ((match = standalonePattern.exec(text)) !== null) {
    results.add(`${match[1]}:${match[2]}`);
  }
  
  return [...results];
}

/**
 * Check if a hostname is an IP address
 */
function isIPAddress(hostname: string): boolean {
  // IPv4 pattern
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  // IPv6 pattern (simplified)
  const ipv6Pattern = /^[\da-f:]+$/i;
  return ipv4Pattern.test(hostname) || ipv6Pattern.test(hostname);
}

/**
 * Extract the matchable domains from a URL.
 * Returns an array of domains to try, from most specific to least specific.
 * 
 * Examples:
 * - "https://www.ebay.com/..." → ["ebay.com"]
 * - "https://mail.google.com/..." → ["mail.google.com", "google.com"]
 * - "https://www.google.com/maps/" → ["google.com-maps", "google.com"]
 * - "https://www.google.com/travel/flights/" → ["google.com-travel-flights", "google.com-travel", "google.com"]
 * - "https://outlook.live.com/..." → ["outlook.live.com", "live.com"]
 * - "http://128.24.92.146:8023/..." → ["webarena-gitlab", "128.24.92.146_8023", "128.24.92.146"]
 */
export function extractDomainsFromUrl(url: string): string[] {
  try {
    const urlObj = new URL(url);
    let hostname = urlObj.hostname.toLowerCase();
    const port = urlObj.port;
    
    const domains: string[] = [];
    
    // Check for URL alias first (for IP-based URLs like WebArena)
    const hostWithPort = port ? `${hostname}:${port}` : hostname;
    if (URL_ALIAS_MAP[hostWithPort]) {
      domains.push(URL_ALIAS_MAP[hostWithPort]);
    }
    
    // For IP addresses, include host:port as a possible match
    if (isIPAddress(hostname)) {
      if (port) {
        // e.g., "128.24.92.146_8023" (using underscore since colon isn't valid in filenames)
        domains.push(`${hostname}_${port}`);
      }
      domains.push(hostname);
      return domains;
    }
    
    // Remove www. prefix for domain names
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }
    
    // Extract path segments for path-based matching
    // e.g., /maps/ → ["maps"], /travel/flights/ → ["travel", "flights"]
    const pathSegments = urlObj.pathname.split('/').filter(seg => seg.length > 0);
    
    // Add domain-path candidates (most specific first)
    // e.g., google.com/travel/flights → "google.com-travel-flights", "google.com-travel"
    if (pathSegments.length > 0) {
      for (let i = pathSegments.length; i >= 1; i--) {
        domains.push(`${hostname}-${pathSegments.slice(0, i).join('-')}`);
      }
    }
    
    domains.push(hostname);
    
    // For subdomains, also try the parent domain
    const parts = hostname.split('.');
    if (parts.length > 2) {
      // e.g., mail.google.com → google.com
      const parentDomain = parts.slice(-2).join('.');
      domains.push(parentDomain);
    }
    
    return domains;
  } catch (error) {
    logger.warning("INSTRUCTION_LOADER", `Failed to parse URL: ${url}`, { error: String(error) });
    return [];
  }
}

/**
 * Load instructions for a domain from bundled local files.
 * Standalone version (no server dependency) - Outlook focused example.
 *
 * @param domain - The domain to load instructions for (e.g., "workarena-outlook")
 * @param version - Optional version (ignored, always uses bundled outlook folder)
 * @returns InstructionInfo with the loaded instructions or empty result
 */
async function loadInstructionsFromBundle(
  domain: string,
  version?: string
): Promise<InstructionInfo> {
  // Map domain to filename for Outlook instruction set
  const domainToFile: Record<string, string> = {
    'workarena-outlook': 'workarena-outlook.md',
    'workarena-scrumboard': 'workarena-scrumboard.md',
    'workarena-teams': 'workarena-teams.md',
  };

  const fileName = domainToFile[domain];
  if (!fileName) {
    return {
      found: false,
      matchedDomain: domain,
      content: null,
      displayName: null,
      version: 'outlook',
      error: `No bundled instructions for domain: ${domain}. Available: outlook tasks only`,
    };
  }

  try {
    // Load markdown file from bundled outlook folder
    const url = chrome.runtime.getURL(`instructions/domains/outlook/${fileName}`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }
    const content = await response.text();

    // Generate a display name from the content or domain
    let displayName = domain;
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      displayName = titleMatch[1].replace(/Quick Reference|Navigation Guide|for AI Agent/gi, '').trim();
      if (!displayName) displayName = domain;
    }

    logger.info("INSTRUCTION_LOADER", `Loaded bundled Outlook instructions for ${domain}`, {
      domain,
      displayName,
      contentLength: content.length,
      version: 'outlook',
    });

    return {
      found: true,
      matchedDomain: domain,
      content,
      displayName,
      version: 'outlook',
    };
  } catch (error) {
    logger.warning("INSTRUCTION_LOADER", `Failed to load bundled Outlook instructions for ${domain}`, {
      error: String(error),
      domain,
      version: 'outlook',
    });

    return {
      found: false,
      matchedDomain: domain,
      content: null,
      displayName: null,
      version: 'outlook',
      error: `Could not load bundled file for ${domain}`,
    };
  }
}

/**
 * Load instructions for a given URL from bundled files (standalone, no server).
 *
 * @param url - The current page URL
 * @param version - Optional version (for compatibility, not used in standalone)
 * @returns InstructionInfo with the loaded instructions or error info
 */
export async function loadInstructionsForUrl(
  url: string,
  version?: string
): Promise<InstructionInfo> {
  const domains = extractDomainsFromUrl(url);

  if (domains.length === 0) {
    return {
      found: false,
      matchedDomain: null,
      content: null,
      displayName: null,
      version: version || 'bundled',
      error: 'Could not extract domain from URL',
    };
  }

  // Try each domain in order (most specific first)
  for (const domain of domains) {
    const result = await loadInstructionsFromBundle(domain, version);
    if (result.found && result.content) {
      return result;
    }
  }

  // No instructions found for any domain
  logger.info("INSTRUCTION_LOADER", `No bundled instructions found for URL: ${url}`, {
    triedDomains: domains,
  });

  return {
    found: false,
    matchedDomain: null,
    content: null,
    displayName: null,
    version: version || 'bundled',
    error: `No instructions available for: ${domains.join(', ')}`,
  };
}

/**
 * Format the instruction content for prepending to the user's prompt.
 * This creates a clear context block that the LLM can use.
 * 
 * @param info - The instruction info from loadInstructionsForUrl
 * @returns Formatted instruction block or empty string if no instructions
 */
export function formatInstructionsForPrompt(info: InstructionInfo): string {
  if (!info.found || !info.content) {
    return '';
  }
  
  return `
<website_navigation_guide>
The following is a pre-loaded navigation guide for ${info.matchedDomain}.
Use this information to help locate and interact with elements on the page.

${info.content}
</website_navigation_guide>

`;
}

/**
 * Get current page URL from the active content tab.
 * This filters out extension/browser pages (chrome://, edge://, about:, etc.)
 * and finds the actual website the user is browsing.
 */
export async function getCurrentTabUrl(): Promise<string | null> {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs) {
      return null;
    }
    
    // First try: get the active tab in the current window
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // Check if this is a content page (not an extension/browser page)
    if (activeTab?.url && isContentUrl(activeTab.url)) {
      logger.info("INSTRUCTION_LOADER", "Found content URL from active tab", { url: activeTab.url });
      return activeTab.url;
    }
    
    // If active tab is an extension page, try to find the last active content tab
    logger.info("INSTRUCTION_LOADER", "Active tab is not a content page, searching for content tabs", {
      activeTabUrl: activeTab?.url,
    });
    
    // Get all tabs in the current window and find content tabs
    const allTabs = await chrome.tabs.query({ currentWindow: true });
    
    // Sort by index (prefer tabs closer to active tab, or higher index as fallback)
    // Note: lastAccessed is not available in all Chrome versions
    const contentTabs = allTabs
      .filter(tab => tab.url && isContentUrl(tab.url))
      .sort((a, b) => {
        // Prefer higher index (more recently opened tabs tend to have higher index)
        return (b.index || 0) - (a.index || 0);
      });
    
    if (contentTabs.length > 0) {
      const bestTab = contentTabs[0];
      logger.info("INSTRUCTION_LOADER", "Found content URL from recent content tab", { 
        url: bestTab.url,
        tabId: bestTab.id,
        tabIndex: bestTab.index,
      });
      return bestTab.url || null;
    }
    
    // No content tabs found
    logger.info("INSTRUCTION_LOADER", "No content tabs found in current window", {
      totalTabs: allTabs.length,
    });
    return null;
  } catch (error) {
    logger.warning("INSTRUCTION_LOADER", "Failed to get current tab URL", {
      error: String(error),
    });
    return null;
  }
}

/**
 * Check if a URL is a content page (not a browser/extension page)
 */
function isContentUrl(url: string): boolean {
  // Filter out browser and extension URLs
  const nonContentPrefixes = [
    'chrome://',
    'chrome-extension://',
    'edge://',
    'extension://',
    'about:',
    'moz-extension://',
    'brave://',
    'opera://',
    'vivaldi://',
    'file://',  // Local files might not have instructions
  ];
  
  const lowerUrl = url.toLowerCase();
  return !nonContentPrefixes.some(prefix => lowerUrl.startsWith(prefix));
}

// Default model for SDF endpoint calls
const DEFAULT_LLM_MODEL = 'dev-anthropic-claude-sonnet-4-5';

/**
 * Result from analyzing query for website
 */
export interface QueryAnalysisResult {
  /** The detected domain, if any */
  domain: string | null;
  /** Whether the analysis succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Error type for UI display */
  errorType?: 'sdf_unavailable' | 'llm_error' | 'no_website_detected' | 'unknown';
}

/**
 * LLM configuration for SDF endpoint calls
 */
export interface SDFLLMConfig {
  /** Pre-built auth headers from getAuthHeaders() */
  authHeaders?: Record<string, string>;
  baseURL?: string;
  model?: string;
}

/**
 * Use LLM to analyze the user's query and determine the target website URL.
 * This is called before planning to identify which website the user wants to interact with.
 * Uses the same LLM endpoint as the SDF proxy for topology mapping.
 * 
 * IMPORTANT: For IP-based URLs (like WebArena), we first check for IP:port patterns
 * in the query and map them to aliases before falling back to LLM analysis.
 * 
 * @param query - The user's query/prompt
 * @param llmConfig - Optional LLM config with API key and base URL
 * @returns QueryAnalysisResult with domain or error details
 */
export async function analyzeQueryForWebsite(
  query: string,
  llmConfig?: SDFLLMConfig
): Promise<QueryAnalysisResult> {
  if (!query) {
    return { domain: null, success: true };
  }
  
  // Fast path: If exactly ONE IP:port in the query, use alias map directly
  // When multiple IP:port patterns exist (e.g., WebArena task listings), fall through to LLM
  const allIpPorts = extractAllIPPortsFromText(query);
  console.log("[INSTRUCTION_LOADER DEBUG] extractAllIPPortsFromText result:", allIpPorts);
  console.log("[INSTRUCTION_LOADER DEBUG] URL_ALIAS_MAP keys:", Object.keys(URL_ALIAS_MAP));
  
  if (allIpPorts.length === 1 && URL_ALIAS_MAP[allIpPorts[0]]) {
    const alias = URL_ALIAS_MAP[allIpPorts[0]];
    console.log("[INSTRUCTION_LOADER DEBUG] Single IP:port alias found:", alias);
    logger.info("INSTRUCTION_LOADER", "Found single IP:port alias in query", {
      ipPort: allIpPorts[0],
      alias,
      queryPreview: query.substring(0, 100),
    });
    return {
      domain: alias,
      success: true,
    };
  }
  
  if (allIpPorts.length > 1) {
    console.log("[INSTRUCTION_LOADER DEBUG] Multiple IP:port patterns found, using LLM to determine target");
  }
  
  console.log("[INSTRUCTION_LOADER DEBUG] Using LLM to determine target website");
  const systemPrompt = `You are a URL extraction assistant. Analyze the user's query and determine which PRIMARY website they want to interact with.

Rules:
1. If the query says "Start from current page <URL>", that URL is the target website
2. Ignore lists of available/local sites (e.g., "IMPORTANT: Use these local sites...") — those are reference info, not the target
3. If the query mentions a specific website (by name or URL), extract it
4. If the query implies a well-known website (e.g., "search for products" might imply a shopping site, but only if context is clear), identify it
5. Return ONLY the domain name (e.g., "ebay.com", "openstreetmap.org", "mail.google.com")
6. If no specific website can be determined, return "NONE"
7. Do not guess - if the website is ambiguous, return "NONE"

Examples:
- "Start from current page https://www.openstreetmap.org to complete this task: ..." → openstreetmap.org
- "Start from current page http://127.0.0.1:7770 to complete this task: ... IMPORTANT: Use these local sites: Reddit: http://127.0.0.1:9999 ..." → 127.0.0.1:7770 (the starting page, NOT reddit)
- "Go to eBay and search for laptop" → ebay.com
- "On OpenStreetMap, click the Share button" → openstreetmap.org
- "Check my Gmail inbox" → mail.google.com
- "Search for restaurants nearby" → NONE (ambiguous - could be Google, Yelp, etc.)
- "Book a flight to Paris" → NONE (could be multiple travel sites)`;

  const userMessage = `Query: "${query}"

What is the target website domain? Reply with ONLY the domain (e.g., "ebay.com") or "NONE".`;

  try {
    // baseURL is required - fail if not provided
    if (!llmConfig?.baseURL) {
      logger.warning("INSTRUCTION_LOADER", "No LLM baseURL provided for query analysis");
      return {
        domain: null,
        success: false,
        error: "LLM baseURL not configured",
        errorType: 'sdf_unavailable',
      };
    }
    
    const sdfEndpoint = llmConfig.baseURL;
    const sdfModel = llmConfig?.model || DEFAULT_LLM_MODEL;
    
    logger.info("INSTRUCTION_LOADER", "Analyzing query for target website using LLM", {
      queryPreview: query.substring(0, 100),
      endpoint: sdfEndpoint,
      model: sdfModel,
    });

    const requestBody = {
      model: sdfModel,
      max_tokens: 50,
      messages: [
        { role: 'user', content: `${systemPrompt}\n\n${userMessage}` }
      ],
    };

    // Build headers from pre-built authHeaders
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(llmConfig?.authHeaders || {}),
    };

    const response = await fetch(sdfEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.warning("INSTRUCTION_LOADER", "LLM request failed", {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      });
      return {
        domain: null,
        success: false,
        error: `LLM request failed: ${response.status} ${response.statusText}`,
        errorType: 'llm_error',
      };
    }

    const data = await response.json();
    
    // Handle Anthropic-style response
    let resultText = '';
    if (data.content && Array.isArray(data.content)) {
      const textContent = data.content.find((c: any) => c.type === 'text');
      if (textContent) {
        resultText = textContent.text;
      }
    }
    // Handle OpenAI-style response
    else if (data.choices && data.choices[0]?.message?.content) {
      resultText = data.choices[0].message.content;
    }
    
    resultText = resultText.trim().toLowerCase();
    
    logger.info("INSTRUCTION_LOADER", "LLM URL extraction result", {
      result: resultText,
    });
    
    // Check if valid domain or NONE
    if (resultText === 'none' || !resultText || resultText.length > 100) {
      return {
        domain: null,
        success: true,
        errorType: 'no_website_detected',
      };
    }
    
    // Clean up the result - remove quotes, extra text
    resultText = resultText.replace(/['"]/g, '').split(/\s/)[0];
    
    // Validate it looks like a domain
    if (resultText.includes('.') && !resultText.includes(' ')) {
      return {
        domain: resultText,
        success: true,
      };
    }
    
    return {
      domain: null,
      success: true,
      errorType: 'no_website_detected',
    };
  } catch (error) {
    const errorMessage = String(error);
    logger.warning("INSTRUCTION_LOADER", "Error analyzing query with LLM", {
      error: errorMessage,
    });
    
    // Check if it's a connection error (SDF proxy not running)
    if (errorMessage.includes('fetch') || errorMessage.includes('ECONNREFUSED') || errorMessage.includes('Failed to fetch') || errorMessage.includes('NetworkError')) {
      return {
        domain: null,
        success: false,
        error: `Cannot connect to SDF proxy at ${llmConfig?.baseURL ?? 'unknown'}. Is the server running?`,
        errorType: 'sdf_unavailable',
      };
    }
    
    return {
      domain: null,
      success: false,
      error: `Error analyzing query: ${errorMessage}`,
      errorType: 'unknown',
    };
  }
}

/**
 * Load instructions for a domain directly (without needing a full URL).
 * 
 * For IP addresses, this function checks the URL_ALIAS_MAP to find matching
 * instruction files (e.g., "128.24.92.146" might match "webarena-gitlab").
 *
 * @param domain - The domain to load instructions for (e.g., "ebay.com" or "128.24.92.146")
 * @param serverUrl - The server URL (e.g., "http://localhost:8202" or "https://server.com")
 * @param version - Optional instruction set version (e.g., "v1_2026_2_28")
 * @returns InstructionInfo with the loaded instructions
 */
/**
 * Standalone stub: Load instructions for a domain from bundled files only.
 * Ignores serverUrl parameter - this is for backward compatibility with caller signatures.
 *
 * @param domain - The domain to load instructions for
 * @param serverUrl - Ignored (kept for signature compatibility)
 * @param version - Optional version string
 * @returns InstructionInfo from bundled files or error info
 */
export async function loadInstructionsForDomain(
  domain: string,
  serverUrl: string,
  version?: string
): Promise<InstructionInfo> {
  // Standalone: Always load from bundled files, ignore serverUrl
  return await loadInstructionsFromBundle(domain, version);
}
