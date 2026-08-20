# Notion 与 Google Docs 托管同步实现说明

## 默认任务

每个处于 active 状态的连接账号由 Gateway 自动创建两个只读任务。任务 ID 由服务名和连接名哈希生成，不包含邮箱或工作区名称。

| 连接器 | 全量校准 | 增量同步 | 增量依据 |
| --- | --- | --- | --- |
| Notion | 每 12 小时 | 每 10 分钟 | `last_edited_time` 水位，向前重叠 2 分钟 |
| Google Docs | 每 24 小时 | 每 5 分钟 | Google Drive Changes `pageToken` |

首次发现账号后只启动全量校准；全量成功并提交检查点后才激活增量任务。用户暂停已有增量任务后，全量任务不会擅自恢复它。Google change token 返回失效错误时，增量任务暂停并立即调度一次全量校准。

首次和游标交接立即运行；后续周期按任务 ID 施加稳定的 ±5% 抖动，避免多个账号长期同时请求 Provider。

全量校准完成前不提交检查点。扫描中任何分页、正文获取或导出失败都会使本次 run 失败；已经写入的记录保持幂等，下次重试继续校准。枚举缺失必须连续出现在两次成功的全量校准中才软删除；Provider 明确返回 archived、trash 或 removed 时立即删除。

## 内容获取

Notion 使用：

- `search`：分页枚举页面，按 `last_edited_time` 降序。
- `retrieve_page_markdown`：获取官方 enhanced Markdown。
- 页面属性、parent、归档状态和来源 URL 保存在来源元数据中。

Google Docs 使用：

- `files.list`：仅枚举 `application/vnd.google-apps.document`。
- `changes.getStartPageToken` / `changes.list`：维护增量游标。
- `files.export`：导出 `text/html`，从 OpenConnector 本地 transit URL 下载后确定性转 Markdown。

Transit 下载只接受 OpenConnector 同源地址，或同协议同端口的 loopback 别名，并限制为 `/api/files/` 路径和 32 MiB。

## ERMD 产物

每条生效记录生成两个同名产物：

```text
<dataDir>/connectors/markdown/<service>/<connection-hash>/document/<source-hash>.md
<dataDir>/connectors/markdown/<service>/<connection-hash>/document/<source-hash>.manifest.json
```

`.md` 使用 `ermd_version: 1` frontmatter、统一文档信息区和 Markdown 正文。`.manifest.json` 保存稳定来源身份、source/markdown hash、renderer version 和无法无损放入 Markdown 的连接器元数据。

兼容规则：

- 换行统一为 LF，清理行末空白，输出字节稳定。
- Notion enhanced Markdown 原样保留，不把未知块臆造为其他结构。
- Google Docs 标题、列表和链接转为 GFM；复杂或合并单元格表格保留为安全的 raw HTML。
- 导出的 `script`、`style`、HTML 注释和事件处理属性在转换前移除。
- 评论、建议模式和修订历史不混入正文；当前 Provider 未提供的字段保持缺失。
- 图片 URL 当前保留为来源引用，不主动抓取文档内任意 URL，避免 SSRF；受控附件资产本地化应通过独立 asset outbox 实现。

## 删除与恢复

删除事件会依次：

1. 软删除连接器领域记录并写 Markdown outbox。
2. 触发 Knowledge cleanup 和 MemoryCore `caller_ref` 清理。
3. 将历史 ingest 台账标为 deleted，使旧 hash 不再参与幂等命中。
4. 删除 `.md` 和 `.manifest.json`，artifact 标记为 deleted。

同一来源以后以相同内容恢复时会生成更高的 source version，并重新进入 Room/Memory。台账幂等身份为 `(sourceKind, sourceId, contentHash)`，不同来源类型不会发生 ID 碰撞。
