import React from 'react'

// The centrepiece of the immersive voice screen. Three distinct visuals, one per
// phase of a command, so a glance tells you what the assistant is doing:
//
//   listening  — woven orbit rings + a live waveform
//   thinking   — a neural-mesh brain with a sweeping scan arc
//   executing  — the same brain carrying a bolt, inside a segmented progress ring
//
// It's drawn rather than animated-GIF'd so it scales to the compact size the
// stage collapses to once there are messages, and costs nothing to ship.

// Hand-placed mesh nodes, in the brain's own 0 0 220 210 coordinate space. Fixed
// rather than generated so the mesh is identical on every render (a regenerated
// mesh visibly reshuffles when React re-renders mid-session) and so the dense
// cluster lands where the brain is widest.
const NODES: [number, number][] = [
  [110, 34], [86, 38], [134, 40], [64, 50], [156, 52], [46, 68], [174, 70],
  [38, 90], [182, 92], [60, 86], [160, 88], [86, 66], [134, 68], [110, 60],
  [110, 88], [88, 96], [132, 98], [52, 110], [168, 112], [72, 118], [148, 120],
  [100, 116], [120, 116], [86, 134], [134, 136], [110, 140], [110, 158],
  [98, 168], [122, 168], [110, 176],
]
// Edges are every pair closer than this — computed once at module load, not per
// render. Squared distance, so no square roots in the loop.
const EDGES: [number, number][] = (() => {
  const out: [number, number][] = []
  for (let i = 0; i < NODES.length; i++) {
    for (let j = i + 1; j < NODES.length; j++) {
      const dx = NODES[i][0] - NODES[j][0]
      const dy = NODES[i][1] - NODES[j][1]
      if (dx * dx + dy * dy < 42 * 42) out.push([i, j])
    }
  }
  return out
})()

// Silhouette: two mirrored halves plus a stem. Split in halves rather than one
// closed blob so the centre line reads as the fissure between hemispheres.
const BRAIN_L = 'M110 30C98 20 76 20 68 32C52 30 40 42 42 56C28 62 24 82 34 92C26 104 32 122 46 126C50 140 66 148 80 142C88 152 100 152 110 146'
const BRAIN_R = 'M110 30C122 20 144 20 152 32C168 30 180 42 178 56C192 62 196 82 186 92C194 104 188 122 174 126C170 140 154 148 140 142C132 152 120 152 110 146'
const BRAIN_STEM = 'M110 146V178M110 160L98 170M110 160L122 170'
// Cortex folds — four sweeps that stop the mesh reading as a plain blob.
const FOLDS = [
  'M78 52C92 62 92 78 76 84',
  'M142 54C128 64 128 80 144 86',
  'M62 100C78 104 86 116 78 128',
  'M158 102C142 106 134 118 142 130',
]

const BrainMesh = ({ bolt }: { bolt?: boolean }) => (
  <svg className="va-brain" viewBox="0 0 220 210" fill="none" aria-hidden="true">
    <g className="va-brain-mesh">
      {EDGES.map(([a, b], i) => (
        <line key={i} x1={NODES[a][0]} y1={NODES[a][1]} x2={NODES[b][0]} y2={NODES[b][1]} />
      ))}
    </g>
    <g className="va-brain-line">
      <path d={BRAIN_L} /><path d={BRAIN_R} /><path d={BRAIN_STEM} />
      {FOLDS.map((d, i) => <path key={i} d={d} className="va-brain-fold" />)}
    </g>
    <g className="va-brain-nodes">
      {NODES.map(([x, y], i) => (
        // Staggered by index so the whole mesh twinkles instead of blinking in unison.
        <circle key={i} cx={x} cy={y} r={2.1} style={{ animationDelay: `${(i % 7) * 0.28}s` }} />
      ))}
    </g>
    {bolt && <path className="va-brain-bolt" d="M118 68 96 112h16l-8 34 26-46h-16z" />}
  </svg>
)

export default function VoiceOrb({ state }: { state: string }) {
  const listening = state === 'listening'
  const thinking = state === 'processing'
  const executing = state === 'speaking' || state === 'confirming'
  return (
    <span className="va-orb-art" aria-hidden="true">
      {/* Static concentric rings — the shared frame every phase sits inside. */}
      <span className="va-orb-ring va-orb-ring--3" />
      <span className="va-orb-ring va-orb-ring--2" />
      <span className="va-orb-ring" />

      {listening && (
        <>
          {/* Four ellipses at different aspect ratios and speeds; where they cross
              they weave, which is what gives the sphere-of-orbits look. */}
          <span className="va-orbit va-orbit--1" />
          <span className="va-orbit va-orbit--2" />
          <span className="va-orbit va-orbit--3" />
          <span className="va-orbit va-orbit--4" />
          <span className="va-wave">{Array.from({ length: 15 }).map((_, i) => <i key={i} />)}</span>
        </>
      )}

      {(thinking || executing) && <BrainMesh bolt={executing} />}
      {/* Thinking gets one bright arc orbiting the mesh; executing gets a
          segmented ring, so the two states never look like the same screen. */}
      {thinking && <span className="va-scan" />}
      {executing && <span className="va-progress" />}

      {state === 'idle' && <span className="va-orb-core" />}
      {state === 'error' && <span className="va-orb-core va-orb-core--error" />}
    </span>
  )
}
