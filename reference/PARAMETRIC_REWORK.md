# Parametric Modifier Rework — Design Doc

Handover for the next session. Goal: make the modifier tools (Fillet,
Trim, Chamfer, Offset, Extend) preserve parametric links instead of
overwriting source features with absolute-coord rewrites.

Status at time of writing: v0.2.10 landed the minimal fix only —
destructive `state.features.filter(...)` paths in trim and fillet were
routed through `deleteFeatures([fid])` so referenced sources become
hidden-but-ctx-resolvable instead of vanishing. The deeper rework
(new modifier feature types with live sources) is still open.

---

## 1. User-visible symptoms (what the user reported)

> "wenn ich mit dem Fillet tool zwei linien bzw. eine ecke abrunden
>  welche parametrische verknüpfungen haben, mache ich die
>  verknüpfung kabutt. Das stutzen tool funktioniert nicht bei
>  parametrisch verknüpften linien."

Translated: Fillet and Trim both break parametric links. Minimum viable
mental model the user asked for:

> "können wir das nicht so machen, dass alles was wir mit den
>  modifikatoren machen im parametrischen modus die linien einfach
>  'versteckt' und nicht wirklich löscht, sodass die variablen also
>  die zeichnung immernoch parametrisch bleibt?"

In short: **modifiers should hide sources, not delete or rewrite them.**

Concrete scenarios that still break after v0.2.10:

1. **Rect fillet.** Clicking a rect edge with the Fillet tool invokes
   `pickFilletLine` which explodes the rect into 4 lines (loses `width`,
   `height`, `signX`, `signY` exprs) and hands the closest line back.
   Even with the v0.2.10 patch (the rect is now hidden if referenced),
   the 4 new lines are plain abs coords — the rect's variable bindings
   are gone from the filleted geometry.
2. **Fillet between two already-bound lines.** The two source lines are
   replaced in place (preserving fid) via `replaceLineEndPreservingRef`
   for the kept end. The cut end becomes an absolute coordinate, so any
   downstream ref pointing at the *former* endpoint loses that binding.
   Re-filleting at a different radius cannot recover the intersection
   parametrically.
3. **Trim preservation is partial.** `handleTrimClick` uses
   `buildRayHitCutOverride` on the cut end — this builds a `rayHit`
   PointRef against the cutter feature, so the cut moves when the
   cutter moves. Good. But the trimmed-out segment is still lost — if
   the user later drags a cutter past the original endpoint, the trim
   doesn't "grow back", because the surviving piece is a geometric
   rewrite, not a clipping view.
4. **Chamfer.** Same destructive pattern as Fillet on two lines;
   produces a new abs-coord cut line and rewrites both sources.
5. **Offset, Extend, Stretch.** Also use `replaceFeatureFromInit` with
   all-abs values when they can't use the preserving path. Out of
   scope for the "minimal" user complaint but same architectural smell.

---

## 2. What already works in the timeline engine

The foundation for the rework is already in place — we don't need new
evaluator plumbing, just new feature kinds.

### 2.1 `Feature.hidden` flag — `src/types.ts:440-451`

```ts
type FeatureBase = {
  id: string;
  layer: number;
  hidden?: boolean;
};
```

### 2.2 `evaluateTimeline` respects it — `src/features.ts:1189-1202`

```ts
let e: Entity | null;
if (!isDirty && cachedEntity.has(f.id)) {
  e = cachedEntity.get(f.id)!;
} else {
  e = buildEntity(f, ctx);
  if (e) cachedEntity.set(f.id, e);
}
if (e) {
  // Hidden features still populate ctx — so lines snapped to a
  // deleted Hilfslinie keep resolving and stay parametric — but they
  // don't go into state.entities, so they're invisible and
  // unselectable on canvas.
  ctx.set(f.id, e);
  if (!f.hidden) out.push(e);
}
```

Same handling exists for modifier features (mirror/array/rotate/
crossMirror) — the cached outputs are computed but only pushed when
not hidden. Sub-entity ids are still reserved in `aliveSubKeys` so
downstream lookups don't break.

### 2.3 `deleteFeatures` is the template — `src/features.ts:1352-1407`

```ts
// Requested deletes that still have dependents become `hidden` (not
// rendered, not hit-tested, but still evaluated so they appear in
// `ctx` and dependents keep resolving — including live updates when
// the user changes variables). Requested deletes with no dependents
// are removed outright.
```

