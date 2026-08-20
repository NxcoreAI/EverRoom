---
name: notion-sync
description: Normalize read-only Notion pages into EverRoom document records during connector synchronization. Use when the job service is notion and resourceType is document.
---

# Notion Sync

Use only read-only Notion actions and preserve the source pagination/checkpoint. Map each page to this schema:

```json
{"sourceRecordId":"string","documentId":"string","title":"string","ownerName":"string|null","documentType":"string|null","bodyText":"string","sourceUrl":"string|null","sourceUpdatedAt":"ISO-8601|string|null","extensionPayload":{}}
```

Preserve page title, readable enhanced Markdown body, properties, owner, document type, and source URL in the target fields or extensionPayload. Keep unknown blocks in source order using a loss-minimizing representation. Do not invent missing properties; quarantine pages that cannot be mapped reliably.
