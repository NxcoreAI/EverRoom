---
name: gmail-sync
description: Normalize read-only Gmail messages into EverRoom email records during connector synchronization. Use when the job service is gmail and resourceType is email.
---

# Gmail Sync

Use only read-only Gmail actions and preserve the source pagination/checkpoint. Map each message to this schema:

```json
{"sourceRecordId":"string","messageId":"string","threadId":"string|null","senderName":"string|null","senderAddress":"string|null","recipients":[{"name":"string?","address":"string"}],"subject":"string","sentAt":"ISO-8601|string|null","bodyText":"string","labels":["string"],"hasAttachments":true,"sourceUpdatedAt":"ISO-8601|string|null","extensionPayload":{}}
```

Prefer plain text when Gmail exposes both text and HTML. Keep sender, recipients, subject, labels, attachment presence, thread identity, and source timestamps. Do not infer headers or body text. If a message cannot be mapped reliably, quarantine the original record instead of guessing or dropping it.
