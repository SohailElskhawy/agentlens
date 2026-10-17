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
  readonly property var agentWindows: hostWidget ? hostWidget.agentWindows : []
  readonly property var topProjects: hostWidget ? hostWidget.topProjects : []
  readonly property var topRecommendation: hostWidget ? hostWidget.topRecommendation : null
  readonly property int tokensToday: hostWidget ? hostWidget.tokensToday : 0
  readonly property double costToday: hostWidget ? hostWidget.costToday : 0
  readonly property int burnRatePerHour: hostWidget ? hostWidget.burnRatePerHour : 0
  readonly property string statuslineForecast: hostWidget ? hostWidget.statuslineForecast : ""

  property bool copiedPrompt: false

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
  function alpha(c, a) { return Qt.rgba(c.r, c.g, c.b, a) }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.hostWidget || root, direction)
    return false
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
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(640))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if ((t === "r" || t === "R") && root.hostWidget) root.hostWidget.refresh()
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

          // ---------- Offline Empty State ----------
          BorderSurface {
            visible: !root.hasData
            width: parent.width
            implicitHeight: offlineText.implicitHeight + Style.space(20)
            color: root.alpha(root.foreground, 0.04)
            borderSpec: Border.flat(root.alpha(root.foreground, 0.12), 1)
            radius: Style.cornerRadius

            Text {
              id: offlineText
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(12)
              anchors.rightMargin: Style.space(12)
              text: "No summary.json found yet.\nRun 'agentlens serve' or 'agentlens ingest' to populate live telemetry."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }

          // ---------- Multi-Agent Quota Limits & Pace ----------
          PanelSeparator {
            visible: limitsSection.visible
            foreground: root.foreground
          }

          Column {
            id: limitsSection
            visible: root.agentWindows.length > 0
            width: parent.width
            spacing: Style.space(10)

            PanelSectionHeader {
              width: parent.width
              text: "LIMITS & PACE"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: root.agentWindows

              Column {
                required property var modelData
                width: limitsSection.width
                spacing: Style.space(6)

                readonly property color rowColor:
                  modelData.alarming ? root.urgent :
                  modelData.warning ? root.warningColor :
                  root.foreground

                Item {
                  width: parent.width
                  implicitHeight: Math.max(winTitleText.implicitHeight, winPctText.implicitHeight)

                  Text {
                    id: winTitleText
                    textFormat: Text.PlainText
                    text: modelData.title
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                    anchors.left: parent.left
                    anchors.right: winPctText.left
                    anchors.rightMargin: Style.space(8)
                    anchors.verticalCenter: parent.verticalCenter
                  }

                  Text {
                    id: winPctText
                    textFormat: Text.PlainText
                    text: modelData.usedPct + "%"
                    color: parent.parent.rowColor
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                  }
                }

                // Progress Meter
                Item {
                  width: parent.width
                  implicitHeight: Math.max(Style.space(5), Math.round(Style.spacing.controlHeight * 0.14))

                  Rectangle {
                    id: meterTrack
                    anchors.fill: parent
                    radius: height / 2
                    color: root.track
                  }

                  Rectangle {
                    anchors.left: meterTrack.left
                    anchors.verticalCenter: meterTrack.verticalCenter
                    height: meterTrack.height
                    radius: meterTrack.radius
                    width: meterTrack.width * root.clamp(modelData.ratio, 0, 1)
                    color: parent.parent.rowColor

                    Behavior on width {
                      NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
                    }
                  }
                }

                Text {
                  textFormat: Text.PlainText
                  visible: text !== ""
                  width: parent.width
                  text: {
                    var parts = []
                    if (modelData.resetText && modelData.resetText !== "")
                      parts.push("Resets in " + modelData.resetText)
                    if (modelData.message && modelData.message !== "")
                      parts.push(modelData.message)
                    return parts.join(" · ")
                  }
                  color: modelData.alarming ? root.urgent : (modelData.warning ? root.warningColor : root.dim)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
              }
            }
          }

          // ---------- Today's Telemetry ----------
          PanelSeparator {
            visible: telemetrySection.visible
            foreground: root.foreground
          }

          Column {
            id: telemetrySection
            visible: root.hasData
            width: parent.width
            spacing: Style.space(10)

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

            Repeater {
              model: root.topProjects

              Item {
                required property var modelData
                width: telemetrySection.width
                implicitHeight: Math.max(projName.implicitHeight, projTokens.implicitHeight) + Style.space(2)

                Text {
                  id: projName
                  textFormat: Text.PlainText
                  text: modelData.name
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                  anchors.left: parent.left
                  anchors.right: projTokens.left
                  anchors.rightMargin: Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                }

                Text {
                  id: projTokens
                  textFormat: Text.PlainText
                  text: modelData.tokensFormatted + " · " + modelData.costFormatted
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                }
              }
            }
          }

          // ---------- #1 Priority Fix Now Recommendation ----------
          PanelSeparator {
            visible: fixSection.visible
            foreground: root.foreground
          }

          Column {
            id: fixSection
            visible: !!root.topRecommendation
            width: parent.width
            spacing: Style.space(8)

            PanelSectionHeader {
              width: parent.width
              text: "PRIORITY FIX NOW"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            BorderSurface {
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
                  text: root.topRecommendation ? (root.topRecommendation.projectName + " · " + root.topRecommendation.title) : ""
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  font.bold: true
                  elide: Text.ElideRight
                }

                Text {
                  textFormat: Text.PlainText
                  width: parent.width
                  text: root.topRecommendation ? root.topRecommendation.action : ""
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  wrapMode: Text.WordWrap
                }

                Text {
                  textFormat: Text.PlainText
                  visible: root.topRecommendation && root.topRecommendation.estTokensSavedWeek > 0
                  width: parent.width
                  text: root.topRecommendation ? ("Est. savings: ~" + root.topRecommendation.estSavingsFormatted) : ""
                  color: Color.accent
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                }

                Button {
                  width: parent.width
                  bordered: true
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  fontSize: Style.font.caption
                  text: root.copiedPrompt ? "✓ Copied Fix Prompt to Clipboard" : "Copy Fix Prompt"
                  onClicked: {
                    if (root.hostWidget && root.topRecommendation) {
                      root.hostWidget.copyTextToClipboard(root.topRecommendation.prompt)
                      root.copiedPrompt = true
                      copiedResetTimer.restart()
                    }
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
              text: "Open Dashboard"
              onClicked: {
                if (root.hostWidget) root.hostWidget.openDashboard()
                root.close()
              }
            }

            Button {
              id: refreshButton
              width: Style.space(92)
              bordered: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.bodySmall
              text: "Refresh"
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
