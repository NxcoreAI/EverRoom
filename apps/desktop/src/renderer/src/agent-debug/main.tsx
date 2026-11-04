import { createRoot } from 'react-dom/client'

import { App } from './App'
import './styles.css'

const container = document.getElementById('agent-debug-root')
if (!container) throw new Error('agent-debug-root 不存在')

createRoot(container).render(<App />)
