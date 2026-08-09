const ORIGIN_CAP = 32;
const ORIGIN_LENGTH_CAP = 512;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CONNECTION_TYPES = new Set(["WebSocket", "EventSource"]);

export class OriginContainmentError extends Error {
  constructor(code) {
    super("origin containment policy error");
    this.name = "OriginContainmentError";
    this.code = code;
  }
}

function fail(code) {
  throw new OriginContainmentError(code);
}

export function normalizeGrantOrigin(value) {
  if (typeof value !== "string" || !value || value.length > ORIGIN_LENGTH_CAP || /[\u0000-\u001f\u007f*]/.test(value)) {
    fail("invalid_origin_grant");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("invalid_origin_grant");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) fail("invalid_origin_grant");
  return parsed.origin;
}

export function originForUrl(value) {
  if (typeof value !== "string" || !value || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "ws:") return `http://${parsed.host}`;
    if (parsed.protocol === "wss:") return `https://${parsed.host}`;
    if (["http:", "https:", "blob:"].includes(parsed.protocol) && parsed.origin !== "null") return parsed.origin;
  } catch {
    // Invalid/relative URLs do not inherit trust.
  }
  return "";
}

export function compileOriginGrant(primaryOrigin, allowedOrigins = []) {
  if (!Array.isArray(allowedOrigins)) fail("invalid_origin_grant");
  if (allowedOrigins.length + 1 > ORIGIN_CAP) fail("origin_grant_too_large");
  const primary = normalizeGrantOrigin(primaryOrigin);
  const origins = [...new Set([primary, ...allowedOrigins.map(normalizeGrantOrigin)])];
  const allowed = new Set(origins);
  return Object.freeze({
    primaryOrigin: primary,
    origins: Object.freeze(origins),
    contains(value) {
      const candidate = originForUrl(value);
      return Boolean(candidate && allowed.has(candidate));
    },
  });
}

export function decidePausedRequest(input, grant) {
  const request = input?.request ?? {};
  const url = String(request.url ?? "");
  const method = String(request.method ?? "GET").toUpperCase();
  if (grant.contains(url)) return decision("continue", "granted_origin", true);
  if (input?.isNavigationRequest === true) return decision("fail", "ungranted_navigation", false);
  if (MUTATING_METHODS.has(method)) return decision("fail", "ungranted_mutation", false);
  if (CONNECTION_TYPES.has(String(input?.resourceType ?? ""))) return decision("fail", "ungranted_connection", false);
  if (method === "GET" || method === "HEAD") return decision("continue_without_body_access", "read_only_subresource", false);
  return decision("fail", "unsupported_ungranted_request", false);
}

export function decidePausedTarget(input, grant) {
  const url = String(input?.url ?? "");
  if (!url || url === "about:blank") {
    return input?.initiatorUrl && grant.contains(input.initiatorUrl)
      ? decision("resume", "granted_inherited_origin", true)
      : decision("hold", "target_origin_pending", false);
  }
  if (grant.contains(url)) return decision("resume", "granted_origin", true);
  return decision("block", "ungranted_target", false);
}

function decision(action, reason, granted) {
  return Object.freeze({ action, reason, granted });
}
