# Native agent protocol v1

Create a run with `POST /api/v1/agent/runs` using `model`, `messages`, and optional
`max_tokens`/`temperature` fields. The host returns `202` immediately and continues consuming the
inference stream if the client disconnects.

Run state is available from `GET /api/v1/agent/runs/:runId`. Events are monotonically sequenced per
run and retained in SQLite. Retrieve them as JSON from
`GET /api/v1/agent/runs/:runId/events?after=<sequence>`, or request `text/event-stream`. SSE clients
can reconnect with either the same `after` parameter or the standard `Last-Event-ID` header.

The v1 event vocabulary is `run.created`, `run.started`, `assistant.delta`, `tool.started`,
`tool.completed`, `run.completed`, `run.failed`, `run.cancelled`, and `run.interrupted`. Every envelope includes `protocolVersion`,
`runId`, `sequence`, and `timestamp`.

Delete a run resource to request cancellation. Under required authentication, non-administrators
can only list, inspect, replay, or cancel their own runs and may only start runs on granted routes.
