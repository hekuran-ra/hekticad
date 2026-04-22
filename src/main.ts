import './styles.css';

import type { Pt } from './types';
import { state, runtime, saveOrthoAutoLock, saveParametricMode, saveShowAxes, saveSnapDynamic } from './state';
import { screenToWorld } from './math';
import { gripAffectsLeft, gripAffectsTop, hitFrameGrip } from './textgrips';
// Geometry-grip drag (line endpoints, rect corners, polyline vertices, …) —
// gated to free-draw mode (`runtime.parametricMode === false`). In parametric
// mode the sidebar editor remains the canonical edit path so PointRef links
// aren't silently flattened.
import { computeGripDragInit, findGripHit } from './grips';
import { layoutText } from './textlayout';
import { collectSnapPoints } from './snap';
import { hitTest } from './hittest';
import { render, requestRender, resize } from './render';
import {
  cancelTool, deleteSelection, handleClick, handleTextDrag,
  renderToolsPanel, selectByBox, setStretchBox, setTool, TOOLS, toolRequiresSelection, updatePreview,
} from './tools';
import { saveJson } from './io';
import { showExportDialog } from './ui/export-dialog';
import { initMenuBar, showImportDialog } from './ui/menu-bar';
import { zoomFit } from './view';
import {
  analyseDrivingDim, applyDrivingDim,
  ensureAxisFeatures, evaluateTimeline, featureForEntity,
  replaceFeatureFromInit,
} from './features';
import { createParameter, findParamByName, parseExprInput } from './params';
import { pushUndo, redo, undo } from './undo';
import {
  renderLayers, renderParameters, toast, updatePosStatus, updateSelStatus,
  updateStats, updateZoomStatus,
} from './ui';
import { cmdBarHasFocus, cmdBarHasFields, focusCmdBar, handleBareEnter } from './cmdbar';
import { dom } from './dom';
import { initThemes } from './themes';
import { isModalOpen, showPrompt } from './modal';
import {
  commitInlineTextIfOpen, isInlineTextOpen, showInlineTextEditor,
} from './textinline';

// Keep the linter happy in case future phases remove direct usage.
void updateStats;

const { cv } = dom;

/**
 * Return the frame grip (if any) hovered at the given canvas-local screen
 * point. Only looks at currently selected Rahmentext entities — grips only
 * appear on those, so there's no reason to scan the rest.
 */
function findFrameGripHit(
  screenPt: { x: number; y: number },
): { entityId: number; gripIdx: 0 | 1 | 2 | 3; entity: import('./types').TextEntity } | null {
  for (const eid of state.selection) {
    const ent = state.entities.find(x => x.id === eid);
    if (!ent || ent.type !== 'text' || ent.boxWidth === undefined) continue;
    const g = hitFrameGrip(screenPt, ent);
    if (g) return { entityId: ent.id, gripIdx: g.idx, entity: ent };
  }
  return null;
}

/**
 * Apply a grip drag to the live feature. We mutate the feature's p.x/p.y and
 * boxWidth directly; `evaluateTimeline()` regenerates the entity. We require
 * an `abs` point and `num` boxWidth — parametric anchors are out of scope for
 * direct-drag editing and would need a proper constraint solver.
 */
function applyFrameGripDrag(worldPt: Pt): void {
  const dtf = runtime.dragTextFrame;
  if (!dtf) return;
  const feat = featureForEntity(dtf.entityId);
  if (!feat || feat.kind !== 'text') return;
  // Only direct-mutate when the feature uses `abs`/`num` expressions. A
  // parametric anchor (e.g. an endpoint ref) or a boxWidth tied to a variable
  // would need a constraint solver to update correctly, which is out of scope.
  if (feat.p.kind !== 'abs') return;
  if (feat.p.x.kind !== 'num' || feat.p.y.kind !== 'num') return;
  if (!feat.boxWidth || feat.boxWidth.kind !== 'num') return;

  // Compensate for where inside the grip the user originally clicked, so the
  // edge latches to the cursor without a visible jump.
  const cx = worldPt.x - dtf.grabDx;
  const cy = worldPt.y - dtf.grabDy;

  // Start with the edges at drag-start; move only the grabbed corner's edges.
  let newLeft  = dtf.startLeft;
  let newRight = dtf.startRight;
  let newTop   = dtf.startTop;

  if (gripAffectsLeft(dtf.gripIdx)) newLeft = cx;
  else                              newRight = cx;

  // Vertical: top corners move the top edge directly; bottom corners also
  // move the top edge, because the bottom is content-driven (text height) and
  // the visual effect of "drag the bottom corner down" is identical to
  // "shift the whole block down".
  if (gripAffectsTop(dtf.gripIdx)) {
    newTop = cy;
  } else {
    // Bottom grip: to land the new bottom edge at `cy`, put the top at
    // cy + contentHeight. contentHeight is content-driven — read it from the
    // live layout rather than snapshotting, since a width change on this same
    // frame can re-wrap the text and change how many lines we have.
    const liveEnt = state.entities.find(x => x.id === dtf.entityId);
    if (liveEnt && liveEnt.type === 'text') {
      const live = layoutText(liveEnt);
      newTop = cy + (live.maxY - live.minY);
    } else {
      newTop = cy;
    }
  }

  // Guard: don't let the user collapse the frame to <= 0 width. Below a
  // minimum, clamp so the grip stops tracking rather than flipping inside-out.
  const MIN_W = 1e-3;
  if (newRight - newLeft < MIN_W) {
    if (gripAffectsLeft(dtf.gripIdx)) newLeft = newRight - MIN_W;
    else newRight = newLeft + MIN_W;
  }

  feat.p.x.value = newLeft;
  feat.p.y.value = newTop;
  feat.boxWidth.value = newRight - newLeft;
  evaluateTimeline();
}

