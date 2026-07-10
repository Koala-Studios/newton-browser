# Security

The binding security and trust model is locked in [DECISIONS.md](DECISIONS.md). Browser Bridge is loopback-only, pairing-authenticated, origin-scoped, and local-user trusted. It does not inspect cookies, storage, profile files, saved passwords, or authentication tokens.
