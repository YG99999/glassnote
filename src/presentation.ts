// Prepare the material while the native window is still hidden. The renderer
// warms its first canvas synchronously, so hidden-window RAF throttling is safe.
export function prepareGlass(): Promise<void> {
  return new Promise(resolve => {
    const complete = () => {
      clearTimeout(timeout);
      document.removeEventListener("glass-ready", complete);
      resolve();
    };
    // Unsupported or slow graphics must never prevent a usable CSS surface.
    const timeout = setTimeout(complete, 300);
    document.addEventListener("glass-ready", complete, { once: true });
    const script = document.createElement("script"); script.src = "/glass.js";
    script.onerror = complete; document.body.append(script);
  });
}

export function afterPaint(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

export async function leaveOverlay(): Promise<void> {
  document.body.classList.add("overlay-leaving");
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
    await new Promise(resolve => setTimeout(resolve, 180));
}
