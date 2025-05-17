// src/features/puzzle/puzzleView.ts
import { h } from 'snabbdom';
import type { VNode, Hooks } from 'snabbdom';
import type { Key } from 'chessground/types';
import type { PuzzleController } from './PuzzleController';
import { BoardView } from '../../shared/components/boardView';
import logger from '../../utils/logger';
import { renderPromotionDialog } from '../common/promotion/promotionView';

let boardViewInstance: BoardView | null = null;

export interface PuzzlePageViewLayout {
  left: VNode | null;
  center: VNode;
  right: VNode | null;
}

export function renderPuzzleUI(controller: PuzzleController): PuzzlePageViewLayout {
  const puzzleControllerState = controller.state;
  const boardHandler = controller.boardHandler;

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

  const boardWrapperHook: Hooks = {
    insert: (vnode: VNode) => {
        const wrapperEl = vnode.elm as HTMLElement;
        const boardContainerEl = wrapperEl.querySelector('#board-container') as HTMLElement | null;
        if (boardContainerEl) {
            if (!boardViewInstance || boardViewInstance.container !== boardContainerEl) {
                if (boardViewInstance) {
                    logger.warn('[puzzleView.ts #board-wrapper hook.insert] Board container element changed or boardViewInstance was null. Re-initializing BoardView.');
                    boardViewInstance.destroy();
                } else {
                    logger.info('[puzzleView.ts #board-wrapper hook.insert] BoardView initializing for the first time...');
                }
                boardViewInstance = new BoardView(
                    boardContainerEl,
                    boardHandler,
                    controller.chessboardService,
                    (orig: Key, dest: Key) => controller.handleUserMove(orig, dest)
                );
            } else {
                logger.debug('[puzzleView.ts #board-wrapper hook.insert] boardViewInstance exists and container is the same, calling updateView.');
                boardViewInstance.updateView();
            }
        } else {
             logger.error('[puzzleView.ts #board-wrapper hook.insert] #board-container not found within #board-wrapper!');
        }
    },
    update: (_oldVnode: VNode, vnode: VNode) => {
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
                boardViewInstance.updateView();
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

  const centerContent = h('div#board-wrapper', {
    key: 'board-wrapper-key',
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
      key: 'board-container-key',
      style: {
        width: '100%',
      }
    }),
    promotionDialogVNode
  ]);

  // --- Left Panel Content ---
  const puzzleInfoItems = [];
  if (puzzleControllerState.activePuzzle) {
    puzzleInfoItems.push(h('div.info-item', [
        h('span.info-label', 'Puzzle ID: '),
        h('span.info-value', `${puzzleControllerState.activePuzzle.PuzzleId}`)
    ]));
    puzzleInfoItems.push(h('div.info-item', [
        h('span.info-label', 'Rating: '),
        h('span.info-value', `${puzzleControllerState.activePuzzle.Rating || 'N/A'}`)
    ]));
    // Используем currentPuzzlePieceCount из состояния контроллера
    if (puzzleControllerState.currentPuzzlePieceCount > 0) {
        puzzleInfoItems.push(h('div.info-item', [
            h('span.info-label', 'Level (Pieces): '),
            h('span.info-value', `${puzzleControllerState.currentPuzzlePieceCount}`)
        ]));
    }
  }

  const leftContent = h('div.puzzle-left-content', {
    style: {
        padding: '10px', // Add some padding
        fontSize: '0.9em',
        lineHeight: '1.6'
    }
  }, [
    h('h3', { style: { marginTop: '0', marginBottom: '15px', color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)', paddingBottom: '8px' } }, 'Puzzle Details'),
    puzzleControllerState.activePuzzle
      ? h('div.puzzle-details-list', puzzleInfoItems)
      : h('p', {style: {color: 'var(--color-text-muted)'}}, 'Load a puzzle to see details.'),
    // PGN display will go here later
    // h('div#pgn-display-container', { style: { marginTop: '20px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', border: '1px solid var(--color-border)', padding: '10px', maxHeight: '300px', overflowY: 'auto' } },
    //   puzzleControllerState.currentPgnString || "PGN will appear here..."
    // )
  ]);
  // --- End Left Panel Content ---

  const isPuzzleActive = !!puzzleControllerState.activePuzzle;
  const canActivateAnalysis = isPuzzleActive && (puzzleControllerState.gameOverMessage || puzzleControllerState.isInPlayOutMode);

  const rightContent = h('div.puzzle-right-content', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, [
    h('div#puzzle-info-feedback', { style: { textAlign: 'center', marginBottom: '20px', fontSize: '1.1em', flexShrink: '0' } }, [ // Renamed from #puzzle-info to avoid clash
      h('p', { style: { fontWeight: 'bold', color: puzzleControllerState.gameOverMessage ? (puzzleControllerState.gameOverMessage.toLowerCase().includes("won") ? 'var(--color-accent-success)' : 'var(--color-accent-error)') : 'var(--color-text-default)' } },
        puzzleControllerState.gameOverMessage || puzzleControllerState.feedbackMessage
      ),
      // Информация о пазле теперь в левой панели
      // puzzleControllerState.activePuzzle && !puzzleControllerState.isInPlayOutMode && !puzzleControllerState.gameOverMessage
      //   ? h('p.puzzle-details', `Puzzle ID: ${puzzleControllerState.activePuzzle.PuzzleId} | Rating: ${puzzleControllerState.activePuzzle.Rating || 'N/A'}`)
      //   : '',
    ]),
    h('div#controls', { style: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '10px', marginTop: 'auto' } }, [
      h('button.button.puzzle-button.primary-button', { // Next Puzzle
        attrs: {
          disabled: puzzleControllerState.isStockfishThinking || boardHandler.promotionCtrl.isActive() || puzzleControllerState.isAnalysisModeActive
        },
        on: { click: () => controller.loadAndStartPuzzle() }
      }, 'Next Puzzle'),
      h('button.button.puzzle-button', { // Restart
        attrs: {
          disabled: !isPuzzleActive || puzzleControllerState.isStockfishThinking || boardHandler.promotionCtrl.isActive() || puzzleControllerState.isAnalysisModeActive
        },
        on: { click: () => controller.handleRestartPuzzle() }
      }, 'Restart'),
      h('button.button.puzzle-button', { // Analysis
        class: { 'active-analysis': puzzleControllerState.isAnalysisModeActive },
        attrs: {
          disabled: !canActivateAnalysis || puzzleControllerState.isStockfishThinking || boardHandler.promotionCtrl.isActive()
        },
        on: { click: () => controller.handleToggleAnalysisMode() }
      }, puzzleControllerState.isAnalysisModeActive ? 'End Analysis' : 'Analysis'),
      h('button.button.puzzle-button', { // Set FEN
        attrs: {
          disabled: puzzleControllerState.isStockfishThinking || boardHandler.promotionCtrl.isActive()
        },
        on: { click: () => controller.handleSetFen() }
      }, 'Set FEN'),
    ])
  ]);

  return {
    left: leftContent,
    center: centerContent,
    right: rightContent
  };
}
