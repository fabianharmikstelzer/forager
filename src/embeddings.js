import { pipeline } from '@huggingface/transformers';

let _embedder = null;

export async function getEmbedder() {
  if (_embedder) return _embedder;
  _embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    dtype: 'fp32',
  });
  return _embedder;
}

export async function embed(text) {
  const embedder = await getEmbedder();
  const result = await embedder(text, { pooling: 'mean', normalize: true });
  // result is a Tensor; convert to a plain Float32Array
  return new Float32Array(result.data);
}

export function embeddingToBuffer(embedding) {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

export function bufferToEmbedding(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
