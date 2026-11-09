"""把 docs/pptx-agent-prompt-sheet.zh-CN.md 导出成 Word（.docx）与 Excel 执行记录表（.xlsx）。

单一数据源：markdown 就是权威内容，改 md 后重跑本脚本即可。

用法：
    python3 test/fixtures/pptx-agent/export_prompt_sheet.py
产出：
    docs/答辩PPT改稿测试_提示词清单.docx
    docs/答辩PPT改稿测试_执行记录表.xlsx
"""

from __future__ import annotations

import re
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

ROOT = Path(__file__).resolve().parents[3]
MD = ROOT / "docs" / "pptx-agent-prompt-sheet.zh-CN.md"
DOCX = ROOT / "docs" / "答辩PPT改稿测试_提示词清单.docx"
XLSX = ROOT / "docs" / "答辩PPT改稿测试_执行记录表.xlsx"


# ─────────────────────────── markdown 解析 ───────────────────────────

def parse_markdown(text: str):
    """按行解析成块：heading / paragraph / code / table / list / hr。"""
    blocks = []
    lines = text.split("\n")
    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        if stripped.startswith("```"):
            index += 1
            body = []
            while index < len(lines) and not lines[index].strip().startswith("```"):
                body.append(lines[index])
                index += 1
            index += 1
            blocks.append(("code", "\n".join(body)))
            continue

        if not stripped:
            index += 1
            continue

        if stripped.startswith("|") and index + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|$", lines[index + 1].strip()):
            rows = []
            header = [cell.strip() for cell in stripped.strip("|").split("|")]
            index += 2
            while index < len(lines) and lines[index].strip().startswith("|"):
                rows.append([cell.strip() for cell in lines[index].strip().strip("|").split("|")])
                index += 1
            blocks.append(("table", (header, rows)))
            continue

        heading = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if heading:
            blocks.append(("heading", (len(heading.group(1)), heading.group(2).strip())))
            index += 1
            continue

        if stripped.startswith("---"):
            blocks.append(("hr", None))
            index += 1
            continue

        if re.match(r"^[-*]\s+|^\d+\.\s+", stripped):
            items = []
            while index < len(lines) and re.match(r"^\s*([-*]|\d+\.)\s+", lines[index]):
                items.append(re.sub(r"^\s*([-*]|\d+\.)\s+", "", lines[index]).strip())
                index += 1
            blocks.append(("list", items))
            continue

        if stripped.startswith(">"):
            quote = [stripped.lstrip(">").strip()]
            index += 1
            while index < len(lines) and lines[index].strip().startswith(">"):
                quote.append(lines[index].strip().lstrip(">").strip())
                index += 1
            blocks.append(("quote", " ".join(part for part in quote if part)))
            continue

        paragraph = [stripped]
        index += 1
        while index < len(lines):
            nxt = lines[index].strip()
            if not nxt or nxt.startswith(("#", "|", "```", "---")) or re.match(r"^([-*]|\d+\.)\s+", nxt):
                break
            paragraph.append(nxt)
            index += 1
        blocks.append(("paragraph", " ".join(paragraph)))
    return blocks


INLINE_TOKEN = re.compile(r"(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)")


def add_inline(paragraph, text: str) -> None:
    """把 **粗体** / `代码` / *斜体* 拆成 run，保留普通文本。"""
    for chunk in INLINE_TOKEN.split(text):
        if not chunk:
            continue
        if chunk.startswith("**") and chunk.endswith("**") and len(chunk) > 4:
            run = paragraph.add_run(chunk[2:-2])
            run.bold = True
        elif chunk.startswith("`") and chunk.endswith("`") and len(chunk) > 2:
            run = paragraph.add_run(chunk[1:-1])
            run.font.name = "Menlo"
            run._element.rPr.rFonts.set(qn("w:eastAsia"), "Menlo")
            run.font.size = Pt(9.5)
            run.font.color.rgb = RGBColor(0x8B, 0x2E, 0x2E)
        elif chunk.startswith("*") and chunk.endswith("*") and len(chunk) > 2:
            run = paragraph.add_run(chunk[1:-1])
            run.italic = True
        else:
            paragraph.add_run(chunk)


