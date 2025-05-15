// src/features/analysis/AnalysisTestController.ts
import type { ChessboardService } from '../../core/chessboard.service';
// import { ChessLogicService } from '../../core/chess-logic.service'; // Пока не используется
import type { StockfishService, AnalysisResult, AnalysisOptions, EvaluatedLine } from '../../core/stockfish.service';
import logger from '../../utils/logger';
import type { Key, Color as ChessgroundColor } from 'chessground/types';

interface AnalysisTestState {
  currentFen: string;
  isAnalyzing: boolean;
  analysisResult: AnalysisResult | null;
  feedbackMessage: string;
  linesToRequest: number;
  depthToRequest: number;
}

export class AnalysisTestController {
  public state: AnalysisTestState;
  // private chessLogicServiceInstance: ChessLogicService; // ИСПРАВЛЕНИЕ: Удалено, т.к. не используется
  // private firstDrawAttempt = true; // Для диагностики ошибки chessground - можно убрать, если RAF работает

  constructor(
    public chessboardService: ChessboardService,
    private stockfishService: StockfishService,
    // chessLogicServiceInstance: ChessLogicService, // ИСПРАВЛЕНИЕ: Удалено
    private requestRedraw: () => void
  ) {
    // this.chessLogicServiceInstance = chessLogicServiceInstance; // ИСПРАВЛЕНИЕ: Удалено
    this.state = {
      currentFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      isAnalyzing: false,
      analysisResult: null,
      feedbackMessage: 'Готов к анализу. Нажмите кнопку.',
      linesToRequest: 3,
      depthToRequest: 12,
    };
  }

  public initializeView(): void {
    this.updateBoardFromFen(true);
  }

  public updateBoardFromFen(isInitialSetup: boolean = false): void {
    if (!this.chessboardService.ground && !isInitialSetup) {
      logger.warn('[AnalysisTestController] updateBoardFromFen called but ground not initialized by view yet.');
      return;
    }
    if (!this.chessboardService.ground && isInitialSetup) {
        logger.info('[AnalysisTestController] updateBoardFromFen (initial): ground not yet created by view, view will call again.');
        this.requestRedraw(); 
        return;
    }
    if (!this.chessboardService.ground) return; 

    const fenParts = this.state.currentFen.split(' ');
    const currentTurnInFenForBoard: ChessgroundColor = fenParts[1] === 'w' ? 'white' : 'black';

    const configForSet = {
        fen: fenParts[0], 
        turnColor: currentTurnInFenForBoard, // Используем преобразованное значение
        orientation: 'white' as ChessgroundColor,
        movable: {
          free: true,
          color: 'both' as ChessgroundColor | 'both',
          dests: new Map<Key, Key[]>(),
          events: {
            after: (_orig: Key, _dest: Key, _metadata: any) => {
              if (this.chessboardService.ground) {
                const piecePlacementFen = this.chessboardService.ground.getFen();
                
                const oldFenParts = this.state.currentFen.split(' ');
                const oldTurnFenChar = oldFenParts[1]; // 'w' или 'b'
                const newTurnFenChar = oldTurnFenChar === 'w' ? 'b' : 'w';
                
                const castling = oldFenParts[2] || '-';
                const enPassant = oldFenParts[3] || '-';
                const halfMoveClock = (parseInt(oldFenParts[4] || '0', 10) + 1);
                const fullMoveCounter = oldTurnFenChar === 'b' ? (parseInt(oldFenParts[5] || '1', 10) + 1) : parseInt(oldFenParts[5] || '1', 10);

                const newFullFen = `${piecePlacementFen} ${newTurnFenChar} ${castling} ${enPassant} ${halfMoveClock} ${fullMoveCounter}`;
                                
                if (this.state.currentFen !== newFullFen) {
                    this.state.currentFen = newFullFen;
                    this.state.analysisResult = null; 
                    this.state.feedbackMessage = 'Позиция изменена. Готов к анализу.';
                    logger.info(`[AnalysisTestController] FEN updated by user drag: ${this.state.currentFen}`);
                    
                    // Обновляем FEN и turnColor на доске chessground
                    this.chessboardService.setFen(piecePlacementFen); 
                    if (this.chessboardService.ground) { 
                       // ИСПРАВЛЕНИЕ: Преобразуем 'b'/'w' в 'black'/'white'
                       const newTurnForBoard: ChessgroundColor = newTurnFenChar === 'w' ? 'white' : 'black';
                       this.chessboardService.ground.set({ turnColor: newTurnForBoard });
                    }
                    this.requestRedraw();
                }
              }
            }
          }
        },
        drawable: {
            enabled: true,
            shapes: [],
        }
      };

    this.chessboardService.ground.set(configForSet);
    if(isInitialSetup) this.requestRedraw();
  }