/**
 * Gather the text entities that should translate together when the user
 * drags on `hitId`. If the hit is already in the selection, we move the
 * whole selection (filtered to text entities with directly-mutable anchors);
 * otherwise we move just the hit. Returns null if nothing is movable —
 * e.g. the entity has a parametric anchor we can't directly edit.
 */
function collectMovableText(
  hitId: number,
): { ids: number[]; anchors: Pt[] } | null {
  const isMovable = (id: number): Pt | null => {
    const feat = featureForEntity(id);
    if (!feat || feat.kind !== 'text') return null;
    if (feat.p.kind !== 'abs') return null;
    if (feat.p.x.kind !== 'num' || feat.p.y.kind !== 'num') return null;
    return { x: feat.p.x.value, y: feat.p.y.value };
  };

  const hitAnchor = isMovable(hitId);
  if (!hitAnchor) return null;

  // If the hit is part of the current selection, drag everything in the
  // selection that's also movable. Non-text selections are left in place —
  // drag-move for other entity types isn't wired up yet.
  const ids: number[] = [];
  const anchors: Pt[] = [];
  if (state.selection.has(hitId) && state.selection.size > 1) {
    for (const id of state.selection) {
      const a = isMovable(id);
      if (a) { ids.push(id); anchors.push(a); }
    }
  }
  if (ids.length === 0) { ids.push(hitId); anchors.push(hitAnchor); }
  return { ids, anchors };
}

/** Translate every entity in `dragTextMove` by the cursor delta from the
 *  drag's starting point. Mutates features directly (abs+num only) and
 *  re-evaluates the timeline so the entities repaint in their new positions. */
function applyTextMoveDrag(worldPt: Pt): void {
  const dtm = runtime.dragTextMove;
  if (!dtm) return;
  const dx = worldPt.x - dtm.startWorld.x;
  const dy = worldPt.y - dtm.startWorld.y;
  for (let i = 0; i < dtm.entityIds.length; i++) {
    const feat = featureForEntity(dtm.entityIds[i]);
    if (!feat || feat.kind !== 'text') continue;
    if (feat.p.kind !== 'abs') continue;
    if (feat.p.x.kind !== 'num' || feat.p.y.kind !== 'num') continue;
    feat.p.x.value = dtm.startAnchors[i].x + dx;
    feat.p.y.value = dtm.startAnchors[i].y + dy;
  }
  evaluateTimeline();
}

/**
 * Apply one frame of a geometry-grip drag: compute the new EntityInit from
 * the snapshot + live cursor, write it back via `replaceFeatureFromInit` and
 * re-evaluate only the changed feature. Runs every mousemove once the drag
 * has crossed the deadzone.
 *
 * The cursor is corrected by `grabDx/grabDy` so the grip doesn't jump to the
 * cursor on the first frame. Snap takes precedence over the raw cursor so
 * endpoints can latch to existing geometry.
 */
function applyGripDrag(worldPt: Pt): void {
  const dg = runtime.dragGrip;
  if (!dg) return;
  // Prefer the live snap target (endpoint / mid / center / intersection /
  // grid / axis / polar / …) over the raw cursor so grip edits latch onto
  // existing geometry. `runtime.lastSnap` is refreshed earlier in the same
  // mousemove tick so it reflects the current cursor position.
  //
  // When a snap is active the point is ABSOLUTE — we want the grip to land
  // exactly on the snap target, so the mousedown click-offset (grabDx/grabDy)
  // is deliberately NOT subtracted. Without a snap we do subtract it, so the
  // grip tracks the cursor smoothly without jumping when the user clicked a
  // pixel or two off the grip centre.
  const newPoint: Pt = runtime.lastSnap
    ? { x: runtime.lastSnap.x, y: runtime.lastSnap.y }
    : { x: worldPt.x - dg.grabDx, y: worldPt.y - dg.grabDy };
  // Delta from the grip's ORIGINAL world position, not the previous frame —
  // the snapshot-based `computeGripDragInit` wants the total displacement.
  const deltaFromGripStart: Pt = {
    x: newPoint.x - dg.grip.x,
    y: newPoint.y - dg.grip.y,
  };
  const init = computeGripDragInit(dg.startEntity, dg.grip, newPoint, deltaFromGripStart);
  if (!init) return;
  const feat = featureForEntity(dg.entityId);
  if (!feat) return;
  if (!replaceFeatureFromInit(feat.id, init)) return;
  evaluateTimeline({ changedFeatures: [feat.id], changedParams: [] });
}

/**
 * Hit-test a geometry grip under the cursor, but only in free-draw mode and
 * only when the hit feature is a direct drawing feature (not a modifier
 * sub-entity). Returns null when grips should be ignored — the caller then
 * falls through to normal hit-testing.
 */
function findDirectGripHit(screenPt: { x: number; y: number }): ReturnType<typeof findGripHit> {
  if (runtime.parametricMode) return null;
  if (state.selection.size !== 1) return null;
  const id = [...state.selection][0];
  const ent = state.entities.find(x => x.id === id);
  if (!ent) return null;
  const feat = featureForEntity(id);
  // Modifier sub-entity → feat.kind won't match ent.type. Skip: editing a
  // computed copy would rebuild the source as a free line and orphan the
  // modifier chain.
  if (!feat || feat.kind !== ent.type) return null;
  return findGripHit(screenPt);
}

/** Reference point for tangent/perpendicular snap: the tool's current anchor. */
function snapFromPt(): Pt | null {
  const tc = runtime.toolCtx;
  if (!tc) return null;
  if (state.tool === 'line' && tc.step === 'p2' && tc.p1) return tc.p1;
  if (state.tool === 'polyline' && tc.pts && tc.pts.length > 0) return tc.pts[tc.pts.length - 1];
  if ((state.tool === 'move' || state.tool === 'copy') && tc.step === 'target' && tc.basePt) return tc.basePt;
  return null;
}

// ----------------- Mouse -----------------

