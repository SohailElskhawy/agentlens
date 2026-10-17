import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PLUGIN_DIR = join(process.cwd(), 'plugins', 'omarchy', 'agentlens.bar-widget');
const MODEL_PATH = join(PLUGIN_DIR, 'Model.js');
const MANIFEST_PATH = join(PLUGIN_DIR, 'manifest.json');
const ICON_PATH = join(PLUGIN_DIR, 'assets', 'icon.svg');

function loadModel(): any {
  const source = readFileSync(MODEL_PATH, 'utf8').replace(/^\s*\.pragma library\s*/, '');
  const mod = { exports: {} as any };
  new Function('module', source)(mod);
  return mod.exports;
}

test('Model.js handles empty or malformed summary.json safely', () => {
  const Model = loadModel();
  const now = 1_700_000_000_000;

  const emptyState = Model.parseSummaryJson('', now);
  assert.equal(emptyState.hasData, false);
  assert.equal(emptyState.severity, 'normal');
  assert.equal(emptyState.binding5hPct, -1);
  assert.equal(Model.formatBarLabel(emptyState, { showCountdown: true, showBurnRate: true }), '⚡ --');

  const invalidState = Model.parseSummaryJson('{broken-json', now);
  assert.equal(invalidState.hasData, false);
  assert.equal(invalidState.severity, 'normal');
  assert.equal(Model.formatBarLabel(invalidState, { showCountdown: true, showBurnRate: true }), '⚡ --');
});

test('Model.js selects binding 5h quota across multiple agents and clamps expired resetsAt to now', () => {
  const Model = loadModel();
  const now = 1_700_000_000_000;

  const payload = JSON.stringify({
    updatedAt: now,
    totals: {
      tokensToday: 193_065_876,
      costToday: 48.2,
      burnRateTokensPerHour: 42_100,
      activeSessions: 2,
    },
    projects: {
      '/work/fakih': { projectId: 1, root: '/work/fakih', name: 'Fakih', tokensToday: 108_568_094, costToday: 30.1 },
      '/work/oooha': { projectId: 2, root: '/work/oooha', name: 'OOOHA', tokensToday: 77_646_400, costToday: 18.1 },
    },
    quotas: {
      claude: { '5h': 68, '7d': 35 },
      codex: { '5h': 96, '7d': 76 },
    },
    forecasts: [
      {
        agent: 'claude',
        window: '5h',
        usedPct: 68,
        resetsAt: now + 102 * 60_000, // 1h 42m
        burnRatePctPerHour: 12,
        projectedExhaustionTs: null,
        willExhaustBeforeReset: false,
        message: null,
      },
      {
        agent: 'codex',
        window: '5h',
        usedPct: 96,
        resetsAt: now - 60_000, // expired in the past
        burnRatePctPerHour: 25,
        projectedExhaustionTs: now - 10_000,
        willExhaustBeforeReset: true,
        message: '5h limit currently exhausted',
      },
    ],
    statuslineForecast: '5h limit currently exhausted',
    topRecommendation: {
      id: 'rec-1',
      rule: 'hot_files',
      severity: 'high',
      title: 'Hot file re-read: src/db.ts',
      action: 'Add summary to CLAUDE.md',
      estTokensSavedWeek: 45_000,
      projectName: 'Fakih',
      prompt: 'Add a concise architectural summary of src/db.ts to CLAUDE.md.',
    },
  });

  const state = Model.parseSummaryJson(payload, now);
  assert.equal(state.hasData, true);
  assert.equal(state.bindingAgent, 'codex');
  assert.equal(state.binding5hPct, 96);
  assert.equal(state.binding5hReset, 'now');
  assert.equal(state.severity, 'danger');
  assert.equal(state.tokensToday, 193_065_876);
  assert.equal(state.costToday, 48.2);
  assert.equal(state.burnRatePerHour, 42_100);
  assert.equal(state.topProjects.length, 2);
  assert.equal(state.topProjects[0].name, 'Fakih');
  assert.ok(state.topRecommendation);
  assert.equal(state.topRecommendation.projectName, 'Fakih');
});

test('Model.js evaluates warning vs danger severity from quota percentage and imminent exhaustion', () => {
  const Model = loadModel();
  const now = 1_700_000_000_000;

  // 82% without imminent exhaustion -> warning
  const warnPayload = JSON.stringify({
    updatedAt: now,
    totals: { tokensToday: 50_000, costToday: 0.25, burnRateTokensPerHour: 10_000, activeSessions: 1 },
    projects: {},
    quotas: { claude: { '5h': 82 } },
    forecasts: [
      {
        agent: 'claude',
        window: '5h',
        usedPct: 82,
        resetsAt: now + 90 * 60_000,
        burnRatePctPerHour: 5,
        projectedExhaustionTs: null,
        willExhaustBeforeReset: false,
        message: null,
      },
    ],
  });
  const warnState = Model.parseSummaryJson(warnPayload, now);
  assert.equal(warnState.severity, 'warning');

  // 68% but projected exhaustion in 20 minutes (<= 30m) -> danger
  const imminentPayload = JSON.stringify({
    updatedAt: now,
    totals: { tokensToday: 50_000, costToday: 0.25, burnRateTokensPerHour: 95_000, activeSessions: 1 },
    projects: {},
    quotas: { claude: { '5h': 68 } },
    forecasts: [
      {
        agent: 'claude',
        window: '5h',
        usedPct: 68,
        resetsAt: now + 102 * 60_000,
        burnRatePctPerHour: 96,
        projectedExhaustionTs: now + 20 * 60_000,
        willExhaustBeforeReset: true,
        message: 'at this pace you hit the 5h limit in 20m',
      },
    ],
  });
  const imminentState = Model.parseSummaryJson(imminentPayload, now);
  assert.equal(imminentState.severity, 'danger');
});

