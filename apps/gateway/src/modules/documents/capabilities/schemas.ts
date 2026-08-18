export const EMPTY_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export const PATCH_TARGET_SCHEMA = {
  oneOf: [
    {
      type: "object", additionalProperties: false,
      properties: { at: { const: "end" } }, required: ["at"],
    },
    {
      type: "object", additionalProperties: false,
      properties: { blockId: { type: "string" }, edge: { enum: ["before", "after"] } },
      required: ["blockId", "edge"],
    },
    {
      type: "object", additionalProperties: false,
      properties: {
        blockId: { type: "string" },
        fromOffset: { type: "integer", minimum: 0 },
        toOffset: { type: "integer", minimum: 0 },
      },
      required: ["blockId"],
    },
    {
      type: "object", additionalProperties: false,
      properties: { fromBlockId: { type: "string" }, toBlockId: { type: "string" } },
      required: ["fromBlockId", "toBlockId"],
    },
  ],
} as const;
