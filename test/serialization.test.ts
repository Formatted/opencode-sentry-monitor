import { strict as assert } from "node:assert";
import { test, mock } from "node:test";
import { Socket } from "node:net";
import type { PluginInput } from "@opencode-ai/plugin";
import Sentry = require("@sentry/node");
import config = require("../src/config");
import { emit, failure, session } from "./fixtures";

test("real SDK exports terminal failure, unset success, and typed abort", async (t) => {
  type Transport = ReturnType<NonNullable<Sentry.NodeOptions["transport"]>>;
  const envelopes: Parameters<Transport["send"]>[0][] = [];
  const init = Sentry.init;
  mock.method(Socket.prototype, "connect", () => {
    throw new Error("Outbound network forbidden in serialization test");
  });
  mock.method(globalThis, "fetch", () => {
    throw new Error("Outbound network forbidden in serialization test");
  });
  mock.method(console, "info", () => undefined);
  mock.method(config, "loadPluginConfig", async () => ({
    source: "test",
    config: {
      dsn: "https://public@example.invalid/1",
      tracesSampleRate: 1,
      recordInputs: false,
      recordOutputs: false,
      maxAttributeLength: 12000,
      includeMessageUsageSpans: false,
      includeSessionEvents: false,
      diagnostics: false,
      flushTimeoutMs: 1000,
      enableMetrics: false,
      tags: {},
    },
  }));
  mock.method(Sentry, "init", (options: Sentry.NodeOptions) =>
    init({
      ...options,
      defaultIntegrations: false,
      transport: () => ({
        send: async (envelope) => {
          envelopes.push(envelope);
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    }),
  );
  t.after(async () => {
    await Sentry.close(1000);
    mock.restoreAll();
  });
  const { SentryObservabilityPlugin } = await import("../src/index");
  const hooks = await SentryObservabilityPlugin({
    directory: "/synthetic",
    project: { worktree: "/synthetic" },
  } as PluginInput);
  for (const id of ["failure", "success", "abort"]) {
    await emit(hooks, {
      type: "session.created",
      properties: { info: session(id) },
    });
    if (id !== "success")
      await emit(hooks, {
        type: "session.error",
        properties: {
          sessionID: id,
          error:
            id === "failure"
              ? failure
              : {
                  name: "MessageAbortedError",
                  data: { message: "synthetic abort" },
                },
        },
      });
    await emit(hooks, { type: "session.idle", properties: { sessionID: id } });
  }
  await Sentry.flush(1000);
  const transactions = envelopes.flatMap(([, items]) =>
    items
      .filter(([header]) => header.type === "transaction")
      .map(([, payload]) => payload as Sentry.Event),
  );
  const summary = transactions.map((event) => ({
    session: event.contexts?.trace?.data?.["gen_ai.conversation.id"],
    op: event.contexts?.trace?.op,
    status: event.contexts?.trace?.status,
    errorType: event.contexts?.trace?.data?.["error.type"] ?? null,
  }));
  // Deliberately emit only a whitelist: no IDs, timestamps, paths or error payloads.
  t.diagnostic(`sanitized span export: ${JSON.stringify(summary)}`);
  assert.equal(transactions.length, 3);
  assert.deepEqual(summary, [
    {
      session: "failure",
      op: "gen_ai.invoke_agent",
      status: "unknown_error",
      errorType: "APIError",
    },
    {
      session: "success",
      op: "gen_ai.invoke_agent",
      status: "ok",
      errorType: null,
    },
    {
      session: "abort",
      op: "gen_ai.invoke_agent",
      status: "cancelled",
      errorType: "MessageAbortedError",
    },
  ]);
});
