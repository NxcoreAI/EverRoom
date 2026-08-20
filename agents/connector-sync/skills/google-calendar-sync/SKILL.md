---
name: google-calendar-sync
description: Normalize read-only Google Calendar events into EverRoom calendar records during connector synchronization. Use when the job service is google_calendar and resourceType is calendar.
---

# Google Calendar Sync

Use only read-only Google Calendar actions and preserve the source pagination/checkpoint. Map each event to this schema:

```json
{"sourceRecordId":"string","eventId":"string","title":"string","description":"string","organizer":{"name":"string?","address":"string?"},"attendees":[{"name":"string?","address":"string?","status":"string?"}],"startAt":"ISO-8601|string|null","endAt":"ISO-8601|string|null","allDay":false,"status":"string|null","location":"string|null","sourceUpdatedAt":"ISO-8601|string|null","extensionPayload":{}}
```

Preserve timezone semantics for start and end values, organizer and attendee response status, all-day state, event status, and location. Do not convert an unknown timezone or missing participant into a guess; quarantine records that fail reliable normalization.