test('Model.formatBarLabel and formatters format quota, countdown, burn rate, tokens, and cost', () => {
  const Model = loadModel();
  const now = 1_700_000_000_000;

  assert.equal(Model.formatTokens(0), '0');
  assert.equal(Model.formatTokens(42_100), '42.1k');
  assert.equal(Model.formatTokens(193_065_876), '193.1M');
  assert.equal(Model.formatCost(0), '$0.00');
  assert.equal(Model.formatCost(0.06), '$0.06');
  assert.equal(Model.formatCost(48.2), '$48.20');

  const payload = JSON.stringify({
    updatedAt: now,
    totals: { tokensToday: 85_000, costToday: 0.42, burnRateTokensPerHour: 42_100, activeSessions: 1 },
    projects: {},
    quotas: { claude: { '5h': 68 } },
    forecasts: [
      {
        agent: 'claude',
        window: '5h',
        usedPct: 68,
        resetsAt: now + 102 * 60_000,
        burnRatePctPerHour: 10,
        projectedExhaustionTs: null,
        willExhaustBeforeReset: false,
        message: null,
      },
    ],
  });

  const state = Model.parseSummaryJson(payload, now);
  assert.equal(
    Model.formatBarLabel(state, { showCountdown: true, showBurnRate: true }),
    '⚡ 68% (1h 42m) · 🔥 42.1k/h',
  );
  assert.equal(
    Model.formatBarLabel(state, { showCountdown: true, showBurnRate: false }),
    '⚡ 68% (1h 42m)',
  );
  assert.equal(
    Model.formatBarLabel(state, { showCountdown: false, showBurnRate: false }),
    '⚡ 68%',
  );
});

test('manifest.json and icon.svg exist and conform to Omarchy Quattro schemaVersion 1', () => {
  assert.ok(existsSync(MANIFEST_PATH), 'manifest.json must exist');
  assert.ok(existsSync(ICON_PATH), 'assets/icon.svg must exist');

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, 'agentlens.bar-widget');
  assert.deepEqual(manifest.kinds, ['bar-widget']);
  assert.equal(manifest.entryPoints?.barWidget, 'BarWidget.qml');
  assert.equal(manifest.barWidget?.defaultSection, 'right');
});

test('BarWidget.qml and Panel.qml exist and use valid Omarchy Quattro qs.Commons and qs.Ui components', () => {
  const barWidgetPath = join(PLUGIN_DIR, 'BarWidget.qml');
  const panelPath = join(PLUGIN_DIR, 'Panel.qml');
  const readmePath = join(PLUGIN_DIR, 'README.md');

  assert.ok(existsSync(barWidgetPath), 'BarWidget.qml must exist');
  assert.ok(existsSync(panelPath), 'Panel.qml must exist');
  assert.ok(existsSync(readmePath), 'README.md must exist');

  const barQml = readFileSync(barWidgetPath, 'utf8');
  const panelQml = readFileSync(panelPath, 'utf8');

  assert.match(barQml, /import qs\.Commons/);
  assert.match(barQml, /import qs\.Ui/);
  assert.match(barQml, /moduleName:\s*"agentlens\.bar-widget"/);
  assert.match(barQml, /IpcHandler/);
  assert.match(barQml, /target:\s*"agentlens\.bar-widget"/);
  assert.match(barQml, /WidgetButton/);
  assert.match(barQml, /FileView/);

  assert.match(panelQml, /import qs\.Commons/);
  assert.match(panelQml, /import qs\.Ui/);
  assert.match(panelQml, /moduleName:\s*"agentlens\.bar-widget"/);
  assert.match(panelQml, /KeyboardPanel/);
  assert.match(panelQml, /PanelKeyCatcher/);
  assert.match(panelQml, /PanelHero/);
  assert.match(panelQml, /PanelSectionHeader/);
  assert.match(panelQml, /PanelSeparator/);

  // Ensure no non-existent pseudo-components are referenced
  for (const invalid of ['BarButton', 'StatusBadge', 'StatBox', 'Divider']) {
    assert.ok(!barQml.includes(invalid), `BarWidget.qml must not reference ${invalid}`);
    assert.ok(!panelQml.includes(invalid), `Panel.qml must not reference ${invalid}`);
  }
});

test('Model.buildStateFromApi parses /api/quota latest array and returns hasData: false when empty', () => {
  const Model = loadModel();
  const now = 1_700_000_000_000;

  const emptyFallback = Model.buildStateFromApi(null, { latest: [], forecasts: [] }, now);
  assert.equal(emptyFallback.hasData, false);

  const validFallback = Model.buildStateFromApi(
    { tokens: 25_000, cost: 0.15 },
    {
      latest: [{ agent: 'claude', window: '5h', usedPct: 54, resetsAt: now + 60 * 60_000 }],
      forecasts: [],
    },
    now,
  );
  assert.equal(validFallback.hasData, true);
  assert.equal(validFallback.bindingAgent, 'claude');
  assert.equal(validFallback.binding5hPct, 54);
});


