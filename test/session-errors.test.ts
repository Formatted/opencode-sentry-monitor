import { strict as assert } from "node:assert";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { PluginInput, Hooks } from "@opencode-ai/plugin";
import Sentry = require("@sentry/node");
import config = require("../src/config");
import type { Event, AssistantMessage } from "@opencode-ai/sdk";
import type {
  ContextOverflowError,
  StructuredOutputError,
} from "@opencode-ai/sdk/v2";
import { assistant, chat, emit, failure, session } from "./fixtures";

type SpanOptions = Parameters<typeof Sentry.startInactiveSpan>[0];
class Span {
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  ends = 0;
  constructor(readonly options: SpanOptions) {
    this.attributes = { ...options.attributes };
  }
  setAttribute(key: string, value: unknown) {
    assert.equal(this.ends, 0);
    this.attributes[key] = value;
  }
  setStatus(status: { code: number; message?: string }) {
    assert.equal(this.ends, 0);
    this.status = status;
  }
  end() {
    this.ends++;
  }
}
let hooks: Hooks;
let spans: Span[];
let captures: ReturnType<typeof mock.fn>;
let flushes: ReturnType<typeof mock.fn>;
let settings: config.ResolvedPluginConfig;
async function setup(overrides: Partial<config.ResolvedPluginConfig> = {}) {
  settings = {
    dsn: "https://public@example.invalid/1",
    tracesSampleRate: 1,
    recordInputs: false,
    recordOutputs: false,
    maxAttributeLength: 12000,
    includeMessageUsageSpans: true,
    includeSessionEvents: true,
    diagnostics: false,
    flushTimeoutMs: 1000,
    enableMetrics: false,
    tags: {},
    ...overrides,
  };
  mock.method(config, "loadPluginConfig", async () => ({
    source: "test",
    config: settings,
  }));
  // Reload only the plugin to isolate its maps and initialization flag per test.
  delete require.cache[require.resolve("../src/index")];
  const { SentryObservabilityPlugin } = await import("../src/index");
  hooks = await SentryObservabilityPlugin({
    directory: "/synthetic",
    project: { worktree: "/synthetic" },
  } as PluginInput);
}
beforeEach(async () => {
  spans = [];
  mock.method(Sentry, "init", () => undefined);
  mock.method(Sentry, "startInactiveSpan", (options: SpanOptions) => {
    const span = new Span(options);
    spans.push(span);
    return span;
  });
  captures = mock.method(Sentry, "captureMessage", () => "synthetic");
  flushes = mock.method(Sentry, "flush", async () => true);
  mock.method(Sentry, "addBreadcrumb", () => undefined);
  mock.method(console, "info", () => undefined);
  mock.method(console, "warn", () => undefined);
  await setup();
});
afterEach(() => mock.restoreAll());
const start = (id = "A") =>
  emit(hooks, { type: "session.created", properties: { info: session(id) } });
const idle = (sessionID = "A") =>
  emit(hooks, { type: "session.idle", properties: { sessionID } });
const error = (sessionID = "A") =>
  emit(hooks, {
    type: "session.error",
    properties: { sessionID, error: failure },
  });

test("terminal session.error marks the existing parent before idle", async () => {
  await start();
  await error();
  assert.equal(spans[0].status?.code, 2);
  assert.equal(spans[0].attributes["error.type"], "APIError");
  assert.equal(spans[0].ends, 0);
  await idle();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].ends, 1);
  assert.equal(captures.mock.callCount(), 1);
  assert.equal(flushes.mock.callCount(), 2);
});

// Invalid/partial wire payloads deliberately bypass SDK compile-time validation.
const wire = (event: unknown) => emit(hooks, event as Event);
const update = (info: AssistantMessage) =>
  emit(hooks, { type: "message.updated", properties: { info } });
const parents = () =>
  spans.filter((span) => span.options.op === "gen_ai.invoke_agent");
const assertUnfailed = (span: Span) => {
  assert.equal(span.status, undefined);
  assert.equal(span.attributes["error.type"], undefined);
};

test("normal run keeps status unset, usage, model and parentage intact", async () => {
  await start();
  await chat(hooks, "A");
  await update(assistant("A"));
  await idle();
  assert.equal(parents().length, 1);
  assertUnfailed(spans[0]);
  assert.equal(spans[0].ends, 1);
  assert.equal(spans[0].attributes["gen_ai.request.model"], "synthetic-model");
  assert.equal(spans[0].attributes["gen_ai.conversation.id"], "A");
  assert.equal(spans[1].options.parentSpan, spans[0]);
  assert.equal(spans[1].attributes["gen_ai.usage.total_tokens"], 5);
  assert.equal(spans[1].ends, 1);
});

