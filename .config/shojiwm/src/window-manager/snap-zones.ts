import type { LayoutSnapZone, SnapColumn, SnapZone } from "./state";

export function isLayoutSnapZone(zone: SnapZone | null): zone is LayoutSnapZone {
  return zone !== null && zone !== "maximize";
}

export function isLeftSnapZone(zone: LayoutSnapZone): boolean {
  return zone === "left" || zone === "top-left" || zone === "bottom-left";
}

export function isRightSnapZone(zone: LayoutSnapZone): boolean {
  return zone === "right" || zone === "top-right" || zone === "bottom-right";
}

export function isTopSnapZone(zone: LayoutSnapZone): boolean {
  return zone === "top-left" || zone === "top-right";
}

export function isBottomSnapZone(zone: LayoutSnapZone): boolean {
  return zone === "bottom-left" || zone === "bottom-right";
}

export function snapColumn(zone: LayoutSnapZone): SnapColumn {
  return isLeftSnapZone(zone) ? "left" : "right";
}

export function snapZonesConflict(
  current: SnapZone | null,
  next: LayoutSnapZone,
): boolean {
  if (!isLayoutSnapZone(current)) {
    return false;
  }
  if (current === next) {
    return true;
  }

  if (next === "left") {
    return current === "top-left" || current === "bottom-left";
  }
  if (next === "right") {
    return current === "top-right" || current === "bottom-right";
  }
  if (current === "left") {
    return next === "top-left" || next === "bottom-left";
  }
  if (current === "right") {
    return next === "top-right" || next === "bottom-right";
  }
  return false;
}
