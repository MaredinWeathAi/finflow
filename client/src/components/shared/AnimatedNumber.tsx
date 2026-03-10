import { useEffect, useRef, useState } from 'react'

interface AnimatedNumberProps {
  value: number
  duration?: number
  formatter?: (value: number) => string
  className?: string
}

export function AnimatedNumber({
  value,
  duration = 1000,
  formatter = (v) => v.toFixed(2),
  className,
}: AnimatedNumberProps) {
  const [display, setDisplay] = useState(0)
  const prevValue = useRef(0)
  const frameRef = useRef<number>()

  useEffect(() => {
    const start = prevValue.current
    const end = value
    const startTime = performance.now()

    function animate(currentTime: number) {
      const elapsed = currentTime - startTime
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3) // ease-out cubic

      setDisplay(start + (end - start) * eased)

      if (progress < 1) {
        frameRef.current = requestAnimationFrame(animate)
      } else {
        prevValue.current = end
      }
    }

    frameRef.current = requestAnimationFrame(animate)

    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
    }
  }, [value, duration])

  return <span className={className}>{formatter(display)}</span>
}
