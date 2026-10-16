import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { CHARS_PER_TOKEN } from './constants.ts';
import type { InstructionItem } from './scanners/instruction.ts';

export interface TrimmingCut {
  type: 'duplicate_line' | 'conflict_section' | 'long_code_block' | 'stale_path';
  description: string;
  startLine: number;
  endLine: number;
  removedText: string;
  replacementText?: string;
  tokensSaved: number;
}

export interface InstructionTrimmerResult {
  filePath: string;
  fileName: string;
  agent: string;
  projectId: number | null;
  projectName?: string;
  totalTokens: number;
  tokensSaved: number;
  cuts: TrimmingCut[];
  unifiedDiff: string;
  fixPrompt: string;
}

export function generateUnifiedDiff(
  filePath: string,
  originalLines: string[],
  cuts: TrimmingCut[]
): string {
  if (cuts.length === 0) return '';
  const relName = basename(filePath);

  // Apply cuts in reverse line order to create modified content
  const newLines = [...originalLines];
  const sortedCuts = [...cuts].sort((a, b) => b.startLine - a.startLine);

  for (const cut of sortedCuts) {
    const s = Math.max(0, cut.startLine - 1);
    const count = cut.endLine - cut.startLine + 1;
    if (cut.replacementText) {
      newLines.splice(s, count, cut.replacementText);
    } else {
      newLines.splice(s, count);
    }
  }

  // Create unified diff chunks
  const diffLines: string[] = [
    `--- a/${relName}`,
    `+++ b/${relName}`,
  ];

  for (const cut of cuts) {
    const s = Math.max(0, cut.startLine - 1);
    const e = Math.min(originalLines.length, cut.endLine);
    diffLines.push(`@@ -${cut.startLine},${e - s} +${cut.startLine},${cut.replacementText ? 1 : 0} @@`);
    for (let i = s; i < e; i++) {
      diffLines.push(`-${originalLines[i]}`);
    }
    if (cut.replacementText) {
      diffLines.push(`+${cut.replacementText}`);
    }
  }

  return diffLines.join('\n');
}

