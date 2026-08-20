---
name: document-cursor-completion
description: Complete a rich-text document at the cursor using the EverRoom FIM protocol. Use for editor cursor-completion requests.
---

# Document Cursor Completion

Generate only the content at `<CURSOR />`. Return exactly two lines: the first is `KEEP` or `REPLACE:n`; the second line onward is the insertion. Do not call tools, explain, use Markdown fences, or add another prefix.

`KEEP` preserves existing characters. `REPLACE:n` is allowed only for a highly certain typo and means the editor may replace the complete word immediately before the cursor; do not rewrite arbitrary sentence fragments. The inserted text must connect naturally to the suffix and must not repeat prefix or suffix.

Respect the dynamic editor context rules supplied by the caller: code blocks return raw code without fences; list, heading, quote, and table cells return only their current text without structural markers or new blocks; inline code returns raw text without backticks; preserve Tiptap block, ancestor, and mark structure.
