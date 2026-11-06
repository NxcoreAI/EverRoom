# Word → PDF 导出中文变空白（豆腐块）修复

2026-11-04 · 关联：`word_export_pdf` / 论文面板导出 PDF / 旧格式 Office 预览转换

## 现象

Agent 把 Word 导出成 PDF 后，整篇中文变成空白方块（截图里标题、正文、表格内容全丢，只剩 Latin 与数字），
但 `pdftotext` 能抽出完整中文 —— 即**文字层在、字形层缺失**，所以肉眼看起来是空文档，也没有任何报错。

## 根因

PDF 生成走 `apps/desktop/src/main/office/legacy-convert.ts` 的 `convertOfficeFileToPdf()`：
`soffice --headless --convert-to pdf` 转 LibreOffice。

LibreOffice（本机 26.8，自带 `libfontconfig`）默认的 fontconfig 配置**只看得到自己 bundle 内的字体**
（`LibreOffice.app/Contents/Resources/fonts/truetype`：Carlito / DejaVu / Liberation…），
看不到 macOS 系统字体目录，尤其：

- `/System/Library/Fonts/Supplemental/Songti.ttc`（宋体 STSongti）
- `/System/Library/AssetsV2/com_apple_MobileAsset_Font8/.../PingFang.ttc`（苹方）

而 App 生成的 docx（genoffice docx 引擎）默认 `w:eastAsia="宋体"`。宋体不可见、也没有 CJK 回退，
LibreOffice 就把所有 CJK 字符写成 notdef：`pdffonts` 里只有 Carlito 等拉丁字体，PDF 页数还会被压扁
（缺字形时 CJK 无 advance width；同一份文档 3 页坏 → 6 页好）。

同类风险：`convertLegacyOfficeFile()`（.doc/.xls/.ppt → OOXML 预览）用的是同一个 soffice 启动器。

## 修复

1. **新增** `apps/desktop/src/main/office/office-fontconfig.ts`
   `sofficeFontConfigEnv(executable)` 生成一份 fontconfig 配置并在 spawn soffice 时注入
   `FONTCONFIG_FILE` / `XDG_CACHE_HOME`：
   - `<dir>` = 存在的系统字体目录（macOS：`/System/Library/Fonts`、`Supplemental`、`/Library/Fonts`、
     `~/Library/Fonts`、`AssetsV2/com_apple_MobileAsset_Font8`；Linux：`/usr/share/fonts` 等）
     + LibreOffice 自带字体目录（保住 Carlito 等拉丁字体；由可执行文件路径推导，保留 `/Applications` 兜底）。
   - macOS 追加常用 Windows 中文字体名 → 系统字体别名（宋体/SimSun→Songti SC、黑体/SimHei→Heiti SC、
     微软雅黑/等线→PingFang SC、仿宋→STFangsong、楷体→Kaiti SC），再加通用弱兜底 PingFang SC。
   - Linux `include /etc/fonts/fonts.conf` 保留发行版规则；Windows 不用 fontconfig，直接不启用。
   - 配置与 cache 落在 `tmpdir()/everroom-soffice-fontconfig/<platform>-<hash>/`，按
     (平台, executable, 字体目录) 复用；原子写（临时文件+rename）、目录 `0o700`。
   - 任何异常、已有 `FONTCONFIG_FILE`、系统字体目录全缺时返回 `{}` —— 只降级、绝不影响导出本身。
2. **修改** `legacy-convert.ts`：把「拼 args + 找可执行 + execFileAsync + 找产物」抽成
   `runSofficeConversion()` 供两个转换函数共用，spawn 时注入上面生成的 env；错误文案、60s 超时、
   临时 profile / 缓存命中行为不变。

## 验证

- 单测 `apps/desktop/tests/office-fontconfig.test.ts`（8 用例，注入 platform/env/exists/cacheRoot，不依赖真实系统字体）
- 端到端：用改后的 `convertOfficeFileToPdf()` 转换真实失败样本
  （`飞书工作信息汇总-李展萍-20261104.docx`，`w:eastAsia=宋体`）：
  - 页数 3 → **6**，`pdffonts` 出现 `STSongti-SC-Bold/Regular`（emb=yes）且 Carlito 保留，拉丁正常；
  - `pdftotext` 中文完整；`pdftoppm` 渲染标题/正文/表格中文完整，无空框。
- 另用一份用户 docx（`谢国新的使用说明书.docx`）验证同样通过；转换耗时 ~4.5–5.5s（首次含字体扫描，
  之后命中 fontconfig cache），远低于 60s 超时。

## 边界与后续

- 本修复覆盖 `word_export_pdf`（Agent 导出）与论文面板导出（同一函数）；`.doc/.xls/.ppt` 预览转换同样受益。
- 其它 PDF 链路审计结论：`document-pdf-export.ts`（Electron `printToPDF`）与 vendor genoffice 的
  docs/slides 导出走 Chromium 字体栈，CJK 安全；PDF 读改走 `@genoffice/font-metrics` 直接扫系统字体目录，
  不依赖 fontconfig；**不存在「Agent 直接生成 PDF」的路径**，生成 PDF = Word→PDF 导出。
- 仍依赖本机安装 LibreOffice（未装时返回 `unavailable`，Agent 侧提示"本机未安装"）。首次转换有一次性字体扫描开销。
- 建议后续（未做）：`word_export_pdf` 成功后做一次产物自检（源含 CJK 而 PDF 字体表无 CJK 字体时记 warn/回带提示），
  避免"空白 PDF 仍被告知成功"这类静默失败。
