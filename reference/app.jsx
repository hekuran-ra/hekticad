// Main app — multi-root React setup

const { useState: uS, useEffect: uE, useMemo: uM, useCallback: uC, useRef: uR } = React;

// ============ Tool rail ============
function ToolRail({ tool, setTool }) {
  return <>{['guides','draw','modify'].map(cat => (
    <div className="cat" data-cat={cat} key={cat}>
      <div className="cat-bar"/>
      <div className="cat-label">{CAT_LABELS[cat]}</div>
      {TOOLS_BY_CAT[cat].map(t => (
        <button key={t.id}
          className={'tool-btn' + (tool===t.id?' active':'')}
          data-label={t.label} data-key={t.key}
          onClick={() => setTool(t.id)}>
          <svg viewBox="0 0 22 22" dangerouslySetInnerHTML={{__html: ICONS[t.id] || ''}}/>
        </button>
      ))}
    </div>
  ))}</>;
}

// ============ Overlays (floating on canvas) ============
function CanvasOverlays({ view, setView, snapOn, setSnapOn, orthoOn, setOrthoOn, gridOn, setGridOn, cursor, tool }) {
  const fmt = (n) => Math.round(n).toString();
  const resetView = () => setView({ zoom: 0.085, cx: 3600, cy: 2500 });
  return (
    <>
      <div className="snap-toolbar">
        <button className={gridOn?'on':''} onClick={()=>setGridOn(v=>!v)}>RASTER</button>
        <button className={snapOn?'on':''} onClick={()=>setSnapOn(v=>!v)}>FANG</button>
        <button className={orthoOn?'on':''} onClick={()=>setOrthoOn(v=>!v)}>ORTHO</button>
        <div className="sep"/>
        <button className="on">OFANG</button>
        <button>POLAR</button>
      </div>
      <div className="viewcube">
        <button onClick={resetView} title="Alles zeigen">A</button>
        <button onClick={()=>setView(v=>({...v, zoom: Math.min(5, v.zoom*1.25)}))}>+</button>
        <button onClick={()=>setView(v=>({...v, zoom: Math.max(0.005, v.zoom/1.25)}))}>−</button>
        <button onClick={resetView} className="active">⊙</button>
      </div>
      <div className="coord-readout">
        <div><em>X</em> <span>{fmt(cursor.world.x)}</span></div>
        <div><em>Y</em> <span>{fmt(cursor.world.y)}</span></div>
        <div><em>M</em> <span>1:{Math.max(1, Math.round(20/view.zoom))}</span></div>
      </div>
    </>
  );
}

// ============ Command prompt (floating bottom) ============
function CmdPrompt({ tool }) {
  const prompts = {
    select:   ['Auswahl',   'Objekt wählen · oder [Fenster] aufziehen'],
    line:     ['Linie',     'Startpunkt angeben · oder [Länge Winkel]'],
    poly:     ['Polylinie', 'Nächsten Punkt angeben · [Schließen] [Rückgängig]'],
    ref_line: ['Hilfslinie','Durchgangspunkt angeben'],
    ref_circle:['Hilfskreis','Mittelpunkt angeben'],
    rect:     ['Rechteck',  'Erste Ecke angeben · oder [Maße]'],
    circle:   ['Kreis',     'Mittelpunkt angeben · oder [Durchmesser]'],
    arc:      ['Bogen',     'Startpunkt des Bogens'],
    ellipse:  ['Ellipse',   'Achsenendpunkt'],
    spline:   ['Spline',    'Ersten Kontrollpunkt angeben'],
    text:     ['Text',      'Einfügepunkt angeben · Höhe: 3.5mm'],
    hatch:    ['Schraffur', 'Innenpunkt wählen'],
    point:    ['Punkt',     'Position angeben'],
    axis:     ['Bezugsachse','Richtung angeben'],
    measure:  ['Bemaßung',  'Ersten Bemaßungspunkt angeben'],
    angle:    ['Winkel',    'Scheitelpunkt angeben'],
    move:     ['Verschieben','Basispunkt angeben'],
    rotate:   ['Drehen',    'Drehpunkt angeben · Winkel: 0°'],
    scale:    ['Skalieren', 'Basispunkt angeben · Faktor: 1.0'],
    mirror:   ['Spiegeln',  'Erster Punkt der Spiegelachse'],
    trim:     ['Stutzen',   'Schnittkanten wählen · [Alle]'],
    fillet:   ['Abrunden',  'Radius: 50mm · Erstes Objekt wählen'],
    offset:   ['Versatz',   'Abstand angeben: 120mm'],
    trash:    ['Löschen',   'Objekte zum Löschen wählen'],
  };
  const [name, msg] = prompts[tool] || ['Befehl', '...'];
  return (
    <div className="cmd-prompt">
      <span className="cmd-name">{name}</span>
      <span className="cmd-text" dangerouslySetInnerHTML={{__html: msg.replace(/\[(.+?)\]/g,'<b>[$1]</b>')}}/>
      <input className="cmd-input" placeholder="_" spellCheck={false}/>
    </div>
  );
}