cv.addEventListener('mousemove', (e) => {
  const r = cv.getBoundingClientRect();
  state.mouseScreen = { x: e.clientX - r.left, y: e.clientY - r.top };
  state.mouseWorld = screenToWorld(state.mouseScreen);
  runtime.orthoSnap = e.shiftKey && state.tool !== 'select';
  updatePosStatus(state.mouseWorld.x, state.mouseWorld.y);

  if (runtime.pan) {
    state.view.x += e.clientX - runtime.pan.lastX;
    state.view.y += e.clientY - runtime.pan.lastY;
    runtime.pan.lastX = e.clientX;
    runtime.pan.lastY = e.clientY;
    runtime.lastSnap = null;
    runtime.hoveredId = null;
  } else {
    // During a geometry-grip drag, exclude the entity being edited from snap
    // collection — otherwise endpoint 0 could snap to endpoint 1 of the same
    // line and collapse it, or a rect-corner drag would snap onto the edges
    // of the same rect. Other drag types don't need this (text grips/move
    // operate on anchors that are never near other snap points of the same
    // entity, and dragSelect/dragText don't snap at all).
    const snapExclude = runtime.dragGrip?.entityId ?? null;
    runtime.lastSnap = collectSnapPoints(state.mouseWorld, snapFromPt(), snapExclude);
    // Include locked layers so axis xlines also highlight on hover.
    runtime.hoveredId = hitTest(state.mouseWorld, undefined, true)?.id ?? null;
    // Fang-Marker unterdrücken, wenn sie mit einem Griff der aktuell
    // ausgewählten Entität kollidieren würden. Zwei Situationen:
    //   (a) Cursor SITZT auf dem Griff (Pixel-genau) — dann sowieso wegblenden
    //       (ein Klick triggert Grip-Drag, kein Snap).
    //   (b) Cursor ist NAH am Griff, weiter als der 5-Pixel-Griff-Hittest aber
    //       innerhalb der 14-Pixel-Snap-Apertur — dann landet der Snap
    //       genau auf der Griff-Position (END=Endpunkt, MITTE=Mittelpunkt usw.).
    //       Das END-Label würde das Griffquadrat überdecken → unterdrücken.
    //
    // Die Koinzidenz prüfen wir logisch: wenn der Snappunkt auf einem der
    // Griff-Weltpunkte der selektierten Entität liegt, weg damit. Funktioniert
    // automatisch für alle Typen (end/mid/center/…) weil die Griffe genau an
    // denselben geometrischen Schlüsselpunkten sitzen.
    // Frame-text grips still render and can be dragged (separate non-parametric
    // system); hide snap markers that coincide with them so the snap glyph
    // doesn't sit on top of the grip box.
    if (state.tool === 'select' && !runtime.dragTextFrame) {
      const gripOver = findFrameGripHit(state.mouseScreen);
      if (gripOver) {
        runtime.lastSnap = null;
        runtime.hoveredId = null;
      } else if (!runtime.dragGrip) {
        // Geometry grips (free-draw mode) sit at the same points END/MID would
        // snap to. Hide the snap marker so the glyph doesn't float on top of
        // the grip box — the grip itself is the visible affordance.
        const geomGripOver = findDirectGripHit(state.mouseScreen);
        if (geomGripOver) runtime.lastSnap = null;
      }
    }
  }
  if (runtime.dragSelect && !runtime.dragSelect.active) {
    const dx = e.clientX - runtime.dragSelect.startClientX;
    const dy = e.clientY - runtime.dragSelect.startClientY;
    if (dx * dx + dy * dy > 9) runtime.dragSelect.active = true;
  }
  if (runtime.dragText && !runtime.dragText.active) {
    const dx = e.clientX - runtime.dragText.startClientX;
    const dy = e.clientY - runtime.dragText.startClientY;
    // Slightly looser deadzone than dragSelect — the text tool only has two
    // meaningful outcomes (single click vs rectangle) and users frequently
    // wobble a pixel or two while committing a single click.
    if (dx * dx + dy * dy > 16) runtime.dragText.active = true;
  }
  // Text body drag-to-move: once past the deadzone, translate the anchor(s)
  // every mousemove. Undo is captured exactly at the deadzone crossing so a
  // no-drag click doesn't pollute history.
  const dtm = runtime.dragTextMove;
  if (dtm) {
    if (!dtm.active) {
      const dx = e.clientX - dtm.startClientX;
      const dy = e.clientY - dtm.startClientY;
      if (dx * dx + dy * dy > 9) {
        pushUndo();
        dtm.active = true;
        // Starting a drag on an unselected text pulls it into the selection
        // so the user sees a visual confirmation of what's being moved.
        if (!state.selection.has(dtm.entityIds[0])) {
          state.selection.clear();
          for (const id of dtm.entityIds) state.selection.add(id);
          updateSelStatus();
        }
        cv.style.cursor = 'move';
      }
    }
    if (dtm.active) applyTextMoveDrag(state.mouseWorld);
  }
  // Frame-grip drag: once past the deadzone, live-update the feature every
  // mousemove so the frame (and wrapped lines) track the cursor.
  const dtf = runtime.dragTextFrame;
  if (dtf) {
    if (!dtf.active) {
      const dx = e.clientX - dtf.startClientX;
      const dy = e.clientY - dtf.startClientY;
      if (dx * dx + dy * dy > 4) {
        // Push undo BEFORE the first mutation so `Ctrl+Z` restores the pre-
        // drag frame. Sub-deadzone clicks never hit this, so they don't
        // pollute history.
        pushUndo();
        dtf.active = true;
      }
    }
    if (dtf.active) {
      applyFrameGripDrag(state.mouseWorld);
    }
  }
  // Geometry-grip drag (free-draw mode only): identical state-machine to
  // the frame-grip drag above — deadzone, first-move undo push, then live
  // rebuild of the feature on every mousemove.
  const dgm = runtime.dragGrip;
  if (dgm) {
    if (!dgm.active) {
      const dx = e.clientX - dgm.startClientX;
      const dy = e.clientY - dgm.startClientY;
      if (dx * dx + dy * dy > 4) {
        pushUndo();
        dgm.active = true;
      }
    }
    if (dgm.active) applyGripDrag(state.mouseWorld);
  }
  if (state.tool === 'select' && !runtime.pan && !runtime.dragTextFrame && !runtime.dragGrip) {
    // Hover hints: diagonal-resize cursor over a frame grip, 'move' cursor
    // over a text body (drag-to-move is a low-discoverability feature —
    // the cursor change teaches it passively).
    const hoveredGrip = findFrameGripHit(state.mouseScreen);
    const hoveredGeomGrip = hoveredGrip ? null : findDirectGripHit(state.mouseScreen);
    if (hoveredGrip) {
      const idx = hoveredGrip.gripIdx;
      cv.style.cursor = (idx === 0 || idx === 2) ? 'nwse-resize' : 'nesw-resize';
    } else if (hoveredGeomGrip) {
      // Move grip = translate-the-whole-thing ⇒ 'move'. Any edit grip (endpoint,
      // vertex, corner, quadrant, edge, …) ⇒ 'crosshair' to signal "pick a new
      // world point". Matches the feel of ArtiosCAD / AutoCAD grip editing.
      cv.style.cursor = hoveredGeomGrip.grip.kind === 'move'
        || hoveredGeomGrip.grip.kind === 'arc-mid' ? 'move' : 'crosshair';
    } else {
      const hoveredEnt = runtime.hoveredId != null
        ? state.entities.find(x => x.id === runtime.hoveredId)
        : undefined;
      if (hoveredEnt && hoveredEnt.type === 'text') {
        cv.style.cursor = 'move';
      } else if (cv.style.cursor === 'nwse-resize' ||
                 cv.style.cursor === 'nesw-resize' ||
                 cv.style.cursor === 'move' ||
                 cv.style.cursor === 'crosshair') {
        cv.style.cursor = '';
      }
    }
  }
  updatePreview();
  requestRender();
});

