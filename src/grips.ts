/**
 * Interaktive "Griffe" (grips, AutoCAD-style) für ausgewählte Entitäten.
 *
 * Wenn EINE Entität ausgewählt ist, zeichnen wir kleine Quadrate an allen
 * relevanten geometrischen Schlüsselpunkten:
 *
 *   • line      → 2 Endpunkte + Mittelpunkt (mid = Verschieben der ganzen Linie)
 *   • circle    → Mittelpunkt (Verschieben) + 4 Quadranten (Radius ändern)
 *   • arc       → Mittelpunkt (Verschieben) + Startpunkt + Endpunkt + Bogenmitte
 *                 (Bogenmitte = Verschieben, Start/End ändern den Winkel und
 *                  passen den Radius an den gezogenen Punkt an)
 *   • rect      → 4 Ecken (Stretch) + 4 Kantenmitten (einzelne Kante stretchen)
 *                 + Mittelpunkt (Verschieben)
 *   • ellipse   → Mittelpunkt (Verschieben) + 4 Achsenenden
 *                 (2 × rx, 2 × ry — beim Ziehen ändert sich der Radius +
 *                  ggf. die Rotation wenn die Hauptachse gezogen wird)
 *   • polyline  → jeder Stützpunkt (Vertex)
 *   • spline    → jeder Kontrollpunkt
 *   • text      → Einfügepunkt (Mittelgriff zum Verschieben) — Rahmen-Griffe
 *                 werden weiterhin in textgrips.ts behandelt (bleibt unberührt)
 *
 * Parametrische Features (mit `endpoint`/`center`/formel-Radius etc.) werden
 * beim Direktziehen zu abs-Literalen flachgeklopft — die Bindung geht
 * verloren. Für parametrisches Nachbearbeiten gibt es den Eigenschaften-
 * Bereich in der Sidebar.
 */

import type {
  ArcEntity, CircleEntity, DimEntity, EllipseEntity, Entity, EntityInit,
  LineEntity, PolylineEntity, Pt, RectEntity, SplineEntity, TextEntity,
} from './types';
import { state } from './state';
import { worldToScreen } from './math';

/** Halbe Kantenlänge eines Griff-Quadrats in CSS-Pixeln. Gleichzeitig
 *  Toleranz für den Hit-Test. Passt zum Rahmen-Grip in textgrips.ts. */
export const GRIP_HALF_PX = 5;

export type GripKind =
  | 'move'          // Verschiebe die ganze Entität
  | 'endpoint'      // Linien-Endpunkt (line/xline), Index 0 oder 1
  | 'vertex'        // Polyline/Spline-Stützpunkt bei vertexIndex
  | 'rect-corner'   // Rechteck-Ecke, cornerIdx 0..3 (TL, TR, BR, BL)
  | 'rect-edge'     // Rechteck-Kantenmitte, edge 'top'|'right'|'bottom'|'left'
  | 'circle-quad'   // Kreis-Quadrant, axis 'e'|'n'|'w'|'s' → ändert Radius
  | 'arc-end'       // Bogen-Endpunkt, end 0 oder 1
  | 'arc-mid'       // Bogen-Mittelpunkt → Bogen verschieben (reiner Move)
  | 'ellipse-axis'  // Ellipsen-Achsenende, axis 'rx'|'ry', side 1 | -1
  | 'dim-offset';   // Bemaßungs-Abstandspunkt — verschiebt die Hilfslinie
                    // senkrecht zur Messlinie, parametrische Bindung an p1/p2
                    // bleibt erhalten (dim-offset wird direkt auf dem Feature
                    // mutiert statt über replaceFeatureFromInit).

/** Welche Kante eines Rechtecks ein Edge-Griff steuert. */
export type RectEdge = 'top' | 'right' | 'bottom' | 'left';
/** Welche Achse eines Kreises ein Quadrant-Griff steuert. */
export type CircleAxis = 'e' | 'n' | 'w' | 's';

export type Grip = {
  x: number;
  y: number;
  kind: GripKind;
  /** Polyline/Spline-Vertex-Index. */
  vertexIndex?: number;
  /** Linien-Endpunkt 0 oder 1. */
  endIdx?: 0 | 1;
  /** Rechteck-Ecken-Index (0=TL, 1=TR, 2=BR, 3=BL). */
  cornerIdx?: 0 | 1 | 2 | 3;
  /** Rechteck-Kanten-Identifier. */
  edge?: RectEdge;
  /** Kreis-Quadranten-Identifier. */
  circleAxis?: CircleAxis;
  /** Bogen-Endpunkt 0 (a1-Seite) oder 1 (a2-Seite). */
  arcEnd?: 0 | 1;
  /** Ellipsen-Achse: 'rx' = Hauptachse (lokale X), 'ry' = Nebenachse. */
  ellipseAxis?: 'rx' | 'ry';
  /** Seite entlang der Achse: +1 (positive Richtung) oder -1. */
  ellipseSide?: 1 | -1;
};

