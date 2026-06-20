import { contextBridge, ipcRenderer } from "electron";
import type {
  AutomationAction,
  BillingInterval,
  ChatDeltaFrame,
  ConversationSummary,
  Message,
  ModelTier,
  PlanId,
  RunStepResponse,
  SubscriptionState
} from "@workcrew/contracts";

// What the renderer passes to chat.send. The request id is generated here and
// returned so the caller can correlate streamed frames and issue a stop.
type ChatSendPayload = {
  conversationId?: string;
  text: string;
  attachments?: unknown[];
  model: ModelTier;
  effort: "low" | "medium" | "high" | "max";
  thinking?: boolean;
};

// A frame envelope as delivered over the chat:delta channel.
type ChatDeltaEnvelope = { requestId: string; frame: ChatDeltaFrame };

// A loaded conversation as returned by conversations.get.
type ConversationDetail = ConversationSummary & { messages: Message[] };

// A short random id for correlating a chat stream to its frames. crypto is
// available in the preload context.
function makeRequestId(): string {
  return crypto.randomUUID();
}

const workcrew = {
  app: {
    info: (): Promise<{ name: string; version: string; authMode: string; billingMode: string }> => ipcRenderer.invoke("app:info")
  },
  auth: {
    session: (): Promise<{ authenticated: boolean; email?: string }> => ipcRenderer.invoke("auth:session"),
    signIn: (email: string, password: string) => ipcRenderer.invoke("auth:sign-in", { email, password }),
    signUp: (email: string, password: string) => ipcRenderer.invoke("auth:sign-up", { email, password }),
    reset: (email: string) => ipcRenderer.invoke("auth:reset", email),
    signOut: () => ipcRenderer.invoke("auth:sign-out")
  },
  api: {
    entitlement: (): Promise<SubscriptionState> => ipcRenderer.invoke("api:entitlement"),
    simulateCheckout: (plan: PlanId, interval: BillingInterval): Promise<SubscriptionState> => ipcRenderer.invoke("api:simulate", { plan, interval }),
    checkout: (plan: PlanId, interval: BillingInterval) => ipcRenderer.invoke("api:checkout", { plan, interval }),
    portal: () => ipcRenderer.invoke("api:portal"),
    createRun: (task: string, model: ModelTier): Promise<{ runId: string }> => ipcRenderer.invoke("api:create-run", { task, model }),
    nextRun: (runId: string, result?: { toolUseId: string; ok: boolean; output: string }): Promise<RunStepResponse> => ipcRenderer.invoke("api:next-run", runId, { result })
  },
  chat: {
    // Start a streamed chat turn. A request id is generated here so the caller
    // can match incoming deltas and stop the stream. Frames arrive on onDelta.
    send: (payload: ChatSendPayload): Promise<{ requestId: string }> => {
      const requestId = makeRequestId();
      return ipcRenderer.invoke("chat:send", { ...payload, requestId });
    },
    // Subscribe to streamed frames. The callback receives the request id and the
    // frame. Returns an unsubscribe that removes exactly this listener.
    onDelta: (cb: (envelope: ChatDeltaEnvelope) => void): (() => void) => {
      const listener = (_event: unknown, envelope: ChatDeltaEnvelope): void => cb(envelope);
      ipcRenderer.on("chat:delta", listener);
      return () => ipcRenderer.removeListener("chat:delta", listener);
    },
    // Cancel an in-flight stream by its request id.
    stop: (requestId: string): Promise<{ stopped: boolean }> => ipcRenderer.invoke("chat:stop", requestId)
  },
  conversations: {
    list: (): Promise<ConversationSummary[]> => ipcRenderer.invoke("conversations:list"),
    get: (id: string): Promise<ConversationDetail> => ipcRenderer.invoke("conversations:get", id),
    delete: (id: string): Promise<{ deleted: boolean }> => ipcRenderer.invoke("conversations:delete", id)
  },
  automation: {
    execute: (action: AutomationAction): Promise<string> => {
      if (action.kind === "browser") return ipcRenderer.invoke("automation:browser", action);
      if (action.kind === "windows") return ipcRenderer.invoke("automation:windows", action);
      return Promise.resolve(action.summary);
    },
    stop: () => ipcRenderer.invoke("automation:stop")
  },
  files: {
    pick: (): Promise<{ path: string; name: string; size: number }[]> => ipcRenderer.invoke("dialog:open-files")
  }
};

contextBridge.exposeInMainWorld("workcrew", workcrew);

export type WorkCrewBridge = typeof workcrew;
