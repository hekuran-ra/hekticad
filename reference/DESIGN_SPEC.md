# HektikCad — Design Spec

**Verbindliche Referenz.** Jede Abweichung bei Layout, Spacing, Typography, Farbe oder Interaktionsverhalten gilt als Bug. Bei Unsicherheit: die `reference/prototype.html` öffnen und CSS 1:1 übernehmen.

---

## 1. Layout

### App-Grid
```
grid-template-rows:    38px 1fr 26px       /* header / main / footer */
grid-template-columns: 156px 1fr 280px     /* tools / canvas / sidebar */
```
- Header: `#0a0a0a`, 1px bottom-border `#1a1a1a`
- Footer: `#0a0a0a`, 1px top-border `#1a1a1a`
- Canvas: `#000000`

### Tool Rail (links, 156px)
- 3 Spalten à 52px in einem inneren `grid-template-columns: repeat(3, 1fr)`
- Jede Spalte ist eine `.cat` mit `flex-direction: column`
- Trenner zwischen Spalten: `border-left: 1px solid #141414` (ab zweiter Spalte)
- Kategorie-Überschrift oben: 8.5px, uppercase, letter-spacing 1.3px, weight 700, in Kategorie-Farbe mit 85% Opacity, 20px breiter Farb-Strich darunter
- Reihenfolge: **Hilfen** (grün) · **Zeichnen** (amber/blau) · **Ändern** (rot)

### Sidebar (rechts, 280px)
- Drei `.side-section` untereinander: **Ebenen**, **Variablen**, **Verlauf**
- Jeder Header: `padding: 10px 12px`, bg `#101010`, sticky `top:0`
- Chevron links (12px), Titel-Text mittig, Counter-Badge rechts
- Header-Text: 10.5px, uppercase, letter-spacing 1.3px, weight 600, color `#888` (aktiv: `#e8e6e2`)
- Badge: Space Mono 10px, bg `#000`, border `1px #1a1a1a`, padding `1px 6px`, radius 8px
- `.side-section.open` bekommt `flex: 1 1 auto; min-height: 120px`
- `.side-section.closed` → body collapsed, Chevron `rotate(-90deg)`

---

## 2. Typography

### Fonts
```
--sans: 'DM Sans', -apple-system, system-ui, 'Segoe UI', sans-serif
--mono: 'Space Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace
```
- Google Fonts Import: `DM+Sans:wght@300;400;500;700&family=Space+Mono:wght@400;700`

### Scale
| Use | Font | Size | Weight | Tracking |
|---|---|---|---|---|
| body | sans | 12.5px/1.5 | 300 | — |
| section header | sans | 10.5px | 600 | 1.3px uppercase |
| tool tooltip | sans | 11px | 400 | — |
| category label | sans | 8.5px | 700 | 1.3px uppercase |
| brand mark | sans | 11.5px | 500 | 3px uppercase |
| coord readout | mono | 11px | 400 | — |
| variable expr/name | mono | 11.5px | 400 | — |
| history detail | mono | 10.5px | 400 | — |
| footer status | mono | 11px | 400 | — |
| snap label | mono | 10px | 400 | — |
| dim text | mono | 11px | 400 | — |
| badge counter | mono | 10px | 400 | — |

---

## 3. Colors (exakt, keine Abweichung)

```css
--bg:        #050505   /* app background */
--bg-deep:   #000000   /* canvas, deepest input */
--panel:     #0a0a0a   /* surfaces (header/footer/tools/sidebar) */
--panel-2:   #101010   /* hover, section header bg */
--panel-3:   #161616   /* pressed/nested */
--hair:      #1a1a1a   /* primary border */
--hair-soft: #141414   /* internal dividers */
--fg:        #e8e6e2   /* primary text */
--fg-mid:    #888      /* secondary text */
--fg-dim:    #555      /* tertiary text / icons */
--fg-faint:  #333      /* disabled / micro-meta */

--accent:    #5B8DEF   /* CI blue — brand + selection */

--guides:    #14b8a6   /* Hilfen (teal, tweakable) */
--draw:      #fbbf24   /* Zeichnen (amber, tweakable) */
--modify:    #a44      /* Ändern (desat red) */
--sel:       #5B8DEF   /* selection (= accent) */

--grid:      #101010   /* minor grid */
--grid-maj:  #1a1a1a   /* major grid */
--axis-x:    #a44      /* X axis */
--axis-y:    #4a8      /* Y axis */
```

