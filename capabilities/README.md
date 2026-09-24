# capabilities/

Capability artifacts, app profiles, and tenant overlays: the data `/automation` loads
and validates at runtime (see `automation/schema/loader.ts`). Nothing in this directory
is code; everything here is authored, human-reviewed configuration.

## Provenance

`fake-credit-union-console.app-profile.json` and `fake-credit-union-console.beta.tenant-overlay.json`
were authored from **observing target-app's rendered output**, driving the running app
with a real browser and reading what it actually displays, never from reading
`target-app`'s source code. This matters: a real app profile for an actual bank product
could only ever be authored this way, since the vendor's source would never be available.

The observation supporting the app profile is saved as evidence, not just asserted:
`evidence/app-profile-verification/` has the raw `ariaSnapshot()` capture for every
outcome and recovery this profile declares, plus a signal-by-signal comparison against
the JSON. See also `evidence/accessibility-snapshot-spike/` for the earlier, broader
perception spike from `/automation`'s Phase 2.
