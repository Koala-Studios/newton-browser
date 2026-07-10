import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "app");

export async function startFixtureServers({ port = 18231, crossOriginPort = port + 1 } = {}) {
  const main = http.createServer((request, response) => serve(request, response, root));
  const cross = http.createServer((request, response) => serve(request, response, root));
  await Promise.all([listen(main, port), listen(cross, crossOriginPort)]);
  return {
    origin: `http://127.0.0.1:${port}`,
    crossOrigin: `http://127.0.0.1:${crossOriginPort}`,
    async close() { await Promise.all([close(main), close(cross)]); },
  };
}

function serve(request, response, directory) {
  if (request.url === "/write" && request.method === "POST") return response.writeHead(204).end();
  if (request.url === "/submitted" && request.method === "POST") return response.writeHead(200, { "content-type": "text/plain" }).end("submitted");
  if (request.url === "/download") return response.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="fixture.txt"' }).end("fixture-download");
  const pathname = request.url === "/" ? "/index.html" : new URL(request.url ?? "/", "http://fixture.local").pathname;
  const file = path.resolve(directory, `.${pathname}`);
  if (!file.startsWith(path.resolve(directory)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return response.writeHead(404).end("not found");
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  response.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(response);
}

function listen(server, port) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }

if (import.meta.url === `file:///${process.argv[1]?.replaceAll("\\", "/")}`) {
  const running = await startFixtureServers({ port: Number(process.env.BROWSER_BRIDGE_FIXTURE_PORT ?? 18231) });
  process.stdout.write(`${JSON.stringify(running)}\n`);
}
