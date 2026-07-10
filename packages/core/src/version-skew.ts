export type VersionSkew = "none" | "patch" | "incompatible" | "unknown";

export function classifyVersionSkew(hostVersion: string, extensionVersion?: string | null): VersionSkew {
  const host = parse(hostVersion);
  const extension = parse(extensionVersion);
  if (!host || !extension) return "unknown";
  if (host.major !== extension.major || host.minor !== extension.minor) return "incompatible";
  return host.patch === extension.patch ? "none" : "patch";
}

function parse(version?: string | null) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version ?? "");
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}
