import * as bfl from "./bfl.js";
import * as anifusion from "./anifusion.js";

// Every model the app offers, keyed by id. BFL ids are bare ("flux-3-image");
// Anifusion ids are "anifusion:<model>". model.provider picks the client.
export const PROVIDERS = {
  bfl: { name: "Black Forest Labs", keyVar: "BFL_API_KEY", client: bfl },
  anifusion: { name: "Anifusion", keyVar: "ANIFUSION_API_KEY", client: anifusion },
};

export const MODELS = {
  ...Object.fromEntries(Object.entries(bfl.MODELS).map(([id, m]) => [id, { ...m, provider: "bfl" }])),
  ...anifusion.MODELS,
};

export function providerOf(model) {
  return PROVIDERS[model.provider];
}
