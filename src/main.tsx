import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import App from './App'
import './styles/index.css'

// Theme: a saved in-app choice wins; otherwise follow the OS (prefers-color-scheme),
// defaulting to dark. file:// localStorage can throw, so guard it.
try {
  const saved = localStorage.getItem('jb-theme')
  const osLight = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
  const light = saved === 'light' || (saved == null && osLight)
  document.documentElement.classList.toggle('dark', !light)
} catch {
  document.documentElement.classList.add('dark')
}

// IMPORTANT (file://): the production bundle is a CLASSIC script injected into <head>, so it runs
// BEFORE <div id="root"> is parsed. Wait for the DOM before mounting, or createRoot would get null.
function mount() {
  const el = document.getElementById('root')
  if (!el) return
  // reducedMotion="user" makes every motion/react animation honor the OS "reduce motion" setting
  // (the CSS media query only tames CSS animations, not framer-motion's JS-driven ones).
  createRoot(el).render(
    <StrictMode>
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </StrictMode>,
  )
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true })
} else {
  mount()
}
