---
version: anydesign-1
name: Transcriber — Reels Insight Extractor (frontend)
source: frontend/src/index.css + frontend/src/App.jsx + frontend/src/App.css (running at http://localhost:5173)
captured_at: 2026-06-06
description: |
  A restrained dark dashboard for an AI tool that turns Instagram Reels into structured
  insights. Near-black blue-tinted canvas, flat solid surfaces with crisp hairline borders
  and a faint top-edge highlight, and a single desaturated violet accent used only where it
  means something (primary actions, active/focus states). Exactly ONE gradient survives — the
  violet→pink logo wordmark. No motion, no glow. Typeface is Plus Jakarta Sans (300–800).
  The voice is calm and deliberate, in the Linear/Vercel line — intention over decoration.

colors:
  bg-dark: "#0E0E13"        # hsl(240 20% 6%) — app canvas
  bg-card: "#13131B"        # hsl(240 21% 9%) — flat surface fill (cards, panels, table)
  bg-input: "#14141E99"     # rgba(20,20,30,0.6)
  primary: "#8B66E1"        # hsl(258 67% 64%) — desaturated violet accent
  secondary: "#DA62AE"      # hsl(322 62% 62%) — pink, used ONLY in the logo gradient
  success: "#21C45D"        # hsl(142 71% 45%)
  warning: "#F59E0B"        # hsl(38 92% 50%)
  text-primary: "#FAFAFA"   # hsl(0 0% 98%)
  text-secondary: "#BCBCC2" # hsl(240 5% 75%)
  text-muted: "#78788A"     # hsl(240 5% 50%)
  border: "#FFFFFF1A"       # rgba(255,255,255,0.1) — hairline
  border-hover: "#7C63DE59" # rgba(124,99,222,0.35)

typography:
  display:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: 36px
    fontWeight: 800
    letterSpacing: -0.5px
  modal-title:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: 28px
    fontWeight: 800
    lineHeight: 1.35
  section-title:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: 22px
    fontWeight: 700
  card-title:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.4
  body:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  label-eyebrow:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: 17px
    fontWeight: 700
    letterSpacing: 0.5px
    textTransform: uppercase
  caption:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: 12px
    fontWeight: 500

spacing:
  base: 4px
  scale: [4, 8, 12, 16, 24, 28, 32, 40, 48, 56]

rounded:
  sm: 8px
  md: 12px
  lg: 16px
  pill: 20px
  full: 9999px

components:
  glass-card:
    backgroundColor: "{colors.bg-card}"
    border: "1px solid {colors.border}"
    highlight: "inset 0 1px 0 rgba(255,255,255,0.03)"
    rounded: "{rounded.lg}"
    padding: 28px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: 12px 28px
  input-group:
    backgroundColor: "{colors.bg-input}"
    border: "1px solid {colors.border}"
    focusRing: "0 0 0 2px rgba(124,99,222,0.25)"
    rounded: "{rounded.md}"
    padding: 8px
  topic-badge:
    backgroundColor: "rgba(255,255,255,0.06)"
    textColor: "{colors.text-secondary}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.pill}"
    padding: 4px 10px
  search-bar:
    backgroundColor: "{colors.bg-card}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.sm}"
    padding: 10px 16px
---

# Design Analysis — Transcriber (Reels Insight Extractor)

> Analysis generated with the `anydesign` skill.
> Date: 2026-06-06 (refreshed after the "restraint pass")
> Analysis emphasis: design system + reconstruction

---

## Source

- **Source type**: combination — codebase + running URL
- **Path / URL**: `frontend/src/index.css` (token source), `frontend/src/App.jsx` (structure), `frontend/src/App.css` (controls/table), live at `http://localhost:5173`
- **Capture method**: direct source reading of CSS custom properties — highest fidelity.
- **Detected limitations**: HSL→hex conversions are approximate (the HSL/rgba originals in `index.css` are authoritative).

---

## TL;DR

A calm, restrained dark dashboard: near-black blue canvas, flat solid cards with crisp hairlines and a faint top highlight, and **one** desaturated violet accent (`{colors.primary}` #8B66E1) reserved for primary actions and focus/active states. The only gradient in the entire system is the violet→pink logo wordmark; there is no motion and no glow. This is a deliberate post-"AI-slop" cleanup — depth now comes from typography, spacing, and hairlines rather than gradients and animation.

---

## 1. Visual identity

### 1.1 Surface description

**Personality**: calm, deliberate, precise, focused, engineered.

**Mood**: a quiet dark "instrument" — confident without shouting; the single accent does the talking.

**Detectable stylistic references**: Linear / Vercel restraint; flat-first dark UI with selective depth.

**Information density**: balanced — generous padding (28–40px), bento auto-fill card grid, intentional whitespace, hairline section dividers.

**Implicit positioning**: a single power-user / maker who saves educational Reels. Personal-tool craft, not enterprise.

**Confidence**: ✅ high (read from source).

### 1.2 Brand voice / Atmosphere

This design believes its user is a focused maker who reads software by its restraint. After an earlier glow-and-gradient phase, the system was deliberately pulled back to a flat-first dark surface: solid cards, hairline borders, a single faint inset top-highlight for craft, and exactly one accent color. The conviction is that *intention reads as quality* — a violet that appears only on the primary button, the active toggle, and focus rings feels considered, where a violet on every surface read as generated.

Motion was removed for the same reason: the animated mesh and pulsing logo were atmosphere for atmosphere's sake. The product now lets hierarchy come from type weight (Plus Jakarta 800 vs 400) and spacing. The one indulgence kept — the violet→pink gradient on the logo wordmark — survives precisely *because* it is the only one; it carries the brand alone.

### 1.3 The "ONE brand thing"

- **The thing**: the **violet→pink gradient on the logo wordmark** (`linear-gradient(135deg, #8B66E1, #DA62AE)` clipped to text). It is now the single gradient in the whole product.
- **Why it carries the brand**: it is the only saturated, only gradient, only "expressive" gesture. Remove it and the UI is a tasteful but anonymous dark dashboard.
- **How everything else supports it**: every other surface is flat neutral; the accent elsewhere is a flat, desaturated single violet. Nothing competes.
- **Where it appears (and where it doesn't)**: logo wordmark only. It deliberately does NOT appear on buttons, badges, banners, or backgrounds anymore.

*Confidence*: ✅ high.

---

## 2. Design System (tokens)

### 2.1 Colors

| Token | Value (authoritative) | Hex approx | Role | Where | Confidence |
|---|---|---|---|---|---|
| `bg-dark` | `hsl(240 20% 6%)` | `#0E0E13` | App canvas | `body` | ✅ |
| `bg-card` | `hsl(240 21% 9%)` | `#13131B` | Flat surface fill | cards, panels, table, search | ✅ |
| `bg-input` | `rgba(20,20,30,0.6)` | `#14141E99` | Input fields, selects | url-input, controls | ✅ |
| `primary` | `hsl(258 67% 64%)` | `#8B66E1` | Accent — CTA, active, focus | buttons, toggle, rings | ✅ |
| `secondary` | `hsl(322 62% 62%)` | `#DA62AE` | Logo gradient end ONLY | `.logo-text` | ✅ |
| `success` | `hsl(142 71% 45%)` | `#21C45D` | Completed steps | step.completed | ✅ |
| `warning` | `hsl(38 92% 50%)` | `#F59E0B` | Wake-up alert | `.wake-alert` | ✅ |
| `text-primary` | `hsl(0 0% 98%)` | `#FAFAFA` | Main text | headings, body | ✅ |
| `text-secondary` | `hsl(240 5% 75%)` | `#BCBCC2` | Secondary text | takeaways, chips | ✅ |
| `text-muted` | `hsl(240 5% 50%)` | `#78788A` | Tertiary text | dates, captions, th | ✅ |
| `border` | `rgba(255,255,255,0.1)` | `#FFFFFF1A` | Hairline | borders, dividers | ✅ |
| `border-hover` | `rgba(124,99,222,0.35)` | `#7C63DE59` | Hover border | interactive surfaces | ✅ |

The system is now a **single-accent** palette: text + neutrals + one violet + feedback semantics (success/warning). Pink exists only inside the logo gradient.

### 2.2 Typography

- **Family**: `Plus Jakarta Sans` (Google Fonts, 300–800) — ✅ high (explicit `@import`).
- **Fallback**: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`.

| Token | Size | Weight | Line-height | Use |
|---|---|---|---|---|
| `display` | 36px | 800 | — | Logo wordmark (only gradient text) |
| `modal-title` | 28px | 800 | 1.35 | Modal heading |
| `section-title` | ~22px | 700 | — | Dashboard / "Saved Insights" |
| `card-title` | ~18px | 700 | 1.4 | Card titles (2-line clamp) |
| `body` | 16px | 400–500 | 1.5 | Body, inputs |
| `label-eyebrow` | ~17px | 700 | — | Modal section titles (UPPERCASE, +0.5px) |
| `caption` | 12px | 500 | — | Dates, step + table-header labels |

Hierarchy is now carried by weight/size contrast, not color. Uppercase is reserved for the modal eyebrow labels only.

### 2.3 Spacing

- **Base**: 4px, expressed in `rem`. Steps: 8/12/16/24/28/32/40px. **Consistency**: ✅ high.

### 2.4 Radii

- `sm` 8px (buttons, inputs, tags, search), `md` 12px (input group, upload, progress), `lg` 16px (cards, modal), `pill` 20px (badges), `full` 9999px (step nodes).

### 2.5 Elevation system

Flat-first. Depth = hairline + a 1px inset top highlight; real blur is reserved for the modal.

| Level | Name | Treatment | Use |
|---|---|---|---|
| 0 | Flat | no chrome | body canvas |
| 1 | Crafted surface | `bg-card` + `1px {colors.border}` + `inset 0 1px 0 rgba(255,255,255,0.03)` | default cards/panels |
| 2 | Hover | violet hairline + `inset highlight, 0 6px 22px rgba(0,0,0,0.35)` | `.glass-interactive:hover` |
| 3 | Focus | crisp `0 0 0 2px rgba(124,99,222,0.25)` ring + violet border | inputs, selects |
| 4 | Modal | `0 20px 50px rgba(0,0,0,0.6)` over a `blur(12px)` **overlay** | dialogs |

#### Decorative depth (non-functional)

- **Single static wash**: one fixed low-opacity radial `rgba(124,99,222,0.06)` top-left on `body::before`. No animation. (The previous 3-gradient pulsing mesh + logo-glow animation were removed.)

### 2.6 Borders

- Hairline: `rgba(255,255,255,0.1)` 1px, used for card borders and the dashboard header divider.
- Hover: violet `rgba(124,99,222,0.35)`.
- Focus: crisp 2px violet ring (`rgba(124,99,222,0.25)`) — not a blurred glow.

### 2.7 Accessibility quick-check

See companion `design-a11y.md`. `text-primary` on canvas ≈ 18:1 (AAA ✅). Watch `text-muted` (#78788A) on `bg-card` for small text (borderline AA). The desaturated violet on dark improves slightly over the old neon.

---

## 3. Components Inventory

### 3.1 Generic components

#### button-primary
- **Variants**: primary (**solid** `{colors.primary}`), ghost/alt (`.alt-input-btn`, transparent violet text).
- **States**: default, hover (darken to `hsl(258 67% 58%)` + `translateY(-1px)`, no glow), disabled (opacity 0.6).
- **Padding**: 12px 28px. **Radius**: `{rounded.sm}`. **Confidence**: ✅.

#### input-group
- Frosted-free dark group with left icon; `:focus-within` → violet border + crisp 2px ring. ✅

#### search-bar
- Flat `bg-card` pill, icon + transparent input, max-width 400px. ✅

#### glass-card (`.reel-card` on `.glass`)
- Flat `bg-card` + hairline + inset top highlight; neutral topic badge + date, 2-line title, 3-line takeaway, footer with task count + "View details". Hover = violet hairline + soft shadow. ✅

#### topic-badge
- Neutral light chip (`rgba(255,255,255,0.06)`, `text-secondary`) for topic/cluster; `tool-tag`/`tool-chip` are the same neutral family. Color is no longer used decoratively. ✅

### 3.2 Signature components

#### Pipeline step-tracker
- 6-node horizontal progress (Server→Fetch→Audio→Transcribe→Llama→Save); active = violet border/fill (no glow), completed = green. Turns a single API call into a watchable process. ✅

#### Gradient-text logo
- Wordmark in clipped violet→pink gradient — the lone gradient and the brand's one expressive gesture. ✅

*(The animated aurora mesh was removed in the restraint pass and is no longer a signature element.)*

---

## 4. Layout & Composition

### 4.1 Grid & containers
- `.app-container` max-width 1200px, padding 2.5rem 1.5rem, centered.
- Card grid: `repeat(auto-fill, minmax(340px, 1fr))`, 1.75rem gap.
- Dashboard header separated from results by a hairline divider.

### 4.2 Composition patterns
- Centered hero (logo + subtitle) → ingestion panel → dashboard (search + controls + cards/table toggle) → modal overlay.

### 4.3 Responsive behavior

| Name | Width | Key changes |
|---|---|---|
| Mobile | < 640px | `.dashboard-controls` stack |
| Tablet | < 768px | step-tracker → 1 column |
| Desktop | ≥ 768px | full 6-up steps, multi-col grid |

Card grid is intrinsically responsive (`auto-fill minmax(340px,…)`). Controls wrap via flex.

#### Touch targets
- CTAs/inputs ~44–48px ✅. ⚠️ view-toggle (~32px) and selects are a touch small — candidate for a future bump.

### 4.4 Image behavior
- Effectively imageless; icon-driven via **lucide-react** (stroke icons; `Clapperboard` replaces the removed `Instagram` glyph).

---

## 5. Reconstruction Notes

### Suggested stack
Vanilla CSS with custom properties (current). The token layer in `index.css` is the system; components consume it.

### Quick wins
- The restraint pass is implemented: single gradient, flat surfaces, neutral chips, crisp rings, no motion.

### Tricky bits
- Keep the modal overlay as the *only* `backdrop-filter` — don't reintroduce blur on cards.
- Native `<select>` is themed via custom chevron + `option` background; verify across browsers.

### Implicit states to define
- Active-filter chip state, empty-cluster state ("Run Recompute"), recompute error toast (currently `setError` only), table filtered-to-zero state.

### Confidence map

| Layer | Confidence | Why |
|---|---|---|
| Identity | ✅ high | Read from source |
| Colors | ✅ high | CSS vars authoritative |
| Typography | ✅ high | Explicit import + sizes |
| Spacing | ✅ high | Read from source |
| Components | ✅ high | Full CSS available |
| Layout | ✅ high | Containers/grids explicit |

---

## 6. Do's and Don'ts

### Do
- **Keep the gradient on the logo wordmark only.** It is the one expressive gesture; everything else is flat.
- **Use the solid violet `{colors.primary}` (#8B66E1) for primary actions, active, and focus** — nowhere decorative.
- **Build surfaces from `.glass`** (now flat `bg-card` + hairline + inset top highlight); reuse it for cards, panels, tables.
- **Reserve `backdrop-filter` blur for the modal overlay** — the single depth moment.
- **Use neutral chips** (`rgba(255,255,255,0.06)`) for topics/clusters/tools; reserve color for status (success/warning).
- **Show focus as a crisp 2px violet ring** (`rgba(124,99,222,0.25)`), never a blurred glow.
- **Drive hierarchy with type weight and spacing** (800 vs 400) plus hairline dividers.

### Don't
- **Don't add a second gradient** anywhere outside the logo — buttons, badges, banners stay solid.
- **Don't reintroduce ambient motion** (pulsing meshes, glowing logos) — it reads as AI-generated.
- **Don't use glow/drop-shadow as decoration** — depth is hairline + inset highlight + one soft modal shadow.
- **Don't color chips by vibe** — violet/decorative pills are out; color must carry meaning.
- **Don't apply `backdrop-filter` to cards or the table** — only the modal overlay.
- **Don't introduce a third accent** — the system is text + neutral + one violet + feedback semantics.

---

## 7. Open Questions

- Light mode is loosely on your mind — do you want a real `prefers-color-scheme` / toggle, or stay dark-only? (Tokens are centralized in `index.css`, so a light theme is feasible later.)
- Bump small touch targets (view-toggle, selects) to ≥40px height?
- Recompute errors only set `setError` — add a visible inline banner/toast?
- Should the neutral topic/cluster chips ever encode anything (e.g., color per cluster), or stay strictly neutral?

---

## 8. Companion files

- [x] `design-tokens.json` — DTCG tokens for the restrained system
- [x] `design-a11y.md` — WCAG contrast for key pairs
- [ ] `design-screenshot.png` — not generated (analysis from authoritative source)

---

*Next logical step: if you want a light mode, this token layer is ready for it — say the word and I'll add a `prefers-color-scheme` variant.*
