# Source provenance

Vibeinator adopts [Synara](https://github.com/Emanuele-web04/synara) at commit `3e72c70af1f9bfe1fdf3eeafd7fa9e0ba0d5f3b4` (2 November 2026). This is an owned baseline; ongoing upstream merges are not planned.

The original MIT [LICENSE](LICENSE), source copyright notices, dependency patches, lockfile, and [upstream README](docs/upstream/SYNARA-README.md) are retained. The original README's relative links refer to the upstream checkout. Historical Synara documentation, changelogs, assets, and attribution are retained as reference; the Vibeinator README and implementation tracker describe this fork's current product and commands.

Imported runtime packages: Electron host, embedded React renderer, private backend, contracts, shared utilities, and build/test scripts. The standalone `apps/marketing` website, upstream workflow automation, selected operator instructions/work plans, and local audit/dependency artifacts are excluded. A desktop verification workflow on Windows and Linux replaces the upstream workflows; there is no automated release publication.

Vibeinator changes the app display name, app protocol, bundle identity, Electron profile directories, backend home environment/defaults, and Windows installer GUIDs. Internal `@synara/*` imports, storage keys, and most implementation names remain deliberately unchanged. Existing artwork and inherited in-app copy still include Synara branding; a complete visual rebrand is outside this adoption step.

Builds contain no update feed unless `VIBEINATOR_UPDATE_REPOSITORY=owner/repository` is explicitly set. Neither `GITHUB_REPOSITORY` nor Synara's update repository environment variable supplies a default. Keep this unset until an owned feed has been qualified. The inherited Beta installer is disabled at the desktop entry point.

The adoption merge preserves Vibeinator's original history and the pinned upstream commit's ancestry (4,812 commits). Only the pinned revision is adopted; fetched tags and the source reference are provenance, not an upstream synchronization policy. The local audit clone remains ignored and is not required to install, build, or run this repository.
