# Canonical configuration

Every non-secret operational setting lives in `%LOCALAPPDATA%\Fitz Harness\fitz.config.json`. The
versioned document is schema-validated, written atomically, watched for external edits, and exposed
to administrators through read, validate, and patch APIs plus the Hosting Advanced editor.

Top-level domains are `hosting`, `defaults`, `users`, `storage`, `interface`, `inference`, and the
extensible `settings` object. `defaults.route` and `defaults.effort` are applied to every new chat.
Legacy scalar SQLite settings migrate on first creation.

The inference registry is intentionally not configurable in this document. `FITZ_LLM_ROOT` selects
one persistent machine-level registry at process startup; engine, environment, and model roots are
derived beneath it. Historical `engineRoot` settings are accepted during parsing and discarded.

Secrets are rejected recursively from the JSON document. Authentication material stays hashed in
SQLite or encrypted with OS-backed Electron storage. Users, API keys, projects, chats, usage,
provider connections, and route bindings are runtime records rather than settings and remain in
SQLite/secure storage. This separation lets an LLM inspect or patch one JSON file for app setup
without exposing credentials or corrupting historical data.
