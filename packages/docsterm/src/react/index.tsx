'use client'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { AriaAttributes, ForwardRefExoticComponent, HTMLAttributes, RefAttributes } from 'react'
import { DocsTerminal as DocsTerminalWidget } from '../index.js'
import type { DocsTerminalOptions, RunReport } from '../index.js'

type DataAttributes = { [attribute: `data-${string}`]: string | number | boolean | undefined }

type HostAttributes = Pick<HTMLAttributes<HTMLDivElement>, 'id' | 'title' | 'role' | 'className' | 'style'>

type LiveOptions = Parameters<DocsTerminalWidget['setOptions']>[0]

export interface DocsTerminalProps extends DocsTerminalOptions, HostAttributes, AriaAttributes, DataAttributes {
  onReady?: (terminal: DocsTerminalWidget) => void
  onError?: (error: unknown) => void
}

export interface DocsTerminalHandle {
  run(text: string): Promise<RunReport>
  insert(text: string): void
  focus(): void
  clear(): void
}

const HOST_ATTRIBUTES = new Set(['id', 'title', 'role', 'className', 'style'])

const LIVE_OPTIONS = [
  'theme',
  'locale',
  'ai',
  'pageContext',
  'fontFamily',
  'fontSize',
  'ariaLabel',
  'screenReaderMode',
  'onEvent',
] as const satisfies ReadonlyArray<keyof LiveOptions>

const COMPARED_BY_VALUE = new Set<keyof LiveOptions>(['theme', 'pageContext'])

const isHostAttribute = (name: string): boolean =>
  HOST_ATTRIBUTES.has(name) || name.startsWith('aria-') || name.startsWith('data-')

function splitProps(props: Omit<DocsTerminalProps, 'onReady' | 'onError'>) {
  const host: Record<string, unknown> = {}
  const options: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(props)) {
    if (name === 'aria-label') continue
    if (isHostAttribute(name)) host[name] = value
    else options[name] = value
  }
  if (options.ariaLabel === undefined && props['aria-label'] !== undefined) options.ariaLabel = props['aria-label']
  return { host: host as HTMLAttributes<HTMLDivElement>, options: options as unknown as DocsTerminalOptions }
}

const valueKey = (value: unknown): unknown =>
  typeof value === 'object' && value !== null ? JSON.stringify(value) : value

function changedOptions(next: DocsTerminalOptions, applied: DocsTerminalOptions): LiveOptions | null {
  const patch: Record<string, unknown> = {}
  let changed = false
  for (const name of LIVE_OPTIONS) {
    const same = COMPARED_BY_VALUE.has(name)
      ? valueKey(next[name]) === valueKey(applied[name])
      : Object.is(next[name], applied[name])
    if (same) continue
    patch[name] = next[name]
    changed = true
  }
  return changed ? (patch as LiveOptions) : null
}

function notify<T>(callback: ((value: T) => void) | undefined, value: T): void {
  try {
    callback?.(value)
  } catch (error) {
    console.error(error)
  }
}

const notMounted = () => new DOMException('DocsTerminal is not mounted', 'AbortError')

export const DocsTerminal: ForwardRefExoticComponent<DocsTerminalProps & RefAttributes<DocsTerminalHandle>> =
  forwardRef<DocsTerminalHandle, DocsTerminalProps>(function DocsTerminal({ onReady, onError, ...props }, ref) {
    const { host, options } = splitProps(props)
    const container = useRef<HTMLDivElement>(null)
    const widget = useRef<DocsTerminalWidget | null>(null)
    const applied = useRef(options)
    const latest = useRef({ options, onReady, onError })

    useImperativeHandle(
      ref,
      () => ({
        run: (text) => widget.current?.run(text) ?? Promise.reject(notMounted()),
        insert: (text) => widget.current?.insert(text),
        focus: () => widget.current?.focus(),
        clear: () => widget.current?.clear(),
      }),
      [],
    )

    useEffect(() => {
      latest.current = { options, onReady, onError }
      const instance = widget.current
      if (!instance) return
      const patch = changedOptions(options, applied.current)
      if (!patch) return
      applied.current = options
      instance.setOptions(patch)
    })

    useEffect(() => {
      const element = container.current
      if (!element) return
      const instance = new DocsTerminalWidget(latest.current.options)
      let active = true
      widget.current = instance
      applied.current = latest.current.options
      instance.mount(element).then(
        () => {
          if (active) notify(latest.current.onReady, instance)
        },
        (error: unknown) => {
          if (!active) return
          const report = latest.current.onError
          if (report) notify(report, error)
          else console.error(error)
        },
      )
      return () => {
        active = false
        widget.current = null
        instance.dispose()
      }
    }, [options.backend])

    return <div ref={container} {...host} />
  })
