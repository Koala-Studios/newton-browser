# Discovery Submission Plan

Newton Browser 0.4.0 is public on npm and GitHub. This plan covers discovery listings
without changing the product's local-only architecture. Submission work uses the
standalone Newton Browser `browser.*` tools for signed-in web dashboards and public
verification. The official MCP Registry remains a CLI publish flow; Newton Browser is
used for its GitHub authentication handoff and for browser verification.

## Outcomes

- Establish `io.github.koala-studios/newton-browser` in the official MCP Registry as
  the canonical machine-readable record.
- Obtain accurate directory listings without creating a hosted relay, managed proxy,
  analytics tunnel, or remote Newton Browser service.
- Publish one consistent install path: `npx -y newton-browser@0.4.0`.
- Record every listing URL, submission receipt, owner handoff, and verification result.

## Locked metadata

| Field | Value |
| --- | --- |
| Name | Newton Browser |
| Registry name | `io.github.koala-studios/newton-browser` |
| Version | `0.4.0` |
| Package | `newton-browser@0.4.0` |
| Command | `npx -y newton-browser@0.4.0` |
| Repository | `https://github.com/Koala-Studios/newton-browser` |
| Homepage | `https://koala-studios.github.io/newton-browser/` |
| Privacy | `https://github.com/Koala-Studios/newton-browser/blob/main/docs/PRIVACY.md` |
| License | MIT |
| Categories | Browser Automation; Developer Tools; Local Tools |
| Architecture | Local stdio MCP host plus local MV3 extension; no remote endpoint |

Use the repository README for long-form copy. Do not claim that Newton Browser is a
hosted or Streamable HTTP server, and do not opt into third-party hosting merely to make
a directory accept the package.

## Submission order

### Wave 0 — Preflight

1. Confirm npm `newton-browser@0.4.0`, GitHub release `v0.4.0`, the landing page, privacy
   policy, and repository are publicly readable.
2. Run `pnpm lint`, validate `server.json` with the current `mcp-publisher`, and inspect
   the generated install command.
3. Call `browser.status`; continue only with host/extension 0.4.0, `ready:true`, and no
   version skew. Close unintended existing sessions.
4. Create `test/evidence/discovery-ledger.md` when execution begins. Record target,
   account/namespace, submission URL, commit boundary, receipt, public listing URL,
   logged-out verification, and follow-up date.

### Wave 1 — Official MCP Registry

The official registry is authoritative and should precede community directories.

1. Run the current `mcp-publisher validate server.json` command.
2. Start `mcp-publisher login github`. When it opens a GitHub device/authorization page,
   use a Newton Browser owned session on `https://github.com` to inspect it, then hand the
   tab to the owner for any account choice, credential, or verification-code entry.
3. Confirm the authenticated identity can publish the
   `io.github.koala-studios/newton-browser` namespace.
4. Run `mcp-publisher publish server.json` only after authentication succeeds.
5. Verify the exact version through the registry API and a logged-out Newton Browser
   session. Check name, version, repository, npm package, stdio transport, and install
   command.

Reference: `https://modelcontextprotocol.io/registry/quickstart`.

### Wave 2 — Ingestion check

Wait 48 hours after the official publish, then use separate logged-out Newton Browser
sessions to search Glama, PulseMCP, Smithery, and MCP.so for both `Newton Browser` and
`io.github.koala-studios/newton-browser`.

- If a correct listing was automatically ingested, claim it when supported instead of
  creating a duplicate.
- If an entry is wrong, use its correction/claim route and record the requested changes.
- If no entry exists, proceed to Wave 3.

### Wave 3 — Community directories

#### Glama

1. Start an owned Newton Browser session scoped to `https://glama.ai`.
2. Use **List your server for free** / **Add Server** and submit the public GitHub
   repository, not a hosted endpoint.
3. Select Browser Automation and Developer Tools. Preserve the npm stdio install command.
4. Decline hosting, gateway, analytics, and deployment options; they are outside the
   product boundary.
5. Submit after the owner is signed in, then verify the public page in a logged-out
   session and inspect every indexed tool/schema.

#### PulseMCP

1. Start an owned session scoped to `https://www.pulsemcp.com` and inspect the current
   add/claim route.
2. Submit the repository, npm package, stdio command, MIT license, homepage, and privacy
   URL if the directory accepts local stdio servers.
3. If the current form requires a hosted URL, stop and record an incompatibility rather
   than inventing a remote service.
4. Verify the resulting public listing and install instructions logged out.

#### MCP.so

1. Start on `https://mcp.so` and use its **Submit** route. The current site routes server
   submissions to a GitHub issue.
2. Use Newton Browser on `https://github.com` for the issue form. Paste only the locked
   public metadata and submit after inspecting the final issue body.
3. Record the issue URL, then verify the directory entry after it is indexed.

#### Smithery

Smithery currently publishes remote MCP URLs or local MCPB bundles. Newton Browser ships
as an npm stdio package and has neither format.

1. Use Newton Browser to inspect the current Smithery publish UI and documentation.
2. Submit only if Smithery now supports GitHub/npm stdio ingestion or if Newton Browser
   later ships a reviewed MCPB artifact.
3. Do not use Uplink, create a tunnel, deploy a hosted proxy, or add telemetry to obtain
   a listing. If URL/MCPB remains mandatory, record Smithery as `incompatible-deferred`.

Reference: `https://smithery.ai/docs/concepts/cli`.

## Newton Browser operating procedure

For every dashboard:

1. Call `browser.status` before the first session.
2. Use a distinct `owned_group` session with the narrowest exact origin and a descriptive
   `instanceLabel`; use the normal profile only when an existing login is required.
3. Ask the owner to complete sign-in, account selection, credentials, OTP, or recovery.
   Never type or inspect those values.
4. Observe the fresh page, fill only public metadata, and re-observe after every rerender.
5. Treat Submit, Publish, Create issue, Claim, and Save as external commit boundaries.
   Inspect the final payload and confirm the submission remains within the approved target.
6. After dispatch, re-observe and capture the receipt/status because a blocked
   post-action network result may still mean the submission occurred.
7. Finalize the authenticated tab with `close` unless the owner needs a handoff. Verify no
   unintended Newton Browser sessions remain.
8. Verify the public result in a new incognito/logged-out owned session and record evidence.

## Listing-quality checks

Every listing must:

- identify the server as local stdio, not remote HTTP;
- show `npx -y newton-browser@0.4.0` or an equivalent version-pinned config;
- state that the Chrome/Edge extension is required;
- link the canonical repository, homepage, privacy policy, MIT license, and release;
- describe origin-scoped owned tabs, parallel agents, harness independence, token-efficient
  observations, local-only transport, no telemetry, and the safety floor accurately;
- avoid claims that a third-party directory hosts or secures Newton Browser;
- expose no account identifiers, private page data, credentials, or local paths.

## Completion criteria

Discovery is complete when:

- the official MCP Registry entry is public and verified;
- Glama, PulseMCP, and MCP.so are listed or have an accepted submission receipt;
- Smithery is either correctly listed or explicitly recorded as incompatible-deferred;
- every public listing has a logged-out verification row and canonical URL;
- README badges/links are updated with stable registry URLs;
- `docs/PROGRESS_LEDGER.md` marks WS12 complete.

