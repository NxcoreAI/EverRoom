# Washi Soft Glow QA Checklist

Use this before final delivery.

## Visual Fit

- Style 1 background reads as soft paper, not blank white.
- Style 2 background is intentionally stark white, not off-white paper.
- Accent color is indigo for Style 1 or burnt orange for Style 2.
- Palette does not feel like rainbow pastel.
- Geometry is precise, thin, and quiet.
- Deck feels professional with warmth, not craft-themed.
- Style 2 feels sharp and magazine-like, not soft or nostalgic.

## Layout

- Each slide has a clear focal point.
- There is enough negative space.
- Cards are used sparingly.
- Style 2 uses structured grids and edge-pressed images where appropriate.
- No repeated generic centered title + bullet layout.
- Diagrams align to a consistent grid.
- Footers and page numbers are unobtrusive.

## Text

- Titles are concise and editorial.
- Body text is readable at presentation distance.
- Text does not touch borders, rules, or icons.
- English terms are preserved when they are domain terms.
- No emoji.

## PPT / SVG

- Run `svg_quality_checker.py` when using `ppt-master`.
- Fix all errors before export.
- Prefer zero warnings; document any warnings that remain.
- Export PPT to PNG previews and inspect visually.
- Check cover, densest slide, and conclusion manually.

## Common Fixes

- If a slide feels too empty: add a thin rule, metadata label, or one structured diagram; do not add random decoration.
- If a slide feels too busy: remove containers before shrinking text.
- If warmth is missing: use paper texture, serif title, or a muted clay/lavender wash on one page.
- If professionalism is missing: reduce color variety and remove decorative marks.
