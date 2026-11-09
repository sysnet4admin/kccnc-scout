# Session times

Session data comes from the official KubeCon + CloudNativeCon North America 2026 schedule
(Sessionize JSON). Its `startsAt` and `endsAt` values are venue-local times without an
offset, for example `2026-11-10T17:30:00`. The venue is in Salt Lake City, time zone
America/Denver, which is MST (UTC-7) for the whole event, Nov 9-13 2026.
CI runners and the app's containers run in UTC.

For new or changed code under `app/` that parses, stores, compares or renders a session time:

- Never pass an offset-less schedule time straight to `new Date()` or `Date.parse()`.
  It is read in the runtime's local zone, which is UTC in CI and in the container,
  so every time shifts by 7 hours.
- Store times as ISO 8601 with the venue offset (`-07:00`), or convert them with an
  explicit `America/Denver` time zone before creating a `Date`.
- Elasticsearch range queries on session times (for example "starts in the next 30 minutes")
  pass `time_zone: "America/Denver"` or compare against values that carry the offset.
- Times shown to attendees are formatted with `timeZone: 'America/Denver'` and labeled MST.
- Sessions that have already ended are never recommended. "Now" is the current instant,
  compared against offset-aware session times.

Tests that cover time handling should pass no matter what time zone the test process runs in.

Report a blocking finding when any of these is broken.
