// src/features/finishHim/finishHimView.ts
import { h } from 'snabbdom';
import type { VNode, Hooks } from 'snabbdom';
import type { Key } from 'chessground/types';
import type { FinishHimController } from './finishHimController';
import { FINISH_HIM_PUZZLE_TYPES } from './finishHim.types';
import { BoardView } from '../../shared/components/boardView';
import logger from '../../utils/logger';
import { renderPromotionDialog } from '../common/promotion/promotionView';
import { renderAnalysisPanel } from '../analysis/analysisPanelView'; // This now expects AnalysisController
import { t } from '../../core/i18n.service';

let boardViewInstance: BoardView | null = null;

export interface FinishHimPageViewLayout {
  left: VNode | null;
  center: VNode;
  right: VNode | null;
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
            // Disable category buttons if analysis is active and loading, or if stockfish is thinking (game active), or promotion
            disabled: (controller.analysisController.getPanelState().isAnalysisActive && controller.analysisController.getPanelState().isAnalysisLoading) || 
                      controller.state.isStockfishThinking || 
                      controller.boardHandler.promotionCtrl.isActive()
          }
        }, t(`finishHim.puzzleTypes.${type}`))
      )
    )
  ]);
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
        } else if (newBoardContainerEl && !boardViewInstance) { // If instance was null but container exists now
            boardViewInstance = new BoardView(newBoardContainerEl, boardHandler, controller.chessboardService,
                (orig: Key, dest: Key) => controller.handleUserMove(orig, dest));
        } else if (!newBoardContainerEl && boardViewInstance) { // If container disappeared but instance exists
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
      style: { width: '100%' /* Chessground will adapt to this */ }}
    ),
    promotionDialogVNode
  ]);

  const leftContent = h('div.finish-him-left-panel', [
    h('div#finish-him-feedback', {
      style: { order: '-1' } 
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
    renderCategoryButtons(controller),
    fhState.activePuzzle ? h('div.current-task-info', [
        h('h4', t('finishHim.currentTask.title')),
        h('p', `${t('puzzle.details.idLabel')} ${fhState.activePuzzle.PuzzleId}`),
        h('p', `${t('puzzle.details.ratingLabel')} ${fhState.activePuzzle.Rating || t('common.na')}`),
    ]) : null,
  ]);

  // Pass controller.analysisController to renderAnalysisPanel
  const rightContent = h('div.finish-him-right-panel', { 
    style: { display: 'flex', flexDirection: 'column', height: '100%' } 
  }, [
    renderAnalysisPanel(controller.analysisController) // Corrected: Pass the AnalysisController instance
  ]);

  return {
    left: leftContent,
    center: centerContent,
    right: rightContent
  };
}
