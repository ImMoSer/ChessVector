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

let boardViewInstance: BoardView | null = null;

export interface FinishHimPageViewLayout {
  left: VNode | null;
  center: VNode;
  right: VNode | null;
}

function renderCategoryButtons(controller: FinishHimController): VNode {
  // Инлайновые стили для h3 и кнопок категорий удалены,
  // они теперь должны быть полностью в finishHim.css
  return h('div.finish-him-categories', [
    h('h3', t('finishHim.categories.title')), // Удалены инлайн стили
    h('div.button-group.vertical',
      FINISH_HIM_PUZZLE_TYPES.map(type =>
        h('button.button.category-button', {
          key: type,
          class: { active: controller.state.activePuzzleType === type },
          // Инлайновые стили для backgroundColor, color, borderColor удалены
          // и управляются через класс .active в CSS
          on: {
            click: () => {
              logger.debug(`[FinishHimView] Category selected: ${type}`);
              controller.setActivePuzzleType(type);
            }
          },
          attrs: {
            disabled: controller.state.isStockfishThinking || controller.boardHandler.promotionCtrl.isActive()
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
            } else { boardViewInstance.updateView(); }
        } else { logger.error('[FinishHimView] #board-container not found within #board-wrapper!'); }
    },
    update: (_oldVnode: VNode, vnode: VNode) => {
        const newBoardContainerEl = (vnode.elm as Element)?.querySelector('#board-container') as HTMLElement | null;
        if (boardViewInstance && newBoardContainerEl) {
            if (boardViewInstance.container !== newBoardContainerEl) {
                 boardViewInstance.destroy();
                 boardViewInstance = new BoardView(newBoardContainerEl, boardHandler, controller.chessboardService,
                    (orig: Key, dest: Key) => controller.handleUserMove(orig, dest));
            } else { boardViewInstance.updateView(); }
        } else if (newBoardContainerEl && !boardViewInstance) {
            boardViewInstance = new BoardView(newBoardContainerEl, boardHandler, controller.chessboardService,
                (orig: Key, dest: Key) => controller.handleUserMove(orig, dest));
        } else if (!newBoardContainerEl && boardViewInstance) {
            boardViewInstance.destroy(); boardViewInstance = null;
        }
    },
    destroy: () => {
        if (boardViewInstance) { boardViewInstance.destroy(); boardViewInstance = null; }
    }
  };

  // Инлайновые стили для #board-wrapper и #board-container оставлены,
  // так как они больше относятся к позиционированию и размеру, чем к внешнему виду.
  const centerContent = h('div#board-wrapper', { key: 'fh-board-wrapper', style: { position: 'relative', width: '100%', height: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center'}, hook: boardWrapperHook }, [
    h('div#board-container.cg-wrap', { key: 'fh-board-container', style: { width: '100%' }}),
    promotionDialogVNode
  ]);

  // Инлайновые стили для .finish-him-left-panel удалены, теперь они будут в finishHim.css
  const leftContent = h('div.finish-him-left-panel', [
    h('div#finish-him-feedback', {
      // Инлайновый стиль для order оставлен, так как он управляет порядком flex-элементов,
      // что является частью структуры, а не чистого вида.
      // Остальные инлайновые стили удалены.
      style: { order: '-1' }
    }, [
      // Инлайновый стиль для цвета текста оставлен, так как он динамический.
      h('p', { style: { fontWeight: 'bold', color: fhState.gameOverMessage ? 'var(--color-accent-error)' : 'var(--color-text-default)' } },
        fhState.gameOverMessage || fhState.feedbackMessage
      ),
    ]),
    renderCategoryButtons(controller),
    // Инлайновые стили для .current-task-info и его дочерних элементов удалены.
    fhState.activePuzzle ? h('div.current-task-info', [
        h('h4', t('finishHim.currentTask.title')),
        h('p', `${t('puzzle.details.idLabel')} ${fhState.activePuzzle.PuzzleId}`),
        h('p', `${t('puzzle.details.ratingLabel')} ${fhState.activePuzzle.Rating || t('common.na')}`),
    ]) : null,
  ]);

  // Инлайновый стиль для .finish-him-right-panel оставлен, так как он структурный.
  const rightContent = h('div.finish-him-right-panel', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, [
    renderAnalysisPanel(controller.analysisController)
  ]);

  return {
    left: leftContent,
    center: centerContent,
    right: rightContent
  };
}
