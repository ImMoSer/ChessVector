// src/core/analysis.service.ts
import logger from '../utils/logger';
import type { StockfishService, EvaluatedLine, AnalysisOptions } from './stockfish.service';
import type { BoardHandler, MoveMadeEventData, PgnNavigatedEventData } from './boardHandler';
import { PgnService, type PgnNode } from './pgn.service';
import type { Key } from 'chessground/types';

export interface AnalysisStateForUI {
  isActive: boolean;
  isLoading: boolean;
  lines: EvaluatedLine[] | null;
  currentFenAnalyzed: string | null; 
}

const DEFAULT_ANALYSIS_DEPTH = 15;
const DEFAULT_ANALYSIS_LINES = 3;
const ANALYSIS_REQUEST_TIMEOUT = 20000; 

const ARROW_BRUSHES = {
  bestLine: 'blue',   
  secondLine: 'green', 
  thirdLine: 'red',   
};

export class AnalysisService {
  private stockfishService: StockfishService;
  private boardHandler: BoardHandler;
  private pgnServiceInstance: typeof PgnService; 

  private isActive: boolean = false;
  private isLoadingAnalysis: boolean = false;
  private currentAnalysisLines: EvaluatedLine[] | null = null;
  private currentFenForAnalysis: string | null = null; 
  private currentAnalysisNodePath: string | null = null; 

  private analysisTimeoutId: number | null = null;
  private currentAnalysisPromiseId: number = 0; // Для отслеживания актуального промиса

  private onAnalysisUpdateSubscribers: Array<(state: AnalysisStateForUI) => void> = [];

  constructor(
    stockfishService: StockfishService,
    boardHandler: BoardHandler,
    pgnServiceInstance: typeof PgnService, 
  ) {
    this.stockfishService = stockfishService;
    this.boardHandler = boardHandler;
    this.pgnServiceInstance = pgnServiceInstance; 

    this.boardHandler.onMoveMade(this._handleBoardMoveMade.bind(this));
    this.boardHandler.onPgnNavigated(this._handlePgnNavigated.bind(this));

    logger.info('[AnalysisService] Initialized and subscribed to BoardHandler events.');
  }

  public subscribeToAnalysisUpdates(subscriber: (state: AnalysisStateForUI) => void): () => void {
    this.onAnalysisUpdateSubscribers.push(subscriber);
    subscriber(this.getAnalysisStateForUI());
    return () => {
      this.onAnalysisUpdateSubscribers = this.onAnalysisUpdateSubscribers.filter(s => s !== subscriber);
    };
  }

  private _notifySubscribers(): void {
    const currentState = this.getAnalysisStateForUI();
    this.onAnalysisUpdateSubscribers.forEach(subscriber => {
      try {
        subscriber(currentState);
      } catch (error) {
        logger.error('[AnalysisService] Error in onAnalysisUpdate subscriber:', error);
      }
    });
  }

  public startAnalysis(nodePath?: string): void {
    logger.info(`[AnalysisService] Attempting to start analysis. Requested nodePath: ${nodePath}`);
    this.isActive = true;
    // Не сбрасываем isLoadingAnalysis здесь, это сделает _requestAndDisplayAnalysis
    // this.currentAnalysisLines = null; // Очистится в _requestAndDisplayAnalysis
    this.boardHandler.configureBoardForAnalysis(true);

    const pathToAnalyze = nodePath || this.pgnServiceInstance.getCurrentPath();
    this.currentAnalysisNodePath = pathToAnalyze;
    
    const pgnNode = this._getNodeByPath(pathToAnalyze);
    if (pgnNode) {
      this.currentFenForAnalysis = pgnNode.fenAfter;
      logger.info(`[AnalysisService] Starting analysis for PGN Path: ${pathToAnalyze}, FEN: ${this.currentFenForAnalysis}`);
      this._requestAndDisplayAnalysis(); // Запускаем новый анализ
    } else {
      this.currentFenForAnalysis = this.boardHandler.getFen(); 
      logger.warn(`[AnalysisService] Could not find PGN node for path: ${pathToAnalyze}. Using current board FEN: ${this.currentFenForAnalysis} for initial analysis.`);
      if (this.currentFenForAnalysis) {
         this._requestAndDisplayAnalysis();
      } else {
        logger.error('[AnalysisService] Cannot start analysis, no valid FEN found.');
        this.isActive = false; 
        this.boardHandler.configureBoardForAnalysis(false);
      }
    }
    this._notifySubscribers(); // Уведомить, что isActive=true
  }

