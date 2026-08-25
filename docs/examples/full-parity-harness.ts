import {
	Command,
	END,
	MemorySaver,
	START,
	StateGraph,
	StateSchema,
	interrupt,
} from '@langchain/langgraph'
/**
 * REFERENCE: a parity-oriented harness boundary.
 *
 * AI SDK performs one model step. LangGraph checkpoints control flow. Atlas
 * owns policy, idempotent tool execution, events, and workspace snapshots.
 */
import type { LanguageModel, LanguageModelCallOptions, ModelMessage, ToolSet } from 'ai'
import { streamText, tool } from 'ai'
import { z } from 'zod'

const ToolInput = z.record(z.string(), z.unknown())

const PendingTool = z.object({
	callId: z.string(),
	name: z.string(),
	input: ToolInput,
})
type PendingTool = z.infer<typeof PendingTool>

const PolicyDecision = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('allow'), input: ToolInput }),
	z.object({ kind: z.literal('deny'), reason: z.string() }),
	z.object({ kind: z.literal('ask'), input: ToolInput, reason: z.string() }),
])
type PolicyDecision = z.infer<typeof PolicyDecision>

const HumanDecision = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('allow') }),
	z.object({ kind: z.literal('deny'), reason: z.string() }),
	z.object({ kind: z.literal('edit'), input: ToolInput }),
])
export type HumanDecision = z.infer<typeof HumanDecision>

const HarnessState = new StateSchema({
	runId: z.string(),
	// In production, store canonical messages in Atlas and checkpoint a cursor.
	messages: z.custom<ModelMessage[]>().default(() => []),
	pendingTools: z.array(PendingTool).default(() => []),
	decision: PolicyDecision.nullable().default(null),
	finalText: z.string().default(''),
})

export const codingTools = {
	read_file: tool({
		description: 'Read a UTF-8 file from the workspace.',
		inputSchema: z.object({ path: z.string() }),
		// Deliberately no execute: Atlas must authorize and dispatch it.
	}),
	write_file: tool({
		description: 'Replace a UTF-8 file in the workspace.',
		inputSchema: z.object({ path: z.string(), content: z.string() }),
		// Deliberately no execute: Atlas must authorize and dispatch it.
	}),
} satisfies ToolSet

type HarnessEvent =
	| { type: 'model-part'; runId: string; partType: string }
	| { type: 'tool-policy'; runId: string; tool: PendingTool; decision: PolicyDecision }
	| { type: 'tool-result'; runId: string; callId: string; snapshotId: string; output: unknown }

export interface ParityHarnessDependencies {
	model: LanguageModel
	// Examples: { reasoning: 'high' } for a supported GPT/Claude model.
	// Unsupported settings are still constrained by the selected provider/model.
	modelSettings?: LanguageModelCallOptions
	systemPrompt: string
	events: { append(event: HarnessEvent): Promise<void> }
	policy: { beforeTool(tool: PendingTool): Promise<PolicyDecision> }
	workspace: { snapshot(runId: string, callId: string): Promise<string> }
	tools: {
		dispatchOnce(args: {
			idempotencyKey: string
			name: string
			input: Record<string, unknown>
			abortSignal?: AbortSignal
		}): Promise<unknown>
	}
}

function objectInput(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {}
}

function toolResultMessage(toolCall: PendingTool, output: unknown): ModelMessage {
	return {
		role: 'tool',
		content: [
			{
				type: 'tool-result',
				toolCallId: toolCall.callId,
				toolName: toolCall.name,
				output: { type: 'json', value: JSON.parse(JSON.stringify(output)) },
			},
		],
	}
}