for (const includeMessageUsageSpans of [false, true]) {
  test(`assistant failure is independent of usage=${includeMessageUsageSpans}, content, breadcrumbs and metrics`, async () => {
    settings.includeMessageUsageSpans = includeMessageUsageSpans;
    settings.includeSessionEvents = false;
    await start();
    await update({ ...assistant("A"), error: failure });
    assert.equal(spans[0].status?.code, 2);
    assert.equal(spans[0].attributes["error.type"], "APIError");
    await idle();
    assert.equal(spans[0].ends, 1);
    assert.equal(captures.mock.callCount(), 0);
    assert.equal(
      spans.some(
        (span) =>
          "gen_ai.request.messages" in span.attributes ||
          "gen_ai.response.text" in span.attributes,
      ),
      false,
    );
  });
}

test("partial assistant error needs no tokens, completion, model or provider fields", async () => {
  await start();
  const info = {
    id: "partial",
    sessionID: "A",
    role: "assistant",
    error: failure,
  } satisfies Pick<AssistantMessage, "id" | "sessionID" | "role" | "error">;
  await wire({ type: "message.updated", properties: { info } });
  await idle();
  assert.equal(spans[0].attributes["error.type"], "APIError");
  assert.equal(spans.length, 1);
});

test("completed error without tokens does not leak a usage span", async () => {
  await start();
  const { tokens, ...info } = { ...assistant("A"), error: failure };
  await wire({ type: "message.updated", properties: { info } });
  await idle();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].status?.code, 2);
});

test("usage deduplication cannot suppress a later terminal error on that message", async () => {
  await start();
  await update(assistant("A"));
  // Compaction can add an error to an already completed assistant message.
  const overflow = {
    name: "ContextOverflowError",
    data: { message: "synthetic context limit" },
  } satisfies ContextOverflowError;
  await wire({
    type: "message.updated",
    properties: { info: { ...assistant("A"), error: overflow } },
  });
  assert.equal(spans[0].attributes["error.type"], "ContextOverflowError");
  assert.equal(spans.length, 2);
});

test("duplicates and both failure paths keep one parent, first classification and existing captures", async () => {
  await start();
  await error();
  await error();
  await update({ ...assistant("A"), error: failure });
  await update({ ...assistant("A"), error: failure });
  await update({
    ...assistant("A"),
    error: {
      name: "MessageAbortedError",
      data: { message: "synthetic abort" },
    },
  });
  await emit(hooks, {
    type: "session.status",
    properties: { sessionID: "A", status: { type: "busy" } },
  });
  await chat(hooks, "A");
  await idle();
  await idle();
  assert.equal(parents().length, 1);
  assert.equal(spans[0].ends, 1);
  assert.equal(spans[0].attributes["error.type"], "APIError");
  assert.equal(spans[0].status?.message, "unknown_error");
  assert.equal(captures.mock.callCount(), 2); // one per session.error, unchanged
});

test("failed tool then recovered tool does not fail the parent", async () => {
  await start();
  for (const callID of ["failed", "recovered"]) {
    const input = { sessionID: "A", callID, tool: "synthetic", args: {} };
    await hooks["tool.execute.before"]!(input, { args: {} });
    await hooks["tool.execute.after"]!(input, {
      title: callID === "failed" ? "error" : "done",
      output: "synthetic",
      metadata: {},
    });
  }
  await idle();
  assertUnfailed(spans[0]);
  assert.equal(spans[1].status?.code, 2);
  assert.equal(spans[2].status?.code, 1);
  assert.equal(spans[1].options.parentSpan, spans[0]);
  assert.equal(captures.mock.callCount(), 1);
});

test("provider retry and recoverable context overflow do not fail the run", async () => {
  await start();
  await emit(hooks, {
    type: "session.status",
    properties: {
      sessionID: "A",
      status: {
        type: "retry",
        attempt: 1,
        message: "synthetic overload",
        next: 2,
      },
    },
  });
  const overflow = {
    name: "ContextOverflowError",
    data: { message: "synthetic overflow" },
  } satisfies ContextOverflowError;
  await wire({
    type: "session.error",
    properties: { sessionID: "A", error: overflow },
  });
  await update(assistant("A"));
  await idle();
  assertUnfailed(spans[0]);
  assert.equal(captures.mock.callCount(), 1); // existing separate reporting preserved
});

test("typed abort is cancelled without inferring a user or inspecting text", async () => {
  await start();
  await emit(hooks, {
    type: "session.error",
    properties: {
      sessionID: "A",
      error: {
        name: "MessageAbortedError",
        data: { message: "synthetic opaque detail" },
      },
    },
  });
  await idle();
  assert.deepEqual(spans[0].status, { code: 2, message: "cancelled" });
  assert.equal(spans[0].attributes["error.type"], "MessageAbortedError");
  await start("B");
  await emit(hooks, {
    type: "session.error",
    properties: {
      sessionID: "B",
      error: {
        ...failure,
        data: { ...failure.data, message: "user cancelled abort" },
      },
    },
  });
  assert.equal(parents()[1].status?.message, "unknown_error");
});

test("explicit host cancellation may emit idle before its abort notification", async () => {
  await start();
  await idle(); // SessionPrompt.cancel publishes idle immediately
  await emit(hooks, {
    type: "session.error",
    properties: {
      sessionID: "A",
      error: {
        name: "MessageAbortedError",
        data: { message: "synthetic abort" },
      },
    },
  });
  await update({
    ...assistant("A"),
    error: {
      name: "MessageAbortedError",
      data: { message: "synthetic abort" },
    },
  });
  await idle();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].ends, 1);
  assertUnfailed(spans[0]); // ended spans are not reopened or rewritten
});

