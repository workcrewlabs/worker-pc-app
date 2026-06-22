import { join } from "node:path";
import { app, BrowserWindow } from "electron";

// On-device speech to text. A small Whisper model runs on the CPU in this
// background process via transformers.js. The renderer captures the microphone
// and sends 16 kHz mono samples here, so the audio itself never leaves the PC;
// only the model is downloaded once (cached under the app's data folder) and
// then it works offline. No API key, no per-use cost.

type AsrPipeline = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text?: string }>;

// The model is loaded lazily on first use and reused after that.
let pipelinePromise: Promise<AsrPipeline> | null = null;

function broadcastStatus(status: { state: string; progress?: number }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("dictation:status", status);
  }
}

async function getPipeline(): Promise<AsrPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      // Loaded lazily and kept external from the bundle, so the model toolkit is
      // only touched the first time voice is used.
      const specifier = "@huggingface/transformers";
      const transformers = (await import(specifier)) as {
        pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<AsrPipeline>;
        env: { cacheDir?: string; allowRemoteModels?: boolean };
      };
      transformers.env.cacheDir = join(app.getPath("userData"), "voice-model");
      transformers.env.allowRemoteModels = true;
      broadcastStatus({ state: "preparing" });
      const pipe = await transformers.pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", {
        // Report download progress on first use so the UI can show a one-time setup.
        progress_callback: (info: { status?: string; progress?: number }) => {
          if (typeof info?.progress === "number") broadcastStatus({ state: "downloading", progress: Math.round(info.progress) });
        }
      });
      broadcastStatus({ state: "ready" });
      return pipe;
    })();
    // If the load fails, allow a later retry rather than caching the rejection.
    pipelinePromise.catch(() => {
      pipelinePromise = null;
    });
  }
  return pipelinePromise;
}

/** Transcribe 16 kHz mono PCM samples to text. Returns "" for empty/too-short audio. */
export async function transcribeSamples(samples: Float32Array): Promise<string> {
  if (!samples || samples.length < 1_600) return "";
  const transcribe = await getPipeline();
  // chunk_length_s lets clips longer than 30 seconds transcribe correctly.
  const result = await transcribe(samples, { chunk_length_s: 30, stride_length_s: 5 });
  return (result?.text ?? "").trim();
}
