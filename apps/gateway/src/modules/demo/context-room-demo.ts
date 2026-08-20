import type { TiptapJsonContent } from "@nxcore/agent-contract";
import { eq } from "drizzle-orm";

import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { contextRooms, gatewayMetadata } from "../../infrastructure/database/schema.js";
import type { DocumentService } from "../documents/service.js";

export const KNOWLEDGE_SPACE_ROOM_ID = "demo-knowledge-space-v1";
export const KNOWLEDGE_SPACE_OVERVIEW_DOCUMENT_ID = "demo-knowledge-space-overview-v1";
export const KNOWLEDGE_SPACE_FORMATS_DOCUMENT_ID = "demo-knowledge-space-formats-v1";

const SEED_KEY = "demo.context_room.knowledge_space_v1";
const SAMPLE_IMAGE = "https://raw.githubusercontent.com/NxcoreAI/Everroom/main/apps/desktop/src/renderer/public/icons/nexcore-logo.png";

function text(value: string, marks?: TiptapJsonContent["marks"]): TiptapJsonContent {
  return { type: "text", text: value, ...(marks ? { marks } : {}) };
}

function paragraph(...content: TiptapJsonContent[]): TiptapJsonContent {
  return { type: "paragraph", content };
}

function heading(level: 1 | 2 | 3, value: string): TiptapJsonContent {
  return { type: "heading", attrs: { level }, content: [text(value)] };
}

function listItem(value: string): TiptapJsonContent {
  return { type: "listItem", content: [paragraph(text(value))] };
}

function taskItem(value: string, checked: boolean): TiptapJsonContent {
  return { type: "taskItem", attrs: { checked }, content: [paragraph(text(value))] };
}

function tableCell(value: string, header = false): TiptapJsonContent {
  return { type: header ? "tableHeader" : "tableCell", content: [paragraph(text(value))] };
}

function tableRow(values: string[], header = false): TiptapJsonContent {
  return { type: "tableRow", content: values.map((value) => tableCell(value, header)) };
}

function projectOverviewContent(): TiptapJsonContent {
  const modules = [
    ["Home", "A focused dashboard for recent work, active Rooms, tasks, and system activity."],
    ["Context Room", "A workspace that brings documents, resources, memory, relationships, and Agent actions together around one subject."],
    ["Documents", "Structured, versioned documents with rich-text editing, block identity, exports, and reviewable Agent changes."],
    ["Reality", "Audio capture, transcription, summaries, action items, and visual perception organized on a time-based activity stream."],
    ["Sources and Files", "Local files, web material, evidence, and imported content that can be traced back to their original source."],
    ["Memory", "Conversation history, atomic memories, scenarios, and a long-term profile used to preserve useful context."],
    ["Wiki", "Room-scoped knowledge pages and graphs generated from connected documents and evidence."],
    ["Connectors", "Local synchronization and controlled actions for email, calendars, cloud documents, and developer tools."],
    ["Agent", "A context-aware assistant that can answer questions, inspect the workspace, use tools, and propose document changes."],
    ["Tasks and Diary", "Execution tracking plus a daily narrative assembled from documents, memory, meetings, and perception events."],
    ["Settings", "Language, account, model, memory, recording, privacy, connector, and local workspace controls."],
  ] as const;

  return {
    type: "doc",
    content: [
      paragraph(text("EverRoom is a local-first workspace for turning scattered context into durable knowledge and coordinated action.")),
      heading(2, "How the workspace fits together"),
      paragraph(text("Sources enter the workspace, Context Rooms organize them, Documents and Wiki pages make the knowledge editable, Memory preserves useful context, and Agent helps move work forward.")),
      heading(2, "Core modules"),
      ...modules.flatMap(([name, description]) => [heading(3, name), paragraph(text(description))]),
      heading(2, "A practical first workflow"),
      {
        type: "orderedList",
        content: [
          listItem("Open the Knowledge Space Room and review its documents."),
          listItem("Import a real source or create a document for an active project."),
          listItem("Ask Agent to summarize the context or propose the next actions."),
          listItem("Review generated changes before applying them to a document."),
        ],
      },
      heading(2, "Product principles"),
      {
        type: "bulletList",
        content: [
          listItem("Local-first by default, with explicit boundaries for external services."),
          listItem("Traceable knowledge that keeps links to documents, blocks, and source evidence."),
          listItem("Human review for meaningful edits and actions."),
          listItem("One coherent workspace instead of disconnected AI features."),
        ],
      },
    ],
  };
}

