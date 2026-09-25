import path from "node:path";
import { startNativeBroker } from "./native-broker.ts";

// The immutable launch entry supplies the already-installed private rendezvous directory.
const directory = process.env.NEWTON_NATIVE_DIRECTORY;
if (!directory || !path.isAbsolute(directory)) throw new Error("native_installation_missing");
await startNativeBroker(directory, process.stdin, process.stdout);
