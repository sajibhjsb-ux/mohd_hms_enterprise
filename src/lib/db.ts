import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // 'query' logging floods dev.log and churns process memory on every
    // scheduler/poll tick; errors + warnings only (queries remain inspectable
    // via the generated client when needed).
    log: ['error', 'warn'],
    // SQLite (dev) is a single-writer database: long payroll transactions can
    // collide with background scheduler writes and time out. Serializing the
    // connection pool + longer busy/socket timeouts makes writers queue
    // instead of failing. PostgreSQL (production) ignores these URL params.
    ...(process.env.DATABASE_URL?.startsWith('file:')
      ? {
          datasources: {
            db: { url: `${process.env.DATABASE_URL}?connection_limit=1&socket_timeout=30&pool_timeout=30` },
          },
        }
      : {}),
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
