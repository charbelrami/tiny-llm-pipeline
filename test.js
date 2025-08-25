import test from "node:test";
import assert from "node:assert/strict";
import createPipeline, {
  isPipelineCancelled,
  isPipelineTimeout,
  isPipelineStepTimeout,
  isPipelineValidation,
} from "./index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("YAML parser: set/llm/output", async () => {
  const yaml = `
steps:
  - type: set
    var: poem.topic
    value: rain
  - type: set
    var: prompt
    value: |
      Write a poem about {{poem.topic}}.
  - type: llm
    model: demo
    from: prompt
    var: completion
  - type: output
    pick:
      - completion
`;

  const registry = {
    models: { demo: async ({ prompt }) => `Y:${prompt}` },
  };
  const run = createPipeline(yaml, { registry });
  const out = await run();
  assert.equal(typeof out, "object");
  assert.ok(String(out.completion).startsWith("Y:"));
});

test("runs a simple set/llm/output pipeline", async () => {
  const spec = {
    steps: [
      { type: "set", var: "poem.topic", value: "rain" },
      { type: "set", var: "prompt", value: "Write a poem about {{poem.topic}}." },
      { type: "llm", model: "demo", from: "prompt", var: "completion" },
      { type: "output", pick: ["completion"] },
    ],
  };
  const registry = {
    models: {
      demo: async ({ prompt }) => `OK:${prompt}`,
    },
  };

  const run = createPipeline(spec, { registry });
  const out = await run();
  assert.equal(typeof out, "object");
  assert.equal(out.completion.startsWith("OK:"), true);
});

test("withSignal aborts pipeline promptly", async () => {
  const spec = { steps: [{ type: "llm", model: "slow", prompt: "X" }] };

  const registry = {
    models: {
      slow: async ({ signal }) => {
        await Promise.race([
          sleep(1000),
          new Promise((_, rej) =>
            signal.addEventListener("abort", () => rej(new Error("aborted")), {
              once: true,
            }),
          ),
        ]);
        return "never";
      },
    },
  };

  const run = createPipeline(spec, { registry });
  const c = new AbortController();
  const bound = run.withSignal(c.signal);
  const p = bound();
  c.abort();
  await assert.rejects(p, (e) => isPipelineCancelled(e));
});

test("overall timeout rejects with PipelineTimeout", async () => {
  const spec = { steps: [{ type: "llm", model: "slow", prompt: "X" }] };
  const registry = {
    models: {
      slow: async () => {
        await sleep(100);
        return "SLOW";
      },
    },
  };
  const run = createPipeline(spec, { registry, overallTimeoutMs: 10 });
  await assert.rejects(run(), (e) => isPipelineTimeout(e));
});

test("perStepTimeout aborts slow llm step allowing pipeline to fail", async () => {
  const spec = {
    steps: [{ type: "llm", model: "slow", prompt: "X" }, { type: "output" }],
  };
  const registry = {
    models: {
      slow: async ({ signal }) => {
        await Promise.race([
          sleep(1000),
          new Promise((_, rej) =>
            signal.addEventListener("abort", () => rej(new Error("aborted")), {
              once: true,
            }),
          ),
        ]);
        return "never";
      },
    },
  };
  const run = createPipeline(spec, { registry, perStepTimeoutMs: 10 });
  await assert.rejects(run());
});

test("if/then/else executes correct branch", async () => {
  const spec = {
    steps: [
      { type: "set", var: "user.admin", value: true },
      {
        type: "if",
        when: "{{user.admin}}",
        then: [{ type: "set", var: "role", value: "admin" }],
        else: [{ type: "set", var: "role", value: "guest" }],
      },
      { type: "output", pick: "role" },
    ],
  };
  const run = createPipeline(spec, {});
  const out = await run();
  assert.equal(out, "admin");
});

