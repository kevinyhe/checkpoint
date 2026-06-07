import { parentPort, workerData } from "node:worker_threads";
import { runDiscoveryShard } from "./discovery.js";
import type { DiscoveryProgressEvent } from "./types.js";

if (!parentPort) {
  throw new Error("Discovery worker must be run inside a worker thread.");
}

try {
  const shard = await runDiscoveryShard({
    ...workerData,
    onProgress: (event: DiscoveryProgressEvent) => {
      parentPort?.postMessage({
        type: "progress",
        event
      });
    }
  });

  parentPort.postMessage({
    type: "result",
    shard
  });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    error: error instanceof Error ? error.message : String(error)
  });
}
