.pragma library

var AGENT_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  gemini: "Gemini CLI",
  aider: "Aider",
  cursor: "Cursor"
};

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function agentDisplayName(agentId) {
  var key = String(agentId || "").toLowerCase();
  if (AGENT_LABELS[key]) return AGENT_LABELS[key];
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : "Agent";
}

function formatTokens(n) {
  var val = Number(n) || 0;
  if (val >= 1000000) return (val / 1000000).toFixed(1) + "M";
  if (val >= 1000) return (val / 1000).toFixed(1) + "k";
  return String(Math.round(val));
}

function formatCost(n) {
  var val = Number(n) || 0;
  return "$" + val.toFixed(2);
}

function formatDurationMs(ms) {
  var val = Number(ms);
  if (!isFinite(val) || val <= 0) return "now";
  var totalMins = Math.floor(val / 60000);
  if (totalMins <= 0) return "1m";
  var days = Math.floor(totalMins / (60 * 24));
  var hours = Math.floor((totalMins % (60 * 24)) / 60);
  var mins = totalMins % 60;
  if (days > 0) return days + "d " + hours + "h";
  if (hours > 0) return hours + "h " + mins + "m";
  return mins + "m";
}

function cyclePillMode(currentMode) {
  if (currentMode === "full") return "compact";
  if (currentMode === "compact") return "cost";
  return "full";
}

function emptyState() {
  return {
    hasData: false,
    updatedAt: 0,
    severity: "normal",
    bindingAgent: null,
    binding5hPct: -1,
    binding5hReset: "--",
    binding7dPct: -1,
    binding7dReset: "--",
    tokensToday: 0,
    costToday: 0,
    burnRatePerHour: 0,
    activeSessions: 0,
    agents: [],
    agentQuotas: [],
    byAgentToday: [],
    switchAdvice: null,
    liveAlerts: [],
    projects: [],
    projectList: [],
    daily7d: [],
    topModels: [],
    topRecommendation: null,
    recommendations: [],
    statuslineForecast: ""
  };
}

