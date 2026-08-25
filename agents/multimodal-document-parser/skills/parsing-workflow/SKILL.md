---
name: parsing-workflow
description: Parse and validate one authorized Office or PDF file version without overstating unsupported multimodal coverage.
---

# Parsing Workflow

1. Run `document_parse_native` with the exact granted identifiers.
2. If and only if `privacyPolicy` is `external_vlm_allowed` and the format is PDF, run `document_analyze_visuals` for every page with the exact granted identifiers and policy. Never send `local_only` content to the VLM.
3. Run `document_validate_artifact` for the same file version.
4. Run `document_read_content` and answer the caller's question from that content. Use `document_read_artifact` only when validation issues or the caller's requested outputs require block/table inspection.
5. Treat remaining warnings as real capability gaps. VLM OCR is probabilistic evidence and does not replace native evidence when native text exists.
6. Return a grounded summary together with the artifact identity, measured counts, validation result, warnings, and quality status. Never infer that a missing stage succeeded.
