const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE|CREDENTIAL)[A-Z0-9_]*)\s*=\s*([^\s"']+|"[^"]+"|'[^']+')/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const PLATFORM_TOKEN_PATTERN = /\bshp[a-z0-9]*_[A-Za-z0-9_]{12,}/gi;
const PRIVATE_API_KEY_PATTERN = /\bpk_[A-Za-z0-9]{20,}/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const DATABASE_URL_PATTERN = /\b(postgres(?:ql)?:\/\/)[^:\s/]+:[^@\s/]+@/gi;

export type RedactionOptions = {
  redactEmails?: boolean;
};

export function redactText(input: string, options: RedactionOptions = {}): string {
  const redactEmails = options.redactEmails ?? true;
  const redacted = input
    .replace(DATABASE_URL_PATTERN, "$1[REDACTED]@")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1=[REDACTED]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(PLATFORM_TOKEN_PATTERN, "[REDACTED_PLATFORM_TOKEN]")
    .replace(PRIVATE_API_KEY_PATTERN, "[REDACTED_PRIVATE_API_KEY]");
  return redactEmails ? redacted.replace(EMAIL_PATTERN, "[REDACTED_EMAIL]") : redacted;
}

export function redactJson(value: unknown, options: RedactionOptions = {}): unknown {
  if (typeof value === "string") return redactText(value, options);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, options));
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      output[key] = typeof item === "boolean" || typeof item === "number" || item === null
        ? item
        : "[REDACTED]";
      continue;
    }
    output[key] = redactJson(item, options);
  }
  return output;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  return (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("private") ||
    normalized.includes("credential") ||
    compact === "apikey" ||
    compact.endsWith("apikey") ||
    normalized === "api_key" ||
    normalized.endsWith("_api_key") ||
    normalized === "access_key" ||
    normalized.endsWith("_access_key")
  );
}
