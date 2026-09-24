---
name: soft-3d-clay-ppt-skill
description: "Create or redesign PowerPoint/PPTX decks in a \"Soft 3D / Claymorphism\" style: minimalist professional presentation design with soft matte 3D geometric shapes, pastel beige/sage/warm-pink palette, airy clean layouts, soft shadows, high-end illustration feel, and sophisticated UI design. Use when the user asks for PPT design, slide decks, presentation styling, ppt-master integration, claymorphism, soft 3D, pastel professional decks, or modern airy business presentations."
---

# Soft 3D / Claymorphism PPT

Use this skill to design professional PPT decks with a lightweight 3D claymorphism aesthetic: soft matte geometric shapes, airy whitespace, pastel warmth, and polished UI-like layout discipline. The style should feel modern, high-end, and calm, not childish or toy-like.

## Core Workflow

1. If the task uses `ppt-master`, follow the `ppt-master` pipeline first. Use this skill as the visual style layer for the Eight Confirmations, `design_spec.md`, `spec_lock.md`, SVG execution, and visual QA.
2. Read `references/style-system.md` before choosing colors, typography, background treatment, icon strategy, and 3D shape usage.
3. Read `references/slide-patterns.md` before creating or rewriting slide layouts.
4. Read `references/ppt-master-integration.md` when producing `design_spec.md`, `spec_lock.md`, or SVG pages through `ppt-master`.
5. Read `references/qa-checklist.md` before final delivery or when reviewing a generated deck.

## Non-Negotiable Style Rules

- Keep the layout extremely clean and professional.
- Use soft 3D geometry as corner accents or concept anchors, not as clutter.
- Use the pastel palette with restraint: warm beige base, sage green and warm pink accents.
- Use soft shadows and matte surfaces; avoid glossy plastic, neon, glassmorphism, or hard metallic 3D.
- Keep most information in flat, readable typography and simple grids.
- Avoid emoji, cartoon mascots, busy backgrounds, and saturated candy colors.
- Prefer 16:9 unless the user explicitly requests another aspect ratio.

## Default Style Values

- Background: `#FDF5E6`
- Sage green: `#B2AC88`
- Warm pink: `#DBADAD`
- Charcoal text: `#333333`
- Secondary text: `#6B6B6B`
- Soft divider: `#E7DAC8`
- Highlight surface: `#FFF9EF`

## Output Expectations

For new decks:

- Start with a clear content strategy: audience, narrative arc, page count, slide outline.
- Use calm assertion headlines and short body copy.
- Place 3D shapes in corners, side gutters, or hero zones; do not let them compete with the message.
- Use spacious UI-like composition: clear columns, soft panels, and consistent spacing.
- Include speaker notes when the workflow supports them.
- Export slide previews for visual QA when possible.

For redesigns:

- Preserve the user's content unless asked to restructure.
- Replace heavy charts/cards with softer panels, floating callouts, and simple diagrams.
- Add soft 3D accents only where they clarify hierarchy or mood.

## Bundled Resources

- `references/style-system.md`: color, typography, 3D shape, material, and icon rules.
- `references/slide-patterns.md`: reusable PPT page structures for this style.
- `references/ppt-master-integration.md`: how to express the style inside `ppt-master`.
- `references/qa-checklist.md`: final review criteria.
- `assets/template.html`: optional HTML deck starter using this visual language.
