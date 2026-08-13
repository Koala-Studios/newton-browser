const destination = `http://127.0.0.1:${Number(location.port) + 1}`;

fetch(`${destination}/origin-containment/application/worker.js`)
  .then((response) => postMessage(response.ok ? "worker-unexpectedly-allowed" : "worker-blocked"))
  .catch(() => postMessage("worker-blocked"));