test("foreach sets loop variable and runs body", async () => {
  const spec = {
    steps: [
      { type: "set", var: "items", value: [1, 2, 3] },
      {
        type: "foreach",
        in: "items",
        as: "x",
        steps: [{ type: "set", var: "last", value: "x:{{x}}" }],
      },
      { type: "output", pick: "last" },
    ],
  };
  const run = createPipeline(spec, {});
  const out = await run();
  assert.equal(out, "x:3");
});

test("parallel runs branches on child contexts and aggregates results", async () => {
  const spec = {
    steps: [
      {
        type: "parallel",
        var: "arr",
        branches: [
          {
            steps: [
              { type: "set", var: "v", value: "A" },
              { type: "output", pick: "v" },
            ],
          },
          {
            steps: [
              { type: "set", var: "v", value: "B" },
              { type: "output", pick: "v" },
            ],
          },
        ],
      },
      { type: "output", pick: "arr" },
    ],
  };
  const run = createPipeline(spec, {});
  const out = await run();
  assert.deepEqual(out, ["A", "B"]);
});

test("parallel with allSettled collects results and reasons", async () => {
  const spec = {
    steps: [
      {
        type: "parallel",
        var: "arr",
        mode: "allSettled",
        branches: [
          {
            steps: [
              { type: "set", var: "v", value: "A" },
              { type: "output", pick: "v" },
            ],
          },
          { steps: [{ type: "llm", model: "fail", prompt: "X" }] },
        ],
      },
      { type: "output", pick: "arr" },
    ],
  };
  const registry = {
    models: {
      fail: async () => {
        throw new Error("fail");
      },
    },
  };
  const run = createPipeline(spec, { registry });
  const out = await run();
  assert.equal(out[0].status, "fulfilled");
  assert.equal(out[0].value, "A");
  assert.equal(out[1].status, "rejected");
  assert.equal(out[1].reason instanceof Error, true);
});

test("llm.from reads prompt directly from context", async () => {
  const registry = {
    models: {
      echo: async ({ prompt }) => `E:${prompt}`,
    },
  };
  const spec = {
    steps: [
      { type: "set", var: "prompt", value: "Hello" },
      { type: "llm", model: "echo", from: "prompt", var: "out" },
      { type: "output", pick: "out" },
    ],
  };
  const run = createPipeline(spec, { registry });
  const out = await run();
  assert.equal(out, "E:Hello");
});

test("output.value returns literal and templated values", async () => {
  const spec1 = { steps: [{ type: "output", value: 123 }] };
  const run1 = createPipeline(spec1, {});
  const out1 = await run1();
  assert.equal(out1, 123);

  const spec2 = {
    steps: [
      { type: "set", var: "x", value: "Z" },
      { type: "output", value: "val:{{x}}" },
    ],
  };
  const run2 = createPipeline(spec2, {});
  const out2 = await run2();
  assert.equal(out2, "val:Z");
});

test("output.pick supports object mapping with aliases and literals", async () => {
  const spec = {
    steps: [
      { type: "set", var: "x", value: 1 },
      { type: "set", var: "y", value: 2 },
      { type: "output", pick: { a: "x", b: "y", c: 3 } },
    ],
  };
  const run = createPipeline(spec, {});
  const out = await run();
  assert.deepEqual(out, { a: 1, b: 2, c: 3 });
});

test("foreach alias works and accepts index alias", async () => {
  const spec = {
    steps: [
      { type: "set", var: "items", value: ["a", "b", "c"] },
      {
        type: "foreach",
        in: "items",
        as: "it",
        index: "i",
        steps: [{ type: "set", var: "last", value: "{{i}}:{{it}}" }],
      },
      { type: "output", pick: "last" },
    ],
  };
  const run = createPipeline(spec, {});
  const out = await run();
  assert.equal(out, "2:c");
});

test("template escaping with quadruple braces via set", async () => {
  const spec = {
    steps: [
      { type: "set", var: "x", value: 1 },
      {
        type: "set",
        var: "t",
        value: "literal {{{{not-var}}}} and value {{x}}",
      },
      { type: "output", pick: "t" },
    ],
  };
  const run = createPipeline(spec, {});
  const out = await run();
  assert.equal(out, "literal {{not-var}} and value 1");
});

