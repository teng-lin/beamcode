#!/usr/bin/env node
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/consumer", { recursive: true });
cpSync("src/consumer/index.html", "dist/consumer/index.html");
console.log("Copied src/consumer/index.html → dist/consumer/index.html");
