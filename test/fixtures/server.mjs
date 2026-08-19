import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "app");
export async function startFixtureServers({ port = 18231, crossOriginPort = port + 1, thirdOriginPort } = {}) {
  const origins = { main: "", destination: "", third: "" };
  const main = fixtureServer(origins);
  const cross = fixtureServer(origins);
  const third = thirdOriginPort === undefined ? null : fixtureServer(origins);
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
    async close() { await Promise.all([close(main), close(cross), ...(third ? [close(third)] : [])]); },
  };
}

function fixtureServer(origins) {
  const server = http.createServer((request, response) => serve(request, response, root, { origins }));
  server.on("upgrade", (request, socket) => {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  return server;
}

function serve(request, response, directory, options = {}) {
  const pathname = requestPath(request);
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
