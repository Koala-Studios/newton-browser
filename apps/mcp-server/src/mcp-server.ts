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
import { handleEngineMcp } from "./engine-mcp.ts";
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
    handleRequest: (request, context) => handleMcpMessage(input.host, request, context),
  });
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
