# Agent span failure reporting

A run is the lifetime of the current `gen_ai.invoke_agent` span: it starts through
existing session creation, model, tool, or usage hooks and ends on `session.idle`
or deletion. The first terminal error sets the active span's error status and a
bounded `error.type`. Later notifications cannot reset it. Creating the next span
in the same conversation resets classification. No explicit success status is
introduced; completion does not establish answer correctness.

## Signals and compatibility

Verified against OpenCode **1.2.16**, plugin/SDK **1.2.16**, and the committed Sentry
**10.42.0** dependency, without upgrading the lockfile. The host still supplies the
plugin's existing hooks. Its bundled runtime also loads the built ESM plugin.
There is no claim of compatibility testing against other OpenCode versions.

- Terminal `session.error` and assistant `message.updated.info.error` classify an
  existing active parent. Assistant errors are handled before usage validation,
  usage deduplication, and configuration gates for usage/content/metrics.
- Provider retries use `session.status` with `type: retry`; they do not fail the
  parent. Failed/recovered tool calls retain the existing child-only behavior.
- **Exception:** `session.error` with `ContextOverflowError` initiates compaction
  and is not yet terminal. A subsequent assistant error confirms failure (for
  example, compaction itself exceeding the context limit). This can update a
  message whose usage has already been processed.
- **Ambiguous notification:** `session.error` with `UnknownError` also reports
  recoverable input-file read failures. It does not fail the parent without an
  assistant error confirming terminal failure while the span is active. Unknown
  future error names receive the same conservative treatment.
- The 1.2.16 host emits `ContextOverflowError` and `StructuredOutputError`, although
  the plugin's v1 SDK error union omits them. The existing SDK's v2 types describe
  them. Runtime guards accept these bounded names; no plugin API migration is
  required. Tests type these fixtures against those v2 types.

The other recognized categories are `ProviderAuthError`, `UnknownError`,
`MessageOutputLengthError`, `MessageAbortedError`, and `APIError`. Other named
error objects use `UnknownError`. Missing/malformed error objects do not classify
spans. Only category names are added; no message, body, or arbitrary object is
copied into `error.type`. Existing separate error reports and flushes remain
unchanged, including their existing payload serialization.

## Cancellation and ordering

`MessageAbortedError` sets Sentry status `{ code: 2, message: "cancelled" }` and
`error.type: "MessageAbortedError"` when the span is active. This describes an
aborted operation, **not a known user action**. OpenCode converts a DOM
`AbortError` to this category without recording its initiator. No message-text
heuristic is used. Other terminal categories use `{ code: 2, message:
"unknown_error" }`.

The host publishes normal processor terminal errors before idle, then publishes
the completed assistant message after idle. Error-only handling never creates a
parent, and the late completed error message must not reopen a parent through the
usage path. Deletion and repeated idle/error notifications remain safe.

For a retained idle session, a completed error message still emits its token and
response-duration metrics when usage processing and metrics are enabled. The
existing completed-message deduplication prevents repeated updates from counting
usage twice. No parent or request span is created after idle just to record those
metrics. Late errors for deleted or unknown sessions remain ignored.

Explicit host cancellation can publish idle *before* the abort error arrives.
An already-ended span is not rewritten or reopened; in that order it retains its
original unset status. This is a limitation of the existing span boundary, not
proof of success. The same limitation applies to an ambiguous `UnknownError` notification followed
by its confirming assistant error only after idle (the normal processor order).
Terminal unknown model/agent notifications may have no assistant confirmation at
all. These cases remain unclassified: the event lacks enough structured context
to distinguish them safely from recovered input-file failures.

Distinguishing user intent or retaining spans after idle would
require a separate host/lifecycle change.

Correlation uses the event's session ID and the active span. The host's
`session.error` has no run or message identifier. This patch assumes notifications
belong to the currently active run, and does not attempt to reorder a previous
run's delayed events arriving after a new run has started. Tests cover observed
error-before-idle and completed-error-after-idle orderings, including cancellation,
not arbitrary cross-run replay.

## Verification

```sh
npm ci
npm test
npm run typecheck
npm run build
git diff --check
```

Tests use Node's built-in test runner and the existing TypeScript compiler (tested
with Node 22.17.0 / npm 10.9.2). They compile into ignored `.test-dist/` as CommonJS
for isolated module mocks; test-only type paths resolve the existing SDK's
export-map-only packages. The distributed ESM build still includes only `src/`.
Each mocked test reloads the plugin to isolate module-level maps and initialization.

The separate real-Sentry test uses a custom in-memory transport, disables default
integrations, blocks socket/fetch network calls, flushes, and closes the SDK.
It logs only a sanitized whitelist from actual transaction envelopes:

| Scenario | Baseline export | Patched export | Patched `error.type` |
| --- | --- | --- | --- |
| Terminal API error | `ok` | `unknown_error` | `APIError` |
| Successful run | `ok` | `ok` | absent |
| Typed abort before idle | `ok` | `cancelled` | `MessageAbortedError` |

The baseline never set parent status; Sentry 10.42.0 maps unset status to `ok` in
its export. The successful mocked span remains unset. No live Sentry UI or paid
provider calls are needed for these tests.

## Source references

- [Original report by rustyaos, issue #4](https://github.com/stolinski/opencode-sentry-monitor/issues/4).
- [Host processor: retry, compaction, terminal error, idle, final message](https://github.com/anomalyco/opencode/blob/v1.2.16/packages/opencode/src/session/processor.ts#L352-L426).
- [Compaction failure updates the assistant error](https://github.com/anomalyco/opencode/blob/v1.2.16/packages/opencode/src/session/compaction.ts#L224-L233).
- [Recoverable input-file error notification](https://github.com/anomalyco/opencode/blob/v1.2.16/packages/opencode/src/session/prompt.ts#L1182-L1200).
- [Host cancellation and idle](https://github.com/anomalyco/opencode/blob/v1.2.16/packages/opencode/src/session/prompt.ts#L256-L267).
- [Abort conversion without initiator information](https://github.com/anomalyco/opencode/blob/v1.2.16/packages/opencode/src/session/message-v2.ts#L832-L842).
- [Plugin event dispatch](https://github.com/anomalyco/opencode/blob/v1.2.16/packages/opencode/src/plugin/index.ts#L134-L141).
- [OpenTelemetry error-recording guidance](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/).
