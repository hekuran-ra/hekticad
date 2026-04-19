# HektikCad — Acceptance Tests

**Regel:** Jede Checkbox muss durch einen Playwright-Test oder manuellen Screenshot-Vergleich gegen `reference/prototype.png` belegt sein, bevor "fertig" gemeldet wird.

---

## 1. Layout & Shell

- [ ] Header ist exakt **38px** hoch, Footer **26px**, Tool-Rail **156px**, Sidebar **280px** breit
- [ ] Brand-Logo links im Header: H-Monogramm in CI-Blau `#5B8DEF`, Wortmarke „HEKTIK**CAD**" mit farbigem „CAD"
- [ ] Titelbalken zeigt Dateiname + Änderungs-Punkt (`•` in `--draw`) bei ungespeicherten Changes
- [ ] Menübar: Datei · Bearbeiten · Ansicht · Einfügen · Format · Werkzeuge · Parametrisch · Fenster · Hilfe
- [ ] Footer zeigt: aktives Tool (Kategorie-Farbe) · Koordinaten · FANG · ORTHO · POLAR · Einheit · Zoom-%

## 2. Tool Rail (3 Kategorien)

- [ ] Drei Spalten nebeneinander: **Hilfen** · **Zeichnen** · **Ändern**
- [ ] Jede Spalte hat eigene Überschrift in Kategorie-Farbe mit 20px-Strich darunter
- [ ] Vertikaler 1px-Trenner `#141414` zwischen den Spalten
- [ ] Tool-Buttons: 40×34px, Icon 18×18, stroke-width 1.5, stroke-linecap round
- [ ] Hover zeigt Tooltip rechts mit Label + Shortcut
- [ ] Active State: Kategorie-Farbe als Text + 12%-Fill + 30%-Border

## 3. Sidebar (Ebenen / Variablen / Verlauf)

- [ ] Drei Panels untereinander, alle mit Toggle-Header + Counter-Badge
- [ ] Header-Text uppercase, 10.5px, 1.3px letter-spacing
- [ ] Chevron rotiert auf 0° (offen) bzw. -90° (zu) mit 150ms-Transition
- [ ] **Ebenen** und **Variablen** offen by default, **Verlauf** geschlossen
- [ ] Counter-Badge zeigt Zahl der Items (Layers/Variables/History Steps)
- [ ] Offenes Panel füllt verfügbaren Platz (`flex: 1 1 auto`)

### Ebenen (Layers)
- [ ] Aktive Ebene hat 2px linken Border in `--sel` + 10%-Fill
- [ ] Sichtbarkeits-Toggle: Auge/durchgestrichenes Auge
- [ ] Lock-Toggle: Schloss offen/zu
- [ ] Farb-Swatch 14×14 links
- [ ] Doppelklick auf Namen → inline rename (border `--draw`)
- [ ] Hidden Layer: opacity 0.35 auf Name + Swatch

