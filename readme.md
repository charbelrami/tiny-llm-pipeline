# tiny-llm-pipeline

YAML DSL for LLM pipeline creation. Define simple pipelines in YAML that set variables, render templates, and call pluggable LLM providers. Tiny, ESM-only, zero dependencies.

> Note: This package is ESM-only. For CommonJS consumers, use dynamic `import()` or create a small bridge module.

## Install

```sh
npm i tiny-llm-pipeline
# or
pnpm add tiny-llm-pipeline
# or
yarn add tiny-llm-pipeline
```

## Usage

```yaml
# yaml-language-server: $schema=./schema.json
# pipeline.yaml
steps:
  - type: set
    var: poem.topic
    value: rain

  - type: set
    var: prompt
    value: |
      Write a short haiku about {{poem.topic}}.

  - type: llm
    model: ollama
    from: prompt
    params:
      model: gemma3:1b
      temperature: 0.7
    var: completion

  - type: output
    pick: completion
```

```js
import createPipeline from "tiny-llm-pipeline";

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

const yaml = await (await fetch("/pipeline.yaml")).text();
const run = createPipeline(yaml, { registry });
const out = await run();
console.log(out.completion);
```

### CommonJS interop

```js
async function getPipeline() {
  const mod = await import("tiny-llm-pipeline");
  return mod.default;
}
module.exports = { getPipeline };
```

## DSL

Steps are executed sequentially.

- Common step fields:
  - `timeoutMs`: number; optional per-step timeout that overrides `options.perStepTimeoutMs`.
  - `name`: optional display name; surfaced in error annotations (`stepName`).

- `set`: set a variable. Supports dot-paths.
  - `var`: string path (e.g., `user.name`)
  - `value`: scalar or template string (supports `{{var}}` interpolation)

- `llm`: call a model function registered under `options.registry.models[name]`.
  - `model`: string
  - `prompt`: template string, or
  - `from`: context path that supplies the prompt (shorthand for `prompt: "{{path}}"`). The path must exist; a missing path throws a validation error.
  - `params`: optional object passed to the model. String leaves are templated recursively using `{{var}}`.
  - `var`: destination for the model output (optional)

- `output`: return a value and stop the pipeline.
  - `value`: literal or templated value to return
  - `pick`: string path, array of paths, or an object map `{ alias: "path" }` to shape the output
  - If omitted, returns the entire context

Flow control extensions:

- `if`: conditional execution.
  - `when`: template or literal; executes `then` when truthy, otherwise `else`.
  - `whenVar`: string path; use a value directly from context for the condition.
  - One of `when` or `whenVar` is required.
  - `then`: array of steps (optional)
  - `else`: array of steps (optional)
  - Note: `output` is not allowed inside `if` branches.

- `foreach`: iterate over an array in context.
  - `in`: string path of an array (required)
  - `as`: variable name for the current item (default `item`)
  - `index`: optional variable name for the current index
  - `scoped`: when `true`, the previous values of loop vars are restored after the loop
  - `steps`: array of steps executed for each item; context is shared across iterations
  - Note: `output` is not allowed inside the loop body.

- `parallel`: run branches concurrently on cloned child contexts and collect their results.
  - `branches`: array of `{ steps: [...] }`, each branch should `output` a value if you want a scalar result; otherwise the final child context is used
  - `var`: destination path to store an array of branch results
  - `mode`: optional
    - default ("all"): fail-fast, collects results as an array.
    - `allSettled`: collects `{ status, value|reason }` like `Promise.allSettled` (never throws).
    - `race`: resolves with the first successful branch and aborts the rest.
  - `result`: optional ("context" | "value"); when set to "value", branches that do not call `output` contribute `undefined` instead of their full child context. Use this to reduce memory for large branch contexts. Default is "context".
  - Zero branches behavior: with no `branches`, default and `allSettled` set `var` to `[]`, while `race` sets `var` to `undefined`.
  - Note: `output` is allowed inside branches and its value becomes that branch’s result; otherwise the child context is used as the result.

### DSL structure (diagram)

