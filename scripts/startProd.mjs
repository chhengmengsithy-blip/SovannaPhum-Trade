import { spawn } from 'node:child_process'

const env = {
  ...process.env,
  PYTHON_RESEARCH_URL: process.env.PYTHON_RESEARCH_URL || 'http://127.0.0.1:8790',
}

const pythonCommand = process.platform === 'win32' ? 'python' : 'python3'
const research = spawn(pythonCommand, ['python/research_service.py'], { stdio: 'inherit', env })
const server = spawn(process.execPath, ['dist-server/index.mjs'], { stdio: 'inherit', env })
const children = [research, server]

let shuttingDown = false
function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill()
  }
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

research.on('error', error => {
  console.error(`[research] Could not start Python Playbook Lab: ${error.message}`)
})
server.on('error', error => {
  console.error(`[server] Could not start production server: ${error.message}`)
  shutdown(1)
})
server.on('exit', code => {
  if (!shuttingDown) shutdown(code ?? 1)
})
research.on('exit', code => {
  if (!shuttingDown && code !== 0) {
    console.error(`[research] Python Playbook Lab exited with code ${code}.`)
  }
})
