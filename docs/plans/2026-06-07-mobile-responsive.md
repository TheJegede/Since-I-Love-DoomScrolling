# Mobile Responsive Pass — Implementation Plan

**Date:** 2026-06-07
**Scope:** Polished mobile UX, fully fluid (no device hardcoding). CSS-only except one JSX wrapper div for the table.
**Files touched:** `frontend/src/index.css`, `frontend/src/App.css`, `frontend/src/App.jsx` (1 wrapper).
**Decisions (from user):** Table → horizontal scroll. Scope → polished. Targets → fully adaptive (clamp/min), breakpoints only as guardrails.

**Strategy:** `clamp()` / `min()` do the heavy lifting so layout flexes across *all* widths. Two guardrail breakpoints — `640px` (stack controls) and `420px` (stack input + tighten) — only for layout *shifts* that fluid sizing can't express. One `@media (pointer: coarse)` block for touch targets.

---

## Change 1 — Table horizontal scroll

**Why:** 6-col `insights-table` has no scroll container; `body{overflow-x:hidden}` clips it → squashed/cut columns on phones.

### 1a. JSX wrapper — `App.jsx:741`
```jsx
// before
) : viewMode === 'table' ? (
  <table className="insights-table glass">
    ...
  </table>
) : (

// after
) : viewMode === 'table' ? (
  <div className="table-scroll">
    <table className="insights-table glass">
      ...
    </table>
  </div>
) : (
```

### 1b. CSS — `App.css`, add near `.insights-table`
```css
.table-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;       /* momentum scroll on iOS */
  border-radius: var(--radius-lg);
  /* edge fade hint that there's more to the right */
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent);
          mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent);
}
/* drop the fade once everything fits (wide screens) */
@media (min-width: 760px) {
  .table-scroll { -webkit-mask-image: none; mask-image: none; }
}
.insights-table {
  min-width: 640px;   /* keep columns readable; wrapper scrolls instead of squashing */
}
```
*Note:* `min-width: 640px` is the only fixed px — it's the readable floor for 6 columns, not a device target. The wrapper scrolls below that.

---

## Change 2 — Card grid fluid — `index.css:403`

**Why:** `minmax(340px, 1fr)` overflows on ≤~372px screens.
```css
/* before */
grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
/* after */
grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
```
`min(100%, 320px)` → card shrinks to full container width on narrow screens, never overflows.

---

## Change 3 — Fluid container + spacing

| Selector | Property | Before | After |
|---|---|---|---|
| `.app-container` (`index.css:89`) | padding | `2.5rem 1.5rem` | `clamp(1.5rem, 5vw, 2.5rem) clamp(1rem, 4vw, 1.5rem)` |
| `.app-header` (`index.css:100`) | margin-bottom | `3.5rem` | `clamp(2rem, 6vw, 3.5rem)` |
| `.ingestion-panel` (`index.css:132`) | padding | `2.5rem` | `clamp(1.25rem, 4vw, 2.5rem)` |
| `.modal-overlay` (`index.css:507`) | padding | `1.5rem` | `clamp(0.75rem, 3vw, 1.5rem)` |
| `.modal-content` (`index.css:523`) | padding | `2.25rem` | `clamp(1.25rem, 4vw, 2.25rem)` |

---

## Change 4 — Fluid typography

| Selector | Before | After |
|---|---|---|
| `.logo-text` (`index.css:115`) | `2.25rem` | `clamp(1.6rem, 7vw, 2.25rem)` |
| `.app-subtitle` (`index.css:124`) | `1.05rem` | `clamp(0.95rem, 3.5vw, 1.05rem)` |
| `.dashboard-title` (`index.css:392`) | `1.35rem` | `clamp(1.1rem, 4vw, 1.35rem)` |
| `.modal-title` (`index.css:559`) | `1.75rem` | `clamp(1.3rem, 5vw, 1.75rem)` |

---

## Change 5 — Controls + sticky filter bar

**Why:** `recompute-btn{margin-left:auto}` jumps when row wraps; filters scroll out of reach on long lists.

### 5a. Sticky — `App.css`, `.controls-bar` (`App.css:4`)
```css
.controls-bar {
  position: sticky;
  top: 0;
  z-index: 20;
  background: var(--bg-dark);
  padding-top: 0.75rem;
  padding-bottom: 0.75rem;
}
```
*Caveat:* sticks at viewport top; cards scroll under it. `bg-dark` (opaque) prevents bleed-through. View-toggle + filters + recompute stay reachable while scrolling the grid/table.

### 5b. Stack on small — `App.css`, new block
```css
@media (max-width: 640px) {
  .controls-bar { gap: 0.6rem; }
  .controls-bar select,
  .recompute-btn,
  .view-toggle { width: 100%; }
  .view-toggle button { flex: 1; }      /* Cards|Table split evenly full-width */
  .recompute-btn { margin-left: 0; justify-content: center; }
}
```

---

## Change 6 — Touch targets ≥44px (polished)

`App.css` / `index.css`, new block:
```css
@media (pointer: coarse) {
  .view-toggle button,
  .controls-bar select,
  .btn-primary,
  .recompute-btn { min-height: 44px; }
  .alt-input-btn { min-height: 40px; }
  .delete-btn { padding: 0.5rem; }       /* bigger hit area */
}
```

---

## Change 7 — Input group stacks on small — `index.css:137`

**Why:** url input + "Extract" button on one row → button text crushes input on narrow screens.
```css
@media (max-width: 420px) {
  .input-group { flex-direction: column; align-items: stretch; }
  .input-icon { display: none; }          /* reclaim width */
  .btn-primary { justify-content: center; }
}
```

---

## Verification

1. `cd frontend && npm run lint` — clean.
2. `npm run build` — compiles.
3. Browser responsive mode, sweep widths (fluid, so range not device): **360 / 390 / 768 / 1200px**. Check: no horizontal page scroll; table scrolls internally; cards full-width on phone; sticky filter bar holds; tap targets comfortable; modal padding sane.

## Risk
Low. Additive CSS + one wrapper `<div>`. No JS logic, no API, no data-layer touched. Reversible per-change.

## Out of scope (flag for later)
- Search bar (`dashboard-controls`) not made sticky — only `controls-bar`. Can add if wanted.
- No hamburger/nav restructure (app has no nav).
- Landscape-phone tuning beyond fluid defaults.
