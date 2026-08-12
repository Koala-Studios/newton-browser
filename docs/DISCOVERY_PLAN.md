# Historical discovery plan

This file records the intent of the 0.4.1 distribution experiment. It is archival only
and contains no current setup or operating instructions.

The experiment evaluated whether agents could discover a local browser-control product,
configure an MCP client, and complete bounded read-only workflows. That release used a
browser add-on and a loopback control plane. Both were superseded by the owned-browser
architecture in Decisions 33, 35, 38, and 42 and have now been deleted.

Current discovery and onboarding are intentionally smaller:

1. install the single npm package;
2. run `newton-browser --install <client>` or copy `--print-config` output;
3. run `newton-browser --doctor`;
4. start an exact-origin session, which launches its isolated Chrome or Edge process;
5. use an ephemeral identity or an operator-created opaque Newton identity;
6. close the session and confirm no session/process/lease residue.

The current product boundary, schemas, safety rules, and release requirements live in
[`INSTALL.md`](INSTALL.md), [`SECURITY.md`](SECURITY.md),
[`PRIVACY.md`](PRIVACY.md), and [`RELEASE.md`](RELEASE.md). Historical screenshots,
store-listing copy, add-on refresh instructions, tab-group workflows, and logged-out
incognito comparisons are not applicable to the current product.
