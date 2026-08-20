import {
  Check,
  Cpu,
  FolderOpen,
  Gauge,
  HardDrive,
  Play,
  Square,
} from 'lucide-react'
import { useState } from 'react'

type RuntimeState = 'ready' | 'running'

interface LocalModelOption {
  id: string
  name: string
  description: string
  size: string
  memory: string
  recommended?: boolean
}

const LOCAL_MODELS: LocalModelOption[] = [
  {
    id: 'llama-3.2-3b-instruct-q4',
    name: 'Llama 3.2 3B Instruct',
    description: 'Q4_K_M · 适合日常对话与轻量 Agent',
    size: '2.0 GB',
    memory: '约 4 GB 内存',
    recommended: true,
  },
  {
    id: 'llama-3.1-8b-instruct-q4',
    name: 'Llama 3.1 8B Instruct',
    description: 'Q4_K_M · 更好的复杂任务理解能力',
    size: '4.9 GB',
    memory: '约 7 GB 内存',
  },
  {
    id: 'llama-3.2-1b-instruct-q4',
    name: 'Llama 3.2 1B Instruct',
    description: 'Q4_K_M · 启动快，适合低内存设备',
    size: '0.8 GB',
    memory: '约 2 GB 内存',
  },
]

export function LocalModelSettingsSection() {
  const [runtimeState, setRuntimeState] = useState<RuntimeState>('ready')
  const [selectedModelId, setSelectedModelId] = useState(LOCAL_MODELS[0].id)
  const [contextSize, setContextSize] = useState('8192')
  const [gpuAcceleration, setGpuAcceleration] = useState(true)
  const selectedModel = LOCAL_MODELS.find((model) => model.id === selectedModelId) ?? LOCAL_MODELS[0]
  const isRunning = runtimeState === 'running'

  return (
    <section className="reality-settings-section local-model-settings" aria-labelledby="local-model-settings-title">
      <header>
        <span><Cpu aria-hidden="true" /></span>
        <div>
          <div className="local-model-title-row">
            <h2 id="local-model-settings-title">本地模型</h2>
            <span className="local-model-preview-badge">界面预览</span>
          </div>
          <p>参考 Jan 的本地优先体验，使用 Llama 在设备上完成推理。</p>
        </div>
      </header>

      <div className="local-runtime-row" data-state={runtimeState} aria-live="polite">
        <span className="local-runtime-icon" aria-hidden="true"><Gauge /></span>
        <div className="local-runtime-copy">
          <strong>{isRunning ? '本地服务运行中' : 'Llama Runtime 已就绪'}</strong>
          <small>
            {isRunning
              ? `${selectedModel.name} · 仅为交互预览，尚未启动真实推理进程`
              : 'Mock 状态 · 后续由桌面主进程管理 llama.cpp 生命周期'}
          </small>
        </div>
        <span className="local-runtime-address">127.0.0.1:39281</span>
        <button
          className={isRunning ? 'secondary-button local-model-stop' : 'primary-button'}
          type="button"
          onClick={() => setRuntimeState(isRunning ? 'ready' : 'running')}
        >
          {isRunning ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
          {isRunning ? '停止预览' : '预览启动'}
        </button>
      </div>

      <div className="local-model-body">
        <div className="local-model-section-heading">
          <div>
            <strong>模型</strong>
            <small>选择默认用于对话和 Agent 的本地 Llama 模型。</small>
          </div>
          <button className="secondary-button" type="button" disabled title="真实模型导入将在接入 llama.cpp 后开放">
            <FolderOpen aria-hidden="true" />导入 GGUF
          </button>
        </div>

        <div className="local-model-list" role="radiogroup" aria-label="本地模型">
          {LOCAL_MODELS.map((model) => {
            const selected = model.id === selectedModelId
            return (
              <button
                key={model.id}
                className="local-model-option"
                type="button"
                role="radio"
                aria-checked={selected}
                data-selected={String(selected)}
                disabled={isRunning}
                onClick={() => setSelectedModelId(model.id)}
              >
                <span className="local-model-radio" aria-hidden="true">{selected ? <Check /> : null}</span>
                <span className="local-model-option-copy">
                  <span>
                    <strong>{model.name}</strong>
                    {model.recommended ? <em>推荐</em> : null}
                  </span>
                  <small>{model.description}</small>
                </span>
                <span className="local-model-meta">
                  <strong>{model.size}</strong>
                  <small>{model.memory}</small>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="local-model-config">
        <div className="local-model-config-heading">
          <strong>运行配置</strong>
          <small>修改后将在下次启动本地模型时生效。</small>
        </div>
        <label>
          <span>上下文长度</span>
          <select value={contextSize} disabled={isRunning} onChange={(event) => setContextSize(event.target.value)}>
            <option value="4096">4K</option>
            <option value="8192">8K</option>
            <option value="16384">16K</option>
            <option value="32768">32K</option>
          </select>
        </label>
        <div className="local-model-config-switch">
          <span>
            <strong>GPU 加速</strong>
            <small>优先使用 Metal 或 CUDA，失败时回退到 CPU。</small>
          </span>
          <button
            className="settings-toggle"
            type="button"
            role="switch"
            aria-label="GPU 加速"
            aria-checked={gpuAcceleration}
            data-active={String(gpuAcceleration)}
            disabled={isRunning}
            onClick={() => setGpuAcceleration((current) => !current)}
          >
            <span aria-hidden="true" />
            {gpuAcceleration ? '已开启' : '已关闭'}
          </button>
        </div>
      </div>

      <footer className="local-model-footer">
        <HardDrive aria-hidden="true" />
        <span>模型目录</span>
        <code>~/Library/Application Support/EverRoom/models</code>
        <small>占位配置，当前不会创建或下载模型文件。</small>
      </footer>
    </section>
  )
}