  public stopAnalysis(): void {
    logger.info('[AnalysisService] Stopping analysis.');
    this.isActive = false;
    this.isLoadingAnalysis = false; // Важно сбросить флаг загрузки
    this.currentAnalysisPromiseId++; // Инкрементируем ID, чтобы текущие промисы анализа поняли, что они устарели

    if (this.analysisTimeoutId) {
      clearTimeout(this.analysisTimeoutId);
      this.analysisTimeoutId = null;
    }
    // Посылаем команду stop в StockfishService, если он ее поддерживает
    // this.stockfishService.sendCommand('stop'); // Зависит от реализации StockfishService
    
    this.boardHandler.configureBoardForAnalysis(false);
    this.boardHandler.clearAllDrawings(); 
    
    this.currentAnalysisLines = null;
    this._notifySubscribers();
  }

  public getAnalysisStateForUI(): AnalysisStateForUI {
    return {
      isActive: this.isActive,
      isLoading: this.isLoadingAnalysis,
      lines: this.currentAnalysisLines,
      currentFenAnalyzed: this.currentFenForAnalysis,
    };
  }

  public playMoveFromAnalysis(uciMove: string): void {
    if (!this.isActive) {
      logger.warn('[AnalysisService] playMoveFromAnalysis called, but analysis is not active.');
      return;
    }
    if (!this.currentAnalysisNodePath) {
        logger.warn('[AnalysisService] playMoveFromAnalysis called, but no current PGN node path for analysis.');
        return;
    }

    logger.info(`[AnalysisService] Applying move from analysis line: ${uciMove} to current node path: ${this.currentAnalysisNodePath}`);
    
    if (this.pgnServiceInstance.getCurrentPath() !== this.currentAnalysisNodePath) {
        this.boardHandler.handleNavigatePgnToPath(this.currentAnalysisNodePath);
    }

    this.boardHandler.applySystemMove(uciMove);
  }

  private _handleBoardMoveMade(data: MoveMadeEventData): void {
    if (!this.isActive) return;

    logger.debug(`[AnalysisService] Received onMoveMade. New path: ${data.newNodePath}. Current analysis path: ${this.currentAnalysisNodePath}`);
    if (data.newNodePath !== this.currentAnalysisNodePath || data.isVariation) {
      this.currentAnalysisNodePath = data.newNodePath;
      this.currentFenForAnalysis = data.newFen;
      logger.info(`[AnalysisService] Board move detected. Requesting new analysis for PGN Path: ${this.currentAnalysisNodePath}, FEN: ${this.currentFenForAnalysis}`);
      this._requestAndDisplayAnalysis();
    }
    // _notifySubscribers() будет вызван из _requestAndDisplayAnalysis
  }

  private _handlePgnNavigated(data: PgnNavigatedEventData): void {
    if (!this.isActive) return;

    logger.debug(`[AnalysisService] Received onPgnNavigated. New path: ${data.currentNodePath}. Current analysis path: ${this.currentAnalysisNodePath}`);
    if (data.currentNodePath !== this.currentAnalysisNodePath) {
      this.currentAnalysisNodePath = data.currentNodePath;
      this.currentFenForAnalysis = data.currentFen;
      logger.info(`[AnalysisService] PGN navigation detected. Requesting new analysis for PGN Path: ${this.currentAnalysisNodePath}, FEN: ${this.currentFenForAnalysis}`);
      this._requestAndDisplayAnalysis();
    }
     // _notifySubscribers() будет вызван из _requestAndDisplayAnalysis
  }

