// Heuristic token estimation constants
const CHARS_PER_TOKEN_SCHEMA = 6; // ~6 chars/token for JSON schemas (more verbose per token)

/**
 * Cheap identity signature for a request body.
 *
 * The streaming pipeline resolves usage many times for the same request: the
 * passthrough sanitizer, the stream accounting getter and the partial-usage
 * reader all call back into the estimator, once per upstream chunk. Re-running
 * `JSON.stringify` and the token-boundary split over a multi-hundred-KB agent
 * payload costs tens of milliseconds per call and blocks the single Node event
 * loop, which stalls every concurrent request (measured on a live agent
 * workload: 85% of process CPU inside this estimator).
 *
 * The body object is stable for the life of a request, so callers cache their
 * result against it. This signature detects the mutations that actually happen
 * (a message appended, tools added, a prompt string replaced or resized) and
 * forces a recomputation instead of serving a stale number.
 */
export type BodyShape = {
  messages: number;
  tools: number;
  promptChars: number;
};

export function getBodyShape(record: Record<string, unknown>): BodyShape {
  const messages = Array.isArray(record.messages) ? record.messages.length : -1;
  const tools = Array.isArray(record.tools) ? record.tools.length : -1;
  let promptChars = 0;
  for (const key of ["input", "prompt", "system", "instructions"] as const) {
    const value = record[key];
    if (typeof value === "string") promptChars += value.length;
    else if (Array.isArray(value)) promptChars += value.length;
  }
  return { messages, tools, promptChars };
}

function sameShape(a: BodyShape, b: BodyShape): boolean {
  return a.messages === b.messages && a.tools === b.tools && a.promptChars === b.promptChars;
}

type InputEstimateCacheEntry = BodyShape & { tokens: number };
const inputEstimateCache = new WeakMap<object, InputEstimateCacheEntry>();

/**
 * Improved token estimation heuristic (no dependency).
 * Splits text on common token boundaries (whitespace, punctuation, camelCase)
 * and applies a sub-word correction factor. Better accuracy for:
 * - English text (~4 chars/token)
 * - CJK text (~1 char/token for ideographs)
 * - Code (~3.5 chars/token, more punctuation-heavy)
 *
 * @param {string} text - Text to estimate tokens for
 * @returns {number} Estimated token count
 */
function estimateTokenCount(text: unknown) {
  if (!text || typeof text !== "string") return 0;

  // Count CJK ideographs separately — each is roughly 1 token
  const cjkMatches = text.match(/[\u3000-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]/gu);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // Remove CJK chars for the remaining estimation
  const nonCJK = text.replace(/[\u3000-\u9fff\uf900-\ufaff]/g, " ");

  // Split on token boundaries: whitespace, punctuation, camelCase transitions
  const tokens = nonCJK
    .split(/(\s+|[^\w\s]|(?<=[a-z])(?=[A-Z]))/)
    .filter((t) => t && t.trim().length > 0);

  // Apply sub-word correction: BPE tokenizers often split long words
  // into sub-word pieces, so raw token count underestimates slightly
  const estimatedNonCJK = Math.ceil(tokens.length * 1.3);

  return cjkCount + estimatedNonCJK;
}

/**
 * Estimate input tokens from request body.
 * Separates tool definitions (JSON schemas) from message content
 * for more accurate estimation since JSON schemas are more verbose but
 * compress into fewer tokens than plain text.
 */
export function estimateInputTokens(body: unknown) {
  if (!body || typeof body !== "object") return 0;
  const record = body as Record<string, unknown>;
  const shape = getBodyShape(record);
  const cached = inputEstimateCache.get(body);
  if (cached && sameShape(cached, shape)) return cached.tokens;

  let tokens = 0;
  try {
    let toolTokens = 0;
    let messageTokens = 0;

    // Separate tool definitions from the rest of the body
    if (record.tools && Array.isArray(record.tools)) {
      const toolStr = JSON.stringify(record.tools);
      toolTokens = Math.ceil(toolStr.length / CHARS_PER_TOKEN_SCHEMA);
      // Estimate messages without tools
      const { tools, ...bodyWithoutTools } = record;
      messageTokens = estimateTokenCount(JSON.stringify(bodyWithoutTools));
    } else {
      messageTokens = estimateTokenCount(JSON.stringify(record));
    }

    tokens = messageTokens + toolTokens;
  } catch {
    // Fallback if stringify fails
    tokens = 0;
  }

  inputEstimateCache.set(body, { ...shape, tokens });
  return tokens;
}

/**
 * Estimate output tokens from content length.
 * Uses improved heuristic when possible, falls back to length-based estimation.
 */
export function estimateOutputTokens(contentLength: number | null | undefined) {
  if (!contentLength || contentLength <= 0) return 0;
  // When we only have a character count, use 4 chars/token with sub-word correction
  return Math.max(1, Math.ceil(contentLength / 3.5));
}