export type GripHit = {
  entityId: number;
  grip: Grip;
  /** Offset vom Cursor zum Griffmittelpunkt beim Mousedown, damit der Griff
   *  beim ersten Mousemove nicht auf den Cursor "springt". */
  grabDx: number;
  grabDy: number;
};

// ============================================================================
// Griffe pro Entitätstyp enumerieren
// ============================================================================

/**
 * Liefert alle Griffe einer Entität in Weltkoordinaten. Für Typen ohne
 * Unterstützung (dim, hatch, xline) ein leeres Array — die User-Erwartung ist
 * dort schwächer und die Geometrie unpraktisch für direkte Griffe.
 */
export function entityGrips(e: Entity): Grip[] {
  if (e.type === 'line')     return lineGrips(e);
  if (e.type === 'circle')   return circleGrips(e);
  if (e.type === 'arc')      return arcGrips(e);
  if (e.type === 'rect')     return rectGrips(e);
  if (e.type === 'ellipse')  return ellipseGrips(e);
  if (e.type === 'polyline') return polylineGrips(e);
  if (e.type === 'spline')   return splineGrips(e);
  if (e.type === 'text')     return textGrips(e);
  if (e.type === 'dim')      return dimGrips(e);
  return [];
}

function lineGrips(e: LineEntity): Grip[] {
  return [
    { x: e.x1, y: e.y1, kind: 'endpoint', endIdx: 0 },
    { x: e.x2, y: e.y2, kind: 'endpoint', endIdx: 1 },
    { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2, kind: 'move' },
  ];
}

function circleGrips(e: CircleEntity): Grip[] {
  return [
    { x: e.cx,          y: e.cy,          kind: 'move' },
    { x: e.cx + e.r,    y: e.cy,          kind: 'circle-quad', circleAxis: 'e' },
    { x: e.cx,          y: e.cy + e.r,    kind: 'circle-quad', circleAxis: 'n' },
    { x: e.cx - e.r,    y: e.cy,          kind: 'circle-quad', circleAxis: 'w' },
    { x: e.cx,          y: e.cy - e.r,    kind: 'circle-quad', circleAxis: 's' },
  ];
}

function arcGrips(e: ArcEntity): Grip[] {
  const aMid = (e.a1 + e.a2) / 2;
  return [
    { x: e.cx,                              y: e.cy,                              kind: 'move' },
    { x: e.cx + e.r * Math.cos(e.a1),       y: e.cy + e.r * Math.sin(e.a1),       kind: 'arc-end', arcEnd: 0 },
    { x: e.cx + e.r * Math.cos(e.a2),       y: e.cy + e.r * Math.sin(e.a2),       kind: 'arc-end', arcEnd: 1 },
    { x: e.cx + e.r * Math.cos(aMid),       y: e.cy + e.r * Math.sin(aMid),       kind: 'arc-mid' },
  ];
}

function rectGrips(e: RectEntity): Grip[] {
  const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
  const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
  const cx = (xl + xr) / 2, cy = (yb + yt) / 2;
  return [
    // 4 Ecken — TL, TR, BR, BL (CW von oben-links, wie frame-grips in textgrips.ts)
    { x: xl, y: yt, kind: 'rect-corner', cornerIdx: 0 },
    { x: xr, y: yt, kind: 'rect-corner', cornerIdx: 1 },
    { x: xr, y: yb, kind: 'rect-corner', cornerIdx: 2 },
    { x: xl, y: yb, kind: 'rect-corner', cornerIdx: 3 },
    // 4 Kantenmitten
    { x: cx, y: yt, kind: 'rect-edge', edge: 'top' },
    { x: xr, y: cy, kind: 'rect-edge', edge: 'right' },
    { x: cx, y: yb, kind: 'rect-edge', edge: 'bottom' },
    { x: xl, y: cy, kind: 'rect-edge', edge: 'left' },
    // Zentrum
    { x: cx, y: cy, kind: 'move' },
  ];
}

