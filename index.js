export class PipelineCancelled extends Error {
  constructor(message = "pipeline cancelled") {
    super(message);
    this.name = "PipelineCancelled";
    this.code = "E_PIPELINE_CANCELLED";
  }
}

export class PipelineTimeout extends Error {
  constructor(message = "pipeline timed out") {
    super(message);
    this.name = "PipelineTimeout";
    this.code = "E_PIPELINE_TIMEOUT";
  }
}

export class PipelineValidationError extends Error {
  constructor(message = "invalid pipeline") {
    super(message);
    this.name = "PipelineValidationError";
    this.code = "E_PIPELINE_VALIDATION";
  }
}

export class PipelineStepTimeout extends Error {
  constructor(message = "step timed out") {
    super(message);
    this.name = "PipelineStepTimeout";
    this.code = "E_PIPELINE_STEP_TIMEOUT";
  }
}

export default function createPipeline(source, options = {}) {
  const parseYAML =
    typeof options.parseYAML === "function" ? options.parseYAML : parseYamlish;
  const registry =
    options.registry && typeof options.registry === "object"
      ? options.registry
      : {};
  const models =
    registry.models && typeof registry.models === "object"
      ? registry.models
      : {};
  const perStepTimeoutMs = clampOptionalNum(
    options.perStepTimeoutMs,
    1,
    3_600_000,
  );
  const overallTimeoutMs = clampOptionalNum(
    options.overallTimeoutMs,
    1,
    3_600_000,
  );
  const defaultParentSignal = options.parentSignal;
  const useStepTimeoutError = options.stepTimeoutError === true;
  const stepHandlers =
    options.stepHandlers && typeof options.stepHandlers === "object"
      ? options.stepHandlers
      : undefined;
  const hooks =
    options.hooks && typeof options.hooks === "object"
      ? options.hooks
      : undefined;
  const cloneContext =
    typeof options.cloneContext === "function"
      ? options.cloneContext
      : defaultCloneContext;

  let spec;
  if (typeof source === "string") spec = parseYAML(source);
  else if (source && typeof source === "object") spec = source;
  else
    throw new PipelineValidationError("source must be YAML string or object");

  validateSpec(spec);

  function startInternal(parentSignal, initialContext = {}) {
    const controllers = [];
    const parentAbortRemovers = new Map();
    const stepTimeoutTimers = new Set();
    const stepTimeoutReasons = new WeakMap();
    const sleepWithSignal = createSleepWithSignalFactory(stepTimeoutReasons);
    let overallTimer;
    let settled = false;
    let resolvePromise;
    let rejectPromise;
    let removeAggregateParentAbort;

    function newController(extraParentSignal) {
      const c = new AbortController();
      controllers.push(c);
      const removers = [];
      function attachParent(sig) {
        if (!sig) return;
        if (sig.aborted) {
          try {
            c.abort();
          } catch {}
          return;
        }
        const forwardAbort = () => {
          try {
            c.abort();
          } catch {}
        };
        try {
          sig.addEventListener("abort", forwardAbort, { once: true });
        } catch {}
        removers.push(() => {
          try {
            sig.removeEventListener("abort", forwardAbort);
          } catch {}
        });
      }
      attachParent(parentSignal);
      attachParent(extraParentSignal);
      if (removers.length) parentAbortRemovers.set(c, removers);
      return c;
    }

    function cleanupController(controller) {
      const removeParents = parentAbortRemovers.get(controller);
      if (removeParents && Array.isArray(removeParents)) {
        for (const fn of removeParents) {
          try {
            fn();
          } catch {}
        }
        parentAbortRemovers.delete(controller);
      }
      const idx = controllers.indexOf(controller);
      if (idx >= 0) controllers.splice(idx, 1);
    }

    function abortAll() {
      for (const c of [...controllers]) {
        try {
          c.abort();
        } catch {}
        cleanupController(c);
      }
    }

    function clearAllTimers() {
      for (const t of stepTimeoutTimers) clearTimeout(t);
      if (overallTimer) clearTimeout(overallTimer);
    }

    function callHook(name, payload) {
      try {
        const fn = hooks && typeof hooks === "object" ? hooks[name] : undefined;
        if (typeof fn === "function") {
          Promise.resolve()
            .then(() => fn(payload))
            .catch(() => {});
        }
      } catch {}
    }

    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;

      if (parentSignal) {
        const onParentAbort = () => {
          if (settled) return;
          settled = true;
          abortAll();
          clearAllTimers();
          try {
            if (removeAggregateParentAbort) removeAggregateParentAbort();
          } catch {}
          removeAggregateParentAbort = undefined;
          callHook("onError", { error: new PipelineCancelled() });
          reject(new PipelineCancelled());
        };
        if (parentSignal.aborted) {
          onParentAbort();
          return;
        }
        parentSignal.addEventListener("abort", onParentAbort, { once: true });
        removeAggregateParentAbort = () => {
          try {
            parentSignal.removeEventListener("abort", onParentAbort);
          } catch {}
        };
      }

      if (overallTimeoutMs) {
        overallTimer = setTimeoutMaybeUnref(() => {
          if (settled) return;
          settled = true;
          abortAll();
          clearAllTimers();
          if (removeAggregateParentAbort) {
            try {
              removeAggregateParentAbort();
            } catch {}
            removeAggregateParentAbort = undefined;
          }
          callHook("onError", { error: new PipelineTimeout() });
          reject(new PipelineTimeout());
        }, overallTimeoutMs);
      }

      (async () => {
        try {
          callHook("onStart", { steps: spec.steps, initialContext });
          const out = await runSteps(spec.steps, initialContext, undefined);
          if (settled) return;
          settled = true;
          clearAllTimers();
          if (removeAggregateParentAbort) {
            try {
              removeAggregateParentAbort();
            } catch {}
            removeAggregateParentAbort = undefined;
          }
          callHook("onFinish", { result: out });
          resolve(out);
        } catch (err) {
          if (settled) return;
          settled = true;
          abortAll();
          clearAllTimers();
          if (removeAggregateParentAbort) {
            try {
              removeAggregateParentAbort();
            } catch {}
            removeAggregateParentAbort = undefined;
          }
          callHook("onError", { error: err });
          reject(err);
        }
      })();
    });

    async function runSteps(
      steps,
      ctx,
      runParentSignal,
      allowOutput = true,
      onOutput,
    ) {
      let context = { ...ctx };
      for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
        const step = steps[stepIndex];
        const controller = newController(runParentSignal);
        const stepSignal = controller.signal;
        let timer;
        const effectiveStepTimeoutMs =
          clampOptionalNum(step && step.timeoutMs, 1, 3_600_000) ??
          perStepTimeoutMs;
        if (effectiveStepTimeoutMs) {
          timer = setTimeoutMaybeUnref(() => {
            try {
              if (useStepTimeoutError)
                stepTimeoutReasons.set(stepSignal, new PipelineStepTimeout());
              controller.abort();
            } catch {}
          }, effectiveStepTimeoutMs);
          stepTimeoutTimers.add(timer);
        }
        let stepFailed = false;
        callHook("onStepStart", { step, stepIndex, context });
        let stepType;
        try {
          if (stepSignal.aborted)
            throw stepTimeoutReasons.get(stepSignal) || new PipelineCancelled();
          stepType = step && step.type;
          const handler =
            stepHandlers && typeof stepHandlers === "object"
              ? stepHandlers[stepType]
              : undefined;
          if (typeof handler === "function") {
            const invoke = async () =>
              handler({
                step,
                context,
                signal: stepSignal,
                get: (path) => getPath(context, path),
                set: (path, value) => setPath(context, path, value),
                runSteps: (innerSteps, childContext) =>
                  runSteps(innerSteps, childContext ?? context, stepSignal),
                sleep: (ms) => sleepWithSignal(ms, stepSignal),
                registry,
                models,
              });
            const result = await withRetry(invoke, step, stepSignal, {
              sleep: (ms) => sleepWithSignal(ms, stepSignal),
              classifyAbort: () => stepTimeoutReasons.get(stepSignal),
            });
            if (step.var && result !== undefined)
              setPath(context, step.var, result);
          } else if (stepType === "set") {
            const v = resolveValue(step.value, context);
            if (!step.var)
              throw new PipelineValidationError("set requires 'var'");
            setPath(context, step.var, v);
          } else if (stepType === "llm") {
            const modelName = step.model;
            if (!modelName || typeof modelName !== "string")
              throw new PipelineValidationError("llm requires string 'model'");
            const fn = models[modelName];
            if (typeof fn !== "function")
              throw new PipelineValidationError(`unknown model: ${modelName}`);
            let prompt;
            if (typeof step.from === "string" && step.from.trim()) {
              const fromVal = getPath(context, step.from);
              if (fromVal == null)
                throw new PipelineValidationError(
                  `llm.from path not found: ${step.from}`,
                );
              prompt = String(fromVal);
            } else if (Object.prototype.hasOwnProperty.call(step, "prompt")) {
              prompt = String(resolveTemplate(step.prompt, context));
            } else {
              throw new PipelineValidationError(
                "llm requires 'prompt' or 'from'",
              );
            }
            const params =
              step.params && typeof step.params === "object"
                ? resolveParams(step.params, context)
                : undefined;
            const invoke = async () =>
              fn({ prompt, params, signal: stepSignal, context });
            const res = await withRetry(invoke, step, stepSignal, {
              sleep: (ms) => sleepWithSignal(ms, stepSignal),
              classifyAbort: () => stepTimeoutReasons.get(stepSignal),
            });
            if (step.var) setPath(context, step.var, res);
          } else if (stepType === "output") {
            if (!allowOutput)
              throw new PipelineValidationError(
                "output not allowed in this context",
              );
            if (typeof onOutput === "function") {
              try {
                onOutput();
              } catch {}
            }
            if (Object.prototype.hasOwnProperty.call(step, "value")) {
              return resolveValue(step.value, context);
            }
            if (Array.isArray(step.pick)) {
              const out = {};
              for (const p of step.pick) out[p] = getPath(context, p);
              return out;
            }
            if (
              step.pick &&
              typeof step.pick === "object" &&
              !Array.isArray(step.pick)
            ) {
              const out = {};
              for (const k of Object.keys(step.pick)) {
                const p = step.pick[k];
                out[k] = typeof p === "string" ? getPath(context, p) : p;
              }
              return out;
            }
            if (typeof step.pick === "string")
              return getPath(context, step.pick);
            return context;
          } else if (stepType === "if") {
            if (
              !Object.prototype.hasOwnProperty.call(step, "when") &&
              typeof step.whenVar !== "string"
            ) {
              throw new PipelineValidationError(
                "if requires 'when' or 'whenVar'",
              );
            }
            if (
              Object.prototype.hasOwnProperty.call(step, "then") &&
              !Array.isArray(step.then)
            ) {
              throw new PipelineValidationError(
                "if.then must be an array of steps",
              );
            }
            if (
              Object.prototype.hasOwnProperty.call(step, "else") &&
              !Array.isArray(step.else)
            ) {
              throw new PipelineValidationError(
                "if.else must be an array of steps",
              );
            }
            const cond = evaluateWhen(step, context);
            const branch = cond ? step.then : step.else;
            if (Array.isArray(branch)) {
              context = await runSteps(
                branch,
                context,
                stepSignal,
                false,
                undefined,
              );
            }
          } else if (stepType === "foreach") {
            const path = step.in;
            if (!path || typeof path !== "string")
              throw new PipelineValidationError(
                "foreach requires 'in' (path string)",
              );
            const arr = getPath(context, path);
            if (arr != null && !Array.isArray(arr)) {
              throw new PipelineValidationError(
                `foreach.in must be an array path: ${path}`,
              );
            }
            const list = Array.isArray(arr) ? arr : [];
            const as =
              typeof step.as === "string" && step.as.trim() ? step.as : "item";
            const indexVar =
              typeof step.index === "string" ? step.index : undefined;
            if (!Array.isArray(step.steps))
              throw new PipelineValidationError(
                "foreach.steps must be an array of steps",
              );
            const body = step.steps;
            const scoped = step.scoped === true;
            const prevAsVal = scoped ? getPath(context, as) : undefined;
            const hadAs = scoped ? hasPath(context, as) : false;
            const prevIndexVal =
              scoped && indexVar ? getPath(context, indexVar) : undefined;
            const hadIndex =
              scoped && indexVar ? hasPath(context, indexVar) : false;
            for (let i = 0; i < list.length; i++) {
              setPath(context, as, list[i]);
              if (indexVar) setPath(context, indexVar, i);
              context = await runSteps(
                body,
                context,
                stepSignal,
                false,
                undefined,
              );
            }
            if (scoped) {
              if (hadAs) setPath(context, as, prevAsVal);
              else deletePath(context, as);
              if (indexVar) {
                if (hadIndex) setPath(context, indexVar, prevIndexVal);
                else deletePath(context, indexVar);
              }
            }
          } else if (stepType === "parallel") {
            if (!Array.isArray(step.branches))
              throw new PipelineValidationError(
                "parallel.branches must be an array",
              );
            const branches = step.branches;
            const outVar = step.var;
            const resultMode = step.result === "value" ? "value" : "context";
            const tasks = branches.map((b, i) => {
              if (!b || typeof b !== "object") return [];
              if (!Array.isArray(b.steps))
                throw new PipelineValidationError(
                  `parallel.branches[${i}].steps must be an array`,
                );
              return b.steps;
            });
            const mode = step.mode;
            const count = tasks.length;
            if (count === 0) {
              if (outVar) {
                if (mode === "allSettled") setPath(context, outVar, []);
                else if (mode === "race") setPath(context, outVar, undefined);
                else setPath(context, outVar, []);
              }
            } else if (mode === "allSettled") {
              const concurrency =
                clampOptionalNum(step.concurrency, 1, count) || count;
              const controllers = tasks.map(() => newController(stepSignal));
              const results = new Array(count);
              await runInPool(count, concurrency, async (i) => {
                const t = tasks[i];
                const child = cloneContext(context);
                try {
                  let usedOutput = false;
                  const r = await runSteps(
                    t,
                    child,
                    controllers[i].signal,
                    true,
                    () => {
                      usedOutput = true;
                    },
                  );
                  const v =
                    resultMode === "value" && !usedOutput ? undefined : r;
                  results[i] = { status: "fulfilled", value: v };
                } catch (e) {
                  results[i] = { status: "rejected", reason: e };
                }
              });
              if (outVar) setPath(context, outVar, results);
              controllers.forEach((c) => cleanupController(c));
            } else if (mode === "race") {
              const concurrency =
                clampOptionalNum(step.concurrency, 1, count) || count;
              const controllers = tasks.map(() => newController(stepSignal));
              let winner;
              await new Promise((resolve, reject) => {
                let active = 0;
                let idx = 0;
                const startNext = () => {
                  while (
                    active < concurrency &&
                    idx < count &&
                    winner === undefined
                  ) {
                    const i = idx++;
                    active++;
                    (async () => {
                      try {
                        const child = cloneContext(context);
                        let usedOutput = false;
                        const r = await runSteps(
                          tasks[i],
                          child,
                          controllers[i].signal,
                          true,
                          () => {
                            usedOutput = true;
                          },
                        );
                        if (winner === undefined) {
                          winner =
                            resultMode === "value" && !usedOutput
                              ? undefined
                              : r;
                          controllers.forEach((c, j) => {
                            if (j !== i) {
                              try {
                                c.abort();
                              } catch {}
                            }
                          });
                          resolve();
                        }
                      } catch (e) {
                        active--;
                        if (
                          active === 0 &&
                          idx >= count &&
                          winner === undefined
                        )
                          reject(e);
                        else startNext();
                      }
                    })();
                  }
                  if (active === 0 && idx >= count && winner === undefined) {
                    resolve();
                  }
                };
                startNext();
              });
              if (outVar) setPath(context, outVar, winner);
              controllers.forEach((c) => cleanupController(c));
            } else {
              const concurrency =
                clampOptionalNum(step.concurrency, 1, count) || count;
              const controllers = tasks.map(() => newController(stepSignal));
              try {
                const results = await runInPool(
                  count,
                  concurrency,
                  async (i) => {
                    const t = tasks[i];
                    const child = cloneContext(context);
                    let usedOutput = false;
                    const r = await runSteps(
                      t,
                      child,
                      controllers[i].signal,
                      true,
                      () => {
                        usedOutput = true;
                      },
                    );
                    return resultMode === "value" && !usedOutput
                      ? undefined
                      : r;
                  },
                );
                if (outVar) setPath(context, outVar, results);
              } catch (e) {
                controllers.forEach((c) => {
                  try {
                    c.abort();
                  } catch {}
                });
                throw e;
              } finally {
                controllers.forEach((c) => cleanupController(c));
              }
            }
          } else {
            throw new PipelineValidationError(`unknown step type: ${stepType}`);
          }
        } catch (err) {
          try {
            if (err && typeof err === "object") {
              if (!("stepIndex" in err)) err.stepIndex = stepIndex;
              if (!("stepType" in err)) err.stepType = stepType;
              if (
                !("stepName" in err) &&
                step &&
                typeof step === "object" &&
                typeof step.name === "string"
              )
                err.stepName = step.name;
            }
          } catch {}
          stepFailed = true;
          callHook("onStepError", { step, stepIndex, error: err, context });
          throw err;
        } finally {
          if (timer) {
            clearTimeout(timer);
            stepTimeoutTimers.delete(timer);
          }
          cleanupController(controller);
          if (!stepFailed)
            callHook("onStepFinish", { step, stepIndex, context });
        }
      }
      return context;
    }

    function cancel() {
      if (settled) return false;
      settled = true;
      abortAll();
      clearAllTimers();
      if (removeAggregateParentAbort) {
        try {
          removeAggregateParentAbort();
        } catch {}
        removeAggregateParentAbort = undefined;
      }
      callHook("onError", { error: new PipelineCancelled() });
      rejectPromise(new PipelineCancelled());
      return true;
    }

    return { promise, cancel };
  }

  function runOnce(initialContext) {
    return startInternal(defaultParentSignal, initialContext).promise;
  }

  function pipeline(initialContext) {
    return runOnce(initialContext);
  }

  pipeline.start = function start(initialContext) {
    return startInternal(defaultParentSignal, initialContext);
  };

  pipeline.withSignal = function withSignal(parentSignal) {
    return function withParent(initialContext) {
      return startInternal(parentSignal, initialContext).promise;
    };
  };

  pipeline.startWithSignal = function startWithSignal(
    parentSignal,
    initialContext,
  ) {
    return startInternal(parentSignal, initialContext);
  };

  return pipeline;
}

