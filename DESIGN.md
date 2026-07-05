---
name: Transcriber Design System
description: High-contrast monochrome developer aesthetic with premium typography and razor-sharp structural borders.
colors:
  primary: "#000000"
  neutral-bg: "#ffffff"
  accent-secondary: "#f3f4f6"
  accent-success: "#10b981"
  accent-warning: "#f59e0b"
  text-primary: "#000000"
  text-secondary: "#4b5563"
  text-muted: "#78788a"
typography:
  display:
    fontFamily: "Plus Jakarta Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "clamp(1.6rem, 7vw, 2.25rem)"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.5px"
  body:
    fontFamily: "Plus Jakarta Sans, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  sm: "2px"
  md: "2px"
  lg: "2px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral-bg}"
    rounded: "{rounded.sm}"
    padding: "12px 28px"
---

# Design System: Transcriber

## 1. Overview

**Creative North Star: "The Obsidian Desk"**

The Transcriber visual identity is an elevated, high-contrast monochrome workspace. Inspired by architectural blueprints, physical desks, and industrial terminal interfaces, the design leverages stark pure-white/pure-black surfaces, sharp 2px radius borders, and intentional accent spacing to build a clutter-free environment. Visual structure is driven purely by clean alignments and border divisions, rather than heavy cards or muddy shadow depth.

The system is highly interactive. Hover states reveal soft background glows or border accentuation. The mood is precise, direct, and developer-centric, showing extreme respect for the user's attention.

### Key Characteristics:
* **Stark Contrast:** Strict black and white primary layers to ensure readability.
* **Sharp Outlines:** Components are defined by explicit 1px borders with a micro 2px radius.
* **Typographic Focus:** Plus Jakarta Sans drives the content rhythm with generous weight contrast and tight headings.
* **Intentional Transitions:** Smooth interaction feedbacks (border color changes, opacity offsets) that make the page feel reactive.

---

## 2. Colors

The color palette is monochrome at rest, using color strictly for status indication (processing, success, warning) or micro-interactions.

### Primary
- **Obsidian Ink** (#000000 / oklch(0% 0 0)): Primary surface fill and body text color in light mode; flips to pure white in dark mode.

### Neutral
- **Clean Canvas** (#ffffff / oklch(100% 0 0)): Primary background surface in light mode; flips to pure black in dark mode.
- **Cool Concrete** (#f3f4f6 / oklch(96% 0.005 240)): Secondary background for panels and secondary buttons; flips to deep gray (#1f2937) in dark mode.

### Status Accent
- **Vibrant Emerald** (#10b981 / oklch(72% 0.17 150)): Used for completed pipeline states and success indicators.
- **Vibrant Amber** (#f59e0b / oklch(77% 0.18 70)): Used for processing or warning states.

### Named Rules
**The Monochrome Dominance Rule.** Brand surfaces and primary elements must remain strictly black and white. Saturated colors are reserved exclusively for status states (success, pending, failed) and must cover ≤5% of the total screen area.
**The High-Contrast Text Rule.** All text elements must preserve a minimum contrast ratio of 4.5:1 against their backgrounds. Text is never tinted into mid-gray "for elegance" if it compromises readability.

---

## 3. Typography

All typography is rendered using **Plus Jakarta Sans**, a modern geometric sans-serif that balances legibility in small text blocks with bold, display character in titles.

**Display Font:** Plus Jakarta Sans
**Body Font:** Plus Jakarta Sans

### Hierarchy
- **Display** (800, clamp(1.6rem, 7vw, 2.25rem), 1.2): Used for the main header title. Features a subtle letter-spacing adjustment (-0.5px).
- **Headline** (700, 1.15rem, 1.4): Used for card titles and section headers.
- **Title** (600, 0.95rem, 1.3): Used for subheadings and panel headers.
- **Body** (400, 1rem, 1.5): Used for paragraph text, transcript details, and description blocks. Cap content width at 75ch.
- **Label** (500, 0.75rem, normal): Used for badges, tags, buttons, and metadata.

### Named Rules
**The Letter-Spacing Rule.** High-weight display headers (fontWeight 800) must have a negative letter-spacing (-0.5px) to keep letters cohesive, while labels and small text keep standard spacing.
**The Balanced Wrap Rule.** Heading text must use `text-wrap: balance` to prevent orphan words and maintain typographic balance.

---

## 4. Elevation

The Obsidian Desk rejects traditional soft shadows and drop-shadow depth in favor of flat boundaries and strict border definitions. Depth is represented purely by container nesting or high-contrast borders.

### Named Rules
**The Zero-Shadow Rule.** Surfaces are flat by default. Traditional drop shadows are prohibited unless explicitly required for modal overlay separation. Depth is conveyed strictly through structural borders and background tint shifts.
**The Border State Rule.** Interactive containers (cards, buttons, inputs) transition their border color on hover or focus instead of using shadow glow.

---

## 5. Components

### Buttons
- **Shape:** 2px border radius.
- **Primary:** Obsidian Ink background with Clean Canvas text, padding of 12px 28px.
- **Hover / Focus:** Translucent background shifts (`--accent-secondary`), border remains sharp.
- **Secondary:** Clean Canvas background with Obsidian Ink border and text.

### Cards / Containers
- **Corner Style:** 2px border radius.
- **Background:** Clean Canvas background.
- **Border:** 1px solid Obsidian Ink (`--glass-border`).
- **Hover:** Border color highlights, soft background opacity changes.

### Inputs / Fields
- **Style:** 1px solid Obsidian Ink border with Clean Canvas background.
- **Focus:** Sharp border color transition to primary ink with high contrast.

---

## 6. Do's and Don'ts

### Do:
- **Do** maintain a strict 2px border radius on all cards, buttons, and input fields.
- **Do** ensure that text elements have clear contrast, moving toward ink black (#000000) or pure white (#ffffff) depending on the mode.
- **Do** use CSS transitions (`--transition-smooth`) on hover and focus to provide instant feedback.

### Don't:
- **Don't** use side-stripe borders or colored left-borders on cards or alerts.
- **Don't** apply text gradients or `background-clip: text` for display headings.
- **Don't** use soft drop shadows (e.g. `box-shadow: 0 4px 20px ...`) to separate normal cards.
- **Don't** animate image scale, translation, or rotation on card hover.
- **Don't** use low-contrast muted grays for body or description text.
