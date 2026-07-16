import { lazy, Suspense } from 'react'
import Calibre from './Calibre'

/* The WebGL gradient pulls in three.js (~1.3 MB) — lazy-load it so the
   app itself paints immediately. The static fallback approximates the
   gradient's palette until the shader arrives. */
const Background = lazy(() => import('./Background'))

function StaticBackdrop() {
  /* Dark gradient inline as the pre-style default; the Ciel theme
     overrides it from Calibre's stylesheet (see .cal-backdrop rules). */
  return (
    <div
      className="cal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: -2,
        pointerEvents: 'none',
        background:
          'radial-gradient(120% 90% at 80% 10%, #003e91 0%, rgba(0,62,145,0) 60%),' +
          'radial-gradient(100% 80% at 15% 85%, #16617a 0%, rgba(22,97,122,0) 55%),' +
          'linear-gradient(160deg, #0a1440 0%, #021030 55%, #02224a 100%)',
      }}
    />
  )
}

export default function App() {
  return (
    <>
      <StaticBackdrop />
      <Suspense fallback={null}>
        <Background />
      </Suspense>
      <Calibre />
    </>
  )
}
