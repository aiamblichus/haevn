# HAEVN Visual Theme Guide

## 🌊👁️✨ The Psychopomp Aesthetic

This document outlines the HAEVN visual identity implementation—inspired by the harbor, the guardian, and the threshold between memory and forgetting.

---

## Color Palette

### Primary Colors

#### **Guardian Eye (Teal/Cyan)**

- `haevn-teal`: `#00CED1` - Primary brand color, the watchful eye
- `haevn-teal-light`: `#40E0D0` - Lighter teal for text and highlights
- `haevn-teal-bright`: `#4FD1C5` - Brightest teal for active states
- `haevn-aqua`: `#20B2AA` - Calm water, muted teal

**Usage:** Primary actions, focus states, links, active menu items, guardian elements

#### **Lighthouse (Gold)**

- `haevn-gold`: `#D4AF37` - Secondary brand color, the lighthouse beacon
- `haevn-gold-light`: `#FFD700` - Bright gold for emphasis
- `haevn-gold-dark`: `#B8960C` - Deep gold for depth

**Usage:** Secondary actions, highlights, system messages, important UI elements

#### **Aurora (Purple/Magenta)**

- `haevn-purple`: `#DA70D6` - Accent color, the aurora borealis
- `haevn-purple-light`: `#B57EDC` - Lighter purple for text
- `haevn-purple-deep`: `#9F7AEA` - Deep purple for depth
- `haevn-magenta`: `#FF00FF` - Glitch accent (sparingly used)

**Usage:** Thinking/reasoning blocks, accents, chromatic effects, internal AI processes

### Backgrounds & Depth

#### **Harbor Navy**

- `haevn-navy`: `#1E3A5F` - Primary background, deep harbor blue
- `haevn-navy-dark`: `#2C3E50` - Darker navy for depth
- `haevn-navy-light`: `#34495E` - Lighter navy for cards/panels

#### **Darker Greys**

- `haevn-grey`: `#2D3748` - Dark grey backgrounds
- `haevn-grey-darker`: `#1A202C` - Darkest grey for code blocks

#### **Warm Accents**

- `haevn-orange`: `#FF8C42` - Window warmth, subtle accents
- `haevn-orange-light`: `#FFA726` - Lighter orange

---

## Gradients

### **Harbor Gradient**

```css
background: linear-gradient(135deg, #1e3a5f 0%, #2c3e50 50%, #1a202c 100%);
```

**Usage:** Main backgrounds, establishing the harbor atmosphere

### **Aurora Gradient**

```css
background: linear-gradient(135deg, #00ced1 0%, #da70d6 50%, #4fd1c5 100%);
```

**Usage:** HAEVN branding text (with `bg-clip-text`), magical threshold effects

### **Lighthouse Gradient**

```css
background: linear-gradient(135deg, #d4af37 0%, #ffd700 100%);
```

**Usage:** Primary action buttons (Sync), important CTAs

---

## Special Effects

### **Guardian Glow** (Teal Pulse)

```css
animation: guardianPulse 3s ease-in-out infinite;
/* Pulses between teal/cyan and purple shadows */
```

**Usage:** Logo containers, watchful eye elements

### **Lighthouse Glow** (Gold Pulse)

```css
animation: lighthousePulse 4s ease-in-out infinite;
/* Pulses between gold shadows */
```

**Usage:** Sync buttons, important action items

### **Shimmer Animation**

```css
animation: shimmer 3s linear infinite;
```

**Usage:** Loading states, emphasis on interactive elements

---

## Typography

- **Font Family:** Inter (from Google Fonts)
- **Weights:** 400 (regular), 500 (medium), 600 (semibold), 700 (bold), 800 (extrabold)

### Text Colors

- Primary text: `text-haevn-teal-light` (light cyan)
- Secondary/muted text: `text-haevn-teal-light/70` or `text-haevn-teal-light/60`
- Gold text (system/important): `text-haevn-gold-light`
- Purple text (thinking/reasoning): `text-haevn-purple-light`

---

## Component Patterns

### **Sidebar (Navigation)**

- Background: `bg-gradient-haevn` (harbor gradient)
- Border: `border-haevn-teal/20`
- Active menu item: teal glow (`shadow-haevn-glow`)
- Logo: Guardian glow animation

