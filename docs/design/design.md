---
version: anydesign-1
name: Transcriber — Reels Insight Extractor (frontend)
source: frontend/src/index.css + frontend/src/App.jsx + frontend/src/App.css (running at http://localhost:5173)
captured_at: 2026-06-06
description: |
  A dark "aurora glassmorphism" dashboard for an AI tool that turns Instagram Reels into
  structured insights. Near-black blue-tinted canvas with a slow-pulsing violet/pink radial
  mesh, frosted translucent cards (backdrop-blur), and a single violet→pink gradient that
  carries every accent — logo wordmark, CTAs, glowing icons, badges. Typeface is Plus Jakarta
  Sans across 300–800. The look is premium-indie-AI: confident, glowy, motion-aware.

colors:
  bg-dark: "#0E0E13"        # hsl(240 20% 6%) — app canvas
  bg-card: "#13131B"        # hsl(240 21% 9%)
  bg-input: "#14141E99"     # rgba(20,20,30,0.6)
  surface-glass: "#12121CB3" # rgba(18,18,28,0.7) — frosted card fill
  primary: "#8B5CF6"        # hsl(263 85% 63%) — violet accent
  secondary: "#EC4899"      # hsl(325 83% 58%) — pink accent
  success: "#21C45D"        # hsl(142 71% 45%)
  warning: "#F59E0B"        # hsl(38 92% 50%)
  text-primary: "#FAFAFA"   # hsl(0 0% 98%)
  text-secondary: "#BCBCC2" # hsl(240 5% 75%)
  text-muted: "#78788A"     # hsl(240 5% 50%)
  border: "#FFFFFF14"       # rgba(255,255,255,0.08) — glass hairline
  border-hover: "#8B5CF64D" # rgba(139,92,246,0.3)

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
    fontSize: 21.6px
    fontWeight: 700
  card-title:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: 18.4px
    fontWeight: 700
    lineHeight: 1.4
  body:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  label-eyebrow:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: 16.8px
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
    backgroundColor: "{colors.surface-glass}"
    border: "1px solid {colors.border}"
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
    rounded: "{rounded.md}"
    padding: 8px
  topic-badge:
    backgroundColor: "#8B5CF61A"
    textColor: "{colors.primary}"
    border: "1px solid #8B5CF633"
    rounded: "{rounded.pill}"
    padding: 4px 10px
  search-bar:
    backgroundColor: "{colors.surface-glass}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.sm}"
    padding: 10px 16px
---

# Design Analysis — Transcriber (Reels Insight Extractor)

> Analysis generated with the `anydesign` skill.
> Date: 2026-06-06
> Analysis emphasis: design system + reconstruction (goal: improve the UI)

---

## Source

- **Source type**: combination — codebase + running URL
- **Path / URL**: `frontend/src/index.css` (token source), `frontend/src/App.jsx` (structure), `frontend/src/App.css` (recent additions), live at `http://localhost:5173`
- **Capture method**: direct source reading of CSS custom properties — highest fidelity, no visual approximation needed
- **Detected limitations**: tokens read from source, not a rendered screenshot; HSL→hex conversions are approximate (the HSL/rgba originals are exact and authoritative).

---

## TL;DR

A dark, glowy "aurora glassmorphism" AI dashboard: near-black blue canvas, a slow-pulsing violet/pink radial mesh, and frosted translucent cards. One violet→pink gradient (`{colors.primary}` #8B5CF6 → `{colors.secondary}` #EC4899) carries the entire brand. **The actionable problem: the newest UI (the clustering controls — view toggle, filter dropdowns, recompute button) was added with hardcoded light-theme values (`#fff`, `#111`, `#ccc`, `#4f46e5`) and unstyled native `<select>`s, so it visually clashes with the otherwise-cohesive dark system.** Fixing that one band of controls is the highest-leverage UI win.

---

## 1. Visual identity

### 1.1 Surface description

**Personality**: glowy, premium, motion-aware, focused, indie-AI.

**Mood**: a calm dark "command surface" that feels alive (ambient animated mesh, pulsing logo glow) without being noisy.

**Detectable stylistic references**: Linear's dark restraint crossed with Vercel/AI-startup gradient glow; glassmorphism (frosted `backdrop-filter: blur(16px)`).

**Information density**: balanced — generous padding (28–40px), a bento-style auto-fill card grid, lots of breathing room.

**Implicit positioning**: a single power-user / maker who saves educational Reels. Personal-tool polish, not enterprise.

**Confidence**: ✅ high (read from source).

### 1.2 Brand voice / Atmosphere

This design believes its user is a focused maker who lives in dark tools and judges software by feel. Every choice serves "this is a premium AI instrument, not a CRUD form": the canvas is near-black so the violet glow reads as energy; cards are frosted glass so content feels layered over an atmosphere rather than stamped on a page; the background mesh *moves* on a 20s loop so the surface feels live even when idle. The pipeline step-tracker (Server Check → Fetch → Transcribe → Llama → Save) turns a backend POST into a visible, almost cinematic process — the product wants you to *watch the AI work*.

The restraint is deliberate: outside the one gradient and its glows, everything is neutral (text, hairline borders, translucent fills). That discipline is what makes the violet feel expensive instead of gaudy. The recent clustering controls break this contract — they reach for raw browser defaults instead of the atmosphere, which is exactly why they look "bolted on."

### 1.3 The "ONE brand thing"

- **The thing**: the **violet→pink gradient + its glow** (`linear-gradient(135deg, #8B5CF6, #EC4899)`), applied as text-fill on the logo, as the primary button, and as drop-shadow glows on the logo icon and focus rings.
- **Why it carries the brand**: strip the gradient/glow and you have a generic dark admin panel. It is the only saturated color in the system; it does 100% of the brand work.
- **How everything else supports it**: canvas, cards, text, and borders are all desaturated neutrals specifically so the gradient has no competition.
- **Where it appears (and where it doesn't)**: hero wordmark, primary CTA, active pipeline node, focus rings, badges. It deliberately does *not* appear as large background fills (only as low-opacity mesh/glow). 

*Confidence*: ✅ high.

---

## 2. Design System (tokens)

### 2.1 Colors

| Token | Value (authoritative) | Hex approx | Role | Where | Confidence |
|---|---|---|---|---|---|
| `bg-dark` | `hsl(240 20% 6%)` | `#0E0E13` | App canvas | `body` | ✅ |
| `bg-card` | `hsl(240 21% 9%)` | `#13131B` | Solid card / node fill | step-node | ✅ |
| `bg-input` | `rgba(20,20,30,0.6)` | `#14141E99` | Input fields | url-input, textarea | ✅ |
| `surface-glass` | `rgba(18,18,28,0.7)` | `#12121CB3` | Frosted card fill | `.glass` | ✅ |
| `primary` | `hsl(263 85% 63%)` | `#8B5CF6` | Accent, CTA, links | buttons, badges, glow | ✅ |
| `secondary` | `hsl(325 83% 58%)` | `#EC4899` | Gradient end | logo, CTA gradient | ✅ |
| `success` | `hsl(142 71% 45%)` | `#21C45D` | Completed steps | step.completed | ✅ |
| `warning` | `hsl(38 92% 50%)` | `#F59E0B` | Wake-up alert | `.wake-alert` | ✅ |
| `text-primary` | `hsl(0 0% 98%)` | `#FAFAFA` | Main text | headings, body | ✅ |
| `text-secondary` | `hsl(240 5% 75%)` | `#BCBCC2` | Secondary text | takeaways, labels | ✅ |
| `text-muted` | `hsl(240 5% 50%)` | `#78788A` | Tertiary text | dates, captions | ✅ |
| `border` | `rgba(255,255,255,0.08)` | `#FFFFFF14` | Glass hairline | card borders | ✅ |
| `border-hover` | `rgba(139,92,246,0.3)` | `#8B5CF64D` | Hover border | interactive glass | ✅ |

**Off-system colors found (the problem set)** — in `App.css`, the clustering controls hardcode values that exist nowhere else: `#fff`, `#111`, `#ccc` (view-toggle), `#4f46e5` (recompute button — indigo, not the brand violet `#8B5CF6`), and ad-hoc `rgba(120,130,255,…)` / `rgba(110,231,150,…)` chips. These should map to existing tokens. ⚠️

### 2.2 Typography

- **Detected family**: `Plus Jakarta Sans` (imported from Google Fonts, weights 300–800) — ✅ high (explicit `@import`).
- **Fallback**: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`.

| Token | Size | Weight | Line-height | Use |
|---|---|---|---|---|
| `display` | 2.25rem / 36px | 800 | — | Logo wordmark (gradient text) |
| `modal-title` | 1.75rem / 28px | 800 | 1.35 | Modal heading |
| `section-title` | 1.35rem / ~22px | 700 | — | Dashboard / "Saved Insights" |
| `card-title` | 1.15rem / ~18px | 700 | 1.4 | Card titles (2-line clamp) |
| `body` | 1rem / 16px | 400–500 | 1.5 | Body, inputs |
| `label-eyebrow` | 1.05rem / ~17px | 700 | — | Modal section titles (UPPERCASE, +0.5px tracking) |
| `caption` | 0.75rem / 12px | 500 | — | Dates, step labels |

**Notable**: display/logo uses negative tracking (-0.5px); modal section titles are the only uppercase + positive-tracking style (eyebrow voice).

### 2.3 Spacing

- **Base unit**: 4px, but expressed in `rem` (0.25rem). Common steps: 0.5/0.75/1/1.5/1.75/2/2.5rem (8/12/16/24/28/32/40px).
- **Consistency**: ✅ high in `index.css`; ⚠️ the new `App.css` controls use a looser ad-hoc set (0.4rem/0.6rem/0.9rem) that doesn't align to the scale.

### 2.4 Radii

- `sm`: 8px (buttons, inputs, tags, search) — `{rounded.sm}`
- `md`: 12px (input group, upload zone, progress) — `{rounded.md}`
- `lg`: 16px (cards, modal) — `{rounded.lg}`
- `pill`: 20px (topic badge) — `{rounded.pill}`
- `full`: 9999px (step-node circle, spinner)

### 2.5 Elevation system

Glass + glow, not classic drop-shadow tiers.

| Level | Name | Treatment | Use |
|---|---|---|---|
| 0 | Flat | no chrome | body canvas |
| 1 | Glass hairline | `blur(16px)` + `1px solid {colors.border}` | default cards |
| 2 | Glow hover | `0 8px 30px rgba(0,0,0,0.4), 0 0 15px rgba(139,92,246,0.05)` + violet border | `.glass-interactive:hover` |
| 3 | Focus glow | `--shadow-glow: 0 0 20px rgba(139,92,246,0.25)` | focused inputs, primary CTA hover |
| 4 | Modal | `0 20px 50px rgba(0,0,0,0.6)` over `blur(12px)` backdrop | dialogs |

#### Decorative depth (non-functional)

- **Animated aurora mesh**: fixed full-bleed `body::before` with three radial-gradients (indigo/pink/violet) animating position+scale on a 20s `backgroundPulse` loop. This is the signature atmosphere.
- **Logo glow**: `logoGlow` drop-shadow animation (3s) on the logo icon.
- **Gradient text**: logo wordmark uses `background-clip: text` over the violet→pink gradient.

### 2.6 Borders

- Base: `rgba(255,255,255,0.08)` 1px hairline.
- Hover/focus: violet — `rgba(139,92,246,0.3)` border or `--shadow-glow` ring.

### 2.7 Accessibility quick-check

See companion `design-a11y.md`. Headlines on canvas are strong (`text-primary` on `bg-dark` ≈ 18:1, AAA). Watch `text-muted` (#78788A) on glass — borderline for small text. The off-system `view-toggle` (white bg, #111 text) is high-contrast but wrong-theme.

---

## 3. Components Inventory

### 3.1 Generic components

#### button-primary
- **Variants**: primary (violet→pink gradient), ghost/alt (`.alt-input-btn`, transparent violet text).
- **States**: default, hover (`translateY(-2px)` + glow), disabled (opacity 0.6).
- **Padding**: 12px 28px. **Radius**: `{rounded.sm}` (8px). **Confidence**: ✅.

#### input-group
- Frosted group with left icon; `:focus-within` → violet border + `--shadow-glow`. ✅

#### search-bar
- Glass pill, icon + transparent input, max-width 400px. ✅

#### glass-card (`.reel-card` on `.glass`)
- Topic badge (pill) + date, 2-line clamped title, 3-line takeaway, footer with task count + "View details". Hover lifts the read-more arrow gap. ✅

#### topic-badge
- `topic-badge` (violet pill for cluster/topic), `tool-tag` (neutral glass chip with hover lift + copy icon). ✅

#### Modal
- Centered, `scaleUp` spring entrance, blurred overlay, close button rotates 90° on hover, takeaway banner with gradient + left accent bar, action checklist, tool tags, transcript accordion. ✅

### 3.2 Signature components

#### Aurora mesh canvas
- **What**: animated multi-radial-gradient fixed background.
- **Why signature**: it's the brand atmosphere; remove it and the app goes flat.
- **Composition**: `body::before`, three radial-gradients, 20s `backgroundPulse`.
- **Confidence**: ✅.

#### Pipeline step-tracker
- **What**: 6-node horizontal progress (Server→Fetch→Audio→Transcribe→Llama→Save) with active/completed states (violet glow / green).
- **Why signature**: turns a single API call into a watchable AI process; unique to this product.
- **Confidence**: ✅.

#### Gradient-text glowing logo
- Wordmark in clipped violet→pink gradient + pulsing glow icon. ✅

---

## 4. Layout & Composition

### 4.1 Grid & containers
- `.app-container` max-width **1200px**, padding 2.5rem 1.5rem, centered.
- Card grid: `repeat(auto-fill, minmax(340px, 1fr))`, 1.75rem gap (bento auto-fill).

### 4.2 Composition patterns
- Centered hero (logo + subtitle) → ingestion panel (glass) → dashboard (search + controls + grid/table) → modal overlay.

### 4.3 Responsive behavior

| Name | Width | Key changes |
|---|---|---|
| Mobile | < 640px | `.dashboard-controls` stack vertically |
| Tablet | < 768px | step-tracker → 1 column |
| Desktop | ≥ 768px | full 6-up step grid, multi-col card grid |

Card grid is intrinsically responsive via `auto-fill minmax(340px,…)`. ⚠️ The new `.controls-bar` uses `flex-wrap` only — acceptable, but the native `<select>`s are not theme-aware on any width.

#### Touch targets
- CTAs/inputs ~44–48px ✅. ⚠️ view-toggle buttons (~32px tall) and select height are a touch small.

### 4.4 Image behavior
- Effectively imageless app (icon-driven). Icons: **lucide-react** (stroke icons). Note the lucide v1.17 build dropped brand icons — `Clapperboard` replaced the removed `Instagram` glyph.

---

## 5. Reconstruction Notes

### Suggested stack
Vanilla CSS with CSS custom properties (current approach) — no framework needed. The token layer in `index.css` is already a clean design system; the fix is to *use* it everywhere.

### Quick wins (the UI improvement work)
1. **Re-skin the clustering controls to the token system** — replace `App.css` lines 187–200 hardcoded values with `var(--glass-bg)`, `var(--accent-primary)`, `var(--radius-*)`, `var(--text-*)`. Style the native `<select>` (dark bg, hairline border, custom arrow) or swap for a styled dropdown.
2. **Recolor the recompute button** from `#4f46e5` to the brand gradient (reuse `.btn-primary`).
3. **Delete dead CSS**: `App.css` lines 1–184 are unused Vite-template styles (`.hero`, `.counter`, `#next-steps`, `#docs`, `.ticks`).
4. **Promote the table into the glass system**: give `.insights-table` a `.glass` wrapper, violet hover rows, and reuse `tool-tag`/`topic-badge` instead of the one-off `tool-chip`/`cluster-pill`.

### Tricky bits
- The animated mesh + `backdrop-filter` can be GPU-heavy; keep blur values as-is, don't stack more.
- Native `<select>` styling on dark themes needs the custom-arrow + `option` background treatment (browsers vary).

### Implicit states to define
- Active filter "chip" state, empty-cluster state ("Run Recompute"), recompute error toast (currently only `setError`), table empty/filtered-to-zero state.

### Confidence map

| Layer | Confidence | Why |
|---|---|---|
| Identity | ✅ high | Read from source + clear patterns |
| Colors | ✅ high | CSS vars are authoritative |
| Typography | ✅ high | Explicit font import + sizes |
| Spacing | ✅ high | Read from source |
| Components | ✅ high | Full CSS available |
| Layout | ✅ high | Containers/grids explicit |
| New controls | ⚠️ flagged | Off-system by construction |

---

## 6. Do's and Don'ts

### Do
- **Pull every color from `index.css` variables** (`var(--accent-primary)`, `var(--glass-bg)`, `var(--text-secondary)`) — never hardcode hex in component CSS.
- **Reserve the violet→pink gradient for primary actions and brand marks** (logo, primary CTA, active states). Reuse `.btn-primary` for the recompute button.
- **Wrap new surfaces in `.glass`** (cards, tables, panels) so they inherit blur + hairline + radius.
- **Use the radius scale**: `--radius-sm` (8px) for controls/tags, `--radius-md` (12px) for inputs/panels, `--radius-lg` (16px) for cards/modals.
- **Reuse existing chips**: `topic-badge` for clusters, `tool-tag` for tools — don't invent `cluster-pill`/`tool-chip` parallels.
- **Keep accents desaturated-neutral around the gradient** so violet stays the only saturated voice.
- **Style interactive hover as a violet border/glow** (`--glass-border-hover`, `--shadow-glow`), matching cards and inputs.

### Don't
- **Don't introduce new accent colors** (`#4f46e5` indigo, `rgb(120,130,255)`, `rgb(110,231,150)`) — they fracture the single-gradient identity.
- **Don't ship unstyled native `<select>`** on the dark theme — default white dropdowns break the atmosphere.
- **Don't use light-on-light controls** (white bg / `#111` text) anywhere — the system is dark-first.
- **Don't add heavy single drop-shadows**; the system layers soft glow + hairline.
- **Don't leave the dead Vite-template CSS** in `App.css` — it's confusing and unused.
- **Don't put body/long text in uppercase**; uppercase is reserved for the modal eyebrow labels only.

---

## 7. Open Questions

- Is there a light mode planned? Nothing in source suggests one — the system is dark-only.
- Should the table view fully adopt card-grid visual weight, or stay a denser "spreadsheet" on purpose? (Affects how much glass to apply.)
- Is a styled custom dropdown component wanted, or is a CSS-themed native `<select>` acceptable?
- Recompute currently surfaces errors via `setError` only — is a toast/inline-banner pattern desired (none exists yet)?

---

## 8. Companion files

- [x] `design-tokens.json` — DTCG tokens (`$value`/`$type`) for the system above
- [x] `design-a11y.md` — WCAG contrast for key pairs
- [ ] `design-screenshot.png` — not generated (analysis done from authoritative source)

---

*Next logical step (emphasis = improve UI): convert Section 5 "Quick wins" + Section 6 rules into a focused refactor of `App.css` so the clustering controls join the design system. Say the word and I'll implement it.*
