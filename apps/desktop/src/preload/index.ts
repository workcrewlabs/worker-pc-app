import { contextBridge, ipcRenderer } from "electron";
import type {
  AutomationAction,
  BillingInterval,
  ModelTier,
  PlanId,
  RunStepResponse,
  SubscriptionState
} from "@workcrew/contracts";

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