function parseSummaryJson(rawText, nowMs) {
  if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
    return emptyState();
  }
  var parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    return emptyState();
  }
  if (!parsed || typeof parsed !== "object") {
    return emptyState();
  }

  var now = isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  var totals = parsed.totals || {};
  var quotas = parsed.quotas || {};
  var forecasts = Array.isArray(parsed.forecasts) ? parsed.forecasts : [];

  var forecastMap = {};
  var imminentExhaustion = false;
  var forecastHeadline = parsed.statuslineForecast || "";

  for (var i = 0; i < forecasts.length; i++) {
    var f = forecasts[i];
    if (!f || !f.agent || !f.window) continue;
    var key = f.agent + ":" + f.window;
    forecastMap[key] = f;
    if (f.window === "5h" && f.willExhaustBeforeReset) {
      if (!forecastHeadline && f.message) {
        forecastHeadline = f.message;
      }
      var exhaustAt = Number(f.projectedExhaustionTs);
      if (isFinite(exhaustAt) && exhaustAt - now <= 30 * 60000) {
        imminentExhaustion = true;
      } else if (!isFinite(exhaustAt) && f.message) {
        var matchMins = String(f.message).match(/in\s+(\d+)m/i);
        if (matchMins && Number(matchMins[1]) <= 30 && !/h\s+\d+m/i.test(String(f.message))) {
          imminentExhaustion = true;
        }
      }
    }
  }

  var agentNames = ["claude", "codex"];
  for (var k in quotas) {
    if (agentNames.indexOf(k) === -1) agentNames.push(k);
  }

  var agents = [];
  var agentQuotas = [];
  var bindingAgent = null;
  var binding5hPct = -1;
  var binding5hReset = "--";
  var binding7dPct = -1;
  var binding7dReset = "--";

  var span5hMs = 5 * 3600 * 1000;
  var span7dMs = 7 * 86400 * 1000;

  for (var ai = 0; ai < agentNames.length; ai++) {
    var agentName = agentNames[ai];
    var qObj = quotas[agentName];
    var f5 = forecastMap[agentName + ":5h"];
    var f7 = forecastMap[agentName + ":7d"];
    if (!qObj && !f5 && !f7) continue;

    var pct5h = qObj && typeof qObj["5h"] === "number" ? Math.round(qObj["5h"]) : (f5 && typeof f5.usedPct === "number" ? Math.round(f5.usedPct) : -1);
    var pct7d = qObj && typeof qObj["7d"] === "number" ? Math.round(qObj["7d"]) : (f7 && typeof f7.usedPct === "number" ? Math.round(f7.usedPct) : -1);

    var rem5hMs = f5 && typeof f5.resetsAt === "number" ? f5.resetsAt - now : -1;
    var rem7dMs = f7 && typeof f7.resetsAt === "number" ? f7.resetsAt - now : -1;
    var reset5hStr = f5 && typeof f5.resetsAt === "number" ? formatDurationMs(rem5hMs) : "--";
    var reset7dStr = f7 && typeof f7.resetsAt === "number" ? formatDurationMs(rem7dMs) : "--";

    var elapsedPct5h = rem5hMs > 0 ? clamp(Math.round((1 - rem5hMs / span5hMs) * 100), 0, 100) : -1;
    var paceDelta5h = (pct5h >= 0 && elapsedPct5h >= 0) ? (pct5h - elapsedPct5h) : 0;

    var elapsedPct7d = rem7dMs > 0 ? clamp(Math.round((1 - rem7dMs / span7dMs) * 100), 0, 100) : -1;
    var paceDelta7d = (pct7d >= 0 && elapsedPct7d >= 0) ? (pct7d - elapsedPct7d) : 0;

    var displayName = agentDisplayName(agentName);
    var agentRecord = {
      agent: agentName,
      displayName: displayName,
      pct5h: pct5h,
      usedPct5h: pct5h,
      reset5h: reset5hStr,
      elapsedPct5h: elapsedPct5h,
      paceDelta5h: paceDelta5h,
      pct7d: pct7d,
      usedPct7d: pct7d,
      reset7d: reset7dStr,
      elapsedPct7d: elapsedPct7d,
      paceDelta7d: paceDelta7d,
      willExhaust5h: Boolean(f5 && f5.willExhaustBeforeReset),
      forecast5h: (f5 && f5.message) ? String(f5.message) : "",
      willExhaust7d: Boolean(f7 && f7.willExhaustBeforeReset),
      forecast7d: (f7 && f7.message) ? String(f7.message) : ""
    };

    agents.push(agentRecord);
    agentQuotas.push(agentRecord);

    if (pct5h > binding5hPct) {
      binding5hPct = pct5h;
      bindingAgent = agentName;
      binding5hReset = reset5hStr;
      binding7dPct = pct7d;
      binding7dReset = reset7dStr;
    }
  }

  // Cross-Agent Switch Advisor: if one agent has 5h >= 80% and another has 5h <= 50%
  var switchAdvice = null;
  var constrainedAgent = null;
  var headroomAgent = null;
  for (var si = 0; si < agentQuotas.length; si++) {
    var aq = agentQuotas[si];
    if (aq.usedPct5h >= 80 && (!constrainedAgent || aq.usedPct5h > constrainedAgent.usedPct5h)) {
      constrainedAgent = aq;
    }
    if (aq.usedPct5h >= 0 && aq.usedPct5h <= 50 && (!headroomAgent || aq.usedPct5h < headroomAgent.usedPct5h)) {
      headroomAgent = aq;
    }
  }
  if (constrainedAgent && headroomAgent && constrainedAgent.agent !== headroomAgent.agent) {
    switchAdvice = {
      fromAgent: constrainedAgent.agent,
      fromDisplayName: constrainedAgent.displayName,
      fromPct: constrainedAgent.usedPct5h,
      toAgent: headroomAgent.agent,
      toDisplayName: headroomAgent.displayName,
      toPct: headroomAgent.usedPct5h,
      message: constrainedAgent.displayName + " 5h is at " + constrainedAgent.usedPct5h + "% — switch to " + headroomAgent.displayName + " (" + headroomAgent.usedPct5h + "% used)"
    };
  }

  // Active agents today (includes Antigravity, Claude Code, Codex, OpenCode, etc.)
  var byAgentTodayRaw = Array.isArray(parsed.byAgentToday) ? parsed.byAgentToday : [];
  var maxAgentTokens = 0;
  for (var bai = 0; bai < byAgentTodayRaw.length; bai++) {
    var bt = Number(byAgentTodayRaw[bai] && byAgentTodayRaw[bai].tokens) || 0;
    if (bt > maxAgentTokens) maxAgentTokens = bt;
  }
  var byAgentToday = [];
  for (var baj = 0; baj < byAgentTodayRaw.length; baj++) {
    var baItem = byAgentTodayRaw[baj];
    if (!baItem || !baItem.agent) continue;
    var baTok = Number(baItem.tokens) || 0;
    byAgentToday.push({
      agent: String(baItem.agent),
      displayName: agentDisplayName(baItem.agent),
      tokens: baTok,
      cost: Number(baItem.cost) || 0,
      sessions: Number(baItem.sessions) || 0,
      barRatio: maxAgentTokens > 0 ? baTok / maxAgentTokens : 0
    });
  }

  // Live alerts (last 30m waste findings)
  var liveAlertsRaw = Array.isArray(parsed.liveAlerts) ? parsed.liveAlerts : [];
  var liveAlerts = [];
  for (var lai = 0; lai < liveAlertsRaw.length; lai++) {
    var la = liveAlertsRaw[lai];
    if (!la || !la.rule) continue;
    liveAlerts.push({
      id: String(la.id || lai),
      rule: String(la.rule),
      severity: String(la.severity || "medium"),
      title: String(la.title || la.rule),
      detail: String(la.detail || ""),
      projectName: la.projectName ? String(la.projectName) : "global",
      wastedTokens: Number(la.wastedTokens) || 0,
      detectedAt: Number(la.detectedAt) || now
    });
  }

  // Projects map + enriched projectList with weekly budgets
  var projectsObj = parsed.projects || {};
  var projectListLegacy = [];
  for (var rootPath in projectsObj) {
    var p = projectsObj[rootPath];
    if (!p) continue;
    projectListLegacy.push({
      projectId: p.projectId || 0,
      root: p.root || rootPath,
      path: p.root || rootPath,
      name: p.name || "unknown",
      tokensToday: Number(p.tokensToday) || 0,
      costToday: Number(p.costToday) || 0,
      weeklyTokenBudget: null,
      weeklyTokensUsed: Number(p.tokensToday) || 0,
      budgetUsedPct: null
    });
  }
  projectListLegacy.sort(function(a, b) {
    return b.tokensToday - a.tokensToday;
  });
  var topProjects = projectListLegacy.slice(0, 3);

  var projectListRaw = Array.isArray(parsed.projectList) ? parsed.projectList : projectListLegacy;
  var projectList = [];
  for (var pli = 0; pli < projectListRaw.length; pli++) {
    var pl = projectListRaw[pli];
    if (!pl) continue;
    projectList.push({
      projectId: Number(pl.projectId) || 0,
      name: String(pl.name || "unknown"),
      path: String(pl.path || pl.root || ""),
      tokensToday: Number(pl.tokensToday) || 0,
      costToday: Number(pl.costToday) || 0,
      weeklyTokenBudget: pl.weeklyTokenBudget != null ? Number(pl.weeklyTokenBudget) : null,
      weeklyTokensUsed: Number(pl.weeklyTokensUsed) || 0,
      budgetUsedPct: pl.budgetUsedPct != null ? Number(pl.budgetUsedPct) : null
    });
  }

  // 7-day daily bars
  var daily7dRaw = Array.isArray(parsed.daily7d) ? parsed.daily7d : [];
  var maxDailyTokens = 0;
  for (var di = 0; di < daily7dRaw.length; di++) {
    var dt = Number(daily7dRaw[di] && daily7dRaw[di].tokens) || 0;
    if (dt > maxDailyTokens) maxDailyTokens = dt;
  }
  var daily7d = [];
  for (var dj = 0; dj < daily7dRaw.length; dj++) {
    var dItem = daily7dRaw[dj];
    if (!dItem || !dItem.day) continue;
    var dTok = Number(dItem.tokens) || 0;
    var shortDay = String(dItem.day).slice(5); // MM-DD
    daily7d.push({
      day: String(dItem.day),
      shortDay: shortDay,
      tokens: dTok,
      cost: Number(dItem.cost) || 0,
      barRatio: maxDailyTokens > 0 ? dTok / maxDailyTokens : 0,
      isToday: dj === daily7dRaw.length - 1
    });
  }

  // Top models (7d)
  var topModelsRaw = Array.isArray(parsed.topModels) ? parsed.topModels : [];
  var maxModelTokens = 0;
  for (var mi = 0; mi < topModelsRaw.length; mi++) {
    var mt = Number(topModelsRaw[mi] && topModelsRaw[mi].tokens) || 0;
    if (mt > maxModelTokens) maxModelTokens = mt;
  }
  var topModels = [];
  for (var mj = 0; mj < topModelsRaw.length; mj++) {
    var mItem = topModelsRaw[mj];
    if (!mItem || !mItem.model) continue;
    var mTok = Number(mItem.tokens) || 0;
    topModels.push({
      model: String(mItem.model),
      tokens: mTok,
      inputTokens: Number(mItem.inputTokens) || 0,
      outputTokens: Number(mItem.outputTokens) || 0,
      cacheTokens: Number(mItem.cacheTokens) || 0,
      cost: Number(mItem.cost) || 0,
      barRatio: maxModelTokens > 0 ? mTok / maxModelTokens : 0
    });
  }

  // Recommendations list (Top 5) + backwards-compatible topRecommendation
  var recommendations = [];
  if (Array.isArray(parsed.recommendations) && parsed.recommendations.length > 0) {
    for (var ri = 0; ri < parsed.recommendations.length; ri++) {
      var rItem = parsed.recommendations[ri];
      if (!rItem || !rItem.title) continue;
      recommendations.push({
        id: String(rItem.id || ri),
        rule: String(rItem.rule || ""),
        severity: String(rItem.severity || "medium"),
        title: String(rItem.title),
        action: String(rItem.action || ""),
        estTokensSavedWeek: Number(rItem.estTokensSavedWeek) || 0,
        projectName: String(rItem.projectName || "global"),
        prompt: String(rItem.prompt || "")
      });
    }
  } else if (parsed.topRecommendation && parsed.topRecommendation.title) {
    var tr = parsed.topRecommendation;
    recommendations.push({
      id: String(tr.id || "0"),
      rule: String(tr.rule || ""),
      severity: String(tr.severity || "medium"),
      title: String(tr.title),
      action: String(tr.action || ""),
      estTokensSavedWeek: Number(tr.estTokensSavedWeek) || 0,
      projectName: String(tr.projectName || "global"),
      prompt: String(tr.prompt || "")
    });
  }

  var severity = "normal";
  if (binding5hPct >= 95 || imminentExhaustion) {
    severity = "danger";
  } else if (binding5hPct >= 80 || liveAlerts.length > 0) {
    severity = "warning";
  }

  return {
    hasData: true,
    updatedAt: Number(parsed.updatedAt) || now,
    severity: severity,
    bindingAgent: bindingAgent,
    binding5hPct: binding5hPct,
    binding5hReset: binding5hReset,
    binding7dPct: binding7dPct,
    binding7dReset: binding7dReset,
    tokensToday: Number(totals.tokensToday) || 0,
    costToday: Number(totals.costToday) || 0,
    burnRatePerHour: Number(totals.burnRateTokensPerHour) || 0,
    activeSessions: Number(totals.activeSessions) || 0,
    agents: agents,
    agentQuotas: agentQuotas,
    byAgentToday: byAgentToday,
    switchAdvice: switchAdvice,
    liveAlerts: liveAlerts,
    projects: topProjects,
    topProjects: topProjects,
    projectList: projectList,
    daily7d: daily7d,
    topModels: topModels,
    topRecommendation: recommendations.length > 0 ? recommendations[0] : null,
    recommendations: recommendations,
    statuslineForecast: forecastHeadline
  };
}

