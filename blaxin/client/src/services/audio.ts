// BLAXIN // JARVIS — audio identity
// =============================================================
// Small centralized event → sound mapping (directive §23). Sounds are
// synthesized with WebAudio (no assets, no dependencies), short, subtle
// and recognizable. Repeated events are debounced; everything can be
// muted and the volume controlled. Audio only ever fires on REAL state
// transitions — it is driven by the app store, never on a timer.
// =============================================================

export type AudioEvent =
  | 'STARTUP' | 'READY' | 'CONNECTED' | 'DISCONNECTED'
  | 'LISTENING' | 'THINKING' | 'PLANNING' | 'ACTION_STARTED'
  | 'OBSERVATION' | 'VERIFICATION' | 'PERMISSION_REQUIRED'
  | 'WARNING' | 'ERROR' | 'CANCELLED' | 'TASK_COMPLETED';

type Note = [
  freq: number,
  startSec: number,
  durSec: number,
  type?: OscillatorType,
  peak?: number,
];

// Futuristic two/three-tone motifs. Gains stay low (subtle), durations
// stay short (never annoying), and only one sound plays per event window.
const SEQUENCES: Record<AudioEvent, Note[]> = {
  STARTUP: [[523.25, 0, 0.16, 'sine', 0.20], [783.99, 0.09, 0.24, 'sine', 0.18]],
  READY: [[659.25, 0, 0.26, 'sine', 0.15]],
  CONNECTED: [[392, 0, 0.12, 'sine', 0.16], [523.25, 0.08, 0.16, 'sine', 0.16]],
  DISCONNECTED: [[523.25, 0, 0.14, 'sine', 0.16], [392, 0.08, 0.2, 'sine', 0.16]],
  LISTENING: [[220, 0, 0.18, 'sine', 0.20]],
  THINKING: [[440, 0, 0.1, 'sine', 0.10]],
  PLANNING: [[329.63, 0, 0.1, 'sine', 0.14], [392, 0.07, 0.12, 'sine', 0.14]],
  ACTION_STARTED: [[880, 0, 0.06, 'sine', 0.12]],
  OBSERVATION: [[659.25, 0, 0.12, 'sine', 0.12]],
  VERIFICATION: [[659.25, 0, 0.08, 'sine', 0.14], [880, 0.06, 0.1, 'sine', 0.14]],
  PERMISSION_REQUIRED: [[587.33, 0, 0.12, 'triangle', 0.16], [783.99, 0.1, 0.16, 'triangle', 0.16]],
  WARNING: [[587.33, 0, 0.1, 'triangle', 0.18], [440, 0.09, 0.1, 'triangle', 0.18], [587.33, 0.18, 0.14, 'triangle', 0.18]],
  ERROR: [[220, 0, 0.28, 'sawtooth', 0.09], [174.61, 0, 0.28, 'sawtooth', 0.09]],
  CANCELLED: [[523.25, 0, 0.12, 'sine', 0.16], [329.63, 0.09, 0.2, 'sine', 0.16]],
  TASK_COMPLETED: [[523.25, 0, 0.1, 'sine', 0.16], [659.25, 0.08, 0.1, 'sine', 0.16], [783.99, 0.16, 0.22, 'sine', 0.16]],
};

/** Repeated events within this window are collapsed to one sound. */
const DEBOUNCE_MS = 350;

class AudioIdentity {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lastPlayed = new Map<AudioEvent, number>();
  private unlocked = false;

  muted = false;
  volume = 0.5;

  private ensure(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const AC = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return null;
    if (!this.ctx) {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    // Autoplay policy: an AudioContext created before any user gesture is
    // suspended; resume lazily on the next play (after unlock()).
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Call on the first user gesture so browsers allow audio. */
  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    this.ensure();
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  private tone(freq: number, start: number, dur: number, type: OscillatorType, peak: number): void {
    if (!this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + start;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    // Fast attack, exponential release — a clean short blip.
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  play(event: AudioEvent): void {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const now = Date.now();
    const last = this.lastPlayed.get(event) ?? 0;
    if (now - last < DEBOUNCE_MS) return;
    this.lastPlayed.set(event, now);
    for (const [freq, start, dur, type = 'sine', peak = 0.15] of SEQUENCES[event]) {
      this.tone(freq, start, dur, type, peak);
    }
  }
}

export const audioIdentity = new AudioIdentity();