This is exactly the semantic the user wants. The rework is to make
modifier tools *always* go through this hide-or-delete pathway for
their sources, instead of rewriting them.

### 2.4 Modifier feature pattern exists — `src/types.ts:553-623`

`MirrorFeature`, `ArrayFeature`, `RotateFeature`, `CrossMirrorFeature`
all hold `sourceIds: string[]` and re-emit transformed sub-entities on
every eval. The evaluator handles caching (`cachedModifierOutputs`),
`aliveSubKeys` tracking, and respects `.hidden`. See
`evaluateTimeline` at `features.ts:1115-1188`.

**The rework is: add new modifier kinds for clip/fillet/chamfer that
follow the same pattern.**

---

## 3. Proposed architecture

Three new modifier features, added to the `Feature` union in
`types.ts:625-630`:

### 3.1 `ClipFeature` — replaces destructive trim

```ts
export type ClipFeature = FeatureBase & {
  kind: 'clip';
  /** The source feature being clipped. Hidden on commit; its entity
   *  still lives in ctx so downstream refs resolve. */
  sourceId: string;
  /** Intervals along the source that REMAIN visible. For lines:
   *  t ∈ [0,1] along p1→p2. For arcs: angle fraction along the CCW
   *  sweep. A single `[0, tLow]` entry plus `[tHigh, 1]` models the
   *  two-cut case; `[0, tLow]` alone is a single-cut survivor.
   *  Empty array = everything clipped (feature effectively hidden). */
  segments: Array<{ tStart: Expr; tEnd: Expr }>;
  /** When a segment boundary came from a cutter, record which cutter
   *  it was so the clip is parametric: if the cutter moves, the clip
   *  endpoint follows. `null` means "hard endpoint" (t=0 or t=1 of
   *  the source, no cutter involvement). */
  cutters: Array<{ startCutter: string | null; endCutter: string | null }>;
};
```

Evaluator: look up `ctx.get(sourceId)`, walk each segment, emit one
child entity per segment (line pieces or arc pieces). Use the
cutter's current entity to recompute `t` if `cutter != null` — this
is what makes the trim re-flow when the cutter moves.

On commit:
```ts
// 1. Mark source hidden (or delete if orphan via deleteFeatures)
// 2. Push ClipFeature with computed segments + cutter refs
```

### 3.2 `FilletFeature` — replaces destructive fillet

```ts
export type FilletFeature = FeatureBase & {
  kind: 'fillet';
  line1Id: string;
  line2Id: string;
  /** Which end of each source line meets the corner (the "cut" end —
   *  opposite end is the "kept" end, which stays visible on the
   *  source). Stored as 1|2 to match LineEntity.p1/p2 convention. */
  cut1End: 1 | 2;
  cut2End: 1 | 2;
  radius: Expr;
};
```

Evaluator emits three child entities:
  - Trimmed copy of `line1` from its kept end to the tangent point.
  - Trimmed copy of `line2` from its kept end to the tangent point.
  - The fillet arc tangent to both.

Both source lines are hidden on commit. The emitted trimmed copies
"replace them visually" but stay parametric — edit the variable, the
lines regrow and the fillet recomputes on the next eval.

Sub-entity subkey convention (to slot into the existing `subEntityIds`
map): `${filletFid}#${line1Id}@t1`, `#${line2Id}@t2`, `#arc`.

Selection needs a hit-test that maps clicks on these sub-entities
back to the fillet feature (so "select corner" feels natural). The
existing `entityToModifier` map is where these mappings live — see
`features.ts:1222-1228`.

### 3.3 `ChamferFeature` — mirrors FilletFeature

Identical shape to `FilletFeature` but:
```ts
kind: 'chamfer';
distance: Expr;   // instead of `radius`
```
Emits `line1 trimmed + line2 trimmed + cut line between tangent points`.

---

## 4. Phased implementation plan

**Ordering matters.** Each phase leaves the app shippable.

### Phase 1 — `parametricMode` policy consolidation (prep, 1 day)

Right now `runtime.parametricMode` is checked at 15+ call sites
(see grep on `runtime.parametricMode`) with slightly different
semantics at each one. Before adding new modifier features that also
need to branch on it, factor this into a single helper:

```ts
// src/parametric-mode.ts
export function parametricCommitPolicy(): 'link' | 'freeze' { ... }
```

