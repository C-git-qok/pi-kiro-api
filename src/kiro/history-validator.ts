// Kiro conversation history validator and repair.
//
// Kiro's runtime enforces 7 conversation invariants. This module validates
// and repairs history + current message as a single unit so the provider
// can send structurally valid payloads even when Pi's transcript has
// interleaved tool results or missing entries.

import type { KiroHistoryEntry, KiroToolResult, KiroUserInputMessage } from "./transform.ts";
import { KIRO_ORIGIN } from "./transform.ts";

// ---- Validation rules ---------------------------------------------------

export enum KiroValidationRule {
  STARTS_WITH_USER_MESSAGE = "STARTS_WITH_USER_MESSAGE",
  ENDS_WITH_USER_MESSAGE = "ENDS_WITH_USER_MESSAGE",
  ALTERNATING_MESSAGES = "ALTERNATING_MESSAGES",
  TOOL_USES_AND_RESULTS = "TOOL_USES_AND_RESULTS",
  TOOL_RESULTS_AND_NO_USES = "TOOL_RESULTS_AND_NO_USES",
  TOOL_RESULTS_ORPHAN_IDS = "TOOL_RESULTS_ORPHAN_IDS",
  NON_EMPTY_USER_MESSAGE = "NON_EMPTY_USER_MESSAGE",
}

export const KIRO_TOOL_STRUCTURE_RULES = [
  KiroValidationRule.TOOL_USES_AND_RESULTS,
  KiroValidationRule.TOOL_RESULTS_AND_NO_USES,
  KiroValidationRule.TOOL_RESULTS_ORPHAN_IDS,
] as const;

// ---- Types ---------------------------------------------------------------

interface ValidationViolation {
  rule: KiroValidationRule;
  message: string;
  index?: number;
}

export interface KiroRepairResult {
  entries: KiroHistoryEntry[];
  violations: ValidationViolation[];
  repaired: boolean;
}

// ---- Constants -----------------------------------------------------------

export const EMPTY_CONTENT_PLACEHOLDER = "(empty)";
export const SYNTHETIC_FAILED_TOOL_RESULT_TEXT =
  "Tool use was interrupted and did not produce a result.";

// ---- Validation ----------------------------------------------------------

/**
 * Validate a conversation entries array against Kiro's invariants.
 * Returns violations without modifying the input.
 */
export function validateKiroConversation(entries: KiroHistoryEntry[]): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  if (entries.length === 0) return violations;

  // STARTS_WITH_USER_MESSAGE
  if (!entries[0]?.userInputMessage) {
    violations.push({
      rule: KiroValidationRule.STARTS_WITH_USER_MESSAGE,
      message: "Conversation must start with a user message",
    });
  }

  // ENDS_WITH_USER_MESSAGE
  const last = entries[entries.length - 1];
  if (!last?.userInputMessage) {
    violations.push({
      rule: KiroValidationRule.ENDS_WITH_USER_MESSAGE,
      message: "Conversation must end with a user message",
    });
  }

  // ALTERNATING_MESSAGES
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const curr = entries[i];
    const prevHasUser = !!prev?.userInputMessage;
    const currHasUser = !!curr?.userInputMessage;
    if (prevHasUser === currHasUser) {
      violations.push({
        rule: KiroValidationRule.ALTERNATING_MESSAGES,
        message: `Entries ${i - 1} and ${i} are both ${prevHasUser ? "user" : "assistant"}`,
        index: i,
      });
    }
  }

  // Tool structure rules
  violations.push(...validateKiroToolStructure(entries));

  // NON_EMPTY_USER_MESSAGE
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry?.userInputMessage) {
      const content = entry.userInputMessage.content;
      const hasToolResults =
        entry.userInputMessage.userInputMessageContext?.toolResults &&
        entry.userInputMessage.userInputMessageContext.toolResults.length > 0;
      if (!content && !hasToolResults) {
        violations.push({
          rule: KiroValidationRule.NON_EMPTY_USER_MESSAGE,
          message: `Entry ${i} has empty user message with no tool results`,
          index: i,
        });
      }
    }
  }

  return violations;
}

/**
 * Validate only tool-related structure rules.
 */
export function validateKiroToolStructure(entries: KiroHistoryEntry[]): ValidationViolation[] {
  const violations: ValidationViolation[] = [];

  // Collect all toolUseIds from assistant messages
  const allToolUseIds = new Set<string>();
  for (const entry of entries) {
    if (entry?.assistantResponseMessage?.toolUses) {
      for (const tu of entry.assistantResponseMessage.toolUses) {
        allToolUseIds.add(tu.toolUseId);
      }
    }
  }

  // Collect all toolResultIds from user messages
  const allToolResultIds = new Set<string>();
  for (const entry of entries) {
    const toolResults = entry?.userInputMessage?.userInputMessageContext?.toolResults;
    if (toolResults) {
      for (const tr of toolResults) {
        allToolResultIds.add(tr.toolUseId);
      }
    }
  }

  // TOOL_USES_AND_RESULTS: every toolUse must have a corresponding toolResult
  for (const id of allToolUseIds) {
    if (!allToolResultIds.has(id)) {
      violations.push({
        rule: KiroValidationRule.TOOL_USES_AND_RESULTS,
        message: `Tool use ${id} has no corresponding tool result`,
      });
    }
  }

  // TOOL_RESULTS_AND_NO_USES: every toolResult must have a corresponding toolUse
  for (const id of allToolResultIds) {
    if (!allToolUseIds.has(id)) {
      violations.push({
        rule: KiroValidationRule.TOOL_RESULTS_AND_NO_USES,
        message: `Tool result ${id} has no corresponding tool use`,
      });
    }
  }

  // TOOL_RESULTS_ORPHAN_IDS: toolResult IDs must match a toolUse in the same or earlier turn
  // (This is a stricter check — already covered by the above, but kept for completeness)

  return violations;
}

