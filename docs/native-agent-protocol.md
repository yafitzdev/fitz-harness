# Native agent protocol v1

Create a run with `POST /api/v1/agent/runs` using `model`, `messages`, and optional
`max_tokens`/`temperature` fields. The host returns `202` immediately and continues consuming the
inference stream if the client disconnects.

Run state is available from `GET /api/v1/agent/runs/:runId`. Events are monotonically sequenced per
run and retained in SQLite. Retrieve them as JSON from
`GET /api/v1/agent/runs/:runId/events?after=<sequence>`, or request `text/event-stream`. SSE clients
can reconnect with either the same `after` parameter or the standard `Last-Event-ID` header.

The v1 event vocabulary is `run.created`, `run.started`, `assistant.delta`, `reasoning.delta`,
`reasoning.completed`, `user.steer`, `tool.started`, `tool.completed`, `run.completed`, `run.failed`,
`run.cancelled`, and `run.interrupted`. Every envelope includes `protocolVersion`,
`runId`, `sequence`, and `timestamp`.

Reasoning (the model's thinking) is a first-class event stream, separate from chat text.
`reasoning.delta` (`data.text`) streams thinking tokens and `reasoning.completed` marks the end of a
thinking segment, which is emitted before the following `assistant.delta` or tool call. Clients render
reasoning as a collapsible activity row, never as a chat message. The host persists completed segments
in the canonical transcript under their own `reasoning` kind, so they are excluded when the session
context is rebuilt for subsequent model calls and are never echoed back to the model.

While a run is streaming, the composer stays unlocked so the user can steer it: `POST
/api/v1/agent/runs/:runId/steer` with a JSON body `{ "text": "..." }` queues the message into the
running conversation. The host forwards it to the active runtime, which delivers it after the current
turn finishes its tool calls and before the next model call. When the message is delivered, the host
emits a `user.steer` event (`data.text`) and appends a matching user message to the canonical
transcript, so clients can split the following `assistant.delta`s into a fresh bubble. Steer returns
`409` when the run is not currently streaming (queued, finished, or unsupported by the runtime) and
`400` for an empty `text`.

Delete a run resource to request cancellation. Under required authentication, non-administrators
can only list, inspect, replay, or cancel their own runs and may only start runs on granted routes.
