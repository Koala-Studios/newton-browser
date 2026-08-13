import net from "node:net";

// Deterministic long-lived child used to prove the browser guardian owns and
// terminates its process tree when the MCP host connection disappears.
const server = net.createServer();
server.listen(0, "127.0.0.1");