  private async _requestAndDisplayAnalysis(): Promise<void> {
    if (!this.isActive || !this.currentFenForAnalysis) {
      logger.warn('[AnalysisService _requestAndDisplayAnalysis] Analysis not active or no FEN. Aborting.');
      if (this.isLoadingAnalysis) { // Если мы прерываем из-за неактивности, но загрузка шла
          this.isLoadingAnalysis = false;
          this._notifySubscribers();
      }
      return;
    }

    // Увеличиваем ID для нового запроса
    this.currentAnalysisPromiseId++;
    const promiseId = this.currentAnalysisPromiseId;

    // Если уже идет анализ, и это не тот же самый FEN (на всякий случай, хотя path должен быть главным)
    // или если просто хотим прервать предыдущий и начать новый
    if (this.isLoadingAnalysis) {
        logger.warn('[AnalysisService _requestAndDisplayAnalysis] Previous analysis request in progress. Attempting to stop it and start new one.');
        // Попытка остановить предыдущий анализ в Stockfish, если это возможно
        // this.stockfishService.sendCommand('stop'); // Зависит от StockfishService
        if (this.analysisTimeoutId) {
            clearTimeout(this.analysisTimeoutId);
            this.analysisTimeoutId = null;
        }
    }

    this.isLoadingAnalysis = true;
    this.currentAnalysisLines = null; 
    this.boardHandler.clearAllDrawings(); 
    this._notifySubscribers();
    logger.info(`[AnalysisService promiseId: ${promiseId}] Requesting analysis from Stockfish for FEN: ${this.currentFenForAnalysis}`);

    if (this.analysisTimeoutId) { // Очищаем предыдущий таймаут, если он был
        clearTimeout(this.analysisTimeoutId);
    }
    this.analysisTimeoutId = window.setTimeout(() => {
      this.analysisTimeoutId = null; // Сбрасываем ID таймаута
      if (this.isLoadingAnalysis && this.currentAnalysisPromiseId === promiseId) { // Проверяем, что это таймаут для текущего запроса
          logger.warn(`[AnalysisService promiseId: ${promiseId}] Stockfish analysis request timed out for FEN: ${this.currentFenForAnalysis}`);
          this.isLoadingAnalysis = false;
          // this.stockfishService.sendCommand('stop'); 
          this.currentAnalysisLines = [{id: 0, depth: 0, score: {type: 'cp', value:0}, pvUci: ['timeout'] }]; 
          this._notifySubscribers();
      }
    }, ANALYSIS_REQUEST_TIMEOUT);

    try {
      const options: AnalysisOptions = {
        depth: DEFAULT_ANALYSIS_DEPTH,
        lines: DEFAULT_ANALYSIS_LINES,
      };
      const result = await this.stockfishService.getAnalysis(this.currentFenForAnalysis, options);

      // Проверяем, не был ли анализ остановлен или не начался ли новый запрос, пока этот выполнялся
      if (!this.isActive || this.currentAnalysisPromiseId !== promiseId) { 
        logger.info(`[AnalysisService promiseId: ${promiseId}] Analysis was stopped or superseded while waiting for Stockfish result.`);
        // isLoadingAnalysis и currentAnalysisLines уже могли быть изменены новым запросом или stopAnalysis
        // Если isLoadingAnalysis все еще true для этого промиса, сбрасываем
        if (this.isLoadingAnalysis && this.currentAnalysisPromiseId === promiseId) this.isLoadingAnalysis = false;
        if(this.analysisTimeoutId && this.currentAnalysisPromiseId === promiseId) clearTimeout(this.analysisTimeoutId); // Очищаем таймаут, если он еще активен для этого промиса
        // Не вызываем _notifySubscribers здесь, так как состояние могло быть обновлено другим процессом
        return;
      }
      
      if(this.analysisTimeoutId) clearTimeout(this.analysisTimeoutId); // Успешное завершение, очищаем таймаут
      this.analysisTimeoutId = null;

      if (result && result.evaluatedLines && result.evaluatedLines.length > 0) {
        this.currentAnalysisLines = result.evaluatedLines;
        logger.info(`[AnalysisService promiseId: ${promiseId}] Analysis received. Best move: ${result.bestMoveUci}. Lines:`, this.currentAnalysisLines);
        this._drawAnalysisLines();
      } else {
        logger.warn(`[AnalysisService promiseId: ${promiseId}] Stockfish returned no lines or an empty result.`);
        this.currentAnalysisLines = null;
      }
    } catch (error) {
      logger.error(`[AnalysisService promiseId: ${promiseId}] Error getting analysis from Stockfish:`, error);
      if (this.currentAnalysisPromiseId === promiseId) { // Обновляем состояние только если это был текущий промис
        this.currentAnalysisLines = null;
        if(this.analysisTimeoutId) clearTimeout(this.analysisTimeoutId);
        this.analysisTimeoutId = null;
      }
    } finally {
      // Устанавливаем isLoadingAnalysis = false только если это был последний активный промис
      if (this.currentAnalysisPromiseId === promiseId) {
        this.isLoadingAnalysis = false;
      }
      // Уведомляем подписчиков в любом случае, чтобы UI обновился (например, убрал спиннер)
      this._notifySubscribers();
    }
  }

