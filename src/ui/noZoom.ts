/**
 * No zooming on a touch screen: a double-tap on the picture opens the panel and must not also
 * zoom the page, and a pinch must not leave it zoomed in.
 *
 * style.css already asks for this (touch-action). Safari on the iPad zoomed on a double-tap all
 * the same, so here the gestures are cancelled too. Taps on the panel and on buttons are left
 * alone: cancelling those would also cancel the click.
 */
const CONTROLS = '.panel, button, input, select, label, a';

export function noZoom(): void {
  document.addEventListener(
    'touchend',
    (e) => {
      if (e.cancelable && e.target instanceof Element && !e.target.closest(CONTROLS)) e.preventDefault();
    },
    { passive: false },
  );
  // Safari's own events for a pinch.
  for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('dblclick', (e) => e.preventDefault());
}
