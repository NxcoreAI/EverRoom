import { isValidElement, useEffect, useId, useRef, useState, type CSSProperties, type ImgHTMLAttributes, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

function sourceText(children: ReactNode): string {
  if (typeof children === 'string') return children.trim()
  if (Array.isArray(children)) return children.map(sourceText).join('').trim()
  return ''
}

const imageGridBlockPattern = /<!--\s*everroom:image-grid:start\s+columns=(\d+)\s*-->\s*([\s\S]*?)\s*<!--\s*everroom:image-grid:end\s*-->/giu
const localImagePattern = /!\[((?:\\.|[^\]])*)\]\((nxcore-clipper-asset:\/\/local\/[^)\s]+)\)/giu

function displayMarkdown(markdown: string): string {
  return markdown
    .replace(/^---[\s\S]*?---\s*/u, '')
    .replace(imageGridBlockPattern, (_match, columns: string, images: string) => (
      `\n\n\`\`\`everroom-image-grid\n${JSON.stringify({ columns: Number(columns), images })}\n\`\`\`\n\n`
    ))
}

function imageGridData(source: string): { columns: number; images: Array<{ src: string; alt: string }> } | null {
  try {
    const parsed = JSON.parse(source) as { columns?: unknown; images?: unknown }
    if (typeof parsed.images !== 'string') return null
    const images = [...parsed.images.matchAll(localImagePattern)].map((match) => ({
      src: match[2],
      alt: match[1].replace(/\\([\\`*_[\]<>])/g, '$1'),
    }))
    if (images.length < 2) return null
    return { columns: Math.max(2, Math.min(6, Number(parsed.columns) || images.length)), images }
  } catch {
    return null
  }
}

function ImageGrid({ source }: { source: string }) {
  const grid = imageGridData(source)
  if (!grid) return <pre>{source}</pre>
  return (
    <div
      className="clip-image-grid"
      data-columns={grid.columns}
      role="group"
      aria-label="图片组"
      style={{ '--clip-image-columns': grid.columns } as CSSProperties}
    >
      {grid.images.map((image, index) => (
        <figure className="clip-image-grid-item" key={`${image.src}-${index}`}>
          <img src={image.src} alt={image.alt} loading="lazy" />
          {image.alt ? <figcaption>{image.alt}</figcaption> : null}
        </figure>
      ))}
    </div>
  )
}

function ClipImage({ src, alt, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  return (
    <figure className="clip-markdown-image">
      <img {...props} src={src} alt={alt ?? ''} loading="lazy" />
      {alt ? <figcaption>{alt}</figcaption> : null}
    </figure>
  )
}

function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId()
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' })
      const id = `clip-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`
      const rendered = await mermaid.render(id, source)
      if (active) setSvg(rendered.svg)
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '图表语法无法解析')
    })
    return () => { active = false }
  }, [reactId, source])

  if (error) return <figure className="clip-chart clip-chart-error"><figcaption>Mermaid 图表无法渲染</figcaption><pre>{source}</pre></figure>
  return <figure className="clip-chart clip-mermaid" aria-label="Mermaid 图表" dangerouslySetInnerHTML={{ __html: svg }} />
}

function EChartDiagram({ source }: { source: string }) {
  const container = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    let dispose: (() => void) | undefined
    try {
      const option = JSON.parse(source) as Record<string, unknown>
      void import('echarts').then((echarts) => {
        if (!active || !container.current) return
        const chart = echarts.init(container.current, undefined, { renderer: 'canvas' })
        chart.setOption(option)
        const observer = new ResizeObserver(() => chart.resize())
        observer.observe(container.current)
        dispose = () => { observer.disconnect(); chart.dispose() }
      }).catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '图表引擎加载失败')
      })
    } catch {
      setError('ECharts 配置必须是合法 JSON')
    }
    return () => { active = false; dispose?.() }
  }, [source])

  if (error) return <figure className="clip-chart clip-chart-error"><figcaption>{error}</figcaption><pre>{source}</pre></figure>
  return <figure className="clip-chart clip-echart" aria-label="ECharts 图表"><div ref={container} /></figure>
}

function RichPre({ children }: { children?: ReactNode }) {
  if (isValidElement<{ className?: string; children?: ReactNode }>(children)) {
    const language = children.props.className?.match(/language-([\w-]+)/)?.[1]?.toLowerCase()
    const source = sourceText(children.props.children)
    if (language === 'everroom-image-grid') return <ImageGrid source={source} />
    if (language === 'mermaid') return <MermaidDiagram source={source} />
    if (language === 'echarts' || language === 'echart') return <EChartDiagram source={source} />
  }
  return <pre>{children}</pre>
}

function clipUrlTransform(url: string): string {
  if (url.startsWith('nxcore-clipper-asset://local/')) return url
  return defaultUrlTransform(url)
}

export function RichClipMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className="clip-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={clipUrlTransform}
        components={{
          pre: RichPre,
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>,
          img: ClipImage,
        }}
      >
        {displayMarkdown(markdown)}
      </ReactMarkdown>
    </div>
  )
}
