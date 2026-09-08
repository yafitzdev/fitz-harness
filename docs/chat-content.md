# Chat content documents

Every durable text message keeps its canonical source in `content.text` and a versioned block index in
`content.document`. The block index is an ordered `ChatContentDocument`; its ranges point into the
canonical text instead of copying response bodies. Older transcript rows remain valid because the
desktop derives the same document from `content.text` when the index is missing or invalid.

Version 1 recognizes these block types:

| Block | Source form | Desktop presentation |
| --- | --- | --- |
| `markdown` | prose, lists, quotes, links | formatted prose |
| `code` | fenced code | highlighted source with copy action |
| `diff` | `diff` or `patch` fence | highlighted patch |
| `table` | GFM pipe table | bounded, horizontally scrollable table |
| `diagram` | `mermaid` fence | rendered Mermaid SVG with source disclosure |
| `math` | `$$` block | KaTeX MathML |
| `image` | standalone Markdown image | inline image |
| `media` | standalone audio or video link | native player |
| `file` | standalone local or `artifact://` link | file card that opens the Inspector |
| `interactive` | standalone HTML link | preview card that opens the sandboxed Inspector |

Content blocks and artifacts have different jobs. A content block owns message order and
presentation. An artifact owns durable bytes, MIME classification, integrity metadata, access
control, and lifetime. Image, media, file, and interactive blocks can reference an artifact without
embedding its bytes in the transcript.

Every chat owns a durable scratch workspace under the Fitz data directory. Project chats keep the
project root as their code working directory and use the session workspace for chat-owned output;
the Inspector resolves files from both. Standalone chats use the session workspace as their working
directory. The scratch workspace stays attached across app restarts without appearing as a sidebar
project.

Live output and session replay use the same parser and renderer. Block IDs derive from the source
offset at which a block begins. The desktop reconciles those IDs while deltas arrive, so completed
code, media, table, diagram, and math nodes remain mounted while the final block changes. This keeps
playback state, selection, and rendered diagrams stable during streaming.

Rich rendering is progressive. A failed diagram or equation exposes its source. Missing media offers
an open-source action. Mermaid runs in strict mode and its generated SVG is filtered for scripts,
event handlers, and JavaScript links. Interactive HTML is rendered only by the Inspector's sandboxed
frame. Unknown content continues to render as ordinary Markdown.