function formatBarLabel(state, pillModeOrOpts) {
  if (!state || !state.hasData) return "⚡ --";

  if (pillModeOrOpts && typeof pillModeOrOpts === "object") {
    var showCountdown = pillModeOrOpts.showCountdown !== false;
    var showBurnRate = pillModeOrOpts.showBurnRate !== false;
    var optParts = [];
    if (state.binding5hPct >= 0) {
      var qStr = "⚡ " + Math.round(state.binding5hPct) + "%";
      if (showCountdown && state.binding5hReset && state.binding5hReset !== "--") {
        qStr += " (" + state.binding5hReset + ")";
      }
      optParts.push(qStr);
    }
    if (showBurnRate && state.burnRatePerHour > 0) {
      optParts.push("🔥 " + formatTokens(state.burnRatePerHour) + "/h");
    }
    if (optParts.length === 0) {
      optParts.push(state.tokensToday > 0 ? ("⚡ " + formatTokens(state.tokensToday)) : "⚡ 0");
    }
    if (state.liveAlerts && state.liveAlerts.length > 0) {
      optParts.push("⚠ " + state.liveAlerts.length);
    }
    return optParts.join(" · ");
  }

  var mode = String(pillModeOrOpts || "full");
  var parts = [];

  if (mode === "compact") {
    if (state.binding5hPct >= 0) {
      parts.push("⚡ " + Math.round(state.binding5hPct) + "%");
    } else if (state.tokensToday > 0) {
      parts.push("⚡ " + formatTokens(state.tokensToday));
    } else {
      parts.push("⚡ 0");
    }
  } else if (mode === "cost") {
    if (state.binding5hPct >= 0) {
      parts.push("⚡ " + Math.round(state.binding5hPct) + "%");
    } else {
      parts.push("⚡ " + formatTokens(state.tokensToday));
    }
    parts.push(formatCost(state.costToday));
  } else {
    // "full" mode
    if (state.binding5hPct >= 0) {
      var quotaPart = "⚡ " + Math.round(state.binding5hPct) + "%";
      if (state.binding5hReset && state.binding5hReset !== "--") {
        quotaPart += " (" + state.binding5hReset + ")";
      }
      parts.push(quotaPart);
    }
    if (state.burnRatePerHour > 0) {
      parts.push("🔥 " + formatTokens(state.burnRatePerHour) + "/h");
    }
    if (parts.length === 0) {
      if (state.tokensToday > 0) {
        parts.push("⚡ " + formatTokens(state.tokensToday));
      } else {
        parts.push("⚡ 0");
      }
    }
  }

  if (state.liveAlerts && state.liveAlerts.length > 0) {
    parts.push("⚠ " + state.liveAlerts.length);
  }

  return parts.join(" · ");
}

