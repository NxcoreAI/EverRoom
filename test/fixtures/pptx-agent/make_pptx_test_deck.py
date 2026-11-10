"""生成 PPT Agent 测试夹具：一套结构可预期、每页都带"可测工件"的 9 页演示文稿。

设计目标（对应 docs/pptx-agent-test-cases.zh-CN.md）：
- 页结构固定：封面 / 目录 / 关键指标 / 表格 / 图表 / 双标题歧义页 / 长文本页 / 隐藏页 / 结束页
- 每页都有明确可核对的基线：文本内容、表格数值、形状位置与尺寸（英寸）
- 覆盖测试需要的特殊工件：表格、图表、图片、圆角矩形、箭头、连接线、演讲者备注、隐藏页、双标题

重新生成：
    python3 test/fixtures/pptx-agent/make_pptx_test_deck.py
"""

from __future__ import annotations

from pathlib import Path

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.util import Emu, Inches, Pt

OUT = Path(__file__).with_name("PPT测试_2026年Q3经营回顾.pptx")

# 16:9 宽屏：13.333in × 7.5in
SLIDE_W = Inches(13.333)
SLIDE_H = Inches(7.5)

INK = RGBColor(0x1F, 0x29, 0x37)
MUTED = RGBColor(0x5B, 0x66, 0x77)
ACCENT = RGBColor(0x1F, 0x4E, 0x79)
ACCENT_SOFT = RGBColor(0xE8, 0xF0, 0xF8)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
GRID = RGBColor(0xD5, 0xDD, 0xE6)


def inches(value: float) -> Emu:
    return Inches(value)


def add_textbox(slide, left, top, width, height, text, *, size=18, bold=False,
                color=INK, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, name=None):
    box = slide.shapes.add_textbox(inches(left), inches(top), inches(width), inches(height))
    if name:
        box.name = name
    frame = box.text_frame
    frame.word_wrap = True
    frame.vertical_anchor = anchor
    paragraph = frame.paragraphs[0]
    paragraph.alignment = align
    run = paragraph.add_run()
    run.text = text
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    run.font.name = "Microsoft YaHei"
    return box


def add_title(slide, text, *, top=0.45, size=32):
    return add_textbox(slide, 0.75, top, 11.8, 0.9, text, size=size, bold=True, color=INK,
                       name="页面标题")


def add_rect(slide, left, top, width, height, fill, *, shape=MSO_SHAPE.RECTANGLE, name=None,
             line=None):
    rect = slide.shapes.add_shape(shape, inches(left), inches(top), inches(width), inches(height))
    rect.fill.solid()
    rect.fill.fore_color.rgb = fill
    if line is None:
        rect.line.fill.background()
    else:
        rect.line.color.rgb = line
        rect.line.width = Pt(1)
    if name:
        rect.name = name
    rect.text_frame.text = ""
    return rect