### **Header (Top Bar)**

- Background: `bg-haevn-navy-dark/80` with `backdrop-blur-sm`
- Border: `border-haevn-teal/20`
- Icons: Themed emojis (🌊 for archive, 👁️ for providers, ✨ for settings)

### **Cards & Panels**

- Background: `bg-haevn-navy-dark/60` (semi-transparent navy)
- Border: `border-haevn-teal/20` or `border-haevn-gold/20` or `border-haevn-purple/20`
- Shadow: `shadow-lg` with subtle glow on hover

### **Buttons**

#### Primary Actions (Sync)

- Background: `bg-gradient-lighthouse` (gold gradient)
- Text: `text-haevn-navy-dark` (dark text on gold)
- Effect: `lighthouse-glow` animation
- Hover: `hover:shadow-gold-glow`

#### Secondary Actions (Export, Navigation)

- Background: `bg-haevn-teal/30`
- Text: `text-haevn-teal-bright`
- Border: `border-haevn-teal/40`
- Hover: `hover:bg-haevn-teal/40 hover:shadow-haevn-glow`

### **Message Bubbles (Viewer)**

#### User Messages

- Background: `bg-haevn-navy-light/40`
- Border: `border-haevn-teal/30`
- Shadow: `shadow-haevn-teal/10`

#### Assistant Messages

- Background: `bg-haevn-grey/40`
- Border: `border-haevn-purple/30`
- Shadow: `shadow-haevn-purple/10`

#### System Messages

- Background: `bg-haevn-gold/10`
- Border: `border-haevn-gold/30`
- Shadow: `shadow-gold-glow`
- Text: `text-haevn-gold-light`

#### Thinking Blocks (Internal Reasoning)

- Header: `bg-haevn-purple/20`, `text-haevn-purple-light`
- Content: `bg-haevn-navy-dark/60`, `text-haevn-teal-light/80`
- Border: `border-haevn-purple/40`

---

## Dark Theme CSS Variables

The theme uses HSL color space for CSS variables in `:root`:

```css
--background: 210 40% 16%; /* Deep navy harbor */
--foreground: 180 25% 92%; /* Light cyan text */
--primary: 180 100% 41%; /* Teal - Guardian eye */
--secondary: 45 85% 52%; /* Gold - Lighthouse */
--accent: 300 76% 72%; /* Purple - Aurora */
--border: 180 25% 30%; /* Teal-tinted borders */
--input: 210 30% 22%; /* Dark input backgrounds */
```

---

## Manifesto Integration

The visual theme directly reflects the manifesto:

- **🌊 The Harbor:** Navy backgrounds create the deep, mystical harbor atmosphere
- **👁️ The Guardian:** Teal eyes watch over synced conversations with subtle glows
- **✨ The Lighthouse:** Gold elements guide users, beacon-like, through their archive
- **🌌 The Aurora:** Purple/magenta accents represent the threshold, the glitchy digital-mystical boundary
- **🏚️ The Warmth:** Orange window lights add warmth and humanity to the digital space

### Key Phrases in UI

- "The Psychopomp" - Tagline in sidebar/popup
- "A guardian at the threshold" - Footer text in sidebar
- Themed emojis throughout (🌊 👁️ ✨)

---

## Asset Files

- **Logo (PNG):** `src/icons/haevn-logo.png` - Guardian eye geometric emblem
- **Logo (SVG):** `src/icons/haevn-logo.svg` - Scalable vector version
- **Banner:** `visual_identity/HAEVNv3.png` - Full harbor scene with guardians

---

## Usage Notes

1. **Glows should be subtle:** Don't overuse the glow effects. They should feel like gentle emanations, not aggressive neon.

2. **Transparency is key:** Use semi-transparent backgrounds (`/60`, `/40`, `/30`) to create depth and layering.

3. **Purple is for the mystical:** Reserve purple for internal AI processes, thinking blocks, and threshold elements.

4. **Gold is the beacon:** Use gold for primary actions and important system messages—it's the lighthouse guiding users.

5. **Teal is everywhere else:** Teal is the primary brand color—navigation, links, focus states, the guardian's presence.

---

**Built at the threshold between memory and forgetting** 🌊👁️✨