cv.addEventListener('mousedown', (e) => {
  if (e.button === 1 || (e.button === 0 && runtime.spacePan) || (e.button === 0 && state.tool === 'pan')) {
    runtime.pan = { lastX: e.clientX, lastY: e.clientY };
    cv.style.cursor = 'grabbing';
    return;
  }
  // Inline text editor is modal-ish while open: any canvas click — left OR
  // right — commits whatever was typed. Escape is the only way to discard
  // (handled in textinline.ts). We swallow the event so the click itself
  // doesn't trigger a tool action; the user's *next* click starts fresh.
  // Right-click-to-commit matches how the user naturally "signs off" on an
  // entry, and avoids the confusion of having right-click do two opposite
  // things (cancel tool vs. cancel edit).
  if (isInlineTextOpen()) {
    if (e.button === 2) e.preventDefault();
    if (e.button === 0 || e.button === 2) { commitInlineTextIfOpen(); return; }
  }
  if (e.button === 2) { e.preventDefault(); cancelTool(); return; }
  if (e.button === 0) {
    const world: Pt = runtime.lastSnap
      ? { x: runtime.lastSnap.x, y: runtime.lastSnap.y }
      : { ...state.mouseWorld };
    if (state.tool === 'select') {
      // Framed-text corner-grip drag takes priority over everything else —
      // the grip lives ON TOP OF the text entity, so normal hit-test would
      // otherwise just re-select the text on each grip click.
      const gripHit = findFrameGripHit(state.mouseScreen);
      if (gripHit) {
        const { entityId, gripIdx, entity } = gripHit;
        const L = layoutText(entity);
        const gripWorld =
          gripIdx === 0 ? { x: L.minX, y: L.maxY } :
          gripIdx === 1 ? { x: L.maxX, y: L.maxY } :
          gripIdx === 2 ? { x: L.maxX, y: L.minY } :
                          { x: L.minX, y: L.minY };
        runtime.dragTextFrame = {
          entityId,
          gripIdx,
          startLeft:  L.minX,
          startRight: L.maxX,
          startTop:   L.maxY,
          grabDx: world.x - gripWorld.x,
          grabDy: world.y - gripWorld.y,
          active: false,
          startClientX: e.clientX,
          startClientY: e.clientY,
        };
        return;
      }
      // Geometry-grip drag — free-draw mode only. Any selected line /
      // circle / arc / rect / ellipse / polyline / spline / text with a
      // grip under the cursor starts a direct-manipulation drag. In
      // parametric mode this is intentionally disabled so PointRef links
      // aren't silently flattened on drag; the sidebar editor is the
      // canonical edit path there.
      {
        const geomHit = findDirectGripHit(state.mouseScreen);
        if (geomHit) {
          const ent = state.entities.find(x => x.id === geomHit.entityId);
          if (ent) {
            runtime.dragGrip = {
              entityId: geomHit.entityId,
              grip: geomHit.grip,
              startEntity: JSON.parse(JSON.stringify(ent)) as typeof ent,
              grabDx: world.x - geomHit.grip.x,
              grabDy: world.y - geomHit.grip.y,
              startClientX: e.clientX,
              startClientY: e.clientY,
              active: false,
            };
            return;
          }
        }
      }
      // Click-drag on a text entity → move the text. Only fires when the
      // click lands inside the text (hit-test match) and the entity's feature
      // is directly-mutable (abs+num anchor). Shift/alt defer to their normal
      // semantics (shift-add, alt-duplicate), so this only activates on a
      // plain left-click. If the deadzone isn't crossed on mouseup we fall
      // through to a normal click-select.
      if (!e.shiftKey && !e.altKey) {
        const hit = hitTest(world);
        if (hit && hit.type === 'text') {
          const movable = collectMovableText(hit.id);
          if (movable) {
            runtime.dragTextMove = {
              entityIds: movable.ids,
              startWorld: world,
              startAnchors: movable.anchors,
              startClientX: e.clientX,
              startClientY: e.clientY,
              active: false,
              shift: e.shiftKey,
            };
            return;
          }
        }
      }
      // Alt+Drag: duplicate hit entity (or current selection if hit is in it)
      // and drag the copy. Existing copy-tool pipeline handles the transform.
      if (e.altKey) {
        const hit = hitTest(world);
        if (hit) {
          if (!state.selection.has(hit.id)) {
            state.selection.clear();
            state.selection.add(hit.id);
          }
          setTool('copy');
          runtime.toolCtx = { step: 'target', basePt: world };
          runtime.dragCopy = true;
          return;
        }
      }
      runtime.dragSelect = {
        worldStart: world,
        startClientX: e.clientX,
        startClientY: e.clientY,
        active: false,
        shift: e.shiftKey,
      };
      return;
    }
    // Stretch tool: the 'pickbox' step uses a drag-select rectangle to mark
    // the crossing region (same UI as the select tool's rubber-band). Once
    // the drag ends in mouseup, we feed the two corners into setStretchBox()
    // and advance to the base-point step.
    if (state.tool === 'stretch') {
      const tc = runtime.toolCtx;
      if (tc && tc.step === 'pickbox') {
        runtime.dragSelect = {
          worldStart: world,
          startClientX: e.clientX,
          startClientY: e.clientY,
          active: false,
          shift: e.shiftKey,
        };
        return;
      }
    }
    // Text tool: defer commit to mouseup so we can distinguish click vs drag.
    // A plain click drops text with the default height; a drag uses the box
    // height as the text height.
    if (state.tool === 'text') {
      const tc = runtime.toolCtx;
      // Only on the first placement step ('pt'). Once the user has clicked and
      // is typing in the text field (step 'text'), ignore further canvas
      // mousedowns so they don't restart placement.
      if (tc && tc.step === 'pt') {
        runtime.dragText = {
          worldStart: world,
          startClientX: e.clientX,
          startClientY: e.clientY,
          active: false,
        };
        return;
      }
    }
    handleClick(world, e.shiftKey);
  }
});

