import { ShaderGradientCanvas, ShaderGradient } from '@shadergradient/react'

export default function Background() {
  return (
    <ShaderGradientCanvas style={{ position: 'absolute', inset: 0 }}>
      <ShaderGradient
        control="props"
        type="waterPlane"
        color1="#ff5005"
        color2="#dbba95"
        color3="#d0bce1"
        animate="on"
        uSpeed={0.3}
      />
    </ShaderGradientCanvas>
  )
}
