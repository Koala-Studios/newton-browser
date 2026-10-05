import type { Readable, Writable } from "node:stream";

import {
  MODERN_MCP_PROTOCOL_VERSION,
  serveModernMcpStdio,
  type JsonRpcId,
  type ModernMcpRequest,
  type ModernMcpRequestContext,
  type ModernMcpResponse,
} from "./modern-mcp-stdio.ts";
import type { EngineHost } from "./browser-runtime/engine-host.ts";
import { ENGINE_INSTRUCTIONS, handleEngineMcp } from "./engine-mcp.ts";
import { NEWTON_BROWSER_VERSION } from "./package-metadata.ts";
import { createDefaultEngineHost } from "./browser-runtime/default-engine-host.ts";

export async function startNewtonBrowserMcpServer(input: { host?: EngineHost } = {}): Promise<void> {
  const host = input.host ?? createDefaultEngineHost();
  try {
    await serveNewtonBrowserMcpConnection({ host, readable: process.stdin, writable: process.stdout });
  } finally {
    try { await host.stopAll(); } catch { /* close is the authoritative retry/terminal cleanup path */ }
    await host.close();
  }
}

async function serveNewtonBrowserMcpConnection(input: { host: EngineHost; readable: Readable; writable: Writable }): Promise<void> {
  await serveModernMcpStdio({
    readable: input.readable,
    writable: input.writable,
    handleRequest: createMcpConnectionHandler(input.host),
  });
}

/** Classic MCP protocol versions answered after an `initialize` handshake, newest first. */
export const CLASSIC_MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/**
 * One connection's request handler. A client that opens with the classic `initialize` handshake
 * (Claude Code does, depending on its release and settings) gets the same tools as a 2026-07-28
 * client, without the per-request protocol metadata; the tool calls themselves are identical.
 */
export function createMcpConnectionHandler(host: EngineHost) {
  let classic = false;
  return async (request: ModernMcpRequest, context: ModernMcpRequestContext): Promise<ModernMcpResponse | null> => {
    if (request.method === "initialize" && !classic) {
      const requested = isObject(request.params) ? request.params.protocolVersion : undefined;
      const protocolVersion = CLASSIC_MCP_PROTOCOL_VERSIONS.find(version => version === requested) ?? CLASSIC_MCP_PROTOCOL_VERSIONS[0];
      classic = true;
      return { jsonrpc: "2.0", id: request.id, result: { protocolVersion, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "newton-browser", version: NEWTON_BROWSER_VERSION }, instructions: ENGINE_INSTRUCTIONS } };
    }
    if (!classic) return handleMcpMessage(host, request, context);
    if (request.method === "ping") return { jsonrpc: "2.0", id: request.id, result: {} };
    if (request.method !== "tools/list" && request.method !== "tools/call") return errorResponse(request.id, -32601, "Unsupported MCP method.");
    // The classic list may carry a pagination cursor; the catalog is one page.
    const { cursor: _cursor, _meta: _classicMeta, ...params } = isObject(request.params) ? request.params : {};
    return handleEngineMcp(host, { ...request, params: { _meta: {}, ...params } }, context);
  };
}

export async function handleMcpMessage(
  host: EngineHost,
  message: ModernMcpRequest,
  context: ModernMcpRequestContext = { signal: new AbortController().signal },
): Promise<ModernMcpResponse | null> {
  const metadataError = validateRequestMetadata(message.params);
  if (metadataError) return errorResponse(message.id, metadataError.code, metadataError.message, metadataError.data);
  return handleEngineMcp(host, message, context);
}

function validateRequestMetadata(params: Record<string, unknown> | undefined):
  | { code: number; message: string; data: Record<string, unknown> }
  | null {
  const metadata = isObject(params?._meta) ? params._meta : {};
  const requested = metadata["io.modelcontextprotocol/protocolVersion"];
  if (typeof requested !== "string" || requested.length === 0 || requested.length > 80) {
    return {
      code: -32602,
      message: "Missing MCP protocol version metadata.",
      data: { errorCode: "protocol_version_required" },
    };
  }
  if (requested !== MODERN_MCP_PROTOCOL_VERSION) {
    return {
      code: -32022,
      message: "Unsupported MCP protocol version.",
      data: {
        supported: [MODERN_MCP_PROTOCOL_VERSION],
        requested,
      },
    };
  }
  if (!isObject(metadata["io.modelcontextprotocol/clientCapabilities"])) {
    return {
      code: -32602,
      message: "Missing MCP client capabilities metadata.",
      data: { errorCode: "client_capabilities_required" },
    };
  }
  const clientInfo = metadata["io.modelcontextprotocol/clientInfo"];
  if (clientInfo !== undefined && (!isObject(clientInfo)
    || typeof clientInfo.name !== "string" || clientInfo.name.length === 0 || clientInfo.name.length > 240
    || typeof clientInfo.version !== "string" || clientInfo.version.length === 0 || clientInfo.version.length > 120)) {
    return {
      code: -32602,
      message: "Invalid MCP client info metadata.",
      data: { errorCode: "invalid_client_info" },
    };
  }
  return null;
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): ModernMcpResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
