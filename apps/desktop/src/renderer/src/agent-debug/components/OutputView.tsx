import type { AgentDebugRun } from '@nxcore/agent-contract'

import type { DebugRunOutput } from '../reducer'
import { CopyButton } from './CopyButton'
import { runStatusLabel } from './Indicators'
import { formatCharCount } from '../format'

const SOURCE_LABEL: Record<string, string> = {
  result: 'tool.completed.result',
  'result.content': 'tool.completed.result.content',
  args: 'tool.started.args',
}

interface OutputViewProps {
  run: AgentDebugRun | null
  output: DebugRunOutput
}

export function OutputView({ run, output }: OutputViewProps) {
  const failed = run?.status === 'failed' || run?.status === 'cancelled' || run?.status === 'interrupted'
  const finalText = output.finalText || (output.messageCompleted ? '' : output.streamingText)
  const streaming = !output.messageCompleted && Boolean(output.streamingText)

  return (
    <div className="scroll output">
      {failed ? (
        <p className="output-error">
          {run ? runStatusLabel(run.status) : '失败'}：{output.errorMessage ?? run?.errorMessage ?? '运行时未提供错误信息'}
        </p>
      ) : null}

      <section className="output-section">
        <div className="output-head">
          <h2 className="output-title">最终 assistant 输出</h2>
          {run ? <span className="output-title-time">{runStatusLabel(run.status)}</span> : null}
          {streaming ? <span className="output-title-time">流式中</span> : null}
          {finalText ? <CopyButton text={finalText} /> : null}
        </div>
        {finalText ? (
          <div className="output-text">{finalText}</div>
        ) : (
          <p className="output-empty">
            {output.messageCompleted
              ? '本 run 的 message.completed 内容为空。'
              : '尚无最终输出；运行中的消息会实时出现在「时间线」页签。'}
          </p>
        )}
        {output.streamingText && output.messageCompleted && output.streamingText !== output.finalText ? (
          <p className="output-note">
            已收到 {formatCharCount(output.streamingText.length)} 字符流式文本，与最终消息不同（可能被运行时修正）。
          </p>
        ) : null}
      </section>

      <section className="output-section">
        <div className="output-head">
          <h2 className="output-title">subagent_submit_result</h2>
          {output.submitResult ? (
            <span className="output-title-time">
              来源 {SOURCE_LABEL[output.submitResult.source] ?? output.submitResult.source}
            </span>
          ) : null}
          {output.submitResult ? (
            <CopyButton text={JSON.stringify(output.submitResult.value, null, 2)} label="复制 JSON" />
          ) : null}
        </div>
        {output.submitResult ? (
          <pre className="output-pre">{JSON.stringify(output.submitResult.value, null, 2)}</pre>
        ) : (
          <p className="output-empty">
            本次 run 没有 subagent_submit_result 结果；内置 / 本机 Agent 通常以最终 assistant 消息输出。
          </p>
        )}
      </section>
    </div>
  )
}