// ============ Status bar ============
function StatusBar({ tool, cursor, selection, entities, snapOn, orthoOn, gridOn }) {
  const catEntry = Object.entries(TOOLS_BY_CAT).find(([,ts]) => ts.some(t=>t.id===tool));
  const cat = catEntry?.[0] || 'select';
  const toolLabel = Object.values(TOOLS_BY_CAT).flat().find(t=>t.id===tool)?.label || 'Auswahl';
  const colorVar = cat==='guides'?'--guides':cat==='draw'?'--draw':cat==='modify'?'--modify':'--sel';
  return (
    <>
      <div className="stat tool" style={{'--cat-color': `var(${colorVar})`}}>
        <span>Werkzeug:</span> <b>{toolLabel}</b>
      </div>
      <div className="sep"/>
      <div className="stat"><span>Auswahl:</span> <b>{selection.length}</b></div>
      <div className="stat"><span>Objekte:</span> <b>{entities.length}</b></div>
      <div className="sep"/>
      <div className="stat"><span>X</span> <b>{Math.round(cursor.world.x)}</b></div>
      <div className="stat"><span>Y</span> <b>{Math.round(cursor.world.y)}</b></div>
      <div className="right">
        <div className="stat" style={{color: gridOn?'var(--guides)':'var(--fg-faint)'}}>RASTER</div>
        <div className="stat" style={{color: snapOn?'var(--guides)':'var(--fg-faint)'}}>FANG</div>
        <div className="stat" style={{color: orthoOn?'var(--guides)':'var(--fg-faint)'}}>ORTHO</div>
        <div className="sep"/>
        <div className="stat"><b>Modell</b> · Layout1</div>
      </div>
    </>
  );
}

// ============ Sidebar ============
function Sidebar({ tab, setTab, layers, setLayers, activeLayer, setActiveLayer, vars, setVars, history, head, setHead, openSections, toggleSection }) {
  const Section = ({ id, title, count, children }) => (
    <div className={'side-section' + (openSections[id] ? ' open' : ' closed')}>
      <button className="side-section-header" onClick={() => toggleSection(id)}>
        <svg className="chev" viewBox="0 0 12 12" width="10" height="10">
          <path d="M3 4.5 L6 7.5 L9 4.5" stroke="currentColor" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span className="side-title">{title}</span>
        <span className="side-count">{count}</span>
      </button>
      {openSections[id] && <div className="side-body">{children}</div>}
    </div>
  );
  return (
    <>
      <Section id="layers" title="Ebenen" count={layers.length}>
        <LayersPanel layers={layers} setLayers={setLayers} activeLayer={activeLayer} setActiveLayer={setActiveLayer}/>
      </Section>
      <Section id="vars" title="Variablen" count={vars.length}>
        <VariablesPanel vars={vars} setVars={setVars}/>
      </Section>
      <Section id="history" title="Verlauf" count={history.length}>
        <HistoryPanel history={history} head={head} setHead={setHead}/>
      </Section>
    </>
  );
}

