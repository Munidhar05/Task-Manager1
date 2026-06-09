// One-time / repeatable RAG backfill: embeds every existing task, meeting,
// transcript segment, and chat message into the embeddings table.
// Run with: npm run rag:index   (needs OPENAI_API_KEY or VOYAGE_API_KEY)
import 'dotenv/config'
import { initSchema } from './db.js'
import { hasEmbeddings, embedModel } from './ai/embeddings.js'
import { backfillAll } from './ai/ragIndex.js'

initSchema()

if (!hasEmbeddings()) {
  console.error('No embedding provider configured. Set OPENAI_API_KEY or VOYAGE_API_KEY in server/.env')
  process.exit(1)
}

console.log(`[rag] backfilling with model "${embedModel()}"...`)
const t0 = Date.now()
const { embedded, skipped } = await backfillAll()
console.log(`[rag] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — embedded ${embedded}, skipped ${skipped} (unchanged).`)
process.exit(0)