test("next run in the same conversation starts clean", async () => {
  await start();
  await error();
  await idle();
  await update({ ...assistant("A"), error: failure }); // actual processor order
  await chat(hooks, "A");
  await update(assistant("A", "assistant-2"));
  await idle();
  assert.equal(parents().length, 2);
  assert.equal(parents()[0].attributes["error.type"], "APIError");
  assertUnfailed(parents()[1]);
  assert.deepEqual(
    parents().map((span) => span.ends),
    [1, 1],
  );
});

test("interleaved sessions remain isolated", async () => {
  await start();
  await start("B");
  await error();
  await idle("B");
  await idle();
  assert.equal(spans[0].status?.code, 2);
  assertUnfailed(spans[1]);
});

test("deletion closes dangling tools once and late error updates create no spans", async () => {
  await start();
  await hooks["tool.execute.before"]!(
    { sessionID: "A", callID: "dangling", tool: "synthetic" },
    { args: {} },
  );
  await error();
  await emit(hooks, {
    type: "session.deleted",
    properties: { info: session("A") },
  });
  await update({ ...assistant("A"), error: failure });
  await error();
  await emit(hooks, {
    type: "session.deleted",
    properties: { info: session("A") },
  });
  await idle();
  assert.equal(spans.length, 2);
  assert.deepEqual(
    spans.map((span) => span.ends),
    [1, 1],
  );
  assert.equal(spans[1].status?.code, 2);
});

test("uncorrelated and malformed failures cannot affect another session or create spans", async () => {
  await start("B");
  for (const sessionID of [undefined, "", "absent", 3, null]) {
    await wire({
      type: "session.error",
      properties: { sessionID, error: failure, info: { id: "B" } },
    });
    await wire({
      type: "message.updated",
      properties: {
        info: { ...assistant("absent"), sessionID, error: failure },
      },
    });
  }
  for (const error of [
    undefined,
    null,
    "raw secret",
    [],
    {},
    { name: "APIError", data: null },
  ]) {
    await wire({
      type: "session.error",
      properties: { sessionID: "B", error },
    });
  }
  await wire({
    type: "message.updated",
    properties: { info: { id: "B", role: "user", error: failure } },
  });
  await wire({ type: "message.updated", properties: { info: null } });
  await wire({ type: "session.error", properties: null });
  assert.equal(spans.length, 1);
  assertUnfailed(spans[0]);
});

test("unknown error names use a bounded fallback without collecting sensitive fields", async () => {
  await start();
  await wire({
    type: "message.updated",
    properties: {
      info: {
        ...assistant("A"),
        error: {
          name: "secret-provider-response",
          data: { message: "secret prompt", responseBody: "secret credential" },
        },
      },
    },
  });
  assert.equal(spans[0].attributes["error.type"], "UnknownError");
  assert.equal(JSON.stringify(spans[0].attributes).includes("secret"), false);
});

test("structured output exhaustion is terminal in the 1.2.16 host", async () => {
  await start();
  const error = {
    name: "StructuredOutputError",
    data: { message: "synthetic", retries: 2 },
  } satisfies StructuredOutputError;
  await wire({
    type: "message.updated",
    properties: { info: { ...assistant("A"), error } },
  });
  assert.equal(spans[0].attributes["error.type"], "StructuredOutputError");
});

test("recoverable input-file UnknownError does not fail the parent", async () => {
  await start();
  await emit(hooks, {
    type: "session.error",
    properties: {
      sessionID: "A",
      error: {
        name: "UnknownError",
        data: { message: "synthetic input read failure" },
      },
    },
  });
  await chat(hooks, "A");
  await update(assistant("A"));
  await idle();
  assertUnfailed(spans[0]);
  assert.equal(captures.mock.callCount(), 1);
});

test("assistant UnknownError confirms terminal failure while the parent is active", async () => {
  await start();
  const error = {
    name: "UnknownError",
    data: { message: "synthetic failure" },
  } satisfies NonNullable<AssistantMessage["error"]>;
  await emit(hooks, {
    type: "session.error",
    properties: { sessionID: "A", error },
  });
  assertUnfailed(spans[0]);
  await update({ ...assistant("A"), error });
  await idle();
  assert.equal(spans[0].status?.code, 2);
  assert.equal(spans[0].attributes["error.type"], "UnknownError");
});

test("unknown failure confirmed only after idle cannot retroactively change the ended span", async () => {
  await start();
  const error = {
    name: "UnknownError",
    data: { message: "synthetic failure" },
  } satisfies NonNullable<AssistantMessage["error"]>;
  await emit(hooks, {
    type: "session.error",
    properties: { sessionID: "A", error },
  });
  await idle();
  await update({ ...assistant("A"), error });
  assert.equal(spans.length, 1);
  assert.equal(spans[0].ends, 1);
  assertUnfailed(spans[0]);
});
