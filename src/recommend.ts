import { CONFIDENCE_WEIGHTS } from './analyze/constants.ts';
import { findCatalogItemsForRule } from './catalog.ts';
import type { ActionType, Finding, Recommendation } from './types.ts';

export function generateRecommendations(findings: Finding[]): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const f of findings) {
    let action: ActionType = 'improve';
    let title = '';
    let body = '';
    let actionSnippet: string | undefined;
    let catalogRef: string | undefined;

    switch (f.rule) {
      case 'context_growth':
        action = 'improve';
        title = 'Run /compact or reset long conversation context';
        body = 'Prompt context accumulated heavily without compaction. Run /compact periodically or break complex tasks into smaller focused sessions.';
        actionSnippet = '/compact';
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
        actionSnippet = f.evidence?.tool === 'Bash' ? 'bash tools/check.sh' : undefined;
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
        actionSnippet = '| head -n 100';
        break;

      case 'repeated_prompt':
        action = 'add';
        title = 'Convert repeated prompt into a slash command or skill';
        body = `This prompt pattern was used across ${f.evidence?.sessionCount ?? 'multiple'} separate sessions. Define a project slash command or skill to automate it cleanly.`;
        actionSnippet = '/skill <name>';
        break;

      case 'model_fit':
        action = 'replace';
        title = 'Use lightweight model for single-turn quick queries';
        body = `Flagship model '${f.evidence?.model}' was used on a short single-turn query producing ${f.evidence?.outputTokens} tokens. Use Sonnet, Haiku, or Flash for simple queries.`;
        actionSnippet = '--model sonnet';
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
        actionSnippet = 'agentlens status';
        break;

      case 'cross_agent_balance': {
        const tight = f.evidence?.tightAgent || 'claude';
        const alt = f.evidence?.altAgent || 'codex';
        const resetStr = f.evidence?.resetFormatted || 'next reset';
        const capAlt = alt.charAt(0).toUpperCase() + alt.slice(1);
        const capTight = tight.charAt(0).toUpperCase() + tight.slice(1);
        action = 'replace';
        title = `Use ${capAlt} for this project until ${resetStr}`;
        body = `${capTight}'s ${f.evidence?.window || '7d'} quota is tight (${Math.round(f.evidence?.tightUsedPct ?? 0)}% used), while ${capAlt} has headroom (${Math.round(f.evidence?.altUsedPct ?? 0)}% used). Route active tasks to ${capAlt} until ${resetStr} to prevent quota lockout.`;
        actionSnippet = alt.toLowerCase() === 'codex' ? 'codex' : alt.toLowerCase() === 'claude' ? 'claude' : 'opencode';
        break;
      }

      case 'instruction_bloat':
        action = 'improve';
        title = 'Trim always-loaded instruction files';
        body = `Instruction files consume ${f.evidence?.fixedTokens?.toLocaleString() ?? 'many'} tokens per session. Move detailed guidelines to on-demand skills or reference documents.`;
        break;

      case 'unused_config':
        action = 'remove';
        title = `Remove unused ${f.evidence?.kind ?? 'config'} '${f.evidence?.name}'`;
        body = `No invocations detected in the last 30 days. Disabling unused configurations saves context overhead and eliminates tool schema pollution.`;
        if (f.evidence?.kind === 'mcp') {
          if (f.evidence?.agent === 'claude') {
            actionSnippet = `claude mcp remove ${f.evidence?.name}`;
          } else if (f.evidence?.agent === 'codex') {
            actionSnippet = `# remove [mcp_servers.${f.evidence?.name}] from ~/.codex/config.toml`;
          } else if (f.evidence?.agent === 'opencode') {
            actionSnippet = `# remove "${f.evidence?.name}" from opencode.json`;
          } else if (f.evidence?.agent === 'antigravity') {
            actionSnippet = `rm -rf ${f.evidence?.sourcePath || `~/.gemini/antigravity-cli/mcp/${f.evidence?.name}`}`;
          }
        }
        break;

      case 'duplicate_config':
        action = 'remove';
        title = `Consolidate duplicate ${f.evidence?.kind ?? 'config'} '${f.evidence?.name}'`;
        body = `${f.evidence?.kind ?? 'Config'} '${f.evidence?.name}' is defined in ${f.evidence?.sources?.length ?? 'multiple'} locations. Maintain a single canonical definition to prevent conflicts.`;
        break;

      case 'config_conflict':
        action = 'improve';
        title = 'Resolve conflicting instruction commands';
        body = `Instructions in ${f.evidence?.projectName ?? 'project'} specify conflicting package managers (${f.evidence?.managers?.join(', ')}). Standardize on a single package manager.`;
        break;

      default:
        action = 'improve';
        title = `Address ${f.rule.replace(/_/g, ' ')} workflow waste`;
        body = f.confidenceReason;
        break;
    }

    const matchingCatalog = findCatalogItemsForRule(f.rule);
    if (matchingCatalog.length > 0) {
      const topPick = matchingCatalog[0];
      catalogRef = topPick.id;
      if (!actionSnippet && topPick.installCommand) {
        actionSnippet = topPick.installCommand;
      }
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
      actionSnippet,
      catalogRef,
      status: 'open',
      score,
    });
  }

  // Sort descending by score, tie-break by title and id
  recs.sort(
    (a, b) =>
      (b.score ?? 0) - (a.score ?? 0) ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id)
  );
  return recs;
}
