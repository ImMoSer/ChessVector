// src/features/puzzle/puzzleView.ts
import { h } from 'snabbdom';
import type { VNode, Hooks } from 'snabbdom';
import type { Key } from 'chessground/types';
import type { PuzzleController } from './PuzzleController';
import { BoardView } from '../../shared/components/boardView';
import logger from '../../utils/logger';
import { renderPromotionDialog } from '../common/promotion/promotionView';
import type { EvaluatedLineWithSan } from '../../core/analysis.service';
import type { Color as ChessopsColor } from 'chessops/types';


let boardViewInstance: BoardView | null = null;

export interface PuzzlePageViewLayout {
  left: VNode | null;
  center: VNode;
  right: VNode | null;
}

function renderVariations(controller: PuzzleController): VNode | null {
  if (!controller.boardHandler.isBoardConfiguredForAnalysis()) {
    return null;
  }

  const variations = controller.boardHandler.getCurrentPgnNodeVariations();
  
  if (variations.length <= 1) { 
    return null;
  }
  
  return h('div.pgn-variations', { style: { marginTop: '10px', padding: '5px', borderTop: '1px solid var(--color-border)'} }, [
    h('span.variations-label', { style: { fontWeight: 'bold', marginRight: '5px'} }, 'Варианты:'),
    ...variations.map((variationNode, index) => {
      const currentPgnNode = controller.boardHandler.pgnService.getCurrentNode();
      const isActiveVariation = currentPgnNode.children[0]?.id === variationNode.id;
      
      return h('button.button.variation-button', {
        style: { 
            marginRight: '5px', 
            marginBottom: '5px', 
            fontSize: '0.85em',
            padding: '3px 6px',
            backgroundColor: isActiveVariation ? 'var(--color-accent-info)' : 'var(--color-bg-tertiary)',
            color: isActiveVariation ? 'var(--color-text-on-accent)' : 'var(--color-text-default)',
            border: isActiveVariation ? '1px solid var(--color-accent-info)' : '1px solid var(--color-border-hover)',
        },
        on: {
          click: () => {
            logger.debug(`[puzzleView] Clicked variation ${index}: SAN ${variationNode.san}, ID ${variationNode.id}`);
            controller.handlePgnNavForward(index); 
          }
        },
        attrs: {
            disabled: controller.boardHandler.promotionCtrl.isActive()
        }
      }, variationNode.san || variationNode.uci);
    })
  ]);
}

function formatSanLine(
    pvSan: string[], 
    initialFullMoveNumber: number, 
    initialTurn: ChessopsColor,
    controller: PuzzleController, // Для обработчика клика
    lineIndexForLog: number // Для логирования
): VNode[] {
    const elements: VNode[] = [];
    let currentMoveNumber = initialFullMoveNumber;
    let currentTurn = initialTurn;

    pvSan.forEach((sanMove, moveIndex) => {
        const uciMoveForClick = controller.state.analysisUiState?.lines?.[lineIndexForLog]?.pvUci[moveIndex];

        if (currentTurn === 'white') {
            elements.push(h('span.move-number', `${currentMoveNumber}. `));
        } else if (moveIndex === 0) { // Первый ход черных в варианте
            elements.push(h('span.move-number', `${currentMoveNumber}... `));
        }

        elements.push(h('span.pv-move', {
            style: {
                cursor: uciMoveForClick ? 'pointer' : 'default',
                textDecoration: uciMoveForClick ? 'underline' : 'none',
                color: uciMoveForClick ? 'var(--color-text-link)' : 'inherit',
                marginRight: '5px'
            },
            on: {
                click: () => {
                    if (uciMoveForClick && controller.boardHandler.isBoardConfiguredForAnalysis()) {
                        logger.info(`[puzzleView] Clicked analysis move: ${uciMoveForClick} from line ${lineIndexForLog}, SAN: ${sanMove}`);
                        controller.handlePlayAnalysisMove(uciMoveForClick);
                    }
                }
            }
        }, sanMove));

        if (currentTurn === 'black') {
            currentMoveNumber++;
        }
        currentTurn = currentTurn === 'white' ? 'black' : 'white';
    });
    return elements;
}


