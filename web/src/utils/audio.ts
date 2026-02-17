/**
 * Web Audio API helper for completion sounds.
 * AudioContext is created lazily on first user gesture to satisfy
 * browser autoplay policies.
 */

let audioCtx: AudioContext | null = null;
let unlocked = false;

function ensureContext(): AudioContext | null {
  if (!audioCtx) {
    try {
      audioCtx = new AudioContext();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

/** Unlock AudioContext on first user gesture (click/keydown). */
function tryUnlock(): void {
  if (unlocked) return;
  const ctx = ensureContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  unlocked = true;
}

// Attach unlock listeners
if (typeof document !== "undefined") {
  document.addEventListener("click", tryUnlock, { once: true });
  document.addEventListener("keydown", tryUnlock, { once: true });
}

/** Play a short completion beep (440Hz, 200ms). */
export function playCompletionSound(): void {
  const ctx = ensureContext();
  if (!ctx || ctx.state !== "running") return;

  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.connect(gain);
  gain.connect(ctx.destination);

  oscillator.type = "sine";
  oscillator.frequency.value = 440;
  gain.gain.value = 0.15;

  // Quick fade out to avoid click
  gain.gain.setValueAtTime(0.15, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);

  oscillator.start(ctx.currentTime);
  oscillator.stop(ctx.currentTime + 0.2);
}
