import { DocsTerminal as DocsTerminalWidget, type DocsTerminalOptions } from 'docsterm'
import { useEffect, useRef } from 'react'
import type { CSSProperties, JSX } from 'react'

export interface DocsTerminalProps extends DocsTerminalOptions {
  className?: string
  style?: CSSProperties
}

export function DocsTerminal(props: DocsTerminalProps): JSX.Element {
  const { className, style, ...options } = props
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const widget = new DocsTerminalWidget(options)
    if (container.current) void widget.mount(container.current)
    return () => widget.dispose()
  }, [options.backend])

  return <div ref={container} className={className} style={style} />
}