function formatShowcaseContent(overviewBlockId: string): TiptapJsonContent {
  return {
    type: "doc",
    content: [
      paragraph(text("This editable document showcases the formatting and block tools available in the EverRoom editor.")),
      heading(1, "Heading level 1"),
      heading(2, "Heading level 2"),
      heading(3, "Heading level 3"),
      paragraph(
        text("Inline styles: "),
        text("bold", [{ type: "bold" }]), text(", "),
        text("italic", [{ type: "italic" }]), text(", "),
        text("underline", [{ type: "underline" }]), text(", "),
        text("strikethrough", [{ type: "strike" }]), text(", and "),
        text("inline code", [{ type: "code" }]), text("."),
      ),
      paragraph(
        text("Links can point to "),
        text("the EverRoom repository", [{
          type: "link",
          attrs: { href: "https://github.com/NxcoreAI/Everroom", target: "_blank", rel: "noopener noreferrer" },
        }]),
        text(" or to specific blocks inside a Room."),
      ),
      heading(2, "Lists"),
      { type: "bulletList", content: [listItem("A bullet-list item"), listItem("A second item with a clear hierarchy")] },
      { type: "orderedList", attrs: { start: 1 }, content: [listItem("First ordered step"), listItem("Second ordered step")] },
      { type: "taskList", content: [taskItem("Completed task", true), taskItem("Open task", false)] },
      heading(2, "Quote and code"),
      { type: "blockquote", content: [paragraph(text("A useful workspace should make context easier to inspect, connect, and act on."))] },
      {
        type: "codeBlock",
        attrs: { language: "typescript" },
        content: [text("type Room = {\n  title: string\n  documents: Document[]\n}\n\nconst space: Room = { title: 'Knowledge Space', documents: [] }")],
      },
      { type: "horizontalRule" },
      heading(2, "Table"),
      {
        type: "table",
        content: [
          tableRow(["Tool", "Use", "Editable"], true),
          tableRow(["Headings", "Structure a document", "Yes"]),
          tableRow(["Tasks", "Track actionable work", "Yes"]),
          tableRow(["Tables", "Compare structured information", "Yes"]),
        ],
      },
      heading(2, "Image"),
      paragraph(text("Images support alternative text, replacement, resizing, and a full preview.")),
      { type: "image", attrs: { src: SAMPLE_IMAGE, alt: "Sample image block", title: "Sample image", width: 320, height: 96 } },
      heading(2, "Document block reference"),
      paragraph(text("References preserve a navigable connection to a specific block in another document.")),
      {
        type: "documentBlockReference",
        attrs: {
          targetRoomId: KNOWLEDGE_SPACE_ROOM_ID,
          targetDocumentId: KNOWLEDGE_SPACE_OVERVIEW_DOCUMENT_ID,
          targetBlockId: overviewBlockId,
          fallbackTitle: "EverRoom Product & Module Guide",
          fallbackPreview: "EverRoom is a local-first workspace for turning scattered context into durable knowledge and coordinated action.",
        },
      },
    ],
  };
}

function knowledgeSpaceRoomData(): Record<string, unknown> {
  return {
    id: KNOWLEDGE_SPACE_ROOM_ID,
    title: "Knowledge Space",
    kind: "主题",
    icon: "主题",
    tone: "zinc",
    status: "进行中",
    starred: true,
    lastViewed: "刚刚",
    roomCode: "KNOWLEDGE-SPACE",
    origin: "user",
    brief: {
      background: "A starter workspace for learning how EverRoom organizes knowledge, documents, and Agent-assisted work.",
      goal: "Explore the product through editable examples and reuse the Room as a personal knowledge space.",
      status: "Ready to explore.",
      risks: [],
      decisions: [],
    },
    stats: { docs: 2, mails: 0, meetings: 0, events: 0, memories: 0, tasks: 0 },
    riskCount: 0,
    pendingMemoryCount: 0,
    people: [],
    timeline: [],
    materials: [],
    actionItems: [],
    graphEdges: [],
    pendingMemoryItems: [],
    memoryItems: [],
    fileItems: [],
    recentSource: { type: "Document", name: "EverRoom Product & Module Guide" },
    nextReverseRecall: "After you add your own material",
    cloudDoc: {
      workspaceId: "local-demo",
      docId: KNOWLEDGE_SPACE_OVERVIEW_DOCUMENT_ID,
      title: "EverRoom Product & Module Guide",
    },
  };
}

export async function bootstrapKnowledgeSpaceDemo(
  db: GatewayDatabase,
  documents: DocumentService,
): Promise<boolean> {
  const seeded = db.select({ key: gatewayMetadata.key }).from(gatewayMetadata)
    .where(eq(gatewayMetadata.key, SEED_KEY)).get();
  if (seeded) return false;

  const now = new Date();
  db.insert(contextRooms).values({
    id: KNOWLEDGE_SPACE_ROOM_ID,
    title: "Knowledge Space",
    kind: "主题",
    data: knowledgeSpaceRoomData(),
    position: 0,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: contextRooms.id,
    set: { title: "Knowledge Space", kind: "主题", deletedAt: null, updatedAt: now },
  }).run();

  await documents.import({
    id: KNOWLEDGE_SPACE_OVERVIEW_DOCUMENT_ID,
    roomId: KNOWLEDGE_SPACE_ROOM_ID,
    title: "EverRoom Product & Module Guide",
    contentJson: projectOverviewContent(),
  });
  const overviewBlockId = documents.listBlocks(KNOWLEDGE_SPACE_OVERVIEW_DOCUMENT_ID)[0]?.blockId;
  if (!overviewBlockId) throw new Error("Knowledge Space overview has no addressable block");

  await documents.import({
    id: KNOWLEDGE_SPACE_FORMATS_DOCUMENT_ID,
    roomId: KNOWLEDGE_SPACE_ROOM_ID,
    title: "Document Formatting & Tools Showcase",
    contentJson: formatShowcaseContent(overviewBlockId),
  });

  db.insert(gatewayMetadata).values({ key: SEED_KEY, value: "complete", updatedAt: now })
    .onConflictDoUpdate({ target: gatewayMetadata.key, set: { value: "complete", updatedAt: now } }).run();
  return true;
}
