// src/features/analysis_test/AnalysisTestController.ts
import type { ChessboardService } from '../../core/chessboard.service';
import { ChessLogicService } from '../../core/chess-logic.service';
import type { StockfishService, AnalysisResult, AnalysisOptions, EvaluatedLine } from '../../core/stockfish.service';
import logger from '../../utils/logger';
import type { Key } from 'chessground/types'; // ИСПРАВЛЕНИЕ: Импортируем Key

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
  private chessLogicServiceInstance: ChessLogicService;

  constructor(
    public chessboardService: ChessboardService,
    private stockfishService: StockfishService,
    chessLogicServiceInstance: ChessLogicService,
    private requestRedraw: () => void
  ) {
    this.chessLogicServiceInstance = chessLogicServiceInstance;
    this.state = {
      currentFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      isAnalyzing: false,
      analysisResult: null,
      feedbackMessage: 'Готов к анализу. Нажмите кнопку.', // Ready for analysis. Press the button.
      linesToRequest: 3,
      depthToRequest: 12,
    };
  }

  public initializeView(): void {
    this.updateBoardFromFen();
    this.requestRedraw();
  }

  private updateBoardFromFen(): void {
    if (this.chessboardService.ground) {
      this.chessboardService.setFen(this.state.currentFen);
      this.chessboardService.setOrientation('white');
      this.chessboardService.ground.set({
        movable: {
          free: true,
          color: 'both',
          dests: new Map(),
          events: {
            // ИСПРАВЛЕНИЕ: Помечаем неиспользуемые параметры
            after: (_orig: Key, _dest: Key, _metadata: any) => {
              if (this.chessboardService.ground) {
                const newFen = this.chessboardService.ground.getFen();
                if (newFen) {
                  this.state.currentFen = newFen;
                  this.state.analysisResult = null;
                  this.state.feedbackMessage = 'Позиция изменена. Готов к анализу.'; // Position changed. Ready for analysis.
                  logger.info(`[AnalysisTestController] FEN updated by user: ${this.state.currentFen}`);
                  this.requestRedraw();
                }
              }
            }
          }
        },
        turnColor: this.state.currentFen.includes(' w ') ? 'white' : 'black',
      });
    }
    this.requestRedraw();
  }

  public setFen(fen: string): void {
    if (fen && typeof fen === 'string') {
      const parts = fen.split(' ');
      if (parts.length >= 2) {
        this.state.currentFen = fen;
        this.state.analysisResult = null;
        this.state.feedbackMessage = 'FEN установлен. Готов к анализу.'; // FEN set. Ready for analysis.
        this.updateBoardFromFen();
        logger.info(`[AnalysisTestController] FEN set programmatically: ${this.state.currentFen}`);
      } else {
        this.state.feedbackMessage = 'Некорректный формат FEN.'; // Invalid FEN format.
        logger.warn(`[AnalysisTestController] Invalid FEN format: ${fen}`);
        this.requestRedraw();
      }
    }
  }


  public async runAnalysis(): Promise<void> {
    if (this.state.isAnalyzing) {
      logger.warn('[AnalysisTestController] Analysis is already in progress.');
      this.state.feedbackMessage = 'Анализ уже выполняется...'; // Analysis already in progress...
      this.requestRedraw();
      return;
    }

    logger.info(`[AnalysisTestController] Starting analysis for FEN: ${this.state.currentFen} | Lines: ${this.state.linesToRequest}, Depth: ${this.state.depthToRequest}`);
    this.state.isAnalyzing = true;
    this.state.analysisResult = null;
    this.state.feedbackMessage = `Анализ запущен (линий: ${this.state.linesToRequest}, глубина: ${this.state.depthToRequest})...`; // Analysis started...
    this.requestRedraw();
    this.chessboardService.clearShapes();

    const analysisOptions: AnalysisOptions = {
      depth: this.state.depthToRequest,
      lines: this.state.linesToRequest,
    };

    try {
      const result = await this.stockfishService.getAnalysis(this.state.currentFen, analysisOptions);
      this.state.isAnalyzing = false;
      if (result && result.evaluatedLines.length > 0) {
        this.state.analysisResult = result;
        this.state.feedbackMessage = `Анализ завершен. Лучший ход: ${result.bestMoveUci || 'нет'}. Линий: ${result.evaluatedLines.length}.`; // Analysis complete. Best move: ... Lines: ...
        logger.info('[AnalysisTestController] Analysis result:', result);
        this.drawAnalysisArrows(result.evaluatedLines);
      } else if (result && result.bestMoveUci) {
        this.state.analysisResult = result;
        this.state.feedbackMessage = `Анализ завершен. Лучший ход: ${result.bestMoveUci}. Линии не получены.`; // Analysis complete. Best move: ... No lines received.
        logger.info('[AnalysisTestController] Analysis result (only best move):', result);
      } else {
        this.state.analysisResult = null;
        this.state.feedbackMessage = 'Анализ не вернул результата или хода.'; // Analysis returned no result or move.
        logger.warn('[AnalysisTestController] Analysis returned no result.');
      }
    } catch (error: any) {
      this.state.isAnalyzing = false;
      this.state.analysisResult = null;
      this.state.feedbackMessage = `Ошибка анализа: ${error.message}`; // Analysis error: ...
      logger.error('[AnalysisTestController] Analysis error:', error);
    }
    this.requestRedraw();
  }

  private drawAnalysisArrows(lines: EvaluatedLine[]): void {
    if (!this.chessboardService.ground || !lines || lines.length === 0) {
      return;
    }
    const shapes = [];
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
    this.chessboardService.drawShapes(shapes);
  }

  // Метод для преобразования UCI в SAN, если понадобится в view
  public getSanMove(_fen: string, uciMove: string): string { // _fen пока не используется
    // ИСПРАВЛЕНИЕ: Закомментировано, так как uciToSan еще не реализован в ChessLogicService
    // const san = this.chessLogicServiceInstance.uciToSan(fen, uciMove);
    // return san || uciMove;
    logger.warn('[AnalysisTestController] uciToSan method is not yet fully implemented in ChessLogicService.');
    return uciMove; // Возвращаем UCI, пока SAN не готов
  }
}
