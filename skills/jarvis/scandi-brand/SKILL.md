---
name: scandi-brand
description: Applies Scandi Gum's visual identity — colours, gradient, Aeonik Pro typography, logo variants and usage rules — to any document, slide deck, spreadsheet, chart, image or web page being produced. Use whenever creating a presentation, report, PDF, document or visual that someone outside the immediate team will see, or when the user asks for something on-brand, branded, or in company colours.
---

# Scandi brand

Everything needed to make an artefact look like it came from us. Assets are in
`/home/app/skills/jarvis/scandi-brand/assets/` (paths below are relative to
`/home/app/skills/jarvis/scandi-brand/`).

## Colours

| | Hex | Use |
|---|---|---|
| Scandi blue | `#2BB7EE` | primary |
| Scandi cyan | `#22D3EE` | secondary, gradient end |
| Black | `#000000` | text |
| White | `#FFFFFF` | backgrounds, text on the gradient |

**The gradient** is the signature element:

```css
linear-gradient(135deg, #2BB7EE 0%, #22D3EE 100%)
```

Always `135deg`, and **text on it is always white**.

Neutrals from the brand book, for backgrounds and rules rather than accents:
`#FAFAFA` page, `#F2F3F5` alt panel, `#0A0A0A` ink, `#4B4F55` soft ink,
`#E6E8EB` hairline.

## Type

**Aeonik Pro**, weights 400 / 500 / 700. TTFs are in `assets/fonts/`:

```
assets/fonts/aeonik-pro-regular.ttf   400
assets/fonts/aeonik-pro-medium.ttf    500
assets/fonts/aeonik-pro-bold.ttf      700
```

Embed the TTF when the format allows (`python-pptx` and `python-docx` both
can). When it doesn't, fall back to Inter, then Segoe UI, then system sans —
in that order. **Never substitute a serif.**

## Logo

| File | When |
|---|---|
| `assets/logo/logo-black.svg` | light backgrounds — the default |
| `assets/logo/logo-white.svg` | on the gradient, or any vivid colour |
| `assets/logo/logo-gradient.svg` | white or very light backgrounds only, when you want the mark to carry the colour |
| `assets/favicon/favicon-smile-*.svg` | the smile mark alone, for small square spaces |

**`python-pptx` and `python-docx` cannot embed SVG.** Use the PNGs for anything
built with them, and pick by background or you will put a black wordmark on a
blue gradient:

| File | When |
|---|---|
| `assets/logo/logo-black-2400.png` | light backgrounds (2400px, embed-friendly) |
| `assets/logo/logo-white.png` | **on the gradient or any vivid colour** (2400px) |
| `assets/logo/logo-black.png` | full resolution, 11600px — only when print-size |

`assets/pattern/scandi-pattern.png` is the background pattern. Use it sparingly
— a title slide or a section divider, not behind body text.

**Rules, from the brand book:**

- Keep clear space around the wordmark — at least the height of the smile.
- Put the white logo over the gradient or any vivid colour.
- Scale proportionally. Never stretch or skew.
- Don't recolour the wordmark outside this palette.
- Don't add shadows, outlines or 3D effects.
- Don't place the logo on busy imagery without a backing.

## Voice

Lowercase by default, short, warm. A stray `c:` is welcome.

That applies to **brand-facing copy** — marketing text, customer-facing
material, a deck title. It does **not** apply to analysis, internal reports or
data commentary, which should stay in normal sentence case and be precise.
Don't lowercase a financial summary.

## Charts

- Single series: Scandi blue `#2BB7EE`.
- Two series: blue `#2BB7EE` and cyan `#22D3EE`.
- More than two: extend with neutrals rather than inventing new brand colours.
- Gridlines `#E6E8EB`, labels `#4B4F55`, titles `#0A0A0A`.
- No 3D, no drop shadows, no gradient fills on bars — the gradient is for
  surfaces, not data.

## Building the artefact

This skill supplies the look. The mechanics come from the format skills:
**`pptx`** for slides, **`docx`** for documents, **`xlsx`** for spreadsheets,
**`pdf`** for PDFs. Load the format skill for how, and keep this one open for
what it should look like.

Finished files go in `/home/app/output/` and are sent to the user with the
`whatsapp_send_file` tool. Working files stay in `/home/app/workspace/`.
