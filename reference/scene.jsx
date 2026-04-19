// Sample scene — a small apartment floor plan in mm, around 7m x 5m
// Layers: 0=Wände (white), 1=Türen (amber), 2=Fenster (cyan), 3=Möbel (gray), 4=Maße (dim), 5=Hilfen (green)

const LAYERS = [
  { id: 0, name: 'Wände',     color: '#e6ecf2', visible: true,  locked: false },
  { id: 1, name: 'Türen',     color: '#fbbf24', visible: true,  locked: false },
  { id: 2, name: 'Fenster',   color: '#22d3ee', visible: true,  locked: false },
  { id: 3, name: 'Möbel',     color: '#9ca3af', visible: true,  locked: false },
  { id: 4, name: 'Bemaßung',  color: '#8a909c', visible: true,  locked: false },
  { id: 5, name: 'Hilfslinien',color: '#34d399',visible: true,  locked: true  },
  { id: 6, name: 'Elektro',   color: '#a78bfa', visible: false, locked: false },
];

let entityCounter = 1;
const eid = () => entityCounter++;

// Floor plan: outer shell + interior walls + bath + kitchen island + sofa + bed
// Coordinates in mm. Origin at lower-left of building.
const SCENE_ENTITIES = [
  // ====== Wände (layer 0) — outer shell, double-line wall (240mm thick)
  // Outer
  { id: eid(), type: 'rect', layer: 0, x1: 0, y1: 0, x2: 7200, y2: 5000, lw: 2 },
  // Inner offset of outer (drawn as separate rect to fake wall thickness)
  { id: eid(), type: 'rect', layer: 0, x1: 240, y1: 240, x2: 6960, y2: 4760, lw: 1 },

  // Interior wall splitting bedroom from living (vertical at x=4400, from y=240 to y=2800)
  { id: eid(), type: 'line', layer: 0, x1: 4400, y1: 240, x2: 4400, y2: 2800, lw: 2 },
  { id: eid(), type: 'line', layer: 0, x1: 4520, y1: 240, x2: 4520, y2: 2800, lw: 2 },

  // Interior wall splitting bath off (vertical at x=2000, y=2800 to y=4760)
  { id: eid(), type: 'line', layer: 0, x1: 2000, y1: 2800, x2: 2000, y2: 4760, lw: 2 },
  { id: eid(), type: 'line', layer: 0, x1: 2120, y1: 2800, x2: 2120, y2: 4760, lw: 2 },

  // Horizontal wall — separates living from bath corridor (y=2800)
  { id: eid(), type: 'line', layer: 0, x1: 240, y1: 2800, x2: 4400, y2: 2800, lw: 2 },
  { id: eid(), type: 'line', layer: 0, x1: 240, y1: 2920, x2: 2000, y2: 2920, lw: 2 },
  { id: eid(), type: 'line', layer: 0, x1: 2120, y1: 2920, x2: 4400, y2: 2920, lw: 2 },

  // ====== Türen (layer 1) — door swings as arcs + lines
  // Front door bottom
  { id: eid(), type: 'arc', layer: 1, cx: 3500, cy: 240, r: 900, a1: 0, a2: Math.PI/2, lw: 1 },
  { id: eid(), type: 'line', layer: 1, x1: 3500, y1: 240, x2: 3500, y2: 1140, lw: 1.5 },
  // Bedroom door
  { id: eid(), type: 'arc', layer: 1, cx: 4400, cy: 1500, r: 800, a1: -Math.PI/2, a2: 0, lw: 1 },
  { id: eid(), type: 'line', layer: 1, x1: 4400, y1: 700, x2: 5200, y2: 700, lw: 1.5 },
  // Bath door
  { id: eid(), type: 'arc', layer: 1, cx: 2120, cy: 3300, r: 700, a1: 0, a2: Math.PI/2, lw: 1 },
  { id: eid(), type: 'line', layer: 1, x1: 2120, y1: 3300, x2: 2120, y2: 4000, lw: 1.5 },

  // ====== Fenster (layer 2) — windows, drawn as parallel lines on walls
  // Bedroom window (right wall)
  { id: eid(), type: 'line', layer: 2, x1: 6960, y1: 800, x2: 6960, y2: 2200, lw: 1.5 },
  { id: eid(), type: 'line', layer: 2, x1: 7200, y1: 800, x2: 7200, y2: 2200, lw: 1.5 },
  { id: eid(), type: 'line', layer: 2, x1: 7080, y1: 800, x2: 7080, y2: 2200, lw: 0.5 },
  // Living room window (top wall)
  { id: eid(), type: 'line', layer: 2, x1: 1200, y1: 4760, x2: 3800, y2: 4760, lw: 1.5 },
  { id: eid(), type: 'line', layer: 2, x1: 1200, y1: 5000, x2: 3800, y2: 5000, lw: 1.5 },
  { id: eid(), type: 'line', layer: 2, x1: 1200, y1: 4880, x2: 3800, y2: 4880, lw: 0.5 },
  // Bath window (top wall, smaller)
  { id: eid(), type: 'line', layer: 2, x1: 600, y1: 4760, x2: 1100, y2: 4760, lw: 1.5 },
  { id: eid(), type: 'line', layer: 2, x1: 600, y1: 5000, x2: 1100, y2: 5000, lw: 1.5 },
  // Bedroom window 2 (top, behind bedroom)
  { id: eid(), type: 'line', layer: 2, x1: 5200, y1: 4760, x2: 6400, y2: 4760, lw: 1.5 },
  { id: eid(), type: 'line', layer: 2, x1: 5200, y1: 5000, x2: 6400, y2: 5000, lw: 1.5 },

  // ====== Möbel (layer 3)
  // Sofa, living room
  { id: eid(), type: 'rect', layer: 3, x1: 400,  y1: 600, x2: 2400, y2: 1400, lw: 1 },
  { id: eid(), type: 'rect', layer: 3, x1: 400,  y1: 1400, x2: 2400, y2: 1700, lw: 1 },
  // Coffee table
  { id: eid(), type: 'rect', layer: 3, x1: 800,  y1: 1900, x2: 1900, y2: 2400, lw: 1 },
  // Dining table (round)
  { id: eid(), type: 'circle', layer: 3, cx: 3300, cy: 2100, r: 600, lw: 1 },
  // Dining chairs (small circles)
  { id: eid(), type: 'circle', layer: 3, cx: 3300, cy: 1300, r: 200, lw: 1 },
  { id: eid(), type: 'circle', layer: 3, cx: 3300, cy: 2900, r: 200, lw: 1 },
  { id: eid(), type: 'circle', layer: 3, cx: 2500, cy: 2100, r: 200, lw: 1 },
  { id: eid(), type: 'circle', layer: 3, cx: 4100, cy: 2100, r: 200, lw: 1 },
  // Bed (bedroom)
  { id: eid(), type: 'rect', layer: 3, x1: 4700, y1: 3200, x2: 6500, y2: 4500, lw: 1 },
  { id: eid(), type: 'rect', layer: 3, x1: 4700, y1: 3200, x2: 6500, y2: 3400, lw: 1 },
  // Nightstands
  { id: eid(), type: 'rect', layer: 3, x1: 4520, y1: 3400, x2: 4700, y2: 3800, lw: 1 },
  { id: eid(), type: 'rect', layer: 3, x1: 6500, y1: 3400, x2: 6700, y2: 3800, lw: 1 },
  // Wardrobe
  { id: eid(), type: 'rect', layer: 3, x1: 4520, y1: 4100, x2: 4520+2200, y2: 4700, lw: 1 },
  // Bath: tub, sink, toilet
  { id: eid(), type: 'rect', layer: 3, x1: 300,  y1: 3000, x2: 1900, y2: 3700, lw: 1 },  // tub
  { id: eid(), type: 'circle', layer: 3, cx: 1700, cy: 4300, r: 220, lw: 1 },           // sink
  { id: eid(), type: 'rect', layer: 3, x1: 350,  y1: 4100, x2: 700,  y2: 4500, lw: 1 }, // toilet

  // ====== Bemaßung (layer 4) — exterior dimensions
  { id: eid(), type: 'dim', layer: 4, p1:{x:0,y:0}, p2:{x:7200,y:0}, off: -800, label: '7200' },
  { id: eid(), type: 'dim', layer: 4, p1:{x:7200,y:0}, p2:{x:7200,y:5000}, off: 800, label: '5000' },
  { id: eid(), type: 'dim', layer: 4, p1:{x:0,y:0}, p2:{x:4400,y:0}, off: -400, label: '4400' },
  { id: eid(), type: 'dim', layer: 4, p1:{x:4400,y:0}, p2:{x:7200,y:0}, off: -400, label: '2800' },

  // ====== Hilfslinien (layer 5) — construction guides
  { id: eid(), type: 'xline', layer: 5, x1: 0, y1: 2860, x2: 7200, y2: 2860 },  // horiz mid
  { id: eid(), type: 'xline', layer: 5, x1: 4460, y1: 0, x2: 4460, y2: 5000 },  // vert
];

