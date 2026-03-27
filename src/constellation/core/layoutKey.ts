import objectHash from "object-hash";
import type { ConstellationLayoutParams } from "./types";

export function buildConstellationLayoutKey(args: {
  chatIds: string[];
  params: ConstellationLayoutParams;
  embeddingModel: string;
  endpointHash: string;
  latestEmbeddingUpdatedAt: number;
}): string {
  const payload = {
    chatIds: [...args.chatIds].sort(),
    params: args.params,
    embeddingModel: args.embeddingModel,
    endpointHash: args.endpointHash,
    latestEmbeddingUpdatedAt: args.latestEmbeddingUpdatedAt,
  };

  return objectHash(payload, { algorithm: "sha1" });
}
