import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "app");
const containmentRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "origin-containment");

export async function startFixtureServers({ port = 18231, crossOriginPort = port + 1, thirdOriginPort } = {}) {
  const requests = createContainmentRequestLedger();
  const origins = { main: "", destination: "", third: "" };
  const main = fixtureServer("main", requests, origins);
  const cross = fixtureServer("destination", requests, origins);
  const third = thirdOriginPort === undefined ? null : fixtureServer("third", requests, origins);
  await Promise.all([
    listen(main, port),
    listen(cross, crossOriginPort),
    ...(third ? [listen(third, thirdOriginPort)] : []),
  ]);
  origins.main = addressOrigin(main);
  origins.destination = addressOrigin(cross);
  origins.third = third ? addressOrigin(third) : "";
  return {
    origin: origins.main,
    crossOrigin: origins.destination,
    ...(third ? { thirdOrigin: origins.third } : {}),
    containment: Object.freeze({
      reset: () => requests.reset(),
      snapshot: () => requests.snapshot(),
    }),
    async close() { await Promise.all([close(main), close(cross), ...(third ? [close(third)] : [])]); },
  };
}

function fixtureServer(role, requests, origins) {
  const server = http.createServer((request, response) => serve(request, response, root, { role, requests, origins }));
  server.on("upgrade", (request, socket) => {
    const pathname = requestPath(request);
    if (pathname.startsWith("/origin-containment/")) requests.record(role, request.method, pathname, containmentKind(pathname));
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  return server;
}

function serve(request, response, directory, options = {}) {
  const pathname = requestPath(request);
  if (pathname.startsWith("/origin-containment/")) {
    options.requests.record(options.role, request.method, pathname, containmentKind(pathname));
    if (serveContainment(request, response, pathname, options)) return;
  }
  if (request.url === "/write" && request.method === "POST") return response.writeHead(204).end();
  if (request.url === "/submitted" && request.method === "POST") return response.writeHead(200, { "content-type": "text/plain" }).end("submitted");
  if (request.url === "/download") return response.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="fixture.txt"' }).end("fixture-download");
  if (request.url === "/redirect-cross") return response.writeHead(302, { location: `${options.origins.destination}/cross-origin.html` }).end();
  const appPathname = request.url === "/" ? "/index.html" : pathname;
  const file = path.resolve(directory, `.${appPathname}`);
  if (!file.startsWith(path.resolve(directory)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return response.writeHead(404).end("not found");
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  response.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(response);
}

function serveContainment(request, response, pathname, { origins }) {
  const headers = { "access-control-allow-origin": "*", "cache-control": "no-store" };
  if (pathname === "/origin-containment/redirect-to-destination") {
    response.writeHead(302, { ...headers, location: `${origins.destination}/origin-containment/application/redirect.html` }).end();
    return true;
  }
  if (pathname === "/origin-containment/application/mutation") {
    response.writeHead(204, headers).end();
    return true;
  }
  if (pathname === "/origin-containment/application/connection") {
    response.writeHead(200, { ...headers, "content-type": "text/event-stream" }).end("event: ready\ndata: connected\n\n");
    return true;
  }
  if (pathname === "/origin-containment/application/worker.js") {
    response.writeHead(200, { ...headers, "content-type": "text/javascript; charset=utf-8" }).end('postMessage("destination-worker-executed");');
    return true;
  }
  if (pathname === "/origin-containment/application/redirect.html" || pathname === "/origin-containment/application/popup.html" || pathname === "/origin-containment/application/frame.html") {
    const marker = pathname.split("/").at(-1)?.replace(".html", "") ?? "application";
    response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="en"><body><button>${marker} destination control</button><script>globalThis.__newtonDestinationExecuted=${JSON.stringify(marker)};<\/script></body></html>`);
    return true;
  }
  if (pathname === "/origin-containment/resource/pixel.svg") {
    response.writeHead(200, { ...headers, "content-type": "image/svg+xml" }).end('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#0a0"/></svg>');
    return true;
  }
  if (pathname === "/origin-containment/resource/style.css") {
    response.writeHead(200, { ...headers, "content-type": "text/css; charset=utf-8" }).end("#containment-read-only { color: rgb(0, 128, 0); }");
    return true;
  }
  const relative = pathname.slice("/origin-containment/".length);
  const file = path.resolve(containmentRoot, relative);
  if (!file.startsWith(path.resolve(containmentRoot)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  response.writeHead(200, { ...headers, "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(response);
  return true;
}

function createContainmentRequestLedger() {
  let sequence = 0;
  let destinationApplicationRequests = 0;
  let destinationResourceRequests = 0;
  const entries = [];
  return {
    record(originRole, method, pathname, kind) {
      if (originRole === "destination" && kind === "application") destinationApplicationRequests += 1;
      if (originRole === "destination" && kind === "resource") destinationResourceRequests += 1;
      entries.push(Object.freeze({ sequence: ++sequence, originRole, method: String(method ?? "GET").toUpperCase(), pathname, kind }));
      if (entries.length > 512) entries.shift();
    },
    reset() {
      entries.length = 0;
      sequence = 0;
      destinationApplicationRequests = 0;
      destinationResourceRequests = 0;
    },
    snapshot() {
      const copy = entries.map((entry) => entry);
      return Object.freeze({
        destinationApplicationRequests,
        destinationResourceRequests,
        entries: Object.freeze(copy),
      });
    },
  };
}

function containmentKind(pathname) {
  if (pathname.startsWith("/origin-containment/application/")) return "application";
  if (pathname.startsWith("/origin-containment/resource/")) return "resource";
  return "control";
}

function requestPath(request) {
  return new URL(request.url ?? "/", "http://fixture.local").pathname;
}

function addressOrigin(server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_server_address_unavailable");
  return `http://127.0.0.1:${address.port}`;
}

function listen(server, port) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); }
function close(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll("\\", "/")}`) {
  const running = await startFixtureServers({ port: Number(process.env.NEWTON_BROWSER_FIXTURE_PORT ?? 18231) });
  process.stdout.write(`${JSON.stringify(running)}\n`);
}