function ellipseGrips(e: EllipseEntity): Grip[] {
  const cosR = Math.cos(e.rot), sinR = Math.sin(e.rot);
  const rxX  =  e.rx * cosR, rxY =  e.rx * sinR;
  const ryX  = -e.ry * sinR, ryY =  e.ry * cosR;
  return [
    { x: e.cx,         y: e.cy,         kind: 'move' },
    { x: e.cx + rxX,   y: e.cy + rxY,   kind: 'ellipse-axis', ellipseAxis: 'rx', ellipseSide:  1 },
    { x: e.cx - rxX,   y: e.cy - rxY,   kind: 'ellipse-axis', ellipseAxis: 'rx', ellipseSide: -1 },
    { x: e.cx + ryX,   y: e.cy + ryY,   kind: 'ellipse-axis', ellipseAxis: 'ry', ellipseSide:  1 },
    { x: e.cx - ryX,   y: e.cy - ryY,   kind: 'ellipse-axis', ellipseAxis: 'ry', ellipseSide: -1 },
  ];
}

function polylineGrips(e: PolylineEntity): Grip[] {
  return e.pts.map((p, i): Grip => ({
    x: p.x, y: p.y, kind: 'vertex', vertexIndex: i,
  }));
}

function splineGrips(e: SplineEntity): Grip[] {
  return e.pts.map((p, i): Grip => ({
    x: p.x, y: p.y, kind: 'vertex', vertexIndex: i,
  }));
}

/**
 * Grips for dimension entities. We only surface grips for linear dims for now —
 * angular/radius/diameter dims have different offset semantics (arc radius,
 * leader tail) and need their own tailored grip sets.
 *
 *   • offset grip: sits at the midpoint of the rendered dim line (= offset of
 *     (p1+p2)/2 along the perpendicular to p1→p2). Dragging it moves the
 *     dim line closer/farther from the measured geometry. The drag handler
 *     constrains motion to the perpendicular and writes back only the offset
 *     PointRef so any link from p1/p2 to a line's endpoints stays intact.
 */
function dimGrips(e: DimEntity): Grip[] {
  if (e.dimKind && e.dimKind !== 'linear') return [];
  const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return [];
  const nx = -dy / L, ny = dx / L;
  // Signed perpendicular distance from p1→p2 to the offset point — same
  // formula as the renderer, so the grip sits exactly on the dim line.
  const sd = (e.offset.x - e.p1.x) * nx + (e.offset.y - e.p1.y) * ny;
  const mx = (e.p1.x + e.p2.x) / 2 + nx * sd;
  const my = (e.p1.y + e.p2.y) / 2 + ny * sd;
  return [
    { x: mx, y: my, kind: 'dim-offset' },
  ];
}

function textGrips(e: TextEntity): Grip[] {
  // Textgriff = Einfügepunkt, fungiert als Move-Griff. Rahmen-Ecken werden in
  // textgrips.ts gesondert gezeichnet (nur für Rahmentext) und dort
  // behandelt — hier NICHT doppelt ausgeben.
  return [{ x: e.x, y: e.y, kind: 'move' }];
}

// ============================================================================
// Hit-Test (Screen-Raum)
// ============================================================================

/**
 * Untersucht alle ausgewählten Entitäten auf einen Griff unter `screenPt`.
 * Nur aktiv, wenn genau EINE Entität ausgewählt ist — bei Mehrfachauswahl
 * würden sich die Griffe gegenseitig ins Gehege kommen und das UX-Pattern
 * ("dieses eine Objekt bearbeiten") wäre kaputt.
 *
 * Rahmen-Grips von Rahmentext werden bewusst übergangen — die Pipeline in
 * main.ts ruft zuerst findFrameGripHit() auf, das die Rahmen-Ecken exklusiv
 * bedient.
 */
export function findGripHit(screenPt: Pt): GripHit | null {
  if (state.selection.size !== 1) return null;
  const id = [...state.selection][0];
  const ent = state.entities.find(x => x.id === id);
  if (!ent) return null;
  // Rahmentext: der Rahmen hat eigene Ecken-Griffe; nur der Einfügepunkt
  // würde hier kollidieren. Wir liefern KEINEN Griff für Rahmentext, damit
  // das bestehende textgrips-Pattern unverändert greift.
  if (ent.type === 'text' && ent.boxWidth !== undefined) return null;
  // Gesperrte Layer: keine Griffe, Geometrie darf nicht bewegt werden.
  const layer = state.layers[ent.layer];
  if (!layer || layer.locked) return null;

  const grips = entityGrips(ent);
  for (const g of grips) {
    const s = worldToScreen({ x: g.x, y: g.y });
    if (Math.abs(s.x - screenPt.x) <= GRIP_HALF_PX &&
        Math.abs(s.y - screenPt.y) <= GRIP_HALF_PX) {
      return { entityId: ent.id, grip: g, grabDx: 0, grabDy: 0 };
    }
  }
  return null;
}

