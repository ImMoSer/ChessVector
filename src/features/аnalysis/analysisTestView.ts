// src/features/analysis/analysisTestView.ts
import { h } from 'snabbdom';
import type { VNode } from 'snabbdom';
import type { Key } from 'chessground/types'; // Key нужен для хука доски
import type { AnalysisTestController } from './AnalysisTestController';
import type { EvaluatedLine } from '../../core/stockfish.service';
import logger from '../../utils/logger';

export function renderAnalysisTestUI(controller: AnalysisTestController): VNode {
  const state = controller.state;
  logger.debug(`[analysisTestView] Rendering. Analyzing: ${state.isAnalyzing}. FEN: ${state.currentFen}`);

  return h('div#app-container.analysis-test-container', { style: { padding: '20px', fontFamily: 'Arial, sans-serif' } }, [
    h('h1', 'Тест Анализа Stockfish (MultiPV)'), // Stockfish Analysis Test (MultiPV)
    h('div#board-container', {
      key: 'board' as Key,
      style: {
        width: 'clamp(320px, 70vmin, 500px)',
        height: 'clamp(320px, 70vmin, 500px)',
        margin: '20px auto',
        border: '1px solid #ccc'
      },
      hook: {
        insert: (vnode: VNode) => {
          const elm = vnode.elm as HTMLElement;
          if (elm && !controller.chessboardService.ground) {
            logger.info('[analysisTestView] Chessground initializing for AnalysisTest...');
            controller.chessboardService.init(elm, {
              fen: state.currentFen,
              orientation: 'white', // или на основе FEN
              movable: {
                free: true, // Позволяем двигать фигуры для установки позиции
                color: 'both',
                dests: new Map(),
                events: {
                  after: (orig, dest, metadata) => {
                    if (controller.chessboardService.ground) {
                      const newFen = controller.chessboardService.ground.getFen();
                      if (newFen) {
                        controller.setFen(newFen); // Обновляем FEN в контроллере
                      }
                    }
                  }
                }
              },
              drawable: {
                enabled: true, // Включаем возможность рисования (для стрелок)
              }
            });
            logger.info('[analysisTestView] Chessground for AnalysisTest initialized.');
          } else if (elm && controller.chessboardService.ground) {
            // Если доска уже есть, просто синхронизируем FEN (хотя controller.initializeView должен это делать)
             controller.chessboardService.setFen(state.currentFen);
          }
        },
        destroy: () => {
          logger.info('[analysisTestView] Destroying Chessground for AnalysisTest...');
          controller.chessboardService.destroy();
        }
      }
    }),
    h('div.fen-input-container', { style: { textAlign: 'center', marginBottom: '10px'} }, [
        h('label', { attrs: { for: 'fenInput' }, style: { marginRight: '5px' } }, 'FEN:'),
        h('input#fenInput', {
            props: { type: 'text', value: state.currentFen },
            style: { width: '80%', maxWidth: '600px', padding: '5px', marginBottom: '5px' },
            on: {
                change: (event: Event) => {
                    const newFen = (event.target as HTMLInputElement).value;
                    controller.setFen(newFen);
                }
            }
        }),
    ]),
    h('div.controls', { style: { textAlign: 'center', marginBottom: '20px' } }, [
      h('button', {
        on: { click: () => controller.runAnalysis() },
        props: { disabled: state.isAnalyzing },
        style: { padding: '10px 20px', fontSize: '16px', cursor: 'pointer' }
      }, state.isAnalyzing ? 'Анализ...' : 'Анализировать (L:3, D:12)'), // Analyzing... / Analyze (L:3, D:12)
    ]),
    h('div.feedback-message', { style: { textAlign: 'center', marginBottom: '10px', minHeight: '1.2em', fontWeight: 'bold' } }, [
      state.feedbackMessage
    ]),
    h('div.analysis-results', { style: { marginTop: '20px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', border: '1px solid #eee', padding: '10px', background: '#f9f9f9' } }, [
      state.analysisResult && state.analysisResult.evaluatedLines.length > 0
        ? h('ul', { style: { listStyleType: 'none', padding: '0' } }, state.analysisResult.evaluatedLines.map((line: EvaluatedLine, index: number) =>
            h('li', { style: { marginBottom: '8px', paddingBottom: '8px', borderBottom: index < state.analysisResult!.evaluatedLines.length - 1 ? '1px dashed #ccc' : 'none' } }, [
              h('div', `Линия ${line.id}: Глубина ${line.depth}, Оценка: ${line.score.type === 'cp' ? (line.score.value / 100).toFixed(2) : `мат в ${line.score.value}`}`), // Line ... Depth ... Score ... mate in ...
              h('div', `PV (UCI): ${line.pvUci.join(' ')}`),
              // Если хотите отображать SAN, вам понадобится метод в контроллере,
              // который преобразует каждый ход в линии с помощью chessLogicServiceInstance
              // h('div', `PV (SAN): ${controller.convertUciLineToSan(state.currentFen, line.pvUci).join(' ')}`),
            ])
          ))
        : (state.analysisResult && state.analysisResult.bestMoveUci // Если есть только лучший ход
            ? h('p', `Лучший ход (UCI): ${state.analysisResult.bestMoveUci}`) // Best move (UCI):
            : (state.isAnalyzing ? '' : h('p', 'Нет данных для отображения.')) // No data to display.
          )
    ])
  ]);
}
