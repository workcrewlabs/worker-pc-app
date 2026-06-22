// Microphone capture for on-device voice input. This records from the mic, then
// decodes the clip to 16 kHz mono PCM in the renderer (using the Web Audio API)
// and hands the samples to the main process, which transcribes them locally. The
// audio never leaves the machine.

type AudioContextCtor = typeof AudioContext;

export class Dictation {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  get recording(): boolean {
    return this.recorder !== null && this.recorder.state === "recording";
  }

  // Ask for the mic and start recording. Throws if the mic is unavailable or the
  // user blocks access.
  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start();
  }

  // Stop recording, decode, and transcribe locally. Returns the recognized text.
  async stopAndTranscribe(): Promise<string> {
    const blob = await this.finish();
    if (blob.size === 0) return "";
    const samples = await decodeTo16kMono(blob);
    return window.workcrew.dictation.transcribe(samples);
  }

  // Stop and discard without transcribing.
  cancel(): void {
    void this.finish();
  }

  private finish(): Promise<Blob> {
    return new Promise((resolve) => {
      const recorder = this.recorder;
      if (!recorder || recorder.state === "inactive") {
        this.cleanup();
        resolve(new Blob());
        return;
      }
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
        this.cleanup();
        resolve(blob);
      };
      recorder.stop();
    });
  }

  private cleanup(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
  }
}

// Decode any recorded clip to a single channel of 16 kHz float samples, the
// format the speech model expects.
async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  const buffer = await blob.arrayBuffer();
  const Ctor: AudioContextCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: AudioContextCtor }).webkitAudioContext;
  const context = new Ctor({ sampleRate: 16_000 });
  try {
    const decoded = await context.decodeAudioData(buffer);
    if (decoded.numberOfChannels === 1) return new Float32Array(decoded.getChannelData(0));
    // Average the channels down to mono.
    const left = decoded.getChannelData(0);
    const right = decoded.getChannelData(1);
    const mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; i += 1) mono[i] = (left[i]! + right[i]!) / 2;
    return mono;
  } finally {
    await context.close();
  }
}
