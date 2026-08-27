// @vitest-environment happy-dom

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Capture = {
  extractionMode: string
  markdown: string
  assets: Array<{ originalUrl: string; altText: string }>
}

let captureListener: ((message: Record<string, unknown>, sender: unknown, respond: (capture: Capture | null) => void) => boolean) | null

async function loadContentScript(): Promise<void> {
  const scriptPath = resolve(process.cwd(), '../browser-extension/content-script.js')
  const source = await readFile(scriptPath, 'utf8')
  window.eval(source)
}

async function loadBundledReadability(): Promise<void> {
  const scriptPath = resolve(process.cwd(), '../browser-extension/vendor/Readability.js')
  const source = await readFile(scriptPath, 'utf8')
  window.eval(source)
}

async function capture(selectionText = ''): Promise<Capture> {
  await loadContentScript()
  let result: Capture | null = null
  captureListener?.({ type: 'everroom:capture', selectionText }, null, (value) => { result = value })
  if (!result) throw new Error('capture did not return a result')
  return result
}

beforeEach(() => {
  ;(window as unknown as { happyDOM: { setURL(value: string): void } }).happyDOM.setURL('https://example.com/gallery')
  document.head.innerHTML = '<title>Image gallery</title>'
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
  captureListener = null
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn((listener) => { captureListener = listener }) },
    },
  })
})

