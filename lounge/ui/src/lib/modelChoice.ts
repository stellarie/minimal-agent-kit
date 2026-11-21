export type ModelMode = "default" | "pick" | "custom";

// How the model select shows a saved model: the default, a catalog entry, or free text.
export function modelMode(model: string, models: readonly string[]): ModelMode {
  if (model === "") return "default";
  return models.includes(model) ? "pick" : "custom";
}
