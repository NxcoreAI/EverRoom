import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import FaConsoleApp from './App'
import './styles.css'

const root = document.getElementById('fa-console-root')
if (root) createRoot(root).render(createElement(FaConsoleApp))
