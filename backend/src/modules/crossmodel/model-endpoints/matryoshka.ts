/**
 * Matryoshka (MRL) truncation — shared by the RAG runtime (rag.service
 * embedTextsCustom) and the admin probe (model-roles probeEmbeddings) so the
 * Test button predicts runtime exactly.
 *
 * MRL-trained embedding models (Qwen3-Embedding, OpenAI text-embedding-3,
 * nomic-embed v1.5…) are trained so that any LEADING prefix of the vector is
 * itself a valid lower-fidelity embedding; the canonical `dimensions` /
 * `truncate_dim` operation is "keep the first N components, L2-normalize". That
 * is what DashScope does server-side for text-embedding-v4 (Alibaba's hosted
 * Qwen3-Embedding) when Digby asks for `dimensions: 1536`, and what vLLM does
 * only when the served model is Matryoshka-flagged (`is_matryoshka`). Doing it
 * client-side is therefore faithful for FLAGGED models — and silently
 * corrupting for anything else, which is why callers only apply it when the
 * admin set the registry model's `matryoshka` flag.
 */

export function truncateMatryoshka(vec: number[], dims: number): number[] {
  if (vec.length < dims) throw new Error(`cannot truncate a ${vec.length}-dim vector to ${dims}`);
  const head = vec.slice(0, dims);
  let sumSq = 0;
  for (const x of head) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (!Number.isFinite(norm) || norm === 0) return head;
  return head.map(x => x / norm);
}
