import { getAllSessions } from './db.js';
import { embed, bufferToEmbedding } from './embeddings.js';

function cosineSimilarity(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function searchSessions(query, { limit = 5 } = {}) {
  const queryEmbedding = await embed(query);
  const sessions = getAllSessions();

  const scored = sessions
    .filter((session) => session.embedding)
    .map((session) => {
      const sessionEmbedding = bufferToEmbedding(session.embedding);
      const score = cosineSimilarity(queryEmbedding, sessionEmbedding);
      return { ...session, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}
