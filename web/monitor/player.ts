// ▶ Play on a bubble: exactly what Gemini heard, or what Fish said (RECORD_CALLS=1).
// One at a time; the buttons always show what's playing, also when playing fails.

let player: HTMLAudioElement | null = null;
let playing: string | null = null;

/** Every play button's label from what's playing (after a redraw, too). */
export function paintPlayer(root: ParentNode = document): void {
  for (const b of root.querySelectorAll<HTMLButtonElement>("button.play")) {
    const on = b.dataset.src === playing;
    b.textContent = on ? "■ Stop" : "▶ Play";
    b.setAttribute("aria-pressed", String(on));
  }
}

/** Plays src, or stops it if it's what's playing. */
export function togglePlay(src: string): void {
  const was = playing;
  if (player) { player.pause(); player = null; playing = null; }
  if (was === src) { paintPlayer(); return; }
  const audio = new Audio(src);
  player = audio;
  playing = src;
  const done = (): void => {
    if (player !== audio) return;
    player = null;
    playing = null;
    paintPlayer();
  };
  audio.onended = done;
  audio.onerror = done;
  audio.play().catch(done);
  paintPlayer();
}