test("YAML parser supports inline object map", async () => {
  const yaml = `
steps:
  - type: set
    var: obj
    value: { a: 1, b: "x" }
  - type: set
    var: s
    value: {{obj.a}}-{{obj.b}}
  - type: output
    pick: s
`;
  const run = createPipeline(yaml, {});
  const out = await run();
  assert.equal(out, "1-x");
});

test("YAML parser supports inline arrays and trailing comments", async () => {
  const yaml = `
steps:
  - type: set
    var: items
    value: [1, "x", true] # comment after value
  - type: foreach
    in: items
    as: it
    steps:
      - type: set
        var: last
        value: {{it}}
  - type: output
    pick: last
`;
  const run = createPipeline(yaml, {});
  const out = await run();
  assert.equal(out, "true");
});

test("perStepTimeout cancels nested branches in parallel", async () => {
  let aAborted = false;
  let bAborted = false;
  const spec = {
    steps: [
      {
        type: "parallel",
        var: "arr",
        branches: [
          { steps: [{ type: "llm", model: "slowA", prompt: "x" }] },
          { steps: [{ type: "llm", model: "slowB", prompt: "y" }] },
        ],
      },
    ],
  };
  const registry = {
    models: {
      slowA: async ({ signal }) => {
        signal.addEventListener(
          "abort",
          () => {
            aAborted = true;
          },
          { once: true },
        );
        await new Promise((resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
        return "A";
      },
      slowB: async ({ signal }) => {
        signal.addEventListener(
          "abort",
          () => {
            bAborted = true;
          },
          { once: true },
        );
        await new Promise((resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
        return "B";
      },
    },
  };
  const run = createPipeline(spec, { registry, perStepTimeoutMs: 10 });
  await assert.rejects(run(), (e) => isPipelineCancelled(e));
  await sleep(0);
  assert.equal(aAborted, true);
  assert.equal(bAborted, true);
});

test("parent abort cancels nested branches in parallel", async () => {
  let aAborted = false;
  let bAborted = false;
  const spec = {
    steps: [
      {
        type: "parallel",
        branches: [
          { steps: [{ type: "llm", model: "slowA", prompt: "x" }] },
          { steps: [{ type: "llm", model: "slowB", prompt: "y" }] },
        ],
      },
    ],
  };
  const registry = {
    models: {
      slowA: async ({ signal }) => {
        signal.addEventListener(
          "abort",
          () => {
            aAborted = true;
          },
          { once: true },
        );
        await Promise.race([
          sleep(1000),
          new Promise((_, rej) =>
            signal.addEventListener("abort", () => rej(new Error("aborted")), {
              once: true,
            }),
          ),
        ]);
        return "A";
      },
      slowB: async ({ signal }) => {
        signal.addEventListener(
          "abort",
          () => {
            bAborted = true;
          },
          { once: true },
        );
        await Promise.race([
          sleep(1000),
          new Promise((_, rej) =>
            signal.addEventListener("abort", () => rej(new Error("aborted")), {
              once: true,
            }),
          ),
        ]);
        return "B";
      },
    },
  };
  const run = createPipeline(spec, { registry });
  const controller = new AbortController();
  const bound = run.withSignal(controller.signal);
  const p = bound();
  await sleep(20);
  controller.abort();
  await assert.rejects(p, (e) => isPipelineCancelled(e));
  await sleep(0);
  assert.equal(aAborted, true);
  assert.equal(bAborted, true);
});

test("perStepTimeout throws PipelineStepTimeout when enabled", async () => {
  const spec = { steps: [{ type: "llm", model: "slow", prompt: "X" }] };
  const registry = {
    models: {
      slow: async ({ signal }) => {
        await Promise.race([
          new Promise((r) => setTimeout(r, 1000)),
          new Promise((_, rej) =>
            signal.addEventListener("abort", () => rej(new Error("aborted")), {
              once: true,
            }),
          ),
        ]);
        return "never";
      },
    },
  };
  const run = createPipeline(spec, {
    registry,
    perStepTimeoutMs: 10,
    stepTimeoutError: true,
  });
  await assert.rejects(run(), (e) => isPipelineStepTimeout(e));
});

test("foreach.in must point to an array when present", async () => {
  const spec = {
    steps: [
      { type: "set", var: "obj", value: { a: 1 } },
      { type: "foreach", in: "obj", as: "x", steps: [] },
    ],
  };
  const run = createPipeline(spec, {});
  await assert.rejects(
    run(),
    (e) =>
      isPipelineValidation(e) && String(e.message || "").includes("foreach.in"),
  );
});

test("cancel() triggers onError and returns true/false appropriately", async () => {
  const spec = { steps: [{ type: "llm", model: "slow", prompt: "X" }] };
  let onErrorCalled = 0;
  const hooks = {
    onError: () => {
      onErrorCalled++;
    },
  };
  const registry = {
    models: {
      slow: async ({ signal }) => {
        await Promise.race([
          new Promise((r) => setTimeout(r, 1000)),
          new Promise((_, rej) =>
            signal.addEventListener("abort", () => rej(new Error("aborted")), {
              once: true,
            }),
          ),
        ]);
        return "never";
      },
    },
  };
  const { promise, cancel } = createPipeline(spec, { registry, hooks }).start();
  const first = cancel();
  const second = cancel();
  assert.equal(first, true);
  assert.equal(second, false);
  await assert.rejects(promise, (e) => isPipelineCancelled(e));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(onErrorCalled > 0, true);
});

test("output is disallowed in nested if branch", async () => {
  const spec = {
    steps: [
      { type: "set", var: "x", value: 1 },
      { type: "if", when: true, then: [{ type: "output", pick: "x" }] },
      { type: "output", pick: "x" },
    ],
  };
  const run = createPipeline(spec, {});
  await assert.rejects(run(), (e) =>
    String((e && e.message) || "").includes("output not allowed"),
  );
});

test("unknown model throws PipelineValidationError", async () => {
  const spec = { steps: [{ type: "llm", model: "nope", prompt: "x" }] };
  const run = createPipeline(spec, {});
  await assert.rejects(run(), (e) => isPipelineValidation(e));
});

test("path safety blocks dangerous keys", async () => {
  for (const bad of ["__proto__.x", "a.constructor.b", "a.prototype.c"]) {
    const spec = { steps: [{ type: "set", var: bad, value: 1 }] };
    const run = createPipeline(spec, {});
    await assert.rejects(
      run(),
      (e) =>
        isPipelineValidation(e) &&
        String(e.message || "").includes("invalid path segment"),
    );
  }
});

test("params are templated recursively before calling model", async () => {
  let seen;
  const registry = {
    models: {
      echo: async ({ prompt, params }) => {
        seen = { prompt, params };
        return String(prompt);
      },
    },
  };
  const spec = {
    steps: [
      { type: "set", var: "user.name", value: "Bob" },
      {
        type: "llm",
        model: "echo",
        prompt: "{{user.name}}",
        params: { greet: "hi {{user.name}}", nested: { v: "{{user.name}}" } },
        var: "out",
      },
      { type: "output", pick: "out" },
    ],
  };
  const run = createPipeline(spec, { registry });
  const out = await run();
  assert.equal(out, "Bob");
  assert.equal(seen.params.greet, "hi Bob");
  assert.equal(seen.params.nested.v, "Bob");
});

test("output without pick returns full context", async () => {
  const spec = {
    steps: [
      { type: "set", var: "x", value: 1 },
      { type: "set", var: "y", value: 2 },
      { type: "output" },
    ],
  };
  const run = createPipeline(spec, {});
  const out = await run();
  assert.equal(out.x, 1);
  assert.equal(out.y, 2);
});

test("hooks onStepStart/Finish are called", async () => {
  const events = [];
  const hooks = {
    onStart: () => events.push("start"),
    onFinish: () => events.push("finish"),
    onStepStart: ({ stepIndex }) => events.push(`s${stepIndex}:start`),
    onStepFinish: ({ stepIndex }) => events.push(`s${stepIndex}:finish`),
  };
  const spec = {
    steps: [
      { type: "set", var: "a", value: 1 },
      { type: "set", var: "b", value: "{{a}}" },
      { type: "output", pick: "b" },
    ],
  };
  const run = createPipeline(spec, { hooks });
  const out = await run();
  assert.equal(out, "1");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(events.includes("start"), true);
  assert.equal(events.includes("finish"), true);
  assert.equal(
    events.some((e) => e.endsWith(":start")),
    true,
  );
  assert.equal(
    events.some((e) => e.endsWith(":finish")),
    true,
  );
});

test("custom step handler assigns var and can sleep", async () => {
  const stepHandlers = {
    wait: async ({ sleep }) => {
      await sleep(1);
      return "ok";
    },
  };
  const spec = {
    steps: [
      { type: "wait", var: "res" },
      { type: "output", pick: "res" },
    ],
  };
  const run = createPipeline(spec, { stepHandlers });
  const out = await run();
  assert.equal(out, "ok");
});

test("parallel.result=value collects only explicit outputs", async () => {
  const spec = {
    steps: [
      {
        type: "parallel",
        var: "arr",
        result: "value",
        branches: [
          {
            steps: [
              { type: "set", var: "v", value: "A" },
              { type: "output", pick: "v" },
            ],
          },
          {
            steps: [
              { type: "set", var: "v", value: "B" },
              // no output: should become undefined under result=value
            ],
          },
        ],
      },
      { type: "output", pick: "arr" },
    ],
  };
  const run = createPipeline(spec, {});
  const out = await run();
  assert.deepEqual(out, ["A", undefined]);
});

test("foreach scoped restores variables and index", async () => {
  const spec = {
    steps: [
      { type: "set", var: "x", value: "orig" },
      { type: "set", var: "items", value: [1, 2] },
      {
        type: "foreach",
        in: "items",
        as: "x",
        index: "i",
        scoped: true,
        steps: [{ type: "set", var: "last", value: "{{x}}-{{i}}" }],
      },
      { type: "output", pick: ["x", "last"] },
    ],
  };
  const run = createPipeline(spec, {});
  const out = await run();
  assert.equal(out.x, "orig");
  assert.equal(out.last, "2-1");
});

test("if.whenVar executes else branch when falsey", async () => {
  const spec = {
    steps: [
      { type: "set", var: "flag", value: false },
      {
        type: "if",
        whenVar: "flag",
        then: [{ type: "set", var: "v", value: "yes" }],
        else: [{ type: "set", var: "v", value: "no" }],
      },
      { type: "output", pick: "v" },
    ],
  };
  const run = createPipeline(spec, {});
  const out = await run();
  assert.equal(out, "no");
});

test("error annotations include stepIndex/type/name", async () => {
  const registry = {
    models: {
      fail: async () => {
        throw new Error("fail");
      },
    },
  };
  const spec = {
    steps: [{ type: "llm", name: "test_failure", model: "fail", prompt: "x" }],
  };
  const run = createPipeline(spec, { registry });
  await assert.rejects(
    run(),
    (e) =>
      e &&
      e.stepIndex === 0 &&
      e.stepType === "llm" &&
      e.stepName === "test_failure",
  );
});

test("YAML parser: indentation error throws validation error", () => {
  const bad = `steps:\n - type: set\n  var: x\n  value: 1`;
  assert.throws(
    () => createPipeline(bad, {}),
    (e) => isPipelineValidation(e),
  );
});

test("startWithSignal cancel cancels the run", async () => {
  const spec = { steps: [{ type: "llm", model: "slow", prompt: "X" }] };
  const registry = {
    models: {
      slow: async ({ signal }) => {
        await Promise.race([
          new Promise((r) => setTimeout(r, 1000)),
          new Promise((_, rej) =>
            signal.addEventListener("abort", () => rej(new Error("aborted")), {
              once: true,
            }),
          ),
        ]);
        return "never";
      },
    },
  };
  const ctrl = new AbortController();
  const { promise, cancel } = createPipeline(spec, {
    registry,
  }).startWithSignal(ctrl.signal);
  const first = cancel();
  assert.equal(first, true);
  await assert.rejects(promise, (e) => isPipelineCancelled(e));
});

test("overall timeout aborts in-flight model", async () => {
  let aborted = false;
  const registry = {
    models: {
      slow: async ({ signal }) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        await sleep(50);
        return "SLOW";
      },
    },
  };
  const run = createPipeline(
    { steps: [{ type: "llm", model: "slow", prompt: "x" }] },
    { registry, overallTimeoutMs: 10 },
  );
  await assert.rejects(run(), (e) => isPipelineTimeout(e));
  await sleep(0);
  assert.equal(aborted, true);
});

test("if uses user-friendly truthiness ('false'/'0' => false)", async () => {
  const spec = {
    steps: [
      { type: "set", var: "a", value: "false" },
      {
        type: "if",
        when: "{{a}}",
        then: [{ type: "set", var: "v", value: "yes" }],
        else: [{ type: "set", var: "v", value: "no" }],
      },
      { type: "set", var: "b", value: "0" },
      {
        type: "if",
        when: "{{b}}",
        then: [{ type: "set", var: "v2", value: "yes" }],
        else: [{ type: "set", var: "v2", value: "no" }],
      },
      { type: "set", var: "c", value: "true" },
      {
        type: "if",
        when: "{{c}}",
        then: [{ type: "set", var: "v3", value: "yes" }],
        else: [{ type: "set", var: "v3", value: "no" }],
      },
      { type: "output", pick: ["v", "v2", "v3"] },
    ],
  };
  const run = createPipeline(spec, {});
  const out = await run();
  assert.equal(out.v, "no");
  assert.equal(out.v2, "no");
  assert.equal(out.v3, "yes");
});

test("parallel early rejection aborts sibling branch", async () => {
  let slowAborted = false;
  const registry = {
    models: {
      fail: async () => {
        throw new Error("fail");
      },
      slow: async ({ signal }) => {
        signal.addEventListener(
          "abort",
          () => {
            slowAborted = true;
          },
          { once: true },
        );
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
        return "never";
      },
    },
  };
  const spec = {
    steps: [
      {
        type: "parallel",
        branches: [
          { steps: [{ type: "llm", model: "fail", prompt: "x" }] },
          { steps: [{ type: "llm", model: "slow", prompt: "y" }] },
        ],
      },
    ],
  };
  const run = createPipeline(spec, { registry });
  await assert.rejects(run());
  await sleep(0);
  assert.equal(slowAborted, true);
});

test("invalid if/foreach shapes throw validation", async () => {
  const spec1 = { steps: [{ type: "if", when: true, then: { nope: 1 } }] };
  const run1 = createPipeline(spec1, {});
  await assert.rejects(run1(), (e) => isPipelineValidation(e));

  const spec2 = {
    steps: [{ type: "foreach", in: "items", steps: { nope: 1 } }],
  };
  const run2 = createPipeline(spec2, {});
  await assert.rejects(run2(), (e) => isPipelineValidation(e));
});

test("perStepTimeout default throws PipelineCancelled", async () => {
  const registry = {
    models: {
      slow: async ({ signal }) => {
        await Promise.race([
          new Promise((r) => setTimeout(r, 500)),
          new Promise((_, rej) =>
            signal.addEventListener("abort", () => rej(new Error("aborted")), {
              once: true,
            }),
          ),
        ]);
        return "never";
      },
    },
  };
  const spec = { steps: [{ type: "llm", model: "slow", prompt: "x" }] };
  const run = createPipeline(spec, { registry, perStepTimeoutMs: 10 });
  await assert.rejects(run(), (e) => isPipelineCancelled(e));
});

test("parallel allSettled returns child context when no output in branch", async () => {
  const spec = {
    steps: [
      {
        type: "parallel",
        mode: "allSettled",
        var: "arr",
        branches: [
          { steps: [{ type: "set", var: "x", value: 1 }] },
          { steps: [{ type: "set", var: "y", value: 2 }] },
        ],
      },
      { type: "output", pick: "arr" },
    ],
  };
  const run = createPipeline(spec, {});
  const out = await run();
  assert.equal(out[0].status, "fulfilled");
  assert.equal(typeof out[0].value, "object");
  assert.equal(out[0].value.x, 1);
  assert.equal(out[1].value.y, 2);
});

test("parallel uses cloneContext for each branch", async () => {
  let calls = 0;
  const cloneContext = (ctx) => {
    calls++;
    return JSON.parse(JSON.stringify(ctx));
  };
  const spec = {
    steps: [
      { type: "set", var: "x", value: 1 },
      { type: "parallel", branches: [{ steps: [] }, { steps: [] }] },
      { type: "output" },
    ],
  };
  const run = createPipeline(spec, { cloneContext });
  const out = await run();
  assert.equal(out.x, 1);
  assert.equal(calls >= 2, true);
});

test("YAML parser: parallel aggregates branch outputs", async () => {
  const yaml = `
steps:
  - type: parallel
    var: arr
    branches:
      - steps:
          - type: set
            var: v
            value: A
          - type: output
            pick: v
      - steps:
          - type: set
            var: v
            value: B
          - type: output
            pick: v
  - type: output
    pick: arr
`;
  const run = createPipeline(yaml, {});
  const out = await run();
  assert.deepEqual(out, ["A", "B"]);
});

test("YAML parser: parallel allSettled aggregates results", async () => {
  const yaml = `
steps:
  - type: parallel
    mode: allSettled
    var: arr
    branches:
      - steps:
          - type: set
            var: v
            value: C
          - type: output
            pick: v
      - steps:
          - type: llm
            model: fail
            prompt: X
  - type: output
    pick: arr
`;
  const registry = {
    models: {
      fail: async () => {
        throw new Error("fail");
      },
    },
  };
  const run = createPipeline(yaml, { registry });
  const out = await run();
  assert.equal(out[0].status, "fulfilled");
  assert.equal(out[0].value, "C");
  assert.equal(out[1].status, "rejected");
  assert.equal(out[1].reason instanceof Error, true);
});

test("YAML parser: loop works with YAML sequence items", async () => {
  const yaml = `
steps:
  - type: set
    var: items
    value:
      - a
      - b
      - c
  - type: foreach
    in: items
    as: x
    index: i
    scoped: true
    steps:
      - type: set
        var: last
        value: "{{i}}:{{x}}"
  - type: output
    pick: last
`;
  const run = createPipeline(yaml, {});
  const out = await run();
  assert.equal(out, "2:c");
});

test("YAML parser: inline arrays work for foreach", async () => {
  const yaml = `
steps:
  - type: set
    var: items
    value: [a, b, c]
  - type: foreach
    in: items
    as: x
    steps:
      - type: set
        var: last
        value: {{x}}
  - type: output
    pick: last
`;
  const run = createPipeline(yaml, {});
  const out = await run();
  assert.equal(out, "c");
});

test("retry on error succeeds after transient failures", async () => {
  let attempts = 0;
  const registry = {
    models: {
      flaky: async ({ prompt }) => {
        attempts++;
        if (attempts < 3) throw new Error("transient");
        return `OK:${prompt}`;
      },
    },
  };
  const spec = {
    steps: [
      { type: "set", var: "x", value: "hi" },
      {
        type: "llm",
        model: "flaky",
        prompt: "{{x}}",
        retry: { retries: 3, backoffMs: 1, jitter: 0, on: "error" },
        var: "out",
      },
      { type: "output", pick: "out" },
    ],
  };
  const run = createPipeline(spec, { registry });
  const out = await run();
  assert.equal(out, "OK:hi");
  assert.equal(attempts >= 3, true);
});

test("parallel race mode resolves first and aborts others", async () => {
  let slowAborted = false;
  const registry = {
    models: {
      fast: async () => {
        return "A";
      },
      slow: async ({ signal }) => {
        signal.addEventListener(
          "abort",
          () => {
            slowAborted = true;
          },
          { once: true },
        );
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
        return "never";
      },
    },
  };
  const spec = {
    steps: [
      {
        type: "parallel",
        mode: "race",
        concurrency: 2,
        var: "first",
        branches: [
          {
            steps: [
              { type: "set", var: "v", value: "A" },
              { type: "output", pick: "v" },
            ],
          },
          { steps: [{ type: "llm", model: "slow", prompt: "y" }] },
        ],
      },
      { type: "output", pick: "first" },
    ],
  };
  const run = createPipeline(spec, { registry });
  const out = await run();
  assert.equal(out, "A");
  await sleep(0);
  assert.equal(slowAborted, true);
});

test("parallel race handles zero branches", async () => {
  const spec = {
    steps: [
      { type: "parallel", mode: "race", var: "first", branches: [] },
      { type: "output", pick: "first" },
    ],
  };
  const run = createPipeline(spec, {});
  const out = await run();
  assert.equal(out, undefined);
});

test("parallel all/allSettled handle zero branches as []", async () => {
  for (const mode of [undefined, "allSettled"]) {
    const spec = {
      steps: [
        { type: "parallel", mode, var: "arr", branches: [] },
        { type: "output", pick: "arr" },
      ],
    };
    const run = createPipeline(spec, {});
    const out = await run();
    assert.deepEqual(out, []);
  }
});

test("llm.from missing path throws validation error", async () => {
  const registry = { models: { echo: async ({ prompt }) => prompt } };
  const spec = {
    steps: [
      { type: "llm", model: "echo", from: "missing", var: "v" },
      { type: "output", pick: "v" },
    ],
  };
  const run = createPipeline(spec, { registry });
  await assert.rejects(run(), (e) => isPipelineValidation(e));
});

test("parallel race returns output of winning branch", async () => {
  let slowAborted = false;
  const spec = {
    steps: [
      {
        type: "parallel",
        mode: "race",
        concurrency: 2,
        var: "first",
        branches: [
          {
            steps: [
              { type: "set", var: "v", value: "A" },
              { type: "output", pick: "v" },
            ],
          },
          {
            steps: [{ type: "llm", model: "slow", prompt: "y" }],
          },
        ],
      },
      { type: "output", pick: "first" },
    ],
  };
  const registry = {
    models: {
      slow: async ({ signal }) => {
        signal.addEventListener(
          "abort",
          () => {
            slowAborted = true;
          },
          { once: true },
        );
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
        return "never";
      },
    },
  };
  const run = createPipeline(spec, { registry });
  const out = await run();
  assert.equal(out, "A");
  await sleep(0);
  assert.equal(slowAborted, true);
});

test("parallel allSettled honors concurrency and preserves result statuses", async () => {
  const registry = {
    models: {
      fail: async () => {
        throw new Error("fail");
      },
    },
  };
  const spec = {
    steps: [
      {
        type: "parallel",
        mode: "allSettled",
        concurrency: 1,
        var: "arr",
        branches: [
          {
            steps: [
              { type: "set", var: "v", value: "X" },
              { type: "output", pick: "v" },
            ],
          },
          { steps: [{ type: "llm", model: "fail", prompt: "x" }] },
        ],
      },
      { type: "output", pick: "arr" },
    ],
  };
  const run = createPipeline(spec, { registry });
  const out = await run();
  assert.equal(out[0].status, "fulfilled");
  assert.equal(out[0].value, "X");
  assert.equal(out[1].status, "rejected");
  assert.equal(out[1].reason instanceof Error, true);
});
