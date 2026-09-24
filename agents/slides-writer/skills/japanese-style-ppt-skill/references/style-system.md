# Washi Paper & Soft Glow Style System

## Design Intent

Create a calm, tactile, high-end PPT style that blends Japanese washi paper, Muji-like restraint, and modern editorial precision. The deck should feel professional, reflective, and warm, not decorative or sentimental.

## Palette

Use these colors with low saturation and generous whitespace.

| Role | HEX | Usage |
| --- | --- | --- |
| Paper base | `#F5F5F5` | Primary background |
| Indigo accent | `#2C3E50` | Main accent, rules, emphasis, diagram nodes |
| Charcoal text | `#333333` | Body and title text |
| Secondary text | `#6B6B6B` | Captions and support copy |
| Divider gray | `#D8D6D0` | Thin rules and quiet borders |
| Mist lavender | `#D5D0DB` | Soft background field, rare |
| Wisteria gray | `#B3AFCB` | Gentle secondary wash, rare |
| Blue gray | `#8995B7` | Alternative cool accent, not with indigo unless muted |
| Moss gray | `#777F6C` | Organic supporting tone, rare |
| Clay rose | `#AA6F5F` | Human warmth marker, rare |

Rules:

- Use `#2C3E50` as the only active accent unless the user explicitly selects walnut/clay.
- Do not use all five palette colors equally.
- Keep most pages to paper + charcoal + gray + indigo.
- Use palette reserves as translucent fields or single-page mood accents only.

## Background and Material

Use paper texture, not glossy gradients.

- PPT/SVG: simulate washi through tiny low-opacity dots, fine fibers, or subtle irregular line texture.
- HTML: use radial noise, pseudo-element grain, or a soft paper overlay.
- Keep texture subtle enough that body text remains readable.
- Avoid bokeh, orbs, neon glow, glass panels, or strong drop shadows.

Soft glow is allowed only as a restrained local wash:

- Use pale indigo/lavender at very low opacity.
- Apply behind a hero word, diagram node, or section transition.
- Never use glowing buttons or outer neon shadows.

## Typography

Preferred PPT-safe direction:

- Title: `Georgia, "Microsoft YaHei", serif`
- Body: `"Microsoft YaHei", "PingFang SC", Arial, sans-serif`
- Code/labels: `Consolas, "Courier New", monospace`

Usage:

- Use title serif for editorial warmth and hierarchy.
- Use sans body for clarity.
- Use monospace sparingly for section labels, page numbers, technical terms, and source notes.
- Avoid negative letter spacing in PPT.
- Keep body text around 18-22 px for dense content and 22-26 px for reflective decks.

## Geometry

Use precise, light geometry:

- Thin horizontal and vertical rules.
- Open rectangular frames.
- Small indigo dots or line endpoints.
- Asymmetric columns.
- Spacious grids.
- Low-radius rectangles only when a container is needed.

Avoid:

- Heavy card grids.
- Thick borders.
- Filled icon badges.
- Decorative blobs.
- Repeated centered title + bullets.

## Icons

For `ppt-master`, prefer `tabler-outline`.

- Use icons as quiet line markers, not visual decoration.
- Use at most 1-3 icons per page.
- Keep stroke/icons indigo or charcoal.
- Do not use emoji.

## Imagery

Best image types:

- Cropped product/process photos with lots of negative space.
- Paper, craft, architecture, landscape, studio details.
- Softly framed diagrams and scanned document fragments.

Treatment:

- Use image crops in geometric frames.
- Add thin caption rules.
- Avoid dark stock photos, busy office scenes, and generic AI illustrations.
