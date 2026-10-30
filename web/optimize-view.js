// Pure markup helpers for the Optimize Workspace surfaces (project inline panel,
// optimization drawer). No DOM access — app.js keeps layout, helpers keep the
// copy that must match the WorkspaceOptimizeResult contract (estimates, not
// measured savings; per-provider ignore-file status).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTok = (n) => {
  n = n ?? 0;
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
};

export { esc, fmtTok };

// IgnoreFileUpdate entries with pending patterns, from the whole ignoreFiles result array.
export const pendingIgFiles = (ignoreFiles = []) => (ignoreFiles ?? []).filter((ig) => (ig.addedPatterns?.length || 0) > 0);

// Inline project panel col-4: per-file pending patterns, or the shared up-to-date note.
export function optimizeIgnoreFilesCardHtml(ignoreFiles = []) {
  const pending = pendingIgFiles(ignoreFiles);
  if (pending.length === 0) {
    return `<div style="font-size:12.5px;color:var(--success)">✓ Both .claudeignore & .cursorignore are up to date.</div>`;
  }
  return pending
    .map(
      (ig) => `
      <div style="font-size:12.5px;color:var(--text);margin-bottom:6px"><code class="cell-mono">${esc(ig.fileName)}</code>: <strong>${ig.addedPatterns.length}</strong> missing pattern(s) ready to add:</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">
        ${ig.addedPatterns.slice(0, 10).map((pat) => `<span class="badge cell-mono">${esc(pat)}</span>`).join('')}
        ${ig.addedPatterns.length > 10 ? `<span class="badge">+${ig.addedPatterns.length - 10} more</span>` : ''}
      </div>
    `,
    )
    .join('');
}

// Drawer section 1: intro + per-file pattern dumps, or the shared up-to-date note.
export function optimizeDrawerIgnoreFilesHtml(ignoreFiles = []) {
  const pending = pendingIgFiles(ignoreFiles);
  if (pending.length === 0) {
    return `<p style="font-size:12.5px;color:var(--success);margin-bottom:14px">✓ Both <code class="cell-mono">.claudeignore</code> and <code class="cell-mono">.cursorignore</code> are already up to date.</p>`;
  }
  return `
      <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:8px">Missing patterns to add, per ignore file (build artifacts, lockfiles, oversized dumps):</p>
      ${pending
        .map(
          (ig) => `
        <div style="margin-bottom:14px">
          <div style="font-size:12.5px;color:var(--text);margin-bottom:4px"><code class="cell-mono">${esc(ig.fileName)}</code>: <strong>${ig.addedPatterns.length}</strong> missing pattern(s):</div>
          <pre><code># agentlens-managed (workspace hygiene)\n${esc(ig.addedPatterns.join('\n'))}</code></pre>
        </div>
      `,
        )
        .join('')}
    `;
}

// Inline project panel per-file trim reductions: estimated, never measured.
export const optimizeTrimLine = (trims = []) => (trims ?? []).map((t) => `${esc(t.fileName)}: -${fmtTok(t.tokensSaved)} tok/turn est.`).join(', ');
