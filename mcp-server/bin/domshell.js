#!/usr/bin/env node
import { readFileSync } from "node:fs";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
  console.log(pkg.version);
} else if (process.argv.includes("init")) {
  import("../dist/init.js").then((m) => m.main());
} else {
  import("../dist/index.js");
}
