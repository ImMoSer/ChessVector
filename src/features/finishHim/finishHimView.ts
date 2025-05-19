// src/features/finishHim/finishHimView.ts
import { h } from 'snabbdom';
import type { VNode, Hooks } from 'snabbdom';
import type { Key } from 'chessground/types';
import type { FinishHimController } from './finishHimController';
import { FINISH_HIM_PUZZLE_TYPES } from './finishHim.types';
import { BoardView } from '../../shared/components/boardView';
import logger from '../../utils/logger';
import { renderPromotionDialog } from '../common/promotion/promotionView';
import { renderAnalysisLinesView } from '../analysis/analysisView'; // Импортируем новую view для анализа
// EvaluatedLineWithSan и Color больше не нужны здесь напрямую для рендеринга анализа
import { t } from '../../core/i18n.service';

let boardViewInstance: BoardView | null = null;

export interface FinishHimPageViewLayout {
  left: VNode | null;
  center: VNode;
  right: VNode | null;
}

function renderCategoryButtons(controller: FinishHimController): VNode {
  return h('div.finish-him-categories', [
    h('h3', { style: { marginTop: '0', marginBottom: '15px', color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)', paddingBottom: '8px' } }, t('finishHim.categories.title')),
    h('div.button-group.vertical',
      FINISH_HIM_PUZZLE_TYPES.map(type =>
        h('button.button.category-button', {
          key: type,
          class: { active: controller.state.activePuzzleType === type },
          style: { 
            marginBottom: '8px', 
            width: '100%',
            backgroundColor: controller.state.activePuzzleType === type ? 'var(--color-accent-primary)' : 'var(--color-bg-tertiary)',
            color: controller.state.activePuzzleType === type ? 'var(--color-text-on-accent)' : 'var(--color-text-default)',
            borderColor: controller.state.activePuzzleType === type ? 'var(--color-accent-primary)' : 'var(--color-border-hover)',
          },
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

// Старая функция renderAnalysisLinesForFinishHim больше не нужна,
// так как ее заменяет renderAnalysisLinesView из analysisView.ts

export function renderFinishHimUI(controller: FinishHimController): FinishHimPageViewLayout {
  const fhState = controller.state;
  const boardHandler = controller.boardHandler;
  const isBoardConfiguredForAnalysis = boardHandler.isBoardConfiguredForAnalysis();
  
  // Получаем состояние анализа от FinishHimController, который берет его из AnalysisController
  const analysisStateForView = controller.getAnalysisStateForUI();

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

  const centerContent = h('div#board-wrapper', { key: 'fh-board-wrapper', style: { position: 'relative', width: '100%', height: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center'}, hook: boardWrapperHook }, [
    h('div#board-container.cg-wrap', { key: 'fh-board-container', style: { width: '100%' }}),
    promotionDialogVNode
  ]);

  const leftContent = h('div.finish-him-left-panel', { style: { padding: '10px', fontSize: '0.9em', lineHeight: '1.6', display: 'flex', flexDirection: 'column', height: '100%' }}, [
    renderCategoryButtons(controller),
    fhState.activePuzzle ? h('div.current-task-info', { style: { marginTop: '20px', borderTop: '1px solid var(--color-border)', paddingTop: '10px'}}, [
        h('h4', {style: {margin: '0 0 5px 0'}}, t('finishHim.currentTask.title')),
        h('p', {style: {margin: '2px 0'}}, `${t('puzzle.details.idLabel')} ${fhState.activePuzzle.PuzzleId}`),
        h('p', {style: {margin: '2px 0'}}, `${t('puzzle.details.ratingLabel')} ${fhState.activePuzzle.Rating || t('common.na')}`),
        h('p', {style: {margin: '2px 0'}}, `${t('puzzle.details.levelPiecesLabel')} ${fhState.currentTaskPieceCount || t('common.na')}`),
    ]) : null,
  ]);

  let pgnNavigationControls: VNode | null = null;
  if (isBoardConfiguredForAnalysis) {
    pgnNavigationControls = h('div#pgn-navigation-controls.button-group', { style: { display: 'flex', justifyContent: 'space-between', gap: '5px', marginBottom: '10px' }}, [
        h('button.button.pgn-nav-button', { attrs: { disabled: !controller.canNavigatePgnBackward() || boardHandler.promotionCtrl.isActive() }, on: { click: () => controller.handlePgnNavToStart() }}, t('pgn.nav.start')),
        h('button.button.pgn-nav-button', { attrs: { disabled: !controller.canNavigatePgnBackward() || boardHandler.promotionCtrl.isActive() }, on: { click: () => controller.handlePgnNavBackward() }}, t('pgn.nav.prev')),
        h('button.button.pgn-nav-button', { attrs: { disabled: !controller.canNavigatePgnForward(0) || boardHandler.promotionCtrl.isActive() }, on: { click: () => controller.handlePgnNavForward(0) }}, t('pgn.nav.next')),
        h('button.button.pgn-nav-button', { attrs: { disabled: !controller.canNavigatePgnForward(0) || boardHandler.promotionCtrl.isActive() }, on: { click: () => controller.handlePgnNavToEnd() }}, t('pgn.nav.end')),
    ]);
  }

  const rightContent = h('div.finish-him-right-panel', { style: { display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' } }, [
    h('div#finish-him-feedback', { style: { textAlign: 'center', marginBottom: '15px', fontSize: '1.1em', flexShrink: '0', minHeight: '2.5em' } }, [
      h('p', { style: { fontWeight: 'bold', color: fhState.gameOverMessage ? 'var(--color-accent-error)' : 'var(--color-text-default)' } },
        fhState.gameOverMessage || fhState.feedbackMessage
      ),
    ]),
    pgnNavigationControls,
    h('div#controls.button-group', { style: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '10px', marginTop: pgnNavigationControls ? '5px' : 'auto', flexShrink: '0' } }, [
      h('button.button.finish-him-button.primary-button', {
        attrs: {
          disabled: fhState.isStockfishThinking || boardHandler.promotionCtrl.isActive() || isBoardConfiguredForAnalysis
        },
        on: { click: () => controller.loadAndStartFinishHimPuzzle() }
      }, t('puzzle.button.next')),
      h('button.button.finish-him-button', {
        attrs: {
          disabled: !fhState.activePuzzle || fhState.isStockfishThinking || boardHandler.promotionCtrl.isActive() || isBoardConfiguredForAnalysis
        },
        on: { click: () => controller.handleRestartTask() }
      }, t('puzzle.button.restartTask')),
      h('button.button.finish-him-button', {
        attrs: {
          disabled: fhState.isStockfishThinking || boardHandler.promotionCtrl.isActive()
        },
        on: { click: () => controller.handleSetFen() }
      }, t('puzzle.button.setFen')),
      h('button.button.finish-him-button', {
        class: { 'active-analysis': isBoardConfiguredForAnalysis },
        attrs: {
          disabled: (!fhState.activePuzzle && !fhState.gameOverMessage && !boardHandler.getFen().startsWith('8/8/8/8/8/8/8/8')) || fhState.isStockfishThinking || boardHandler.promotionCtrl.isActive()
        },
        on: { click: () => controller.handleToggleAnalysisMode() }
      }, isBoardConfiguredForAnalysis ? t('puzzle.button.finishAnalysis') : t('puzzle.button.analysis')),
    ]),
    // Используем новую функцию renderAnalysisLinesView
    renderAnalysisLinesView(
        analysisStateForView, // Передаем состояние анализа
        (uciMove: string) => controller.handlePlayAnalysisMove(uciMove) // Передаем колбэк
    )
  ]);

  return {
    left: leftContent,
    center: centerContent,
    right: rightContent
  };
}