export function createParityHarness(deps: ParityHarnessDependencies) {
	const modelStep: typeof HarnessState.Node = async (state, config) => {
		const result = streamText({
			...deps.modelSettings,
			model: deps.model,
			instructions: deps.systemPrompt,
			messages: state.messages,
			tools: codingTools,
			abortSignal: config.signal,
		})

		for await (const part of result.fullStream) {
			await deps.events.append({
				type: 'model-part',
				runId: state.runId,
				partType: part.type,
			})
		}

		const [response, calls, text] = await Promise.all([
			result.response,
			result.toolCalls,
			result.text,
		])

		return {
			messages: [...state.messages, ...response.messages],
			pendingTools: calls.map((call) => ({
				callId: call.toolCallId,
				name: call.toolName,
				input: objectInput(call.input),
			})),
			decision: null,
			finalText: text,
		}
	}

	const preTool: typeof HarnessState.Node = async (state) => {
		const pending = state.pendingTools[0]
		if (!pending) return { decision: null }

		const decision = await deps.policy.beforeTool(pending)
		await deps.events.append({
			type: 'tool-policy',
			runId: state.runId,
			tool: pending,
			decision,
		})
		return { decision }
	}

	const humanApproval: typeof HarnessState.Node = (state) => {
		const pending = state.pendingTools[0]
		if (!pending || state.decision?.kind !== 'ask') return { decision: state.decision }

		// This must be the first effect in the node: LangGraph restarts interrupted nodes.
		const answer = HumanDecision.parse(
			interrupt({
				type: 'tool-approval',
				tool: pending,
				reason: state.decision.reason,
			}),
		)

		if (answer.kind === 'deny') return { decision: answer }
		return {
			decision: {
				kind: 'allow',
				input: answer.kind === 'edit' ? answer.input : state.decision.input,
			},
		}
	}

	const executeTool: typeof HarnessState.Node = async (state, config) => {
		const pending = state.pendingTools[0]
		if (!pending || state.decision?.kind !== 'allow') return {}

		const snapshotId = await deps.workspace.snapshot(state.runId, pending.callId)
		const output = await deps.tools.dispatchOnce({
			idempotencyKey: `${state.runId}:${pending.callId}`,
			name: pending.name,
			input: state.decision.input,
			abortSignal: config.signal,
		})

		await deps.events.append({
			type: 'tool-result',
			runId: state.runId,
			callId: pending.callId,
			snapshotId,
			output,
		})

		return {
			messages: [...state.messages, toolResultMessage(pending, output)],
			pendingTools: state.pendingTools.slice(1),
			decision: null,
		}
	}

	const denyTool: typeof HarnessState.Node = (state) => {
		const pending = state.pendingTools[0]
		if (!pending || state.decision?.kind !== 'deny') return {}

		return {
			messages: [
				...state.messages,
				toolResultMessage(pending, { denied: true, reason: state.decision.reason }),
			],
			pendingTools: state.pendingTools.slice(1),
			decision: null,
		}
	}

	const afterModel = (state: typeof HarnessState.State) =>
		state.pendingTools.length > 0 ? 'pre_tool' : END
	const afterPolicy = (state: typeof HarnessState.State) => {
		if (state.decision?.kind === 'ask') return 'approval'
		if (state.decision?.kind === 'deny') return 'deny_tool'
		return 'execute_tool'
	}
	const afterTool = (state: typeof HarnessState.State) =>
		state.pendingTools.length > 0 ? 'pre_tool' : 'model'

	const graph = new StateGraph(HarnessState)
		.addNode('model', modelStep)
		.addNode('pre_tool', preTool)
		.addNode('approval', humanApproval)
		.addNode('execute_tool', executeTool)
		.addNode('deny_tool', denyTool)
		.addEdge(START, 'model')
		.addConditionalEdges('model', afterModel, ['pre_tool', END])
		.addConditionalEdges('pre_tool', afterPolicy, ['approval', 'execute_tool', 'deny_tool'])
		.addConditionalEdges('approval', afterPolicy, ['execute_tool', 'deny_tool'])
		.addConditionalEdges('execute_tool', afterTool, ['pre_tool', 'model'])
		.addConditionalEdges('deny_tool', afterTool, ['pre_tool', 'model'])
		.compile({ checkpointer: new MemorySaver() })

	return {
		graph,
		start(runId: string, messages: ModelMessage[]) {
			return graph.invoke({ runId, messages }, { configurable: { thread_id: runId } })
		},
		resume(runId: string, decision: HumanDecision) {
			return graph.invoke(new Command({ resume: decision }), {
				configurable: { thread_id: runId },
			})
		},
		// Rewind/fork: select a checkpoint from graph.getStateHistory(config),
		// restore its workspace snapshot, then invoke/updateState with checkpoint_id.
	}
}
