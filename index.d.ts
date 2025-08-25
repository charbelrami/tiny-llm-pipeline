export class PipelineCancelled extends Error {
  name: "PipelineCancelled";
  code: "E_PIPELINE_CANCELLED";
  constructor(message?: string);
}

export class PipelineTimeout extends Error {
  name: "PipelineTimeout";
  code: "E_PIPELINE_TIMEOUT";
  constructor(message?: string);
}

export class PipelineValidationError extends Error {
  name: "PipelineValidationError";
  code: "E_PIPELINE_VALIDATION";
  constructor(message?: string);
}

export class PipelineStepTimeout extends Error {
  name: "PipelineStepTimeout";
  code: "E_PIPELINE_STEP_TIMEOUT";
  constructor(message?: string);
}

export interface PipelineRegistry {
  models?: Record<
    string,
    (args: {
      prompt: string;
      params?: Record<string, unknown>;
      signal: AbortSignal;
      context: Record<string, unknown>;
    }) => Promise<unknown> | unknown
  >;
}

export interface PipelineHooks<
  TContext = Record<string, unknown>,
  TResult = unknown,
> {
  onStart?: (payload: {
    steps: Array<unknown>;
    initialContext: TContext;
  }) => void | Promise<void>;
  onFinish?: (payload: { result: TResult }) => void | Promise<void>;
  onError?: (payload: { error: unknown }) => void | Promise<void>;
  onStepStart?: (payload: {
    step: unknown;
    stepIndex: number;
    context: TContext;
  }) => void | Promise<void>;
  onStepFinish?: (payload: {
    step: unknown;
    stepIndex: number;
    context: TContext;
  }) => void | Promise<void>;
  onStepError?: (payload: {
    step: unknown;
    stepIndex: number;
    context: TContext;
    error: unknown;
  }) => void | Promise<void>;
}

export interface BuiltinStepBase {
  type: string;
  timeoutMs?: number;
  name?: string;
  retry?: {
    retries?: number;
    backoffMs?: number;
    jitter?: number; // 0..1
    on?: "any" | "error" | "timeout";
  };
}

export interface SetStep extends BuiltinStepBase {
  type: "set";
  var: string;
  value: unknown;
}
export interface LlmStep extends BuiltinStepBase {
  type: "llm";
  model: string;
  prompt?: unknown;
  from?: string; // read prompt from context path
  params?: Record<string, unknown>;
  var?: string;
  retry?: {
    retries?: number;
    backoffMs?: number;
    jitter?: number; // 0..1
    on?: "any" | "error" | "timeout";
  };
}
export interface OutputStep extends BuiltinStepBase {
  type: "output";
  pick?: string | string[] | Record<string, unknown>;
  value?: unknown;
}
export interface IfStep extends BuiltinStepBase {
  type: "if";
  when?: unknown;
  whenVar?: string;
  then?: Array<unknown>;
  else?: Array<unknown>;
}
export interface ForEachStep extends BuiltinStepBase {
  type: "foreach";
  in?: string;
  as?: string;
  index?: string;
  scoped?: boolean;
  steps: Array<unknown>;
}
export interface ParallelBranch {
  steps: Array<unknown>;
}
export interface ParallelStep extends BuiltinStepBase {
  type: "parallel";
  branches: Array<ParallelBranch>;
  var?: string;
  mode?: "allSettled" | "race";
  result?: "context" | "value";
  concurrency?: number;
}

export type BuiltinStep =
  | SetStep
  | LlmStep
  | OutputStep
  | IfStep
  | ForEachStep
  | ParallelStep;

export interface StepHandlerArgs<C = Record<string, unknown>> {
  step: any;
  context: C;
  signal: AbortSignal;
  get: (path: string) => unknown;
  set: (path: string, value: unknown) => void;
  runSteps: (steps: Array<any>, childContext?: C) => Promise<any>;
  sleep: (ms: number) => Promise<void>;
  registry: PipelineRegistry;
  models: NonNullable<PipelineRegistry["models"]>;
}

export interface PipelineOptions<
  TContext = Record<string, unknown>,
  TResult = unknown,
> {
  parseYAML?: (src: string) => unknown; // optional custom parser; default is a tiny YAML subset parser
  registry?: PipelineRegistry;
  perStepTimeoutMs?: number; // optional timeout applied to each step
  overallTimeoutMs?: number; // optional timeout for the entire pipeline
  parentSignal?: AbortSignal; // optional parent signal to cancel pipeline
  stepTimeoutError?: boolean; // if true, per-step timeouts throw PipelineStepTimeout instead of PipelineCancelled
  cloneContext?: <T = unknown>(ctx: T) => T; // optional deep clone function for isolating parallel branch contexts
  hooks?: PipelineHooks<TContext, TResult>; // optional lifecycle hooks
  stepHandlers?: Record<
    string,
    (args: StepHandlerArgs<TContext>) => Promise<unknown> | unknown
  >; // custom step types
}

export interface PipelineStartResult<T = unknown> {
  promise: Promise<T>;
  cancel(): boolean;
}

export type PipelineFunction<
  TContext = Record<string, unknown>,
  TResult = unknown,
> = ((initialContext?: TContext) => Promise<TResult>) & {
  start(initialContext?: TContext): PipelineStartResult<TResult>;
  withSignal(
    parentSignal: AbortSignal,
  ): (initialContext?: TContext) => Promise<TResult>;
  startWithSignal(
    parentSignal: AbortSignal,
    initialContext?: TContext,
  ): PipelineStartResult<TResult>;
};

declare function createPipeline<
  TContext = Record<string, unknown>,
  TResult = unknown,
>(
  source: string | object,
  options?: PipelineOptions<TContext, TResult>,
): PipelineFunction<TContext, TResult>;
export default createPipeline;

export function isPipelineCancelled(
  err: unknown,
): err is PipelineCancelled & { code: "E_PIPELINE_CANCELLED" };
export function isPipelineTimeout(
  err: unknown,
): err is PipelineTimeout & { code: "E_PIPELINE_TIMEOUT" };
export function isPipelineValidation(
  err: unknown,
): err is PipelineValidationError & { code: "E_PIPELINE_VALIDATION" };
export function isPipelineStepTimeout(
  err: unknown,
): err is PipelineStepTimeout & { code: "E_PIPELINE_STEP_TIMEOUT" };

export function renderTemplate(
  tpl: unknown,
  ctx: Record<string, unknown>,
): string;

export function defineRegistry<T extends PipelineRegistry>(registry: T): T;

export function validatePipeline(
  source: string | object,
  options?: PipelineOptions & { initialContext?: Record<string, unknown> },
): Promise<{ ok: true } | { ok: false; error: unknown }>;
