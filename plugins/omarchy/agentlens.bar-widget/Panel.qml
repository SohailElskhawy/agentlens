import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "agentlens.bar-widget"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color warningColor: "#f59e0b"
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color track: Style.selectedFillFor(foreground, Color.accent)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property bool hasData: hostWidget ? hostWidget.hasData : false
  readonly property string severity: hostWidget ? hostWidget.severity : "normal"
  readonly property var agentQuotas: hostWidget && hostWidget.agentQuotas ? hostWidget.agentQuotas : []
  readonly property var byAgentToday: hostWidget && hostWidget.byAgentToday ? hostWidget.byAgentToday : []
  readonly property var switchAdvice: hostWidget ? hostWidget.switchAdvice : null
  readonly property var liveAlerts: hostWidget && hostWidget.liveAlerts ? hostWidget.liveAlerts : []
  readonly property var projectList: hostWidget && hostWidget.projectList ? hostWidget.projectList : []
  readonly property var daily7d: hostWidget && hostWidget.daily7d ? hostWidget.daily7d : []
  readonly property var topModels: hostWidget && hostWidget.topModels ? hostWidget.topModels : []
  readonly property var recsList: hostWidget && hostWidget.recommendations ? hostWidget.recommendations : []
  readonly property int tokensToday: hostWidget ? hostWidget.tokensToday : 0
  readonly property double costToday: hostWidget ? hostWidget.costToday : 0
  readonly property int burnRatePerHour: hostWidget ? hostWidget.burnRatePerHour : 0
  readonly property string statuslineForecast: hostWidget ? hostWidget.statuslineForecast : ""

  property int activeTab: 0 // 0 = Overview, 1 = Fix & Optimize, 2 = Trends & Budgets
  property int recIndex: 0
  property bool copiedPrompt: false
  property string acceptedRecId: ""
  property string optimizeStatusText: ""
  property bool optimizeBusy: false

  readonly property var currentRec: (recsList.length > 0) ? recsList[Math.max(0, Math.min(root.recIndex, recsList.length - 1))] : null
  readonly property var primaryProject: (projectList.length > 0) ? projectList[0] : null

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
  function alpha(c, a) { return Qt.rgba(c.r, c.g, c.b, a) }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.hostWidget || root, direction)
    return false
  }

  function triggerCopyCurrentPrompt() {
    if (root.hostWidget && root.currentRec) {
      root.hostWidget.copyTextToClipboard(root.currentRec.prompt)
      root.copiedPrompt = true
      copiedResetTimer.restart()
    }
  }

  function triggerAcceptCurrentRec() {
    if (!root.currentRec || !root.currentRec.id) return
    var targetId = root.currentRec.id
    var baseUrl = root.hostWidget ? root.hostWidget.dashboardUrl : "http://127.0.0.1:4711"
    Model.acceptRecommendation(targetId, baseUrl, function(ok) {
      if (ok) {
        root.acceptedRecId = targetId
        if (root.hostWidget) root.hostWidget.refresh()
      }
    })
  }

  function triggerPreviewOptimize() {
    if (!root.primaryProject || !root.primaryProject.path) return
    root.optimizeBusy = true
    root.optimizeStatusText = "Scanning " + root.primaryProject.name + "..."
    var baseUrl = root.hostWidget ? root.hostWidget.dashboardUrl : "http://127.0.0.1:4711"
    Model.previewWorkspaceOptimize(root.primaryProject.path, baseUrl, function(err, res) {
      root.optimizeBusy = false
      if (err || !res) {
        root.optimizeStatusText = err || "Could not preview workspace hygiene"
        return
      }
      var count = Number(res.actionCount || 0)
      root.optimizeStatusText = count > 0
        ? (count + " hygiene actions ready (~" + Model.formatTokens(res.estTokensSaved || 0) + " tokens/turn saved)")
        : "Workspace is already clean!"
    })
  }

  function triggerApplyOptimize() {
    if (!root.primaryProject || !root.primaryProject.path) return
    root.optimizeBusy = true
    root.optimizeStatusText = "Applying hygiene fixes..."
    var baseUrl = root.hostWidget ? root.hostWidget.dashboardUrl : "http://127.0.0.1:4711"
    Model.applyWorkspaceOptimize(root.primaryProject.path, baseUrl, function(err, res) {
      root.optimizeBusy = false
      if (err || !res) {
        root.optimizeStatusText = err || "Could not apply workspace hygiene"
        return
      }
      var count = Number(res.actionCount || 0)
      root.optimizeStatusText = "✓ Applied " + count + " fixes (~" + Model.formatTokens(res.estTokensSaved || 0) + " tokens/turn saved)"
      if (root.hostWidget) root.hostWidget.refresh()
    })
  }

  onOpenedChanged: if (opened) {
    copiedPrompt = false
    if (hostWidget && typeof hostWidget.refresh === "function") hostWidget.refresh()
    if (panelFlick) panelFlick.contentY = 0
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  Timer {
    id: copiedResetTimer
    interval: 2200
    repeat: false
    onTriggered: root.copiedPrompt = false
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(390))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(660))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) {
        if (dx !== 0) {
          root.activeTab = ((root.activeTab + dx) % 3 + 3) % 3
        }
        if (dy !== 0) {
          var step = Style.space(48)
          panelFlick.contentY = root.clamp(panelFlick.contentY + dy * step, 0, Math.max(0, panelFlick.contentHeight - panelFlick.height))
        }
      }
      onTextKey: function(t) {
        if ((t === "r" || t === "R") && root.hostWidget) {
          root.hostWidget.refresh()
        } else if (t === "o" || t === "O") {
          if (root.hostWidget) root.hostWidget.openDashboard()
          root.close()
        } else if (t === "1") {
          root.activeTab = 0
        } else if (t === "2") {
          root.activeTab = 1
        } else if (t === "3") {
          root.activeTab = 2
        } else if (t === "[") {
          if (root.recsList.length > 0) root.recIndex = (root.recIndex + root.recsList.length - 1) % root.recsList.length
        } else if (t === "]") {
          if (root.recsList.length > 0) root.recIndex = (root.recIndex + 1) % root.recsList.length
        } else if (t === "c" || t === "C") {
          root.triggerCopyCurrentPrompt()
        } else if (t === "a" || t === "A") {
          root.triggerAcceptCurrentRec()
        }
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          // ---------- Hero ----------
          PanelHero {
            width: parent.width
            title: "agentlens Monitor"
            detail: !root.hasData ? "OFFLINE" : (root.severity === "danger" ? "LIMIT" : (root.severity === "warning" ? "WARN" : "LIVE"))
            meta: root.statuslineForecast !== "" ? root.statuslineForecast : "Local AI Coding Telemetry"
            foreground: root.foreground
            fontFamily: root.fontFamily

            iconComponent: Component {
              Item {
                width: Style.font.display
                height: Style.font.display

                Image {
                  id: heroIcon
                  anchors.fill: parent
                  source: Qt.resolvedUrl("assets/icon.svg")
                  sourceSize.width: Style.font.display * 2
                  sourceSize.height: Style.font.display * 2
                  fillMode: Image.PreserveAspectFit
                }

                Text {
                  textFormat: Text.PlainText
                  anchors.centerIn: parent
                  visible: heroIcon.status !== Image.Ready
                  text: "⚡"
                  color: Color.accent
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.display
                }
              }
            }
          }

          // ---------- 3-Tab Switcher (1 Overview · 2 Fix & Optimize · 3 Trends) ----------
          Row {
            id: tabRow
            width: parent.width
            spacing: Style.space(6)
            readonly property real tabW: (width - spacing * 2) / 3

            Button {
              width: tabRow.tabW
              bordered: true
              selected: root.activeTab === 0
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.caption
              text: "1 Overview"
              onClicked: root.activeTab = 0
            }

            Button {
              width: tabRow.tabW
              bordered: true
              selected: root.activeTab === 1
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.caption
              text: "2 Fix (" + root.recsList.length + ")"
              onClicked: root.activeTab = 1
            }

            Button {
              width: tabRow.tabW
              bordered: true
              selected: root.activeTab === 2
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.caption
              text: "3 Trends"
              onClicked: root.activeTab = 2
            }
          }

          PanelSeparator {
            foreground: root.foreground
          }

          // ===================================================================
          // TAB 0: OVERVIEW
          // ===================================================================
          Column {
            id: overviewTab
            visible: root.activeTab === 0
            width: parent.width
            spacing: Style.space(12)

            // 1. Live In-Flight Waste Alert Banner (last 30m)
            BorderSurface {
              visible: root.liveAlerts.length > 0
              width: parent.width
              implicitHeight: alertCol.implicitHeight + Style.space(18)
              color: root.alpha(root.urgent, 0.08)
              borderSpec: Border.flat(root.alpha(root.urgent, 0.4), 1)
              radius: Style.cornerRadius

              Column {
                id: alertCol
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: Style.space(10)
                anchors.rightMargin: Style.space(10)
                spacing: Style.space(4)

                Text {
                  textFormat: Text.PlainText
                  width: parent.width
                  text: root.liveAlerts.length > 0
                    ? ("⚠ Live Waste Alert (" + root.liveAlerts[0].projectName + ") · ~" + Model.formatTokens(root.liveAlerts[0].wastedTokens) + "/wk")
                    : ""
                  color: root.urgent
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                  elide: Text.ElideRight
                }

                Text {
                  textFormat: Text.PlainText
                  width: parent.width
                  text: root.liveAlerts.length > 0
                    ? (root.liveAlerts[0].title + (root.liveAlerts[0].detail ? " — " + root.liveAlerts[0].detail : ""))
                    : ""
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  wrapMode: Text.WordWrap
                }
              }
            }

            // 2. Cross-Agent Switch Advisor Banner
            BorderSurface {
              visible: root.switchAdvice !== null
              width: parent.width
              implicitHeight: switchText.implicitHeight + Style.space(16)
              color: root.alpha(Color.accent, 0.08)
              borderSpec: Border.flat(root.alpha(Color.accent, 0.35), 1)
              radius: Style.cornerRadius

              Text {
                id: switchText
                textFormat: Text.PlainText
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: Style.space(10)
                anchors.rightMargin: Style.space(10)
                text: root.switchAdvice ? ("⇄ " + root.switchAdvice.message) : ""
                color: Color.accent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
                wrapMode: Text.WordWrap
              }
            }

            // 3. Quota Windows & Clock Pace
            Column {
              id: quotaSection
              visible: root.agentQuotas.length > 0
              width: parent.width
              spacing: Style.space(8)

              PanelSectionHeader {
                width: parent.width
                text: "QUOTA WINDOWS & CLOCK PACE"
                foreground: root.foreground
                fontFamily: root.fontFamily
              }

              Repeater {
                model: root.agentQuotas

                BorderSurface {
                  required property var modelData
                  width: quotaSection.width
                  implicitHeight: aqCol.implicitHeight + Style.space(18)
                  color: root.alpha(root.foreground, 0.03)
                  borderSpec: Border.flat(root.alpha(root.foreground, 0.12), 1)
                  radius: Style.cornerRadius

                  Column {
                    id: aqCol
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: Style.space(10)
                    anchors.rightMargin: Style.space(10)
                    spacing: Style.space(6)

                    Text {
                      textFormat: Text.PlainText
                      width: parent.width
                      text: modelData.displayName + (modelData.willExhaust5h ? " · ⚠ Exhausting before reset" : "")
                      color: modelData.willExhaust5h ? root.urgent : root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      font.bold: true
                      elide: Text.ElideRight
                    }

                    // 5h window
                    Column {
                      visible: modelData.usedPct5h >= 0
                      width: parent.width
                      spacing: Style.space(3)

                      Item {
                        width: parent.width
                        implicitHeight: Math.max(lbl5h.implicitHeight, meta5h.implicitHeight)

                        Text {
                          id: lbl5h
                          textFormat: Text.PlainText
                          text: "5h: " + modelData.usedPct5h + "%"
                          color: root.foreground
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.caption
                          anchors.left: parent.left
                          anchors.verticalCenter: parent.verticalCenter
                        }

                        Text {
                          id: meta5h
                          textFormat: Text.PlainText
                          text: (modelData.elapsedPct5h >= 0 ? ((modelData.paceDelta5h > 0 ? "+" : "") + modelData.paceDelta5h + "% vs clock · ") : "") + "resets " + modelData.reset5h
                          color: modelData.paceDelta5h > 15 ? root.warningColor : root.dim
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.caption
                          anchors.right: parent.right
                          anchors.verticalCenter: parent.verticalCenter
                        }
                      }

                      Rectangle {
                        id: meter5h
                        width: parent.width
                        height: Style.space(6)
                        radius: Style.space(3)
                        color: root.alpha(root.foreground, 0.14)

                        Rectangle {
                          width: parent.width * root.clamp(modelData.usedPct5h / 100, 0, 1)
                          height: parent.height
                          radius: parent.radius
                          color: modelData.usedPct5h >= 95 ? root.urgent : (modelData.usedPct5h >= 80 ? root.warningColor : Color.accent)
                        }

                        Rectangle {
                          visible: modelData.elapsedPct5h > 0 && modelData.elapsedPct5h < 100
                          x: root.clamp(meter5h.width * (modelData.elapsedPct5h / 100), 0, Math.max(0, meter5h.width - 2))
                          y: -1
                          width: 2
                          height: meter5h.height + 2
                          color: root.foreground
                          opacity: 0.85
                        }
                      }
                    }

                    // 7d window
                    Column {
                      visible: modelData.usedPct7d >= 0
                      width: parent.width
                      spacing: Style.space(3)

                      Item {
                        width: parent.width
                        implicitHeight: Math.max(lbl7d.implicitHeight, meta7d.implicitHeight)

                        Text {
                          id: lbl7d
                          textFormat: Text.PlainText
                          text: "7d: " + modelData.usedPct7d + "%"
                          color: root.foreground
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.caption
                          anchors.left: parent.left
                          anchors.verticalCenter: parent.verticalCenter
                        }

                        Text {
                          id: meta7d
                          textFormat: Text.PlainText
                          text: (modelData.elapsedPct7d >= 0 ? ((modelData.paceDelta7d > 0 ? "+" : "") + modelData.paceDelta7d + "% vs clock · ") : "") + "resets " + modelData.reset7d
                          color: modelData.paceDelta7d > 15 ? root.warningColor : root.dim
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.caption
                          anchors.right: parent.right
                          anchors.verticalCenter: parent.verticalCenter
                        }
                      }

                      Rectangle {
                        id: meter7d
                        width: parent.width
                        height: Style.space(6)
                        radius: Style.space(3)
                        color: root.alpha(root.foreground, 0.14)

                        Rectangle {
                          width: parent.width * root.clamp(modelData.usedPct7d / 100, 0, 1)
                          height: parent.height
                          radius: parent.radius
                          color: modelData.usedPct7d >= 95 ? root.urgent : (modelData.usedPct7d >= 80 ? root.warningColor : Color.accent)
                        }

                        Rectangle {
                          visible: modelData.elapsedPct7d > 0 && modelData.elapsedPct7d < 100
                          x: root.clamp(meter7d.width * (modelData.elapsedPct7d / 100), 0, Math.max(0, meter7d.width - 2))
                          y: -1
                          width: 2
                          height: meter7d.height + 2
                          color: root.foreground
                          opacity: 0.85
                        }
                      }
                    }
                  }
                }
              }
            }

            // 4. Today's Telemetry KPIs
            Column {
              width: parent.width
              spacing: Style.space(8)

              PanelSectionHeader {
                width: parent.width
                text: "TODAY'S TELEMETRY"
                foreground: root.foreground
                fontFamily: root.fontFamily
              }

              Row {
                id: statRow
                width: parent.width
                spacing: Style.space(8)
                readonly property real cardWidth: (width - spacing * 2) / 3

                StatCard {
                  width: statRow.cardWidth
                  label: "TOKENS"
                  value: Model.formatTokens(root.tokensToday)
                }

                StatCard {
                  width: statRow.cardWidth
                  label: "API COST"
                  value: Model.formatCost(root.costToday)
                }

                StatCard {
                  width: statRow.cardWidth
                  label: "BURN RATE"
                  value: Model.formatTokens(root.burnRatePerHour) + "/h"
                }
              }
            }

            // 5. Active Agents Today (Antigravity, Claude Code, Codex, OpenCode, etc.)
            Column {
              id: activeAgentsSection
              visible: root.byAgentToday.length > 0
              width: parent.width
              spacing: Style.space(6)

              PanelSectionHeader {
                width: parent.width
                text: "ACTIVE AGENTS TODAY"
                foreground: root.foreground
                fontFamily: root.fontFamily
              }

              Repeater {
                model: root.byAgentToday

                Column {
                  required property var modelData
                  width: activeAgentsSection.width
                  spacing: Style.space(2)

                  Item {
                    width: parent.width
                    implicitHeight: Math.max(agName.implicitHeight, agVal.implicitHeight)

                    Text {
                      id: agName
                      textFormat: Text.PlainText
                      text: modelData.displayName + " (" + modelData.sessions + " sess)"
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.bold: true
                      anchors.left: parent.left
                      anchors.verticalCenter: parent.verticalCenter
                    }

                    Text {
                      id: agVal
                      textFormat: Text.PlainText
                      text: Model.formatTokens(modelData.tokens) + " · " + Model.formatCost(modelData.cost)
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      anchors.right: parent.right
                      anchors.verticalCenter: parent.verticalCenter
                    }
                  }

                  Rectangle {
                    width: parent.width
                    height: Style.space(4)
                    radius: Style.space(2)
                    color: root.alpha(root.foreground, 0.12)

                    Rectangle {
                      width: parent.width * root.clamp(modelData.barRatio, 0.04, 1)
                      height: parent.height
                      radius: parent.radius
                      color: Color.accent
                    }
                  }
                }
              }
            }
          }

          // ===================================================================
          // TAB 1: FIX & OPTIMIZE
          // ===================================================================
          Column {
            id: fixTab
            visible: root.activeTab === 1
            width: parent.width
            spacing: Style.space(10)

            Item {
              width: parent.width
              implicitHeight: Math.max(recHdr.implicitHeight, Style.space(24))

              PanelSectionHeader {
                id: recHdr
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                text: root.recsList.length > 0
                  ? ("RECOMMENDATIONS (" + (root.recIndex + 1) + "/" + root.recsList.length + ")")
                  : "RECOMMENDATIONS"
                foreground: root.foreground
                fontFamily: root.fontFamily
              }

              Row {
                visible: root.recsList.length > 1
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(4)

                Button {
                  bordered: true
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  fontSize: Style.font.caption
                  text: "[ ◀"
                  onClicked: root.recIndex = (root.recIndex + root.recsList.length - 1) % root.recsList.length
                }

                Button {
                  bordered: true
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  fontSize: Style.font.caption
                  text: "▶ ]"
                  onClicked: root.recIndex = (root.recIndex + 1) % root.recsList.length
                }
              }
            }

            BorderSurface {
              visible: root.currentRec !== null
              width: parent.width
              implicitHeight: fixCol.implicitHeight + Style.space(20)
              color: root.alpha(Color.accent, 0.06)
              borderSpec: Border.flat(root.alpha(Color.accent, 0.28), 1)
              radius: Style.cornerRadius

              Column {
                id: fixCol
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: Style.space(12)
                anchors.rightMargin: Style.space(12)
                spacing: Style.space(6)

                Text {
                  textFormat: Text.PlainText
                  width: parent.width
                  text: root.currentRec ? ("[" + root.currentRec.projectName + "] " + root.currentRec.title) : ""
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  font.bold: true
                  elide: Text.ElideRight
                }

                Text {
                  textFormat: Text.PlainText
                  width: parent.width
                  text: root.currentRec ? root.currentRec.action : ""
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  wrapMode: Text.WordWrap
                }

                Text {
                  textFormat: Text.PlainText
                  visible: root.currentRec !== null && root.currentRec.estTokensSavedWeek > 0
                  width: parent.width
                  text: root.currentRec ? ("Est. savings: ~" + Model.formatTokens(root.currentRec.estTokensSavedWeek) + " tokens/wk") : ""
                  color: Color.accent
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                }

                Row {
                  id: recBtnRow
                  width: parent.width
                  spacing: Style.space(6)
                  readonly property real btnW: (width - spacing) / 2

                  Button {
                    width: recBtnRow.btnW
                    bordered: true
                    selected: root.copiedPrompt
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                    fontSize: Style.font.caption
                    text: root.copiedPrompt ? "✓ Copied Prompt" : "Copy Prompt (c)"
                    onClicked: root.triggerCopyCurrentPrompt()
                  }

                  Button {
                    width: recBtnRow.btnW
                    bordered: true
                    selected: root.currentRec !== null && root.acceptedRecId === root.currentRec.id
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                    fontSize: Style.font.caption
                    text: (root.currentRec && root.acceptedRecId === root.currentRec.id) ? "✓ Tracking 14d" : "Accept & Track (a)"
                    onClicked: root.triggerAcceptCurrentRec()
                  }
                }
              }
            }

            PanelSeparator {
              foreground: root.foreground
            }

            // 1-Click Workspace Hygiene (/api/optimize)
            PanelSectionHeader {
              width: parent.width
              text: "WORKSPACE HYGIENE (" + (root.primaryProject ? root.primaryProject.name : "NONE") + ")"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            BorderSurface {
              visible: root.primaryProject !== null
              width: parent.width
              implicitHeight: optCol.implicitHeight + Style.space(18)
              color: root.alpha(root.foreground, 0.04)
              borderSpec: Border.flat(root.alpha(root.foreground, 0.14), 1)
              radius: Style.cornerRadius

              Column {
                id: optCol
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: Style.space(10)
                anchors.rightMargin: Style.space(10)
                spacing: Style.space(6)

                Text {
                  textFormat: Text.PlainText
                  width: parent.width
                  text: root.optimizeStatusText !== ""
                    ? root.optimizeStatusText
                    : "Preview or apply .claudeignore/.agentignore rules and trim duplicate instruction lines."
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  wrapMode: Text.WordWrap
                }

                Row {
                  id: optBtnRow
                  width: parent.width
                  spacing: Style.space(6)
                  readonly property real optW: (width - spacing) / 2

                  Button {
                    width: optBtnRow.optW
                    bordered: true
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                    fontSize: Style.font.caption
                    text: "Preview Hygiene"
                    onClicked: if (!root.optimizeBusy) root.triggerPreviewOptimize()
                  }

                  Button {
                    width: optBtnRow.optW
                    bordered: true
                    selected: true
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                    fontSize: Style.font.caption
                    text: "Apply Fixes"
                    onClicked: if (!root.optimizeBusy) root.triggerApplyOptimize()
                  }
                }
              }
            }
          }

          // ===================================================================
          // TAB 2: TRENDS & BUDGETS
          // ===================================================================
          Column {
            id: trendsTab
            visible: root.activeTab === 2
            width: parent.width
            spacing: Style.space(10)

            // 1. 7-Day Daily Bars
            PanelSectionHeader {
              width: parent.width
              text: "TOKENS BY DAY (LAST 7 DAYS)"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: root.daily7d

              Item {
                required property var modelData
                width: trendsTab.width
                implicitHeight: Style.space(18)

                Text {
                  id: dayLbl
                  textFormat: Text.PlainText
                  width: Style.space(48)
                  text: modelData.isToday ? (modelData.shortDay + " ★") : modelData.shortDay
                  color: modelData.isToday ? Color.accent : root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: modelData.isToday
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                }

                Rectangle {
                  anchors.left: dayLbl.right
                  anchors.right: dayVal.left
                  anchors.leftMargin: Style.space(6)
                  anchors.rightMargin: Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  height: Style.space(6)
                  radius: Style.space(3)
                  color: root.alpha(root.foreground, 0.12)

                  Rectangle {
                    width: parent.width * root.clamp(modelData.barRatio, modelData.tokens > 0 ? 0.03 : 0, 1)
                    height: parent.height
                    radius: parent.radius
                    color: modelData.isToday ? Color.accent : root.alpha(Color.accent, 0.7)
                  }
                }

                Text {
                  id: dayVal
                  textFormat: Text.PlainText
                  text: Model.formatTokens(modelData.tokens) + " · " + Model.formatCost(modelData.cost)
                  color: modelData.isToday ? root.foreground : root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: modelData.isToday
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                }
              }
            }

            PanelSeparator {
              foreground: root.foreground
            }

            // 2. Top Models (7d)
            PanelSectionHeader {
              width: parent.width
              text: "TOP MODELS (7D)"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: root.topModels

              Column {
                required property var modelData
                width: trendsTab.width
                spacing: Style.space(2)

                Item {
                  width: parent.width
                  implicitHeight: Math.max(mName.implicitHeight, mVal.implicitHeight)

                  Text {
                    id: mName
                    textFormat: Text.PlainText
                    text: modelData.model
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                    elide: Text.ElideRight
                    anchors.left: parent.left
                    anchors.right: mVal.left
                    anchors.rightMargin: Style.space(6)
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  Text {
                    id: mVal
                    textFormat: Text.PlainText
                    text: Model.formatTokens(modelData.tokens) + " (" + Model.formatCost(modelData.cost) + ")"
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                  }
                }

                Text {
                  textFormat: Text.PlainText
                  width: parent.width
                  text: "in " + Model.formatTokens(modelData.inputTokens) + " · out " + Model.formatTokens(modelData.outputTokens) + " · cache " + Model.formatTokens(modelData.cacheTokens)
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }
            }

            PanelSeparator {
              foreground: root.foreground
            }

            // 3. Projects & Weekly Budgets
            PanelSectionHeader {
              width: parent.width
              text: "PROJECTS & WEEKLY BUDGETS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: root.projectList

              Column {
                required property var modelData
                width: trendsTab.width
                spacing: Style.space(3)

                Item {
                  width: parent.width
                  implicitHeight: Math.max(pName.implicitHeight, pVal.implicitHeight)

                  Text {
                    id: pName
                    textFormat: Text.PlainText
                    text: modelData.name
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                    elide: Text.ElideRight
                    anchors.left: parent.left
                    anchors.right: pVal.left
                    anchors.rightMargin: Style.space(6)
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  Text {
                    id: pVal
                    textFormat: Text.PlainText
                    text: modelData.budgetUsedPct != null
                      ? ("7d budget: " + modelData.budgetUsedPct + "%")
                      : ("Today: " + Model.formatTokens(modelData.tokensToday) + " · 7d: " + Model.formatTokens(modelData.weeklyTokensUsed))
                    color: (modelData.budgetUsedPct != null && modelData.budgetUsedPct >= 100) ? root.urgent : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                  }
                }

                Rectangle {
                  visible: modelData.budgetUsedPct != null
                  width: parent.width
                  height: Style.space(5)
                  radius: Style.space(2)
                  color: root.alpha(root.foreground, 0.14)

                  Rectangle {
                    width: parent.width * root.clamp((modelData.budgetUsedPct || 0) / 100, 0, 1)
                    height: parent.height
                    radius: parent.radius
                    color: (modelData.budgetUsedPct || 0) >= 100 ? root.urgent : ((modelData.budgetUsedPct || 0) >= 80 ? root.warningColor : Color.accent)
                  }
                }
              }
            }
          }

          // ---------- Quick Actions Footer ----------
          PanelSeparator {
            foreground: root.foreground
          }

          Row {
            id: actionRow
            width: parent.width
            spacing: Style.space(8)
            readonly property real primaryWidth: width - refreshButton.width - spacing

            Button {
              width: actionRow.primaryWidth
              bordered: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.bodySmall
              text: "Open Dashboard (o)"
              onClicked: {
                if (root.hostWidget) root.hostWidget.openDashboard()
                root.close()
              }
            }

            Button {
              id: refreshButton
              width: Style.space(104)
              bordered: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.bodySmall
              text: "Refresh (r)"
              onClicked: {
                if (root.hostWidget) root.hostWidget.refresh()
              }
            }
          }
        }
      }
    }
  }

  component StatCard: BorderSurface {
    id: card
    property string label: ""
    property string value: ""

    implicitHeight: cardCol.implicitHeight + Style.space(16)
    color: root.alpha(root.foreground, 0.04)
    borderSpec: Border.flat(root.alpha(root.foreground, 0.12), 1)
    radius: Style.cornerRadius

    Column {
      id: cardCol
      anchors.centerIn: parent
      width: parent.width - Style.space(12)
      spacing: Style.space(2)

      Text {
        textFormat: Text.PlainText
        width: parent.width
        horizontalAlignment: Text.AlignHCenter
        text: card.label
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.bold: true
      }

      Text {
        textFormat: Text.PlainText
        width: parent.width
        horizontalAlignment: Text.AlignHCenter
        text: card.value
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.bold: true
        elide: Text.ElideRight
      }
    }
  }
}
