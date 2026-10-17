// Pure state parser and formatting helpers for agentlens.bar-widget.
// Compatible with both QML (`import "Model.js" as Model`) and Node unit tests.

function formatTokens(n) {
  var val = Number(n);
  if (!isFinite(val) || val <= 0) return "0";
  if (val >= 1000000000) return (val / 1000000000).toFixed(2) + "B";
  if (val >= 1000000) return (val / 1000000).toFixed(1) + "M";
  if (val >= 1000) return (val / 1000).toFixed(1) + "k";
  return String(Math.round(val));
}

function formatCost(usd) {
  var val = Number(usd);
  if (!isFinite(val) || val <= 0) return "$0.00";
  if (val >= 100) return "$" + val.toFixed(0);
  return "$" + val.toFixed(2);
}

function formatDurationMs(ms) {
  var val = Number(ms);
  if (!isFinite(val) || val <= 0) return "now";
  var totalMins = Math.floor(val / 60000);
  if (totalMins <= 0) return "now";
  var hours = Math.floor(totalMins / 60);
  var days = Math.floor(hours / 24);
  if (days > 0) return days + "d " + (hours % 24) + "h";
  if (hours > 0) return hours + "h " + (totalMins % 60) + "m";
  return totalMins + "m";
}

function agentDisplayName(agent) {
  var a = String(agent || "").toLowerCase();
  if (a === "claude") return "Claude Code";
  if (a === "codex") return "Codex";
  if (a === "gemini") return "Gemini CLI";
  if (a === "opencode") return "OpenCode";
  if (a === "antigravity") return "Antigravity";
  return a ? (a.charAt(0).toUpperCase() + a.slice(1)) : "Agent";
}

function emptyState() {
  return {
    hasData: false,
    updatedAt: 0,
    bindingAgent: "",
    bindingAgentLabel: "",
    binding5hPct: -1,
    binding5hReset: "",
    bindingWillExhaustSoon: false,
    severity: "normal",
    tokensToday: 0,
    costToday: 0,
    burnRatePerHour: 0,
    activeSessions: 0,
    statuslineForecast: "",
    agentWindows: [],
    topProjects: [],
    topRecommendation: null
  };
}

