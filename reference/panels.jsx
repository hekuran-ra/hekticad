// Right-side panels: Ebenen / Variablen / Verlauf

const { useState: useS } = React;

function LayersPanel({ layers, setLayers, activeLayer, setActiveLayer }) {
  const toggle = (id, key) => setLayers(ls => ls.map(l => l.id===id ? {...l, [key]: !l[key]} : l));
  const rename = (id, name) => setLayers(ls => ls.map(l => l.id===id ? {...l, name} : l));
  return (
    <div className="panel-body active">
      <div className="panel-section">
        <div className="panel-header">
          Ebenen <span className="ph-count">{layers.length}</span>
          <div className="ph-actions">
            <button title="Neue Ebene"><svg viewBox="0 0 12 12"><path d="M6 2 L6 10 M2 6 L10 6"/></svg></button>
            <button title="Ebene löschen"><svg viewBox="0 0 12 12"><path d="M2 4 L10 4 M4 4 L4 10 L8 10 L8 4"/></svg></button>
          </div>
        </div>
        {layers.map(l => (
          <div key={l.id}
            className={'layer-row' + (activeLayer===l.id?' active':'') + (!l.visible?' hidden':'')}
            onClick={() => setActiveLayer(l.id)}>
            <span className="swatch" style={{background: l.color}}/>
            <span className="name"
              onDoubleClick={e => { e.target.contentEditable = 'true'; e.target.focus(); }}
              onBlur={e => { e.target.contentEditable = 'false'; rename(l.id, e.target.textContent); }}
              onKeyDown={e => { if (e.key==='Enter') { e.preventDefault(); e.target.blur(); } }}>
              {l.name}
            </span>
            <button className="vis" onClick={(e)=>{e.stopPropagation(); toggle(l.id,'visible');}} title={l.visible?'Ausblenden':'Einblenden'}>
              {l.visible
                ? <svg viewBox="0 0 20 20"><path d="M2 10 C 5 4, 15 4, 18 10 C 15 16, 5 16, 2 10 Z"/><circle cx="10" cy="10" r="2.5"/></svg>
                : <svg viewBox="0 0 20 20"><path d="M3 3 L17 17" /><path d="M4 10 C 6 6, 14 6, 16 10" opacity="0.5"/></svg>
              }
            </button>
            <button className="lock" onClick={(e)=>{e.stopPropagation(); toggle(l.id,'locked');}} title={l.locked?'Entsperren':'Sperren'}>
              {l.locked
                ? <svg viewBox="0 0 20 20"><rect x="4" y="9" width="12" height="8" rx="1"/><path d="M7 9 V6 A3 3 0 0 1 13 6 V9"/></svg>
                : <svg viewBox="0 0 20 20"><rect x="4" y="9" width="12" height="8" rx="1"/><path d="M7 9 V6 A3 3 0 0 1 13 6"/></svg>
              }
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function VariablesPanel({ vars, setVars }) {
  // re-evaluate all expressions
  const evalVars = (arr) => {
    const scope = {};
    return arr.map(v => {
      const out = { ...v };
      try {
        // Allow unicode identifiers, replace German chars with safe names internally
        const mapName = (n) => n.replace(/ä/g,'_ae').replace(/ö/g,'_oe').replace(/ü/g,'_ue').replace(/ß/g,'_ss');
        const safeExpr = v.expr.replace(/[a-zA-ZäöüÄÖÜß_][a-zA-Z0-9äöüÄÖÜß_]*/g, (m) => {
          if (['Math','abs','sin','cos','tan','sqrt','PI','E','pi'].includes(m)) {
            if (m==='pi') return 'Math.PI';
            if (m==='PI') return 'Math.PI';
            if (m==='E') return 'Math.E';
            if (m==='sin'||m==='cos'||m==='tan'||m==='sqrt'||m==='abs') return 'Math.'+m;
            return m;
          }
          return 'scope['+JSON.stringify(mapName(m))+']';
        });
        // eslint-disable-next-line no-new-func
        const fn = new Function('scope', 'return ('+safeExpr+')');
        const r = fn(scope);
        out.result = r;
        out.error = null;
        scope[mapName(v.name)] = r;
      } catch (e) { out.error = 'Fehler'; out.result = NaN; }
      return out;
    });
    function mapName(n){ return n.replace(/ä/g,'_ae').replace(/ö/g,'_oe').replace(/ü/g,'_ue').replace(/ß/g,'_ss'); }
  };

  const updateExpr = (i, expr) => {
    setVars(arr => evalVars(arr.map((v,k) => k===i ? {...v, expr} : v)));
  };
  const fmt = (n, unit) => {
    if (typeof n !== 'number' || isNaN(n)) return '—';
    const d = Math.abs(n) >= 100 ? 1 : 2;
    return n.toFixed(d);
  };

  return (
    <div className="panel-body active">
      <div className="panel-section">
        <div className="panel-header">
          Variablen <span className="ph-count">{vars.length}</span>
          <div className="ph-actions">
            <button title="Neue Variable"><svg viewBox="0 0 12 12"><path d="M6 2 L6 10 M2 6 L10 6"/></svg></button>
          </div>
        </div>
        {vars.map((v, i) => (
          <div key={v.name} className={'var-row' + (v.error?' error':'')}>
            <span className="var-name">{v.name}</span>
            <input className="var-expr" value={v.expr}
              onChange={e => updateExpr(i, e.target.value)}
              spellCheck={false}/>
            <span className="var-result">{fmt(v.result)}<span>{v.unit}</span></span>
          </div>
        ))}
        <div className="var-add">+ Variable hinzufügen</div>
      </div>
    </div>
  );
}

function HistoryPanel({ history, head, setHead }) {
  return (
    <div className="panel-body active">
      <div className="panel-section">
        <div className="panel-header">
          Verlauf <span className="ph-count">{history.length}</span>
          <div className="ph-actions">
            <button title="Zurück (⌘Z)"><svg viewBox="0 0 12 12"><path d="M3 6 L1 4 L3 2 M1 4 L7 4 A3 3 0 0 1 7 10"/></svg></button>
            <button title="Vorwärts"><svg viewBox="0 0 12 12"><path d="M9 6 L11 4 L9 2 M11 4 L5 4 A3 3 0 0 0 5 10"/></svg></button>
          </div>
        </div>
        <div className="timeline">
          {history.map((h, i) => {
            const isActive = i === head;
            const isFuture = i > head;
            const iconSvg = (window.ICONS||{})[h.icon] || '';
            return (
              <div key={h.id} className={'tl-row' + (isActive?' active head':'') + (isFuture?' future':'')}
                onClick={() => setHead(i)}>
                <span className="tl-dot"/>
                <span className="tl-cat" data-cat={h.cat}/>
                <span className="tl-icon" dangerouslySetInnerHTML={{__html: `<svg viewBox='0 0 22 22'>${iconSvg}</svg>`}}/>
                <span className="tl-label">{h.label}</span>
                <span className="tl-detail">{h.detail}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

window.LayersPanel = LayersPanel;
window.VariablesPanel = VariablesPanel;
window.HistoryPanel = HistoryPanel;
