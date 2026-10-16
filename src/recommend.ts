import { CONFIDENCE_WEIGHTS } from './analyze/constants.ts';
import type { ActionType, Finding, Recommendation } from './types.ts';

export function generateRecommendations(findings: Finding[]): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const f of findings) {
    let action: ActionType = 'improve';
    let title = '';
    let body = '';
    let catalogRef: string | undefined;

    switch (f.rule) {
      case 'context_growth':
        action = 'improve';
        title = 'Run /compact or reset long conversation context';
        body = 'Prompt context accumulated heavily without compaction. Run /compact periodically or break complex tasks into smaller focused sessions.';
        break;

      case 'cache_miss':
        action = 'improve';
        title = 'Avoid 5+ minute idle pauses during active sessions';
        body = 'Anthropic prompt cache expires after 5 minutes of inactivity. Pause work between sessions rather than mid-turn to preserve cached tokens.';
        break;

      case 'retry_loop':
        action = f.evidence?.tool === 'Bash' ? 'add' : 'improve';
        title = f.evidence?.tool === 'Bash'
          ? 'Add a local test/check script to avoid Bash command retries'
          : `Consolidate repeated calls to '${f.evidence?.tool ?? 'tool'}'`;
        body = `Identical '${f.evidence?.tool}' calls were executed ${f.evidence?.count ?? 'multiple'} times. Script multi-step checks or add explicit failure guidance to CLAUDE.md / AGENTS.md.`;
        break;

      case 'hot_files':
        action = 'improve';
        title = 'Consolidate redundant file re-reads';
        body = `A project file was read ${f.evidence?.reads ?? 'multiple'} times across turns. Add concise architectural summaries to project instructions or pin key type definitions.`;
        break;

      case 'large_tool_output':
        action = 'replace';
        title = 'Truncate or stream large tool outputs';
        body = `A tool invocation produced ${Math.round((f.evidence?.resultBytes ?? 0) / 1024)} KB of output. Use line limits (e.g. head/tail/grep) to prevent flooding agent context with massive dumps.`;
        break;

      case 'repeated_prompt':
        action = 'add';
        title = 'Convert repeated prompt into a slash command or skill';
        body = `This prompt pattern was used across ${f.evidence?.sessionCount ?? 'multiple'} separate sessions. Define a project slash command or skill to automate it cleanly.`;
        break;

      case 'model_fit':
        action = 'replace';
        title = 'Use lightweight model for single-turn quick queries';
        body = `Flagship model '${f.evidence?.model}' was used on a short single-turn query producing ${f.evidence?.outputTokens} tokens. Use Sonnet, Haiku, or Flash for simple queries.`;
        break;

      case 'handoff':
        action = 'improve';
        title = 'Minimize cross-agent switching on the same project';
        body = `Switched from ${f.evidence?.previousAgent} to ${f.evidence?.currentAgent} within ${f.evidence?.gapMinutes}m. Each switch incurs a cold repository scanning penalty. Complete subtasks in one agent.`;
        break;

      case 'subagent_share':
        action = 'improve';
        title = 'Constrain subagent research scope and output';
        body = `Subagent consumed ${Math.round((f.evidence?.inputTokens ?? 0) / 1000)}k tokens but only returned ${f.evidence?.outputTokens} tokens to the parent. Require concise, structured summaries.`;
        break;

      case 'quota_pressure':
        action = 'improve';
        title = `Pace consumption to prevent ${f.evidence?.agent} ${f.evidence?.window} quota lockout`;
        body = `${f.evidence?.agent} reached ${Math.round(f.evidence?.usedPct ?? 0)}% of its ${f.evidence?.window} quota. Check top consuming sessions and pace intensive tasks before reset.`;
        break;

      default:
        action = 'improve';
        title = `Address ${f.rule.replace(/_/g, ' ')} workflow waste`;
        body = f.confidenceReason;
        break;
    }

    const weight = CONFIDENCE_WEIGHTS[f.confidence] ?? 0.6;
    const score = Math.round((f.estTokensWeek ?? 0) * weight);

    recs.push({
      id: `rec:${f.rule}:${f.projectId ?? 'global'}:${f.id}`,
      findingRule: f.rule,
      projectId: f.projectId,
      action,
      title,
      body,
      catalogRef,
      status: 'open',
      score,
    });
  }

  // Sort descending by score, tie-break by title
  recs.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.title.localeCompare(b.title));
  return recs;
}