cv.addEventListener('mouseup', () => {
  runtime.pan = null;
  cv.style.cursor = state.tool === 'pan' ? 'grab' : '';
  // Text-body drag-to-move: either commit (active drag) or fall through to
  // a normal click-select (deadzone never crossed).
  if (runtime.dragTextMove) {
    const dtm = runtime.dragTextMove;
    runtime.dragTextMove = null;
    cv.style.cursor = '';
    if (dtm.active) {
      requestRender();
    } else {
      // No real drag — treat it as a plain click at the original point so
      // the user still gets normal click-select behaviour (selects the
      // text, respecting shift).
      handleClick(dtm.startWorld, dtm.shift);
    }
    return;
  }
  // Frame-grip drag: if the user actually moved, push one undo entry
  // *after* the fact — we didn't push at mousedown because a sub-deadzone
  // click should leave history untouched. Snapshot+restore is unnecessary
  // here: the edits during the drag are idempotent in the final state.
  if (runtime.dragTextFrame) {
    const dtf = runtime.dragTextFrame;
    runtime.dragTextFrame = null;
    // Undo was already pushed at the moment we crossed the deadzone. Here we
    // just clean up and repaint; if the drag never activated (plain click on
    // the grip), nothing was mutated and there's nothing to commit.
    if (dtf.active) requestRender();
    return;
  }
  // Geometry-grip drag (free-draw mode): undo was pushed when the deadzone
  // was crossed, so active drags just clean up and repaint. Sub-deadzone
  // clicks on a grip are no-ops — the entity stays selected and nothing is
  // mutated.
  if (runtime.dragGrip) {
    const dgm = runtime.dragGrip;
    runtime.dragGrip = null;
    cv.style.cursor = '';
    if (dgm.active) requestRender();
    return;
  }
  if (runtime.dragCopy) {
    const target: Pt = runtime.lastSnap
      ? { x: runtime.lastSnap.x, y: runtime.lastSnap.y }
      : { ...state.mouseWorld };
    handleClick(target);
    runtime.dragCopy = false;
    setTool('select');
    return;
  }
  const dt = runtime.dragText;
  if (dt) {
    const end: Pt = runtime.lastSnap
      ? { x: runtime.lastSnap.x, y: runtime.lastSnap.y }
      : { ...state.mouseWorld };
    if (dt.active) {
      // Drag past deadzone → frame flow: box height becomes text height, text
      // anchored at the lower-left of the drag box.
      handleTextDrag(dt.worldStart, end);
    } else {
      // Plain click → existing single-point placement with default height.
      handleClick(dt.worldStart, false, { useSnap: false });
    }
    runtime.dragText = null;
    requestRender();
    return;
  }
  const ds = runtime.dragSelect;
  if (ds) {
    if (ds.active) {
      const end: Pt = runtime.lastSnap
        ? { x: runtime.lastSnap.x, y: runtime.lastSnap.y }
        : state.mouseWorld;
      // Stretch-tool box: route into the stretch context instead of touching
      // state.selection (the crossing region selects endpoints, not entities).
      if (state.tool === 'stretch' && runtime.toolCtx?.step === 'pickbox') {
        setStretchBox(ds.worldStart, end);
      } else {
        selectByBox(ds.worldStart, end, ds.shift);
      }
    } else {
      handleClick(ds.worldStart, ds.shift);
    }
    runtime.dragSelect = null;
    requestRender();
  }
});

