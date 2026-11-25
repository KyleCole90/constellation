import * as v from "valibot";

export const AiSourceSchema = v.picklist(["none", "key", "claude-code"]);
export type AiSource = v.InferOutput<typeof AiSourceSchema>;
