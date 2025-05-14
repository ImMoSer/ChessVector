// src/features/puzzle/puzzleView.ts
import { h } from 'snabbdom';
import type { VNode } from 'snabbdom';
import type { Key, MoveMetadata } from 'chessground';
import type { PuzzleController } from './PuzzleController';
import logger from '../../utils/logger'; // ИСПРАВЛЕНИЕ: Добавлен импорт логгера

export function renderPuzzleUI(controller: PuzzleController): VNode {
  const appState = controller.appState; 
  // Логгер теперь доступен
  logger.debug(`[puzzleView.ts] Rendering view. FEN: ${appState.currentFen}, Turn: ${appState.boardTurnColor}, Human: ${appState.humanPlayerColor}, PuzzleTurn: ${appState.isUserTurnInPuzzle}`);
  
  return h('div#app-container', [
    h('h1', 'ChessVector Puzzle Alpha'),
    h('div#board-container', {
      key: 'board' as Key, 
      style: { width: 'clamp(320px, 90vmin, 600px)', height: 'clamp(320px, 90vmin, 600px)', margin: '20px auto', border: '1px solid #ccc' },
      hook: {
        insert: (vnode: VNode) => {
          logger.info('[puzzleView.ts] Board container VNode inserted.');
          const elm = vnode.elm as HTMLElement;
          
          // Доступ к chessboardService теперь через controller.
          // Предполагается, что controller.getChessboardService() вернет экземпляр
          // или chessboardService передается в controller и делается public свойством для доступа из view,
          // либо controller предоставляет методы для инициализации/управления доской.
          // Для текущего исправления, мы предполагаем, что puzzleEntry.ts передал chessboardService
          // в PuzzleController, и он доступен как this.chessboardService в контроллере.
          // View не должен напрямую вызывать методы сервисов, а через контроллер.
          // Однако, для хуков Snabbdom, которые вызываются самим Snabbdom, это может быть сложнее.
          // Пока что оставим прямой вызов controller.chessboardService (сделав его public в контроллере)
          // или передадим его как аргумент в renderPuzzleUI, если потребуется.

          // ВАЖНО: Чтобы этот код работал, chessboardService должен быть доступен из controller,
          // и controller должен передавать его в view или предоставлять методы для управления доской.
          // В PuzzleController.ts chessboardService уже private. Это нужно будет изменить
          // или передавать его как параметр в renderPuzzleUI, или controller должен иметь методы
          // типа initBoardInElement(element), syncBoardState().

          // Временное решение для доступа к chessboardService, если он private в контроллере
          // Это не лучший подход, но для исправления текущей ошибки с logger-ом подойдет.
          // В идеале, controller должен предоставлять методы для управления доской.
          const chessboardService = (controller as any).chessboardService; 

          if (elm && !chessboardService.ground) {
            logger.info('[puzzleView.ts] Chessground initializing for the first time...');
            const initialConfig = {
              fen: appState.currentFen,
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
                duration: 200,
              },
            };
            chessboardService.init(elm, initialConfig);
            logger.info('[puzzleView.ts] Chessground initialized with config:', initialConfig);
          } else if (elm && chessboardService.ground) {
            logger.info('[puzzleView.ts] Chessground already initialized (e.g. HMR or re-patch), syncing state.');
            
            chessboardService.setFen(appState.currentFen);
            chessboardService.ground.set({
              orientation: appState.humanPlayerColor || chessboardService.ground.state.orientation, 
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
            const chessboardService = (controller as any).chessboardService; 
            chessboardService.destroy();
            // stockfishService.terminate(); // Управляется из puzzleEntry.ts
        }
      }
    }),
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
        attrs: { disabled: appState.isStockfishThinking || !!appState.gameOverMessage }, 
        on: { click: () => controller.handleSetFen() } 
      }, 'Установить FEN'),
      h('button.button.lichess-button', { 
        attrs: { disabled: appState.isStockfishThinking || !!appState.gameOverMessage }, 
        on: { click: () => controller.loadAndStartPuzzle() } 
        }, 'Следующий пазл (Мок)')
    ])
  ]);
}
