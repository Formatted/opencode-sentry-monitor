import type { AssistantMessage, Event, Session } from "@opencode-ai/sdk";
import type { Hooks } from "@opencode-ai/plugin";

export const failure = {
  name: "APIError",
  data: {
    message: "synthetic provider failure",
    isRetryable: false,
    statusCode: 400,
  },
} satisfies NonNullable<AssistantMessage["error"]>;

export function assistant(
  sessionID: string,
  id = "assistant-1",
): AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    parentID: "user-1",
    modelID: "synthetic-model",
    providerID: "synthetic-provider",
    mode: "build",
    time: { created: 1, completed: 2 },
    path: { cwd: "/synthetic", root: "/synthetic" },
    cost: 0,
    tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

export function session(id: string): Session {
  return {
    id,
    projectID: "synthetic",
    directory: "/synthetic",
    title: "synthetic",
    version: "1.2.16",
    time: { created: 1, updated: 1 },
  };
}

export async function emit(hooks: Hooks, event: Event): Promise<void> {
  await hooks.event!({ event });
}

export async function chat(hooks: Hooks, sessionID: string): Promise<void> {
  const modalities = {
    text: true,
    audio: false,
    image: false,
    video: false,
    pdf: false,
  };
  await hooks["chat.params"]!(
    {
      sessionID,
      agent: "build",
      model: {
        id: "synthetic-model",
        providerID: "synthetic-provider",
        name: "Synthetic",
        api: {
          id: "synthetic-model",
          url: "http://localhost",
          npm: "synthetic",
        },
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: false,
          toolcall: true,
          input: modalities,
          output: modalities,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 1000, output: 100 },
        status: "active",
        options: {},
        headers: {},
      },
      provider: {
        source: "custom",
        options: {},
        info: {
          id: "synthetic-provider",
          name: "Synthetic",
          source: "custom",
          env: [],
          options: {},
          models: {},
        },
      },
      message: {
        id: "user-1",
        sessionID,
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "synthetic-provider", modelID: "synthetic-model" },
      },
    },
    { temperature: 1, topP: 1, topK: 1, options: {} },
  );
}
