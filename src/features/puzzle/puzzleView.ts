// src/features/puzzle/puzzleView.ts
import { h } from 'snabbdom';
import type { VNode } from 'snabbdom';
// ИСПРАВЛЕНО: MoveMetadata удален из импорта, так как не используется
import type { Key } from 'chessground/types';
import type { PuzzleController } from './PuzzleController';
import { BoardView } from '../../shared/components/boardView'; 
import logger from '../../utils/logger';
import { renderPromotionDialog } from '../common/promotion/promotionView';

let boardViewInstance: BoardView | null = null;

export function renderPuzzleUI(controller: PuzzleController): VNode {
  const puzzleControllerState = controller.state; 
  const boardHandler = controller.boardHandler; 

  logger.debug(`[puzzleView.ts] Rendering view. Puzzle State Feedback: ${puzzleControllerState.feedbackMessage}`);

  let promotionDialogVNode: VNode | null = null;
  if (controller.chessboardService.ground) { 
    const groundState = controller.chessboardService.ground.state;
    const boardOrientation = groundState.orientation;
    const boardDomBounds = groundState.dom?.bounds();

    if (boardDomBounds) {
      promotionDialogVNode = renderPromotionDialog(
        boardHandler.promotionCtrl,
        boardOrientation,
        boardDomBounds
      );
    } else if (boardHandler.promotionCtrl.isActive()) {
      logger.warn('[puzzleView.ts] Promotion is active, but board DOM bounds are not available yet.');
    }
  }

  return h('div#app-container.puzzle-container', [
    h('h1', 'Шахматные Задачи'), 
    h('div#board-wrapper', { 
      style: { 
        position: 'relative', 
        width: 'clamp(300px, 80vmin, 600px)', 
        height: 'clamp(300px, 80vmin, 600px)', 
        margin: '20px auto' 
      } 
    }, [
      h('div#board-container.cg-wrap', { 
        key: 'board' as Key, 
        style: {
          width: '100%',
          height: '100%',
        },
        hook: {
          insert: (vnode: VNode) => {
            logger.info('[puzzleView.ts] Board container VNode inserted.');
            const elm = vnode.elm as HTMLElement;
            if (elm) {
              if (!boardViewInstance) {
                logger.info('[puzzleView.ts] BoardView initializing for the first time...');
                boardViewInstance = new BoardView(
                  elm,
                  boardHandler, 
                  controller.chessboardService,
                  (orig: Key, dest: Key) => controller.handleUserMove(orig, dest)
                );
              } else {
                logger.info('[puzzleView.ts] Board container re-inserted, ensuring BoardView is initialized/updated.');
                if (boardViewInstance.container !== elm) {
                    logger.warn('[puzzleView.ts] Board container element changed. Re-initializing BoardView.');
                    boardViewInstance.destroy(); 
                    boardViewInstance = new BoardView(
                        elm, 
                        boardHandler, 
                        controller.chessboardService,
                        (orig: Key, dest: Key) => controller.handleUserMove(orig, dest)
                    );
                } else {
                    boardViewInstance.updateView();
                }
              }
            } else {
              logger.error('[puzzleView.ts] Board container element not found in VNode after insert!');
            }
          },
          update: (_oldVnode: VNode, vnode: VNode) => {
            if (boardViewInstance && vnode.elm === boardViewInstance.container) { 
              logger.debug('[puzzleView.ts] Board container VNode updated, calling boardViewInstance.updateView()');
              boardViewInstance.updateView();
            }
          },
          destroy: (_vnode: VNode) => {
            logger.info('[puzzleView.ts] Board container VNode will be destroyed. Destroying BoardView instance.');
            if (boardViewInstance) {
              boardViewInstance.destroy();
              boardViewInstance = null; 
            }
          }
        }
      }),
      promotionDialogVNode 
    ]),
    h('div#puzzle-info', { style: { textAlign: 'center', marginTop: '15px', fontSize: '1.1em', minHeight: '2.2em', padding: '0 10px' } }, [
      h('p', { style: { fontWeight: 'bold', color: puzzleControllerState.gameOverMessage ? (puzzleControllerState.gameOverMessage.includes("победили") ? 'var(--color-accent-success)' : 'var(--color-accent-error)') : 'var(--color-text-default)' } },
        puzzleControllerState.gameOverMessage || puzzleControllerState.feedbackMessage
      ),
      puzzleControllerState.activePuzzle && !puzzleControllerState.isInPlayOutMode && !puzzleControllerState.gameOverMessage
        ? h('p.puzzle-details', `Пазл: ${puzzleControllerState.activePuzzle.PuzzleId} | Рейтинг: ${puzzleControllerState.activePuzzle.Rating || 'N/A'}`)
        : '',
      puzzleControllerState.activePuzzle && !puzzleControllerState.isInPlayOutMode && puzzleControllerState.isUserTurnInPuzzle && puzzleControllerState.currentSolutionMoveIndex < puzzleControllerState.puzzleSolutionMoves.length && !puzzleControllerState.gameOverMessage
        ? h('p.expected-move', { style: { color: 'var(--color-text-muted)' } }, `Ожидается: ${puzzleControllerState.puzzleSolutionMoves[puzzleControllerState.currentSolutionMoveIndex]}`)
        : '',
    ]),
    h('div#controls', { style: { textAlign: 'center', marginTop: '15px', display: 'flex', justifyContent: 'center', gap: '12px', padding: '0 10px' } }, [
      h('button.button.puzzle-button', {
        attrs: { 
          disabled: puzzleControllerState.isStockfishThinking || !!puzzleControllerState.gameOverMessage || boardHandler.promotionCtrl.isActive() 
        },
        on: { click: () => controller.handleSetFen() }
      }, 'Установить FEN'), 
      h('button.button.puzzle-button.primary-button', { 
        attrs: { 
          disabled: puzzleControllerState.isStockfishThinking || boardHandler.promotionCtrl.isActive() 
        },
        on: { click: () => controller.loadAndStartPuzzle() }
      }, 'Следующий пазл') 
    ])
  ]);
}