cv.addEventListener('dblclick', async (e) => {
  const r = cv.getBoundingClientRect();
  const world = screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
  const hit = hitTest(world);
  if (!hit) return;

  if (hit.type === 'dim') {
    const dx = hit.p2.x - hit.p1.x, dy = hit.p2.y - hit.p1.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return;
    const fid = featureForEntity(hit.id)?.id;
    if (!fid) return;

    // Driving dimension: the dim is a READABLE view onto its underlying
    // geometry, so editing the dim edits the geometry — not the dim itself.
    // Analyse the dim's PointRefs to find a driveable source (line length,
    // or abs-abs fallback); prompt for the new value (accepting literals,
    // param names, and formulas); then apply.
    const plan = analyseDrivingDim(fid);
    const input = await showPrompt({
      title: 'Maß ändern',
      message: plan?.kind === 'lineLength'
        ? 'Neue Länge der Linie. Zahl, Variable oder Formel (z.B. L, 2*L+5).'
        : 'Neuer Abstand zwischen den Messpunkten.',
      defaultValue: L.toFixed(3),
      validate: (v) => {
        const r = parseExprInput(v.trim());
        if (!r) return 'Ungültige Eingabe';
        if (r.kind === 'unknown') return `Unbekannte Variable: ${r.name}`;
        return null;
      },
    });
    if (input == null) return;
    const r = parseExprInput(input.trim());
    if (!r || r.kind !== 'expr') { toast('Ungültiges Maß'); return; }

    pushUndo();

    if (plan) {
      const ddr = applyDrivingDim(fid, plan, r.expr);
      if (ddr) {
        // Only the mutated feature (and its downstream — including the dim
        // itself, which depends on the line) needs re-evaluating. If we drove
        // a parameter, siblings that reference it also need to rebuild.
        evaluateTimeline({
          changedFeatures: [ddr.mutatedFid],
          changedParams: ddr.changedParams,
        });
        if (ddr.changedParams.length > 0) renderParameters();
        requestRender();
        return;
      }
      toast('Maß konnte nicht gefahren werden');
      return;
    }

    // No plan → the dim's endpoints don't resolve to anything we can drive
    // (e.g. one endpoint is linked to feature A, the other to feature B).
    // Nothing safe to do without ambiguous heuristics; tell the user.
    toast('Maß lässt sich nicht fahren — Messpunkte liegen an verschiedenen Objekten');
    return;
  }

  if (hit.type === 'text') {
    // Inline editor opens directly over the existing text. We edit the feature
    // in place (rather than via replaceFeatureFromInit) so any parametric
    // anchor — e.g. an endpoint ref — is preserved across the edit.
    const feat = featureForEntity(hit.id);
    if (!feat || feat.kind !== 'text') return;

    // Backward-compat: older text entities may lack `boxWidth` (the legacy
    // Grafiktext mode). Give them a sensible frame width based on their
    // current rendered width, and adjust the anchor so the visual top stays
    // put when the semantics flip from "baseline of last line" to "top-left
    // of frame".
    const lay = layoutText(hit);
    let anchor = { x: hit.x, y: hit.y };
    let boxWidth = hit.boxWidth;
    if (boxWidth === undefined || boxWidth <= 0) {
      boxWidth = Math.max(lay.width, hit.height * 4);
      anchor = { x: hit.x, y: lay.maxY };
    }

    const result = await showInlineTextEditor({
      worldAnchor: anchor,
      initialText: hit.text,
      initialHeight: hit.height,
      boxWidth,
    });
    if (!result) return;
    pushUndo();
    feat.text = result.text;
    feat.height = { kind: 'num', value: result.height };
    // Migrate legacy Grafiktext → framed text on first edit.
    if (!feat.boxWidth) {
      feat.boxWidth = { kind: 'num', value: boxWidth };
      if (feat.p.kind === 'abs' && feat.p.y.kind === 'num') {
        feat.p.y.value = anchor.y;
      }
    }
    evaluateTimeline();
    requestRender();
    return;
  }
});

cv.addEventListener('contextmenu', (e) => e.preventDefault());

cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0015);
  const r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const before = screenToWorld({ x: mx, y: my });
  state.view.scale *= factor;
  state.view.scale = Math.max(0.01, Math.min(2000, state.view.scale));
  const after = screenToWorld({ x: mx, y: my });
  state.view.x += (after.x - before.x) * state.view.scale;
  state.view.y -= (after.y - before.y) * state.view.scale;
  updateZoomStatus();
  render();
}, { passive: false });

// ----------------- Keyboard -----------------

