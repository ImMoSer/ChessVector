// src/features/puzzle/puzzleView.ts
import { h } from 'snabbdom';
import type { VNode } from 'snabbdom';
// ИЗМЕНЕНО: Удален неиспользуемый импорт ChessgroundColor
import type { Key, MoveMetadata } from 'chessground/types';
import type { PuzzleController } from './PuzzleController';
import logger from '../../utils/logger';

import { renderPromotionDialog } from '../promotion/promotionView';

export function renderPuzzleUI(controller: PuzzleController): VNode {
  const appState = controller.appState;
  logger.debug(`[puzzleView.ts] Rendering view. FEN: ${appState.currentFen}, Turn: ${appState.boardTurnColor}, Human: ${appState.humanPlayerColor}, PuzzleTurn: ${appState.isUserTurnInPuzzle}`);

  let promotionDialogVNode: VNode | null = null;
  // Доступ к chessboardService и requestRedraw теперь корректен, так как они public в PuzzleController
  if (controller.chessboardService.ground) {
    const groundState = controller.chessboardService.ground.state;
    const boardOrientation = groundState.orientation;
    const boardDomBounds = groundState.dom?.bounds();

    if (boardDomBounds) {
        promotionDialogVNode = renderPromotionDialog(
        controller.promotionCtrl,
        boardOrientation,
        boardDomBounds
      );
    } else if (controller.promotionCtrl.isActive()) {
        logger.warn('[puzzleView.ts] Promotion is active, but board DOM bounds are not available yet.');
    }
  }


  return h('div#app-container', [
    h('h1', 'ChessVector Puzzle Alpha'),
    h('div#board-wrapper', { style: { position: 'relative', width: 'clamp(220px, 95vmin, 900px)', margin: '10px auto' } }, [
      h('div#board-container', {
        key: 'board' as Key,
        style: {
          width: '100%',
          height: 'clamp(320px, 95vmin, 900px)',
          border: '1px solid #ccc'
        },
        hook: {
          insert: (vnode: VNode) => {
            logger.info('[puzzleView.ts] Board container VNode inserted.');
            const elm = vnode.elm as HTMLElement;
            // controller.chessboardService теперь доступен
            const chessboardService = controller.chessboardService;

            if (elm && !chessboardService.ground) {
              logger.info('[puzzleView.ts] Chessground initializing for the first time...');
              const initialConfig = {
                fen: appState.currentFen.split(' ')[0],
                orientation: appState.humanPlayerColor || 'white',
                turnColor: appState.boardTurnColor,
                movable: {
                  free: false,
                  color: controller.determineMovableColor(),
                  dests: controller.determineCurrentDests(),
                  events: {
                    after: (orig: Key, dest: Key, _metadata: MoveMetadata) => {
                      controller.handleUserMove(orig, dest);
                    }
                  }
                },
                highlight: {
                  lastMove: true,
                  check: true,
                },
                animation: {
                  enabled: true,
                  duration: 100,
                },
              };
              chessboardService.init(elm, initialConfig);
              logger.info('[puzzleView.ts] Chessground initialized with config:', initialConfig);
              // controller.requestRedraw теперь доступен
              controller.requestRedraw();
            } else if (elm && chessboardService.ground) {
              logger.info('[puzzleView.ts] Chessground already initialized, syncing state.');
              chessboardService.setFen(appState.currentFen.split(' ')[0]);
              chessboardService.ground.set({
                orientation: appState.humanPlayerColor || (chessboardService.ground.state as any)?.orientation,
                turnColor: appState.boardTurnColor,
                movable: {
                  color: controller.determineMovableColor(),
                  dests: controller.determineCurrentDests(),
                }
              });
              logger.info('[puzzleView.ts] Chessground state synced on re-insert/HMR.');
            } else {
              logger.error('[puzzleView.ts] Board container element not found in VNode after insert!');
            }
          },
          destroy: (_vnode: VNode) => {
              logger.info('[puzzleView.ts] Board container VNode will be destroyed, destroying Chessground...');
              controller.chessboardService.destroy();
          }
        }
      }),
      promotionDialogVNode
    ]),
    h('div#puzzle-info', { style: { textAlign: 'center', marginTop: '10px', fontSize: '1.2em', minHeight: '2.5em' } }, [
        h('p', appState.gameOverMessage || appState.feedbackMessage),
        appState.activePuzzle && !appState.isInPlayOutMode && !appState.gameOverMessage
            ? h('p', `Пазл: ${appState.activePuzzle.PuzzleId} | Рейтинг: ${appState.activePuzzle.Rating || 'N/A'}`)
            : '',
        appState.activePuzzle && !appState.isInPlayOutMode && appState.isUserTurnInPuzzle && appState.currentSolutionMoveIndex < appState.puzzleSolutionMoves.length && !appState.gameOverMessage
            ? h('p', `Ожидается: ${appState.puzzleSolutionMoves[appState.currentSolutionMoveIndex]}`)
            : '',
    ]),
    h('div#controls', { style: { textAlign: 'center', marginTop: '10px', display: 'flex', justifyContent: 'center', gap: '10px' } }, [
      h('button.button.lichess-button', {
        attrs: { disabled: appState.isStockfishThinking || !!appState.gameOverMessage || controller.promotionCtrl.isActive() },
        on: { click: () => controller.handleSetFen() }
      }, 'Установить FEN'),
      h('button.button.lichess-button', {
        attrs: { disabled: appState.isStockfishThinking || !!appState.gameOverMessage || controller.promotionCtrl.isActive() },
        on: { click: () => controller.loadAndStartPuzzle() }
        }, 'Следующий пазл')
    ])
  ]);
}
