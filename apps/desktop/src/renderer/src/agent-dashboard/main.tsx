import { createRoot } from 'react-dom/client'

import { Dashboard } from './Dashboard'

const container = document.getElementById('agent-dashboard-root')
if (!container) throw new Error('agent-dashboard-root 不存在')

createRoot(container).render(<Dashboard />)
