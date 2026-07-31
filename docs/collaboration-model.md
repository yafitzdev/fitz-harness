# Projects, sessions, transcripts, and tools

Projects are owner-scoped containers with optional host root paths. Sessions belong to projects and
can be active or archived. Under required authentication, users only see their own projects and
sessions; administrators can inspect all of them.

Pass `sessionId` when creating a native agent run to append its input messages, tool lifecycle, and
assembled assistant response to the session's ordered canonical transcript. Transcript sequence
numbers are allocated transactionally and can be paged with `after`.

Tool policy can be assigned to a role or a specific user. User policy overrides role policy, and a
missing rule resolves to `ask`. Approval requests become immediately approved or denied for an
explicit policy; otherwise they remain pending until the session owner or an administrator records
a decision. Pi tools remain disabled until the execution bridge can block on this approval service,
so no tool can run ahead of a pending decision in the current build.
