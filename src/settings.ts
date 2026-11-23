import type { CameraFacing } from "./camera";

/**
 * What happens to a phone: erased ("remove"), blown up ("grow"), or listened to ("hijack": the
 * phone in focus gets a soundscape of its own, in headphones; the picture stays as it is).
 */
export type ModeId = "remove" | "grow" | "hijack";
/** Hijack mode: the conversations a person can be in (src/audio/scenes.ts). */
export type SceneId = "comfort" | "catchup" | "argument" | "voicenote" | "secret";
/** Hijack mode: "auto" gives each person their own conversation; otherwise everyone has that one. */
export type HijackScene = "auto" | SceneId;
/**
 * Grow mode: what is enlarged. "hand": the mask (as "mask") plus the hand on the phone, from the
 * detector's person mask (`growReach`); "mask": the detector's mask, with the dents fingers make
 * in it filled (`growFill`); "hull": the mask's convex hull; "rectangle": a rectangle around it.
 */
export type GrowShape = "hand" | "mask" | "hull" | "rectangle";
export type FillId = "migan" | "telea" | "stylised";
export type StyleVariant = "void" | "flat" | "blur";
/** The -320 models take 320×320 input instead of 640×640: about 4× faster, but miss small phones. */
export type DetectorModel =
    | "yolo11s-seg"
    | "yolo11n-seg"
    | "yolo11s-seg-320"
    | "yolo11n-seg-320";

export interface Settings {
    mode: ModeId;
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
    /** Grow mode: the shape that is enlarged (see GrowShape). */
    growShape: GrowShape;
    /**
     * Grow mode, mask shape: fill the dents fingers make in the mask up to about twice this
     * radius, as a share of the phone's size (square root of its area). 0: the exact mask.
     */
    growFill: number;
    /**
     * Grow mode, hand shape: how far along the hand, from the fingers on the phone, it is taken
     * along (fading out towards the end), as a share of the phone box's longer side (at most 0.6).
     */
    growReach: number;
    /** Grow mode: size of a phone the moment it is decided on, as a multiple of its real size. */
    growStart: number;
    /** Grow mode: the size it inflates to. */
    growMax: number;
    /** Grow mode: seconds it takes to get from growStart to growMax. */
    growSeconds: number;
    /**
     * Grow mode, 0..0.9: how much of the previous frame's shape is kept (rectangle: its angle and
     * size; mask: the cut-out itself). Damps wobble.
     */
    growSmoothing: number;
    /** Hijack mode: which conversation a person is in (see HijackScene). */
    hijackScene: HijackScene;
    /** Hijack mode: loudness, 0..1 (the output is limited whatever this is). */
    hijackVolume: number;
    /**
     * Hijack mode: radius of the focus zone around the centre of the picture, as a share of half
     * the picture's shorter side. A phone inside it can be listened to; the closer to the centre,
     * the clearer.
     */
    hijackZone: number;
    /** Hijack mode: how long a new phone is watched before it counts (ms). Replaces `watchMs` there. */
    hijackWatchMs: number;
    /** Hijack mode: how long the sound carries on when the phone in focus is lost (ms), before it fades. */
    hijackHoldMs: number;
    /** Hijack mode: seconds of holding a phone until the conversation is at its most intimate. */
    hijackBuildSeconds: number;
}

export const DEFAULTS: Settings = {
    mode: "remove",
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
    growShape: "hand",
    growFill: 0.15,
    growReach: 0.25,
    growStart: 1,
    growMax: 2,
    growSeconds: 5,
    growSmoothing: 0.5,
    hijackScene: "auto",
    hijackVolume: 0.5,
    hijackZone: 0.6,
    hijackWatchMs: 500,
    hijackHoldMs: 2000,
    hijackBuildSeconds: 30,
};

/**
 * Defaults that were changed, with their earlier values. Settings are saved as a whole, so a
 * saved value equal to an earlier default was most likely never chosen; it follows the new
 * default instead.
 */
const OLD_DEFAULTS: { [K in keyof Settings]?: Settings[K][] } = {
    growShape: ["rectangle", "hull", "mask"],
    growStart: [1.2],
    growMax: [5],
    growSeconds: [30],
};

export const MODE_ORDER: ModeId[] = ["remove", "grow", "hijack"];
export const SCENE_IDS: SceneId[] = ["comfort", "catchup", "argument", "voicenote", "secret"];
export const HIJACK_SCENES: HijackScene[] = ["auto", ...SCENE_IDS];
export const GROW_SHAPES: GrowShape[] = ["hand", "mask", "hull", "rectangle"];

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
        for (const [k, old] of Object.entries(OLD_DEFAULTS))
            if ((old as unknown[]).includes((saved as Record<string, unknown>)[k]))
                delete (saved as Record<string, unknown>)[k];
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