```
pipeline
  steps: [ Step ]

Step
  = Set | Llm | Output | If | Foreach | Parallel

Set
  - type: "set"
  - var: <dot.path>
  - value: <any|string-template>

Llm
  - type: "llm"
  - model: <string>
  - (prompt: <string-template> | from: <dot.path>)
  - params?: <object with templated string leaves>
  - var?: <dot.path>

Output
  - type: "output"
  - value?: <any|string-template>
  - pick?: <path | path[] | { alias: path }>

If
  - type: "if"
  - (when: <any|string-template> | whenVar: <dot.path>)
  - then?: [ Step ]
  - else?: [ Step ]
  - constraint: "output" not allowed inside then/else

Foreach
  - type: "foreach"
  - in: <dot.path of array>
  - as?: <string = "item">
  - index?: <string>
  - scoped?: <boolean>
  - steps: [ Step ]
  - constraint: "output" not allowed inside steps

Parallel
  - type: "parallel"
  - branches: [ { steps: [ Step ] } ]
  - var?: <dot.path>
  - mode?: "all" | "allSettled" | "race"
  - result?: "context" | "value"
  - note: branch result = output(value) ? value : childContext
```

## Step Reference

- set: `type`, `var`, `value`
  - Sets `var` to a value. Strings are templated; use `|` for multi-line.
- llm: `type`, `model`, (`prompt` | `from`), `params?`, `var?`, `retry?`
  - Calls a registered model; `prompt` templated or `from` reads context path.
- output: `type`, (`value` | `pick?`)
  - Returns a value and stops. `pick` = string | string[] | map `{ alias: path }`.
- if: `type`, (`when` | `whenVar`), `then?`, `else?`
  - Conditionally runs branches using user-friendly truthiness (see below).
- foreach: `type`, `in`, `as?`, `index?`, `scoped?`, `steps`
  - Iterates array from context; sets loop vars; disallows `output` inside.
- parallel: `type`, `branches`, `var?`, `mode?`, `concurrency?`
  - Runs branches on cloned contexts; `allSettled` or `race` mode.

## Patterns

- Prompt building:
  - Use `set` with a block scalar to build prompts, then `llm.from: prompt`.
- Branching without early return:
  - Inside `if`/`foreach`, set vars or flags; perform `output` after the block.
- Shaping results:
  - Use `output.pick` with an object map to alias fields.
- Parallel collection:
  - In `parallel`, `output` inside a branch yields a scalar result; otherwise the child context is collected.

### YAML subset

This library ships a tiny YAML subset parser to avoid dependencies. It supports:

- 2-space indentation, objects (key: value), arrays (`- item`), strings (quoted or unquoted), numbers, booleans, null.
- Inline objects like `{ a: 1, b: "x" }` for simple maps.
- Inline arrays like `[1, "x", true]` for simple lists. Quoted items are supported; anchors/tags are not.
- No anchors, tags, merges, or advanced YAML features.
- Trailing inline comments (e.g., `foo: 1 # note`) are ignored when they follow whitespace and are not inside quotes/brackets/braces.
- Only `true`/`false` booleans are recognized; YAML variants like `yes/no/on/off` are not supported.
- Folded scalars (`>`) are not supported; block scalars with `|` are supported on `key: |` lines.

If you need full YAML, supply `options.parseYAML` using `yaml` or another parser.
Note: inline map string values should use double quotes; single quotes are not normalized by the inline map parser.

## API

### createPipeline(source, options?)

- **source**: YAML string or plain object with `{ steps: [...] }`.
- **options.parseYAML**: optional custom YAML parser.
- **options.registry.models**: object of model functions `(args: { prompt, params?, signal, context }) => Promise<any>`.
- **options.perStepTimeoutMs**: optional timeout per step.
- Each step may set `timeoutMs` to override the global per-step timeout.
- **options.overallTimeoutMs**: optional timeout for the whole pipeline.
- **options.parentSignal**: optional `AbortSignal` canceling the whole run.
- **options.stepTimeoutError**: when `true`, per-step timeouts throw `PipelineStepTimeout` instead of a generic cancellation (default `false`).
- **options.cloneContext**: optional deep clone function used to isolate `parallel` branch contexts (defaults to `structuredClone`/JSON clone).
- **options.hooks**: lifecycle hooks `{ onStart, onFinish, onError, onStepStart, onStepFinish, onStepError }` executed fire-and-forget.
- **options.stepHandlers**: map of custom step handlers. When a step's `type` matches a key, that handler is invoked with helpers `{ get, set, runSteps, sleep, signal, registry, models }`. If the handler returns a value and the step has `var`, it will be assigned.
- **returns**: `(initialContext?) => Promise<any>` with `.start(...)`, `.withSignal(...)`, and `.startWithSignal(...)`.