Every call site that currently does `runtime.parametricMode ? X : Y`
should route through this. Mechanical but makes the rest safer.

Files touched: `src/tools.ts` (15 sites), `src/main.ts`,
`src/render.ts`, `src/parametric-mode.ts`.

### Phase 2 — Test harness (1 day)

No unit-test framework in the repo yet. Pragmatic option: add one
smoke-test file `src/__tests__/modifier-parametric.test.ts` driven by
a tiny test runner (can be `vite test` or `node --test`). Cases:
  - Draw two lines snapped at a corner → fillet → change a shared
    variable → both lines + arc should still relate correctly.
  - Draw rect with variable `w` → fillet a corner → change `w` →
    rect grows, filleted corner follows.
  - Trim line against cutter → move cutter → trim-end follows.
  - Delete cutter → clip segment should collapse gracefully (likely
    to `[0,1]` i.e. restored).

**This phase is optional but strongly recommended** — without it, each
commit of the subsequent phases is a regression roulette.

### Phase 3 — ClipFeature (replace trim, 2–3 days)

- Add `ClipFeature` to `Feature` union in `types.ts`.
- Add `buildClipEntities(f, ctx)` to `features.ts` (mirror the shape
  of `buildMirrorEntities`). Handle line, arc, circle, polyline
  sources. Emit sub-entities with stable ids via `subEntityIds`.
- Update evaluator loop at `features.ts:1115` to dispatch `kind: 'clip'`.
- Rewrite `handleTrimClick` (tools.ts:7541), `handleTrimCircleClick`
  (7782), `handleTrimArcClick` (7851): instead of rewriting source
  pieces, compute segment list + cutter refs and push a ClipFeature.
- Editing: clicking a clip sub-entity should either (a) select the
  parent ClipFeature (simplest) or (b) allow further trim on top
  (later). (a) is enough for v1.
- Undo: pushUndo before, ClipFeature creation is a single op.

### Phase 4 — FilletFeature (replace fillet, 2–3 days)

- Add `FilletFeature` to union, `buildFilletEntities` in features.ts.
- Rewrite `handleFilletClick`/`applyFillet` (tools.ts:6574/6607): on
  commit, mark both source lines hidden, push a FilletFeature.
- **Rect handling:** replace the destructive `pickFilletLine`
  rect-explode (tools.ts:6489-6521) with an on-the-fly wrapper that
  creates a clipping view of the clicked rect edge instead. Concrete
  approach: when the user clicks a rect edge, emit a synthetic
  "virtual line" from rect corners (computed from rect exprs) and
  bind the fillet to that virtual ref. *This is the hard bit* — rects
  don't currently expose per-edge refs. May need an `edgeRef` type
  in `PointRef` or a new `RectEdgeFeature` adapter. Leave rects out
  of scope for Phase 4 if time-boxing — rect fillet remains a 2-step
  user action (explode → fillet) with a toast explaining why.
- Re-fillet (tools.ts:6618-6629): replace the find/remove-arc logic
  with a simple "if source lines already participate in a
  FilletFeature, update its radius in place".

### Phase 5 — ChamferFeature (parallel to Phase 4, 1 day)

Once FilletFeature is in, chamfer is mostly a copy. Clone the
implementation with `distance` exprs and a cut-line instead of arc.

### Phase 6 — Migration / compat (1 day)

Existing `.hcad` files on disk have the old representations (abs
rewrites). They keep working — no migration needed, because the old
shape is just less parametric. New drawings start using the new
features automatically.

Verify the file loader (`src/io.ts`) doesn't reject unknown feature
kinds. Add the three new kinds to any switch-default warnings.

### Phase 7 — Offset / Extend cleanup (1–2 days, optional)

Same pattern as trim: offset currently calls `replaceFeatureFromInit`
with all-abs values in its non-preserving branch. Convert to an
`OffsetFeature` that holds source + distance expr. Lower-priority
since these tools don't break parametric links as aggressively as
fillet/trim.

### Phase 8 — Polish (1 day)

- Selection UX: clicking a fillet arc should highlight the whole
  corner (arc + two trimmed line pieces).
- Property-panel editing: radius/distance editable inline.
- Delete behavior: deleting a FilletFeature should unhide the two
  source lines (inverse of commit). Route through a `revertModifier`
  helper.
- Stats bar: count FilletFeature once, not 3× for its sub-entities.

