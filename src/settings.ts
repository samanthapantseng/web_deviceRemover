import type { CameraFacing } from "./camera";

export type FillId = "migan" | "telea" | "stylised";
export type StyleVariant = "void" | "flat" | "blur";
/** The -320 models take 320×320 input instead of 640×640: about 4× faster, but miss small phones. */
export type DetectorModel =
    | "yolo11s-seg"
    | "yolo11n-seg"
    | "yolo11s-seg-320"
    | "yolo11n-seg-320";

export interface Settings {
    fill: FillId;
    /** Variant used when fill === 'stylised'. */
    style: StyleVariant;
    detector: DetectorModel;
    /** Which camera to ask for (only matters on a tablet or phone). */
    camera: CameraFacing;
    mirror: boolean;
    /** Fill the screen (crops the 4:3 camera image) instead of letterboxing it. */
    cover: boolean;
    showMask: boolean;
    /**
     * false: draw the live camera at full frame rate and lay the newest fill on top (fill can lag the hand).
     * true: draw the exact frame the fill was computed from (always consistent, but the whole view lags).
     */
    syncDisplay: boolean;
    /** Phone score at which one frame says "this is a phone". */
    confidence: number;
    /** Only count something as a phone if "cell phone" is the model's best guess for it. */
    topClassOnly: boolean;
    /**
     * A new phone-like object is watched this long (ms) before it may be erased; 0 erases at once.
     * See src/detect/tracker.ts.
     */
    watchMs: number;
    /**
     * It is erased if at least this share (0..1) of its frames over the last `watchMs` said
     * "phone"; once erased, it is let go when fewer than half that share do.
     */
    watchShare: number;
    /** Grow the phone mask by this many px. */
    dilate: number;
    /** Width in px of the soft edge beyond the dilated mask. */
    feather: number;
    /** Keep the last mask for this many pipeline frames when detection drops out. */
    holdFrames: number;
    /** A pixel that was phone stays in the mask for this long (ms). Hides frame-to-frame mask jitter. */
    persistMs: number;
    /** Minimum side (frame px) of the square context window handed to the inpainter. */
    cropSize: number;
    /** 0..0.9: how much of the previous fill is blended into the new one while the phone is still. */
    fillSmoothing: number;
}

export const DEFAULTS: Settings = {
    fill: "migan",
    style: "blur",
    detector: "yolo11s-seg",
    camera: "front",
    mirror: true,
    cover: true,
    showMask: false,
    syncDisplay: false,
    confidence: 0.6,
    topClassOnly: true,
    watchMs: 1000,
    watchShare: 0.67,
    dilate: 0,
    feather: 8,
    holdFrames: 5,
    persistMs: 150,
    cropSize: 320,
    fillSmoothing: 0.5,
};

export const FILL_ORDER: FillId[] = ["migan", "telea", "stylised"];
export const STYLE_ORDER: StyleVariant[] = ["blur", "flat", "void"];

const KEY = "device-remover.settings.v2";

type Listener = (s: Settings, changed: keyof Settings) => void;

export class SettingsStore {
    readonly value: Settings;
    private listeners = new Set<Listener>();

    constructor() {
        let saved: Partial<Settings> = {};
        try {
            saved = JSON.parse(
                localStorage.getItem(KEY) ?? "{}",
            ) as Partial<Settings>;
        } catch {
            /* corrupted or unavailable storage: fall back to defaults */
        }
        // Drop settings that no longer exist (e.g. the old reconfirmMs).
        for (const k of Object.keys(saved))
            if (!(k in DEFAULTS)) delete (saved as Record<string, unknown>)[k];
        this.value = { ...DEFAULTS, ...saved };
        // The mask overlay is a debugging aid; never come back from a reload with it on.
        this.value.showMask = false;
    }

    set<K extends keyof Settings>(key: K, v: Settings[K]): void {
        if (this.value[key] === v) return;
        this.value[key] = v;
        try {
            localStorage.setItem(KEY, JSON.stringify(this.value));
        } catch {
            /* private mode etc.: settings just won't persist */
        }
        for (const l of this.listeners) l(this.value, key);
    }

    reset(): void {
        for (const k of Object.keys(DEFAULTS) as (keyof Settings)[])
            this.set(k, DEFAULTS[k]);
    }

    onChange(l: Listener): void {
        this.listeners.add(l);
    }
}