function formatTooltip(state) {
  if (!state || !state.hasData) return "agentlens — No active telemetry";
  var parts = [];
  if (state.bindingAgent && state.binding5hPct >= 0) {
    parts.push(agentDisplayName(state.bindingAgent) + " 5h: " + state.binding5hPct + "% (resets " + state.binding5hReset + ")");
  }
  parts.push("Today: " + formatTokens(state.tokensToday) + " (" + formatCost(state.costToday) + ")");
  if (state.burnRatePerHour > 0) {
    parts.push("Burn: " + formatTokens(state.burnRatePerHour) + "/h");
  }
  if (state.liveAlerts && state.liveAlerts.length > 0) {
    parts.push("Alerts: " + state.liveAlerts.length + " active");
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

function acceptRecommendation(recId, baseUrl, callback) {
  if (typeof XMLHttpRequest === "undefined" || !recId) return;
  var base = String(baseUrl || "http://127.0.0.1:4711").replace(/\/+$/, "");
  var xhr = new XMLHttpRequest();
  xhr.open("POST", base + "/api/recommendations/" + encodeURIComponent(String(recId)) + "/accept", true);
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.onreadystatechange = function() {
    if (xhr.readyState === XMLHttpRequest.DONE) {
      var ok = xhr.status >= 200 && xhr.status < 300;
      if (typeof callback === "function") callback(ok);
    }
  };
  xhr.send("{}");
}

function normalizeOptimizeResponse(res) {
  if (!res || typeof res !== "object") return { actionCount: 0, estTokensSaved: 0, raw: res };
  var actionCount = 0;
  if (Array.isArray(res.actions)) {
    actionCount = res.actions.length;
  } else if (Array.isArray(res.applied)) {
    actionCount = res.applied.length;
  } else {
    if (Array.isArray(res.ignoreFiles)) {
      for (var i = 0; i < res.ignoreFiles.length; i++) {
        var ig = res.ignoreFiles[i];
        if (ig && Array.isArray(ig.addedPatterns) && ig.addedPatterns.length > 0) actionCount++;
      }
    }
    if (Array.isArray(res.instructionTrims)) {
      for (var j = 0; j < res.instructionTrims.length; j++) {
        var tr = res.instructionTrims[j];
        if (tr && Array.isArray(tr.cuts) && tr.cuts.length > 0) actionCount++;
      }
    }
  }
  var estTokensSaved = Number(res.estimatedTokensSavedPerTurn || res.estTokensSaved || 0);
  return {
    actionCount: actionCount,
    estTokensSaved: estTokensSaved,
    raw: res
  };
}

function previewWorkspaceOptimize(projectPath, baseUrl, callback) {
  if (typeof XMLHttpRequest === "undefined" || !projectPath) return;
  var base = String(baseUrl || "http://127.0.0.1:4711").replace(/\/+$/, "");
  var enc = encodeURIComponent(String(projectPath));
  var xhr = new XMLHttpRequest();
  xhr.open("GET", base + "/api/optimize?path=" + enc + "&project=" + enc, true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState === XMLHttpRequest.DONE) {
      if (xhr.status === 200) {
        try {
          var res = JSON.parse(xhr.responseText);
          if (typeof callback === "function") callback(null, normalizeOptimizeResponse(res));
          return;
        } catch (e) {}
      }
      if (typeof callback === "function") callback("Could not preview workspace hygiene", null);
    }
  };
  xhr.send();
}

function applyWorkspaceOptimize(projectPath, baseUrl, callback) {
  if (typeof XMLHttpRequest === "undefined" || !projectPath) return;
  var base = String(baseUrl || "http://127.0.0.1:4711").replace(/\/+$/, "");
  var xhr = new XMLHttpRequest();
  xhr.open("POST", base + "/api/optimize", true);
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.onreadystatechange = function() {
    if (xhr.readyState === XMLHttpRequest.DONE) {
      if (xhr.status === 200) {
        try {
          var res = JSON.parse(xhr.responseText);
          if (typeof callback === "function") callback(null, normalizeOptimizeResponse(res));
          return;
        } catch (e) {}
      }
      if (typeof callback === "function") callback("Could not apply workspace hygiene", null);
    }
  };
  xhr.send(JSON.stringify({ project: String(projectPath), projectRoot: String(projectPath), apply: true }));
}

if (typeof module !== "undefined") {
  module.exports = {
    agentDisplayName: agentDisplayName,
    formatTokens: formatTokens,
    formatCost: formatCost,
    formatDurationMs: formatDurationMs,
    cyclePillMode: cyclePillMode,
    emptyState: emptyState,
    parseSummaryJson: parseSummaryJson,
    formatBarLabel: formatBarLabel,
    formatTooltip: formatTooltip,
    buildSyntheticSummaryFromApi: buildSyntheticSummaryFromApi,
    buildStateFromApi: buildStateFromApi,
    fetchHttpFallback: fetchHttpFallback,
    acceptRecommendation: acceptRecommendation,
    previewWorkspaceOptimize: previewWorkspaceOptimize,
    applyWorkspaceOptimize: applyWorkspaceOptimize
  };
}