window.addEventListener('keydown', (e) => {
  // When a modal is open, it owns the keyboard. The modal's own capture-phase
  // listener handles Escape; everything else (typing into the input, Tab
  // between buttons, Enter to commit) must reach the modal unmodified. Without
  // this guard, the character-routing branch below would swallow each keypress
  // and append it to the cmdbar input instead of the modal input.
  if (isModalOpen()) return;

  // Inline text editor owns the keyboard while it's open. Its own capture-phase
  // listener handles Escape / Ctrl+Enter; everything else (typing, Tab between
  // the textarea and size input) must reach it unmodified. Without this guard,
  // a tool shortcut like L would fire when focus has drifted from the textarea
  // to (e.g.) a nudger button.
  if (isInlineTextOpen()) return;

  // Any non-cmdbar input/textarea/contenteditable owns its own keys. Without
  // this, Backspace in the sidebar parameter-value field would fall through to
  // the `deleteSelection()` branch below and wipe the canvas selection — and
  // the user cannot erase digits from the field, only overwrite them.
  const ae = document.activeElement as HTMLElement | null;
  if (ae && !cmdBarHasFocus()) {
    const tag = ae.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable) return;
  }

  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { undo(); e.preventDefault(); return; }
    if (k === 'y' || (k === 'z' && e.shiftKey)) { redo(); e.preventDefault(); return; }
    if (k === 's') { saveJson(); e.preventDefault(); return; }
    if (k === 'a' && !cmdBarHasFocus()) {
      state.selection.clear();
      for (const ent of state.entities) {
        if (!state.layers[ent.layer]?.locked) state.selection.add(ent.id);
      }
      updateSelStatus();
      requestRender();
      e.preventDefault();
      return;
    }
  }

  // Cmdbar fields handle their own Enter/Tab/Escape/Backspace.
  if (cmdBarHasFocus()) return;

  if (e.key === 'Enter') {
    if (handleBareEnter()) { e.preventDefault(); return; }
    // AutoCAD convention: Enter in idle re-invokes the most recent tool.
    if (state.tool === 'select' && runtime.lastInvokedTool) {
      setTool(runtime.lastInvokedTool as Parameters<typeof setTool>[0]);
      e.preventDefault();
      return;
    }
  }
  // Any printable character while tool-input fields are active → route to first field.
  // This prevents tool shortcuts (e.g. L → Line) from firing when the user intends
  // to type a parameter name like "L" or "W" into a dimension field.
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && cmdBarHasFields()) {
    e.preventDefault();
    focusCmdBar();
    const inp = document.activeElement as HTMLInputElement | null;
    if (inp && inp.classList.contains('cmd-field-input')) inp.value += e.key;
    return;
  }
  if (e.key === ' ') { runtime.spacePan = true; cv.style.cursor = 'grab'; e.preventDefault(); return; }
  if (e.key === 'Escape') { cancelTool(); return; }
  if (e.key === 'Home') { zoomFit(); e.preventDefault(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelection();
    e.preventDefault();
    return;
  }
  const shortcut = TOOLS.find(t => t.key.toLowerCase() === e.key.toLowerCase() && !t.action);
  if (shortcut) {
    // Same gating as the rail click handler: selection-required tools refuse
    // to activate when nothing is selected. Keyboard shortcuts must enforce
    // the same rule as clicks, otherwise the hotkey bypasses the greyed-out
    // affordance.
    if (toolRequiresSelection(String(shortcut.id)) && state.selection.size === 0) {
      toast('Erst Objekte wählen');
      return;
    }
    setTool(shortcut.id as Exclude<typeof shortcut.id, 'delete'>);
    return;
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') { runtime.spacePan = false; cv.style.cursor = ''; }
  if (e.key === 'Shift' && runtime.orthoSnap) {
    runtime.orthoSnap = false;
    updatePreview();
    requestRender();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift' && state.tool !== 'select' && !runtime.orthoSnap) {
    runtime.orthoSnap = true;
    updatePreview();
    requestRender();
  }
}, { passive: true });

// ----------------- Grid size input (in snap overlay) -----------------

const gridInput = document.getElementById('grid-size') as HTMLInputElement | null;
if (gridInput) {
  gridInput.value = String(runtime.snapSettings.gridSize);
  gridInput.oninput = () => {
    runtime.snapSettings.gridSize = Math.max(0.1, parseFloat(gridInput.value) || 10);
    requestRender();
  };
}

const btnAddLayer = document.getElementById('btn-addlayer') as HTMLButtonElement;
btnAddLayer.onclick = async () => {
  const name = await showPrompt({
    title: 'Neuer Layer',
    defaultValue: 'Layer ' + (state.layers.length + 1),
    validate: (v) => v.trim() ? null : 'Name darf nicht leer sein',
  });
  if (!name) return;
  state.layers.push({ name: name.trim(), color: '#cccccc', visible: true });
  renderLayers();
};

const btnAddParam = document.getElementById('btn-addparam') as HTMLButtonElement;
btnAddParam.onclick = async () => {
  const name = await showPrompt({
    title: 'Neue Variable',
    message: 'Kurzer Name, z.B. L, W, R.',
    placeholder: 'L',
    validate: (v) => {
      const t = v.trim();
      if (!t) return 'Name darf nicht leer sein';
      if (!/^[a-zA-Z_π][a-zA-Z0-9_]*$/.test(t)) return 'Nur Buchstaben, Ziffern und _';
      if (findParamByName(t)) return 'Variable existiert bereits';
      return null;
    },
  });
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  const valRaw = await showPrompt({
    title: `Wert für ${trimmed}`,
    defaultValue: '0',
    validate: (v) => Number.isFinite(parseFloat(v.replace(',', '.'))) ? null : 'Zahl erwartet',
  });
  if (valRaw == null) return;
  const val = parseFloat(valRaw.replace(',', '.'));
  if (!Number.isFinite(val)) { toast('Ungültige Zahl'); return; }
  const meaning = await showPrompt({
    title: `Bedeutung von ${trimmed}`,
    message: 'Optional — wofür steht diese Variable?',
    placeholder: 'z.B. Länge',
  }) ?? '';
  createParameter(trimmed, val, meaning.trim() || undefined);
  updateStats();
};

(document.getElementById('btn-save')   as HTMLButtonElement).onclick = saveJson;
(document.getElementById('btn-import') as HTMLButtonElement).onclick = () => { showImportDialog(); };
(document.getElementById('btn-export') as HTMLButtonElement).onclick = () => { void showExportDialog(); };

// Global shortcuts for Export/Import. Registered in the capture phase so they
// fire even when focus is inside the canvas or a side panel. When a modal is
// already open, let the modal own the keystroke — otherwise Strg+Shift+E
// inside the export dialog itself would recursively open a second one.
window.addEventListener('keydown', (ev) => {
  if (!(ev.ctrlKey || ev.metaKey) || !ev.shiftKey) return;
  if (isModalOpen()) return;
  const k = ev.key.toLowerCase();
  if (k === 'e') {
    ev.preventDefault();
    void showExportDialog();
  } else if (k === 'i') {
    ev.preventDefault();
    showImportDialog();
  }
}, true);

// ----------------- Boot -----------------

ensureAxisFeatures();
evaluateTimeline();

