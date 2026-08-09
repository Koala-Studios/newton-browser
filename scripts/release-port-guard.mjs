import net from "node:net";

export const NEWTON_HOST_PORTS = Object.freeze(Array.from({ length: 20 }, (_, index) => 17_321 + index));

export async function probeOccupiedPorts(ports = NEWTON_HOST_PORTS) {
  const results = await Promise.all(ports.map(async (port) => [port, await canConnect(port)]));
  return new Set(results.filter(([, occupied]) => occupied).map(([port]) => port));
}

export function newlyOccupiedPorts(before, after) {
  return [...after].filter((port) => !before.has(port)).sort((left, right) => left - right);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(150, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
