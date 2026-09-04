// Env is loaded by the `demo:batch` npm script via `--env-file-if-exists=.env`
// (before ESM static imports run). This entrypoint only wires teardown +
// exit codes so piped stdout (the scoreboard table) always flushes.
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
      process.exitCode = 1
      return
    }
    process.exitCode = 0
  })
  .catch(async (err) => {
    console.error('Batch runner failed:', err)
    await closeAllQueues()
    await prisma.$disconnect()
    process.exitCode = 1
  })
