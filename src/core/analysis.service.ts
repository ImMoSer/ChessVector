// src/core/analysis.service.ts
import logger from '../utils/logger';
import type { StockfishService } from './stockfish.service'; // Убрали неиспользуемые EvaluatedLine, AnalysisOptions, ScoreInfo отсюда
import type { Color as ChessopsColor } from 'chessops/types';
// import { Chess } from 'chessops/chess'; // Не используется здесь напрямую
// import { parseFen } from 'chessops/fen'; // Не используется здесь напрямую
// import { parseUci } from 'chessops/util'; // Не используется здесь напрямую
// import { makeSan } from 'chessops/san'; // Не используется здесь напрямую

// Экспортируемые интерфейсы, которые будут использоваться в analysisController.ts и других местах
export interface AnalysisOptions {
  depth?: number;
  movetime?: number;
  lines?: number;
}

export interface ScoreInfo {
  type: 'cp' | 'mate';
  value: number;
}

export interface EvaluatedLine {
  id: number; // Номер линии (из MultiPV)
  depth: number;
  score: ScoreInfo;
  pvUci: string[]; // Главный вариант (PV) как массив ходов в UCI нотации
}

// Этот интерфейс используется для передачи состояния в UI, он уже экспортируется
export interface EvaluatedLineWithSan extends EvaluatedLine {
  pvSan: string[];
  startingFen: string;
  initialFullMoveNumber: number;
  initialTurn: ChessopsColor;
}

export interface AnalysisStateForUI {
  isActive: boolean;
  isLoading: boolean;
  lines: EvaluatedLineWithSan[] | null;
  currentFenAnalyzed: string | null;
}

// Константы, которые ранее были в AnalysisController, теперь могут быть здесь или оставаться в контроллере,
// в зависимости от того, где они более логичны. Оставим их пока в контроллере, так как они влияют на *запрос* анализа.
// const DEFAULT_ANALYSIS_DEPTH = 10;
// const DEFAULT_ANALYSIS_LINES = 3;
// const ANALYSIS_REQUEST_TIMEOUT = 20000; 


export class AnalysisService {
  private stockfishService: StockfishService;
  // boardHandler и pgnServiceInstance удалены, так как AnalysisService не должен напрямую с ними работать
  // для своей основной функции - получения анализа от Stockfish.
  // Эта логика перенесена в AnalysisController.

  // Состояния, связанные с UI или конкретным запросом, также перенесены в AnalysisController
  // private isActive: boolean = false;
  // private isLoadingAnalysis: boolean = false;
  // private currentAnalysisLines: EvaluatedLineWithSan[] | null = null;
  // private currentFenForAnalysis: string | null = null;
  // private currentAnalysisNodePath: string | null = null;
  // private analysisTimeoutId: number | null = null;
  // private currentAnalysisPromiseId: number = 0;
  // private onAnalysisUpdateSubscribers: Array<(state: AnalysisStateForUI) => void> = [];


  constructor(
    stockfishService: StockfishService,
    // boardHandler: BoardHandler, // Удалено
    // pgnServiceInstance: typeof PgnService, // Удалено
  ) {
    this.stockfishService = stockfishService;
    // this.boardHandler = boardHandler; // Удалено
    // this.pgnServiceInstance = pgnServiceInstance; // Удалено

    // Подписки на BoardHandler удалены, этим будет заниматься AnalysisController
    // this.boardHandler.onMoveMade(this._handleBoardMoveMade.bind(this));
    // this.boardHandler.onPgnNavigated(this._handlePgnNavigated.bind(this));

    logger.info('[AnalysisService] Initialized.');
  }

  // Метод subscribeToAnalysisUpdates и _notifySubscribers удалены,
  // так как управление состоянием для UI и уведомлениями перешло в AnalysisController.

  // Методы startAnalysis, stopAnalysis, playMoveFromAnalysis удалены,
  // они теперь являются частью AnalysisController.

  // Методы _handleBoardMoveMade, _handlePgnNavigated удалены.

  // Метод _convertUciToSanForLine удален, он теперь в AnalysisController.

  /**
   * Запрашивает анализ у StockfishService для указанного FEN и опций.
   * Возвращает массив EvaluatedLine или null в случае ошибки/таймаута на уровне StockfishService.
   * @param fen - FEN для анализа.
   * @param options - Опции анализа (глубина, линии).
   * @returns Promise, который разрешается массивом EvaluatedLine[] или null.
   */
  public async getAnalysis(fen: string, options: AnalysisOptions): Promise<EvaluatedLine[] | null> {
    // Этот метод теперь просто проксирует запрос к StockfishService
    // и возвращает результат в формате, который ожидает AnalysisController.
    // StockfishService.getAnalysis возвращает AnalysisResult | null,
    // где AnalysisResult содержит bestMoveUci и evaluatedLines.
    // Нам нужны только evaluatedLines.
    
    logger.debug(`[AnalysisService] Forwarding analysis request to StockfishService for FEN: ${fen} with options:`, options);
    
    try {
      const analysisResult = await this.stockfishService.getAnalysis(fen, options);
      if (analysisResult && analysisResult.evaluatedLines) {
        // Убедимся, что возвращаем только EvaluatedLine[], а не EvaluatedLineWithSan[]
        // Преобразование в EvaluatedLineWithSan будет происходить в AnalysisController
        return analysisResult.evaluatedLines.map(line => ({
          id: line.id,
          depth: line.depth,
          score: line.score,
          pvUci: line.pvUci,
        }));
      }
      logger.warn(`[AnalysisService] StockfishService returned null or no evaluatedLines for FEN: ${fen}`);
      return null;
    } catch (error: any) {
      logger.error(`[AnalysisService] Error calling StockfishService.getAnalysis for FEN ${fen}:`, error.message);
      return null; // В случае ошибки возвращаем null
    }
  }

  // Метод _drawAnalysisResult удален, он теперь в AnalysisController как _drawAnalysisResultOnBoard.
  // Метод _getNodeByPath удален, он теперь в AnalysisController.

  public destroy(): void {
    logger.info('[AnalysisService] Destroying AnalysisService instance.');
    // AnalysisService сам по себе не управляет подписками или таймерами,
    // поэтому здесь специфичного кода для уничтожения может и не быть,
    // кроме логирования. StockfishService управляет своим жизненным циклом отдельно.
  }
}
