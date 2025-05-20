// src/features/finishHim/finishHimView.ts
import { h } from 'snabbdom';
import type { VNode, Hooks } from 'snabbdom';
import type { Key } from 'chessground/types';
import type { FinishHimController } from './finishHimController';
import { FINISH_HIM_PUZZLE_TYPES } from './finishHim.types';
import { BoardView } from '../../shared/components/boardView';
import logger from '../../utils/logger';
import { renderPromotionDialog } from '../common/promotion/promotionView';
import { renderAnalysisPanel } from '../analysis/analysisPanelView';
import { t } from '../../core/i18n.service';
import type { FinishHimStats } from '../../core/auth.service';

let boardViewInstance: BoardView | null = null;

export interface FinishHimPageViewLayout {
  left: VNode | null;
  center: VNode;
  right: VNode | null;
}

function formatTime(ms: number | null): string {
  if (ms === null || ms < 0) return "--:--";
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function renderCategoryButtons(controller: FinishHimController): VNode {
  return h('div.finish-him-categories', [
    h('h3', t('finishHim.categories.title')),
    h('div.button-group.vertical',
      FINISH_HIM_PUZZLE_TYPES.map(type =>
        h('button.button.category-button', {
          key: type,
          class: { active: controller.state.activePuzzleType === type },
          on: {
            click: () => {
              logger.debug(`[FinishHimView] Category selected: ${type}`);
              controller.setActivePuzzleType(type);
            }
          },
          attrs: {
            disabled: (controller.analysisController.getPanelState().isAnalysisActive && controller.analysisController.getPanelState().isAnalysisLoading) ||
                      controller.state.isStockfishThinking ||
                      controller.boardHandler.promotionCtrl.isActive()
          }
        }, t(`finishHim.puzzleTypes.${type}`))
      )
    )
  ]);
}

function renderUserStats(stats: FinishHimStats | null): VNode | null {
  if (!stats) {
    return h('div.user-stats-container', [
        h('h4', t('stats.title')),
        h('p', t('stats.loading'))
    ]);
  }

  const tacticalWDL = `${stats.tacticalWins}W / ${stats.tacticalLosses}L`;
  const playoutWDL = `${stats.playoutWins}W / ${stats.playoutDraws}D / ${stats.playoutLosses}L`;

  return h('div.user-stats-container', [
    h('h4', t('stats.title')),
    h('div.stats-grid', [
      h('div.stat-item', [
        h('span.stat-label', `${t('stats.gamesPlayed')}:`),
        h('span.stat-value', String(stats.gamesPlayed))
      ]),
      h('div.stat-item', [
        h('span.stat-label', `${t('stats.currentPieceCount')}:`),
        h('span.stat-value', String(stats.currentPieceCount))
      ]),
      h('div.stat-item.full-width-stat', [
        h('h5.stat-section-title', t('stats.tacticalSectionTitle'))
      ]),
      h('div.stat-item', [
        h('span.stat-label', `${t('stats.tacticalRating')}:`),
        h('span.stat-value', String(stats.tacticalRating))
      ]),
      h('div.stat-item', [
        h('span.stat-label', `${t('stats.tacticalWDL')}:`),
        h('span.stat-value', tacticalWDL)
      ]),
      h('div.stat-item.full-width-stat', [
        h('h5.stat-section-title', t('stats.finishHimSectionTitle'))
      ]),
      h('div.stat-item', [
        h('span.stat-label', `${t('stats.finishHimRating')}:`),
        h('span.stat-value', String(stats.finishHimRating))
      ]),
      h('div.stat-item', [
        h('span.stat-label', `${t('stats.playoutWDL')}:`),
        h('span.stat-value', playoutWDL)
      ]),
    ])
  ]);
}

// Updated renderPlayoutTimer to only show the time value
function renderPlayoutTimerValue(controller: FinishHimController): VNode | null {
    if (controller.state.isInPlayoutMode && controller.state.outplayTimeRemainingMs !== null && controller.state.isGameEffectivelyActive) {
        // Removed the container and label, just returning the timer value span
        return h('span.timer-value-overlay', formatTime(controller.state.outplayTimeRemainingMs));
    }
    return null;
}


export function renderFinishHimUI(controller: FinishHimController): FinishHimPageViewLayout {
  const fhState = controller.state;
  const boardHandler = controller.boardHandler;

  let promotionDialogVNode: VNode | null = null;
  if (controller.chessboardService.ground) {
    const groundState = controller.chessboardService.ground.state;
    const boardOrientation = groundState.orientation;
    const boardDomBounds = groundState.dom?.bounds();
    if (boardDomBounds) {
      promotionDialogVNode = renderPromotionDialog(boardHandler.promotionCtrl, boardOrientation, boardDomBounds);
    } else if (boardHandler.promotionCtrl.isActive()) {
      logger.warn('[FinishHimView] Promotion active, but board DOM bounds not available.');
    }
  }

  const boardWrapperHook: Hooks = {
    insert: (vnode: VNode) => {
        const wrapperEl = vnode.elm as HTMLElement;
        const boardContainerEl = wrapperEl.querySelector('#board-container') as HTMLElement | null;
        if (boardContainerEl) {
            if (!boardViewInstance || boardViewInstance.container !== boardContainerEl) {
                if (boardViewInstance) boardViewInstance.destroy();
                boardViewInstance = new BoardView(boardContainerEl, boardHandler, controller.chessboardService,
                    (orig: Key, dest: Key) => controller.handleUserMove(orig, dest)
                );
            } else {
                boardViewInstance.updateView();
            }
        } else {
            logger.error('[FinishHimView] #board-container not found within #board-wrapper!');
        }
    },
    update: (_oldVnode: VNode, vnode: VNode) => {
        const newBoardContainerEl = (vnode.elm as Element)?.querySelector('#board-container') as HTMLElement | null;
        if (boardViewInstance && newBoardContainerEl) {
            if (boardViewInstance.container !== newBoardContainerEl) {
                 boardViewInstance.destroy();
                 boardViewInstance = new BoardView(newBoardContainerEl, boardHandler, controller.chessboardService,
                    (orig: Key, dest: Key) => controller.handleUserMove(orig, dest));
            } else {
                boardViewInstance.updateView();
            }
        } else if (newBoardContainerEl && !boardViewInstance) {
            boardViewInstance = new BoardView(newBoardContainerEl, boardHandler, controller.chessboardService,
                (orig: Key, dest: Key) => controller.handleUserMove(orig, dest));
        } else if (!newBoardContainerEl && boardViewInstance) {
            boardViewInstance.destroy();
            boardViewInstance = null;
        }
    },
    destroy: () => {
        if (boardViewInstance) {
            boardViewInstance.destroy();
            boardViewInstance = null;
        }
    }
  };

  const centerContent = h('div#board-wrapper', {
    key: 'fh-board-wrapper',
    style: { position: 'relative', width: '100%', height: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center'},
    hook: boardWrapperHook
  }, [
    h('div#board-container.cg-wrap', {
      key: 'fh-board-container',
      style: { width: '100%' }}
    ),
    promotionDialogVNode
  ]);

  const leftPanelContent = h('div.finish-him-left-panel', [
    h('div#finish-him-feedback', {
      style: { order: '1' } // Feedback first
    }, [
      h('p', {
        style: {
          fontWeight: 'bold',
          color: fhState.gameOverMessage ? 'var(--color-accent-error)' : 'var(--color-text-default)'
        }
      },
        fhState.gameOverMessage || fhState.feedbackMessage
      ),
    ]),
    // Timer is removed from left panel
    renderCategoryButtons(controller), // Categories will have order '2' (after feedback)
    renderUserStats(fhState.userStats) // Stats will have order '3'
  ]);

  // Right panel now includes the timer overlay
  const timerOverlayVNode = renderPlayoutTimerValue(controller);

  const rightPanelContent = h('div.finish-him-right-panel', { // This container needs position: relative for the overlay
    style: { display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }
  }, [
    renderAnalysisPanel(controller.analysisController), // Analysis panel itself
    timerOverlayVNode // Timer will be positioned absolutely within this relative container
  ]);

  return {
    left: leftPanelContent,
    center: centerContent,
    right: rightPanelContent
  };
}
