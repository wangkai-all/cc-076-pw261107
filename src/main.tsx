import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './ui/App'
import './ui/styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root 容器')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
