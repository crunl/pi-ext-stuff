/** Model/effort facts for the footer powerline — pure, no Pi imports. */

export interface ResolvedModelInfo {
	modelId: string;
	/** Undefined when the model is not reasoning or thinking is off. */
	effort: string | undefined;
}

export function resolveModelInfo(input: {
	modelId: string;
	reasoning: boolean;
	thinkingLevel: string | undefined;
}): ResolvedModelInfo {
	const level = input.thinkingLevel ?? "off";
	return {
		modelId: input.modelId,
		// "off" is the default — hide the segment rather than label it.
		effort: input.reasoning && level !== "off" ? level : undefined,
	};
}
