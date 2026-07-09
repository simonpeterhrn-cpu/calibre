import { ShaderGradientCanvas, ShaderGradient } from '@shadergradient/react'

export default function Background() {
  return (
    <>
      <ShaderGradientCanvas
        style={{
          position: 'fixed',
          inset: 0,
          width: '100vw',
          height: '100vh',
          zIndex: -2,
          pointerEvents: 'none',
        }}
      >
        <ShaderGradient
          control="query"
          urlString="https://shadergradient.co/customize?animate=on&axesHelper=off&brightness=1.2&cAzimuthAngle=180&cDistance=3.6&cPolarAngle=90&cameraZoom=1&color1=%23394988&color2=%23003e91&color3=%2356e1e8&destination=onCanvas&embedMode=off&envPreset=city&format=gif&fov=45&frameRate=10&gizmoHelper=hide&grain=on&lightType=3d&pixelDensity=1&positionX=-1.4&positionY=0&positionZ=0&range=disabled&rangeEnd=33.8&rangeStart=0&reflection=0.1&rotationX=0&rotationY=10&rotationZ=50&shader=defaults&type=waterPlane&uAmplitude=1&uDensity=1.3&uFrequency=5.5&uSpeed=0.05&uStrength=4&uTime=0&wireframe=false"
        />
      </ShaderGradientCanvas>
      {/* Dark veil — tames the gradient while keeping its depth visible */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(2, 8, 30, 0.55)',
          zIndex: -1,
          pointerEvents: 'none',
        }}
      />
    </>
  )
}