**Regel:** Kategorie-Farben werden für Akzente mit `color-mix(in oklab, <color> 10–30%, transparent)` verwendet (aktive Tool-Fill, Header-Highlight, Timeline-Dots).

---

## 4. Komponenten

### Tool Button (`.tool-btn`)
- Size: **40 × 34 px**, margin `0 auto` (zentriert in Spalte)
- Border-radius: 4px, border: `1px solid transparent`
- Icon: SVG **18 × 18**, `stroke: currentColor`, `fill: none`, `stroke-width: 1.5`, `stroke-linecap: round`, `stroke-linejoin: round`, `vector-effect: non-scaling-stroke`
- Default color: `#888`
- Hover: `background: #101010`, `color: #e8e6e2`
- Active: `color: var(--cat-color)`, `background: color-mix(in oklab, var(--cat-color) 12%, transparent)`, `border-color: color-mix(in oklab, var(--cat-color) 30%, transparent)`
- Tooltip: erscheint rechts nach Hover, bg `#000`, border `1px #1a1a1a`, padding `5px 9px`, radius 4px, 11px; mit Pfeil (5px border-right `#1a1a1a`)
- Tooltip-Text: `data-label " — " data-key` (deutsche Bezeichnung + Shortcut)

### Tool Rail Category
- `.cat-label` mit 20px breitem 2px-Strich in `--cat-color` als `::before`, absolut zentriert am unteren Rand
- Spalten-Trenner via `.cat + .cat { border-left: 1px solid #141414 }`

### Sidebar Section Header
- Padding: `10px 12px`
- Chevron: 12px SVG, color `#555`, `transform: rotate(-90deg)` wenn geschlossen
- Hover: `background: #161616`, text `#e8e6e2`
- Titel: `flex: 1`, uppercase
- Counter: bg `#000`, `1px solid #1a1a1a`, `padding: 1px 6px`, `border-radius: 8px`, Mono 10px, color `#333`

### Layer Row
- Padding: `6px 12px`, gap 8px
- Border-left 2px transparent; aktiv → `--sel`; bg `color-mix(in oklab, var(--sel) 10%, transparent)`
- Swatch: 14 × 14, radius 2px, `1px solid rgba(0,0,0,0.4)`
- Visibility/Lock Icons: 18 × 18, SVG 14 × 14, stroke 1.5, color `#555` → hover `#e8e6e2`
- Hidden state: `opacity: 0.35` auf name/swatch, `color: #333` auf vis icon

### Variable Row
- Grid: `80px 1fr 70px`, gap 8px, padding `6px 12px`
- Name: color `#e8e6e2`
- Expr input: bg `#000`, `1px solid #1a1a1a`, padding `2px 6px`, radius 2px, color `--draw` (amber)
- Expr focus: border-color `--draw`
- Result: right-aligned, color `#888`, Einheit in `#333` mit 3px margin-left
- Error: border + text in `--modify`

### Timeline Row
- Padding: `5px 12px 5px 14px`, font-size 12px
- Spine: `::before` mit `left: 22px, width: 1px, background: #1a1a1a`; erster Eintrag startet bei 50%, letzter endet bei 50%
- Dot: 9 × 9, radius 50%, `border: 1.5px solid #555`, bg `#161616`
- Active dot: bg + border `--sel`, `box-shadow: 0 0 0 3px color-mix(in oklab, var(--sel) 25%, transparent)`
- Future dot: transparent, border-style dashed, row opacity 0.4
- Cat-Bar: 4 × 14, radius 2px, in `--draw` / `--modify` / `--guides`
- HEAD-Badge: `KOPF`, 9px, bg `--sel`, color `#000`, padding `1px 5px`, radius 2px, letter-spacing 1px

### Command Prompt (canvas overlay, bottom-center)
- Absolute, `bottom: 10px`, `left: 50%`, `transform: translateX(-50%)`
- bg `#0a0a0a`, `1px #1a1a1a`, radius 4px, padding `6px 12px`
- Min-width 360px, max-width 60%
- Command name: 10px, uppercase, color `--draw`, weight 600
- Text: `#888`, bold tokens in `#e8e6e2`
- Inline input: Mono, bg `#000`, `1px #1a1a1a`, padding `2px 6px`, width 80px

### Snap Marker
- Stroke `--guides`, stroke-width 1.5, `vector-effect: non-scaling-stroke`, fill: none
- Size 10–12 px im Screen-Space
- Shapes:
  - `END` Quadrat · `MID` Raute · `CENTER` Kreis · `QUAD` Raute (halbtransparent) · `INTERSECT` X · `PERP` umgedrehtes L · `TANGENT` Kreis mit Tangent-Tick · `NEAR` Sanduhr · `GRID` ×
