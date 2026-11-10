# 参考 deck 输入（非单一 PDF）

## 用户怎么给

1. 把参考图/PDF/PPTX 直接拖进对话区，或给出本地路径。
2. 主 Agent 拿到附件后，把路径列表传给 `slides_draft` 的 `referencePaths`：

```json
{
  "task": "draft",
  "instruction": "对标这些参考页，20 页，深蓝品牌，保留团队/市场/产品/竞品/技术/财务/路线图/融资",
  "referencePaths": [
    "/Users/.../Nexwing Personal aircraft BP.pdf",
    "/Users/.../ref-cover.png",
    "/Users/.../ref-product.jpg"
  ],
  "targetPages": 20
}
```

支持：

- `.pdf`：逐页渲染；
- `.pptx/.ppt`：LibreOffice 转 PDF 后逐页渲染；
- `.png/.jpg/.jpeg/.webp/.gif/.bmp`：单张或混合传入；
- 最多 12 个文件，可同一批混传。

## Agent 的主观能动性

- `referencePaths` 是**可选提示**，不是强制模板；Agent 可以只取参考的色板/密度，也可以结合多张图。
- 单张/少量参考图只抽色板、明暗、密度，不生成章节大纲；4 页以上才用参考页标题做 `referenceOutline`。
- Agent 也可以不传文件，直接传 `referenceStyle`/`referenceOutline`/`targetPages`，或完全不使用参考。

## 抽取结果

`analyzeReferenceFiles` 返回 `reference-style/v1`：palette、density、darkCover、composition、pageBudget、逐页视觉摘要。随后：

- planner 按参考页数/章节补全；
- styler 按参考色板/密度出风格卡；
- generate 时参考 palette 覆盖风格卡 palette，字体/间距仍沿用风格卡。

## 限制

- 拖进来的如果是**屏幕照片**，会影响色板/密度统计；Agent 可以只用它做风格提示，或让用户补 2~3 张清晰页。
- PPTX 参考需要本机 LibreOffice；PDF/图片不需要。
- 参考图只提供视觉方向，不复制其内容；内容仍由 Room 草稿与用户指令决定。