Retry support:

- Any step may specify `retry: { retries?: number, backoffMs?: number, jitter?: 0..1, on?: "any"|"error"|"timeout" }`.
- Retries are attempted for `llm` and custom `stepHandlers`. User cancellations are never retried.

Parallel options:

- `parallel.concurrency`: limit number of concurrent branches.
- `parallel.mode: "race"`: resolve with the first successful branch and abort the rest.

### Errors

- `PipelineCancelled` (`code === "E_PIPELINE_CANCELLED"`)
- `PipelineTimeout` (`code === "E_PIPELINE_TIMEOUT"`)
- `PipelineValidationError` (`code === "E_PIPELINE_VALIDATION"`)
- `PipelineStepTimeout` (`code === "E_PIPELINE_STEP_TIMEOUT"`) when `options.stepTimeoutError` is enabled.
- Helpers: `isPipelineCancelled`, `isPipelineTimeout`, `isPipelineValidation`, `isPipelineStepTimeout`

### Escaping in templates

- Use quadruple braces to emit literal braces without interpolation:
  - `{{{{` renders `{{`
  - `}}}}` renders `}}`
  - Example: `literal {{{{not-var}}}} and value {{x}}`

Templates perform simple `{{path.to.value}}` substitution and do not escape output.
Apply context-appropriate escaping in your sinks (e.g., HTML, URL, SQL) or post-process interpolated values before use.

### Path safety

Dot-path helpers reject dangerous segments to avoid prototype pollution.
The keys `__proto__`, `prototype`, and `constructor` are not allowed in paths and will throw a validation error.

Additional notes:

- Dot-paths treat `.` as a separator only; keys containing literal dots cannot be addressed.
- Deleting array elements via a path like `arr.0` will create sparse arrays (holes).

### Truthiness

Conditions use user-friendly truthiness:

- `false`, `0`, `""`, `null`, `undefined` are falsy
- Strings "false" and "0" (after trimming) are also treated as falsy
- Everything else is truthy

Both `when` (after template rendering) and `whenVar` values are evaluated with the same rules.

### Quality Rationale

- **No deps**: Includes a tiny YAML subset parser; pluggable full parser via `options.parseYAML`.
- **Abort hygiene**: step-level controllers chained to a parent; timers unref in Node.
- **Minimal surface**: only essential step types; flexible model registry.
- **Predictable templating**: simple `{{var}}` interpolation with dot-path access.

### TypeScript notes

The model function signature is typed; include DOM types or `@types/node` depending on your runtime.

Additionally exported: `renderTemplate(tpl, ctx)` to reuse the built-in template interpolation.

## CLI

Install globally or use via npx:

```sh
npx tiny-llm-pipeline examples/pipeline.yaml --trace
```

Usage:

- `tiny-llm-pipeline <file.yaml> [--input input.json] [--timeout 30s] [--per-step-timeout 5s] [--step-timeout-error] [--trace] [--validate]`
- Presets: `--preset openai|ollama` with optional `--model` and `--temperature`.
- `--per-step-timeout`: apply a timeout to each step.
- `--step-timeout-error`: classify per-step timeouts as `PipelineStepTimeout` instead of cancellation.
- `--validate`: parse and walk the pipeline with a stubbed `llm` step (no provider calls). Prints `Valid` on success. Exits 0 on success, 2 on validation errors, 1 otherwise.
- Exit codes: 0 success, 2 validation, 3 timeout, 4 cancelled, 1 other.

Tracing uses the library hooks to print step start/finish and errors to stderr.

Examples:

- Retry: `examples/retry.yaml`
- Race mode: `examples/parallel-race.yaml`

## Additional Notes

- Use `pipeline.startWithSignal(parentSignal, initialContext?)` to get `{ promise, cancel }` with a bound parent signal.

## Examples

### YAML examples

Run YAML pipelines directly with the provided runner (Node 18+):