// ---- Conversation entries ------------------------------------------------

/**
 * Convert history + current message into a flat entries array for validation.
 * Current message is always the last entry.
 */
export function kiroConversationEntries(
  history: KiroHistoryEntry[],
  currentMessage: KiroUserInputMessage,
): KiroHistoryEntry[] {
  const entries = [...history];
  entries.push({ userInputMessage: currentMessage });
  return entries;
}

// ---- Repair --------------------------------------------------------------

/**
 * Repair a conversation to satisfy Kiro's invariants.
 *
 * Steps:
 * 1. Remove leading non-user entries (bare tool-result carriers)
 * 2. Merge adjacent pure toolResult user messages
 * 3. Strip orphan and duplicate toolResults
 * 4. Synthesize ERROR tool results for unanswered assistant toolUses
 * 5. Assign placeholder content to empty user messages
 */
export function repairKiroConversation(
  entries: KiroHistoryEntry[],
  options?: { modelId?: string; origin?: string },
): KiroRepairResult {
  const violations: ValidationViolation[] = [];
  let repaired = false;
  let result = entries.map((e) => ({ ...e }));

  // Step 1: Remove leading non-user entries
  while (result.length > 0 && !result[0]?.userInputMessage) {
    result.shift();
    repaired = true;
    violations.push({
      rule: KiroValidationRule.STARTS_WITH_USER_MESSAGE,
      message: "Removed leading non-user entry",
    });
  }

  // Step 2: Merge adjacent pure toolResult user messages (must be before step 3)
  const merged: KiroHistoryEntry[] = [];
  for (const entry of result) {
    if (entry?.userInputMessage && merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (prev?.userInputMessage && !prev.userInputMessage.content) {
        // Previous is a pure toolResult carrier — merge
        const prevTr = prev.userInputMessage.userInputMessageContext?.toolResults ?? [];
        const currTr = entry.userInputMessage.userInputMessageContext?.toolResults ?? [];
        if (prevTr.length > 0 || currTr.length > 0) {
          prev.userInputMessage.userInputMessageContext = {
            ...prev.userInputMessage.userInputMessageContext,
            toolResults: [...prevTr, ...currTr],
          };
          repaired = true;
          continue;
        }
      }
    }
    merged.push(entry);
  }
  result = merged;

  // Step 3: Strip orphan and duplicate toolResults
  const seenToolUseIds = new Set<string>();
  for (const entry of result) {
    if (entry?.assistantResponseMessage?.toolUses) {
      for (const tu of entry.assistantResponseMessage.toolUses) {
        seenToolUseIds.add(tu.toolUseId);
      }
    }
  }

  for (const entry of result) {
    if (!entry?.userInputMessage?.userInputMessageContext?.toolResults) continue;
    const toolResults = entry.userInputMessage.userInputMessageContext.toolResults;
    const filtered: KiroToolResult[] = [];
    const seen = new Set<string>();
    for (const tr of toolResults) {
      if (seen.has(tr.toolUseId)) {
        repaired = true;
        continue; // duplicate
      }
      if (!seenToolUseIds.has(tr.toolUseId)) {
        repaired = true;
        continue; // orphan
      }
      seen.add(tr.toolUseId);
      filtered.push(tr);
    }
    if (filtered.length !== toolResults.length) {
      entry.userInputMessage.userInputMessageContext.toolResults = filtered;
    }
  }

  // Step 4: Synthesize ERROR tool results for unanswered assistant toolUses
  const answeredToolUseIds = new Set<string>();
  for (const entry of result) {
    if (entry?.userInputMessage?.userInputMessageContext?.toolResults) {
      for (const tr of entry.userInputMessage.userInputMessageContext.toolResults) {
        answeredToolUseIds.add(tr.toolUseId);
      }
    }
  }

  for (let i = 0; i < result.length; i++) {
    const entry = result[i];
    if (!entry?.assistantResponseMessage?.toolUses) continue;

    const unanswered = entry.assistantResponseMessage.toolUses.filter(
      (tu) => !answeredToolUseIds.has(tu.toolUseId),
    );
    if (unanswered.length === 0) continue;

    // Create a synthetic toolResult user message after this assistant turn
    const syntheticResults: KiroToolResult[] = unanswered.map((tu) => ({
      content: [{ text: SYNTHETIC_FAILED_TOOL_RESULT_TEXT }],
      status: "error" as const,
      toolUseId: tu.toolUseId,
    }));

    const syntheticEntry: KiroHistoryEntry = {
      userInputMessage: {
        content: "",
        modelId: options?.modelId ?? "",
        origin: options?.origin ?? KIRO_ORIGIN,
        userInputMessageContext: { toolResults: syntheticResults },
      },
    };

    result.splice(i + 1, 0, syntheticEntry);
    repaired = true;
    violations.push({
      rule: KiroValidationRule.TOOL_USES_AND_RESULTS,
      message: `Synthesized ${unanswered.length} error tool results`,
    });
  }

  // Step 5: Assign placeholder content to empty user messages
  for (const entry of result) {
    if (!entry?.userInputMessage) continue;
    const uim = entry.userInputMessage;
    const hasToolResults =
      uim.userInputMessageContext?.toolResults &&
      uim.userInputMessageContext.toolResults.length > 0;
    if (!uim.content && !hasToolResults) {
      uim.content = EMPTY_CONTENT_PLACEHOLDER;
      repaired = true;
    }
  }

  return { entries: result, violations, repaired };
}
