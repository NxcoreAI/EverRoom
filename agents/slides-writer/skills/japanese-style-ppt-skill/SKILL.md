---
name: japanese-style-ppt-skill
description: "Create or redesign PowerPoint/PPTX decks in the user's Japanese editorial styles: (1) \"Washi Paper & Soft Glow\" with washi texture, indigo restraint, and warm minimalism; or (2) high-end Japanese lifestyle magazine style with stark white background, burnt orange accent, charcoal gray, structured grids, and asymmetric edge-pressed imagery. Use when the user asks for PPT design, slide decks, presentation styling, ppt-master integration, or warm/sharp minimalist business, humanities, brand story, or lifestyle editorial decks."
---

# Japanese Style PPT

Use this skill to design PPT decks with refined Japanese editorial restraint. It supports two house styles:

- **Style 1: Washi Paper & Soft Glow** - washi paper texture, quiet geometry, soft glow, indigo emphasis, professional warmth.
- **Style 2: Japanese Lifestyle Editorial** - stark white background, bold elegant sans-serif headings, structured grids, burnt orange/charcoal accents, asymmetric edge-pressed imagery.

## Core Workflow

1. If the task uses `ppt-master`, follow the `ppt-master` pipeline first. Use this skill as the visual style layer for the Eight Confirmations, `design_spec.md`, `spec_lock.md`, SVG execution, and visual QA.
2. If the user asks for "second style", "Japanese lifestyle magazine", "burnt orange", "stark white", or "asymmetric edge-pressed imagery", read `references/japanese-lifestyle-editorial.md`.
3. Otherwise read `references/style-system.md` before choosing colors, typography, background treatment, and icon strategy.
4. Read `references/slide-patterns.md` before creating or rewriting slide layouts.
5. Read `references/ppt-master-integration.md` when producing `design_spec.md`, `spec_lock.md`, or SVG pages through `ppt-master`.
6. Read `references/qa-checklist.md` before final delivery or when reviewing a generated deck.

## Non-Negotiable Style Rules

- Use a soft off-white or pale washi paper background; avoid pure white and pure black.
- Use exactly one active accent color per deck. Default to indigo `#2C3E50`.
- Use the supplied palette only as muted supporting colors, not as a rainbow.
- Favor thin gray lines, asymmetry, and negative space over heavy cards.
- Prefer vector diagrams, quiet image crops, and tactile paper surfaces over glossy stock visuals.
- Avoid neon, glassmorphism, loud gradients, oversized icons, emoji, and generic SaaS blue-purple aesthetics.
- Keep slide density moderate. Let one idea breathe on each page unless the source truly requires a dense framework.
- Always use 16:9 unless the user explicitly requests another ratio.

## Default Style Values

- Background: `#F5F5F5`
- Active accent: `#2C3E50`
- Body text: `#333333`
- Secondary text: `#6B6B6B`
- Divider: `#D8D6D0`
- Palette reserves: `#B3AFCB`, `#8995B7`, `#777F6C`, `#AA6F5F`, `#D5D0DB`

## Style 2 Quick Values

- Background: `#FFFFFF`
- Burnt orange accent: `#CC5500`
- Body/title text: `#333333`
- Deep clay accent: `#71362B`
- Layout: structured grid, high negative space, asymmetric edge-pressed images
- Typography direction: bold but elegant sans-serif headings, sharp editorial details

## Output Expectations

For new decks:

- Produce a clear content strategy first: audience, narrative arc, page count, slide outline.
- Use assertion-style slide titles for business decks.
- Use Japanese minimalist editorial composition: 60-75% quiet surface, 20-30% content, 5-10% accent.
- Include speaker notes when the workflow supports them.
- Run visual QA by exporting slides to images when possible.

For redesigns:

- Preserve the user's message and slide count unless asked to restructure.
- Replace generic cards with lines, open grids, framed callouts, or bento-like asymmetry.
- Harmonize all typography, spacing, and color usage to the selected Japanese style system.

## Bundled Resources

- `references/style-system.md`: palette, typography, texture, icon, and material rules.
- `references/japanese-lifestyle-editorial.md`: second style variant with stark white editorial magazine rules.
- `references/slide-patterns.md`: reusable PPT page structures in this style.
- `references/ppt-master-integration.md`: how to express this style inside `ppt-master` artifacts.
- `references/qa-checklist.md`: final review criteria.
- `assets/template.html`: optional HTML deck starter using this visual language.
- `assets/style2-template.html`: optional HTML starter for the Japanese Lifestyle Editorial variant.