- node examples/run-pipeline.mjs examples/pipeline.yaml
- node examples/run-pipeline.mjs examples/conditional.yaml
- node examples/run-pipeline.mjs examples/loop.yaml
- node examples/run-pipeline.mjs examples/parallel.yaml
- node examples/run-pipeline.mjs examples/allSettled.yaml

### Provider examples (YAML)

- OpenAI (YAML): set OPENAI_API_KEY (and optionally OPENAI_MODEL), then run:
  - node examples/run-openai.mjs
- Ollama gemma3:1b (YAML): ensure Ollama is running and the model is available (`ollama pull gemma3:1b`). Optionally set OLLAMA_URL. Then run:
  - node examples/run-ollama-gemma3.mjs

### OpenAI quickstart and snapshots

- Run with environment model override:
  - macOS/Linux (zsh/bash):
    - `export OPENAI_API_KEY="<your-key>"`
    - `export OPENAI_MODEL="gpt-4o-mini"`
    - `node examples/run-openai.mjs > examples/snapshots/openai_env_gpt-4o-mini.txt`
- Run via CLI preset with explicit model:
  - macOS/Linux (zsh/bash):
    - `export OPENAI_API_KEY="<your-key>"`
    - `npx tiny-llm-pipeline examples/openai.yaml --preset openai --model gpt-4o-mini > examples/snapshots/openai_cli_gpt-4o-mini.txt`
- Retry example via CLI preset:
  - macOS/Linux (zsh/bash):
    - `export OPENAI_API_KEY="<your-key>"`
    - `npx tiny-llm-pipeline examples/retry.yaml --preset openai > examples/snapshots/openai_retry_gpt-4o-mini.txt`

Snapshot files are stored under `examples/snapshots/`. Outputs are non-deterministic and may vary per run and model version.

### Validation helper

Programmatic validation without provider calls:

```js
import { validatePipeline } from "tiny-llm-pipeline";

const source = `steps:\n  - type: set\n    var: x\n    value: 1`;
const res = await validatePipeline(source, { overallTimeoutMs: 2000 });
if (!res.ok) console.error("Invalid:", res.error);
```

### Parallel clone caveat

By default, branch contexts are deep-cloned using `structuredClone` (or JSON fallback). Non-plain objects, functions, or special prototypes may not survive cloning; pass a custom `cloneContext` if needed.

When running heavy parallel branches, consider:

- Setting `parallel.result: "value"` so only explicit `output` values are collected.
- Using `concurrency` to cap peak memory.

### Timeout classification

- Overall timeout always raises `PipelineTimeout`.
- Per-step timeouts:
  - Default: treated as cancellation (`PipelineCancelled`).
  - With `stepTimeoutError: true`: classified as `PipelineStepTimeout`.
  - CLI flag `--step-timeout-error` enables this behavior.

### Parallel modes (flowchart)

```
parallel
  ├─ spawn N branches on cloned contexts
  ├─ each branch result = output(value) ? value : childContext
  └─ mode:
      • all (default)
          ├─ wait for all
          ├─ any failure → throw
          └─ results[] assigned to var (or discarded)
      • allSettled
          ├─ wait for all
          └─ results[] = { status: "fulfilled"|"rejected", value|reason }
      • race
          ├─ resolve on first fulfilled branch
          ├─ abort remaining branches
          └─ result assigned to var (undefined if no success)

Zero branches:
  • all/allSettled → var = []
  • race → var = undefined
```

## Troubleshooting

- Output inside control flow: `output` is not allowed inside `if`/`foreach` bodies. Move the `output` after the block or set vars inside and `output` once.
- Missing path in `llm.from`: `from` must reference an existing context path. Use `prompt` directly or `set` the path before `llm`.
- YAML subset gotchas: use 2-space indentation; only `true`/`false` booleans; no anchors/merges; inline map string values should use double quotes.
- Template escaping: interpolation does not escape values. Apply escaping at sinks (HTML/URL/SQL) to avoid injection issues.
- Parallel cloning: non-plain objects/functions may be dropped by default cloning. Provide a custom `cloneContext` for special types.
- Timeouts vs cancellation: per-step timeouts are cancellations by default; enable `stepTimeoutError` to classify as `PipelineStepTimeout`.
- ESM-only errors in CJS: use dynamic `import()` (see CommonJS interop) or a small bridge module.

## License

MIT
