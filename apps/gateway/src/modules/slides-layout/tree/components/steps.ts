/**
 * steps 组件：STEP 序号微标签 + 标题 + 正文，步骤之间用强调色轨道连接（表达顺序）。
 * 无底面语义：默认直接落在页面上（不铺底、不画卡），只有 agent 显式写
 * style.surface 时才铺底——避免「白卡里飘着一条小字」。
 *
 * 版面：每列 STEP 标签 → 标题 → 正文紧凑顶对齐；连接轨道压在 STEP 标签行高上，
 * 落点小圆点标记每步起点。所有字号/间距来自 skin.metrics，颜色只取 ComponentSkin。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, textBoxHeight } from "../../text-metrics.js";

export interface StepItem {
  title: string;
  text?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandSteps(
  items: StepItem[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
  connector: "line" | "gap" | "none" = "line",
): SpecElement[] {
  void theme;
  const cells = splitColumns(frame, items.length, skin.looseGap);
  const boxes = cells.map((cell) => (skin.surfaceExplicit ? skin.contentBox(cell) : cell));
  const elements: SpecElement[] = skin.surfaceExplicit
    ? [...cells.flatMap((cell) => skin.paint(cell)), ...skin.motifDecor(frame, "corner")]
    : [];

  const m = skin.metrics(boxes[0]!);
  const titleSize = m.title;
  const bodySize = m.body;
  const labelH = Math.round(estimateLineHeight(m.label));
  const labelGap = Math.max(10, Math.round(m.tightGap * 0.8));
  const titleGap = Math.max(10, Math.round(m.tightGap * 0.9));
  const align = skin.alignExplicit ? skin.paragraphAlign : "left";

  items.forEach((item, index) => {
    const box = boxes[index]!;
    const titleH = textBoxHeight(item.title, titleSize, box.w);
    const bodyH = item.text ? textBoxHeight(item.text, bodySize, box.w) : 0;
    const need = labelH + labelGap + titleH + (bodyH ? titleGap + bodyH : 0);
    if (need > box.h) {
      bad(`${what}「${item.title.slice(0, 12)}」内容高约 ${Math.round(need)}px 超过 ${Math.round(box.h)}px——精简标题/说明或减少步骤`);
    }
    elements.push(
      textElement({ x: box.x, y: box.y, w: box.w, h: labelH }, [
        { runs: [skin.micro(`STEP ${String(index + 1).padStart(2, "0")}`, skin.colors.muted)], align },
      ]),
    );
    const titleY = box.y + labelH + labelGap;
    elements.push(
      textElement({ x: box.x, y: titleY, w: box.w, h: titleH }, [
        { runs: skin.heading(item.title, titleSize, skin.colors.text), align },
      ]),
    );
    if (item.text) {
      elements.push(
        textElement({ x: box.x, y: titleY + titleH + titleGap, w: box.w, h: bodyH }, [
          { runs: skin.body(item.text, bodySize, skin.colors.muted), align },
        ]),
      );
    }
    // 步骤轨道：强调色横线沿 STEP 标签行连接相邻步骤，落点小圆点标记每步起点。
    if (index > 0 && connector === "line") {
      const trackY = Math.round(box.y + labelH / 2 - 1);
      elements.push({
        type: "shape", shape: "rect", fill: skin.colors.emphasis,
        x: Math.round(box.x - skin.looseGap), y: trackY, w: Math.round(skin.looseGap), h: 2,
      });
      const dot = 8;
      elements.push({
        type: "shape", shape: "ellipse", fill: skin.colors.emphasis,
        x: Math.round(box.x - dot / 2), y: Math.round(box.y + labelH / 2 - dot / 2), w: dot, h: dot,
      });
    }
  });
  return elements;
}
