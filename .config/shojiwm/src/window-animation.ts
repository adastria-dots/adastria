import {
    read,
    type EasingFunction,
    type WaylandWindow,
    type WindowStateKey,
} from "shoji_wm";
import type { ManagedWindowRect } from "shoji_wm/types";

export interface RectAnimationOptions {
    suppressSSDRebuild?: boolean;
}

interface RectAnimationTarget {
    target: ManagedWindowRect;
    token: number;
}

const activeRectAnimationTargetByWindow = new WeakMap<WaylandWindow, Map<symbol, RectAnimationTarget>>();
let rectAnimationToken = 0;

function rectAnimationChannel(windowRectState: WindowStateKey<ManagedWindowRect>): string {
    return `rect:${windowRectState.description ?? "anon"}`;
}

function snapshotRect(rect: ManagedWindowRect): ManagedWindowRect {
    return {
        x: read(rect.x),
        y: read(rect.y),
        width: read(rect.width),
        height: read(rect.height),
    };
}

function sameRect(a: ManagedWindowRect, b: ManagedWindowRect): boolean {
    return read(a.x) === read(b.x)
        && read(a.y) === read(b.y)
        && read(a.width) === read(b.width)
        && read(a.height) === read(b.height);
}

function activeRectTarget(window: WaylandWindow, windowRectState: WindowStateKey<ManagedWindowRect>): RectAnimationTarget | undefined {
    return activeRectAnimationTargetByWindow.get(window)?.get(windowRectState);
}

function setActiveRectTarget(
    window: WaylandWindow,
    windowRectState: WindowStateKey<ManagedWindowRect>,
    target: RectAnimationTarget | undefined,
): void {
    let perWindow = activeRectAnimationTargetByWindow.get(window);
    if (!perWindow) {
        perWindow = new Map();
        activeRectAnimationTargetByWindow.set(window, perWindow);
    }

    if (target) {
        perWindow.set(windowRectState, target);
    } else {
        perWindow.delete(windowRectState);
    }
}

function clearActiveRectTarget(
    window: WaylandWindow,
    windowRectState: WindowStateKey<ManagedWindowRect>,
    token: number,
): void {
    if (activeRectTarget(window, windowRectState)?.token === token) {
        setActiveRectTarget(window, windowRectState, undefined);
    }
}

export function playRectAnimation(
    window: WaylandWindow,
    windowRectState: WindowStateKey<ManagedWindowRect>,
    to: ManagedWindowRect,
    easing: EasingFunction,
    duration: number,
    _options: RectAnimationOptions = {},
): void {
    const from = snapshotRect(window.state[windowRectState]());
    const target = snapshotRect(to);

    // Idempotent: re-scheduling mid-interpolation races focus reevaluations.
    const previousTarget = activeRectTarget(window, windowRectState)?.target;
    if (previousTarget && sameRect(previousTarget, target)) {
        return;
    }

    // Rust owns frame-by-frame interpolation; falls back to this on cancel.
    window.state[windowRectState].set(target);
    const token = ++rectAnimationToken;
    setActiveRectTarget(window, windowRectState, { target, token });
    window.scheduleAnimation({
        channel: rectAnimationChannel(windowRectState),
        rect: {
            from,
            to: target,
            duration,
            easing,
            mode: "override",
        },
    });
    setTimeout(() => {
        clearActiveRectTarget(window, windowRectState, token);
    }, duration);
}

export function stopRectAnimation(
    window: WaylandWindow,
    windowRectState: WindowStateKey<ManagedWindowRect>,
): void {
    setActiveRectTarget(window, windowRectState, undefined);
    window.cancelAnimation(rectAnimationChannel(windowRectState));
}
