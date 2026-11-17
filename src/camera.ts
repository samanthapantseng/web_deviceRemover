/** Longest side of the frames we process and display. */
export const MAX_SIDE = 640;

export interface FrameSource {
  readonly element: HTMLVideoElement | HTMLCanvasElement;
  /** Processing size: the source scaled so its longest side is at most MAX_SIDE. */
  readonly width: number;
  readonly height: number;
  readonly label: string;
  /** Resolves when a frame newer than the last one handed out is available. */
  nextFrame(): Promise<void>;
  stop(): void;
}

function fit(w: number, h: number): { width: number; height: number } {
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  return { width: Math.round((w * s) / 2) * 2, height: Math.round((h * s) / 2) * 2 };
}

/** 'front': the camera on the screen side (the only one on a Mac); 'back': an iPad's rear camera. */
export type CameraFacing = 'front' | 'back';

export async function openCamera(facing: CameraFacing = 'front'): Promise<FrameSource> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera API unavailable. Open the page on http://localhost or over https.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 },
      // A preference, not a demand: a Mac has one camera and returns it either way.
      facingMode: facing === 'back' ? 'environment' : 'user',
    },
  });
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  while (!video.videoWidth) await new Promise((r) => setTimeout(r, 30));

  const size = fit(video.videoWidth, video.videoHeight);
  const track = stream.getVideoTracks()[0];
  return {
    element: video,
    ...size,
    label: `${track.label || 'camera'} ${video.videoWidth}×${video.videoHeight}`,
    nextFrame: frameWaiter(video),
    stop: () => stream.getTracks().forEach((t) => t.stop()),
  };
}

/**
 * Returns a function that resolves once the video has a frame we have not handed out yet:
 * immediately if one arrived while the pipeline was busy, otherwise when the next one does.
 * (Polling `currentTime` is not enough: it advances between frames, so the same camera
 * frame would be processed twice.)
 */
function frameWaiter(video: HTMLVideoElement): () => Promise<void> {
  const supported = typeof (video as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === 'function';
  if (!supported) {
    let last = -1;
    return () =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (video.readyState >= 2 && video.currentTime !== last) {
            last = video.currentTime;
            resolve();
          } else {
            requestAnimationFrame(check);
          }
        };
        check();
      });
  }
  let arrived = 0;
  let taken = 0;
  let waiting: (() => void) | null = null;
  const onFrame = () => {
    arrived++;
    waiting?.();
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
  return () =>
    new Promise<void>((resolve) => {
      const take = () => {
        waiting = null;
        taken = arrived;
        resolve();
      };
      if (arrived !== taken) take();
      else {
        waiting = take;
        // Safety net: if frame callbacks stall (tab in the background), keep the pipeline alive.
        setTimeout(() => waiting === take && take(), 250);
      }
    });
}

/** Grab one frame from the webcam and release the camera again. */
export async function captureStill(
  countdown?: (secondsLeft: number) => void,
  seconds = 3,
  facing: CameraFacing = 'front',
): Promise<HTMLCanvasElement> {
  const cam = await openCamera(facing);
  try {
    for (let s = seconds; s > 0; s--) {
      countdown?.(s);
      await new Promise((r) => setTimeout(r, 1000));
    }
    countdown?.(0);
    await cam.nextFrame();
    return imageToCanvas(cam.element, cam.width, cam.height);
  } finally {
    cam.stop();
  }
}

export function imageToCanvas(src: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d', { willReadFrequently: true })!.drawImage(src, 0, 0, width, height);
  return canvas;
}

export async function loadImage(url: string): Promise<HTMLCanvasElement> {
  // createImageBitmap rather than <img>.decode(): decode() waits for a rendering opportunity
  // and never resolves in a tab that is not being painted.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load image ${url} (${res.status})`);
  const bitmap = await createImageBitmap(await res.blob());
  const size = fit(bitmap.width, bitmap.height);
  const canvas = imageToCanvas(bitmap, size.width, size.height);
  bitmap.close();
  return canvas;
}

/**
 * A still image posing as a 30 fps camera. Used with `?src=<image url>` to exercise and time
 * the whole live pipeline without a person in front of the camera.
 */
export async function openStill(url: string): Promise<FrameSource> {
  const canvas = await loadImage(url);
  let last = 0;
  return {
    element: canvas,
    width: canvas.width,
    height: canvas.height,
    label: `still ${canvas.width}×${canvas.height}`,
    // Like a camera: a new frame every 1/30 s, available at once if that long has already passed.
    nextFrame: () =>
      new Promise<void>((resolve) => {
        setTimeout(
          () => {
            last = performance.now();
            resolve();
          },
          Math.max(0, last + 1000 / 30 - performance.now()),
        );
      }),
    stop: () => undefined,
  };
}
