import { closeDatabase, migrateDatabase } from '../server/db.ts'

try {
  await migrateDatabase()
  console.log('PostgreSQL migrations are up to date.')
} finally {
  await closeDatabase()
}
