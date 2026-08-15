# Canonical configuration

Every non-secret operational setting lives in `%LOCALAPPDATA%\Fitz Codex\fitz.config.json`. The
versioned document is schema-validated, written atomically, watched for external edits, and exposed
to administrators through read, validate, and patch APIs plus the Hosting Advanced editor.

Top-level domains are `hosting`, `defaults`, `users`, `storage`, `interface`, `inference`, and the
extensible `settings` object. `defaults.route` and `defaults.effort` are applied to every new chat.
Legacy scalar SQLite settings migrate on first creation.

Secrets are rejected recursively from the JSON document. Authentication material stays hashed in
SQLite or encrypted with OS-backed Electron storage. Users, API keys, projects, chats, usage,
provider connections, and route bindings are runtime records rather than settings and remain in
SQLite/secure storage. This separation lets an LLM inspect or patch one JSON file for app setup
without exposing credentials or corrupting historical data.
