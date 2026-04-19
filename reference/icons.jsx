// Icon library — all 22x22 viewBox, consumed as inline SVG paths
const ICONS = {
  // GUIDES (green) — measurement, snap, reference
  point:    '<circle cx="11" cy="11" r="2" fill="currentColor"/><line x1="11" y1="3" x2="11" y2="6"/><line x1="11" y1="16" x2="11" y2="19"/><line x1="3" y1="11" x2="6" y2="11"/><line x1="16" y1="11" x2="19" y2="11"/>',
  axis:     '<line x1="3" y1="11" x2="19" y2="11" stroke-dasharray="3 2"/><line x1="11" y1="3" x2="11" y2="19" stroke-dasharray="3 2"/>',
  ref_line: '<line x1="3" y1="18" x2="19" y2="4" stroke-dasharray="4 2"/>',
  ref_circle:'<circle cx="11" cy="11" r="7" stroke-dasharray="3 2"/>',
  measure:  '<path d="M3 6 L19 6 M3 4 L3 8 M19 4 L19 8 M5 13 L17 13 L17 17 L5 17 Z"/>',
  angle:    '<path d="M4 18 L4 4 M4 18 L18 18"/><path d="M4 11 A 7 7 0 0 1 11 18" stroke-dasharray="2 2"/>',

  // DRAW (amber) — geometry creation
  line:     '<line x1="4" y1="18" x2="18" y2="4"/><circle cx="4" cy="18" r="1.4" fill="currentColor"/><circle cx="18" cy="4" r="1.4" fill="currentColor"/>',
  poly:     '<polyline points="3,17 7,9 12,13 16,5 19,9" /><circle cx="3" cy="17" r="1.2" fill="currentColor"/><circle cx="19" cy="9" r="1.2" fill="currentColor"/>',
  rect:     '<rect x="4" y="6" width="14" height="10"/>',
  circle:   '<circle cx="11" cy="11" r="7"/>',
  arc:      '<path d="M3 16 A 9 9 0 0 1 19 16"/>',
  ellipse:  '<ellipse cx="11" cy="11" rx="8" ry="5"/>',
  spline:   '<path d="M3 14 C 6 6, 10 18, 13 10 S 18 6, 19 8"/>',
  text:     '<path d="M5 5 L17 5 M11 5 L11 18 M9 18 L13 18"/>',
  hatch:    '<rect x="4" y="4" width="14" height="14"/><line x1="4" y1="10" x2="11" y2="4"/><line x1="4" y1="15" x2="16" y2="4"/><line x1="6" y1="18" x2="18" y2="6"/><line x1="11" y1="18" x2="18" y2="11"/>',

  // MODIFY (red) — transforms
  move:     '<path d="M11 3 L11 19 M3 11 L19 11 M11 3 L8 6 M11 3 L14 6 M11 19 L8 16 M11 19 L14 16 M3 11 L6 8 M3 11 L6 14 M19 11 L16 8 M19 11 L16 14"/>',
  rotate:   '<path d="M5 15 A 7 7 0 1 0 5 7"/><path d="M5 4 L5 8 L9 8"/>',
  scale:    '<path d="M4 18 L4 4 L18 4"/><path d="M9 13 L13 9 M9 11 L11 11 M11 9 L11 11 M14 14 L18 18 M18 16 L18 18 L16 18"/>',
  mirror:   '<line x1="11" y1="3" x2="11" y2="19" stroke-dasharray="2 2"/><path d="M4 6 L9 6 L9 16 L4 16 Z"/><path d="M18 6 L13 6 L13 16 L18 16 Z" opacity="0.4"/>',
  trim:     '<line x1="4" y1="11" x2="18" y2="11"/><line x1="11" y1="4" x2="11" y2="18"/><circle cx="11" cy="11" r="2.5" fill="var(--bg-deep)"/>',
  fillet:   '<path d="M4 4 L4 14 A 4 4 0 0 0 8 18 L18 18"/>',
  offset:   '<rect x="3" y="3" width="10" height="10"/><rect x="6" y="6" width="10" height="10" stroke-dasharray="2 2"/>',
  trash:    '<path d="M5 7 L17 7 M9 7 L9 5 L13 5 L13 7 M7 7 L7 18 L15 18 L15 7"/>',
};

// Tools by category
const TOOLS_BY_CAT = {
  guides: [
    { id: 'point',     label: 'Punkt',           key: 'P' },
    { id: 'axis',      label: 'Bezugsachse',     key: 'X' },
    { id: 'ref_line',  label: 'Hilfslinie',      key: 'H' },
    { id: 'ref_circle',label: 'Hilfskreis',      key: 'K' },
    { id: 'measure',   label: 'Bemaßung',        key: 'D' },
    { id: 'angle',     label: 'Winkel messen',   key: 'W' },
  ],
  draw: [
    { id: 'line',      label: 'Linie',           key: 'L' },
    { id: 'poly',      label: 'Polylinie',       key: 'Y' },
    { id: 'rect',      label: 'Rechteck',        key: 'R' },
    { id: 'circle',    label: 'Kreis',           key: 'C' },
    { id: 'arc',       label: 'Bogen',           key: 'A' },
    { id: 'ellipse',   label: 'Ellipse',         key: 'E' },
    { id: 'spline',    label: 'Spline',          key: 'N' },
    { id: 'text',      label: 'Text',            key: 'T' },
    { id: 'hatch',     label: 'Schraffur',       key: 'F' },
  ],
  modify: [
    { id: 'move',      label: 'Verschieben',     key: 'V' },
    { id: 'rotate',    label: 'Drehen',          key: 'O' },
    { id: 'scale',     label: 'Skalieren',       key: 'S' },
    { id: 'mirror',    label: 'Spiegeln',        key: 'M' },
    { id: 'trim',      label: 'Stutzen',         key: 'B' },
    { id: 'fillet',    label: 'Abrunden',        key: 'G' },
    { id: 'offset',    label: 'Versatz',         key: 'U' },
    { id: 'trash',     label: 'Löschen',         key: 'Entf' },
  ],
};

const CAT_LABELS = {
  guides: 'Hilfen',
  draw:   'Zeichnen',
  modify: 'Ändern',
};

window.ICONS = ICONS;
window.TOOLS_BY_CAT = TOOLS_BY_CAT;
window.CAT_LABELS = CAT_LABELS;