---

## 5. Concrete anchor locations (as of v0.2.10)

| File                       | Lines         | What lives there                          |
|----------------------------|---------------|-------------------------------------------|
| `src/types.ts`             | 440-451       | `FeatureBase.hidden`                      |
| `src/types.ts`             | 553-623       | Existing modifier features (template)     |
| `src/types.ts`             | 625-630       | `Feature` union — add new kinds here      |
| `src/features.ts`          | 1104-1228     | `evaluateTimeline` — dispatch loop        |
| `src/features.ts`          | 1115-1188     | Modifier branches — add clip/fillet/chamfer |
| `src/features.ts`          | 1352-1407     | `deleteFeatures` — reuse for commit       |
| `src/tools.ts`              | 6415-6671     | Fillet: compute + pick + handle + apply   |
| `src/tools.ts`              | 6489-6521     | `pickFilletLine` — rect explosion (rewrite) |
| `src/tools.ts`              | 6688-6797     | Chamfer                                   |
| `src/tools.ts`              | 7541-7639     | `handleTrimClick` (line)                  |
| `src/tools.ts`              | 7782-7826     | `handleTrimCircleClick`                   |
| `src/tools.ts`              | 7851-7915     | `handleTrimArcClick`                      |
| `src/parametric-mode.ts`   | whole file    | Auto-enable / persistence hook            |

`runtime.parametricMode` call sites (15): grep for it in src/.

---

## 6. Risks / open questions

1. **Selection semantics for sub-entities.** Today selecting a mirror
   copy selects that sub-entity id. Fillet sub-entities (the two
   trimmed lines + arc) conceptually belong together. Do we:
   (a) select-all-three when any is clicked, or
   (b) allow independent selection per sub-entity?
   Recommend (a) — matches user's "it's one corner" mental model.

2. **What happens when one source line of a FilletFeature is
   deleted?** Options:
   - Auto-dissolve the fillet (emit nothing, orphan the other line
     by unhiding it).
   - Hide the fillet too (user sees nothing where the corner was).
   Recommend auto-dissolve with the sister line un-hidden.

3. **Nested modifiers.** Can you fillet two lines that are already
   part of a Mirror modifier? The mirror emits sub-entities, not
   features — you can't target them as `sourceId`. Either (a) block
   it in the tool ("mirror copies can't be filleted directly"), or
   (b) fillet the pre-mirror sources and let the mirror re-emit. (b)
   is more powerful but requires the fillet to target feature ids,
   not sub-entity ids. Easier path: stick with (a) for v1.

4. **Rect-edge refs.** As noted in Phase 4, the cleanest rect-fillet
   solution needs a `PointRef` that names a rect edge parametrically.
   Consider adding:
   ```ts
   type RectEdgeRef = { kind: 'rectEdge'; featureId: string; edge: 0|1|2|3; t: Expr }
   ```
   Aligns with how `FeatureEdgeRef` already works for snap-tracking.

5. **Perf.** ClipFeature evaluation is a tight loop over segments.
   Shouldn't be a hotspot (drawings rarely have 1000+ clips) but
   worth benching after Phase 3.

---

## 7. Minimal v0.2.10 changes already landed

These belong in the baseline when you pick this up:

- `pickFilletLine` (tools.ts:~6498) — rect explosion routed through
  `deleteFeatures([rectFid])` instead of `state.features.filter`. If
  the rect has dependents it becomes hidden; its ctx entry keeps
  downstream refs alive.
- `applyFillet` existing-arc removal (tools.ts:~6641) — same.
- `handleTrimClick` fully-consumed case (tools.ts:~7588) — same.
- `handleTrimArcClick` fully-consumed case (tools.ts:~7902) — same.

These are compatible with (and not replaced by) the rework — they
remain the correct behavior for the orphan case even after
ClipFeature/FilletFeature land.

---

## 8. Rough effort estimate

- Minimal (Phase 3 + 4 only, no tests, skip rect-fillet): **~1 week**
- Recommended (Phase 1 → 6): **~2 weeks**
- Full (all phases incl. offset/extend/polish): **~2.5–3 weeks**

---

## 9. Related tickets / user messages

- v0.2.10 release notes (this batch of 7 fixes, 6th = this rework).
- Agent research run ID: `a68ddc791264d07f4` (one-shot; results are
  consolidated into this doc, no need to re-run).