function parseSummaryJson(rawText, nowMs) {
  var now = isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (!rawText || typeof rawText !== "string" || rawText.trim() === "") {
    return emptyState();
  }

  var data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    return emptyState();
  }

  if (!data || typeof data !== "object") {
    return emptyState();
  }

  var totals = data.totals || {};
  var tokensToday = Number(totals.tokensToday || 0);
  var costToday = Number(totals.costToday || 0);
  var burnRatePerHour = Number(totals.burnRateTokensPerHour || 0);
  var activeSessions = Number(totals.activeSessions || 0);

  var forecasts = Array.isArray(data.forecasts) ? data.forecasts : [];
  var forecastMap = {};
  for (var i = 0; i < forecasts.length; i++) {
    var f = forecasts[i];
    if (f && f.agent && f.window) {
      forecastMap[f.agent + ":" + f.window] = f;
    }
  }

  var quotas = data.quotas || {};
  var agentOrder = ["claude", "codex"];
  for (var k in quotas) {
    if (agentOrder.indexOf(k) === -1) agentOrder.push(k);
  }

  var agentWindows = [];
  var bindingAgent = "";
  var binding5hPct = -1;
  var binding5hReset = "";
  var anyImminentExhaustion = false;
  var anyWillExhaust = false;

  for (var aIdx = 0; aIdx < agentOrder.length; aIdx++) {
    var agentKey = agentOrder[aIdx];
    var qObj = quotas[agentKey] || {};
    var winKeys = ["5h", "7d"];

    for (var wIdx = 0; wIdx < winKeys.length; wIdx++) {
      var winKey = winKeys[wIdx];
      var fc = forecastMap[agentKey + ":" + winKey] || null;
      var rawPct = qObj[winKey] != null ? Number(qObj[winKey]) : (fc && fc.usedPct != null ? Number(fc.usedPct) : -1);
      if (!isFinite(rawPct) || rawPct < 0) continue;

      var pct = Math.round(Math.max(0, Math.min(100, rawPct)));
      var resetsAt = fc && fc.resetsAt != null ? Number(fc.resetsAt) : 0;
      var resetText = resetsAt > 0 ? formatDurationMs(resetsAt - now) : "";
      var willExhaust = !!(fc && fc.willExhaustBeforeReset);
      var projTs = fc && fc.projectedExhaustionTs != null ? Number(fc.projectedExhaustionTs) : 0;
      var exhaustSoon = willExhaust && projTs > 0 && (projTs - now <= 30 * 60000);

      if (willExhaust) anyWillExhaust = true;
      if (exhaustSoon) anyImminentExhaustion = true;

      var winTitle = agentDisplayName(agentKey) + " · " + (winKey === "5h" ? "5h Session" : "7d Weekly");
      agentWindows.push({
        agent: agentKey,
        agentLabel: agentDisplayName(agentKey),
        window: winKey,
        title: winTitle,
        usedPct: pct,
        ratio: Math.max(0, Math.min(1, pct / 100)),
        resetsAt: resetsAt,
        resetText: resetText,
        willExhaustBeforeReset: willExhaust,
        exhaustSoon: exhaustSoon,
        message: fc && fc.message ? String(fc.message) : "",
        alarming: pct >= 95 || exhaustSoon,
        warning: (pct >= 80 && pct < 95) || (willExhaust && !exhaustSoon)
      });

      if (winKey === "5h" && pct > binding5hPct) {
        binding5hPct = pct;
        bindingAgent = agentKey;
        binding5hReset = resetText;
      }
    }
  }

  var severity = "normal";
  if (binding5hPct >= 95 || anyImminentExhaustion) {
    severity = "danger";
  } else if (binding5hPct >= 80 || anyWillExhaust) {
    severity = "warning";
  }

  var projectsObj = data.projects || {};
  var projectList = [];
  for (var rootPath in projectsObj) {
    var p = projectsObj[rootPath];
    if (p && Number(p.tokensToday || 0) > 0) {
      projectList.push({
        projectId: Number(p.projectId || 0),
        root: String(p.root || rootPath),
        name: String(p.name || "unknown"),
        tokensToday: Number(p.tokensToday || 0),
        tokensFormatted: formatTokens(p.tokensToday || 0),
        costToday: Number(p.costToday || 0),
        costFormatted: formatCost(p.costToday || 0)
      });
    }
  }
  projectList.sort(function(a, b) { return b.tokensToday - a.tokensToday; });
  var topProjects = projectList.slice(0, 3);

  var topRec = null;
  if (data.topRecommendation && typeof data.topRecommendation === "object" && data.topRecommendation.id) {
    var r = data.topRecommendation;
    topRec = {
      id: String(r.id),
      rule: String(r.rule || ""),
      severity: String(r.severity || "medium"),
      title: String(r.title || ""),
      action: String(r.action || ""),
      estTokensSavedWeek: Number(r.estTokensSavedWeek || 0),
      estSavingsFormatted: formatTokens(r.estTokensSavedWeek || 0) + " tok/wk",
      projectName: String(r.projectName || "global"),
      prompt: String(r.prompt || "")
    };
  }

  return {
    hasData: true,
    updatedAt: Number(data.updatedAt || now),
    bindingAgent: bindingAgent,
    bindingAgentLabel: bindingAgent ? agentDisplayName(bindingAgent) : "",
    binding5hPct: binding5hPct,
    binding5hReset: binding5hReset,
    bindingWillExhaustSoon: anyImminentExhaustion,
    severity: severity,
    tokensToday: tokensToday,
    costToday: costToday,
    burnRatePerHour: burnRatePerHour,
    activeSessions: activeSessions,
    statuslineForecast: data.statuslineForecast ? String(data.statuslineForecast) : "",
    agentWindows: agentWindows,
    topProjects: topProjects,
    topRecommendation: topRec
  };
}

function formatBarLabel(state, options) {
  if (!state || !state.hasData) return "⚡ --";
  var opts = options || {};
  var showCountdown = opts.showCountdown !== false;
  var showBurnRate = opts.showBurnRate !== false;

  var base = "";
  if (state.binding5hPct >= 0) {
    base = "⚡ " + state.binding5hPct + "%";
    if (showCountdown && state.binding5hReset && state.binding5hReset !== "") {
      base += " (" + state.binding5hReset + ")";
    }
  } else if (state.tokensToday > 0) {
    base = "⚡ " + formatTokens(state.tokensToday);
  } else {
    base = "⚡ 0%";
  }

  if (showBurnRate && state.burnRatePerHour > 0) {
    base += " · 🔥 " + formatTokens(state.burnRatePerHour) + "/h";
  }

  return base;
}

