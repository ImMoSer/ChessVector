// src/features/playFromFen/playFromFenView.ts
import { h } from 'snabbdom';
import type { VNode, Hooks } from 'snabbdom';
import type { PlayFromFenController } from './PlayFromFenController';
import { BoardView } from '../../shared/components/boardView';
import logger from '../../utils/logger';
import { renderPromotionDialog } from '../common/promotion/promotionView';
import { renderAnalysisPanel } from '../analysis/analysisPanelView';
import { t } from '../../core/i18n.service';

let boardViewInstance: BoardView | null = null;

export interface PlayFromFenPageViewLayout {
  left: VNode | null;
  center: VNode;
  right: VNode | null;
}

// Вспомогательная функция для рендеринга информации о позиции
function renderPositionInfo(controller: PlayFromFenController): VNode | null {
    const { currentPositionCp, currentPositionClass, currentPositionDifficultyClass, currentPositionPuzzleId } = controller.state;

    if (currentPositionCp === undefined && !currentPositionClass && currentPositionDifficultyClass === undefined && !currentPositionPuzzleId) {
        return null;
    }

    const items: VNode[] = [];

    if (currentPositionPuzzleId) {
        items.push(h('div.position-info-item', [
            h('strong', t('playFromFen.info.puzzleId', {defaultValue: "Puzzle ID:"}) + " "),
            currentPositionPuzzleId
        ]));
    }
    if (currentPositionCp !== undefined) {
        items.push(h('div.position-info-item', [
            h('strong', t('playFromFen.info.cp', {defaultValue: "CP:"}) + " "),
            currentPositionCp
        ]));
    }
    if (currentPositionClass) {
        items.push(h('div.position-info-item', [
            h('strong', t('playFromFen.info.positionClass', {defaultValue: "Class:"}) + " "),
            currentPositionClass
        ]));
    }
    if (currentPositionDifficultyClass !== undefined) {
        items.push(h('div.position-info-item', [
            h('strong', t('playFromFen.info.difficultyClass', {defaultValue: "Difficulty:"}) + " "),
            currentPositionDifficultyClass
        ]));
    }

    if (items.length === 0) return null;

    return h('div.position-info-container', [
        h('h4.position-info-title', t('playFromFen.info.title', {defaultValue: "Position Info"})),
        ...items
    ]);
}


export function renderPlayFromFenUI(controller: PlayFromFenController): PlayFromFenPageViewLayout {
  const pffState = controller.state;
  const boardHandler = controller.boardHandler;

  let promotionDialogVNode: VNode | null = null;
  if (controller.chessboardService.ground) {
    const groundState = controller.chessboardService.ground.state;
    const boardOrientation = groundState.orientation;
    const boardDomBounds = groundState.dom?.bounds();
    if (boardDomBounds) {
      promotionDialogVNode = renderPromotionDialog(boardHandler.promotionCtrl, boardOrientation, boardDomBounds);
    } else if (boardHandler.promotionCtrl.isActive()) {
      logger.warn('[PlayFromFenView] Promotion active, but board DOM bounds not available.');
    }
  }

  const boardWrapperHook: Hooks = {
    insert: (vnode: VNode) => {
        const wrapperEl = vnode.elm as HTMLElement;
        const boardContainerEl = wrapperEl.querySelector('#board-container') as HTMLElement | null;
        if (boardContainerEl) {
            if (!boardViewInstance || boardViewInstance.container !== boardContainerEl) {
                if (boardViewInstance) boardViewInstance.destroy();
                boardViewInstance = new BoardView(
                    boardContainerEl,
                    boardHandler,
                    controller.chessboardService,
                    (orig, dest) => controller.handleUserMove(orig, dest)
                );
            } else {
                boardViewInstance.updateView();
            }
        } else {
            logger.error('[PlayFromFenView] #board-container not found within #board-wrapper!');
        }
    },
    update: (_oldVnode: VNode, vnode: VNode) => {
        const newBoardContainerEl = (vnode.elm as Element)?.querySelector('#board-container') as HTMLElement | null;
        if (boardViewInstance && newBoardContainerEl) {
            if (boardViewInstance.container !== newBoardContainerEl) {
                 boardViewInstance.destroy();
                 boardViewInstance = new BoardView(
                    newBoardContainerEl,
                    boardHandler,
                    controller.chessboardService,
                    (orig, dest) => controller.handleUserMove(orig, dest)
                 );
            } else {
                boardViewInstance.updateView();
            }
        } else if (newBoardContainerEl && !boardViewInstance) {
            boardViewInstance = new BoardView(
                newBoardContainerEl,
                boardHandler,
                controller.chessboardService,
                (orig, dest) => controller.handleUserMove(orig, dest)
            );
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
    key: 'pff-board-wrapper',
    style: { position: 'relative', width: '100%', height: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center'},
    hook: boardWrapperHook
  }, [
    h('div#board-container.cg-wrap', {
      key: 'pff-board-container',
      style: { width: '100%' }}
    ),
    promotionDialogVNode
  ]);

  const leftPanelContent = h('div.play-from-fen-left-panel', [
    h('div#play-from-fen-feedback.feedback-area', pffState.feedbackMessage), // gameOverMessage будет отображаться здесь через feedbackMessage
    pffState.isLoadingFen ? h('div.loading-indicator', t('playFromFen.feedback.loadingFen')) : null,
    // pffState.gameOverMessage ? h('div.game-over-message', pffState.gameOverMessage) : null, // Удалено
    renderPositionInfo(controller)
  ]);

  const rightPanelContent = h('div.play-from-fen-right-panel', {
    style: { display: 'flex', flexDirection: 'column', height: '100%' }
  },[
    renderAnalysisPanel(controller.analysisController)
  ]);

  return {
    left: leftPanelContent,
    center: centerContent,
    right: rightPanelContent
  };
}
