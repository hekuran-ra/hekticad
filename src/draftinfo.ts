/**
 * Tool-aware live readout used by the crosshair label AND the bottom status
 * bar. Returns a concise string that mirrors the fields the user is about to
 * fill in via cmdbar — so while drawing a rect you see `B 120  H 80`,
 * while placing a circle you see `R 45`, while drawing a line you see
 * `∠ 15°  L 120`, etc.
 *
 * Returning `null` means "there's nothing tool-specific to show" (idle or a
 * step that doesn't have a live value) — callers then fall back to world XY.
 */

import type { Pt, ToolCtx } from './types';
import { state, runtime } from './state';

function foldAngle(angDeg: number): number {
  // Angle input (`directionAtAngle` in math.ts) is always interpreted relative
  // to the NEAREST cardinal axis, so the display should also be the distance
  // to the nearest cardinal — max 45°. Typed 15° always reads back as 15°
  // regardless of quadrant.
  const mod90 = ((angDeg % 90) + 90) % 90;
  return Math.min(mod90, 90 - mod90);
}

function angleLen(anchor: Pt, cursor: Pt, tc: ToolCtx): { ang: number; len: number } {
  const dx = cursor.x - anchor.x;
  const dy = cursor.y - anchor.y;
  let len: number;
  let ang: number;
  if (tc.lockedDir) {
    const signed = dx * tc.lockedDir.x + dy * tc.lockedDir.y;
    len = Math.abs(signed);
    ang = Math.atan2(tc.lockedDir.y, tc.lockedDir.x) * 180 / Math.PI;
  } else {
    len = Math.hypot(dx, dy);
    ang = Math.atan2(dy, dx) * 180 / Math.PI;
  }
  return { ang: foldAngle(ang), len };
}

function fmt(n: number): string {
  return n.toFixed(2);
}

