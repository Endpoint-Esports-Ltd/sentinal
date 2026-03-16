/**
 * Content Sanitization
 *
 * Strips secrets, credentials, and sensitive data from observation
 * content before persisting to the memory database.
 *
 * Applied automatically by MemoryService.addObservation().
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface SanitizeResult {
  text: string;
  redactedCount: number;
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

/**
 * Each pattern has a regex and a replacement label.
 * Order matters: more specific patterns first to avoid double-redaction.
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // AWS keys
  {
    pattern: /(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}/g,
    label: "[REDACTED:AWS_KEY]",
  },
  {
    pattern: /(?:aws[_-]?secret[_-]?access[_-]?key\s*[=:]\s*)[^\s"']+/gi,
    label: "aws_secret_access_key=[REDACTED]",
  },

  // Generic API keys / tokens (key=value or key: value patterns)
  {
    pattern:
      /(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|bearer|secret[_-]?key|private[_-]?key|client[_-]?secret)\s*[=:]\s*["']?[A-Za-z0-9_\-./+=]{8,}["']?/gi,
    label: "[REDACTED:CREDENTIAL]",
  },

  // Bearer tokens in headers
  { pattern: /Bearer\s+[A-Za-z0-9_\-./+=]{20,}/g, label: "Bearer [REDACTED]" },

  // JWT tokens (three base64 segments separated by dots)
  {
    pattern:
      /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-+=]{10,}/g,
    label: "[REDACTED:JWT]",
  },

  // Private keys (PEM format)
  {
    pattern:
      /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
    label: "[REDACTED:PRIVATE_KEY]",
  },

  // Connection strings with credentials
  {
    pattern:
      /(?:mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^:]+:[^@\s]+@[^\s"']+/gi,
    label: "[REDACTED:CONNECTION_STRING]",
  },

  // Generic password patterns
  {
    pattern: /(?:password|passwd|pwd)\s*[=:]\s*["']?[^\s"']{4,}["']?/gi,
    label: "password=[REDACTED]",
  },

  // Hex tokens (32+ chars, often secrets/hashes)
  {
    pattern: /(?:token|secret|key)\s*[=:]\s*["']?[0-9a-f]{32,}["']?/gi,
    label: "[REDACTED:TOKEN]",
  },

  // GitHub tokens
  { pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g, label: "[REDACTED:GITHUB_TOKEN]" },

  // Slack tokens
  {
    pattern: /xox[bpoas]-[A-Za-z0-9\-]{10,}/g,
    label: "[REDACTED:SLACK_TOKEN]",
  },

  // npm tokens
  { pattern: /npm_[A-Za-z0-9]{36,}/g, label: "[REDACTED:NPM_TOKEN]" },
];

// ─── Sanitize ─────────────────────────────────────────────────────────────────

/**
 * Sanitize text by redacting detected secrets and credentials.
 * Returns the cleaned text and a count of redactions made.
 */
export function sanitize(text: string): SanitizeResult {
  let result = text;
  let redactedCount = 0;

  for (const { pattern, label } of SECRET_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;
    const matches = result.match(pattern);
    if (matches) {
      redactedCount += matches.length;
      result = result.replace(pattern, label);
    }
  }

  return { text: result, redactedCount };
}

/**
 * Sanitize all text fields in a record (title, content).
 * Returns the sanitized record and total redaction count.
 */
export function sanitizeObservationFields(fields: {
  title: string;
  content: string;
}): { title: string; content: string; redactedCount: number } {
  const titleResult = sanitize(fields.title);
  const contentResult = sanitize(fields.content);

  return {
    title: titleResult.text,
    content: contentResult.text,
    redactedCount: titleResult.redactedCount + contentResult.redactedCount,
  };
}
