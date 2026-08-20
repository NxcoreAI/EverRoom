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
import { useLocale } from '@/i18n/LocaleContext'

type RuntimeState = 'ready' | 'running'

interface LocalModelOption {
  id: string
  name: string
  descriptionKey: string
  size: string
  memoryGb: number
  recommended?: boolean
}

const LOCAL_MODELS: LocalModelOption[] = [
  {
    id: 'llama-3.2-3b-instruct-q4',
    name: 'Llama 3.2 3B Instruct',
    descriptionKey: 'surface:settings.localModel3bDescription',
    size: '2.0 GB',
    memoryGb: 4,
    recommended: true,
  },
  {
    id: 'llama-3.1-8b-instruct-q4',
    name: 'Llama 3.1 8B Instruct',
    descriptionKey: 'surface:settings.localModel8bDescription',
    size: '4.9 GB',
    memoryGb: 7,
  },
  {
    id: 'llama-3.2-1b-instruct-q4',
    name: 'Llama 3.2 1B Instruct',
    descriptionKey: 'surface:settings.localModel1bDescription',
    size: '0.8 GB',
    memoryGb: 2,
  },
]

export function LocalModelSettingsSection() {
  const { t } = useLocale()
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
            <h2 id="local-model-settings-title">{t('surface:settings.localModels')}</h2>
            <span className="local-model-preview-badge">{t('surface:settings.interfacePreview')}</span>
          </div>
          <p>{t('surface:settings.localModelsBody')}</p>
        </div>
      </header>

      <div className="local-runtime-row" data-state={runtimeState} aria-live="polite">
        <span className="local-runtime-icon" aria-hidden="true"><Gauge /></span>
        <div className="local-runtime-copy">
          <strong>{isRunning ? t('surface:settings.localRuntimeRunning') : t('surface:settings.localRuntimeReady')}</strong>
          <small>
            {isRunning
              ? t('surface:settings.localRuntimePreviewOnly', { name: selectedModel.name })
              : t('surface:settings.localRuntimeMockStatus')}
          </small>
        </div>
        <span className="local-runtime-address">127.0.0.1:39281</span>
        <button
          className={isRunning ? 'secondary-button local-model-stop' : 'primary-button'}
          type="button"
          onClick={() => setRuntimeState(isRunning ? 'ready' : 'running')}
        >
          {isRunning ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
          {isRunning ? t('surface:settings.stopPreview') : t('surface:settings.startPreview')}
        </button>
      </div>

      <div className="local-model-body">
        <div className="local-model-section-heading">
          <div>
            <strong>{t('surface:settings.model')}</strong>
            <small>{t('surface:settings.localModelSelectionBody')}</small>
          </div>
          <button className="secondary-button" type="button" disabled title={t('surface:settings.importModelsUnavailable')}>
            <FolderOpen aria-hidden="true" />{t('surface:settings.importGguf')}
          </button>
        </div>

        <div className="local-model-list" role="radiogroup" aria-label={t('surface:settings.localModels')}>
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
                    {model.recommended ? <em>{t('surface:settings.recommended')}</em> : null}
                  </span>
                  <small>{t(model.descriptionKey)}</small>
                </span>
                <span className="local-model-meta">
                  <strong>{model.size}</strong>
                  <small>{t('surface:settings.approximatelyMemory', { memory: model.memoryGb })}</small>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="local-model-config">
        <div className="local-model-config-heading">
          <strong>{t('surface:settings.runtimeConfiguration')}</strong>
          <small>{t('surface:settings.runtimeConfigurationBody')}</small>
        </div>
        <label>
          <span>{t('surface:settings.contextLength')}</span>
          <select value={contextSize} disabled={isRunning} onChange={(event) => setContextSize(event.target.value)}>
            <option value="4096">4K</option>
            <option value="8192">8K</option>
            <option value="16384">16K</option>
            <option value="32768">32K</option>
          </select>
        </label>
        <div className="local-model-config-switch">
          <span>
            <strong>{t('surface:settings.gpuAcceleration')}</strong>
            <small>{t('surface:settings.gpuAccelerationBody')}</small>
          </span>
          <button
            className="settings-toggle"
            type="button"
            role="switch"
            aria-label={t('surface:settings.gpuAcceleration')}
            aria-checked={gpuAcceleration}
            data-active={String(gpuAcceleration)}
            disabled={isRunning}
            onClick={() => setGpuAcceleration((current) => !current)}
          >
            <span aria-hidden="true" />
            {t(gpuAcceleration ? 'surface:settings.on' : 'surface:settings.off')}
          </button>
        </div>
      </div>

      <footer className="local-model-footer">
        <HardDrive aria-hidden="true" />
        <span>{t('surface:settings.modelDirectory')}</span>
        <code>~/Library/Application Support/EverRoom/models</code>
        <small>{t('surface:settings.modelDirectoryPlaceholder')}</small>
      </footer>
    </section>
  )
}
