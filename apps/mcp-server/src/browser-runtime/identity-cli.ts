import {
  createNewtonIdentity,
  importOpaqueProfile,
  inspectNewtonIdentityLease,
  listNewtonIdentities,
  prepareOpaqueProfileSource,
  recoverStaleNewtonIdentityLease,
  removeNewtonIdentity,
} from "./profile-store.ts";
import type {
  IdentityManifest,
  ProfileStore,
  SourceClosureVerifier,
} from "./profile-store.ts";

const IDENTITY_PATTERN = /^nbi_[a-f0-9]{32}$/u;
const MAX_ARGUMENTS = 8;
const MAX_ARGUMENT_LENGTH = 32_768;

type BrowserFamily = "chrome" | "edge";
type SafeIdentity = Readonly<Pick<IdentityManifest, "id" | "browserFamily" | "createdAt" | "source">>;

export type IdentityCliOutput =
  | SafeIdentity
  | readonly SafeIdentity[]
  | Readonly<{ id: string }>
  | Readonly<{ id: string; lease: "available" | "active_or_stale" }>
  | Readonly<{ id: string; recovery: "available" | "recovered" }>;

export type IdentityCliContext = Readonly<{
  store: ProfileStore;
  sourceClosureVerifier?: SourceClosureVerifier;
  leaseRecoveryVerifier?: (browserFamily: BrowserFamily) => SourceClosureVerifier;
}>;

export function dispatchIdentityCommand(
  context: IdentityCliContext,
  argv: readonly string[],
): IdentityCliOutput {
  try {
    return dispatchValidated(context, validateArgv(argv));
  } catch (error) {
    throw boundedError(error);
  }
}

function dispatchValidated(context: IdentityCliContext, argv: readonly string[]): IdentityCliOutput {
  if (!context || typeof context !== "object" || !context.store) fail("identity_cli_invalid_context");
  const [command, ...args] = argv;
  switch (command) {
    case "create": {
      const flags = exactFlags(args, ["--browser"]);
      return safeIdentity(createNewtonIdentity(context.store, {
        browserFamily: browserFamily(flags.get("--browser")),
      }));
    }
    case "list": {
      exactFlags(args, []);
      return Object.freeze(listNewtonIdentities(context.store).map(safeIdentity));
    }
    case "import": {
      const flags = exactFlags(args, ["--browser", "--profile-directory", "--user-data-root"]);
      if (typeof context.sourceClosureVerifier !== "function") fail("identity_cli_closure_verifier_required");
      const source = prepareOpaqueProfileSource({
        browserFamily: browserFamily(flags.get("--browser")),
        userDataRoot: requiredFlag(flags, "--user-data-root"),
        profileDirectory: requiredFlag(flags, "--profile-directory"),
        verifyClosed: context.sourceClosureVerifier,
      });
      return safeIdentity(importOpaqueProfile(context.store, { source }));
    }
    case "delete": {
      const flags = exactFlags(args, ["--id"]);
      const id = identityId(flags.get("--id"));
      if (inspectNewtonIdentityLease(context.store, id) === "active_or_stale") {
        fail("identity_delete_lease_active_or_stale");
      }
      removeNewtonIdentity(context.store, id);
      return Object.freeze({ id });
    }
    case "lease-inspect": {
      const flags = exactFlags(args, ["--id"]);
      const id = identityId(flags.get("--id"));
      return Object.freeze({ id, lease: inspectNewtonIdentityLease(context.store, id) });
    }
    case "lease-recover": {
      const flags = exactFlags(args, ["--id"]);
      const id = identityId(flags.get("--id"));
      const identity = listNewtonIdentities(context.store).find((candidate) => candidate.id === id);
      if (!identity) fail("profile_identity_missing");
      if (typeof context.leaseRecoveryVerifier !== "function") fail("identity_cli_closure_verifier_required");
      const verifier = context.leaseRecoveryVerifier(identity.browserFamily);
      return Object.freeze({ id, recovery: recoverStaleNewtonIdentityLease(context.store, id, verifier) });
    }
    default:
      fail("identity_cli_unknown_command");
  }
}

function validateArgv(argv: readonly string[]): readonly string[] {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > MAX_ARGUMENTS) fail("identity_cli_invalid_arguments");
  for (const value of argv) {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_ARGUMENT_LENGTH || value.includes("\0")) {
      fail("identity_cli_invalid_arguments");
    }
  }
  return argv;
}

function exactFlags(args: readonly string[], expected: readonly string[]): ReadonlyMap<string, string> {
  if (args.length !== expected.length * 2) fail("identity_cli_invalid_arguments");
  const allowed = new Set(expected);
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !allowed.has(flag) || flags.has(flag)) {
      fail("identity_cli_invalid_arguments");
    }
    flags.set(flag, value);
  }
  if (flags.size !== expected.length) fail("identity_cli_invalid_arguments");
  return flags;
}

function requiredFlag(flags: ReadonlyMap<string, string>, flag: string): string {
  const value = flags.get(flag);
  if (value === undefined || value.length === 0) fail("identity_cli_invalid_arguments");
  return value;
}

function browserFamily(value: string | undefined): BrowserFamily {
  if (value !== "chrome" && value !== "edge") fail("identity_cli_invalid_arguments");
  return value;
}

function identityId(value: string | undefined): string {
  if (value === undefined || !IDENTITY_PATTERN.test(value)) fail("identity_cli_invalid_arguments");
  return value;
}

function safeIdentity(identity: IdentityManifest): SafeIdentity {
  if (!IDENTITY_PATTERN.test(identity.id)
    || (identity.browserFamily !== "chrome" && identity.browserFamily !== "edge")
    || identity.createdAt.length > 32
    || !Number.isFinite(Date.parse(identity.createdAt))
    || (identity.source !== "new" && identity.source !== "opaque_import")) {
    fail("identity_cli_invalid_receipt");
  }
  return Object.freeze({
    id: identity.id,
    browserFamily: identity.browserFamily,
    createdAt: identity.createdAt,
    source: identity.source,
  });
}

function boundedError(error: unknown): Error & { code: string } {
  const candidate = error instanceof Error && /^[a-z][a-z0-9_]{0,79}$/u.test(error.message)
    ? error.message
    : "identity_cli_command_failed";
  return Object.assign(new Error(candidate), { code: candidate });
}

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
