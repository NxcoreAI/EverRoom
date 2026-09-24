# Soft 3D / Claymorphism QA Checklist

## Visual Fit

- The deck feels professional, airy, and modern.
- 3D shapes are soft matte accents, not toy-like decorations.
- Palette is beige/sage/warm-pink with charcoal text.
- No neon, glossy plastic, glassmorphism, or saturated candy colors.
- Slides retain enough whitespace.

## Layout

- Each slide has one focal point.
- 3D accents do not overlap or reduce text readability.
- Panels align to a consistent grid.
- Card usage is purposeful and not repetitive.
- Dense slides still feel calm and structured.

## Text

- Titles are concise and left aligned unless there is a strong reason otherwise.
- Body text is readable at presentation distance.
- Text does not touch panel edges or decorative objects.
- No emoji.

## PPT / SVG

- Run `svg_quality_checker.py` when using `ppt-master`.
- Fix all errors before export.
- Prefer zero warnings.
- Export PPT to PNG previews and inspect cover, densest slide, and conclusion.

## Common Fixes

- If the deck feels childish: reduce 3D shapes, desaturate accents, increase whitespace, and use more charcoal typography.
- If the deck feels flat: add one soft corner object or subtle offset shadow.
- If the deck feels cluttered: remove decorative shapes before shrinking text.
- If contrast is weak: darken text to `#333333` and reduce pastel text usage.
