// Canvas component — renders scene to SVG, handles pan/zoom/select/draw

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// World ↔ screen
// World coords in mm. Y up in world, Y down in screen. We invert at render.
function Canvas({ tool, setTool, entities, setEntities, layers, selection, setSelection,
                  view, setView, snapOn, orthoOn, gridOn, onCreateEntity, onCursor, pushHistory }) {
  const svgRef = useRef(null);
  const [cursor, setCursor] = useState({ x: 0, y: 0, world: {x:0,y:0} });
  const [hover, setHover] = useState(null); // hovered entity id
  const [snap, setSnap] = useState(null); // current snap point
  const [drawState, setDrawState] = useState(null); // in-progress draw
  const [pan, setPan] = useState(null); // in-progress pan
  const [marquee, setMarquee] = useState(null);

  // Convert screen px → world
  const screenToWorld = useCallback((sx, sy) => {
    const el = svgRef.current;
    const rect = el ? el.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
    const x = (sx - rect.left - rect.width/2) / view.zoom + view.cx;
    const y = -((sy - rect.top - rect.height/2) / view.zoom) + view.cy;
    return { x, y };
  }, [view]);

  const worldToScreen = useCallback((wx, wy) => {
    const el = svgRef.current;
    const rect = el ? el.getBoundingClientRect() : { width: 800, height: 600 };
    return {
      x: (wx - view.cx) * view.zoom + rect.width/2,
      y: -(wy - view.cy) * view.zoom + rect.height/2,
    };
  }, [view]);

  // Build viewBox so that SVG coords == screen coords (we manage transform ourselves)
  const [size, setSize] = useState({ w: 800, h: 600 });
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (!svgRef.current) return;
      const r = svgRef.current.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    });
    if (svgRef.current) ro.observe(svgRef.current);
    return () => ro.disconnect();
  }, []);

  // Grid
  const grid = useMemo(() => {
    // Choose grid step based on zoom. In world units (mm).
    const z = view.zoom;
    // target ~40px between minor lines
    const target = 40 / z;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const candidates = [1, 2, 5, 10].map(k => k * pow);
    let step = candidates[0];
    for (const c of candidates) if (Math.abs(c - target) < Math.abs(step - target)) step = c;

    const majorEvery = 5;
    const rect = { w: size.w, h: size.h };
    const tl = screenToWorld(0, 0);
    const br = screenToWorld(rect.w, rect.h);
    const x0 = Math.floor(tl.x / step) * step;
    const x1 = Math.ceil(br.x / step) * step;
    const y0 = Math.floor(br.y / step) * step;
    const y1 = Math.ceil(tl.y / step) * step;

    const minor = [], major = [];
    for (let x = x0; x <= x1; x += step) {
      const s = worldToScreen(x, 0);
      const isMajor = Math.abs(Math.round(x/step) % majorEvery) < 0.01;
      (isMajor ? major : minor).push(<line key={`vx${x}`} x1={s.x} y1={0} x2={s.x} y2={rect.h} className={isMajor?'grid-line-major':'grid-line'}/>);
    }
    for (let y = y0; y <= y1; y += step) {
      const s = worldToScreen(0, y);
      const isMajor = Math.abs(Math.round(y/step) % majorEvery) < 0.01;
      (isMajor ? major : minor).push(<line key={`hy${y}`} x1={0} y1={s.y} x2={rect.w} y2={s.y} className={isMajor?'grid-line-major':'grid-line'}/>);
    }
    return { lines: [...minor, ...major], step };
  }, [view, size, screenToWorld, worldToScreen]);

  // Axes (x=0 and y=0 lines)
  const axes = useMemo(() => {
    const ox = worldToScreen(0, 0);
    return (
      <>
        <line x1={0} y1={ox.y} x2={size.w} y2={ox.y} className="axis-x"/>
        <line x1={ox.x} y1={0} x2={ox.x} y2={size.h} className="axis-y"/>
      </>
    );
  }, [size, worldToScreen]);

  // Render entities
  const entityElements = entities.map(e => {
    const layer = layers[e.layer];
    if (!layer || !layer.visible) return null;
    const stroke = layer.color;
    const isSel = selection.includes(e.id);
    const isHov = hover === e.id;
    const cls = 'entity' + (isSel ? ' selected' : '');
    const sw = (e.lw || 1) * (isHov ? 1.5 : 1);
    const opacity = layer.locked ? 0.6 : 1;
    const common = { stroke, strokeWidth: sw, className: cls, opacity, onMouseEnter: () => setHover(e.id), onMouseLeave: () => setHover(h => h===e.id?null:h) };

    if (e.type === 'line' || e.type === 'xline') {
      const a = worldToScreen(e.x1, e.y1), b = worldToScreen(e.x2, e.y2);
      return <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...common}
        strokeDasharray={e.type==='xline'?'6 4':null}/>;
    }
    if (e.type === 'rect') {
      const a = worldToScreen(e.x1, e.y1), b = worldToScreen(e.x2, e.y2);
      const x = Math.min(a.x,b.x), y = Math.min(a.y,b.y);
      const w = Math.abs(a.x-b.x), h = Math.abs(a.y-b.y);
      return <rect key={e.id} x={x} y={y} width={w} height={h} {...common}/>;
    }
    if (e.type === 'circle') {
      const c = worldToScreen(e.cx, e.cy);
      return <circle key={e.id} cx={c.x} cy={c.y} r={e.r*view.zoom} {...common}/>;
    }
    if (e.type === 'arc') {
      const c = worldToScreen(e.cx, e.cy);
      const r = e.r*view.zoom;
      // In world, y is up; in screen, y is down. So arc sweep direction flips.
      const p1 = { x: c.x + Math.cos(e.a1)*r, y: c.y - Math.sin(e.a1)*r };
      const p2 = { x: c.x + Math.cos(e.a2)*r, y: c.y - Math.sin(e.a2)*r };
      const large = Math.abs(e.a2-e.a1) > Math.PI ? 1 : 0;
      // because y is flipped, CCW world = CW screen → sweep = 0
      const d = `M ${p1.x} ${p1.y} A ${r} ${r} 0 ${large} 0 ${p2.x} ${p2.y}`;
      return <path key={e.id} d={d} {...common}/>;
    }
    if (e.type === 'dim') {
      const p1 = worldToScreen(e.p1.x, e.p1.y);
      const p2 = worldToScreen(e.p2.x, e.p2.y);
      // Offset perpendicular
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const L = Math.hypot(dx, dy) || 1;
      const nx = -dy/L, ny = dx/L;
      const off = (e.off || 400) * view.zoom * 0.5; // scale offset by zoom a bit
      const ox = nx * off, oy = ny * off;
      const q1 = { x: p1.x + ox, y: p1.y + oy };
      const q2 = { x: p2.x + ox, y: p2.y + oy };
      const mid = { x: (q1.x+q2.x)/2, y: (q1.y+q2.y)/2 };
      return (
        <g key={e.id} opacity={opacity} onMouseEnter={()=>setHover(e.id)} onMouseLeave={()=>setHover(h=>h===e.id?null:h)}>
          <line x1={p1.x} y1={p1.y} x2={q1.x} y2={q1.y} className="dim-line"/>
          <line x1={p2.x} y1={p2.y} x2={q2.x} y2={q2.y} className="dim-line"/>
          <line x1={q1.x} y1={q1.y} x2={q2.x} y2={q2.y} className="dim-line"/>
          <text x={mid.x} y={mid.y - 4} textAnchor="middle" className="dim-text">{e.label}</text>
        </g>
      );
    }
    return null;
  });

  // Snap search
  const findSnap = useCallback((world) => {
    if (!snapOn) return null;
    const thresh = 12 / view.zoom; // screen px → world
    let best = null, bd = thresh;
    const tryPt = (p, type, entId) => {
      const d = Math.hypot(p.x-world.x, p.y-world.y);
      if (d < bd) { bd = d; best = { ...p, type, entityId: entId }; }
    };
    for (const e of entities) {
      if (!layers[e.layer]?.visible) continue;
      if (e.type === 'line') {
        tryPt({x:e.x1,y:e.y1}, 'end', e.id);
        tryPt({x:e.x2,y:e.y2}, 'end', e.id);
        tryPt({x:(e.x1+e.x2)/2,y:(e.y1+e.y2)/2}, 'mid', e.id);
      } else if (e.type === 'rect') {
        tryPt({x:e.x1,y:e.y1},'end',e.id); tryPt({x:e.x2,y:e.y1},'end',e.id);
        tryPt({x:e.x1,y:e.y2},'end',e.id); tryPt({x:e.x2,y:e.y2},'end',e.id);
        tryPt({x:(e.x1+e.x2)/2,y:(e.y1+e.y2)/2},'center',e.id);
      } else if (e.type === 'circle') {
        tryPt({x:e.cx,y:e.cy},'center',e.id);
        tryPt({x:e.cx+e.r,y:e.cy},'quad',e.id);
        tryPt({x:e.cx-e.r,y:e.cy},'quad',e.id);
        tryPt({x:e.cx,y:e.cy+e.r},'quad',e.id);
        tryPt({x:e.cx,y:e.cy-e.r},'quad',e.id);
      } else if (e.type === 'arc') {
        tryPt({x:e.cx,y:e.cy},'center',e.id);
      }
    }
    // grid snap as fallback
    if (!best && gridOn) {
      const step = grid.step;
      const gx = Math.round(world.x/step)*step;
      const gy = Math.round(world.y/step)*step;
      if (Math.hypot(gx-world.x, gy-world.y) < thresh*0.6) {
        best = { x: gx, y: gy, type: 'grid' };
      }
    }
    return best;
  }, [snapOn, gridOn, view.zoom, entities, layers, grid.step]);

  // Mouse handlers
  const onMove = (e) => {
    const world = screenToWorld(e.clientX, e.clientY);
    setCursor({ x: e.clientX, y: e.clientY, world });
    if (onCursor) onCursor({ x: e.clientX, y: e.clientY, world });

    if (pan) {
      const dx = e.clientX - pan.startX;
      const dy = e.clientY - pan.startY;
      setView(v => ({ ...v, cx: pan.startCx - dx/v.zoom, cy: pan.startCy + dy/v.zoom }));
      return;
    }

    const sn = findSnap(world);
    setSnap(sn);

    if (drawState) {
      let p = sn ? { x: sn.x, y: sn.y } : world;
      if (orthoOn && drawState.from) {
        const dx = p.x - drawState.from.x, dy = p.y - drawState.from.y;
        if (Math.abs(dx) > Math.abs(dy)) p.y = drawState.from.y;
        else p.x = drawState.from.x;
      }
      setDrawState(ds => ({ ...ds, to: p }));
    }

    if (marquee) {
      setMarquee(m => ({ ...m, x2: e.clientX, y2: e.clientY }));
    }
  };

  const onDown = (e) => {
    if (e.button === 1 || (e.button === 0 && e.altKey) || e.button === 2) {
      // middle or alt+left → pan
      setPan({ startX: e.clientX, startY: e.clientY, startCx: view.cx, startCy: view.cy });
      return;
    }
    const world = screenToWorld(e.clientX, e.clientY);
    const sn = findSnap(world);
    const p = sn ? { x: sn.x, y: sn.y } : world;

    if (tool === 'select') {
      // Click entity under hover → select
      if (hover != null) {
        if (e.shiftKey) setSelection(s => s.includes(hover) ? s.filter(x=>x!==hover) : [...s, hover]);
        else setSelection([hover]);
      } else {
        setSelection([]);
        setMarquee({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY });
      }
      return;
    }

    // Drawing tools
    if (tool === 'line' || tool === 'ref_line') {
      if (!drawState) setDrawState({ tool, from: p, to: p });
      else {
        onCreateEntity({ type: tool==='ref_line'?'xline':'line',
          layer: tool==='ref_line'?5:0,
          x1: drawState.from.x, y1: drawState.from.y, x2: p.x, y2: p.y, lw: 1.5 });
        setDrawState(null);
      }
    } else if (tool === 'rect') {
      if (!drawState) setDrawState({ tool, from: p, to: p });
      else {
        onCreateEntity({ type: 'rect', layer: 0,
          x1: drawState.from.x, y1: drawState.from.y, x2: p.x, y2: p.y, lw: 1.5 });
        setDrawState(null);
      }
    } else if (tool === 'circle') {
      if (!drawState) setDrawState({ tool, from: p, to: p });
      else {
        const r = Math.hypot(p.x-drawState.from.x, p.y-drawState.from.y);
        onCreateEntity({ type: 'circle', layer: 0,
          cx: drawState.from.x, cy: drawState.from.y, r, lw: 1.5 });
        setDrawState(null);
      }
    } else if (tool === 'point') {
      onCreateEntity({ type: 'circle', layer: 5, cx: p.x, cy: p.y, r: 40, lw: 1 });
    }
  };

  const onUp = (e) => {
    if (pan) setPan(null);
    if (marquee) {
      // compute world rect
      const w1 = screenToWorld(marquee.x1, marquee.y1);
      const w2 = screenToWorld(marquee.x2, marquee.y2);
      const rx1 = Math.min(w1.x, w2.x), rx2 = Math.max(w1.x, w2.x);
      const ry1 = Math.min(w1.y, w2.y), ry2 = Math.max(w1.y, w2.y);
      const hit = [];
      if (Math.hypot(marquee.x2-marquee.x1, marquee.y2-marquee.y1) > 3) {
        for (const ent of entities) {
          if (!layers[ent.layer]?.visible || layers[ent.layer]?.locked) continue;
          let inside = false;
          if (ent.type==='line') inside = ent.x1>=rx1&&ent.x1<=rx2&&ent.y1>=ry1&&ent.y1<=ry2 && ent.x2>=rx1&&ent.x2<=rx2&&ent.y2>=ry1&&ent.y2<=ry2;
          else if (ent.type==='rect') inside = Math.min(ent.x1,ent.x2)>=rx1 && Math.max(ent.x1,ent.x2)<=rx2 && Math.min(ent.y1,ent.y2)>=ry1 && Math.max(ent.y1,ent.y2)<=ry2;
          else if (ent.type==='circle') inside = ent.cx-ent.r>=rx1 && ent.cx+ent.r<=rx2 && ent.cy-ent.r>=ry1 && ent.cy+ent.r<=ry2;
          if (inside) hit.push(ent.id);
        }
        setSelection(hit);
      }
      setMarquee(null);
    }
  };

  const onWheel = (e) => {
    e.preventDefault();
    if (!svgRef.current) return;
    const delta = -e.deltaY * 0.001;
    const factor = Math.exp(delta);
    const world = screenToWorld(e.clientX, e.clientY);
    setView(v => {
      const newZoom = Math.max(0.005, Math.min(5, v.zoom * factor));
      const rect = svgRef.current.getBoundingClientRect();
      const sx = e.clientX - rect.left - rect.width/2;
      const sy = e.clientY - rect.top - rect.height/2;
      return { zoom: newZoom, cx: world.x - sx/newZoom, cy: world.y + sy/newZoom };
    });
  };

  const onKeyEsc = (e) => {
    if (e.key === 'Escape') { setDrawState(null); setTool('select'); }
  };
  useEffect(() => {
    window.addEventListener('keydown', onKeyEsc);
    return () => window.removeEventListener('keydown', onKeyEsc);
  }, []);

  // Preview
  let preview = null;
  if (drawState && drawState.to) {
    const a = worldToScreen(drawState.from.x, drawState.from.y);
    const b = worldToScreen(drawState.to.x, drawState.to.y);
    if (drawState.tool === 'line' || drawState.tool === 'ref_line') {
      preview = <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="preview"/>;
    } else if (drawState.tool === 'rect') {
      preview = <rect x={Math.min(a.x,b.x)} y={Math.min(a.y,b.y)} width={Math.abs(b.x-a.x)} height={Math.abs(b.y-a.y)} className="preview preview-fill"/>;
    } else if (drawState.tool === 'circle') {
      const r = Math.hypot(b.x-a.x, b.y-a.y);
      preview = <circle cx={a.x} cy={a.y} r={r} className="preview preview-fill"/>;
    }
  }

  // Snap marker
  let snapMarker = null, snapLabel = null;
  if (snap && tool !== 'select') {
    const s = worldToScreen(snap.x, snap.y);
    const shape = snap.type === 'end' ? <rect x={s.x-5} y={s.y-5} width={10} height={10} className="snap-marker"/>
      : snap.type === 'mid' ? <polygon points={`${s.x},${s.y-6} ${s.x+6},${s.y} ${s.x},${s.y+6} ${s.x-6},${s.y}`} className="snap-marker"/>
      : snap.type === 'center' ? <circle cx={s.x} cy={s.y} r={6} className="snap-marker"/>
      : snap.type === 'quad' ? <polygon points={`${s.x},${s.y-6} ${s.x+6},${s.y} ${s.x},${s.y+6} ${s.x-6},${s.y}`} className="snap-marker" opacity="0.7"/>
      : <circle cx={s.x} cy={s.y} r={3} className="snap-marker" fill="var(--guides)"/>;
    snapMarker = shape;
    const labels = { end: 'END', mid: 'MITTE', center: 'ZENTR', quad: 'QUAD', grid: 'RASTER' };
    snapLabel = <text x={s.x+10} y={s.y-8} className="snap-label">{labels[snap.type] || ''}</text>;
  }

  // Crosshair cursor when drawing
  let crosshair = null;
  if (tool !== 'select' && cursor.x > 0) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect) {
      const cx = cursor.x - rect.left, cy = cursor.y - rect.top;
      crosshair = (
        <>
          <line x1={0} y1={cy} x2={size.w} y2={cy} className="crosshair-cursor"/>
          <line x1={cx} y1={0} x2={cx} y2={size.h} className="crosshair-cursor"/>
        </>
      );
    }
  }

  return (
    <svg ref={svgRef}
      onMouseMove={onMove} onMouseDown={onDown} onMouseUp={onUp} onWheel={onWheel}
      onContextMenu={e=>e.preventDefault()}
      style={{cursor: pan?'grabbing':(tool==='select'?'default':'crosshair')}}>
      {gridOn && <g>{grid.lines}</g>}
      {gridOn && axes}
      {entityElements}
      {preview}
      {snapMarker}
      {snapLabel}
      {crosshair}
      {marquee && (() => {
        const x = Math.min(marquee.x1, marquee.x2) - (svgRef.current?.getBoundingClientRect().left||0);
        const y = Math.min(marquee.y1, marquee.y2) - (svgRef.current?.getBoundingClientRect().top||0);
        const w = Math.abs(marquee.x2-marquee.x1), h = Math.abs(marquee.y2-marquee.y1);
        const rightToLeft = marquee.x2 < marquee.x1;
        return <rect x={x} y={y} width={w} height={h}
          fill={rightToLeft?'color-mix(in oklab, var(--guides) 8%, transparent)':'color-mix(in oklab, var(--sel) 8%, transparent)'}
          stroke={rightToLeft?'var(--guides)':'var(--sel)'}
          strokeWidth="1" strokeDasharray={rightToLeft?'4 3':null} vectorEffect="non-scaling-stroke"/>;
      })()}
      {/* selection handles */}
      {selection.map(id => {
        const e = entities.find(en => en.id === id); if (!e) return null;
        const pts = [];
        if (e.type==='line') { pts.push([e.x1,e.y1]); pts.push([e.x2,e.y2]); }
        else if (e.type==='rect') { pts.push([e.x1,e.y1]); pts.push([e.x2,e.y1]); pts.push([e.x1,e.y2]); pts.push([e.x2,e.y2]); }
        else if (e.type==='circle') { pts.push([e.cx+e.r,e.cy]); pts.push([e.cx-e.r,e.cy]); pts.push([e.cx,e.cy+e.r]); pts.push([e.cx,e.cy-e.r]); pts.push([e.cx,e.cy]); }
        return pts.map(([x,y],i) => {
          const s = worldToScreen(x,y);
          return <rect key={id+':'+i} x={s.x-3} y={s.y-3} width={6} height={6} className="handle"/>;
        });
      })}
    </svg>
  );
}

window.Canvas = Canvas;
