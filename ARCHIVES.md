# Portable projects and export history

## Archive, restore and relink

The editor's **Editing workflows → Project files and archives** panel detects offline or changed media, relinks a source while preserving clip IDs and edits, consolidates linked sources into verified managed files, and exports a portable `.mcpstudio` archive. Consolidation runs as a cancellable background job; `queue_media_consolidation` exposes the same workflow to MCP while the existing synchronous tool remains available. Cancellation leaves canonical project links unchanged until the final revision commit; already verified content-addressed copies may remain available for reuse. The project chooser imports an archive into a new directory. Custom locations remain in the editor URL across reloads.

`export_project_archive` and `import_project_archive` queue jobs and return `job.id` plus `operationId`. Poll `get_job`; its completed `result` contains the output or imported project. Use `cancel_job` to request cancellation. `list_archive_operations` reports completed, cancelled, failed and interrupted operations. `inspect_project_archive` previews the bounded manifest and migration before import; inspection alone is not a full media checksum verification.

Archives include a project snapshot and checksummed managed copies of every referenced media asset, including linked sources and imported fonts. A changed linked file must be relinked before consolidation or archival. Import verifies every checksum and portable path, rejects existing destinations and starts fresh undo history. Limits: 20GiB payload, 16MiB manifest and10,000files. Render caches, installation export-history records and prior undo transactions are not included.

Archive jobs persist under `VIDEO_STUDIO_DATA_DIR/archive-operations`. Cancellation remains running until staging cleanup finishes. Once atomic publication begins, cancellation waits for the publication result. A restart removes only the dead operation's recorded UUID staging, preserves any published destination and marks the operation interrupted. Inspect that destination before explicitly retrying; the server does not guess whether to overwrite it.

## Saved exports and reproduction

Every `render_sequence` export pins the project revision when queued. Export history stores the full project snapshot, selected sequence and preset, actual input/font SHA-256 hashes, output checksum/size, Node platform, FFmpeg build information and the executing application module hash. The installed bundled CLI hash identifies its complete application bundle; development source runs hash the provenance module and do not certify an entire source checkout.

In **Export → Export history**, refresh and select an export to inspect checksums, download its snapshot, or reproduce it to another output path. MCP offers `list_export_history`, `get_export_history` and `reproduce_export`. Reproduction uses the saved snapshot without changing the current project and rejects changed input hashes or rendering environments. It supports cached and fresh rendering, including nested sequences. Same-build repeatability does not promise bit-identical output after a platform or codec upgrade.

History is stored under `VIDEO_STUDIO_DATA_DIR/render-operations`; back up that directory together with the project and source media if retaining reproducibility matters. Listing returns the latest100 summaries. Each history snapshot is bounded to16MiB; move old records before reaching10,000entries. A downloaded history record is evidence, not an executable import format. Provider credentials are not stored in project snapshots.

Output is rendered into an owned scratch directory, verified and copied to a same-directory temporary. A durable ready receipt precedes the atomic rename. Cancellation before commit preserves an existing export. If a process dies after the rename but before final confirmation, restart verifies the published checksum and reconciles the ready receipt; otherwise it marks the operation interrupted. It removes only that operation's owned temporary and scratch paths. A post-publication journal write failure is returned as `publication-confirmation-pending`, never falsely reported as a cancelled export. Project-internal exports must be under `exports/`, and source assets cannot be overwritten.

## Acceptance evidence

The repository exercises actual modern and legacy MCP, the built stdio CLI, Chromium editor workflows with accessibility checks, real FFmpeg nested/cached snapshot reproduction, source/engine mismatch, cancellation settlement and commit boundaries. A128MiB fixture hard-stops the actual MCP process during both archive export and import, restarts it and verifies recovery and source/output preservation. External provider generation remains a separate credential-backed live check.