function renderAnalysisLines(controller: PuzzleController): VNode {
  const analysisState = controller.state.analysisUiState;

  if (!analysisState || !analysisState.isActive) {
    return h('div.analysis-lines-container.empty', { style: { marginTop: '15px', padding: '10px', borderTop: '1px solid var(--color-border)' } }, [
      h('p.no-analysis-data', { style: { fontStyle: 'italic', color: 'var(--color-text-muted)'}}, 'Анализ не активен.')
    ]);
  }

  if (analysisState.isLoading) {
    return h('div.analysis-lines-container.loading', { style: { marginTop: '15px', padding: '10px', borderTop: '1px solid var(--color-border)' } }, [
      h('p.analysis-loading', { style: { fontWeight: 'bold' } }, 'Анализ...')
    ]);
  }

  if (!analysisState.lines || analysisState.lines.length === 0) {
    return h('div.analysis-lines-container.no-data', { style: { marginTop: '15px', padding: '10px', borderTop: '1px solid var(--color-border)' } }, [
      h('p.no-analysis-data', { style: { fontStyle: 'italic', color: 'var(--color-text-muted)'}}, 'Нет данных для анализа.')
    ]);
  }

  return h('div.analysis-lines-container', { style: { marginTop: '15px', fontFamily: 'monospace', fontSize: '0.9em', borderTop: '1px solid var(--color-border)', paddingTop: '10px' } }, [
    h('h4.analysis-title', { style: { margin: '0 0 10px 0', color: 'var(--color-text-muted)' } }, 'Линии Анализа:'),
    h('ul.analysis-list', { style: { listStyle: 'none', padding: '0', margin: '0' } }, 
      analysisState.lines.map((line: EvaluatedLineWithSan, lineIndex: number) => {
        const scoreType = line.score.type;
        const scoreValue = scoreType === 'cp' ? (line.score.value / 100).toFixed(2) : `мат в ${line.score.value}`;
        
        const formattedPvNodes = formatSanLine(line.pvSan, line.initialFullMoveNumber, line.initialTurn, controller, lineIndex);

        return h('li.analysis-line-item', { 
          style: { 
            marginBottom: '8px', 
            paddingBottom: '8px', 
            borderBottom: lineIndex < (analysisState.lines || []).length - 1 ? '1px dashed var(--color-border-hover)' : 'none'
          } 
        }, [
          h('div.line-info', `Гл: ${line.depth}, Оценка: ${scoreValue}`),
          h('div.line-pv', ['PV: ', ...formattedPvNodes])
        ]);
      })
    )
  ]);
}


