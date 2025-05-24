// src/features/analysis/analysisPanelView.ts
import { h } from 'snabbdom';
import type { VNode } from 'snabbdom';
import type { AnalysisController, AnalysisPanelState } from './analysisController';
import type { EvaluatedLineWithSan, ScoreInfo } from '../../core/analysis.service'; 
import { t } from '../../core/i18n.service';
import logger from '../../utils/logger';
// import type { Color as ChessopsColor } from 'chessops/types'; // Удалено, так как не используется

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
    const scoreToDisplay: ScoreInfo = line.score;

    const scoreValueDisplay = scoreToDisplay.type === 'cp'
      ? (scoreToDisplay.value / 100).toFixed(2)
      : `${t('analysis.mateInShort', { value: Math.abs(scoreToDisplay.value) })}${scoreToDisplay.value < 0 ? '-' : ''}`;

    let pvString = "";
    let currentMoveNumber = line.initialFullMoveNumber;
    let turnForPv = line.initialTurn;

    line.pvSan.forEach((san, sanIndex) => {
      if (turnForPv === 'white') {
        pvString += `${currentMoveNumber}. ${san} `;
      } else {
        if (sanIndex === 0 && line.pvSan.length > 0) { 
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
      key: `analysis-line-${line.id}-${index}` 
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
          disabled: !firstMoveUci 
        }
      }, scoreValueDisplay),
      h('span.analysis-pv-text', {
        attrs: { title: pvString.trim() } 
      }, pvString.trim())
    ]);
  });
}

// Updated PGN controls
function renderPgnControls(controller: AnalysisController, panelState: AnalysisPanelState): VNode {
  const pgnNavDisabled = !panelState.isAnalysisActive || panelState.isGameCurrentlyActive;
  const pgnNavStyledActive = panelState.isAnalysisActive && !panelState.isGameCurrentlyActive;

  return h('div#pgn-navigation-controls.button-group.horizontal', [
    h('button.button.pgn-nav-button', {
      class: { 'active-analysis-mode': pgnNavStyledActive },
      attrs: {
        disabled: pgnNavDisabled || !panelState.canNavigatePgnBackward,
        title: t('pgn.nav.start')
      },
      on: { click: () => controller.pgnNavigateToStart() }
    }, '|◀'),
    h('button.button.pgn-nav-button', {
      class: { 'active-analysis-mode': pgnNavStyledActive },
      attrs: {
        disabled: pgnNavDisabled || !panelState.canNavigatePgnBackward,
        title: t('pgn.nav.prev')
      },
      on: { click: () => controller.pgnNavigateBackward() }
    }, '◀'),
    h('button.button.pgn-nav-button', {
      class: { 'active-analysis-mode': pgnNavStyledActive },
      attrs: {
        disabled: pgnNavDisabled || !panelState.canNavigatePgnForward,
        title: t('pgn.nav.next')
      },
      on: { click: () => controller.pgnNavigateForward(0) }
    }, '▶'),
    h('button.button.pgn-nav-button', {
      class: { 'active-analysis-mode': pgnNavStyledActive },
      attrs: {
        disabled: pgnNavDisabled || !panelState.canNavigatePgnForward,
        title: t('pgn.nav.end')
      },
      on: { click: () => controller.pgnNavigateToEnd() }
    }, '▶|'),
  ]);
}

// Main controls: Disable game control buttons if a game is active.
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

  const gameControlButtonDisabled = panelState.isGameCurrentlyActive;

  return h('div#main-controls.button-group.vertical', [
    h('button.button.game-control-button.primary-button', {
      attrs: { 
        disabled: gameControlButtonDisabled || !panelState.canLoadNextTask 
      },
      on: { click: () => controller.requestNextTask() }
    }, t('puzzle.button.next')),
    h('button.button.game-control-button.restart-button', { 
      attrs: { 
        disabled: gameControlButtonDisabled || !panelState.canRestartTask 
      },
      on: { click: () => controller.requestRestartTask() }
    }, t('puzzle.button.restartTask')),
    h('button.button', { 
      class: {
          'analysis-toggle-button': true,
          'active-analysis': !panelState.isGameCurrentlyActive && panelState.isAnalysisActive,
          'resign-button': panelState.isGameCurrentlyActive,
      },
      on: { click: () => controller.toggleAnalysisEngine() } 
    }, analysisResignButtonText),
    // REMOVED Set FEN button
    // h('button.button.game-control-button.set-fen-button', { 
    //   attrs: { 
    //     disabled: gameControlButtonDisabled || !panelState.canSetFen // canSetFen would be removed
    //   },
    //   on: { click: () => controller.requestSetFen() }
    // }, t('puzzle.button.setFen')),
  ]);
}

export function renderAnalysisPanel(controller: AnalysisController): VNode {
  const panelState = controller.getPanelState(); 
  logger.debug('[AnalysisPanelView] Rendering with state:', panelState);

  const analysisLinesSection = (panelState.isAnalysisActive || panelState.isAnalysisLoading)
    ? h('div.analysis-lines-section',
        renderAnalysisLinesContent(
          panelState, 
          (uciMove: string) => controller.playMoveFromAnalysisLine(uciMove)
        )
      )
    : null;

  return h('div#analysis-panel-container', [
    renderPgnControls(controller, panelState),
    analysisLinesSection,
    renderMainControls(controller, panelState),
  ].filter(Boolean) as VNode[]);
}