// ============ Root App — single tree, fragments to pre-existing DOM slots via portals ============
function App() {
  const [tool, setTool] = uS('select');
  const [tab, setTab] = uS('layers');
  const [layers, setLayers] = uS(LAYERS);
  const [activeLayer, setActiveLayer] = uS(0);
  const [entities, setEntities] = uS(SCENE_ENTITIES);
  const [selection, setSelection] = uS([]);
  const [view, setView] = uS({ zoom: 0.11, cx: 3600, cy: 2500 });

  // Fit to canvas once mounted
  uE(() => {
    const stage = document.getElementById('stage');
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    // Plan is 7200 x 5000 with margin. Pick zoom that fits.
    const z = Math.min((r.width - 140) / 8000, (r.height - 140) / 5600);
    setView({ zoom: z, cx: 3600, cy: 2500 });
  }, []);
  const [snapOn, setSnapOn] = uS(true);
  const [orthoOn, setOrthoOn] = uS(false);
  const [gridOn, setGridOn] = uS(true);
  const [cursor, setCursor] = uS({ x: 0, y: 0, world: {x: 0, y: 0} });
  const [vars, setVars] = uS(() => {
    const mapName = (n) => n.replace(/ä/g,'_ae').replace(/ö/g,'_oe').replace(/ü/g,'_ue').replace(/ß/g,'_ss');
    const scope = {};
    return VARIABLES.map(v => {
      try {
        const s = v.expr.replace(/[a-zA-ZäöüÄÖÜß_][a-zA-Z0-9äöüÄÖÜß_]*/g, (m) => {
          if (['sin','cos','tan','sqrt','abs'].includes(m)) return 'Math.'+m;
          if (m==='PI'||m==='pi') return 'Math.PI';
          return 'scope['+JSON.stringify(mapName(m))+']';
        });
        const r = new Function('scope','return ('+s+')')(scope);
        scope[mapName(v.name)] = r;
        return {...v, result: r};
      } catch { return {...v, error: 'Fehler'}; }
    });
  });
  const [history, setHistory] = uS(HISTORY);
  const [head, setHead] = uS(HISTORY.length - 1);
  const [openSections, setOpenSections] = uS({ layers: true, vars: true, history: false });
  const toggleSection = (id) => setOpenSections(s => ({ ...s, [id]: !s[id] }));

  const visibleEntities = uM(() => {
    if (head === history.length - 1) return entities;
    const ratio = (head + 1) / history.length;
    const count = Math.max(1, Math.round(entities.length * ratio));
    return entities.slice(0, count);
  }, [entities, head, history.length]);

  const createEntity = (init) => {
    const nextId = Math.max(0, ...entities.map(e=>e.id)) + 1;
    const ent = { id: nextId, ...init };
    setEntities(es => [...es, ent]);
    const catMap = { line: 'draw', rect: 'draw', circle: 'draw', arc: 'draw', xline: 'guides' };
    const labelMap = { line: 'Linie', rect: 'Rechteck', circle: 'Kreis', arc: 'Bogen', xline: 'Hilfslinie' };
    const iconMap  = { line: 'line', rect: 'rect', circle: 'circle', arc: 'arc', xline: 'ref_line' };
    setHistory(h => {
      const next = [...h, { id: 100 + h.length, op: 'create', cat: catMap[init.type]||'draw',
        label: labelMap[init.type]||init.type, detail: 'neu', icon: iconMap[init.type]||'line' }];
      setHead(next.length - 1);
      return next;
    });
  };

  // Keyboard
  uE(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.isContentEditable) return;
      const k = e.key.toUpperCase();
      const all = Object.values(TOOLS_BY_CAT).flat();
      const t = all.find(t => t.key.toUpperCase() === k);
      if (t) { setTool(t.id); e.preventDefault(); return; }
      if (e.key === 'Escape') { setTool('select'); setSelection([]); }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selection.length) {
          setEntities(es => es.filter(x => !selection.includes(x.id)));
          setSelection([]);
          e.preventDefault();
        }
      }
      if (e.key === 'F8') { setOrthoOn(v=>!v); e.preventDefault(); }
      if (e.key === 'F9') { setGridOn(v=>!v); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection]);

  uE(() => { window.__setGrid = setGridOn; }, []);

  return (
    <>
      {ReactDOM.createPortal(<ToolRail tool={tool} setTool={setTool}/>, document.getElementById('tools'))}
      {ReactDOM.createPortal(
        <Sidebar tab={tab} setTab={setTab}
          layers={layers} setLayers={setLayers}
          activeLayer={activeLayer} setActiveLayer={setActiveLayer}
          vars={vars} setVars={setVars}
          history={history} head={head} setHead={setHead}
          openSections={openSections} toggleSection={toggleSection}/>,
        document.getElementById('sidebar'))}
      {ReactDOM.createPortal(
        <StatusBar tool={tool} cursor={cursor} selection={selection} entities={visibleEntities}
          snapOn={snapOn} orthoOn={orthoOn} gridOn={gridOn}/>,
        document.querySelector('footer'))}
      <Canvas tool={tool} setTool={setTool}
        entities={visibleEntities} setEntities={setEntities}
        layers={layers} selection={selection} setSelection={setSelection}
        view={view} setView={setView}
        snapOn={snapOn} orthoOn={orthoOn} gridOn={gridOn}
        onCreateEntity={createEntity}
        onCursor={setCursor}/>
      <CanvasOverlays view={view} setView={setView}
        snapOn={snapOn} setSnapOn={setSnapOn}
        orthoOn={orthoOn} setOrthoOn={setOrthoOn}
        gridOn={gridOn} setGridOn={setGridOn}
        cursor={cursor} tool={tool}/>
      <CmdPrompt tool={tool}/>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('stage')).render(<App/>);