- Label: Mono 10px, uppercase, `fill: --guides`, `paint-order: stroke`, `stroke: #000`, `stroke-width: 3`, 3–4px offset rechts/oben

### Crosshair Guides
- Durchgehende horizontale + vertikale Linien durch Cursor-Position, volle Canvas-Abdeckung
- Stroke 1px, `vector-effect: non-scaling-stroke`, color = `--cat-color` des aktiven Tools, opacity 0.6
- Nur bei aktivem Draw-/Modify-/Guides-Tool sichtbar (nicht bei Select)
- Unter Snap-Markern, über Grid + Entities
- `pointer-events: none`
- Snap-Schnittpunkt: Linien rasten auf Snap-Punkt ein, nicht exakte Maus

### Coord Readout (canvas overlay, bottom-left)
- Absolute `bottom: 10px; left: 10px`
- bg `#0a0a0a`, `1px #1a1a1a`, padding `5px 9px`, radius 3px
- Mono 11px, color `#888`, Werte in `#e8e6e2`, Einheiten in `#333`

### Tweaks Panel (bottom-right, fixed)
- 260px wide, bg `#0a0a0a`, `1px #1a1a1a`, radius 6px
- `box-shadow: 0 12px 40px rgba(0,0,0,0.5)`
- Hidden by default; toggled via `__activate_edit_mode` postMessage
- Rows: label `flex: 1`, color `#888`, 11.5px
- Color swatches: 18 × 18, radius 3px, border `1px #1a1a1a`; active: border `#e8e6e2`, `box-shadow: 0 0 0 1px #e8e6e2`

---

## 5. SVG Canvas Conventions

- **Alle** stroke-basierten Entities: `vector-effect: non-scaling-stroke` (Pflicht — sonst brechen Linien beim Zoom)
- Grid minor: `stroke: #101010, width: 1`
- Grid major: `stroke: #1a1a1a, width: 1` (jede 10te Linie)
- Axis-X: `stroke: #a44, width: 1.5, opacity: 0.6`
- Axis-Y: `stroke: #4a8, width: 1.5, opacity: 0.6`
- Selected entity: `stroke: --sel`, width 2, `drop-shadow(0 0 4px color-mix(in oklab, --sel 60%, transparent))`
- Preview (beim Zeichnen): `stroke: --draw`, width 1.5, `stroke-dasharray: 4 3`, fill transparent
- Preview fill: `color-mix(in oklab, --draw 12%, transparent)`
- Handles: bg `#000`, `stroke: --sel`, width 1.5
- Dim lines: `stroke: #555, width 1`; dim text Mono 11px, paint-order stroke, stroke `#000` width 4

---

## 6. Interaction Rules

- **Ortho-Modus** (F8): zwingt nächste Eingabe auf 0°/90°-Schritte
- **OSNAP** (F3): globales Toggle; einzelne Typen via Toolbar oben-links
- **Polar-Tracking** (F10): 15° / 30° / 45° / 90° Hilfslinien vom letzten Referenzpunkt
- **ESC**: bricht aktuelles Kommando ab, kehrt zu Select zurück
- **Space / Enter**: wiederholt letztes Kommando
- **Mausrad**: Zoom auf Cursor-Position (nicht Mitte!)
- **MMB drag** oder **Space + LMB drag**: Pan
- **LMB**: Klick = Punkt setzen; Drag = window selection (links→rechts, blau) / crossing selection (rechts→links, grün)
- **Shift + Click**: zur Auswahl hinzufügen
- **Ctrl + Click**: aus Auswahl entfernen
- **Delete**: löscht selektierte Entities

---

## 7. Do / Don't

**DO**
- Alle Werte exakt übernehmen. Hex-Codes, Pixel-Zahlen, letter-spacing.
- `vector-effect: non-scaling-stroke` auf jedem Canvas-Stroke.
- `color-mix(in oklab, ...)` für Akzent-Fills und Selektions-Hintergründe.
- `paint-order: stroke` bei SVG-Text, der auf Geometrie liegt.

**DON'T**
- Keine Rounded-Containers mit farbigem Left-Border.
- Keine Emojis. Placeholder nutzen wenn ein Icon fehlt.
- Keine Gradients. Flat Near-Black only.
- Kein Inter / Roboto / System-UI als Body-Font. DM Sans ist Pflicht.
- Keine SVG-Icons größer als 18px in der Tool-Rail.
- Keine Hover-Shadows auf Canvas-Entities (außer Selection-Glow).
