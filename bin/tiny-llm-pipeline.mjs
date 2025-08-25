#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import createPipeline, { validatePipeline } from "../index.js";

function parseArgs(argv) {
  const args = {
    file: null,
    input: null,
    timeout: null,
    perStepTimeout: null,
    stepTimeoutError: false,
    trace: false,
    preset: null,
    model: null,
    temperature: null,
    validate: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--trace") args.trace = true;
    else if (a === "--validate") args.validate = true;
    else if (a === "--input" || a === "-i") args.input = argv[++i];
    else if (a === "--timeout" || a === "-t") args.timeout = argv[++i];
    else if (a === "--per-step-timeout") args.perStepTimeout = argv[++i];
    else if (a === "--step-timeout-error") args.stepTimeoutError = true;
    else if (a === "--preset") args.preset = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--temperature") args.temperature = argv[++i];
    else if (!args.file) args.file = a;
  }
  return args;
}

function parseDuration(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d+)(ms|s|m)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] || "ms";
  if (unit === "ms") return n;
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60 * 1000;
  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  return buf.toString("utf8");
}

function printUsage() {
  console.error(
    `Usage: tiny-llm-pipeline <file.yaml> [--input input.json] [--timeout 30s] [--per-step-timeout 5s] [--step-timeout-error] [--trace] [--validate] [--preset openai|ollama] [--model m] [--temperature 0.7]\n`,
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    printUsage();
    process.exit(1);
  }
  const filePath = path.resolve(process.cwd(), args.file);
  const yaml = await fs.readFile(filePath, "utf8");

  let initialContext = {};
  if (args.input) {
    const text =
      args.input === "-"
        ? await readStdin()
        : await fs.readFile(args.input, "utf8");
    try {
      initialContext = JSON.parse(text);
    } catch (e) {
      console.error(`Invalid JSON in --input: ${(e && e.message) || e}`);
      process.exit(2);
    }
  }

  const hooks = args.trace
    ? {
        onStart: ({ steps }) => {
          console.error(`[start] steps=${steps.length}`);
        },
        onStepStart: ({ stepIndex, step }) => {
          const name = step && step.name ? ` ${step.name}` : "";
          console.error(
            `[step:start] #${stepIndex}${name} type=${step && step.type}`,
          );
        },
        onStepFinish: ({ stepIndex }) => {
          console.error(`[step:finish] #${stepIndex}`);
        },
        onStepError: ({ stepIndex, error }) => {
          console.error(
            `[step:error] #${stepIndex} ${String(error && error.message)}`,
          );
        },
        onFinish: ({ result }) => {
          console.error(`[finish] ok`);
        },
        onError: ({ error }) => {
          console.error(`[finish] error ${String(error && error.message)}`);
        },
      }
    : undefined;

  const overallTimeoutMs = parseDuration(args.timeout) || undefined;
  const perStepTimeoutMs = parseDuration(args.perStepTimeout) || undefined;

  let registry;
  if (args.preset === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("OPENAI_API_KEY is required for --preset openai");
      process.exit(2);
    }
    const model = args.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
    const temperature =
      args.temperature != null ? Number(args.temperature) : 0.7;
    registry = {
      models: {
        openai: async ({ prompt, params, signal }) => {
          const reqModel = (params && params.model) || model;
          const reqTemp = (params && params.temperature) ?? temperature;
          const res = await fetch(
            "https://api.openai.com/v1/chat/completions",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model: reqModel,
                messages: [{ role: "user", content: String(prompt) }],
                temperature: reqTemp,
              }),
              signal,
            },
          );
          const data = await res.json();
          if (!res.ok) {
            const msg =
              (data && data.error && data.error.message) ||
              `OpenAI error: ${res.status}`;
            throw new Error(msg);
          }
          return (
            (data.choices &&
              data.choices[0] &&
              data.choices[0].message &&
              data.choices[0].message.content) ||
            ""
          ).trim();
        },
      },
    };
  } else if (args.preset === "ollama") {
    const url = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
    const model = args.model || "gemma3:1b";
    const temperature =
      args.temperature != null ? Number(args.temperature) : 0.2;
    registry = {
      models: {
        ollama: async ({ prompt, params, signal }) => {
          const reqModel = (params && params.model) || model;
          const reqTemp = (params && params.temperature) ?? temperature;
          const res = await fetch(`${url}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: reqModel,
              prompt: String(prompt),
              stream: false,
              options: { temperature: reqTemp },
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
  }

  if (args.validate) {
    const res = await validatePipeline(yaml, {
      hooks,
      overallTimeoutMs: overallTimeoutMs ?? 2000,
      perStepTimeoutMs,
      stepTimeoutError: args.stepTimeoutError,
      initialContext,
    });
    if (res.ok) {
      console.error("Valid ✅");
      process.exit(0);
    } else {
      const e = res.error;
      const name = (e && e.name) || "Error";
      const msg = (e && e.message) || String(e);
      if (name === "PipelineValidationError") process.exitCode = 2;
      else process.exitCode = 1;
      console.error(`${name}: ${msg}`);
    }
  } else {
    const runWith = createPipeline(yaml, {
      hooks,
      overallTimeoutMs,
      perStepTimeoutMs,
      stepTimeoutError: args.stepTimeoutError,
      registry,
    });
    try {
      const out = await runWith(initialContext);
      const text =
        typeof out === "object" ? JSON.stringify(out, null, 2) : String(out);
      process.stdout.write(text + "\n");
      process.exit(0);
    } catch (e) {
      const name = (e && e.name) || "Error";
      const msg = (e && e.message) || String(e);
      if (name === "PipelineValidationError") process.exitCode = 2;
      else if (name === "PipelineTimeout") process.exitCode = 3;
      else if (name === "PipelineCancelled") process.exitCode = 4;
      else process.exitCode = 1;
      console.error(`${name}: ${msg}`);
    }
  }
}

main().catch((e) => {
  console.error(String(e && e.stack) || String(e));
  process.exit(1);
});
