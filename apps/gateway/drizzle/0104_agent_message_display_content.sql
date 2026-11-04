-- 批注消息的气泡正文：有批注卡片时气泡只显示输入框正文（空＝不渲染气泡）。
-- content 仍存合并文案（标题/检索/重试语义不变）。
ALTER TABLE `agent_messages` ADD `display_content` text;
