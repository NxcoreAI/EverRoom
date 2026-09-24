# Soft 3D / Claymorphism Style System

## Design Intent

Create a minimalist professional presentation style with soft matte 3D geometric shapes floating in corners. The deck should feel airy, modern, sophisticated, and UI-polished. It should not feel like a children's clay illustration or a generic pastel template.

## Palette

| Role | HEX | Usage |
| --- | --- | --- |
| Warm beige | `#FDF5E6` | Main background |
| Sage green | `#B2AC88` | Primary accent, 3D shape base, section markers |
| Morandi warm pink | `#DBADAD` | Secondary accent, soft 3D shape, warm emphasis |
| Charcoal | `#333333` | Main text |
| Secondary text | `#6B6B6B` | Body support, captions |
| Soft divider | `#E7DAC8` | Hairlines, panel borders |
| Highlight surface | `#FFF9EF` | Soft cards/panels |
| Shadow tone | `#C8BBA8` | Shadow approximation in SVG/PPT |

Rules:

- Use beige as the dominant surface.
- Use sage and warm pink as accents, not equal full-page backgrounds.
- Do not introduce saturated purple, blue, neon green, or strong gradients.
- Keep text charcoal; avoid pure black.

## 3D Material Rules

Claymorphism here means soft matte depth, not realistic 3D rendering.

Use:

- Rounded spheres, pills, capsules, soft cubes, rings, torus-like arcs, and abstract blobs.
- Pastel fills with subtle highlight and shadow.
- Corner placement: top-right, bottom-left, or side gutters.
- Low-contrast depth to frame content.

Avoid:

- Large central 3D objects on every page.
- Plastic shine, metallic reflections, or harsh perspective.
- Dense stacks of shapes.
- Shapes behind small text.

SVG/PPT approximation:

- Use circles, ellipses, rounded rectangles, and paths.
- Create depth with 2-3 layered shapes: base fill, low-opacity highlight, soft offset shadow.
- Use opacity attributes rather than `rgba()`.
- If using `ppt-master`, avoid filters unless confirmed safe; use simple layered geometry instead.

## Typography

PPT-safe default:

- Title: `Arial, Microsoft YaHei, sans-serif`
- Body: `Microsoft YaHei, PingFang SC, Arial, sans-serif`
- Label/code: `Consolas, Courier New, monospace`

Direction:

- Use clean, rounded-feeling sans typography.
- Titles should be confident but not oversized.
- Body copy should be quiet and readable.
- Use monospace only for labels, page numbers, and small technical tags.

Suggested sizes for 16:9:

- Cover title: 56-76 px.
- Page title: 34-42 px.
- Subtitle: 22-26 px.
- Body: 18-21 px.
- Caption/metadata: 11-14 px.

## Layout and Spacing

- Use generous whitespace and stable grid alignment.
- Prefer two-column layouts, hero object + text, or soft panel groups.
- Cards may be used, but should be soft and purposeful.
- Keep border radius moderate: 12-24 px for panels, larger for decorative shapes.
- Use soft shadows sparingly and consistently.

## Icon Strategy

For `ppt-master`, prefer `tabler-outline` or simple custom line icons.

- Icons should be thin, charcoal or sage.
- Avoid filled icon badges unless they are very subtle.
- Use at most 1-3 icons per slide.

## Imagery

Best image types:

- Product UI screenshots
- Clean workspace details
- Soft product photography
- Minimal abstract renderings

Treatment:

- Use images inside soft rounded rectangles or edge-aligned frames.
- Pair with 3D corner accents, not full decorative backgrounds.
- Avoid busy lifestyle photos and overly colorful stock imagery.
