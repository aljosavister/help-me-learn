# TODO

## Roadmap
- Phase 1: OAuth login (Google first), replace manual user select with session user.
- Phase 1: Ensure "My collections" uses session user only; public/unlisted remain visible.
- Phase 1: Add user level/role field to control moderation permissions.
- Phase 1: Add admin UI to set user levels.
- Phase 2: Add proposal workflow for item edits (pending/approved/rejected) + review UI.
- Phase 2: Public author/profile pages + collection search/filter.
- Phase 3: Class code UX (copy code, open as anon), optional roster view.
- Phase 4: Fork/clone collection versions with attribution.
- Phase 4: Moderation + licensing + reporting flow.

## Open Decisions
- Item ownership: global shared items vs per-user private items (and how CSV import behaves).
- Anonymous progress: keep localStorage only or add lightweight server store.

## Collections UI
- Add search and filters for items (e.g., A1/A2, topic, grammar tags).
- Add quick-select presets and live selected-item counter.
- Add version preview with empty-state warnings.
- Add buttons for copy code and open as anonymous.
- Add version comparison (diff + short changelog).
- Add validation for empty/too-short titles and descriptions.