const VARIABLES = [
  { name: 'wandstärke',  expr: '240',         result: 240,   unit: 'mm' },
  { name: 'raumhöhe',    expr: '2700',        result: 2700,  unit: 'mm' },
  { name: 'türbreite',   expr: '900',         result: 900,   unit: 'mm' },
  { name: 'fensterhöhe', expr: 'raumhöhe - 900', result: 1800, unit: 'mm' },
  { name: 'grundfläche', expr: '7.2 * 5.0',   result: 36.00, unit: 'm²' },
  { name: 'umfang',      expr: '2*(7.2+5.0)', result: 24.40, unit: 'm' },
];

const HISTORY = [
  { id: 1, op: 'create', cat: 'draw',   label: 'Außenwand', detail: '7200×5000', icon: 'rect' },
  { id: 2, op: 'modify', cat: 'modify', label: 'Versatz', detail: '240 mm', icon: 'offset' },
  { id: 3, op: 'create', cat: 'draw',   label: 'Innenwand', detail: '2× Linie', icon: 'line' },
  { id: 4, op: 'create', cat: 'draw',   label: 'Trennwand Bad', detail: '2× Linie', icon: 'line' },
  { id: 5, op: 'create', cat: 'draw',   label: 'Korridorwand', detail: '2× Linie', icon: 'line' },
  { id: 6, op: 'create', cat: 'draw',   label: 'Türblatt', detail: 'Bogen + Linie', icon: 'arc' },
  { id: 7, op: 'create', cat: 'draw',   label: 'Schlafzimmertür', detail: 'Bogen + Linie', icon: 'arc' },
  { id: 8, op: 'create', cat: 'draw',   label: 'Badtür', detail: 'Bogen + Linie', icon: 'arc' },
  { id: 9, op: 'create', cat: 'draw',   label: 'Fenster O', detail: '3× Linie', icon: 'line' },
  { id:10, op: 'create', cat: 'draw',   label: 'Fenster N (Wohnen)', detail: '3× Linie', icon: 'line' },
  { id:11, op: 'create', cat: 'draw',   label: 'Fenster N (Bad)', detail: '2× Linie', icon: 'line' },
  { id:12, op: 'create', cat: 'draw',   label: 'Fenster N (Schlafen)', detail: '2× Linie', icon: 'line' },
  { id:13, op: 'create', cat: 'draw',   label: 'Sofa', detail: '2400×1100', icon: 'rect' },
  { id:14, op: 'create', cat: 'draw',   label: 'Couchtisch', detail: '1100×500', icon: 'rect' },
  { id:15, op: 'create', cat: 'draw',   label: 'Esstisch', detail: 'Ø1200', icon: 'circle' },
  { id:16, op: 'create', cat: 'draw',   label: 'Esszimmerstühle', detail: '4× Kreis', icon: 'circle' },
  { id:17, op: 'create', cat: 'draw',   label: 'Bett', detail: '1800×1300', icon: 'rect' },
  { id:18, op: 'create', cat: 'draw',   label: 'Nachttische', detail: '2× Rechteck', icon: 'rect' },
  { id:19, op: 'create', cat: 'draw',   label: 'Kleiderschrank', detail: '2200×600', icon: 'rect' },
  { id:20, op: 'create', cat: 'draw',   label: 'Badewanne', detail: '1600×700', icon: 'rect' },
  { id:21, op: 'create', cat: 'draw',   label: 'Waschbecken + WC', detail: 'Sanitär', icon: 'circle' },
  { id:22, op: 'create', cat: 'guides', label: 'Hilfsachsen', detail: '2× Achse', icon: 'axis' },
  { id:23, op: 'create', cat: 'draw',   label: 'Außenmaße', detail: '4× Bemaßung', icon: 'measure' },
];

window.LAYERS = LAYERS;
window.SCENE_ENTITIES = SCENE_ENTITIES;
window.VARIABLES = VARIABLES;
window.HISTORY = HISTORY;