export async function validatePipeline(source, options = {}) {
  try {
    const userStepHandlers =
      options && typeof options.stepHandlers === "object"
        ? options.stepHandlers
        : undefined;
    const stepHandlers = {
      ...(userStepHandlers || {}),
      llm: async ({ step, set }) => {
        if (step && step.var) set(step.var, "");
        return undefined;
      },
    };
    const run = createPipeline(source, { ...options, stepHandlers });
    await run(options && options.initialContext ? options.initialContext : {});
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function evaluateWhen(step, ctx) {
  const coerce = truthy;
  if (Object.prototype.hasOwnProperty.call(step, "when")) {
    const v = step.when;
    if (typeof v === "string") {
      const s = String(resolveTemplate(v, ctx));
      return coerce(s);
    }
    return coerce(v);
  }
  if (typeof step.whenVar === "string") {
    return coerce(getPath(ctx, step.whenVar));
  }
  return false;
}

function truthy(v) {
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim();
  if (s === "" || s === "0" || s.toLowerCase() === "false") return false;
  return true;
}

function truthyStrict(v) {
  return !!v;
}

export function isPipelineCancelled(err) {
  return !!(
    err &&
    typeof err === "object" &&
    err.code === "E_PIPELINE_CANCELLED" &&
    err.name === "PipelineCancelled"
  );
}

export function isPipelineTimeout(err) {
  return !!(
    err &&
    typeof err === "object" &&
    err.code === "E_PIPELINE_TIMEOUT" &&
    err.name === "PipelineTimeout"
  );
}

export function isPipelineValidation(err) {
  return !!(
    err &&
    typeof err === "object" &&
    err.code === "E_PIPELINE_VALIDATION" &&
    err.name === "PipelineValidationError"
  );
}

export function isPipelineStepTimeout(err) {
  return !!(
    err &&
    typeof err === "object" &&
    err.code === "E_PIPELINE_STEP_TIMEOUT" &&
    err.name === "PipelineStepTimeout"
  );
}

export function renderTemplate(tpl, ctx) {
  return resolveTemplate(tpl, ctx);
}

export function defineRegistry(registry) {
  return registry;
}

function withRetry(invoke, step, signal, utils) {
  const retry = step && typeof step === "object" ? step.retry : undefined;
  const retries = Math.max(0, Number(retry && retry.retries) || 0);
  const backoffMs = Math.max(0, Number(retry && retry.backoffMs) || 0);
  const jitter = Math.min(1, Math.max(0, Number(retry && retry.jitter) || 0));
  const on = (retry && retry.on) || "any"; // any | error | timeout
  return (async () => {
    let attempt = 0;
    let lastErr;
    while (attempt <= retries) {
      if (signal && signal.aborted)
        throw utils.classifyAbort() || new PipelineCancelled();
      try {
        return await invoke();
      } catch (e) {
        lastErr = e;
        if (signal && signal.aborted) {
          const classified = utils.classifyAbort() || new PipelineCancelled();
          const isTimeout =
            classified && classified.name === "PipelineStepTimeout";
          const isCancel =
            classified && classified.name === "PipelineCancelled";
          if (isCancel) throw classified;
          if (!(on === "any" || (on === "timeout" && isTimeout)))
            throw classified;
        } else if (!(on === "any" || on === "error")) {
          throw e;
        }
        if (attempt === retries) break;
        const base = backoffMs * Math.max(1, attempt + 1);
        const delta = jitter ? Math.random() * base * jitter : 0;
        await utils.sleep(base + delta);
      }
      attempt++;
    }

    if (signal && signal.aborted) {
      throw utils.classifyAbort() || new PipelineCancelled();
    }
    throw lastErr;
  })();
}

function runInPool(count, concurrency, runOne) {
  return new Promise((resolve, reject) => {
    const results = new Array(count);
    let started = 0;
    let completed = 0;
    let rejected = false;
    const startNext = () => {
      while (
        started < count &&
        started - completed < concurrency &&
        !rejected
      ) {
        const i = started++;
        Promise.resolve()
          .then(() => runOne(i))
          .then((res) => {
            results[i] = res;
            completed++;
            if (completed === count) resolve(results);
            else startNext();
          })
          .catch((err) => {
            rejected = true;
            reject(err);
          });
      }
    };
    if (count === 0) resolve([]);
    else startNext();
  });
}

function validateSpec(spec) {
  if (!spec || typeof spec !== "object")
    throw new PipelineValidationError("spec must be an object");
  if (!Array.isArray(spec.steps))
    throw new PipelineValidationError("spec.steps must be an array");
}

function resolveValue(v, ctx) {
  if (typeof v === "string") return resolveTemplate(v, ctx);
  return v;
}

function resolveTemplate(tpl, ctx) {
  if (tpl == null) return "";
  let s = String(tpl);
  const PH_L = "\u0001L";
  const PH_R = "\u0001R";
  s = s.replace(/\{\{\{\{/g, PH_L).replace(/\}\}\}\}/g, PH_R);
  s = s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    const val = getPath(ctx, expr);
    return val == null ? "" : String(val);
  });
  return s
    .replace(new RegExp(PH_L, "g"), "{{")
    .replace(new RegExp(PH_R, "g"), "}}");
}

