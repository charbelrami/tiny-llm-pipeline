import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createPipeline from "../index.js";

if (!process.env.OPENAI_API_KEY) {
  console.error("Set OPENAI_API_KEY in your environment.");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(__dirname, "openai-tools.yaml");
const yaml = await fs.readFile(file, "utf8");

const tools = {
  async get_current_weather({ location, unit }, { signal }) {
    const tempC = 22;
    const tempF = Math.round((tempC * 9) / 5 + 32);
    const u = (unit || "fahrenheit").toLowerCase();
    const temperature = u.startsWith("c") ? tempC : tempF;
    return {
      location,
      unit,
      current_weather: {
        temperature,
        condition: "Sunny",
        humidity: 50,
        wind_speed: 5,
      },
    };
  },
};

const registry = {
  tools,
  models: {
    openai: async ({ prompt, params, signal, context }) => {
      const apiKey = process.env.OPENAI_API_KEY;
      const base = buildBaseParams(params);
      let messages = [buildUserMessage(String(prompt))];
      const maxTurns = 8; // small safety cap to avoid infinite loops

      for (let turn = 0; turn < maxTurns; turn++) {
        const data = await callOpenAI({ apiKey, base, messages, signal });
        const { calls, text } = parseResponse(data);

        if (!calls.length) return text;

        const outputs = await Promise.all(
          calls.map(async (c) => {
            const fn = registry.tools?.[c.name];
            if (typeof fn !== "function")
              throw new Error(`Unknown tool: ${c.name}`);
            const args = c.arguments ? JSON.parse(c.arguments) : {};
            if (c.name === "get_current_weather" && !args.unit)
              args.unit = "fahrenheit";
            const out = await fn(args, { signal, context });
            return { call_id: c.call_id, output: asString(out) };
          }),
        );

        for (const c of calls) messages.push(asFunctionCall(c));
        for (const o of outputs) messages.push(asFunctionOutput(o));
      }

      throw new Error("maxTurns exceeded while handling tool calls");
    },
  },
};

function buildBaseParams(params) {
  return {
    model: params?.model || process.env.OPENAI_MODEL || "gpt-4.1",
    tools: params?.tools,
    tool_choice: params?.tool_choice ?? "auto",
    parallel_tool_calls: params?.parallel_tool_calls ?? true,
    temperature: params?.temperature ?? 0,
    max_output_tokens: params?.max_output_tokens,
    text: params?.text ?? { format: { type: "text" } },
    store: false,
  };
}

function buildUserMessage(text) {
  return { role: "user", content: [{ type: "input_text", text }] };
}

async function callOpenAI({ apiKey, base, messages, signal }) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...base, input: messages }),
    signal,
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || `OpenAI error: ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function parseResponse(data) {
  const parts = Array.isArray(data.output) ? data.output : [];
  const calls = parts.filter((p) => p && p.type === "function_call");
  let text = "";
  if (typeof data.output_text === "string" && data.output_text)
    text = data.output_text;
  else {
    for (const p of parts) {
      if (p && p.type === "message" && Array.isArray(p.content)) {
        for (const c of p.content) {
          if (c && c.type === "output_text" && typeof c.text === "string")
            text += c.text;
        }
      }
    }
  }
  return { parts, calls, text };
}

function asFunctionCall(c) {
  return {
    type: "function_call",
    id: c.id,
    call_id: c.call_id,
    name: c.name,
    arguments: c.arguments,
  };
}

function asFunctionOutput(o) {
  return { type: "function_call_output", call_id: o.call_id, output: o.output };
}

function asString(v) {
  return typeof v === "string" ? v : JSON.stringify(v);
}

const run = createPipeline(yaml, {
  registry,
  overallTimeoutMs: 60_000,
});

try {
  const result = await run();
  console.log(
    typeof result === "object"
      ? JSON.stringify(result, null, 2)
      : String(result),
  );
} catch (e) {
  console.error("run-openai-tools error:", e?.stack || e);
  process.exit(1);
}
