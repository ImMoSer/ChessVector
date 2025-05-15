// src/features/puzzle/puzzleView.ts
import { h } from 'snabbdom';
import type { VNode } from 'snabbdom';
// ИСПРАВЛЕНИЕ: Импортируем Key и MoveMetadata из 'chessground/types'
import type { Key, MoveMetadata } from 'chessground/types';
import type { PuzzleController } from './PuzzleController';
import logger from '../../utils/logger';

export function renderPuzzleUI(controller: PuzzleController): VNode {
  const appState = controller.appState;
  // Логгер теперь доступен
  logger.debug(`[puzzleView.ts] Rendering view. FEN: ${appState.currentFen}, Turn: ${appState.boardTurnColor}, Human: ${appState.humanPlayerColor}, PuzzleTurn: ${appState.isUserTurnInPuzzle}`);

  return h('div#app-container', [
    h('h1', 'ChessVector Puzzle Alpha'),
    h('div#board-container', {
      // Используем импортированный тип Key
      key: 'board' as Key,
      style: { width: 'clamp(320px, 90vmin, 800px)', height: 'clamp(320px, 90vmin, 800px)', margin: '20px auto', border: '1px solid #ccc' },
      hook: {
        insert: (vnode: VNode) => {
          logger.info('[puzzleView.ts] Board container VNode inserted.');
          const elm = vnode.elm as HTMLElement;

          // Доступ к chessboardService через controller.
          // Это временное решение, как указано в ваших комментариях.
          // В идеале, view не должен напрямую обращаться к сервисам таким образом.
          const chessboardService = (controller as any).chessboardService;

          if (elm && !chessboardService.ground) {
            logger.info('[puzzleView.ts] Chessground initializing for the first time...');
            // Тип для initialConfig будет проверяться внутри chessboardService.init()
            // на соответствие типу Config из 'chessground/config'
            const initialConfig = {
              fen: appState.currentFen,
              orientation: appState.humanPlayerColor || 'white',
              turnColor: appState.boardTurnColor,
              movable: {
                free: false,
                color: controller.determineMovableColor(),
                dests: controller.determineCurrentDests(),
                events: {
                  // Используем импортированные типы Key и MoveMetadata
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
          } else if (elm && chessboardService.ground) {
            logger.info('[puzzleView.ts] Chessground already initialized (e.g. HMR or re-patch), syncing state.');

            chessboardService.setFen(appState.currentFen);
            // Тип для объекта конфигурации в set() также будет проверяться
            // внутри chessboardService.ground.set()
            chessboardService.ground.set({
              orientation: appState.humanPlayerColor || (chessboardService.ground.state as any)?.orientation, // Добавлено (as any) для state, если тип неполный
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
