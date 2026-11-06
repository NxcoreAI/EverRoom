"""Rebuild the 10k-row xlsx fixture used by the xlsx-agent perf / batch-limit cases.

    python3 test/fixtures/xlsx-agent/make_sales_10k.py

Needs only `xlsxwriter`. The generated workbook is committed, so this script exists
for reproducibility (regenerate after editing the column layout or row count).
"""
from pathlib import Path

import xlsxwriter

HERE = Path(__file__).resolve().parent
OUT = HERE / "销售明细_1万行.xlsx"

HEADERS = ["日期", "区域", "产品线", "数量", "单价", "金额", "成本", "毛利"]
ROWS = 10_000
REGIONS = ["华东", "华南", "华北", "西南"]
LINES = ["智能照明", "智能安防", "智能家电", "传感器"]


def main() -> None:
    wb = xlsxwriter.Workbook(str(OUT), {"constant_memory": True})
    ws = wb.add_worksheet("销售明细")
    bold = wb.add_format({"bold": True, "bg_color": "#DDEBF7", "align": "center"})
    num = wb.add_format({"num_format": "#,##0.00"})
    date_fmt = wb.add_format({"num_format": "yyyy-mm-dd"})

    ws.set_row(0, 22)
    for column, header in enumerate(HEADERS):
        ws.write(0, column, header, bold)
    ws.set_column(0, 0, 12)
    ws.set_column(1, 3, 12)
    ws.set_column(4, 7, 14)

    for index in range(ROWS):
        row = index + 1
        ws.write_string(row, 0, f"2026-{(index % 12) + 1:02d}-{(index % 28) + 1:02d}", date_fmt)
        ws.write_string(row, 1, REGIONS[index % len(REGIONS)])
        ws.write_string(row, 2, LINES[index % len(LINES)])
        quantity = 10 + (index * 7) % 190
        price = 99 + (index * 13) % 400
        ws.write_number(row, 3, quantity)
        ws.write_number(row, 4, price)
        ws.write_formula(row, 5, f"=D{row + 1}*E{row + 1}", num)
        ws.write_number(row, 6, round(quantity * price * 0.62, 2), num)
        ws.write_formula(row, 7, f"=F{row + 1}-G{row + 1}", num)

    ws.freeze_panes(1, 0)
    ws.autofilter(0, 0, ROWS, len(HEADERS) - 1)
    wb.close()
    print(f"rows={ROWS} -> {OUT} ({OUT.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