  private _drawAnalysisLines(): void {
    if (!this.currentAnalysisLines || this.currentAnalysisLines.length === 0) {
      return;
    }
    this.boardHandler.clearAllDrawings();

    this.currentAnalysisLines.slice(0, 3).forEach((line, index) => {
      if (line.pvUci && line.pvUci.length > 0) {
        const uciMove = line.pvUci[0]; 
        const orig = uciMove.substring(0, 2) as Key;
        const dest = uciMove.substring(2, 4) as Key;
        let brush = ARROW_BRUSHES.bestLine;
        if (index === 1) brush = ARROW_BRUSHES.secondLine;
        if (index === 2) brush = ARROW_BRUSHES.thirdLine;
        
        this.boardHandler.drawArrow(orig, dest, brush);
      }
    });
  }

  private _getNodeByPath(path: string): PgnNode | null {
    const originalPath = this.pgnServiceInstance.getCurrentPath();
    let node: PgnNode | null = null;

    // Если PgnService уже на нужном пути, просто берем текущий узел
    if (originalPath === path) {
        node = this.pgnServiceInstance.getCurrentNode();
    } else { // Иначе, пытаемся навигироваться
        if (this.pgnServiceInstance.navigateToPath(path)) {
            node = this.pgnServiceInstance.getCurrentNode();
        } else {
            logger.warn(`[AnalysisService] _getNodeByPath: Failed to navigate to path ${path} in PgnService.`);
        }
        
        // Возвращаемся на исходный путь, если он отличался и навигация была успешной
        // Это может быть не всегда желаемым поведением, зависит от логики PgnService.
        // Если navigateToPath меняет состояние PgnService перманентно, то этот возврат может быть не нужен
        // или должен координироваться с тем, как BoardHandler и другие части ожидают состояние PgnService.
        // Для _getNodeByPath, которое просто *получает* узел, лучше не менять состояние PgnService перманентно.
        if (this.pgnServiceInstance.getCurrentPath() !== originalPath) {
            if (!this.pgnServiceInstance.navigateToPath(originalPath)) {
                logger.error(`[AnalysisService] _getNodeByPath: Critical error! Failed to navigate back to original path ${originalPath}.`);
            }
        }
    }
    return node;
  }

  public destroy(): void {
    logger.info('[AnalysisService] Destroying AnalysisService instance.');
    this.stopAnalysis(); 
    this.onAnalysisUpdateSubscribers = []; 
  }
}
