#!/usr/bin/env node
if (process.argv.includes("init")) {
  import("../dist/init.js").then((m) => m.main());
} else {
  import("../dist/index.js");
}