window.addEventListener('resize', resize);
initThemes();
initMenuBar();
// Reflect the persisted "palettes locked" flag as a body class so CSS can
// key off it (cursor: default on headers, etc.) without per-element state.
if (runtime.panelsLocked) document.body.classList.add('panels-locked');
renderToolsPanel();
renderLayers();
updateStats();
updateSelStatus();
setTool('select');
resize();

// ----------------- Sidebar collapsible sections -----------------

document.querySelectorAll<HTMLButtonElement>('.side-section-header').forEach(btn => {
  btn.addEventListener('click', () => {
    const section = btn.closest<HTMLElement>('.side-section');
    if (!section) return;
    const opening = section.classList.contains('closed');
    section.classList.toggle('open', opening);
    section.classList.toggle('closed', !opening);
  });
});

// ----------------- Canvas snap-toolbar overlay wiring -----------------
//
// The overlay is the ONLY source of truth for snap settings. State lives in
// `runtime.snapSettings`; buttons toggle fields directly and re-sync visuals.

/** Keys of SnapSettings that correspond to individual snap types (not grid). */
const FANG_KEYS = ['end', 'mid', 'int', 'center', 'tangent', 'perp'] as const;
type FangKey = typeof FANG_KEYS[number];

function syncSnapOverlay(): void {
  const s = runtime.snapSettings;
  const setOn = (id: string, on: boolean) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('on', on);
  };
  setOn('tb-raster',   s.showGrid);
  setOn('tb-axes',     s.showAxes);
  setOn('tb-ortholock', runtime.orthoAutoLock);
  setOn('tb-parametric', runtime.parametricMode);
  setOn('tb-gridsnap', s.grid);
  setOn('tb-end',      s.end);
  setOn('tb-mid',      s.mid);
  setOn('tb-int',      s.int);
  setOn('tb-ctr',      s.center);
  setOn('tb-perp',     s.perp);
  setOn('tb-tan',      s.tangent);
  setOn('tb-polar',    s.polar);
  setOn('tb-track',    s.tracking);
  // Master FANG lights up if ANY individual snap is active.
  const anyFang = FANG_KEYS.some(k => s[k]);
  setOn('tb-fang', anyFang);
}

function tbBind(btnId: string, toggle: () => void): void {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', () => {
    toggle();
    syncSnapOverlay();
    requestRender();
  });
}

tbBind('tb-raster',   () => { runtime.snapSettings.showGrid = !runtime.snapSettings.showGrid; });
tbBind('tb-axes',     () => {
  runtime.snapSettings.showAxes = !runtime.snapSettings.showAxes;
  saveShowAxes(runtime.snapSettings.showAxes);
});
tbBind('tb-ortholock', () => {
  runtime.orthoAutoLock = !runtime.orthoAutoLock;
  saveOrthoAutoLock(runtime.orthoAutoLock);
});
tbBind('tb-parametric', () => {
  runtime.parametricMode = !runtime.parametricMode;
  saveParametricMode(runtime.parametricMode);
  // Brief toast so the user gets feedback on a mode change that only shows
  // its effects on the next click — not immediately visible on-screen.
  toast(runtime.parametricMode ? 'Parametrisches Zeichnen ein' : 'Freies Zeichnen (keine Verknüpfungen)');
});
tbBind('tb-gridsnap', () => { runtime.snapSettings.grid     = !runtime.snapSettings.grid; });
tbBind('tb-end',      () => { runtime.snapSettings.end      = !runtime.snapSettings.end; });
tbBind('tb-mid',      () => { runtime.snapSettings.mid      = !runtime.snapSettings.mid; });
tbBind('tb-int',      () => { runtime.snapSettings.int      = !runtime.snapSettings.int; });
tbBind('tb-ctr',      () => { runtime.snapSettings.center   = !runtime.snapSettings.center; });
tbBind('tb-perp',     () => { runtime.snapSettings.perp     = !runtime.snapSettings.perp; });
tbBind('tb-tan',      () => { runtime.snapSettings.tangent  = !runtime.snapSettings.tangent; });
tbBind('tb-polar',    () => {
  runtime.snapSettings.polar = !runtime.snapSettings.polar;
  saveSnapDynamic({
    polar: runtime.snapSettings.polar,
    tracking: runtime.snapSettings.tracking,
    polarAngleDeg: runtime.snapSettings.polarAngleDeg,
  });
});
tbBind('tb-track', () => {
  runtime.snapSettings.tracking = !runtime.snapSettings.tracking;
  saveSnapDynamic({
    polar: runtime.snapSettings.polar,
    tracking: runtime.snapSettings.tracking,
    polarAngleDeg: runtime.snapSettings.polarAngleDeg,
  });
});

// Master FANG: all individual snaps on if any was off, otherwise all off.
tbBind('tb-fang', () => {
  const s = runtime.snapSettings;
  const anyOn = FANG_KEYS.some(k => s[k]);
  const target = !anyOn;
  FANG_KEYS.forEach((k: FangKey) => { s[k] = target; });
});

syncSnapOverlay();

// ----------------- Viewcube overlay wiring -----------------

const vcZoomIn  = document.getElementById('vc-zoom-in')  as HTMLButtonElement | null;
const vcZoomOut = document.getElementById('vc-zoom-out') as HTMLButtonElement | null;
const vcFit     = document.getElementById('vc-zoom-fit') as HTMLButtonElement | null;

if (vcZoomIn) vcZoomIn.onclick = () => {
  state.view.scale = Math.min(2000, state.view.scale * 1.25);
  updateZoomStatus(); requestRender();
};
if (vcZoomOut) vcZoomOut.onclick = () => {
  state.view.scale = Math.max(0.01, state.view.scale / 1.25);
  updateZoomStatus(); requestRender();
};
if (vcFit) vcFit.onclick = () => zoomFit();

// Dev-only debug hook for programmatic verification in the browser console.
// Stripped from production builds via the DEV guard.
if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __hek: unknown }).__hek = {
    state, runtime, setTool, handleClick,
    updateSelStatus,
  };
}
