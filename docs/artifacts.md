# Artifacts and media

Artifacts belong to sessions and carry a name, normalized MIME type, renderer kind, byte size,
SHA-256 digest, creator, timestamp, and JSON metadata. The initial SQLite-backed content limit is
1.5 MB per artifact; larger artifact storage can move behind the same repository contract later.

Content responses always use attachment disposition, `X-Content-Type-Options: nosniff`, and a
sandboxing content security policy. The renderer registry allows PNG/JPEG/GIF/WebP, a small audio and
video set, PDF, and text/code. SVG and unrecognized formats are classified as binary and are not
previewed. Text and HTML-like content is inserted with `textContent`, never as markup. PDF uses an
iframe with an empty sandbox, and media content reaches the renderer as base64 through the narrow
main-process bridge rather than through direct renderer networking.

The desktop artifact panel lists the current task's artifacts, supports bounded file upload, and
previews only the server-assigned renderer kind.
