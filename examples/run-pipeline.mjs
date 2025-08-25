import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createPipeline from "../index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(__dirname, "pipeline.yaml");
const yaml = await fs.readFile(file, "utf8");

const registry = {
  models: {
    demo: async ({ prompt }) => `DEMO:${prompt}`,
    fail: async () => {
      throw new Error("fail");
    },
  },
};

const run = createPipeline(yaml, { registry });
const result = await run();
console.log(
  typeof result === "object" ? JSON.stringify(result, null, 2) : String(result),
);
