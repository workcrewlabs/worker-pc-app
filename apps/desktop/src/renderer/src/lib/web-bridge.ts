import type { AttachmentRef, AutomationAction, BillingInterval, ChatDeltaFrame, ModelTier, PlanId, RecordedEvent, SubscriptionState } from "@workcrew/contracts";
import type { WorkCrewBridge } from "../../../preload/index";
import { generateExport } from "../../../main/file-export.js";
import type { SaveFileRequest, SaveFileResult } from "../../../shared/export-formats.js";

// The browser build of WorkCrew. This module implements the same `window.workcrew`
// bridge the Electron preload exposes, but against the backend's REST API
// directly, so the whole renderer runs unchanged as a web app (chat, Excel and
// document generation, conversations, billing). Anything that genuinely needs
// the desktop (recorder, browser/computer automation, working in local folders,
// voice) throws DesktopOnlyError, which the UI turns into a "download the app"
// prompt. This file must implement WorkCrewBridge exactly.

const BACKEND = (import.meta.env.VITE_WORKCREW_API as string | undefined) ?? "https://workcrew-backend.onrender.com";
const DOWNLOAD_URL = "https://getworkcrew.com/#download";

export class DesktopOnlyError extends Error {
  code = "DESKTOP_ONLY" as const;
  constructor(feature: string) {
    super(`${feature} needs the WorkCrew desktop app.`);
  }
}

function desktopOnly(feature: string): never {
  throw new DesktopOnlyError(feature);
}

// --- session ---------------------------------------------------------------
// The access token lives in memory; only the refresh token is persisted, so a
// stored value can never be used directly against the API.

const REFRESH_KEY = "workcrew:web:refresh";
let accessToken: string | null = null;
let accessExpiresAtMs = 0;
let sessionEmail: string | undefined;
let sessionName: string | null | undefined;

type Session = { accessToken: string; refreshToken: string; expiresAtMs: number; userId: string; email: string; name?: string | null };

function adoptSession(session: Session): void {
  accessToken = session.accessToken;
  accessExpiresAtMs = session.expiresAtMs;
  sessionEmail = session.email;
  sessionName = session.name ?? null;
  try { localStorage.setItem(REFRESH_KEY, session.refreshToken); } catch { /* storage full/blocked */ }
}

function clearSession(): void {
  accessToken = null;
  accessExpiresAtMs = 0;
  sessionEmail = undefined;
  sessionName = undefined;
  try { localStorage.removeItem(REFRESH_KEY); } catch { /* ignore */ }
}