function resolveParams(obj, ctx) {
  if (obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => resolveParams(v, ctx));
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === "string") out[k] = resolveTemplate(v, ctx);
    else if (v && typeof v === "object") out[k] = resolveParams(v, ctx);
    else out[k] = v;
  }
  return out;
}

function getPath(obj, path) {
  const parts = splitAndValidatePath(path);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setPath(obj, path, value) {
  const parts = splitAndValidatePath(path);
  if (parts.length === 0) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function hasPath(obj, path) {
  const parts = splitAndValidatePath(path);
  if (parts.length === 0) return false;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur == null || typeof cur !== "object" || !(k in cur)) return false;
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  return !!(
    cur &&
    typeof cur === "object" &&
    Object.prototype.hasOwnProperty.call(cur, last)
  );
}

function deletePath(obj, path) {
  const parts = splitAndValidatePath(path);
  if (parts.length === 0) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur == null || typeof cur !== "object" || !(k in cur)) return;
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  try {
    delete cur[last];
  } catch {}
}

function splitAndValidatePath(path) {
  const parts = String(path)
    .split(".")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const seg of parts) {
    if (isBlockedKey(seg)) {
      throw new PipelineValidationError(`invalid path segment: ${seg}`);
    }
  }
  return parts;
}

