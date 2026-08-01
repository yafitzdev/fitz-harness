# Codex desktop UI reference

This reference records the useful design facts recovered read-only from the locally installed Codex desktop package. It exists so future Fitz UI work can use measured values instead of screenshot guesses.

Inspected build: `OpenAI.Codex 26.721.4979.0`

Inspected assets inside `app.asar`:

- `webview/assets/app-BSNLQ2Yt.css`
- `webview/assets/app-initial-Cla-mNzi.css`
- `webview/assets/app-initial-BbEVL4-_.js`

No Codex bundle or extracted asset is committed to Fitz. The repo contains only independently implemented CSS using the measured public-facing geometry, palette values, and SVG path shapes needed for compatible controls.

## Dark theme

- Base surface: `#181818`
- Elevated surfaces: `#212121`, `#282828`, and `#303030`
- Ink: `#ffffff`
- Secondary ink: 70% white
- Tertiary ink: 50% white
- Border: 8% white
- Heavy border: 16% white
- Accent: `#339cff`
- Success: `#40c977`
- Warning: `#ff8549`
- Error: `#fa423e`
- Skill: `#ad7bf9`

## Geometry and type

- Base spacing unit: `4px`
- Body text: `14px`
- Small text: `12px`
- Extra-small text: `11px`
- Home heading: `28px`, normal weight, 1.2 line height
- Default sidebar target: `275px`; runtime resize bounds are 200–720px
- Composer button: `28px`
- Multiline composer radius: `20px`
- Single-line composer radius: `22px`
- User message: at most 77% wide, `12px 8px` padding, `16px` radius
- Standard transitions: 150ms; hero enter is 280ms and exit is 180ms

## Component behavior

- The composer is a translucent control surface with a half-pixel heavy ring and a restrained medium shadow.
- Menus and hover cards use elevated translucent surfaces, a half-pixel ring, and backdrop blur.
- The project/location/branch utility rail is a separate surface above the composer; it does not occupy or cover the input area.
- Activity rows use 20px icon slots and muted 70% ink. Command, edit, generic-tool, and context-compaction rows have distinct SVG symbols.
- The home project heading and starter content fade between states instead of being left behind once a chat starts.