describe('browser extension content extraction', () => {
  it('recovers media from the live page when Readability keeps only text', async () => {
    document.head.insertAdjacentHTML('beforeend', '<meta property="og:image" content="https://cdn.example.com/social.jpg">')
    document.body.innerHTML = `<main>
      <picture>
        <source srcset="https://cdn.example.com/hero-small.webp 1x, https://cdn.example.com/hero-large.webp 2x">
        <img src="https://cdn.example.com/placeholder.jpg" alt="Hero" width="1200" height="800">
      </picture>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="https://cdn.example.com/lazy.jpg" alt="Lazy project" width="900" height="600">
      <div style="background-image: url('https://cdn.example.com/background.png')" aria-label="Background artwork" width="700" height="500"></div>
    </main>`
    vi.stubGlobal('Readability', class {
      parse() {
        return { content: '<article><p>Readable text only.</p></article>', textContent: 'Readable text only.', title: 'Image gallery' }
      }
    })

    const result = await capture()

    expect(result.extractionMode).toBe('article')
    expect(result.markdown).toContain('Readable text only.')
    expect(result.assets.map(({ originalUrl }) => originalUrl)).toEqual(expect.arrayContaining([
      'https://cdn.example.com/hero-large.webp',
      'https://cdn.example.com/lazy.jpg',
      'https://cdn.example.com/background.png',
    ]))
    expect(result.assets.map(({ originalUrl }) => originalUrl)).not.toContain('https://cdn.example.com/social.jpg')
    expect(result.markdown.match(/nxcore-clipper-asset:\/\/local\//g)).toHaveLength(3)
  })

  it('only acquires principal article images before upload and VLM processing', async () => {
    document.body.innerHTML = `<article>
      <p>The article compares two product strategies in detail.</p>
      <figure><img src="https://cdn.example.com/product-chart.png" alt="Product comparison chart" width="900" height="600"><figcaption>Product comparison</figcaption></figure>
      <section class="author-profile"><img src="https://cdn.example.com/avatar.png" alt="Author" width="240" height="240"></section>
      <section class="related-posts"><img src="https://cdn.example.com/related-cover.jpg" alt="Related article" width="800" height="500"></section>
      <aside><img src="https://cdn.example.com/course-ad.jpg" alt="Course promotion" width="800" height="300"></aside>
      <footer><img src="https://cdn.example.com/follow-qr.png" alt="Follow account" width="320" height="320"></footer>
      <p>Only evidence from the comparison chart belongs to the article body.</p>
    </article>`
    vi.stubGlobal('Readability', class {
      constructor(private readonly page: Document) {}
      parse() {
        const article = this.page.querySelector('article')
        return { content: article?.outerHTML ?? '', textContent: article?.textContent ?? '', title: 'Product analysis' }
      }
    })

    const result = await capture()

    expect(result.assets.map(({ originalUrl }) => originalUrl)).toEqual(['https://cdn.example.com/product-chart.png'])
    expect(result.markdown).toContain('Product comparison chart')
    expect(result.markdown).not.toContain('avatar.png')
    expect(result.markdown).not.toContain('related-cover.jpg')
    expect(result.markdown).not.toContain('course-ad.jpg')
    expect(result.markdown).not.toContain('follow-qr.png')
  })

  it('removes recommendation modules identified by their visible heading', async () => {
    document.body.innerHTML = `<article>
      <h1>Workspace lighting guide</h1>
      <p>This article explains how diffuse light reduces glare during long working sessions.</p>
      <figure><img src="https://cdn.example.com/article-diagram.jpg" alt="Lighting diagram" width="960" height="640"></figure>
      <div class="content-module">
        <h2>推荐专题</h2>
        <div class="cards">
          <a href="https://example.com/topic-a"><img src="https://cdn.example.com/topic-a.jpg" alt="Topic A" width="800" height="500"></a>
          <a href="https://example.com/topic-b"><img src="https://cdn.example.com/topic-b.jpg" alt="Topic B" width="800" height="500"></a>
        </div>
      </div>
    </article>`
    vi.stubGlobal('Readability', class {
      constructor(private readonly page: Document) {}
      parse() {
        const article = this.page.querySelector('article')
        return { content: article?.outerHTML ?? '', textContent: article?.textContent ?? '', title: 'Workspace lighting guide' }
      }
    })

    const result = await capture()

    expect(result.assets.map(({ originalUrl }) => originalUrl)).toEqual(['https://cdn.example.com/article-diagram.jpg'])
    expect(result.markdown).toContain('Lighting diagram')
    expect(result.markdown).not.toContain('推荐专题')
    expect(result.markdown).not.toContain('topic-a.jpg')
    expect(result.markdown).not.toContain('topic-b.jpg')
  })

  it('scopes supplemental media to the matched article container on pages without semantic article markup', async () => {
    document.body.innerHTML = `<div class="main-content">
      <div class="article--wrapper">
        <h2 class="article--title">三大方面，分析 to B 和 to C 产品的区别</h2>
        <div class="stream-list-meta author"><img src="https://static.example.com/tag/1101_1@2x.png" width="16" height="16"></div>
        <div class="article--content">
          <p>企业产品与消费产品面向不同的决策者，因此需求分析和产品设计的方法也不同。</p>
          <img src="https://cdn.example.com/product-model.png" alt="产品模式对比" width="960" height="640">
          <p>理解购买者、使用者和决策链条，才能为两类产品选择合适的设计方法。</p>
        </div>
      </div>
      <div class="stream-topics js-topic-list" data-dts-event-location="recom_topic_module">
        <nav class="stream-video--title"><span class="title">推荐专题</span><a href="/topic-list">更多专题</a></nav>
        <div class="stream-list-topic">
          <a href="/topic/a"><img src="https://cdn.example.com/recommended-a.jpg" width="800" height="500"></a>
          <a href="/topic/b"><img src="https://cdn.example.com/recommended-b.jpg" width="800" height="500"></a>
        </div>
      </div>
    </div>`
    vi.stubGlobal('Readability', class {
      parse() {
        return {
          content: '<article><p>企业产品与消费产品面向不同的决策者，因此需求分析和产品设计的方法也不同。</p><p>理解购买者、使用者和决策链条，才能为两类产品选择合适的设计方法。</p></article>',
          textContent: '企业产品与消费产品面向不同的决策者，因此需求分析和产品设计的方法也不同。理解购买者、使用者和决策链条，才能为两类产品选择合适的设计方法。',
          title: '三大方面，分析 to B 和 to C 产品的区别',
        }
      }
    })

    const result = await capture()

    expect(result.assets.map(({ originalUrl }) => originalUrl)).toEqual(['https://cdn.example.com/product-model.png'])
    expect(result.markdown).toContain('产品模式对比')
    expect(result.markdown).not.toContain('推荐专题')
    expect(result.markdown).not.toContain('recommended-a.jpg')
    expect(result.markdown).not.toContain('recommended-b.jpg')
    expect(result.markdown).not.toContain('1101_1@2x.png')
  })

  it('filters related-content headings without treating prose recommendations as modules', async () => {
    document.body.innerHTML = `<main>
      <article>
        <h1>Camera notes</h1>
        <p>I recommend keeping this annotated reference image with the article.</p>
        <img src="https://cdn.example.com/reference.jpg" alt="Annotated reference" width="900" height="600">
        <div><h3>You may also like</h3><div><a href="/next"><img src="https://cdn.example.com/next.jpg" alt="Next story" width="900" height="600"></a></div></div>
      </article>
    </main>`
    vi.stubGlobal('Readability', class {
      constructor(private readonly page: Document) {}
      parse() {
        const article = this.page.querySelector('article')
        return { content: article?.outerHTML ?? '', textContent: article?.textContent ?? '', title: 'Camera notes' }
      }
    })

    const result = await capture()

    expect(result.markdown).toContain('I recommend keeping this annotated reference image')
    expect(result.assets.map(({ originalUrl }) => originalUrl)).toEqual(['https://cdn.example.com/reference.jpg'])
    expect(result.markdown).not.toContain('You may also like')
    expect(result.markdown).not.toContain('next.jpg')
  })

  it('cuts a direct recommendation range without removing the surrounding article', async () => {
    document.body.innerHTML = `<article>
      <h1>Mechanical keyboard notes</h1>
      <p>The switch diagram is part of the article.</p>
      <img src="https://cdn.example.com/switch-diagram.jpg" alt="Switch diagram" width="900" height="600">
      <h2>相关阅读</h2>
      <div><a href="/guide-a"><img src="https://cdn.example.com/guide-a.jpg" alt="Guide A" width="800" height="500"></a></div>
      <div><a href="/guide-b"><img src="https://cdn.example.com/guide-b.jpg" alt="Guide B" width="800" height="500"></a></div>
      <h2>Testing notes</h2>
      <p>This real article section must remain after the related links.</p>
    </article>`
    vi.stubGlobal('Readability', class {
      constructor(private readonly page: Document) {}
      parse() {
        const article = this.page.querySelector('article')
        return { content: article?.outerHTML ?? '', textContent: article?.textContent ?? '', title: 'Mechanical keyboard notes' }
      }
    })

    const result = await capture()

    expect(result.markdown).toContain('The switch diagram is part of the article.')
    expect(result.markdown).toContain('This real article section must remain')
    expect(result.assets.map(({ originalUrl }) => originalUrl)).toEqual(['https://cdn.example.com/switch-diagram.jpg'])
    expect(result.markdown).not.toContain('相关阅读')
    expect(result.markdown).not.toContain('guide-a.jpg')
    expect(result.markdown).not.toContain('guide-b.jpg')
  })

  it('matches Readability output to the correct source article when a page contains several articles', async () => {
    document.body.innerHTML = `<main>
      <article class="feed-card"><h2>Recommended story</h2><p>A short unrelated teaser.</p><img src="https://cdn.example.com/teaser.jpg" alt="Teaser" width="700" height="400"></article>
      <article class="post-content"><h1>Deep product analysis</h1><p>This is the complete article body with the evidence and conclusions used for the product comparison.</p><img src="https://cdn.example.com/evidence.png" alt="Article evidence" width="900" height="600"></article>
    </main>`
    vi.stubGlobal('Readability', class {
      constructor(private readonly page: Document) {}
      parse() {
        const article = this.page.querySelector('.post-content')
        return { content: article?.outerHTML ?? '', textContent: article?.textContent ?? '', title: 'Deep product analysis' }
      }
    })

    const result = await capture()

    expect(result.assets.map(({ originalUrl }) => originalUrl)).toEqual(['https://cdn.example.com/evidence.png'])
    expect(result.markdown).toContain('complete article body')
    expect(result.markdown).not.toContain('teaser.jpg')
  })

  it('keeps a text-only selection scoped instead of adding page media', async () => {
    document.body.innerHTML = '<main><p>Page copy</p><img src="https://cdn.example.com/outside.jpg" width="900" height="600"></main>'
    vi.stubGlobal('Readability', class { parse() { return null } })

    const result = await capture('Only this selected sentence')

    expect(result.extractionMode).toBe('selection')
    expect(result.markdown).toContain('Only this selected sentence')
    expect(result.assets).toEqual([])
  })

  it('preserves side-by-side image groups as explicit layout structure', async () => {
    document.body.innerHTML = `<main>
      <p>Comparison</p>
      <div class="product-photo-grid columns-2" style="display: grid; grid-template-columns: repeat(2, 1fr)">
        <figure><a href="https://example.com/before"><img src="https://cdn.example.com/before.jpg" alt="Before" width="600" height="400"></a><figcaption>Before</figcaption></figure>
        <figure><img src="https://cdn.example.com/after.jpg" alt="After" width="600" height="400"><figcaption>After</figcaption></figure>
      </div>
      <p>Conclusion</p>
      <img src="https://cdn.example.com/standalone.jpg" alt="Standalone" width="900" height="600">
    </main>`
    vi.stubGlobal('Readability', class {
      constructor(private readonly page: Document) {}
      parse() {
        const main = this.page.querySelector('main')
        return { content: main?.innerHTML ?? '', textContent: main?.textContent ?? '', title: 'Image comparison' }
      }
    })

    const result = await capture()

    expect(result.markdown).toContain('<!-- everroom:image-grid:start columns=2 -->')
    expect(result.markdown).toMatch(/image-grid:start columns=2[\s\S]*Before[\s\S]*After[\s\S]*image-grid:end/)
    expect(result.markdown).toContain('](https://example.com/before)')
    expect(result.markdown.indexOf('Before')).toBeLessThan(result.markdown.indexOf('After'))
    expect(result.markdown.indexOf('image-grid:end')).toBeLessThan(result.markdown.indexOf('Standalone'))
  })

  it('keeps images that are wrapped by ordinary page links', async () => {
    document.body.innerHTML = `<main><p>
      <a href="https://example.com/full-size"><img src="https://cdn.example.com/linked.jpg" alt="Linked image" width="800" height="500"></a>
      Read the image description.
    </p></main>`
    vi.stubGlobal('Readability', class {
      constructor(private readonly page: Document) {}
      parse() {
        const main = this.page.querySelector('main')
        return { content: main?.innerHTML ?? '', textContent: main?.textContent ?? '', title: 'Linked image' }
      }
    })

    const result = await capture()

    expect(result.markdown).toContain('[![Linked image](nxcore-clipper-asset://local/')
    expect(result.markdown).toContain('](https://example.com/full-size)')
    expect(result.markdown.match(/nxcore-clipper-asset:\/\/local\//g)).toHaveLength(1)
  })

  it('preserves titles and code from ARIA step lists before Readability runs', async () => {
    document.head.innerHTML = '<title>Testing guide</title>'
    document.body.innerHTML = `<main>
      <h2>Use tests</h2>
      <span data-as="p">Add tests for code without coverage.</span>
      <div role="list" class="steps">
        <div role="listitem" class="step">
          <div data-component-part="step-line"></div>
          <div data-component-part="step-number"><div>1</div></div>
          <div>
            <p data-component-part="step-title">Identify untested code</p>
            <div data-component-part="step-content">
              <div data-floating-buttons="true"><button><span>Copy code</span></button></div>
              <pre language="text"><code language="text">find functions without tests</code></pre>
            </div>
          </div>
        </div>
        <div role="listitem" class="step">
          <div data-component-part="step-number"><div>2</div></div>
          <div>
            <p data-component-part="step-title">Run and verify tests</p>
            <div data-component-part="step-content"><pre><code class="language-bash">pnpm test</code></pre></div>
          </div>
        </div>
      </div>
    </main>`
    vi.stubGlobal('Readability', class {
      constructor(private readonly page: Document) {}
      parse() {
        const content = this.page.querySelector('main')?.innerHTML ?? ''
        return { content, textContent: this.page.querySelector('main')?.textContent ?? '', title: 'Testing guide' }
      }
    })

    const result = await capture()

    expect(result.markdown).toContain('Add tests for code without coverage.')
    expect(result.markdown).toMatch(/1\.\s+Identify untested code/)
    expect(result.markdown).toMatch(/2\.\s+Run and verify tests/)
    expect(result.markdown).toContain('```text\nfind functions without tests\n```')
    expect(result.markdown).toContain('```bash\npnpm test\n```')
    expect(result.markdown).not.toContain('Copy code')
    expect(result.markdown).not.toMatch(/1\s*\n\s*1\./)
  })

  it('preserves ARIA step lists with the bundled Mozilla Readability parser', async () => {
    document.head.innerHTML = '<title>Testing workflow</title>'
    document.body.innerHTML = `<main id="content">
      <article>
        <h1>Testing workflow</h1>
        <p>This guide explains how to find missing coverage, generate useful tests, and validate the final result without losing the structure of the workflow.</p>
        <div role="list" class="steps">
          <div role="listitem" class="step">
            <div data-component-part="step-number"><div>1</div></div>
            <div class="w-full overflow-hidden"><p data-component-part="step-title">Find uncovered functions</p><div data-component-part="step-content"><pre language="text"><code language="text">find functions in NotificationsService.swift that are not covered by tests</code></pre></div></div>
          </div>
          <div role="listitem" class="step">
            <div data-component-part="step-number"><div>2</div></div>
            <div class="w-full overflow-hidden"><p data-component-part="step-title">Generate the test scaffold</p><div data-component-part="step-content"><pre language="text"><code language="text">add tests for the notification service</code></pre></div></div>
          </div>
        </div>
        <p>Clear test requests identify the behavior under test, include expected edge cases, and follow the conventions already present in the repository.</p>
      </article>
    </main>`
    await loadBundledReadability()

    const result = await capture()

    expect(result.extractionMode).toBe('article')
    expect(result.markdown).toMatch(/1\.\s+Find uncovered functions/)
    expect(result.markdown).toMatch(/2\.\s+Generate the test scaffold/)
    expect(result.markdown).toContain('find functions in NotificationsService.swift that are not covered by tests')
    expect(result.markdown).toContain('add tests for the notification service')
  })
})
