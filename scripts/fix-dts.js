#!/usr/bin/env node
/**
 * Post-build script: create stable .d.ts shims that re-export from hashed chunks.
 * tsdown generates declarations like index-CFz20uZ_.d.ts; this creates index.d.ts → re-export.
 */
import { readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dist = "dist";
const entries = [
  ["index", ".d.ts"],
  ["testing", ".d.ts"],
  ["index", ".d.cts"],
  ["testing", ".d.cts"],
];

for (const [name, ext] of entries) {
  const target = join(dist, name + ext);
  if (existsSync(target)) continue;

  const chunk = readdirSync(dist).find(
    (f) => f.startsWith(name + "-") && f.endsWith(ext) && !f.endsWith(".map"),
  );
  if (chunk) {
    // Use .js extension for Node16 moduleResolution compatibility
    const importPath = "./" + chunk.replace(/\.d\.(c?)ts$/, ".$1js");
    writeFileSync(target, `export * from "${importPath}";\n`);
    console.log(`Created ${target} → ${chunk}`);
  }
}
