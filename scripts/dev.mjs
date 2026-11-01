import { spawn } from 'node:child_process'

const env = { ...process.env, PYTHON_RESEARCH_URL: process.env.PYTHON_RESEARCH_URL || 'http://127.0.0.1:8790' }
const children = [
  spawn('python', ['python/research_service.py'], { stdio: 'inherit', env }),
  spawn(process.execPath, ['server/index.ts'], { stdio: 'inherit', env }),
  spawn('npm', ['run', 'dev'], { stdio: 'inherit', shell: true, env }),
]

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

for (const child of children) {
  child.on('exit', code => {
    if (!shuttingDown) shutdown(code ?? 0)
  })
}
