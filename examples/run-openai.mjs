import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createPipeline from "../index.js";

if (!process.env.OPENAI_API_KEY) {
  console.error("Set OPENAI_API_KEY in your environment.");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(__dirname, "openai.yaml");
const yaml = await fs.readFile(file, "utf8");

const registry = {
  models: {
    openai: async ({ prompt, params, signal }) => {
      const model =
        (params && params.model) || process.env.OPENAI_MODEL || "gpt-4o-mini";
      const temperature = (params && params.temperature) ?? 0.7;
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model, input: String(prompt), temperature }),
        signal,
      });
      const data = await res.json();
      if (!res.ok) {
        const msg =
          (data && data.error && data.error.message) ||
          `OpenAI error: ${res.status}`;
        throw new Error(msg);
      }
      return data.output[0].content[0].text.trim();
    },
  },
};

const run = createPipeline(yaml, { registry, overallTimeoutMs: 30_000 });
const result = await run();
console.log(
  typeof result === "object" ? JSON.stringify(result, null, 2) : String(result),
);
