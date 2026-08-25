export interface AgentForumReply {
  replyTo: string;
  content: string;
}

export interface AgentForumStructuredOutput {
  replies: AgentForumReply[];
}

export class AgentForumValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentForumValidationError';
  }
}

/**
 * Extracts structured replies from CLI agent output.
 * Handles raw JSON, ```json ... ``` code blocks, or text surrounding JSON.
 */
export function extractStructuredReplies(
  rawOutput: string,
  options: {
    availableTargetIds: Set<string>;
    maxReplyLength: number;
    currentAgentName?: string;
  },
): AgentForumReply[] {
  if (!rawOutput || !rawOutput.trim()) {
    throw new AgentForumValidationError('Agent produced empty output');
  }

  let jsonStr = rawOutput.trim();

  // Strip markdown code block wrappers if present
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  } else {
    // If not in a code block, try to find the outermost JSON object {...}
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new AgentForumValidationError(`Failed to parse structured JSON response: ${errorMsg}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentForumValidationError('Structured output must be a JSON object with a "replies" array');
  }

  const outputObj = parsed as Record<string, unknown>;
  if (!('replies' in outputObj) || !Array.isArray(outputObj.replies)) {
    throw new AgentForumValidationError('Structured output must contain a "replies" array');
  }

  const rawReplies = outputObj.replies;
  const validatedReplies: AgentForumReply[] = [];
  const seenTargets = new Set<string>();

  for (let i = 0; i < rawReplies.length; i++) {
    const item = rawReplies[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AgentForumValidationError(`Reply #${i + 1} must be an object with "replyTo" and "content" fields`);
    }

    const reply = item as Record<string, unknown>;
    const replyTo = typeof reply.replyTo === 'string' ? reply.replyTo.trim() : '';
    const content = typeof reply.content === 'string' ? reply.content.trim() : '';

    if (!replyTo) {
      throw new AgentForumValidationError(`Reply #${i + 1} missing "replyTo" message ID`);
    }

    if (!content) {
      throw new AgentForumValidationError(`Reply #${i + 1} for "${replyTo}" cannot have empty content`);
    }

    if (content.length > options.maxReplyLength) {
      throw new AgentForumValidationError(
        `Reply #${i + 1} for "${replyTo}" exceeded maximum length of ${options.maxReplyLength} characters (actual: ${content.length})`
      );
    }

    if (seenTargets.has(replyTo)) {
      throw new AgentForumValidationError(
        `Duplicate replyTo target "${replyTo}" in the same turn. Each message can only be replied to once per turn.`
      );
    }
    seenTargets.add(replyTo);

    if (!options.availableTargetIds.has(replyTo)) {
      throw new AgentForumValidationError(
        `Invalid reply target "${replyTo}": target does not exist, belongs to this agent, or has already been replied to by this agent.`
      );
    }

    validatedReplies.push({ replyTo, content });
  }

  return validatedReplies;
}
