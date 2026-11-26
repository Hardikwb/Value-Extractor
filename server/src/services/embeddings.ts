import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

/** Stored on each video so vectors from a different model are never compared. */
// Bump the suffix whenever how videos are indexed changes; videos with an older value are rebuilt on re-add.
export const EMBED_MODEL_ID = "bge-small-en-v1.5/en-captions/v2";
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

let extractor: Promise<FeatureExtractionPipeline> | null = null;
const getExtractor = () =>
  (extractor ??= pipeline("feature-extraction", "Xenova/bge-small-en-v1.5") as Promise<FeatureExtractionPipeline>);

async function run(texts: string[]): Promise<number[][]> {
  const ex = await getExtractor();
  const out = await ex(texts, { pooling: "cls", normalize: true }); // bge uses CLS pooling
  return out.tolist() as number[][];
}

export async function embedQuery(text: string): Promise<number[]> {
  return (await run([QUERY_PREFIX + text]))[0];
}

export async function embedDocs(texts: string[], batch = 16, onBatch?: (done: number) => void): Promise<number[][]> {
  const res: number[][] = [];
  for (let i = 0; i < texts.length; i += batch) {
    res.push(...(await run(texts.slice(i, i + batch))));
    onBatch?.(res.length);
  }
  return res;
}