export function trimInstructions(
  instructions: InstructionItem[],
  projects: Array<{ id: number; root: string; name: string }> = []
): InstructionTrimmerResult[] {
  const results: InstructionTrimmerResult[] = [];
  const lineOccurrences = new Map<string, string[]>(); // trimmedLine -> [filePaths]

  // Pass 1: Collect non-trivial lines across all instruction files
  for (const item of instructions) {
    try {
      if (!existsSync(item.sourcePath)) continue;
      const content = readFileSync(item.sourcePath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        // Ignore headers, empty lines, very short lines, code fences, and basic list markers
        if (
          trimmed.length < 25 ||
          trimmed.startsWith('#') ||
          trimmed.startsWith('```') ||
          trimmed === '-' ||
          trimmed === '*'
        ) {
          continue;
        }
        const existing = lineOccurrences.get(trimmed) || [];
        if (!existing.includes(item.sourcePath)) {
          existing.push(item.sourcePath);
          lineOccurrences.set(trimmed, existing);
        }
      }
    } catch {}
  }

  // Pass 2: Analyze each instruction file
  for (const item of instructions) {
    try {
      if (!existsSync(item.sourcePath)) continue;
      const content = readFileSync(item.sourcePath, 'utf-8');
      const lines = content.split('\n');
      const cuts: TrimmingCut[] = [];

      const proj = projects.find((p) => p.id === item.projectId);
      const projectRoot = proj?.root || dirname(item.sourcePath);

      // A. Duplicate lines across files
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        const filesWithLine = lineOccurrences.get(trimmed);
        if (filesWithLine && filesWithLine.length > 1 && filesWithLine[0] !== item.sourcePath) {
          cuts.push({
            type: 'duplicate_line',
            description: `Duplicate line also defined in ${basename(filesWithLine[0])}`,
            startLine: i + 1,
            endLine: i + 1,
            removedText: line,
            tokensSaved: Math.ceil(line.length / CHARS_PER_TOKEN),
          });
        }
      }

      // B. Very long code blocks (> 15 lines or > 600 chars)
      let inCodeBlock = false;
      let blockStartLine = 0;
      let blockLines: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('```')) {
          if (!inCodeBlock) {
            inCodeBlock = true;
            blockStartLine = i + 1;
            blockLines = [line];
          } else {
            inCodeBlock = false;
            blockLines.push(line);
            if (blockLines.length > 15 || blockLines.join('\n').length > 600) {
              const fullBlock = blockLines.join('\n');
              cuts.push({
                type: 'long_code_block',
                description: `Oversized code block (${blockLines.length} lines) should be moved to a standalone script/file`,
                startLine: blockStartLine,
                endLine: i + 1,
                removedText: fullBlock,
                replacementText: '# (Code block moved to dedicated script/skill file)',
                tokensSaved: Math.ceil((fullBlock.length - 50) / CHARS_PER_TOKEN),
              });
            }
          }
        } else if (inCodeBlock) {
          blockLines.push(line);
        }
      }

      // C. Stale paths that no longer exist
      const pathRegex = /(?:\.\/|[a-zA-Z0-9_\-\.]+\/)[a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+/g;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const matches = line.match(pathRegex);
        if (matches) {
          for (const match of matches) {
            // Ignore URLs, protocols, or node_modules
            if (match.includes('http') || match.includes('node_modules') || match.startsWith('.git/')) {
              continue;
            }
            const candidatePath = isAbsolute(match) ? match : join(projectRoot, match);
            if (!existsSync(candidatePath)) {
              cuts.push({
                type: 'stale_path',
                description: `Reference to missing path '${match}'`,
                startLine: i + 1,
                endLine: i + 1,
                removedText: line,
                tokensSaved: Math.ceil(line.length / CHARS_PER_TOKEN),
              });
              break;
            }
          }
        }
      }

      // D. Conflicting package manager commands within the file
      const hasNpm = content.includes('npm ') || content.includes('npm run');
      const hasPnpm = content.includes('pnpm ');
      const hasYarn = content.includes('yarn ');
      const hasBun = content.includes('bun ');
      const managers = [hasNpm && 'npm', hasPnpm && 'pnpm', hasYarn && 'yarn', hasBun && 'bun'].filter(Boolean);
      if (managers.length >= 2) {
        // Flag non-primary package manager lines
        const primary = managers[0];
        const secondary = managers[1];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(`${secondary} `)) {
            cuts.push({
              type: 'conflict_section',
              description: `Conflicting package manager directive '${secondary}' (primary is '${primary}')`,
              startLine: i + 1,
              endLine: i + 1,
              removedText: lines[i],
              replacementText: lines[i].replace(new RegExp(`${secondary}\\s+`, 'g'), `${primary} `),
              tokensSaved: 10,
            });
          }
        }
      }

      if (cuts.length > 0) {
        // Sort cuts by startLine
        cuts.sort((a, b) => a.startLine - b.startLine);
        const tokensSaved = cuts.reduce((sum, c) => sum + c.tokensSaved, 0);
        const unifiedDiff = generateUnifiedDiff(item.sourcePath, lines, cuts);
        const fixPrompt = `Trim redundant and stale instructions in ${basename(item.sourcePath)}: remove duplicate lines, trim oversized code blocks, and resolve conflicting/stale references to save ~${tokensSaved} tokens/turn.`;

        results.push({
          filePath: item.sourcePath,
          fileName: basename(item.sourcePath),
          agent: item.agent,
          projectId: item.projectId,
          projectName: proj?.name,
          totalTokens: item.tokens,
          tokensSaved,
          cuts,
          unifiedDiff,
          fixPrompt,
        });
      }
    } catch {}
  }

  return results;
}
