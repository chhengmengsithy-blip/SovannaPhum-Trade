import { existsSync } from 'node:fs'

// Load local configuration before any module reads process.env.
for (const file of ['server/.env', '.env', '.env.local']) {
  if (!existsSync(file)) continue
  try {
    process.loadEnvFile(file)
  } catch {
    /* ignore malformed env files */
  }
}
