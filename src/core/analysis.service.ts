// src/core/analysis.service.ts
import logger from '../utils/logger';
import type { StockfishService, EvaluatedLine, AnalysisOptions, ScoreInfo } from './stockfish.service';
import type { BoardHandler, MoveMadeEventData, PgnNavigatedEventData } from './boardHandler';
import { PgnService, type PgnNode } from './pgn.service';
import type { Key,  } from 'chessground/types'; // Color импортирован
import type { CustomDrawShape } from './chessboard.service'; 

import { Chess } from 'chessops/chess';
import type { Color as ChessopsColor } from 'chessops/types'; // Color импортирован
import { parseFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';
import { makeSan } from 'chessops/san';


export interface EvaluatedLineWithSan extends EvaluatedLine {
  pvSan: string[];
  startingFen: string; // FEN, с которого начинается эта линия PV
  // Добавляем информацию для корректной нумерации в UI
  initialFullMoveNumber: number;
  initialTurn: ChessopsColor; // 'white' или 'black'
}

export interface AnalysisStateForUI {
  isActive: boolean;
  isLoading: boolean;
  lines: EvaluatedLineWithSan[] | null; 
  currentFenAnalyzed: string | null; 
}

const DEFAULT_ANALYSIS_DEPTH = 10;
const DEFAULT_ANALYSIS_LINES = 3;
const ANALYSIS_REQUEST_TIMEOUT = 20000; 

const ARROW_BRUSHES = {
  bestLine: 'green',   
  secondLine: 'yellow', 
  thirdLine: 'red',   
};

export class AnalysisService {
  private stockfishService: StockfishService;
  private boardHandler: BoardHandler;
  private pgnServiceInstance: typeof PgnService; 

  private isActive: boolean = false;
  private isLoadingAnalysis: boolean = false;
  private currentAnalysisLines: EvaluatedLineWithSan[] | null = null; 
  private currentFenForAnalysis: string | null = null; 
  private currentAnalysisNodePath: string | null = null; 

  private analysisTimeoutId: number | null = null;
  private currentAnalysisPromiseId: number = 0; 

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
    this.boardHandler.configureBoardForAnalysis(true);

    const pathToAnalyze = nodePath || this.pgnServiceInstance.getCurrentPath();
    this.currentAnalysisNodePath = pathToAnalyze;
    
    const pgnNode = this._getNodeByPath(pathToAnalyze);
    if (pgnNode) {
      this.currentFenForAnalysis = pgnNode.fenAfter;
      logger.info(`[AnalysisService] Starting analysis for PGN Path: ${pathToAnalyze}, FEN: ${this.currentFenForAnalysis}`);
      this._requestAndDisplayAnalysis(); 
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
    this._notifySubscribers(); 
  }

  public stopAnalysis(): void {
    logger.info('[AnalysisService] Stopping analysis.');
    this.isActive = false;
    this.isLoadingAnalysis = false; 
    this.currentAnalysisPromiseId++; 

    if (this.analysisTimeoutId) {
      clearTimeout(this.analysisTimeoutId);
      this.analysisTimeoutId = null;
    }
    
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
  }

  private _convertUciToSanForLine(fen: string, pvUci: string[]): { pvSan: string[], initialFullMoveNumber: number, initialTurn: ChessopsColor } {
    const sanMoves: string[] = [];
    let initialFullMoveNumber = 1;
    let initialTurn: ChessopsColor = 'white';

    try {
      const setup = parseFen(fen).unwrap();
      const pos = Chess.fromSetup(setup).unwrap(); 
      initialFullMoveNumber = pos.fullmoves;
      initialTurn = pos.turn;
      
      for (const uciMove of pvUci) {
        const move = parseUci(uciMove);
        if (move) {
          const san = makeSan(pos, move);
          sanMoves.push(san);
          pos.play(move); 
        } else {
          sanMoves.push(uciMove); 
          logger.warn(`[AnalysisService] Failed to parse UCI move for SAN conversion: ${uciMove}`);
          break; 
        }
      }
    } catch (e) {
      logger.error('[AnalysisService] Error converting UCI to SAN for line:', e);
      return { pvSan: pvUci, initialFullMoveNumber: 1, initialTurn: 'white' }; // Fallback
    }
    return { pvSan: sanMoves, initialFullMoveNumber, initialTurn };
  }

  private async _requestAndDisplayAnalysis(): Promise<void> {
    if (!this.isActive || !this.currentFenForAnalysis) {
      logger.warn('[AnalysisService _requestAndDisplayAnalysis] Analysis not active or no FEN. Aborting.');
      if (this.isLoadingAnalysis) { 
          this.isLoadingAnalysis = false;
          this._notifySubscribers();
      }
      return;
    }

    this.currentAnalysisPromiseId++;
    const promiseId = this.currentAnalysisPromiseId;

    if (this.isLoadingAnalysis) {
        logger.warn('[AnalysisService _requestAndDisplayAnalysis] Previous analysis request in progress. Attempting to stop it and start new one.');
        if (this.analysisTimeoutId) {
            clearTimeout(this.analysisTimeoutId);
            this.analysisTimeoutId = null;
        }
    }

    this.isLoadingAnalysis = true;
    this.currentAnalysisLines = null; 
    this._notifySubscribers(); 
    logger.info(`[AnalysisService promiseId: ${promiseId}] Requesting analysis from Stockfish for FEN: ${this.currentFenForAnalysis}`);

    this.boardHandler.clearAllDrawings(); 

    if (this.analysisTimeoutId) { 
        clearTimeout(this.analysisTimeoutId);
    }
    this.analysisTimeoutId = window.setTimeout(() => {
      this.analysisTimeoutId = null; 
      if (this.isLoadingAnalysis && this.currentAnalysisPromiseId === promiseId) { 
          logger.warn(`[AnalysisService promiseId: ${promiseId}] Stockfish analysis request timed out for FEN: ${this.currentFenForAnalysis}`);
          this.isLoadingAnalysis = false;
          this.currentAnalysisLines = [{
              id: 0, depth: 0, score: {type: 'cp', value:0} as ScoreInfo, 
              pvUci: ['timeout'], pvSan: ['таймаут'], 
              startingFen: this.currentFenForAnalysis || '', 
              initialFullMoveNumber: 1, initialTurn: 'white'
          }]; 
          this._notifySubscribers();
      }
    }, ANALYSIS_REQUEST_TIMEOUT);

    try {
      const options: AnalysisOptions = {
        depth: DEFAULT_ANALYSIS_DEPTH,
        lines: DEFAULT_ANALYSIS_LINES,
      };
      const result = await this.stockfishService.getAnalysis(this.currentFenForAnalysis, options);

      if (!this.isActive || this.currentAnalysisPromiseId !== promiseId) { 
        logger.info(`[AnalysisService promiseId: ${promiseId}] Analysis was stopped or superseded while waiting for Stockfish result.`);
        if (this.isLoadingAnalysis && this.currentAnalysisPromiseId === promiseId) this.isLoadingAnalysis = false;
        if(this.analysisTimeoutId && this.currentAnalysisPromiseId === promiseId) clearTimeout(this.analysisTimeoutId); 
        return;
      }
      
      if(this.analysisTimeoutId) clearTimeout(this.analysisTimeoutId); 
      this.analysisTimeoutId = null;

      if (result && result.evaluatedLines && result.evaluatedLines.length > 0 && this.currentFenForAnalysis) {
        const fenForSanConversion = this.currentFenForAnalysis; // FEN перед первым ходом линии
        const linesWithSan: EvaluatedLineWithSan[] = result.evaluatedLines.map(line => {
            const conversionResult = this._convertUciToSanForLine(fenForSanConversion, line.pvUci);
            return {
                ...line,
                pvSan: conversionResult.pvSan,
                startingFen: fenForSanConversion,
                initialFullMoveNumber: conversionResult.initialFullMoveNumber,
                initialTurn: conversionResult.initialTurn,
            };
        });
        this.currentAnalysisLines = linesWithSan;
        logger.info(`[AnalysisService promiseId: ${promiseId}] Analysis received. Best move: ${result.bestMoveUci}. Lines (with SAN):`, this.currentAnalysisLines);
        this._drawAnalysisResult(); 
      } else {
        logger.warn(`[AnalysisService promiseId: ${promiseId}] Stockfish returned no lines or an empty result.`);
        this.currentAnalysisLines = null;
        this.boardHandler.clearAllDrawings(); 
      }
    } catch (error) {
      logger.error(`[AnalysisService promiseId: ${promiseId}] Error getting analysis from Stockfish:`, error);
      if (this.currentAnalysisPromiseId === promiseId) { 
        this.currentAnalysisLines = null;
        if(this.analysisTimeoutId) clearTimeout(this.analysisTimeoutId);
        this.analysisTimeoutId = null;
        this.boardHandler.clearAllDrawings(); 
      }
    } finally {
      if (this.currentAnalysisPromiseId === promiseId) {
        this.isLoadingAnalysis = false;
      }
      this._notifySubscribers();
    }
  }

  private _drawAnalysisResult(): void {
    if (!this.currentAnalysisLines || this.currentAnalysisLines.length === 0) {
      this.boardHandler.clearAllDrawings();
      return;
    }

    const shapesToDraw: CustomDrawShape[] = [];
    this.currentAnalysisLines.slice(0, 3).forEach((line, index) => {
      if (line.pvUci && line.pvUci.length > 0) { 
        const uciMove = line.pvUci[0]; 
        const orig = uciMove.substring(0, 2) as Key;
        const dest = uciMove.substring(2, 4) as Key;
        let brush = ARROW_BRUSHES.bestLine;
        if (index === 1) brush = ARROW_BRUSHES.secondLine;
        if (index === 2) brush = ARROW_BRUSHES.thirdLine;
        
        shapesToDraw.push({ orig, dest, brush });
      }
    });

    this.boardHandler.clearAllDrawings(); 
    if (shapesToDraw.length > 0) {
      this.boardHandler.setDrawableShapes(shapesToDraw);
    }
  }

  private _getNodeByPath(path: string): PgnNode | null {
    const originalPath = this.pgnServiceInstance.getCurrentPath();
    let node: PgnNode | null = null;

    if (originalPath === path) {
        node = this.pgnServiceInstance.getCurrentNode();
    } else { 
        if (this.pgnServiceInstance.navigateToPath(path)) {
            node = this.pgnServiceInstance.getCurrentNode();
        } else {
            logger.warn(`[AnalysisService] _getNodeByPath: Failed to navigate to path ${path} in PgnService.`);
        }
        
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
