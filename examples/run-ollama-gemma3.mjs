import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createPipeline from "../index.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(__dirname, "ollama-gemma3.yaml");
const yaml = await fs.readFile(file, "utf8");

const registry = {
  models: {
    ollama: async ({ prompt, params, signal }) => {
      const model = (params && params.model) || "gemma3:1b";
      const temperature = (params && params.temperature) ?? 0.2;
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: String(prompt),
          stream: false,
          options: { temperature },
        }),
        signal,
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = (data && data.error) || `Ollama error: ${res.status}`;
        throw new Error(msg);
      }
      return (data && data.response) || "";
    },
  },
};

const run = createPipeline(yaml, { registry, overallTimeoutMs: 60_000 });
const result = await run();
console.log(
  typeof result === "object" ? JSON.stringify(result, null, 2) : String(result),
);
