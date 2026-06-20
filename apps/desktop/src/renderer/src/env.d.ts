/// <reference types="vite/client" />

import type { WorkCrewBridge } from "../../preload/index";

declare global {
  interface Window {
    workcrew: WorkCrewBridge;
  }
}

export {};
