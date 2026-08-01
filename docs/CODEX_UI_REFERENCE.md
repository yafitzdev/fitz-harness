# Codex desktop UI reference

This is a read-only reverse-engineering record for the locally installed Codex desktop app. It keeps Fitz UI work tied to extracted values instead of screenshot guesses.

Inspected build: `OpenAI.Codex 26.721.4979.0`

Installed package: `C:\Program Files\WindowsApps\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0`

The packaged Electron `app.asar` was fully inventoried and extracted to a temporary directory outside this repository. Its webview contains 5,918 files (about 221 MB), including 4,504 JavaScript chunks (about 136 MB), 23 CSS files, fonts, SVG/PNG media, and WASM dependencies. No extracted Codex bundle, font, or asset is committed to Fitz.

Important inspected assets include:

- `webview/assets/app-BSNLQ2Yt.css`
- `webview/assets/app-initial-Cla-mNzi.css`
- `webview/assets/app-initial-BbEVL4-_.js`
- `webview/assets/local-conversation-page-BOQJ0r1u.js`
- `webview/assets/thread-app-shell-chrome-BWtCidYm.js`
- `webview/assets/composer-utility-bar-D8dX0auM.js`
- `webview/assets/header-DcAIMno5.js`
- `webview/assets/thread-overflow-menu-CGTAf-U0.js`
- `webview/assets/model-picker-power-slider-impl-DaJxEtnZ.js`

The archive contains production-compiled and minified code but no source maps. We can recover CSS, theme data, icon paths, component boundaries, user-facing strings, transitions, and substantial client behavior. We cannot reconstruct original TypeScript naming, comments, repository history, build-time sources, or private server implementation exactly.

## Extracted dark theme

The compiled theme object declares:

- Surface: `#181818`
- Ink: `#ffffff`
- Accent: `#339cff`
- Added/success: `#40c977`
- Removed/error: `#fa423e`
- Skill: `#ad7bf9`
- Opaque windows: `false`

The bundled gray scale includes `#ffffff`, `#f9f9f9`, `#ededed`, `#afafaf`, `#5d5d5d`, `#282828`, `#212121`, `#181818`, and `#0d0d0d`. The supplied Codex screenshot measures the sidebar/title-bar surface as `#1a2225`.

Electron's elevated dark control resolves to the measured `#323232` surface with real translucency. Fitz represents that as `rgba(51, 51, 51, .96)` over the base surface. This replaces the earlier guessed `rgba(54, 54, 54, .88)`.

## Exact geometry and motion

- Base spacing unit: `4px`
- Corner-radius scale: `1.25`
- Effective radii: `7.5px`, `10px`, `12.5px`, `15px`, `20px`, `25px`
- Multiline composer radius: `25px`
- Toolbar height: `46px`
- Sidebar target: `clamp(240px, 275px, min(520px, calc(100vw - 320px)))`
- Composer maximum width: `48rem` (`768px`)
- Large backdrop blur: `16px`; small menu blur: `4px`
- Basic transition: `150ms`
- Relaxed transition: `300ms`
- Snappy enter easing: `cubic-bezier(.23, 1, .32, 1)`
- General enter easing: `cubic-bezier(.19, 1, .22, 1)`

The installed prominent elevation is a half-pixel heavy ring followed by extremely light `0 3px 7.5px` and `0 0 20px` shadows. Menus use the half-pixel ring plus a restrained `0 8px 16px -4px` shadow. The much darker shadows previously used by Fitz were not faithful.

## Recovered component details

- Composer default: translucent input background, large backdrop blur, `25px` multiline radius, no CSS border, and prominent elevation.
- Regular menu: translucent dropdown background, `15px` radius, half-pixel ring, small backdrop blur, and XL shadow.
- Panel menu/card: `20px` radius, larger padding, large backdrop blur, and 2XL shadow.
- Sidebar row hover: 8% white overlay; selected rows use a stronger fog surface.
- Project/chat rows animate their expansion rather than snapping open.
- The project/location/branch utility rail is a separate top-tray surface above the composer. Its shell extends 12px beyond the composer on each side and uses a `25px` top radius.
- Activity preview enters with opacity and vertical translation using the snappy easing.
- `PanelLeft`, `PanelLeftOpen`, and `SquarePen` are Lucide icons. Fitz uses the exact extracted path geometry rather than hand-drawn approximations.
- OpenAI Sans Regular and Medium are bundled, but Fitz does not copy proprietary font files. It keeps the compatible system UI stack.

## Portability boundary

Fitz independently implements the visible interaction grammar and measured design values. It does not ship Codex's bundles, proprietary fonts, images, trademarks, private APIs, or server behavior. Hashes and chunk names will change between Codex releases, so this document records the inspected build number and should be refreshed deliberately after upgrades.