  public setFen(fen: string): void {
    if (fen && typeof fen === 'string') {
      const parts = fen.split(' ');
      if (parts.length >= 2 && parts[0].split('/').length === 8 && (parts[1] === 'w' || parts[1] === 'b')) {
        this.state.currentFen = fen;
        this.state.analysisResult = null;
        this.state.feedbackMessage = 'FEN установлен. Готов к анализу.';
        if (this.chessboardService.ground) {
            this.updateBoardFromFen(); 
        } else {
            this.requestRedraw(); 
        }
        logger.info(`[AnalysisTestController] FEN set programmatically: ${this.state.currentFen}`);
      } else {
        this.state.feedbackMessage = 'Некорректный формат FEN.';
        logger.warn(`[AnalysisTestController] Invalid FEN format from input: ${fen}`);
        this.requestRedraw();
      }
    }
  }


  public async runAnalysis(): Promise<void> {
    if (this.state.isAnalyzing) {
      logger.warn('[AnalysisTestController] Analysis is already in progress.');
      this.state.feedbackMessage = 'Анализ уже выполняется...';
      this.requestRedraw();
      return;
    }

    logger.info(`[AnalysisTestController] Starting analysis for FEN: ${this.state.currentFen} | Lines: ${this.state.linesToRequest}, Depth: ${this.state.depthToRequest}`);
    this.state.isAnalyzing = true;
    this.state.analysisResult = null;
    this.state.feedbackMessage = `Анализ запущен (линий: ${this.state.linesToRequest}, глубина: ${this.state.depthToRequest})...`;
    this.requestRedraw();
    
    if (this.chessboardService.ground) {
        this.chessboardService.clearShapes();
    }

    const analysisOptions: AnalysisOptions = {
      depth: this.state.depthToRequest,
      lines: this.state.linesToRequest,
    };

    try {
      const result = await this.stockfishService.getAnalysis(this.state.currentFen, analysisOptions);
      this.state.isAnalyzing = false;
      if (result && result.evaluatedLines.length > 0) {
        this.state.analysisResult = result;
        this.state.feedbackMessage = `Анализ завершен. Лучший ход: ${result.bestMoveUci || 'нет'}. Линий: ${result.evaluatedLines.length}.`;
        logger.info('[AnalysisTestController] Analysis result:', result);
        this.drawAnalysisArrows(result.evaluatedLines);
      } else if (result && result.bestMoveUci) {
        this.state.analysisResult = result;
        this.state.feedbackMessage = `Анализ завершен. Лучший ход: ${result.bestMoveUci}. Линии не получены.`;
        logger.info('[AnalysisTestController] Analysis result (only best move):', result);
        if (this.chessboardService.ground) this.chessboardService.clearShapes();
      } else {
        this.state.analysisResult = null;
        this.state.feedbackMessage = 'Анализ не вернул результата или хода.';
        logger.warn('[AnalysisTestController] Analysis returned no result.');
        if (this.chessboardService.ground) this.chessboardService.clearShapes();
      }
    } catch (error: any) {
      this.state.isAnalyzing = false;
      this.state.analysisResult = null;
      this.state.feedbackMessage = `Ошибка анализа: ${error.message}`;
      logger.error('[AnalysisTestController] Analysis error:', error);
      if (this.chessboardService.ground) this.chessboardService.clearShapes();
    }
    this.requestRedraw();
  }

  private drawAnalysisArrows(lines: EvaluatedLine[]): void {
    if (!this.chessboardService.ground || !lines || lines.length === 0) {
      return;
    }
    const shapes: Array<{ orig: Key; dest?: Key; brush: string }> = [];
    const lineToShow = lines[0];
    if (lineToShow && lineToShow.pvUci.length > 0) {
      for (let i = 0; i < Math.min(lineToShow.pvUci.length, 3); i++) {
        const uciMove = lineToShow.pvUci[i];
        const orig = uciMove.substring(0, 2) as Key;
        const dest = uciMove.substring(2, 4) as Key;
        const brush = i === 0 ? 'blueArrow' : (i === 1 ? 'greenArrow' : 'redArrow');
        shapes.push({ orig, dest, brush });
      }
    }

    const drawFn = () => {
        if (this.chessboardService.ground && this.chessboardService.ground.state.dom.elements.svg) { 
            this.chessboardService.drawShapes(shapes);
        } else {
            logger.warn('[AnalysisTestController] Chessground SVG not ready for drawing shapes.');
        }
    };
    requestAnimationFrame(drawFn);
  }

  public getSanMove(_fen: string, uciMove: string): string {
    logger.warn('[AnalysisTestController] uciToSan method is not yet fully implemented in ChessLogicService.');
    return uciMove; 
  }
}
