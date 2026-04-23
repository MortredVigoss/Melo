/**
 * EmbeddingProvider — narrow contract for turning text into a normalised
 * Float32Array of fixed dimensionality.  Concrete providers live in this
 * directory; the factory in createEmbeddingProvider.js picks one based on
 * MELO_EMBED_PROVIDER and availability.
 *
 * Every provider declares `.dims` (e.g. 1024 for bge-m3) so the store can
 * reject a vector written with the wrong dim.
 */

export class EmbeddingProvider {
  static get providerName() { return 'abstract'; }

  /** @type {number} expected output dimensions */
  get dims() { throw new Error('dims not implemented'); }

  /** @type {string} model identifier, e.g. 'bge-m3' */
  get modelId() { return this.constructor.providerName; }

  /**
   * Produce a unit-length Float32Array(dims) for the given text, or null if
   * the backend is unavailable.
   * @param {string} text
   * @returns {Promise<Float32Array | null>}
   */
  async embed(/* text */) { throw new Error('embed not implemented'); }

  async isAvailable() { return true; }
}

/** L2-normalize in place and return the same array. */
export function l2Normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

export function toDims(arr, dims) {
  if (arr.length === dims) return l2Normalize(arr);
  const out = new Float32Array(dims);
  out.set(arr.slice(0, dims));
  return l2Normalize(out);
}
