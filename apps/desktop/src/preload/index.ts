import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AttachmentRef,
  AutomationAction,
  BillingInterval,
  ChatDeltaFrame,
  ConversationSummary,
  Message,
  ModelTier,
  PlanId,
  ReferralInfo,
  RunStepResponse,
  SubscriptionState
} from "@workcrew/contracts";

import type { UpdateStatus } from "../main/updater";

// A file the user picked locally, before it is uploaded.
type PickedFile = { path: string; name: string; size: number };

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
  support: {
    // Open the user's mail client to the support address.
    contact: (): Promise<{ opened: boolean }> => ipcRenderer.invoke("support:contact"),
    // Open the WorkCrew website, where billing and cancellation are managed.
    billing: (): Promise<{ opened: boolean }> => ipcRenderer.invoke("support:billing")
  },
  settings: {
    getBackendUrl: (): Promise<string> => ipcRenderer.invoke("settings:get-backend-url"),
    setBackendUrl: (url: string): Promise<string> => ipcRenderer.invoke("settings:set-backend-url", url)
  },
  updates: {
    check: (manual?: boolean): Promise<{ supported: boolean }> => ipcRenderer.invoke("updates:check", manual === true),
    install: (): Promise<void> => ipcRenderer.invoke("updates:install"),
    // Subscribe to update status changes. Returns an unsubscribe function.
    onStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
      const listener = (_event: unknown, status: UpdateStatus): void => cb(status);
      ipcRenderer.on("updates:status", listener);
      return () => ipcRenderer.removeListener("updates:status", listener);
    }
  },
  auth: {
    session: (): Promise<{ authenticated: boolean; email?: string }> => ipcRenderer.invoke("auth:session"),
    signIn: (email: string, password: string) => ipcRenderer.invoke("auth:sign-in", { email, password }),
    signUp: (email: string, password: string, referralCode?: string) => ipcRenderer.invoke("auth:sign-up", { email, password, referralCode }),
    reset: (email: string) => ipcRenderer.invoke("auth:reset", email),
    signOut: () => ipcRenderer.invoke("auth:sign-out")
  },
  api: {
    entitlement: (): Promise<SubscriptionState> => ipcRenderer.invoke("api:entitlement"),
    referral: (): Promise<ReferralInfo> => ipcRenderer.invoke("api:referral"),
    simulateCheckout: (plan: PlanId, interval: BillingInterval): Promise<SubscriptionState> => ipcRenderer.invoke("api:simulate", { plan, interval }),
    checkout: (plan: PlanId, interval: BillingInterval) => ipcRenderer.invoke("api:checkout", { plan, interval }),
    changePlan: (plan: PlanId, interval: BillingInterval): Promise<SubscriptionState> => ipcRenderer.invoke("api:change-plan", { plan, interval }),
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
    launchBrowser: (): Promise<{ launched: boolean; message: string }> => ipcRenderer.invoke("automation:launch-browser"),
    stop: () => ipcRenderer.invoke("automation:stop")
  },
  // Click recording: capture the user's clicks (in the automation browser or in
  // a desktop app) and get them back as replayable steps to save as a recipe.
  recorder: {
    start: (target: "browser" | "windows"): Promise<{ started: boolean }> => ipcRenderer.invoke("recorder:start", target),
    stop: (target: "browser" | "windows"): Promise<{ steps: AutomationAction[] }> => ipcRenderer.invoke("recorder:stop", target)
  },
  // On-device voice input. The renderer records the mic and decodes it to 16 kHz
  // mono samples; the main process transcribes locally and returns the text.
  dictation: {
    transcribe: (samples: Float32Array): Promise<string> => ipcRenderer.invoke("dictation:transcribe", samples.buffer),
    onStatus: (cb: (status: { state: string; progress?: number }) => void): (() => void) => {
      const listener = (_event: unknown, status: { state: string; progress?: number }): void => cb(status);
      ipcRenderer.on("dictation:status", listener);
      return () => ipcRenderer.removeListener("dictation:status", listener);
    }
  },
  files: {
    pick: (): Promise<PickedFile[]> => ipcRenderer.invoke("dialog:open-files"),
    // Resolve the absolute path of a file dropped onto the window, so it can be
    // uploaded through the same path-based pipeline as the file picker. Guarded
    // so an unavailable webUtils never breaks the bridge; the caller falls back.
    pathForFile: (file: File): string => (webUtils ? webUtils.getPathForFile(file) : "")
  },
  attachments: {
    // Upload picked files and return a reference for each successfully stored
    // file. The bytes are read in the main process and posted to the backend.
    upload: (files: PickedFile[]): Promise<AttachmentRef[]> => ipcRenderer.invoke("attachments:upload", files)
  }
};

contextBridge.exposeInMainWorld("workcrew", workcrew);

export type WorkCrewBridge = typeof workcrew;