export function renderPuzzleUI(controller: PuzzleController): PuzzlePageViewLayout {
  const puzzleControllerState = controller.state; 
  const boardHandler = controller.boardHandler; 
  const isBoardConfiguredForAnalysis = boardHandler.isBoardConfiguredForAnalysis(); 

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

  const pgnDisplayAndVariations = [
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
      puzzleControllerState.currentPgnString || "PGN появится здесь..."
    ),
    renderVariations(controller) 
  ];


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
    h('h3', { style: { marginTop: '0', marginBottom: '15px', color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)', paddingBottom: '8px', flexShrink: '0' } }, 'Детали Пазла'),
    puzzleControllerState.activePuzzle
      ? h('div.puzzle-details-list', { style: { marginBottom: '20px', flexShrink: '0'} }, puzzleInfoItems)
      : h('p', {style: {color: 'var(--color-text-muted)', marginBottom: '20px', flexShrink: '0'}}, 'Загрузите пазл для просмотра деталей.'),

    h('h4', { style: { marginTop: '0', marginBottom: '10px', color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)', paddingBottom: '8px', flexShrink: '0' } }, 'Нотация Игры (PGN)'),
    h('div.pgn-area-container', { style: { display: 'flex', flexDirection: 'column', flexGrow: '1', minHeight: '0' } }, pgnDisplayAndVariations)
  ]);

  const isPuzzleActive = !!puzzleControllerState.activePuzzle;
  const canActivateAnalysis = (isPuzzleActive || puzzleControllerState.gameOverMessage || puzzleControllerState.isInPlayoutMode);

  let pgnNavigationControls: VNode | null = null;
  if (isBoardConfiguredForAnalysis) { 
    pgnNavigationControls = h('div#pgn-navigation-controls.button-group', {
        style: {
            display: 'flex',
            justifyContent: 'space-between', 
            gap: '5px', 
            marginBottom: '10px' 
        }
    }, [
        h('button.button.pgn-nav-button', {
            attrs: { disabled: !controller.canNavigatePgnBackward() || boardHandler.promotionCtrl.isActive() },
            on: { click: () => controller.handlePgnNavToStart() }
        }, '|◀ Start'), 
        h('button.button.pgn-nav-button', {
            attrs: { disabled: !controller.canNavigatePgnBackward() || boardHandler.promotionCtrl.isActive() },
            on: { click: () => controller.handlePgnNavBackward() }
        }, '◀ Prev'), 
        h('button.button.pgn-nav-button', {
            attrs: { disabled: !controller.canNavigatePgnForward(0) || boardHandler.promotionCtrl.isActive() },
            on: { click: () => controller.handlePgnNavForward(0) }
        }, 'Next ▶'), 
        h('button.button.pgn-nav-button', {
            attrs: { disabled: !controller.canNavigatePgnForward(0) || boardHandler.promotionCtrl.isActive() }, 
            on: { click: () => controller.handlePgnNavToEnd() }
        }, 'End ▶|'), 
    ]);
  }

  const rightContent = h('div.puzzle-right-content', { style: { display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' } }, [
    h('div#puzzle-info-feedback', { style: { textAlign: 'center', marginBottom: '15px', fontSize: '1.1em', flexShrink: '0', minHeight: '2.5em' } }, [
      h('p', { style: { fontWeight: 'bold', color: puzzleControllerState.gameOverMessage ? (puzzleControllerState.gameOverMessage.toLowerCase().includes("won") || puzzleControllerState.gameOverMessage.toLowerCase().includes("победили") ? 'var(--color-accent-success)' : 'var(--color-accent-error)') : 'var(--color-text-default)' } },
        puzzleControllerState.gameOverMessage || puzzleControllerState.feedbackMessage
      ),
    ]),
    
    pgnNavigationControls, 
    
    h('div#controls.button-group', { style: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '10px', marginTop: pgnNavigationControls ? '5px' : 'auto', flexShrink: '0' } }, [
      h('button.button.puzzle-button.primary-button', { 
        attrs: {
          disabled: puzzleControllerState.isStockfishThinking || boardHandler.promotionCtrl.isActive() || isBoardConfiguredForAnalysis
        },
        on: { click: () => controller.loadAndStartPuzzle() }
      }, 'Следующий Пазл'),
      h('button.button.puzzle-button', { 
        attrs: {
          disabled: !isPuzzleActive || puzzleControllerState.isStockfishThinking || boardHandler.promotionCtrl.isActive() || isBoardConfiguredForAnalysis
        },
        on: { click: () => controller.handleRestartPuzzle() }
      }, 'Заново'),
      h('button.button.puzzle-button', { 
        class: { 'active-analysis': isBoardConfiguredForAnalysis }, 
        attrs: {
          disabled: !canActivateAnalysis || puzzleControllerState.isStockfishThinking || boardHandler.promotionCtrl.isActive()
        },
        on: { click: () => controller.handleToggleAnalysisMode() }
      }, isBoardConfiguredForAnalysis ? 'Завершить Анализ' : 'Анализ'), 
      h('button.button.puzzle-button', { 
        attrs: {
          disabled: puzzleControllerState.isStockfishThinking || boardHandler.promotionCtrl.isActive()
        },
        on: { click: () => controller.handleSetFen() }
      }, 'Установить FEN'),
    ]),
    renderAnalysisLines(controller) 
  ]);

  return {
    left: leftContent,
    center: centerContent,
    right: rightContent
  };
}