def build() -> Presentation:
    prs = Presentation()
    prs.slide_width = SLIDE_W
    prs.slide_height = SLIDE_H
    blank = prs.slide_layouts[6]

    # ── 第 1 页：封面（带背景色 + 装饰横条，用于 PP-S-01 / PP-S-02 / PP-T-01）──
    s1 = prs.slides.add_slide(blank)
    background = s1.background.fill
    background.solid()
    background.fore_color.rgb = ACCENT_SOFT
    add_textbox(s1, 1.0, 2.3, 11.3, 1.2, "2026 年第三季度经营回顾", size=44, bold=True,
                color=INK, name="封面标题")
    add_textbox(s1, 1.0, 3.7, 11.3, 0.8, "Fiscal Year 2026 · 内部资料", size=20, color=MUTED,
                name="封面副标题")
    add_rect(s1, 1.0, 4.75, 3.2, 0.12, ACCENT, name="封面装饰条")
    s1.notes_slide.notes_text_frame.text = "封面备注：本页用于测试标题/副标题编辑、背景色与装饰元素。"

    # ── 第 2 页：目录（标题 + 三条列表，用于 PP-T-02 / PP-T-06 / PP-S-04）──
    s2 = prs.slides.add_slide(blank)
    add_title(s2, "目录")
    agenda_items = ["一、业绩概览", "二、产品进展", "三、下季度规划"]
    for index, item in enumerate(agenda_items):
        add_textbox(s2, 1.4, 1.9 + index * 1.05, 10.5, 0.8, item, size=24, color=INK,
                    name=f"目录第{index + 1}条")
    s2.notes_slide.notes_text_frame.text = "目录备注：三条列表用于测试字号统一、项目符号与行距。"

    # ── 第 3 页：关键指标（标题 + 4 张指标卡 + 箭头，用于 PP-S-05/06、PP-E-01/02/04）──
    s3 = prs.slides.add_slide(blank)
    add_title(s3, "关键指标")
    metrics = [
        ("营业收入", "3.05 亿", "+18%"),
        ("毛利率", "42.6%", "+2.1pt"),
        ("新增客户", "1,286", "+9%"),
        ("交付准时率", "96.4%", "+0.8pt"),
    ]
    for index, (label, value, delta) in enumerate(metrics):
        left = 0.9 + index * 3.0
        card = add_rect(s3, left, 1.75, 2.7, 1.75, WHITE, shape=MSO_SHAPE.ROUNDED_RECTANGLE,
                        name=f"指标卡{index + 1}", line=GRID)
        card.adjustments[0] = 0.08
        add_textbox(s3, left + 0.22, 1.95, 2.3, 0.5, label, size=15, color=MUTED,
                    name=f"指标名称{index + 1}")
        add_textbox(s3, left + 0.22, 2.35, 2.3, 0.7, value, size=30, bold=True, color=INK,
                    name=f"指标数值{index + 1}")
        add_textbox(s3, left + 0.22, 3.02, 2.3, 0.4, delta, size=14, color=ACCENT,
                    name=f"指标变化{index + 1}")
    arrow = s3.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, inches(0.9), inches(4.0), inches(1.6),
                                inches(0.6))
    arrow.name = "指示箭头"
    arrow.fill.solid()
    arrow.fill.fore_color.rgb = ACCENT
    arrow.line.fill.background()
    add_textbox(s3, 2.75, 4.02, 10.0, 0.6,
                "指标较上一季度整体向好，其中营业收入增长最为明显。", size=16, color=INK,
                name="指标结论")
    s3.notes_slide.notes_text_frame.text = "指标备注：用于测试移动/缩放/层级/透明度与阴影。"

    # ── 第 4 页：区域营收（表格 + 备注，用于 PP-TB-01..05、PP-D-04、PP-N-01/02）──
    s4 = prs.slides.add_slide(blank)
    add_title(s4, "区域营收")
    rows, cols = 5, 3
    table_frame = s4.shapes.add_table(rows, cols, inches(0.9), inches(1.8), inches(11.5),
                                      inches(2.6))
    table_frame.name = "营收表格"   # 名称挂在 graphicFrame 上，大纲里才看得见
    table = table_frame.table
    table.columns[0].width = inches(4.0)
    table.columns[1].width = inches(4.0)
    table.columns[2].width = inches(3.5)
    header = ["区域", "营业收入", "同比增长"]
    data = [
        ["华东", "120,000", "18%"],
        ["华北", "98,000", "12%"],
        ["华南", "86,500", "9%"],
        ["合计", "304,500", "—"],
    ]
    for column, text in enumerate(header):
        cell = table.cell(0, column)
        cell.text = text
        cell.fill.solid()
        cell.fill.fore_color.rgb = ACCENT
        paragraph = cell.text_frame.paragraphs[0]
        paragraph.alignment = PP_ALIGN.CENTER
        run = paragraph.runs[0]
        run.font.size = Pt(15)
        run.font.bold = True
        run.font.color.rgb = WHITE
        run.font.name = "Microsoft YaHei"
    for row_index, row in enumerate(data, start=1):
        for column, text in enumerate(row):
            cell = table.cell(row_index, column)
            cell.text = text
            paragraph = cell.text_frame.paragraphs[0]
            paragraph.alignment = PP_ALIGN.CENTER
            run = paragraph.runs[0]
            run.font.size = Pt(14)
            run.font.color.rgb = INK
            run.font.name = "Microsoft YaHei"
            cell.fill.solid()
            cell.fill.fore_color.rgb = WHITE if row_index % 2 else ACCENT_SOFT
    add_textbox(s4, 0.9, 4.65, 11.5, 0.6, "注：金额单位为元，数据为内部统计口径。", size=13,
                color=MUTED, name="表格注释")
    s4.notes_slide.notes_text_frame.text = (
        "表格备注：合计 304,500 元由华东 120,000、华北 98,000、华南 86,500 相加得出，"
        "改任一区域数值后合计应同步更新。"
    )

    # ── 第 5 页：趋势（折线图，用于 PP-I-05 / PP-SL-06 / PP-X-04）──
    s5 = prs.slides.add_slide(blank)
    add_title(s5, "季度趋势")
    chart_data = CategoryChartData()
    chart_data.categories = ["Q1", "Q2", "Q3", "Q4"]
    chart_data.add_series("华东", (86_000, 94_000, 108_000, 120_000))
    chart_data.add_series("华北", (74_000, 82_000, 90_000, 98_000))
    chart_data.add_series("华南", (61_000, 68_000, 79_000, 86_500))
    chart_frame = s5.shapes.add_chart(
        XL_CHART_TYPE.LINE_MARKERS, inches(0.9), inches(1.75), inches(11.5), inches(4.4),
        chart_data,
    )
    chart_frame.name = "趋势图表"   # 同上：名称挂 graphicFrame
    chart = chart_frame.chart
    chart.has_title = True
    chart.chart_title.text_frame.text = "各区域季度营收（元）"
    chart.has_legend = True
    chart.legend.position = XL_LEGEND_POSITION.BOTTOM
    chart.legend.include_in_layout = False
    s5.notes_slide.notes_text_frame.text = "图表备注：三条折线分别对应华东/华北/华南，Q4 为预测值。"

    # ── 第 6 页：双标题歧义页（用于 PP-X-02：提示词只给"标题"时的消歧）──
    s6 = prs.slides.add_slide(blank)
    add_textbox(s6, 0.9, 1.2, 5.2, 0.9, "下一步计划", size=32, bold=True, color=INK,
                name="标题A")
    add_textbox(s6, 6.5, 1.2, 5.2, 0.9, "下一步计划", size=32, bold=True, color=ACCENT,
                name="标题B")
    add_textbox(s6, 0.9, 2.4, 5.2, 2.6,
                "左侧：产品侧待办\n1. 完成移动端改版\n2. 补齐数据看板", size=16, color=INK,
                name="正文A")
    add_textbox(s6, 6.5, 2.4, 5.2, 2.6,
                "右侧：交付侧待办\n1. 三家客户验收\n2. 完成年度框架续签", size=16, color=INK,
                name="正文B")
    s6.notes_slide.notes_text_frame.text = (
        "歧义页备注：本页刻意放了两个内容相同、颜色不同的标题，用于测试 Agent 在"
        "「把标题改一下」这类模糊指令下是否先澄清再动手。"
    )

    # ── 第 7 页：长文本（用于 PP-T-07 溢出测试）──
    s7 = prs.slides.add_slide(blank)
    add_title(s7, "风险与挑战")
    add_textbox(s7, 0.9, 1.7, 11.5, 1.4,
                "供应链交付周期延长、客户预算审批趋严、同行价格竞争加剧，"
                "需要在保持毛利的前提下调整报价策略。",
                size=18, color=INK, name="风险说明")
    add_textbox(s7, 0.9, 3.4, 5.4, 3.0,
                "应对措施一\n- 提前锁定关键物料\n- 与两家备选供应商签订框架协议\n"
                "- 对交付周期长的项目提前 6 周排产",
                size=15, color=INK, name="措施一")
    add_textbox(s7, 6.7, 3.4, 5.4, 3.0,
                "应对措施二\n- 报价分层：标准版/增强版\n- 对大客户提供分期付款方案\n"
                "- 建立价格审批红线",
                size=15, color=INK, name="措施二")

    # ── 第 8 页：隐藏页（用于 PP-SL-04：隐藏而不是删除）──
    s8 = prs.slides.add_slide(blank)
    add_title(s8, "数据备份（内部）")
    add_textbox(s8, 0.9, 1.8, 11.5, 3.0,
                "本页仅在内部复盘时使用：\n- 原始明细导出时间：2026-10-08\n"
                "- 数据口径版本：v3.2\n- 负责人：财务 BP",
                size=16, color=MUTED, name="备份说明")
    s8.element.set("show", "0")  # 隐藏页：放映时不出现
    s8.notes_slide.notes_text_frame.text = "隐藏页备注：用于测试 setHidden；若被误删，页数会从 9 变成 8。"

    # ── 第 9 页：结束页（用于 PP-SL-01 调序、PP-E2E-03 自检）──
    s9 = prs.slides.add_slide(blank)
    add_textbox(s9, 1.0, 2.6, 11.3, 1.1, "谢谢观看", size=40, bold=True, color=INK,
                name="结束页主标题")
    add_textbox(s9, 1.0, 3.9, 11.3, 0.7, "Questions?", size=22, color=MUTED,
                name="结束页副标题")
    add_rect(s9, 1.0, 4.8, 2.4, 0.1, ACCENT, name="结束页装饰条")

    return prs


def main() -> None:
    prs = build()
    prs.save(OUT)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(prs.slides)} slides)")


if __name__ == "__main__":
    main()
