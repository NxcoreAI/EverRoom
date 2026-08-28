const root = document.documentElement
const themeButton = document.querySelector('[data-theme-toggle]')
const menuButton = document.querySelector('[data-menu-toggle]')
const isChinese = document.documentElement.lang === 'zh-CN'

const applyTheme = (theme) => {
  root.dataset.theme = theme
  themeButton?.setAttribute('aria-label', theme === 'dark' ? 'Use light theme' : 'Use dark theme')
}

applyTheme(localStorage.getItem('everroom-docs-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))

themeButton?.addEventListener('click', () => {
  const theme = root.dataset.theme === 'dark' ? 'light' : 'dark'
  localStorage.setItem('everroom-docs-theme', theme)
  applyTheme(theme)
})

menuButton?.addEventListener('click', () => {
  const open = document.body.classList.toggle('menu-open')
  menuButton.setAttribute('aria-expanded', String(open))
})

document.querySelectorAll('[data-language]').forEach((link) => {
  link.addEventListener('click', () => localStorage.setItem('everroom-docs-language', link.dataset.language))
})

document.querySelectorAll('.sidebar a').forEach((link) => {
  link.addEventListener('click', () => document.body.classList.remove('menu-open'))
})

document.querySelectorAll('pre').forEach((pre) => {
  const code = pre.querySelector('code')
  const button = document.createElement('button')
  button.className = 'copy-button'
  button.type = 'button'
  button.title = isChinese ? '复制代码' : 'Copy code'
  button.setAttribute('aria-label', button.title)
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(code?.innerText || '')
    button.classList.add('is-copied')
    button.title = isChinese ? '已复制' : 'Copied'
    button.setAttribute('aria-label', button.title)
    setTimeout(() => {
      button.classList.remove('is-copied')
      button.title = isChinese ? '复制代码' : 'Copy code'
      button.setAttribute('aria-label', button.title)
    }, 1200)
  })
  pre.append(button)
})

const pages = [...document.querySelectorAll('[data-page]')]
const pageLinks = [...document.querySelectorAll('[data-page-link]')]
const labels = Object.fromEntries(pageLinks.map((link) => [link.dataset.pageLink, link.textContent]))
pages.forEach((page, index) => {
  const navigation = document.createElement('nav')
  navigation.className = 'page-navigation'
  navigation.setAttribute('aria-label', isChinese ? '文档翻页' : 'Documentation pagination')
  for (const [target, direction] of [[pages[index - 1], 'previous'], [pages[index + 1], 'next']]) {
    if (!target) continue
    const link = document.createElement('a')
    link.className = `page-navigation-${direction}`
    link.href = `#${target.dataset.page}`
    link.innerHTML = `<small>${direction === 'previous' ? (isChinese ? '上一页' : 'Previous') : (isChinese ? '下一页' : 'Next')}</small><strong>${labels[target.dataset.page]}</strong>`
    navigation.append(link)
  }
  page.append(navigation)
})

const showPage = (id, scroll = true) => {
  const page = document.querySelector(`[data-page="${id}"]`) || pages[0]
  if (!page) return
  pages.forEach((item) => { item.hidden = item !== page })
  pageLinks.forEach((link) => link.classList.toggle('active', link.dataset.pageLink === page.dataset.page))
  if (scroll) window.scrollTo({ top: 0, behavior: 'instant' })
}

const openRoute = (scroll = true) => {
  const [pageId, sectionId] = location.hash.slice(1).split('/')
  showPage(pageId || pages[0]?.dataset.page, scroll && !sectionId)
  if (sectionId) requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView({ behavior: 'instant', block: 'start' }))
}

pageLinks.forEach((link) => link.addEventListener('click', () => document.body.classList.remove('menu-open')))
addEventListener('hashchange', () => openRoute())
openRoute(false)