// ============================================================================
// Anwendung des Griff-Drags — Entität aus Snapshot + Deltavektor neu bauen
// ============================================================================

/**
 * Berechnet eine neue EntityInit aus dem Start-Snapshot, dem Grip und dem
 * neuen Weltpunkt. Der Renderer zeichnet die resultierende Entität und der
 * Aufrufer schreibt sie per `replaceFeatureFromInit` zurück.
 *
 * `newPoint` ist der Weltpunkt, auf den der GRIFF gezogen wurde (bereits um
 * grabDx/grabDy kompensiert). `startEntity` ist der unveränderte Zustand vor
 * Beginn des Drags — daraus werden alle "andere Kanten bleiben fix"-
 * Berechnungen abgeleitet, damit keine Akkumulation von Rundungsfehlern
 * auftritt.
 */
export function computeGripDragInit(
  startEntity: Entity,
  grip: Grip,
  newPoint: Pt,
  deltaFromGripStart: Pt,
): EntityInit | null {
  const { x: nx, y: ny } = newPoint;
  const { x: dx, y: dy } = deltaFromGripStart;

  if (startEntity.type === 'line') {
    const e = startEntity;
    if (grip.kind === 'move') {
      return { type: 'line', layer: e.layer,
        x1: e.x1 + dx, y1: e.y1 + dy,
        x2: e.x2 + dx, y2: e.y2 + dy };
    }
    if (grip.kind === 'endpoint') {
      if (grip.endIdx === 0) {
        return { type: 'line', layer: e.layer, x1: nx, y1: ny, x2: e.x2, y2: e.y2 };
      }
      return { type: 'line', layer: e.layer, x1: e.x1, y1: e.y1, x2: nx, y2: ny };
    }
  }

  if (startEntity.type === 'circle') {
    const e = startEntity;
    if (grip.kind === 'move') {
      return { type: 'circle', layer: e.layer, cx: e.cx + dx, cy: e.cy + dy, r: e.r };
    }
    if (grip.kind === 'circle-quad') {
      // Radius = Abstand vom (unveränderten) Zentrum zum neuen Griffpunkt.
      const r = Math.hypot(nx - e.cx, ny - e.cy);
      if (r < 1e-6) return null;
      return { type: 'circle', layer: e.layer, cx: e.cx, cy: e.cy, r };
    }
  }

  if (startEntity.type === 'arc') {
    const e = startEntity;
    if (grip.kind === 'move' || grip.kind === 'arc-mid') {
      return { type: 'arc', layer: e.layer,
        cx: e.cx + dx, cy: e.cy + dy, r: e.r, a1: e.a1, a2: e.a2 };
    }
    if (grip.kind === 'arc-end') {
      // Gezogenes Ende bestimmt neuen Winkel + neuen Radius; Gegenende hält
      // seinen alten Winkel, bekommt aber den neuen Radius.
      const ang = Math.atan2(ny - e.cy, nx - e.cx);
      const r = Math.hypot(nx - e.cx, ny - e.cy);
      if (r < 1e-6) return null;
      const a1 = grip.arcEnd === 0 ? ang : e.a1;
      const a2 = grip.arcEnd === 1 ? ang : e.a2;
      return { type: 'arc', layer: e.layer, cx: e.cx, cy: e.cy, r, a1, a2 };
    }
  }

  if (startEntity.type === 'rect') {
    const e = startEntity;
    // Normalisierte Kanten aus Snapshot: xl < xr, yb < yt.
    const xl = Math.min(e.x1, e.x2), xr = Math.max(e.x1, e.x2);
    const yb = Math.min(e.y1, e.y2), yt = Math.max(e.y1, e.y2);
    if (grip.kind === 'move') {
      return { type: 'rect', layer: e.layer,
        x1: xl + dx, y1: yb + dy, x2: xr + dx, y2: yt + dy };
    }
    if (grip.kind === 'rect-corner') {
      // Die gegenüberliegende Ecke bleibt fix; die gezogene Ecke landet auf nx/ny.
      // Ecken-Indizes: 0=TL (xl,yt), 1=TR (xr,yt), 2=BR (xr,yb), 3=BL (xl,yb).
      let newXl = xl, newXr = xr, newYb = yb, newYt = yt;
      if (grip.cornerIdx === 0) { newXl = nx; newYt = ny; }
      if (grip.cornerIdx === 1) { newXr = nx; newYt = ny; }
      if (grip.cornerIdx === 2) { newXr = nx; newYb = ny; }
      if (grip.cornerIdx === 3) { newXl = nx; newYb = ny; }
      return { type: 'rect', layer: e.layer,
        x1: newXl, y1: newYb, x2: newXr, y2: newYt };
    }
    if (grip.kind === 'rect-edge') {
      let newXl = xl, newXr = xr, newYb = yb, newYt = yt;
      if (grip.edge === 'top')    newYt = ny;
      if (grip.edge === 'bottom') newYb = ny;
      if (grip.edge === 'left')   newXl = nx;
      if (grip.edge === 'right')  newXr = nx;
      return { type: 'rect', layer: e.layer,
        x1: newXl, y1: newYb, x2: newXr, y2: newYt };
    }
  }

  if (startEntity.type === 'ellipse') {
    const e = startEntity;
    if (grip.kind === 'move') {
      return { type: 'ellipse', layer: e.layer,
        cx: e.cx + dx, cy: e.cy + dy, rx: e.rx, ry: e.ry, rot: e.rot };
    }
    if (grip.kind === 'ellipse-axis') {
      // Vektor von Zentrum zum neuen Griffpunkt. Bei der Hauptachse (rx)
      // bestimmt dieser Vektor auch die neue Rotation; die Nebenachse bleibt
      // senkrecht dazu. Bei der Nebenachse (ry) halten wir die Rotation fest
      // und lesen nur die Länge entlang der Nebenachsen-Richtung.
      const vx = nx - e.cx, vy = ny - e.cy;
      const L = Math.hypot(vx, vy);
      if (L < 1e-6) return null;
      if (grip.ellipseAxis === 'rx') {
        const side = grip.ellipseSide ?? 1;
        const rot = Math.atan2(vy * side, vx * side);
        return { type: 'ellipse', layer: e.layer,
          cx: e.cx, cy: e.cy, rx: L, ry: e.ry, rot };
      } else {
        // ry: Länge entlang der NEBENACHSE (senkrecht zu rot) = Projektion.
        // Vorzeichen aus ellipseSide erhält Orientierung.
        const nxAxis = -Math.sin(e.rot), nyAxis = Math.cos(e.rot);
        const proj = Math.abs(vx * nxAxis + vy * nyAxis);
        if (proj < 1e-6) return null;
        return { type: 'ellipse', layer: e.layer,
          cx: e.cx, cy: e.cy, rx: e.rx, ry: proj, rot: e.rot };
      }
    }
  }

  if (startEntity.type === 'polyline') {
    const e = startEntity;
    if (grip.kind === 'move') {
      return { type: 'polyline', layer: e.layer, closed: !!e.closed,
        pts: e.pts.map(p => ({ x: p.x + dx, y: p.y + dy })) };
    }
    if (grip.kind === 'vertex' && grip.vertexIndex != null) {
      const pts = e.pts.map(p => ({ x: p.x, y: p.y }));
      pts[grip.vertexIndex] = { x: nx, y: ny };
      return { type: 'polyline', layer: e.layer, closed: !!e.closed, pts };
    }
  }

  if (startEntity.type === 'spline') {
    const e = startEntity;
    if (grip.kind === 'move') {
      return { type: 'spline', layer: e.layer, closed: !!e.closed,
        pts: e.pts.map(p => ({ x: p.x + dx, y: p.y + dy })) };
    }
    if (grip.kind === 'vertex' && grip.vertexIndex != null) {
      const pts = e.pts.map(p => ({ x: p.x, y: p.y }));
      pts[grip.vertexIndex] = { x: nx, y: ny };
      return { type: 'spline', layer: e.layer, closed: !!e.closed, pts };
    }
  }

  if (startEntity.type === 'text') {
    const e = startEntity;
    if (grip.kind === 'move') {
      return {
        type: 'text', layer: e.layer,
        x: e.x + dx, y: e.y + dy,
        text: e.text, height: e.height,
        ...(e.rotation !== undefined ? { rotation: e.rotation } : {}),
        ...(e.boxWidth !== undefined ? { boxWidth: e.boxWidth } : {}),
      };
    }
  }

  return null;
}
