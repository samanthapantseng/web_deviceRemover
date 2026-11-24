/**
 * Fullscreen and wake lock for the iPad's stream page. Much the same small helpers as in main.ts,
 * copied rather than moved so the standalone page's code stays untouched.
 */

type FullscreenDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FullscreenEl = HTMLElement & { webkitRequestFullscreen?: () => void };

export function isFullscreen(): boolean {
  const doc = document as FullscreenDoc;
  return !!(doc.fullscreenElement ?? doc.webkitFullscreenElement);
}

/** Opened from the Home Screen as an app: there are no browser bars to get rid of. */
const asApp = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;

/** Whether there is anything to do: not already an app, and the browser can. */
export function canFullscreen(): boolean {
  const el = document.documentElement as FullscreenEl;
  return !asApp && (typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function');
}

/** Browsers only do this from within a touch, click or key press; otherwise nothing happens. */
export function enterFullscreen(): void {
  const el = document.documentElement as FullscreenEl;
  if (typeof el.requestFullscreen === 'function') void el.requestFullscreen().catch(() => undefined);
  else el.webkitRequestFullscreen?.(); // older Safari on iPad
}

export function exitFullscreen(): void {
  const doc = document as FullscreenDoc;
  if (typeof doc.exitFullscreen === 'function') void doc.exitFullscreen().catch(() => undefined);
  else doc.webkitExitFullscreen?.();
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
