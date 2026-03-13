# Changelog

All notable changes to Owly are documented in this file.

## [1.3.0] - 2026-03-13

Initial public Owly release.

### Added

- Participant-first conference layouts for desktop and mobile
- Shared screen focus mode and browser fullscreen support
- Mobile selfie preview with drag, collapse, and edge docking
- Per-user volume controls and participant presence indicators
- Built-in chat, reactions, and invite sharing
- Optional camera filters and background effects
- Best-effort audio output selection where the browser supports it
- Frontend, backend, security, and smoke test coverage
- Example Helm chart for Kubernetes deployment

### Improved

- Refined mobile viewport handling for modern browser chrome and safe areas
- Faster stale participant cleanup in conference UI
- Updated README, screenshots, and project metadata for Owly
- Cleaner Docker build context via `.dockerignore`

### Fixed

- Shared screen focus/fullscreen behavior across desktop and mobile
- Selfie preview persistence, drag, and collapse edge cases
- Participant tile duplication and stale `Connecting` placeholders
- Focus-mode controls and overlay collisions
- Mobile page scroll and horizontal overflow issues
