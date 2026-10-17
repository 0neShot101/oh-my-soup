import * as Module from "node:module";
import * as path from "node:path";
import { ensureRuntimeInstalled } from "../../src/runtime-install";

const runtimeDir = process.argv[2];
const spec = process.argv[3];
await ensureRuntimeInstalled({ runtimeDir, install: { dependencies: { "oms-storage-fixture": spec } } });
const require = Module.createRequire(path.join(runtimeDir, "package.json"));
const multiply = require("oms-storage-fixture") as (left: number, right: number) => number;
console.log(JSON.stringify({ value: multiply(6, 7) }));
