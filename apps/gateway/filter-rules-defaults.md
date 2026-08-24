# Ingest 过滤规则

> 过滤器 agent 每次判定时注入本文件内容（apps/gateway/src/modules/ingest/rules.ts）。
> 两段各自独立修改：用户偏好段经 `PUT /v1/ingest/filter/rules/preference`（或直接编辑
> dataDir 副本，mtime 变更即刻生效）；系统洞察段由洞察 job 每小时自动重写，手改会被覆盖。

<!-- everroom:filter:user-preference:start -->
## 用户偏好（可编辑）

- 无价值的典型：纯寒暄/表情回应/+1、系统与 bot 通知、纯模板（日历邀请壳、自动回复）、无正文的链接壳、纯格式空壳。
- 有价值：包含事实、观点、决策、任务、上下文或任何后续可检索复用的信息——即使简短。
<!-- everroom:filter:user-preference:end -->

<!-- everroom:filter:system-insight:start -->
## 系统洞察（系统维护，每小时刷新）

（洞察 job 尚未生成）
<!-- everroom:filter:system-insight:end -->
