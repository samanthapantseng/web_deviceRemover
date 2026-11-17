// OpenCV.js loader. Import this file with a dynamic import() so the ~10 MB library stays
// out of the main bundle.
//
// Trap, found the hard way: the OpenCV module object has a `then` method (old Emscripten),
// so it looks like a promise. Anything that awaits it, or resolves a promise with it, loops
// forever and freezes the tab. That includes `await import('@techstark/opencv-js')`, because
// Vite's CommonJS interop copies the module's properties (including `then`) onto the object
// it resolves the import with. Hence: static default import here, and the module is only
// ever handed out wrapped in `{ cv }`.
import cvModule from '@techstark/opencv-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Cv = any;

const cv = cvModule as Cv;

const ready = new Promise<void>((resolve) => {
  if (cv.Mat) resolve();
  else cv.onRuntimeInitialized = () => resolve();
}).then(() => {
  // The runtime is up; the fake `then` has no further use, so disarm it.
  delete cv.then;
});

export async function getOpenCv(): Promise<{ cv: Cv }> {
  await ready;
  return { cv };
}
