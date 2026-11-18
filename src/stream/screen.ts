/**
 * Fullscreen and wake lock for the iPad's stream page. The same small helpers as in main.ts,
 * copied rather than moved so the standalone page's code stays untouched.
 */

type FullscreenDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FullscreenEl = HTMLElement & { webkitRequestFullscreen?: () => void };

export function toggleFullscreen(): void {
  const doc = document as FullscreenDoc;
  const el = document.documentElement as FullscreenEl;
  if (doc.fullscreenElement ?? doc.webkitFullscreenElement) {
    if (typeof doc.exitFullscreen === 'function') void doc.exitFullscreen().catch(() => undefined);
    else doc.webkitExitFullscreen?.();
  } else if (typeof el.requestFullscreen === 'function') {
    void el.requestFullscreen().catch(() => undefined);
  } else {
    el.webkitRequestFullscreen?.(); // older Safari on iPad
  }
}

/** Keep the screen on while the page is open (an iPad locks itself after a few minutes). */
export function keepScreenOn(): void {
  const request = async () => {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<unknown> } };
    try {
      await nav.wakeLock?.request('screen');
    } catch {
      /* unsupported, or not allowed until the first tap */
    }
  };
  void request();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void request());
  window.addEventListener('pointerdown', () => void request(), { once: true });
}
