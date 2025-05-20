// src/features/finishHim/finishHimView.ts
import { h } from 'snabbdom';
import type { VNode, Hooks } from 'snabbdom';
import type { Key } from 'chessground/types';
import type { FinishHimController } from './finishHimController';
import { FINISH_HIM_PUZZLE_TYPES } from './finishHim.types';
// Отдельный импорт типа FinishHimPuzzleType удален, так как он не используется напрямую в этом файле
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

// Обновленная функция для рендеринга выпадающего меню категорий
function renderCategoryDropdown(controller: FinishHimController): VNode {
  const fhState = controller.state;
  const activeCategoryName = t(`finishHim.puzzleTypes.${fhState.activePuzzleType}`);
  const commonButtonDisabled = (controller.analysisController.getPanelState().isAnalysisActive && controller.analysisController.getPanelState().isAnalysisLoading) ||
                               fhState.isStockfishThinking ||
                               controller.boardHandler.promotionCtrl.isActive();

  return h('div.finish-him-categories-dropdown-container', [
    h('button.button.category-toggle-button', {
      on: { click: () => controller.toggleCategoriesDropdown() },
      attrs: {
        disabled: commonButtonDisabled
      }
    }, [
      activeCategoryName,
      h('span.dropdown-arrow', fhState.isCategoriesDropdownOpen ? '▲' : '▼')
    ]),
    fhState.isCategoriesDropdownOpen
      ? h('div.categories-dropdown-list', FINISH_HIM_PUZZLE_TYPES.map(type =>
          h('button.button.category-dropdown-item', {
            key: type,
            class: { active: fhState.activePuzzleType === type },
            on: {
              click: () => {
                logger.debug(`[FinishHimView] Category selected from dropdown: ${type}`);
                controller.setActivePuzzleType(type); // setActivePuzzleType теперь также закрывает дропдаун
              }
            },
            attrs: {
              disabled: commonButtonDisabled // Кнопки в дропдауне также должны быть недоступны
            }
          }, t(`finishHim.puzzleTypes.${type}`))
        ))
      : null
  ]);
}


// Обновленная функция для рендеринга статистики пользователя
function renderUserStats(controller: FinishHimController): VNode | null {
  const stats: FinishHimStats | null = controller.state.userStats; // Явно указываем тип
  const { tacticalRatingDelta, finishHimRatingDelta, pieceCountDelta } = controller.state;

  if (!stats) {
    return h('div.user-stats-container', [
        h('h4.user-stats-main-title', t('stats.title')),
        h('p', t('stats.loading'))
    ]);
  }

  const renderDelta = (delta: number | null): VNode | null => {
    if (delta === null || delta === 0) return null;
    const sign = delta > 0 ? '+' : '';
    return h('span.value-delta', {
      class: {
        'positive-delta': delta > 0,
        'negative-delta': delta < 0,
      }
    }, `${sign}${delta}`);
  };

  return h('div.user-stats-container', [
    h('h4.user-stats-main-title', t('stats.title')),
    h('div.games-played-info', `${t('stats.gamesPlayed')}: ${stats.gamesPlayed}`),
    h('div.stats-overview-grid', [
      // Tactical Phase Block
      h('div.stat-block', [
        h('h5.stat-block-title', t('stats.tacticalSectionTitle')),
        h('div.stat-block-values', [
          h('span.current-value', String(stats.tacticalRating)),
          renderDelta(tacticalRatingDelta)
        ])
      ]),
      // Playout Phase Block
      h('div.stat-block', [
        h('h5.stat-block-title', t('stats.playoutSectionTitle')),
        h('div.stat-block-values', [
          h('span.current-value', String(stats.finishHimRating)),
          renderDelta(finishHimRatingDelta)
        ])
      ]),
      // Level Block
      h('div.stat-block', [
        h('h5.stat-block-title', t('stats.levelSectionTitle')),
        h('div.stat-block-values', [
          h('span.current-value', String(stats.currentPieceCount)),
          renderDelta(pieceCountDelta)
        ])
      ]),
    ])
  ]);
}


function renderPlayoutTimerValue(controller: FinishHimController): VNode | null {
    if (controller.state.isInPlayoutMode && controller.state.outplayTimeRemainingMs !== null && controller.state.isGameEffectivelyActive) {
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

  // Обновленный порядок и вызовы рендеринга для левой панели
  const leftPanelContent = h('div.finish-him-left-panel', [
    h('div#finish-him-feedback', {}, [ // Первый элемент - фидбек
      h('p', {
        style: {
          fontWeight: 'bold',
          color: fhState.gameOverMessage ? 'var(--color-accent-error)' : 'var(--color-text-default)'
        }
      },
        fhState.gameOverMessage || fhState.feedbackMessage
      ),
    ]),
    renderCategoryDropdown(controller), // Второй элемент - выпадающее меню категорий
    renderUserStats(controller) // Третий элемент - статистика
  ]);

  const timerOverlayVNode = renderPlayoutTimerValue(controller);

  const rightPanelContent = h('div.finish-him-right-panel', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }
  }, [
    renderAnalysisPanel(controller.analysisController),
    timerOverlayVNode
  ]);

  return {
    left: leftPanelContent,
    center: centerContent,
    right: rightPanelContent
  };
}