function formatTooltip(state) {
  if (!state || !state.hasData) {
    return "agentlens: waiting for telemetry (run 'agentlens serve')";
  }
  var parts = [];
  if (state.binding5hPct >= 0) {
    parts.push((state.bindingAgentLabel || "5h Quota") + ": " + state.binding5hPct + "%" + (state.binding5hReset ? (" (resets " + state.binding5hReset + ")") : ""));
  }
  parts.push("Today: " + formatTokens(state.tokensToday) + " (" + formatCost(state.costToday) + ")");
  if (state.burnRatePerHour > 0) {
    parts.push("Burn: " + formatTokens(state.burnRatePerHour) + "/h");
  }
  if (state.statuslineForecast) {
    parts.push(state.statuslineForecast);
  }
  return parts.join(" · ");
}

function buildSyntheticSummaryFromApi(summaryResp, quotaResp, nowMs) {
  var now = isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  var quotas = {};
  var forecasts = [];
  var hasQuotaData = false;
  if (quotaResp && typeof quotaResp === "object") {
    if (Array.isArray(quotaResp.latest)) {
      for (var i = 0; i < quotaResp.latest.length; i++) {
        var entry = quotaResp.latest[i];
        if (entry && entry.agent && (entry.win || entry.window)) {
          var lWin = entry.win || entry.window;
          quotas[entry.agent] = quotas[entry.agent] || {};
          quotas[entry.agent][lWin] = Number(entry.usedPct != null ? entry.usedPct : (entry.percent || 0));
          hasQuotaData = true;
          forecasts.push({
            agent: entry.agent,
            window: lWin,
            usedPct: quotas[entry.agent][lWin],
            resetsAt: entry.resetsAt || 0,
            willExhaustBeforeReset: false,
            message: null
          });
        }
      }
    } else if (quotaResp.windows && typeof quotaResp.windows === "object") {
      for (var k in quotaResp.windows) {
        var w = quotaResp.windows[k];
        if (w && w.agent && (w.win || w.window)) {
          var winName = w.win || w.window;
          quotas[w.agent] = quotas[w.agent] || {};
          quotas[w.agent][winName] = Number(w.usedPct != null ? w.usedPct : (w.percent || 0));
          hasQuotaData = true;
          forecasts.push({
            agent: w.agent,
            window: winName,
            usedPct: quotas[w.agent][winName],
            resetsAt: w.resetsAt || 0,
            willExhaustBeforeReset: false,
            message: null
          });
        }
      }
    }
    if (Array.isArray(quotaResp.forecasts) && quotaResp.forecasts.length > 0) {
      forecasts = quotaResp.forecasts;
      hasQuotaData = true;
    }
  }

  var hasSummaryTokens = Boolean(summaryResp && (summaryResp.tokens != null || summaryResp.cost != null));
  if (!hasQuotaData && !hasSummaryTokens) {
    return null;
  }

  return {
    updatedAt: now,
    totals: {
      tokensToday: summaryResp && summaryResp.tokens != null ? Number(summaryResp.tokens) : 0,
      costToday: summaryResp && summaryResp.cost != null ? Number(summaryResp.cost) : 0,
      burnRateTokensPerHour: 0,
      activeSessions: 0
    },
    projects: {},
    quotas: quotas,
    forecasts: forecasts
  };
}

function buildStateFromApi(summaryResp, quotaResp, nowMs) {
  var now = isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  var synthetic = buildSyntheticSummaryFromApi(summaryResp, quotaResp, now);
  if (!synthetic) return emptyState();
  return parseSummaryJson(JSON.stringify(synthetic), now);
}

function fetchHttpFallback(widget, baseUrl) {
  if (typeof XMLHttpRequest === "undefined" || !widget) return;
  var base = String(baseUrl || "http://127.0.0.1:4711").replace(/\/+$/, "");
  var xhr = new XMLHttpRequest();
  xhr.open("GET", base + "/api/quota", true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState === XMLHttpRequest.DONE && xhr.status === 200) {
      try {
        var quotaResp = JSON.parse(xhr.responseText);
        var synthetic = buildSyntheticSummaryFromApi(null, quotaResp, Date.now());
        if (synthetic) {
          widget.rawSummary = JSON.stringify(synthetic);
        }
      } catch (e) {}
    }
  };
  xhr.send();
}

if (typeof module !== "undefined") {
  module.exports = {
    formatTokens: formatTokens,
    formatCost: formatCost,
    formatDurationMs: formatDurationMs,
    agentDisplayName: agentDisplayName,
    emptyState: emptyState,
    parseSummaryJson: parseSummaryJson,
    buildStateFromApi: buildStateFromApi,
    fetchHttpFallback: fetchHttpFallback,
    formatBarLabel: formatBarLabel,
    formatTooltip: formatTooltip
  };
}