### Variablen
- [ ] Grid: 80px Name · 1fr Expression · 70px Result
- [ ] Expression in `--draw` (amber)
- [ ] Live recompute beim Editieren
- [ ] Syntax-Error: Border + Text in `--modify` (rot)
- [ ] Result mit Einheit (z.B. „1200 mm") — Einheit in `--fg-faint`

### Verlauf
- [ ] Timeline mit Spine-Line, Dots und Kategorie-Bars
- [ ] Aktiver HEAD-Step: gefüllter Dot + `KOPF` Badge
- [ ] Future Steps (nach Rollback): gestrichelter Dot, opacity 0.4
- [ ] Klick auf Step rollt State dorthin zurück

## 4. Canvas

- [ ] Grid: minor `#101010`, major `#1a1a1a` (jede 10te Linie)
- [ ] X-Achse rot `#a44`, Y-Achse grün `#4a8`, beide opacity 0.6
- [ ] Mausrad zoomt auf **Cursor-Position**, nicht Canvas-Mitte
- [ ] Space + LMB-Drag ODER MMB-Drag → Pan; Cursor wird zu `grabbing`
- [ ] Grundriss ist sichtbar (Wohnungs-Floorplan in grau)
- [ ] Coord-Readout bottom-left zeigt live Welt-Koordinaten + Einheit
- [ ] Zoom-% in Footer rechts aktualisiert sich live

### Snap (OSNAP)
- [ ] F3 toggelt OSNAP global; Toolbar oben-links
- [ ] Prioritäts-Reihenfolge: END > INTERSECT > CENTER > QUAD > MID > PERP > TANGENT > NEAR > GRID
- [ ] Marker-Shapes korrekt: END=Quadrat, MID=Raute, CENTER=Kreis, QUAD=halbtransp. Raute, INTERSECT=X, PERP=umgedrehtes L, TANGENT=Kreis+Tick, NEAR=Sanduhr
- [ ] Label-Text direkt neben Marker in Mono 10px uppercase (z.B. `END`, `MITTE`, `ZENTR`, `QUAD`)
- [ ] Snap-Radius = 12px Screen-Space (= 12/zoom in world coords)
- [ ] Bei Klick mit aktivem Snap wird Snap-Punkt verwendet, nicht Rohposition
- [ ] Performance: 60fps bei 5000+ Entities (Spatial-Index Pflicht)

### Crosshair Guides
- [ ] Horizontale + vertikale Linie durch Cursor, volle Canvas-Abdeckung
- [ ] Farbe = Akzent des aktiven Tools, opacity 0.6
- [ ] Nicht sichtbar bei Select-Tool
- [ ] Verschwinden wenn Cursor Canvas verlässt
- [ ] Rasten auf Snap-Punkt ein wenn Snap aktiv

## 5. Tool-Funktionen

### Hilfen (grün)
- [ ] **Messen**: 2 Klicks → zeigt Distanz + Winkel in Dim-Style
- [ ] **Bemaßung**: Linear/Ausgerichtet/Winkel — Text Mono 11px, paint-order stroke
- [ ] **Text**: Klick → Cursor-Input → commit mit Enter
- [ ] **Hilfslinie**: unendliche Construction Line durch 2 Punkte
- [ ] **Hilfspunkt**: Marker-Punkt ohne Geometrie

### Zeichnen (amber/blau)
- [ ] **Linie** (L): 2 Klicks → Line Entity; Preview gestrichelt in `--draw`; ESC = abbrechen
- [ ] **Polylinie**: mehrere Klicks; Enter/Doppelklick = fertig; C = schließen
- [ ] **Rechteck** (R): 2 Klicks (Ecke → Ecke); Preview-Fill 12% `--draw`
- [ ] **Kreis** (C): Mittelpunkt + Radiuspunkt; Preview gestrichelt
- [ ] **Bogen**: 3-Punkt (Start, Mitte, Ende)
- [ ] **Ellipse**: Mittelpunkt + 2 Achsen
- [ ] **Spline**: Control-Points via Klicks, Enter = fertig

### Ändern (rot)
- [ ] **Verschieben** (M): Auswahl → Basispunkt → Ziel
- [ ] **Kopieren** (CP): wie Verschieben aber Original bleibt
- [ ] **Drehen**: Auswahl → Drehpunkt → Winkel (numerisch oder klickbar)
- [ ] **Skalieren**: Auswahl → Basis → Faktor
- [ ] **Spiegeln**: Auswahl → 2-Punkt-Achse
- [ ] **Stutzen** (T): Klick auf Entity-Teil über Schnittpunkt
- [ ] **Versetzen** (O): parallele Kopie in Abstand
- [ ] **Abrunden**: Radius-Prompt, 2 Entities wählen → Fillet
- [ ] **Fasen**: wie Fillet aber lineare Schräge
- [ ] **Löschen** (E / Del): entfernt Selektion

## 6. Interaktions-Regeln

- [ ] **ESC** bricht jedes Kommando ab, setzt Tool auf Select
- [ ] **Enter / Space** wiederholt letztes Kommando
- [ ] **Ortho (F8)**: constraint auf 0°/90°; Indicator in Footer leuchtet
- [ ] **Polar (F10)**: 15°/30°/45°/90° Tracking-Strahlen vom letzten Punkt
- [ ] **LMB-Drag links→rechts**: Window Selection (blauer gefüllter Rahmen, nur vollständig enthaltene Entities)
- [ ] **LMB-Drag rechts→links**: Crossing Selection (grüner gestrichelter Rahmen, alle berührten Entities)
- [ ] **Shift + Click**: zur Auswahl addieren
- [ ] **Ctrl + Click**: aus Auswahl entfernen
- [ ] **Delete**: löscht Selektion

## 7. Command Prompt

- [ ] Bottom-center overlay; erscheint während Tool aktiv ist
- [ ] Zeigt Kommandoname (uppercase, `--draw`) + Prompt-Text
- [ ] Bold Tokens (Ziel-Eingabe) heben sich in `--fg` ab
- [ ] Inline-Input-Feld für numerische Eingabe (Mono, 80px wide)
- [ ] Verschwindet bei Rückkehr zu Select

## 8. Tweaks Panel

- [ ] Toggle-Button oben rechts im Header nur sichtbar wenn Tweaks-Modus aktiv
- [ ] Panel floatet bottom-right, 260px wide
- [ ] Farb-Swatches für Guides, Zeichnen-Accent
- [ ] Stroke-Width Slider (1.0 – 2.5, step 0.1)
- [ ] Änderungen live + persisted via `__edit_mode_set_keys` postMessage

## 9. Performance

- [ ] 60fps beim Pan/Zoom mit 1000 Entities
- [ ] Snap-Suche unter 4ms bei 5000 Entities (Spatial-Index)
- [ ] Crosshair + Snap-Marker via requestAnimationFrame, nicht auf jedem mousemove
- [ ] Kein Re-Render des Canvas bei Sidebar-Interaktionen

## 10. Visueller Pixel-Vergleich

- [ ] Screenshot bei 1920×1080 mit Zoom 100% → diff gegen `reference/prototype.png` < 2% Pixel-Abweichung
- [ ] Dark-Mode-Parität: alle Panels zeigen near-black `#050505` / `#0a0a0a` Oberflächen
- [ ] Kein sichtbarer weißer Flash beim Load (Background setzt vor dem ersten Paint)

---

## Workflow für Claude Code

1. Lies `reference/DESIGN_SPEC.md` **vor** jedem neuen Component
2. Lies `reference/prototype.html` und übernimm CSS-Werte 1:1 (keine Adjektive, nur Zahlen)
3. Nach jedem Feature: Screenshot mit Playwright + visueller Vergleich gegen `reference/prototype.png`
4. Jeder Eintrag hier muss grün sein, bevor Du „fertig" meldest
5. Bei Abweichung: **nicht ausliefern**, sondern fixen oder explizit eskalieren
