import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Live AI coding agent quota, token burn velocity, and remediation widget for Omarchy Quattro.
// Left-click toggles the details panel; middle-click forces a refresh; right-click opens the web dashboard.
BarWidget {
  id: root
  moduleName: "agentlens.bar-widget"

  readonly property string stateHome: {
    var xdg = Quickshell.env("XDG_STATE_HOME")
    if (xdg && String(xdg).trim() !== "") return String(xdg).trim()
    return String(Quickshell.env("HOME") || "") + "/.local/state"
  }
  readonly property string summaryPath: stateHome + "/agentlens/summary.json"

  readonly property int refreshIntervalSec: Math.max(2, Number(setting("refreshIntervalSec", 5)) || 5)
  readonly property bool showCountdown: setting("showCountdown", true) !== false
  readonly property bool showBurnRate: setting("showBurnRate", true) !== false
  readonly property string dashboardUrl: String(setting("dashboardUrl", "http://127.0.0.1:4711") || "http://127.0.0.1:4711")

  property string rawSummary: ""
  property double nowMs: Date.now()
  property var state: Model.parseSummaryJson(rawSummary, nowMs)

  readonly property bool hasData: state ? state.hasData === true : false
  readonly property string severity: state ? String(state.severity || "normal") : "normal"
  readonly property int quota5hPct: state ? Number(state.binding5hPct) : -1
  readonly property string quota5hReset: state ? String(state.binding5hReset || "") : ""
  readonly property int tokensToday: state ? Number(state.tokensToday || 0) : 0
  readonly property double costToday: state ? Number(state.costToday || 0) : 0
  readonly property int burnRatePerHour: state ? Number(state.burnRatePerHour || 0) : 0
  readonly property int activeSessions: state ? Number(state.activeSessions || 0) : 0
  readonly property string statuslineForecast: state ? String(state.statuslineForecast || "") : ""
  readonly property var agentWindows: state && state.agentWindows ? state.agentWindows : []
  readonly property var topProjects: state && state.topProjects ? state.topProjects : []
  readonly property var topRecommendation: state ? state.topRecommendation : null

  readonly property color baseForeground: bar ? bar.barForeground : Color.foreground
  readonly property color urgentColor: bar ? bar.urgent : Color.urgent
  readonly property color warningColor: "#f59e0b"
  readonly property color pillColor:
    severity === "danger" ? urgentColor :
    severity === "warning" ? warningColor :
    baseForeground

  readonly property string displayLabel: Model.formatBarLabel(state, {
    showCountdown: root.showCountdown,
    showBurnRate: root.showBurnRate
  })
  readonly property string tooltipString: Model.formatTooltip(state)

  function refresh() {
    nowMs = Date.now()
    summaryFile.reload()
  }

  function openDashboard() {
    Quickshell.execDetached(["xdg-open", root.dashboardUrl])
  }

  function copyTextToClipboard(text) {
    if (!text || String(text).trim() === "") return
    var escaped = String(text).replace(/'/g, "'\\''")
    var cmd = "printf '%s' '" + escaped + "' | (wl-copy 2>/dev/null || xclip -selection clipboard 2>/dev/null || xsel --clipboard --input 2>/dev/null)"
    Quickshell.execDetached(["sh", "-c", cmd])
  }

  // ---- Panel plumbing (conforming to Bar.findPanelWidget & popout switch contract)
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property real openPanelIndicatorWidth: button.labelWidth
  readonly property real openPanelIndicatorHeight: Math.max(Style.space(10), Math.round(Style.bar.iconSlot * 0.55))
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item && panelLoader.item.closeForPopoutSwitch)
      panelLoader.item.closeForPopoutSwitch()
  }

  function open() {
    if (panelLoader.item) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item) panelLoader.item.close()
  }

  function togglePanel() {
    if (panelLoader.item) panelLoader.item.toggle()
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  FileView {
    id: summaryFile
    path: root.summaryPath
    watchChanges: true
    printErrors: false
    onLoaded: {
      root.nowMs = Date.now()
      root.rawSummary = String(text() || "")
    }
    onLoadFailed: Model.fetchHttpFallback(root, root.dashboardUrl)
    onFileChanged: reload()
  }

  Timer {
    interval: root.refreshIntervalSec * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "agentlens.bar-widget"

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
    function refresh(): string { root.broadcast("refresh"); return "ok" }
    function status(): string {
      return JSON.stringify({
        hasData: root.hasData,
        severity: root.severity,
        quota5hPct: root.quota5hPct,
        quota5hReset: root.quota5hReset,
        tokensToday: root.tokensToday,
        costToday: root.costToday,
        burnRatePerHour: root.burnRatePerHour,
        activeSessions: root.activeSessions,
        displayLabel: root.displayLabel
      })
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.vertical ? (root.quota5hPct >= 0 ? (root.quota5hPct + "%") : "⚡") : root.displayLabel
    tooltipText: root.tooltipString
    foreground: root.pillColor
    active: root.severity === "danger"
    dimmed: !root.hasData
    horizontalMargin: 8.5
    verticalPadding: 6

    onPressed: function(mouseButton) {
      if (mouseButton === Qt.RightButton) root.openDashboard()
      else if (mouseButton === Qt.MiddleButton) root.refresh()
      else root.togglePanel()
    }
  }
}
