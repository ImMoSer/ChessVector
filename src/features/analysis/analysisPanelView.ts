// src/features/analysis/analysisPanelView.ts
import { h } from 'snabbdom';
import type { VNode } from 'snabbdom';
import type { AnalysisController, AnalysisPanelState } from './analysisController';
import type { EvaluatedLineWithSan } from '../../core/analysis.service';
import { t } from '../../core/i18n.service';
import logger from '../../utils/logger';

// --- Логика рендеринга линий анализа ---
function renderAnalysisLinesContent(
  panelState: AnalysisPanelState,
  onPlayMoveFromLine: (uciMove: string) => void
): VNode[] {
  if (!panelState.isAnalysisActive) {
    return [h('div.inactive-message', t('analysis.inactive'))];
  }
  if (panelState.isAnalysisLoading) {
    return [h('div.loading-message', t('analysis.loading'))];
  }
  if (!panelState.analysisLines || panelState.analysisLines.length === 0) {
    return [h('div.no-data-message', t('analysis.noData'))];
  }

  return panelState.analysisLines.map((line: EvaluatedLineWithSan, index: number) => {
    const scoreValueDisplay = line.score.type === 'cp'
      ? (line.score.value / 100).toFixed(2)
      : `${t('analysis.mateInShort', { value: Math.abs(line.score.value) })}${line.score.value < 0 ? '-' : ''}`;

    let pvString = "";
    let currentMoveNumber = line.initialFullMoveNumber;
    let turnForPv = line.initialTurn;

    line.pvSan.forEach((san, sanIndex) => {
      if (turnForPv === 'white') {
        pvString += `${currentMoveNumber}. ${san} `;
      } else {
        if (sanIndex === 0 && line.pvSan.length > 0) { // Ensure ... is only for first black move if it's the start of PV
             pvString += `${currentMoveNumber}...${san} `;
        } else {
             pvString += `${san} `;
        }
      }
      if (turnForPv === 'black') {
        currentMoveNumber++;
      }
      turnForPv = turnForPv === 'white' ? 'black' : 'white';
    });

    const firstMoveUci = line.pvUci.length > 0 ? line.pvUci[0] : null;

    let scoreButtonClass = 'analysis-score-button';
    if (index === 0) {
      scoreButtonClass += '.best-line-score';
    } else if (index === 1) {
      scoreButtonClass += '.second-line-score';
    } else if (index === 2) {
      scoreButtonClass += '.third-line-score';
    } else {
      scoreButtonClass += '.other-line-score';
    }

    return h('div.analysis-line-entry', {
      key: `analysis-line-${line.id}-${index}` // Unique key for Snabbdom
    }, [
      h(`button.${scoreButtonClass}`, {
        on: {
          click: () => {
            if (firstMoveUci) {
              logger.debug(`[analysisPanelView] Clicked score button for line ${index + 1}, first move UCI: ${firstMoveUci}`);
              onPlayMoveFromLine(firstMoveUci);
            } else {
              logger.warn(`[analysisPanelView] Clicked score button for line ${index + 1}, but no UCI move available.`);
            }
          }
        },
        attrs: {
          title: firstMoveUci ? t('analysis.playFirstMove') : t('analysis.noMoveToPlay'),
          disabled: !firstMoveUci // Disable if no move
        }
      }, scoreValueDisplay),
      h('span.analysis-pv-text', {
        attrs: { title: pvString.trim() } // Tooltip with full PV
      }, pvString.trim())
    ]);
  });
}