async function refreshSession(): Promise<boolean> {
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return false;
  const response = await fetch(`${BACKEND}/v1/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken })
  });
  if (!response.ok) {
    clearSession();
    return false;
  }
  const data = (await response.json()) as { session: Session };
  adoptSession(data.session);
  return true;
}

async function bearer(): Promise<string> {
  if (!accessToken || accessExpiresAtMs - 60_000 < Date.now()) {
    const refreshed = await refreshSession();
    if (!refreshed) throw new Error("Sign in is required");
  }
  return accessToken as string;
}

async function apiRequest<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const doFetch = async (): Promise<Response> =>
    fetch(`${BACKEND}${path}`, {
      method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
      headers: {
        authorization: `Bearer ${await bearer()}`,
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {})
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
    });
  let response = await doFetch();
  if (response.status === 401 && (await refreshSession())) response = await doFetch();
  if (!response.ok) {
    let message = "The request could not be completed";
    try {
      const data = (await response.json()) as { error?: string; message?: string };
      message = data.error ?? data.message ?? message;
    } catch { /* non-JSON error body */ }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

// --- picked files -----------------------------------------------------------
// The browser has no file paths, so picked File objects are held here under a
// generated pseudo-path; upload resolves them back to bytes. This keeps the
// renderer's path-based attach flow unchanged.

const pickedFiles = new Map<string, File>();

function rememberFile(file: File): { path: string; name: string; size: number } {
  const path = `web:${crypto.randomUUID()}`;
  pickedFiles.set(path, file);
  return { path, name: file.name, size: file.size };
}

function pickViaDialog(): Promise<{ path: string; name: string; size: number }[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".pdf,.txt,.md,.csv,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.gif,.webp";
    input.onchange = () => resolve(Array.from(input.files ?? []).map(rememberFile));
    // A dialog dismissed without choosing files resolves empty on window focus.
    window.addEventListener("focus", () => setTimeout(() => resolve([]), 400), { once: true });
    input.click();
  });
}

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// --- chat streaming ---------------------------------------------------------

type ChatDeltaEnvelope = { requestId: string; frame: ChatDeltaFrame };
const deltaListeners = new Set<(envelope: ChatDeltaEnvelope) => void>();
const chatAborts = new Map<string, AbortController>();

function emitFrame(requestId: string, frame: ChatDeltaFrame): void {
  for (const listener of deltaListeners) listener({ requestId, frame });
}

async function streamChat(requestId: string, payload: Record<string, unknown>): Promise<void> {
  const controller = new AbortController();
  chatAborts.set(requestId, controller);
  try {
    const response = await fetch(`${BACKEND}/v1/chat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await bearer()}`,
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      let message = "The chat service is unavailable";
      try {
        const data = (await response.json()) as { error?: string; message?: string };
        message = data.error ?? data.message ?? message;
      } catch { /* keep generic */ }
      throw new Error(message);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const flush = (chunk: string): void => {
      for (const event of chunk.split(/\n\n/)) {
        const line = event.split(/\n/).find((entry) => entry.startsWith("data:"));
        if (!line) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        try { emitFrame(requestId, JSON.parse(json) as ChatDeltaFrame); } catch { /* skip bad frame */ }
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const boundary = buffer.lastIndexOf("\n\n");
      if (boundary !== -1) {
        flush(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) flush(buffer);
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = error instanceof Error ? error.message : "The chat request failed";
      emitFrame(requestId, { type: "error", message } as ChatDeltaFrame);
    }
  } finally {
    chatAborts.delete(requestId);
  }
}

// --- the bridge -------------------------------------------------------------

export function createWebBridge(): WorkCrewBridge {
  const bridge = {
    app: {
      info: async () => {
        const health = await fetch(`${BACKEND}/health`).then((r) => r.json()) as { authMode: string; billingMode: string };
        return { name: "WorkCrew", version: "web", authMode: health.authMode, billingMode: health.billingMode };
      }
    },
    clipboard: {
      write: async (text: string) => {
        try { await navigator.clipboard.writeText(text); return { ok: true }; } catch { return { ok: false }; }
      }
    },
    support: {
      contact: async () => { window.open("https://mail.google.com/mail/?view=cm&to=support@getworkcrew.com", "_blank"); return { opened: true }; },
      billing: async () => { window.open("https://getworkcrew.com/#help", "_blank"); return { opened: true }; }
    },
    settings: {
      getBackendUrl: async () => BACKEND,
      setBackendUrl: async () => BACKEND,
      getAnalyticsOptOut: async () => false,
      setAnalyticsOptOut: async (value: boolean) => value,
      getModelMode: async () => apiRequest<{ modelMode: "economy" | "privacy" }>("/v1/preferences").then((r) => r.modelMode).catch(() => "economy" as const),
      setModelMode: async (mode: "economy" | "privacy") => apiRequest<{ modelMode: "economy" | "privacy" }>("/v1/preferences", { method: "PATCH", body: { modelMode: mode } }).then((r) => r.modelMode)
    },
    analytics: {
      capture: async () => ({ ok: true }),
      identify: async () => ({ ok: true })
    },
    updates: {
      check: async () => ({ supported: false }),
      install: async () => undefined,
      onStatus: () => () => undefined
    },
    auth: {
      session: async () => {
        if (!accessToken && !(await refreshSession().catch(() => false))) return { authenticated: false };
        return { authenticated: true, email: sessionEmail, name: sessionName };
      },
      signIn: async (email: string, password: string) => {
        const response = await fetch(`${BACKEND}/v1/auth/sign-in`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password })
        });
        const data = (await response.json()) as { session?: Session; error?: string; message?: string };
        if (!response.ok || !data.session) throw new Error(data.error ?? data.message ?? "Sign in failed");
        adoptSession(data.session);
        return { authenticated: true, email: data.session.email, name: data.session.name ?? null };
      },
      signUp: async (email: string, password: string, name?: string, referralCode?: string) => {
        const response = await fetch(`${BACKEND}/v1/auth/sign-up`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password, name, referralCode })
        });
        const data = (await response.json()) as { session?: Session | null; needsVerification?: boolean; error?: string; message?: string };
        if (!response.ok) throw new Error(data.error ?? data.message ?? "Sign up failed");
        if (data.session) adoptSession(data.session);
        return { needsVerification: data.needsVerification === true };
      },
      setName: async (name: string) => apiRequest<{ name: string | null }>("/v1/profile", { body: { name } }).then((r) => { sessionName = r.name; return r; }),
      reset: async (email: string) => fetch(`${BACKEND}/v1/auth/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }).then(() => ({ ok: true })),
      resendVerification: async (email: string) => fetch(`${BACKEND}/v1/auth/resend-verification`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }).then(() => ({ ok: true })),
      signOut: async () => { clearSession(); return { ok: true }; },
      deleteAccount: async () => { await apiRequest("/v1/account", { method: "DELETE" }); clearSession(); return { ok: true }; }
    },
    api: {
      entitlement: () => apiRequest<SubscriptionState>("/v1/entitlement"),
      referral: () => apiRequest("/v1/referral"),
      // Unauthenticated: how this backend takes payment. Falls back to the card
      // flow if the backend is older than the route or cannot be reached.
      publicConfig: async () => {
        try {
          const response = await fetch(`${BACKEND}/v1/config`);
          if (!response.ok) throw new Error("unavailable");
          return await response.json() as { billingMode: string; billingContactEmail: string };
        } catch {
          return { billingMode: "stripe", billingContactEmail: "" };
        }
      },
      simulateCheckout: (plan: PlanId, interval: BillingInterval) => apiRequest<SubscriptionState>("/v1/billing/simulate", { body: { plan, interval } }),
      checkout: async (plan: PlanId, interval: BillingInterval) => {
        const result = await apiRequest<{ url: string }>("/v1/billing/checkout", { body: { plan, interval } });
        window.open(result.url, "_blank");
        return { opened: true };
      },
      changePlan: async (plan: PlanId, interval: BillingInterval) => {
        const result = await apiRequest<SubscriptionState | { url?: string }>("/v1/billing/change-plan", { body: { plan, interval } });
        if (result && typeof (result as { url?: string }).url === "string") {
          window.open((result as { url: string }).url, "_blank");
          return { opened: true };
        }
        return result as SubscriptionState;
      },
      portal: async () => {
        const result = await apiRequest<{ url: string }>("/v1/billing/portal", { method: "POST" });
        window.open(result.url, "_blank");
        return { opened: true };
      },
      createRun: (task: string, model: ModelTier) => apiRequest<{ runId: string }>("/v1/runs", { body: { task, model } }),
      nextRun: (runId: string, result?: { toolUseId: string; ok: boolean; output: string }) =>
        apiRequest(`/v1/runs/${runId}/next`, { body: { result } })
    },
    chat: {
      send: async (payload: { text: string } & Record<string, unknown>) => {
        const requestId = crypto.randomUUID();
        void streamChat(requestId, payload);
        return { requestId };
      },
      onDelta: (cb: (envelope: ChatDeltaEnvelope) => void) => {
        deltaListeners.add(cb);
        return () => deltaListeners.delete(cb);
      },
      stop: async (requestId: string) => {
        chatAborts.get(requestId)?.abort();
        chatAborts.delete(requestId);
        return { stopped: true };
      }
    },
    conversations: {
      list: async () => {
        const result = await apiRequest<{ conversations?: unknown[] }>("/v1/conversations");
        return (Array.isArray(result?.conversations) ? result.conversations : []) as never;
      },
      get: async (id: string) => {
        const result = await apiRequest<{ conversation?: Record<string, unknown>; messages?: unknown[] }>(`/v1/conversations/${id}`);
        return { ...(result?.conversation ?? {}), messages: Array.isArray(result?.messages) ? result.messages : [] } as never;
      },
      delete: (id: string) => apiRequest<{ deleted: boolean }>(`/v1/conversations/${id}`, { method: "DELETE" }),
      rename: (id: string, title: string) => apiRequest<{ ok: boolean }>(`/v1/conversations/${id}`, { method: "PATCH", body: { title } }),
      setPinned: (id: string, pinned: boolean) => apiRequest<{ ok: boolean }>(`/v1/conversations/${id}`, { method: "PATCH", body: { pinned } })
    },
    automation: {
      execute: async (action: AutomationAction): Promise<string> => {
        if (action.kind === "finish") return action.summary;
        return desktopOnly("Running automations");
      },
      launchBrowser: async () => desktopOnly("Browser automation"),
      stop: async () => ({ stopped: true }),
      overlay: async () => ({ shown: false })
    },
    recorder: {
      start: async () => desktopOnly("Recording"),
      stop: async () => desktopOnly("Recording"),
      summarize: async (_surface: "browser" | "windows", _events: RecordedEvent[]) => desktopOnly("Recording")
    },
    dictation: {
      transcribe: async () => desktopOnly("Voice input"),
      onStatus: () => () => undefined
    },
    files: {
      pick: () => pickViaDialog(),
      pickFolder: async () => desktopOnly("Working in a folder"),
      folderTree: async () => desktopOnly("Working in a folder"),
      pathKind: async (path: string) => (pickedFiles.has(path) ? ("file" as const) : ("missing" as const)),
      pathForFile: (file: File) => rememberFile(file).path,
      save: async (payload: SaveFileRequest): Promise<SaveFileResult> => {
        const bytes = await generateExport(payload.ext, payload.content);
        const blob = new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = payload.name.endsWith(`.${payload.ext}`) ? payload.name : `${payload.name}.${payload.ext}`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        return { saved: true, path: anchor.download };
      }
    },
    attachments: {
      upload: async (files: { path: string; name: string; size: number }[]): Promise<AttachmentRef[]> => {
        const refs: AttachmentRef[] = [];
        for (const entry of files) {
          const file = pickedFiles.get(entry.path);
          if (!file) continue;
          const base64 = toBase64(await file.arrayBuffer());
          try {
            const ref = await apiRequest<AttachmentRef>("/v1/attachments", {
              body: { filename: entry.name, mimeType: file.type || "application/octet-stream", base64 }
            });
            if (ref) refs.push(ref);
          } catch { /* skip a failed file, keep the rest */ }
        }
        return refs;
      },
      uploadBytes: async (name: string, mimeType: string, bytes: ArrayBuffer): Promise<AttachmentRef | null> => {
        try {
          return await apiRequest<AttachmentRef>("/v1/attachments", { body: { filename: name, mimeType, base64: toBase64(bytes) } });
        } catch {
          return null;
        }
      }
    }
  };
  return bridge as unknown as WorkCrewBridge;
}

export { DOWNLOAD_URL };
