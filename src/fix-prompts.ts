import type { Agent, Finding, Recommendation } from './types.ts';

export interface FixPromptContext {
  rule: string;
  agent?: Agent | string;
  projectName?: string;
  projectRoot?: string;
  title?: string;
  evidence?: Record<string, any>;
  finding?: Finding;
  recommendation?: Recommendation;
}

/**
 * Generates a short, actionable fix prompt for an AI agent based on finding evidence.
 * Privacy guarantee: Never includes raw prompt text.
 */
export function generateFixPrompt(ctx: FixPromptContext): string {
  const ev = ctx.evidence ?? ctx.finding?.evidence ?? {};
  const rule = ctx.rule || ctx.finding?.rule || ctx.recommendation?.findingRule || '';
  const agent = ctx.agent || 'agent';

  switch (rule) {
    case 'hot_files': {
      const file = ev.file || ev.target || ev.tool || 'frequently read project files';
      return `Add a concise architectural summary of ${file} (exports, key types, and invariants) to project instructions (CLAUDE.md / AGENTS.md) so it does not need repeated re-reading across turns.`;
    }

    case 'retry_loop': {
      const tool = ev.tool || 'bash command';
      const count = ev.count ? ` (${ev.count} times)` : '';
      return `The tool or command '${tool}' failed and was repeatedly retried${count}. Create a dedicated test/check script or add explicit troubleshooting and invocation instructions to avoid retry loops.`;
    }

    case 'large_tool_output': {
      const tool = ev.tool || 'tool';
      const kb = ev.resultBytes ? `${Math.round(ev.resultBytes / 1024)}KB` : 'oversized output';
      return `The tool '${tool}' generated ${kb} of output, flooding conversation context. Update command instructions to pipe through head/grep or limit search scope to specific file extensions.`;
    }

    case 'context_growth': {
      return `The conversation context grew continuously without compaction. Break complex multi-file edits into self-contained subtasks, run /compact after milestones, and summarize progress before proceeding.`;
    }

    case 'repeated_prompt': {
      return `A repeated workflow prompt pattern was detected across multiple sessions. Define a project slash command or custom skill script to automate and standardize this task.`;
    }

    case 'model_fit': {
      const model = ev.model ? `flagship model '${ev.model}'` : 'a heavyweight model';
      return `A short, single-turn lookup task used ${model}. Configure lightweight models (like Sonnet, Haiku, or Flash) for simple lookups to conserve high-tier quota.`;
    }

    case 'cache_miss': {
      return `Prompt cache expired due to long pauses between turns. Consolidate plans and batch related tool calls to preserve active cache lifetime.`;
    }

    case 'handoff': {
      const fromAgent = ev.previousAgent || 'previous agent';
      const toAgent = ev.currentAgent || 'current agent';
      return `Frequent cross-agent switching between ${fromAgent} and ${toAgent} incurred redundant repository scanning. Finish full milestones in one agent before handing off.`;
    }

    case 'subagent_share': {
      return `Subagent consumed excessive tokens relative to returned output. Update subagent prompts to require concise, structured summary responses and narrow file scopes.`;
    }

    case 'quota_pressure': {
      const win = ev.window || '5h';
      const used = ev.usedPct ? `${Math.round(ev.usedPct)}%` : 'high';
      return `Pace consumption on ${agent}: quota reached ${used} in the ${win} window. Pause non-critical tasks or offload background work to another available agent.`;
    }

    case 'cross_agent_balance': {
      const alt = ev.altAgent ? (ev.altAgent.charAt(0).toUpperCase() + ev.altAgent.slice(1)) : 'Codex';
      const reset = ev.resetFormatted || 'quota reset';
      return `Route pending project tasks to ${alt} until primary agent quota resets at ${reset}. Follow repository guidelines and preserve project context.`;
    }

    case 'instruction_overhead':
    case 'instruction_bloat': {
      const name = ev.name || 'project instruction files';
      const tokens = ev.fixedTokens ? ` (${ev.fixedTokens.toLocaleString()} tokens/turn)` : '';
      return `Instruction file '${name}'${tokens} adds heavy overhead to every turn. Trim unnecessary guidelines and migrate detailed tutorials to on-demand skills or separate docs.`;
    }

    case 'unused_mcp':
    case 'unused_skill':
    case 'unused_plugin':
    case 'unused_config': {
      const kind = ev.kind || 'tool/mcp';
      const name = ev.name || 'unreferenced configuration';
      return `Remove or disable unused ${kind} '${name}' from agent settings. It has had 0 invocations in 30 days and adds redundant tool schema to context.`;
    }

    case 'duplicate_config': {
      const name = ev.name || 'configuration item';
      return `Configuration '${name}' is duplicated in multiple locations. Remove redundant definitions and establish a single source of truth.`;
    }

    case 'conflict_config':
    case 'config_conflict': {
      const managers = Array.isArray(ev.managers) ? ev.managers.join(' vs ') : 'conflicting build instructions';
      return `Resolve conflicting instructions (${managers}). Standardize on a single package manager and build command across all project configs.`;
    }

    // Future detectors from Task 7
    case 'outcome_efficiency': {
      return `Token expenditure per commit is elevated. Bundle related edits and tests into cohesive, focused commits to improve outcome efficiency.`;
    }

    case 'abandoned_session': {
      return `A high-token session concluded without file edits or git commits. Ensure tasks have clear reproduction steps or specs before initiating deep research loops.`;
    }

    case 'compaction_churn': {
      return `Frequent /compact calls occurred within a single session. Reduce compaction churn by scoping tasks to single files or modules rather than running broad multi-area sessions.`;
    }

    case 'reasoning_overuse': {
      return `Reasoning token expenditure was disproportionately high for short turns. Add direct code examples and exact requirements in project instructions to reduce agent reasoning overhead.`;
    }

    default: {
      const title = ctx.title || ctx.recommendation?.title || rule.replace(/_/g, ' ');
      return `Improve agent efficiency for ${title}. Review recent tool calls and optimize configuration to minimize unnecessary token consumption.`;
    }
  }
}
