import type { Backend } from 'docsterm'
import { createShellBackend, type ShellCommand } from 'docsterm/shell'

const BUILD_STEPS = ['resolving manifest', 'bundling 42 modules', 'optimising assets', 'writing sourcemaps', 'uploading']
const BUILD_STEP_MS = 700

const sleep = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })

const buildCommand: ShellCommand = async (ctx) => {
  for (const [index, step] of BUILD_STEPS.entries()) {
    if (ctx.signal?.aborted) return { exitCode: 130 }
    ctx.write?.(`[${index + 1}/${BUILD_STEPS.length}] ${step}...\n`)
    await sleep(BUILD_STEP_MS, ctx.signal)
  }
  if (ctx.signal?.aborted) return { exitCode: 130 }
  return { stdout: 'build complete in 3.5s\n' }
}

const orbitCommand: ShellCommand = (ctx) => {
  const [, sub, ...rest] = ctx.argv
  switch (sub) {
    case 'init':
      ctx.fs.write(ctx.fs.resolve(ctx.cwd, 'orbit.toml'), 'name = "demo"\nregion = "eu-central"\n')
      return 'Created orbit.toml\nProject initialized.\n'
    case 'deploy':
      return 'Uploading bundle... done\nDeployed to https://demo.orbit.app\n'
    case 'status':
      return 'status: RUNNING\nregion: eu-central\nversion: 14\n'
    case 'destroy':
      return rest.includes('--force')
        ? 'Deployment destroyed.\n'
        : { stderr: 'error: refusing to destroy a RUNNING deployment (use --force)\n', exitCode: 1 }
    case 'help':
    case undefined:
      return 'commands: init, deploy, status, destroy [--force], help\n'
    default:
      return { stderr: `orbit: unknown command '${sub}'\n`, exitCode: 2 }
  }
}

export function createOrbitBackend(banner: string): Backend {
  return createShellBackend({
    banner,
    cwd: '/project',
    env: { PROJECT: 'orbit' },
    prompt: (cwd) => `${cwd} $ `,
    files: {
      project: {
        'README.md': '# demo app\n\nDeployed with the orbit CLI.\nRun `orbit help` to start.\n',
        'regions.csv': 'name,region\nalpha,eu-central\nbeta,us-east\ngamma,eu-west\n',
        src: {
          'index.ts': "export const handler = () => 'hello from orbit'\n",
          'config.ts': 'export const region = "eu-central"\n',
        },
      },
    },
    commands: { orbit: orbitCommand, build: buildCommand },
  })
}