export function getDraftInfo(): string | null {
  const tc = runtime.toolCtx;
  if (!tc) return null;
  const world = runtime.lastSnap ?? state.mouseWorld;
  const tool = state.tool;

  // Drawing: line / polyline — ∠ + L from last anchor.
  if (tool === 'line' && tc.step === 'p2' && tc.p1) {
    const { ang, len } = angleLen(tc.p1, world, tc);
    return `∠ ${ang.toFixed(1)}°  L ${fmt(len)}`;
  }
  if (tool === 'polyline' && tc.pts && tc.pts.length > 0) {
    const last = tc.pts[tc.pts.length - 1];
    const { ang, len } = angleLen(last, world, tc);
    return `∠ ${ang.toFixed(1)}°  L ${fmt(len)}`;
  }
  if (tool === 'spline' && tc.pts && tc.pts.length > 0) {
    const last = tc.pts[tc.pts.length - 1];
    const { ang, len } = angleLen(last, world, tc);
    return `∠ ${ang.toFixed(1)}°  L ${fmt(len)}`;
  }

  // Rect — width + height respected. If user locked one of them, show lock.
  if (tool === 'rect' && tc.step === 'dims' && tc.p1) {
    const w = tc.horizontal != null ? tc.horizontal : Math.abs(world.x - tc.p1.x);
    const h = tc.vertical   != null ? tc.vertical   : Math.abs(world.y - tc.p1.y);
    return `B ${fmt(w)}  H ${fmt(h)}`;
  }

  // Circles / arcs / ref_circle / polygon — radius from the center.
  if (tool === 'circle' && tc.cx != null && tc.cy != null) {
    const r = Math.hypot(world.x - tc.cx, world.y - tc.cy);
    return `R ${fmt(r)}`;
  }
  if (tool === 'ref_circle' && tc.cx != null && tc.cy != null) {
    const r = Math.hypot(world.x - tc.cx, world.y - tc.cy);
    return `R ${fmt(r)}`;
  }
  if (tool === 'polygon' && tc.cx != null && tc.cy != null) {
    const r = Math.hypot(world.x - tc.cx, world.y - tc.cy);
    return `R ${fmt(r)}`;
  }
  if (tool === 'circle3' && tc.click1 && tc.click2) {
    // Third click defines the circle — no single anchor to compute R against.
    return null;
  }
  if (tool === 'arc3') {
    return null;
  }

  // Ellipse — axis-1 shows length + angle; axis-2 only length.
  if (tool === 'ellipse' && tc.centerPt) {
    if (tc.step === 'axis1') {
      const { ang, len } = angleLen(tc.centerPt, world, tc);
      return `a ${fmt(len)}  ∠ ${ang.toFixed(1)}°`;
    }
    if (tc.step === 'axis2' && tc.angleDeg != null) {
      // Project onto the axis-1 perpendicular for a clean live radius.
      const rad = (tc.angleDeg + 90) * Math.PI / 180;
      const ux = Math.cos(rad), uy = Math.sin(rad);
      const dx = world.x - tc.centerPt.x, dy = world.y - tc.centerPt.y;
      const b = Math.abs(dx * ux + dy * uy);
      return `b ${fmt(b)}`;
    }
  }

  // Modify — move / copy / stretch from base point.
  if ((tool === 'move' || tool === 'copy' || tool === 'stretch') && tc.basePt) {
    const dx = world.x - tc.basePt.x;
    const dy = world.y - tc.basePt.y;
    const d = Math.hypot(dx, dy);
    return `Δ ${fmt(dx)}, ${fmt(dy)}  L ${fmt(d)}`;
  }

  // Rotate — angle from center relative to reference direction.
  if (tool === 'rotate' && tc.centerPt) {
    if (tc.a1) {
      const a0 = Math.atan2(tc.a1.y - tc.centerPt.y, tc.a1.x - tc.centerPt.x);
      const a1 = Math.atan2(world.y - tc.centerPt.y, world.x - tc.centerPt.x);
      let diff = (a1 - a0) * 180 / Math.PI;
      diff = ((diff + 180) % 360 + 360) % 360 - 180;
      return `∠ ${Math.abs(diff).toFixed(1)}°`;
    }
    const { ang } = angleLen(tc.centerPt, world, tc);
    return `∠ ${ang.toFixed(1)}°`;
  }

  // Scale — factor = current distance / reference length.
  if (tool === 'scale' && tc.basePt) {
    if (tc.refLen != null && tc.refLen > 0) {
      const d = Math.hypot(world.x - tc.basePt.x, world.y - tc.basePt.y);
      return `Faktor ${(d / tc.refLen).toFixed(3)}`;
    }
    const d = Math.hypot(world.x - tc.basePt.x, world.y - tc.basePt.y);
    return `Ref-L ${fmt(d)}`;
  }

  // Mirror — second axis point → angle from first axis point.
  if (tool === 'mirror' && tc.step === 'axis2' && tc.a1) {
    const { ang } = angleLen(tc.a1, world, tc);
    return `∠ ${ang.toFixed(1)}°`;
  }

  // Offset — while picking a side show the locked Versatz distance when
  // the user has typed one (the crosshair value is the anchor, not the live
  // perpendicular — computing that would pull the entity-distance helpers
  // out of tools.ts and create an import cycle).
  if (tool === 'offset' && tc.step === 'side' && tc.distance != null) {
    return `Versatz ${fmt(tc.distance)}`;
  }

  // Dimension — live offset distance from the measurement line.
  if (tool === 'dim' && tc.step === 'place' && tc.click1 && tc.click2) {
    return `Abstand ${fmt(Math.hypot(tc.click1.x - tc.click2.x, tc.click1.y - tc.click2.y))}`;
  }

  // Xline (Hilfslinie) — angle from anchor PLUS Δx/Δy relative to the
  // first-click anchor. The user explicitly asked for relative coords:
  // "die position müsste immer im verhältniss zum letzten klick sein".
  // Falling back to absolute world XY (the default at the bottom of this
  // function) made it hard to read off the offset from the anchor — now
  // each helpline shows where it lands relative to the point it was
  // started from.
  if (tool === 'xline' && tc.p1) {
    const dx = world.x - tc.p1.x;
    const dy = world.y - tc.p1.y;
    const { ang } = angleLen(tc.p1, world, tc);
    return `Δx ${fmt(dx)}  Δy ${fmt(dy)}  ∠ ${ang.toFixed(1)}°`;
  }
  // Parallel xline at distance-from-reference step — the bottom-bar
  // already shows angle/length info via the line tool, but for parallel
  // mode we want Versatz (perpendicular distance) which is what the user
  // is about to commit. Falls back to absolute when no ref is picked yet.
  if (tool === 'xline' && tc.base && tc.dir) {
    const px = world.x - tc.base.x, py = world.y - tc.base.y;
    const perp = Math.abs(-tc.dir.y * px + tc.dir.x * py);
    return `Versatz ${fmt(perp)}`;
  }

  // Angle measurement — angle at vertex.
  if (tool === 'angle' && tc.centerPt && tc.a1) {
    const a0 = Math.atan2(tc.a1.y - tc.centerPt.y, tc.a1.x - tc.centerPt.x);
    const a1 = Math.atan2(world.y - tc.centerPt.y, world.x - tc.centerPt.x);
    let diff = (a1 - a0) * 180 / Math.PI;
    diff = ((diff + 180) % 360 + 360) % 360 - 180;
    return `∠ ${Math.abs(diff).toFixed(1)}°`;
  }

  return null;
}
