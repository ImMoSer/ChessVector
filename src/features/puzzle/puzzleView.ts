// src/features/puzzle/puzzleView.ts
import { h } from 'snabbdom';
import type { VNode, Hooks } from 'snabbdom'; // Hooks импортируется для типа boardWrapperHook
import type { Key } from 'chessground/types';
import type { PuzzleController } from './PuzzleController';
import { BoardView } from '../../shared/components/boardView'; 
import logger from '../../utils/logger';
import { renderPromotionDialog } from '../common/promotion/promotionView';

// Переменная для хранения экземпляра BoardView между перерисовками
let boardViewInstance: BoardView | null = null;

// Логика изменения размера (onResizeStart, onResizeMove, onResizeEnd и связанные переменные) удалена.
// Она будет управляться из appView.ts

// Новый тип для возвращаемого значения renderPuzzleUI
export interface PuzzlePageViewLayout {
  left: VNode | null;
  center: VNode;
  right: VNode | null;
}

export function renderPuzzleUI(controller: PuzzleController): PuzzlePageViewLayout {
  const puzzleControllerState = controller.state; 
  const boardHandler = controller.boardHandler; 

  // logger.debug(`[puzzleView.ts] Rendering view. Puzzle State Feedback: ${puzzleControllerState.feedbackMessage}`);

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

  // Хуки для #board-wrapper (теперь только для инициализации/обновления/уничтожения BoardView)
  const boardWrapperHook: Hooks = {
    insert: (vnode: VNode) => {
        const wrapperEl = vnode.elm as HTMLElement;
        // Ручка изменения размера больше не создается и не управляется здесь
        
        const boardContainerEl = wrapperEl.querySelector('#board-container') as HTMLElement | null;
        if (boardContainerEl) {
            // Проверяем, не изменился ли сам boardContainerEl или boardViewInstance не существует
            if (!boardViewInstance || boardViewInstance.container !== boardContainerEl) {
                if (boardViewInstance) { // Если экземпляр был, но контейнер другой, уничтожаем старый
                    logger.warn('[puzzleView.ts #board-wrapper hook.insert] Board container element changed or boardViewInstance was null. Re-initializing BoardView.');
                    boardViewInstance.destroy();
                } else {
                    logger.info('[puzzleView.ts #board-wrapper hook.insert] BoardView initializing for the first time...');
                }
                boardViewInstance = new BoardView(
                    boardContainerEl,
                    boardHandler, 
                    controller.chessboardService,
                    // controller.handleUserMove привязан к контексту controller в его конструкторе или при передаче
                    (orig: Key, dest: Key) => controller.handleUserMove(orig, dest) 
                );
            } else {
                // Контейнер тот же, экземпляр существует, просто обновляем вид
                logger.debug('[puzzleView.ts #board-wrapper hook.insert] boardViewInstance exists and container is the same, calling updateView.');
                boardViewInstance.updateView();
            }
        } else {
             logger.error('[puzzleView.ts #board-wrapper hook.insert] #board-container not found within #board-wrapper!');
        }
    },
    // ИСПРАВЛЕНО: oldVnode переименован в _oldVnode
    update: (_oldVnode: VNode, vnode: VNode) => {
        // Этот хук вызывается, когда VNode для #board-wrapper обновляется.
        // Нам нужно убедиться, что BoardView также обновлен, если он существует.
        // А также, если сам #board-container был пересоздан внутри #board-wrapper.
        const newBoardContainerEl = (vnode.elm as Element)?.querySelector('#board-container') as HTMLElement | null;

        if (boardViewInstance && newBoardContainerEl) {
            if (boardViewInstance.container !== newBoardContainerEl) {
                 logger.warn('[puzzleView.ts #board-wrapper hook.update] #board-container DOM element changed during update. Re-initializing BoardView.');
                 boardViewInstance.destroy();
                 boardViewInstance = new BoardView(
                    newBoardContainerEl,
                    boardHandler, 
                    controller.chessboardService,
                    (orig: Key, dest: Key) => controller.handleUserMove(orig, dest)
                );
            } else {
                // logger.debug('[puzzleView.ts #board-wrapper hook.update] Calling boardViewInstance.updateView() as container is the same.');
                boardViewInstance.updateView(); // Обновляем вид доски
            }
        } else if (!newBoardContainerEl && boardViewInstance) {
            logger.error('[puzzleView.ts #board-wrapper hook.update] #board-container disappeared, but boardViewInstance exists. Destroying instance.');
            boardViewInstance.destroy();
            boardViewInstance = null;
        } else if (newBoardContainerEl && !boardViewInstance) {
            logger.warn('[puzzleView.ts #board-wrapper hook.update] #board-container exists, but no boardViewInstance. Re-initializing.');
            boardViewInstance = new BoardView(
                newBoardContainerEl,
                boardHandler, 
                controller.chessboardService,
                (orig: Key, dest: Key) => controller.handleUserMove(orig, dest)
            );
        }
    },
    destroy: () => {
        logger.info('[puzzleView.ts #board-wrapper hook.destroy] Destroying BoardView instance.');
        if (boardViewInstance) {
          boardViewInstance.destroy();
          boardViewInstance = null; 
        }
    }
  };

  // --- Центральная колонка: Доска и диалог промоушена ---
  const centerContent = h('div#board-wrapper', { 
    key: 'board-wrapper-key', // Стабильный ключ для обертки
    style: { 
      position: 'relative', 
      width: '100%', 
      height: '100%',
      display: 'flex', 
      justifyContent: 'center',
      alignItems: 'center',
    },
    hook: boardWrapperHook,
  }, [
    h('div#board-container.cg-wrap', { 
      key: 'board-container-key', // Стабильный ключ для контейнера доски
      style: {
        // Стили width, height, aspect-ratio теперь в основном в style.css
        // Этот div будет занимать 100% от #board-wrapper,
        // а #board-wrapper будет занимать 100% от #center-panel.
        // #center-panel будет изменять свои размеры.
        width: '100%', // Занимает всю ширину родителя (#board-wrapper)
        // Высота будет определена через aspect-ratio в CSS
      }
    }),
    promotionDialogVNode 
  ]);

  // --- Левая колонка: Плейсхолдер ---
  const leftContent = h('div.puzzle-left-content', [ // Добавлен класс для возможных стилей
    h('h2', { style: { marginTop: '0', color: 'var(--color-text-muted)' } }, 'Шахматные Задачи')
    // Здесь можно будет позже добавить чат, историю ходов и т.д.
  ]);

  // --- Правая колонка: Информация о пазле и кнопки ---
  const rightContent = h('div.puzzle-right-content', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, [
    h('div#puzzle-info', { style: { textAlign: 'center', marginBottom: '20px', fontSize: '1.1em', flexShrink: '0' } }, [ // flexShrink:0 чтобы не сжимался
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
    h('div#controls', { style: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '10px', marginTop: 'auto' } }, [ // marginTop:auto прижмет кнопки вниз
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

  return {
    left: leftContent,
    center: centerContent,
    right: rightContent
  };
}
