try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile()
  }
} catch {}

import { prisma } from '@grabit/db'
import { closeAllQueues } from '@grabit/queue'
import { runBatch } from './demo-batch/index.js'

const isLive = process.argv.includes('--live-clock')

runBatch({ useLiveClock: isLive })
  .then(async (summary) => {
    await closeAllQueues()
    await prisma.$disconnect()
    if (!summary.passedQAChecks) {
      console.error('QA checks failed')
      process.exit(1)
    }
    process.exit(0)
  })
  .catch(async (err) => {
    console.error('Batch runner failed:', err)
    await closeAllQueues()
    await prisma.$disconnect()
    process.exit(1)
  })