def build_docx(blocks) -> None:
    document = Document()
    style = document.styles["Normal"]
    style.font.name = "PingFang SC"
    style.font.size = Pt(10.5)
    style.element.rPr.rFonts.set(qn("w:eastAsia"), "PingFang SC")

    for block in blocks:
        kind = block[0]
        if kind == "heading":
            level, title = block[1]
            heading = document.add_heading(level=min(level, 4))
            add_inline(heading, title)
            for run in heading.runs:
                run.font.color.rgb = RGBColor(0x1F, 0x29, 0x37)
        elif kind == "paragraph":
            paragraph = document.add_paragraph()
            add_inline(paragraph, block[1])
        elif kind == "list":
            for item in block[1]:
                paragraph = document.add_paragraph(style="List Bullet")
                add_inline(paragraph, item)
        elif kind == "code":
            paragraph = document.add_paragraph()
            paragraph.paragraph_format.left_indent = Pt(12)
            paragraph.paragraph_format.space_before = Pt(2)
            paragraph.paragraph_format.space_after = Pt(6)
            for offset, line in enumerate(block[1].split("\n")):
                if offset:
                    paragraph.add_run().add_break()
                run = paragraph.add_run(line)
                run.font.name = "Menlo"
                run._element.rPr.rFonts.set(qn("w:eastAsia"), "PingFang SC")
                run.font.size = Pt(9)
                run.font.color.rgb = RGBColor(0x24, 0x29, 0x2E)
        elif kind == "quote":
            paragraph = document.add_paragraph()
            paragraph.paragraph_format.left_indent = Pt(10)
            add_inline(paragraph, block[1])
            for run in paragraph.runs:
                run.italic = True
                run.font.color.rgb = RGBColor(0x5B, 0x66, 0x77)
        elif kind == "table":
            header, rows = block[1]
            table = document.add_table(rows=1, cols=len(header))
            table.style = "Light Grid Accent 1"
            table.alignment = WD_TABLE_ALIGNMENT.CENTER
            for cell, text in zip(table.rows[0].cells, header):
                cell.text = ""
                add_inline(cell.paragraphs[0], text)
                for run in cell.paragraphs[0].runs:
                    run.bold = True
            for row in rows:
                cells = table.add_row().cells
                for cell, text in zip(cells, row):
                    cell.text = ""
                    add_inline(cell.paragraphs[0], text)
            document.add_paragraph()
        elif kind == "hr":
            document.add_paragraph()
    DOCX.parent.mkdir(parents=True, exist_ok=True)
    document.save(DOCX)


# ─────────────────────────── Excel 执行记录表 ───────────────────────────

CASE_RE = re.compile(r"^\*\*(P-\d+)\*\*$")


def collect_cases(text: str):
    """从 markdown 抽出「编号 / 提示词 / 看什么 / 所属分组」。"""
    cases = []
    group = "未分组"
    lines = text.split("\n")
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        heading = re.match(r"^##\s+(.*)$", line)
        if heading:
            group = re.sub(r"^\d+\.\s*", "", heading.group(1)).strip()
            index += 1
            continue
        match = CASE_RE.match(line)
        if match:
            prompt_lines = []
            cursor = index + 1
            while cursor < len(lines) and not lines[cursor].strip().startswith("```"):
                cursor += 1
            cursor += 1
            while cursor < len(lines) and not lines[cursor].strip().startswith("```"):
                prompt_lines.append(lines[cursor])
                cursor += 1
            watch = ""
            cursor += 1
            while cursor < len(lines) and not lines[cursor].strip():
                cursor += 1
            if cursor < len(lines) and lines[cursor].strip().startswith(">"):
                watch = lines[cursor].strip().lstrip("> ").strip()
            cases.append({
                "id": match.group(1),
                "group": group,
                "prompt": "\n".join(prompt_lines).strip(),
                "watch": watch,
            })
            index = cursor
            continue
        index += 1
    return cases


