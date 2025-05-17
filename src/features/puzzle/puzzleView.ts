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
    if (puzzleControllerState.currentPuzzlePieceCount > 0) {
        puzzleInfoItems.push(h('div.info-item', [
            h('span.info-label', 'Level (Pieces): '),
            h('span.info-value', `${puzzleControllerState.currentPuzzlePieceCount}`)
        ]));
    }
  }

  const leftContent = h('div.puzzle-left-content', {
    style: {
        padding: '10px',
        fontSize: '0.9em',
        lineHeight: '1.6',
        display: 'flex', 
        flexDirection: 'column', 
        height: '100%' 
    }
  }, [
    h('h3', { style: { marginTop: '0', marginBottom: '15px', color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)', paddingBottom: '8px', flexShrink: '0' } }, 'Puzzle Details'),
    puzzleControllerState.activePuzzle
      ? h('div.puzzle-details-list', { style: { marginBottom: '20px', flexShrink: '0'} }, puzzleInfoItems)
      : h('p', {style: {color: 'var(--color-text-muted)', marginBottom: '20px', flexShrink: '0'}}, 'Load a puzzle to see details.'),

    h('h4', { style: { marginTop: '0', marginBottom: '10px', color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)', paddingBottom: '8px', flexShrink: '0' } }, 'Game Notation (PGN)'),
    h('div#pgn-display-container', {
        style: {
            fontFamily: 'monospace, "Courier New", Courier',
            whiteSpace: 'pre-wrap', 
            border: '1px solid var(--color-border)',
            padding: '10px',
            backgroundColor: 'var(--color-bg-tertiary)', 
            borderRadius: 'var(--panel-border-radius)',
            overflowY: 'auto', 
            flexGrow: '1', 
            minHeight: '100px', 
            fontSize: '0.9em', 
        }
      },
      puzzleControllerState.currentPgnString || "PGN will appear here..."
    )
  ]);
  // --- End Left Panel Content ---

  const isPuzzleActive = !!puzzleControllerState.activePuzzle;
  const canActivateAnalysis = isPuzzleActive && (puzzleControllerState.gameOverMessage || puzzleControllerState.isInPlayOutMode);

  // --- PGN Navigation Buttons ---
  let pgnNavigationControls: VNode | null = null;
  if (puzzleControllerState.isAnalysisModeActive) {
    pgnNavigationControls = h('div#pgn-navigation-controls.button-group', {
        style: {
            display: 'flex',
            justifyContent: 'space-between', // Distribute space between buttons
            gap: '5px', // Small gap between buttons in the group
            marginBottom: '10px' // Space below the navigation group
        }
    }, [
        h('button.button.pgn-nav-button', {
            attrs: { disabled: !controller.canNavigatePgnBackward() || boardHandler.promotionCtrl.isActive() },
            on: { click: () => controller.handlePgnNavToStart() }
        }, '|◀ Start'),
        h('button.button.pgn-nav-button', {
            attrs: { disabled: !controller.canNavigatePgnBackward() || boardHandler.promotionCtrl.isActive() },
            on: { click: () => controller.handlePgnNavBackward() }
        }, '◀ Previous'),
        h('button.button.pgn-nav-button', {
            attrs: { disabled: !controller.canNavigatePgnForward() || boardHandler.promotionCtrl.isActive() },
            on: { click: () => controller.handlePgnNavForward() }
        }, 'Next ▶'),
        h('button.button.pgn-nav-button', {
            attrs: { disabled: !controller.canNavigatePgnForward() || boardHandler.promotionCtrl.isActive() },
            on: { click: () => controller.handlePgnNavToEnd() }
        }, 'End ▶|'),
    ]);
  }
  // --- End PGN Navigation Buttons ---


  const rightContent = h('div.puzzle-right-content', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, [
    h('div#puzzle-info-feedback', { style: { textAlign: 'center', marginBottom: '20px', fontSize: '1.1em', flexShrink: '0' } }, [
      h('p', { style: { fontWeight: 'bold', color: puzzleControllerState.gameOverMessage ? (puzzleControllerState.gameOverMessage.toLowerCase().includes("won") ? 'var(--color-accent-success)' : 'var(--color-accent-error)') : 'var(--color-text-default)' } },
        puzzleControllerState.gameOverMessage || puzzleControllerState.feedbackMessage
      ),
    ]),
    // Вставляем блок навигации PGN перед основными кнопками управления, если он есть
    pgnNavigationControls, 
    h('div#controls.button-group', { style: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '10px', marginTop: pgnNavigationControls ? '0' : 'auto' } }, [
      h('button.button.puzzle-button.primary-button', { 
        attrs: {
          disabled: puzzleControllerState.isStockfishThinking || boardHandler.promotionCtrl.isActive() || puzzleControllerState.isAnalysisModeActive
        },
        on: { click: () => controller.loadAndStartPuzzle() }
      }, 'Next Puzzle'),
      h('button.button.puzzle-button', { 
        attrs: {
          disabled: !isPuzzleActive || puzzleControllerState.isStockfishThinking || boardHandler.promotionCtrl.isActive() || puzzleControllerState.isAnalysisModeActive
        },
        on: { click: () => controller.handleRestartPuzzle() }
      }, 'Restart'),
      h('button.button.puzzle-button', { 
        class: { 'active-analysis': puzzleControllerState.isAnalysisModeActive },
        attrs: {
          disabled: !canActivateAnalysis || puzzleControllerState.isStockfishThinking || boardHandler.promotionCtrl.isActive()
        },
        on: { click: () => controller.handleToggleAnalysisMode() }
      }, puzzleControllerState.isAnalysisModeActive ? 'End Analysis' : 'Analysis'),
      h('button.button.puzzle-button', { 
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
