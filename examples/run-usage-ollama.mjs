import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createPipeline from "../index.js";

// Minimal example matching the README Usage snippet.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(__dirname, "ollama-gemma3.yaml");
const yaml = await fs.readFile(file, "utf8");

const registry = {
  models: {
    ollama: async ({ prompt, params, signal }) => {
      const res = await fetch("http://127.0.0.1:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: params?.model ?? "gemma3:1b",
          prompt: String(prompt),
          stream: false,
          options: { temperature: params?.temperature ?? 0.7 },
        }),
        signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Ollama ${res.status}`);
      return data?.response || "";
    },
  },
};

const run = createPipeline(yaml, { registry });
const out = await run();
console.log(
  typeof out === "object" ? JSON.stringify(out, null, 2) : String(out),
);