// Updated PGN controls to call methods on AnalysisController
function renderPgnControls(controller: AnalysisController, panelState: AnalysisPanelState): VNode {
  // PGN buttons are disabled if analysis is not active OR if the specific navigation is not possible.
  const pgnNavDisabledBase = !panelState.isAnalysisActive;

  return h('div#pgn-navigation-controls.button-group.horizontal', [
    h('button.button.pgn-nav-button', {
      attrs: {
        disabled: pgnNavDisabledBase || !panelState.canNavigatePgnBackward,
        title: t('pgn.nav.start')
      },
      on: { click: () => controller.pgnNavigateToStart() } // Calls AnalysisController method
    }, '|◀'),
    h('button.button.pgn-nav-button', {
      attrs: {
        disabled: pgnNavDisabledBase || !panelState.canNavigatePgnBackward,
        title: t('pgn.nav.prev')
      },
      on: { click: () => controller.pgnNavigateBackward() } // Calls AnalysisController method
    }, '◀'),
    h('button.button.pgn-nav-button', {
      attrs: {
        disabled: pgnNavDisabledBase || !panelState.canNavigatePgnForward,
        title: t('pgn.nav.next')
      },
      on: { click: () => controller.pgnNavigateForward(0) } // Calls AnalysisController method
    }, '▶'),
    h('button.button.pgn-nav-button', {
      attrs: {
        disabled: pgnNavDisabledBase || !panelState.canNavigatePgnForward, // Technically, end might be same as current
        title: t('pgn.nav.end')
      },
      on: { click: () => controller.pgnNavigateToEnd() } // Calls AnalysisController method
    }, '▶|'),
  ]);
}

// Main controls remain largely the same, calling methods on AnalysisController
// which then calls GameControlCallbacks if needed.
function renderMainControls(controller: AnalysisController, panelState: AnalysisPanelState): VNode {
  let analysisResignButtonText: string;

  if (panelState.isGameCurrentlyActive) {
    analysisResignButtonText = t('puzzle.button.resign');
  } else {
    if (panelState.isAnalysisActive) {
      analysisResignButtonText = t('puzzle.button.finishAnalysis');
    } else {
      analysisResignButtonText = t('puzzle.button.analysis');
    }
  }

  return h('div#main-controls.button-group.vertical', [
    h('button.button.game-control-button.primary-button', {
      attrs: { 
        disabled: !panelState.canLoadNextTask || panelState.isGameCurrentlyActive 
      },
      on: { click: () => controller.requestNextTask() } // Calls AnalysisController method
    }, t('puzzle.button.next')),
    h('button.button.game-control-button', {
      attrs: { 
        disabled: !panelState.canRestartTask || panelState.isGameCurrentlyActive 
      },
      on: { click: () => controller.requestRestartTask() } // Calls AnalysisController method
    }, t('puzzle.button.restartTask')),
    h('button.button', {
      class: {
          'analysis-toggle-button': true,
          'active-analysis': !panelState.isGameCurrentlyActive && panelState.isAnalysisActive,
          'resign-button': panelState.isGameCurrentlyActive,
      },
      on: { click: () => controller.toggleAnalysisEngine() } // Calls AnalysisController method
    }, analysisResignButtonText),
    h('button.button.game-control-button', {
      attrs: { 
        disabled: !panelState.canSetFen || panelState.isGameCurrentlyActive 
      },
      on: { click: () => controller.requestSetFen() } // Calls AnalysisController method
    }, t('puzzle.button.setFen')),
  ]);
}

export function renderAnalysisPanel(controller: AnalysisController): VNode {
  // Get the most current state from the controller
  const panelState = controller.getPanelState();
  logger.debug('[AnalysisPanelView] Rendering with state:', panelState);

  const analysisLinesSection = (panelState.isAnalysisActive || panelState.isAnalysisLoading)
    ? h('div.analysis-lines-section',
        renderAnalysisLinesContent(
          panelState,
          // This callback is for playing a move *from* an analysis line,
          // which is still handled by AnalysisController.
          (uciMove: string) => controller.playMoveFromAnalysisLine(uciMove)
        )
      )
    : null;

  return h('div#analysis-panel-container', [
    renderPgnControls(controller, panelState), // Pass controller and its state
    analysisLinesSection,
    renderMainControls(controller, panelState), // Pass controller and its state
  ].filter(Boolean) as VNode[]); // Filter out null for cleaner VDOM
}