function isBlockedKey(k) {
  return k === "__proto__" || k === "prototype" || k === "constructor";
}

function clampOptionalNum(value, min, max) {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, n));
}

function setTimeoutMaybeUnref(fn, delay) {
  const t = setTimeout(fn, delay);
  try {
    if (t && typeof t === "object" && typeof t.unref === "function") t.unref();
  } catch {}
  return t;
}

function parseYamlish(str) {
  if (typeof str !== "string")
    throw new PipelineValidationError("YAML source must be a string");
  const src = str.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = src.split(/\n/);
  const root = { type: "map", value: {} };
  const stack = [{ indent: -1, node: root }];
  let _nextLineIndex = 0;

  function current() {
    return stack[stack.length - 1];
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = line.match(/^(\s*)(.*)$/);
    const indent = m ? m[1].length : 0;
    const content = m ? m[2] : line;
    if (indent % 2 !== 0)
      throw new PipelineValidationError(
        `indent must be multiples of 2 at line ${i + 1}`,
      );

    while (stack.length && indent <= current().indent) stack.pop();
    const parent = current();
    if (!parent) throw new PipelineValidationError("invalid indentation");

    if (/^-\s*/.test(content)) {
      let itemStr = content.replace(/^-\s*?/, "");
      itemStr = stripInlineComment(itemStr);
      if (parent.node.type === "map") {
        const seqArr = [];
        if (typeof parent.assign === "function") parent.assign(seqArr);
        parent.node = { type: "seq", value: seqArr };
      }
      if (parent.node.type !== "seq") parent.node = { type: "seq", value: [] };
      const kv = itemStr.match(/^([^:#]+?):\s*(.*)$/);
      if (kv) {
        const key = kv[1].trim();
        const rest = kv[2];
        const obj = {};
        const scalar = parseScalarOrInlineMap(rest);
        if (scalar !== undefined) obj[key] = scalar;
        else obj[key] = {};
        parent.node.value.push({ type: "map", value: obj });
        stack.push({ indent, node: { type: "map", value: obj } });
        if (scalar === undefined) {
          // important: attach assign so nested list/map can replace obj[key]
          stack.push({
            indent,
            node: { type: "map", value: obj[key] },
            assign: (nv) => {
              obj[key] = nv;
            },
          });
        }
      } else {
        const val = parseScalarOrInlineMap(itemStr);
        if (val !== undefined) parent.node.value.push(val);
        else {
          const holder = { type: "map", value: {} };
          parent.node.value.push(holder);
          stack.push({ indent, node: holder });
        }
      }
    } else {
      const kv = content.match(/^([^:#]+?):\s*(.*)$/);
      if (!kv)
        throw new PipelineValidationError(
          `expected key: value at line ${i + 1}`,
        );
      const key = kv[1].trim();
      let rest = kv[2];
      rest = stripInlineComment(rest);
      if (parent.node.type === "seq") {
        const holder = { type: "map", value: {} };
        parent.node.value.push(holder);
        stack.push({ indent, node: holder });
        const mapNode = stack[stack.length - 1].node;
        if (rest.trim() === "|") {
          mapNode.value[key] = readBlock(i, indent + 2);
          i = _nextLineIndex - 1;
        } else {
          mapNode.value[key] = parseScalarOrInlineMap(rest);
        }
        if (rest === "" || rest == null) {
          mapNode.value[key] = {};
          stack.push({
            indent: indent + 2,
            node: { type: "map", value: mapNode.value[key] },
            assign: (nv) => {
              mapNode.value[key] = nv;
            },
          });
        }
      } else {
        if (parent.node.type !== "map")
          parent.node = { type: "map", value: {} };
        const map = parent.node.value;
        if (rest.trim() === "|") {
          map[key] = readBlock(i, indent + 2);
          i = _nextLineIndex - 1;
        } else {
          const scalar = parseScalarOrInlineMap(rest);
          if (scalar !== undefined) map[key] = scalar;
          else {
            const holderObj = {};
            map[key] = holderObj;
            stack.push({
              indent,
              node: { type: "map", value: holderObj },
              assign: (nv) => {
                map[key] = nv;
              },
            });
          }
        }
      }
    }
  }

  return deepUnwrap(root);

  function parseScalarOrInlineMap(s) {
    if (!s || !s.trim()) return undefined;
    const t = s.trim();
    if (/^\{[\s\S]*\}$/.test(t)) {
      try {
        return JSON.parse(t);
      } catch {}
      try {
        const normalized = t.replace(
          /([\{,]\s*)([A-Za-z_][A-Za-z0-9_\-]*?)\s*:/g,
          '$1"$2":',
        );
        return JSON.parse(normalized);
      } catch {}
    }
    if (/^\[[\s\S]*\]$/.test(t)) {
      try {
        return JSON.parse(t);
      } catch {}
      try {
        const inner = t.slice(1, -1);
        const parts = splitCSV(inner);
        return parts.map((p) => parseScalar(p));
      } catch {}
    }
    return parseScalar(s);
  }

  function parseScalar(s) {
    if (s == null) return undefined;
    const t = s.trim();
    if (t === "") return undefined;
    if (t === "null" || t === "~") return null;
    if (t === "true") return true;
    if (t === "false") return false;
    if (/^[-+]?[0-9]+(\.[0-9]+)?$/.test(t)) return Number(t);
    const m = t.match(/^(['"])(.*)\1$/);
    if (m) return m[2];
    return t;
  }

  function deepUnwrap(n) {
    if (n == null) return n;
    if (typeof n !== "object") return n;
    if (
      typeof n.type === "string" &&
      Object.prototype.hasOwnProperty.call(n, "value")
    ) {
      if (n.type === "map") return deepUnwrap(n.value);
      if (n.type === "seq")
        return Array.isArray(n.value)
          ? n.value.map(deepUnwrap)
          : deepUnwrap(n.value);
    }
    if (Array.isArray(n)) return n.map(deepUnwrap);
    const out = {};
    for (const k of Object.keys(n)) out[k] = deepUnwrap(n[k]);
    return out;
  }

  function readBlock(startIdx, baseIndent) {
    const parts = [];
    let j = startIdx + 1;
    for (; j < lines.length; j++) {
      const m2 = lines[j].match(/^(\s*)(.*)$/);
      const ind2 = m2 ? m2[1].length : 0;
      const body = m2 ? m2[2] : lines[j];
      if (body.trim() === "" && ind2 >= baseIndent) {
        parts.push("");
        continue;
      }
      if (ind2 < baseIndent) break;
      parts.push(lines[j].slice(baseIndent));
    }
    _nextLineIndex = j;
    return parts.join("\n");
  }

  function stripInlineComment(s) {
    if (!s) return s;
    let inS = false;
    let quote = "";
    let esc = false;
    let depthBrace = 0;
    let depthBracket = 0;
    for (let j = 0; j < s.length; j++) {
      const ch = s[j];
      if (inS) {
        if (esc) {
          esc = false;
        } else if (ch === "\\") {
          esc = true;
        } else if (ch === quote) {
          inS = false;
          quote = "";
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inS = true;
        quote = ch;
        continue;
      }
      if (ch === "{") depthBrace++;
      else if (ch === "}") depthBrace = Math.max(0, depthBrace - 1);
      else if (ch === "[") depthBracket++;
      else if (ch === "]") depthBracket = Math.max(0, depthBracket - 1);
      else if (ch === "#" && depthBrace === 0 && depthBracket === 0) {
        const prev = j > 0 ? s[j - 1] : " ";
        if (/\s/.test(prev)) return s.slice(0, j).trimEnd();
      }
    }
    return s;
  }

  function splitCSV(s) {
    const parts = [];
    let cur = "";
    let inS = false;
    let quote = "";
    let esc = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inS) {
        if (esc) {
          cur += ch;
          esc = false;
        } else if (ch === "\\") {
          cur += ch;
          esc = true;
        } else if (ch === quote) {
          cur += ch;
          inS = false;
          quote = "";
        } else {
          cur += ch;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inS = true;
        quote = ch;
        cur += ch;
        continue;
      }
      if (ch === ",") {
        parts.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.trim() !== "" || s.endsWith(",")) parts.push(cur.trim());
    return parts;
  }
}

function defaultCloneContext(obj) {
  try {
    if (typeof structuredClone === "function") return structuredClone(obj);
  } catch {}
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {}
  return { ...obj };
}

function createSleepWithSignalFactory(stepTimeoutReasons) {
  return function sleepWithSignal(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        return reject(
          stepTimeoutReasons.get(signal) || new PipelineCancelled(),
        );
      }
      const t = setTimeoutMaybeUnref(
        () => {
          cleanup();
          resolve();
        },
        Math.max(0, Number(ms) || 0),
      );
      const onAbort = () => {
        cleanup();
        reject(stepTimeoutReasons.get(signal) || new PipelineCancelled());
      };
      function cleanup() {
        clearTimeout(t);
        try {
          signal && signal.removeEventListener("abort", onAbort);
        } catch {}
      }
      try {
        signal && signal.addEventListener("abort", onAbort, { once: true });
      } catch {}
    });
  };
}