def build_xlsx(cases) -> None:
    workbook = Workbook()
    thin = Side(style="thin", color="D5DDE6")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    header_fill = PatternFill("solid", fgColor="1F4E79")
    header_font = Font(color="FFFFFF", bold=True, size=11)

    # ── 说明 ──
    guide = workbook.active
    guide.title = "说明"
    guide["A1"] = "答辩 PPT 改稿测试 · 执行记录表"
    guide["A1"].font = Font(size=15, bold=True)
    rows = [
        ("被测文件", "/Users/nxcore/学生/答辩PPT/学生体质健康信息查询智能体+课程设计答辩_优化版.pptx"),
        ("基线", "10 页 · 16:9 · 无表格/无备注/无隐藏页 · 第 3 页大图 · 第 6 页簇状柱状图（无图表标题）"),
        ("用法", "另存副本 → 以可编辑方式打开 → 逐条发「用例清单」里的提示词 → 在表里勾结果"),
        ("判定", "✅ 改对了且描述一致 / ⚠️ 部分达成或有偏差 / ❌ 没改、改错、或声称成功但未生效"),
        ("来源", "docs/pptx-agent-prompt-sheet.zh-CN.md（改 md 后重跑 export_prompt_sheet.py）"),
    ]
    for offset, (key, value) in enumerate(rows, start=3):
        guide.cell(offset, 1, key).font = Font(bold=True)
        guide.cell(offset, 2, value).alignment = Alignment(wrap_text=True, vertical="top")
    guide.column_dimensions["A"].width = 12
    guide.column_dimensions["B"].width = 96

    # ── 用例清单 ──
    sheet = workbook.create_sheet("用例清单")
    headers = ["编号", "分组", "提示词", "看什么", "结果", "实际改动 / 偏差", "备注"]
    widths = [8, 16, 62, 58, 10, 32, 22]
    for column, (title, width) in enumerate(zip(headers, widths), start=1):
        cell = sheet.cell(1, column, title)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = border
        sheet.column_dimensions[cell.column_letter].width = width
    for offset, case in enumerate(cases, start=2):
        values = [case["id"], case["group"], case["prompt"], case["watch"], "", "", ""]
        for column, value in enumerate(values, start=1):
            cell = sheet.cell(offset, column, value)
            cell.alignment = Alignment(wrap_text=True, vertical="top")
            cell.border = border
        sheet.row_dimensions[offset].height = 46
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = f"A1:G{len(cases) + 1}"

    # ── 分组统计 ──
    stats = workbook.create_sheet("分组统计")
    stats["A1"] = "分组"
    stats["B1"] = "用例数"
    stats["C1"] = "通过"
    stats["D1"] = "部分通过"
    stats["E1"] = "失败"
    stats["F1"] = "未执行"
    for cell in stats[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center")
    groups = []
    for case in cases:
        if case["group"] not in groups:
            groups.append(case["group"])
    for offset, group in enumerate(groups, start=2):
        stats.cell(offset, 1, group)
        stats.cell(offset, 2, f'=COUNTIF(用例清单!B:B,A{offset})')
        stats.cell(offset, 3, f'=COUNTIFS(用例清单!B:B,A{offset},用例清单!E:E,"✅")')
        stats.cell(offset, 4, f'=COUNTIFS(用例清单!B:B,A{offset},用例清单!E:E,"⚠️")')
        stats.cell(offset, 5, f'=COUNTIFS(用例清单!B:B,A{offset},用例清单!E:E,"❌")')
        stats.cell(offset, 6, f'=B{offset}-C{offset}-D{offset}-E{offset}')
        for column in range(1, 7):
            stats.cell(offset, column).border = border
            stats.cell(offset, column).alignment = Alignment(horizontal="center")
    total = len(groups) + 2
    stats.cell(total, 1, "合计").font = Font(bold=True)
    for column in range(2, 7):
        stats.cell(total, 1).border = border
        stats.cell(total, column, f"=SUM({chr(64 + column)}2:{chr(64 + column)}{total - 1})").font = Font(bold=True)
    for column, width in zip("ABCDEF", (22, 10, 8, 11, 8, 10)):
        stats.column_dimensions[column].width = width

    # ── 缺陷记录 ──
    bugs = workbook.create_sheet("缺陷记录")
    bug_headers = ["编号", "关联用例", "现象", "预期", "实际", "严重度", "状态"]
    for column, title in enumerate(bug_headers, start=1):
        cell = bugs.cell(1, column, title)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center")
        cell.border = border
    for column, width in zip("ABCDEFG", (8, 12, 40, 32, 32, 10, 10)):
        bugs.column_dimensions[column].width = width
    bugs.freeze_panes = "A2"

    XLSX.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(XLSX)


def main() -> None:
    text = MD.read_text(encoding="utf-8")
    blocks = parse_markdown(text)
    cases = collect_cases(text)
    build_docx(blocks)
    build_xlsx(cases)
    print(f"docx: {DOCX.name} ({DOCX.stat().st_size} bytes, {len(blocks)} 个块)")
    print(f"xlsx: {XLSX.name} ({XLSX.stat().st_size} bytes, {len(cases)} 条用例)")


if __name__ == "__main__":
    main()
