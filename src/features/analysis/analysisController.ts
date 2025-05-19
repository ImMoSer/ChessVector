// src/features/analysis/analysisController.ts
import logger from '../../utils/logger';
// Предполагается, что AnalysisOptions, ScoreInfo, EvaluatedLine экспортируются из analysis.service.ts
import type { 
  AnalysisService, 
  AnalysisOptions, 
  ScoreInfo, 
  EvaluatedLine, 
  AnalysisStateForUI, 
  EvaluatedLineWithSan 
} from '../../core/analysis.service';
import type { BoardHandler } from '../../core/boardHandler';
import { PgnService, type PgnNode } from '../../core/pgn.service';
import type { Color as ChessopsColor } from 'chessops/types';
import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';
import { makeSan } from 'chessops/san';
import type { Key } from 'chessground/types';
import type { CustomDrawShape } from '../../core/chessboard.service';
import { t } from '../../core/i18n.service'; // Импорт функции локализации

const DEFAULT_ANALYSIS_DEPTH = 10;
const DEFAULT_ANALYSIS_LINES = 3;
const ANALYSIS_REQUEST_TIMEOUT = 20000; // 20 секунд

const ARROW_BRUSHES = {
  bestLine: 'green',   
  secondLine: 'yellow', 
  thirdLine: 'red',   
};

export class AnalysisController {
  private analysisService: AnalysisService;
  private boardHandler: BoardHandler;
  private pgnServiceInstance: typeof PgnService;
  private requestGlobalRedraw: () => void;

  private isActive: boolean = false;
  private isLoadingAnalysis: boolean = false;
  private currentAnalysisLines: EvaluatedLineWithSan[] | null = null;
  private currentFenForAnalysis: string | null = null;
  private currentAnalysisNodePath: string | null = null;

  private analysisTimeoutId: number | null = null;
  private currentAnalysisPromiseId: number = 0;

  constructor(
    analysisService: AnalysisService,
    boardHandler: BoardHandler,
    pgnServiceInstance: typeof PgnService,
    requestGlobalRedraw: () => void
  ) {
    this.analysisService = analysisService;
    this.boardHandler = boardHandler;
    this.pgnServiceInstance = pgnServiceInstance;
    this.requestGlobalRedraw = requestGlobalRedraw;

    this.boardHandler.onMoveMade(this._handleBoardMoveMade.bind(this));
    this.boardHandler.onPgnNavigated(this._handlePgnNavigated.bind(this));

    logger.info('[AnalysisController] Initialized.');
  }

  public getAnalysisStateForUI(): AnalysisStateForUI {
    return {
      isActive: this.isActive,
      isLoading: this.isLoadingAnalysis,
      lines: this.currentAnalysisLines,
      currentFenAnalyzed: this.currentFenForAnalysis,
    };
  }

  public toggleAnalysis(nodePath?: string): void {
    if (this.isActive) {
      this.stopAnalysis();
    } else {
      this.startAnalysis(nodePath);
    }
  }

  public startAnalysis(nodePath?: string): void {
    if (this.boardHandler.promotionCtrl.isActive()) {
        logger.warn("[AnalysisController] Cannot start analysis during promotion.");
        return;
    }

    logger.info(`[AnalysisController] Attempting to start analysis. Requested nodePath: ${nodePath}`);
    this.isActive = true;
    this.boardHandler.configureBoardForAnalysis(true);

    const pathToAnalyze = nodePath || this.pgnServiceInstance.getCurrentPath();
    this.currentAnalysisNodePath = pathToAnalyze;
    
    const pgnNode = this._getNodeByPath(pathToAnalyze);
    if (pgnNode) {
      this.currentFenForAnalysis = pgnNode.fenAfter;
      logger.info(`[AnalysisController] Starting analysis for PGN Path: ${pathToAnalyze}, FEN: ${this.currentFenForAnalysis}`);
      this._requestAndProcessAnalysis(); 
    } else {
      this.currentFenForAnalysis = this.boardHandler.getFen(); 
      logger.warn(`[AnalysisController] Could not find PGN node for path: ${pathToAnalyze}. Using current board FEN: ${this.currentFenForAnalysis} for initial analysis.`);
      if (this.currentFenForAnalysis) {
         this._requestAndProcessAnalysis();
      } else {
        logger.error('[AnalysisController] Cannot start analysis, no valid FEN found.');
        this.isActive = false; 
        this.boardHandler.configureBoardForAnalysis(false);
      }
    }
    this.requestGlobalRedraw();
  }

  public stopAnalysis(): void {
    logger.info('[AnalysisController] Stopping analysis.');
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
    this.currentFenForAnalysis = null;
    this.currentAnalysisNodePath = null;
    this.requestGlobalRedraw();
  }

  public playMoveFromAnalysisLine(uciMove: string): void {
    if (!this.isActive) {
      logger.warn('[AnalysisController] playMoveFromAnalysisLine called, but analysis is not active.');
      return;
    }
    if (!this.currentAnalysisNodePath) {
        logger.warn('[AnalysisController] playMoveFromAnalysisLine called, but no current PGN node path for analysis context.');
        return;
    }

    logger.info(`[AnalysisController] Applying move from analysis line: ${uciMove} to current node path: ${this.currentAnalysisNodePath}`);
    
    if (this.pgnServiceInstance.getCurrentPath() !== this.currentAnalysisNodePath) {
        this.boardHandler.handleNavigatePgnToPath(this.currentAnalysisNodePath);
    }

    this.boardHandler.applySystemMove(uciMove);
  }

  private _handleBoardMoveMade(data: { newNodePath: string; newFen: string; isVariation: boolean }): void {
    if (!this.isActive) return;

    logger.debug(`[AnalysisController] Received onMoveMade. New path: ${data.newNodePath}. Current analysis path: ${this.currentAnalysisNodePath}`);
    if (data.newNodePath !== this.currentAnalysisNodePath || data.newFen !== this.currentFenForAnalysis || data.isVariation) {
      this.currentAnalysisNodePath = data.newNodePath;
      this.currentFenForAnalysis = data.newFen;
      logger.info(`[AnalysisController] Board move detected. Requesting new analysis for PGN Path: ${this.currentAnalysisNodePath}, FEN: ${this.currentFenForAnalysis}`);
      this._requestAndProcessAnalysis();
    }
  }

  private _handlePgnNavigated(data: { currentNodePath: string; currentFen: string }): void {
    if (!this.isActive) return;

    logger.debug(`[AnalysisController] Received onPgnNavigated. New path: ${data.currentNodePath}. Current analysis path: ${this.currentAnalysisNodePath}`);
    if (data.currentNodePath !== this.currentAnalysisNodePath || data.currentFen !== this.currentFenForAnalysis) {
      this.currentAnalysisNodePath = data.currentNodePath;
      this.currentFenForAnalysis = data.currentFen;
      logger.info(`[AnalysisController] PGN navigation detected. Requesting new analysis for PGN Path: ${this.currentAnalysisNodePath}, FEN: ${this.currentFenForAnalysis}`);
      this._requestAndProcessAnalysis();
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
          logger.warn(`[AnalysisController] Failed to parse UCI move for SAN conversion: ${uciMove}`);
          break; 
        }
      }
    } catch (e: any) {
      logger.error('[AnalysisController] Error converting UCI to SAN for line:', e.message);
      return { pvSan: pvUci, initialFullMoveNumber: 1, initialTurn: 'white' };
    }
    return { pvSan: sanMoves, initialFullMoveNumber, initialTurn };
  }

  private async _requestAndProcessAnalysis(): Promise<void> {
    if (!this.isActive || !this.currentFenForAnalysis) {
      logger.warn('[AnalysisController _requestAndProcessAnalysis] Analysis not active or no FEN. Aborting.');
      if (this.isLoadingAnalysis) { 
          this.isLoadingAnalysis = false;
          this.requestGlobalRedraw();
      }
      return;
    }

    this.currentAnalysisPromiseId++;
    const promiseId = this.currentAnalysisPromiseId;

    if (this.isLoadingAnalysis) {
        logger.warn('[AnalysisController _requestAndProcessAnalysis] Previous analysis request in progress. Current promise will supersede.');
        if (this.analysisTimeoutId) {
            clearTimeout(this.analysisTimeoutId);
            this.analysisTimeoutId = null;
        }
    }

    this.isLoadingAnalysis = true;
    this.currentAnalysisLines = null; 
    this.requestGlobalRedraw(); 
    logger.info(`[AnalysisController promiseId: ${promiseId}] Requesting analysis from Stockfish for FEN: ${this.currentFenForAnalysis}`);

    this.boardHandler.clearAllDrawings(); 

    if (this.analysisTimeoutId) { 
        clearTimeout(this.analysisTimeoutId);
    }
    this.analysisTimeoutId = window.setTimeout(() => {
      this.analysisTimeoutId = null; 
      if (this.isLoadingAnalysis && this.currentAnalysisPromiseId === promiseId) { 
          logger.warn(`[AnalysisController promiseId: ${promiseId}] Stockfish analysis request timed out for FEN: ${this.currentFenForAnalysis}`);
          this.isLoadingAnalysis = false;
          this.currentAnalysisLines = [{
              id: 0, depth: 0, score: {type: 'cp', value:0} as ScoreInfo, 
              pvUci: ['timeout'], pvSan: [t('analysis.timeout')], 
              startingFen: this.currentFenForAnalysis || '', 
              initialFullMoveNumber: 1, initialTurn: 'white'
          }]; 
          this.requestGlobalRedraw();
      }
    }, ANALYSIS_REQUEST_TIMEOUT);

    try {
      const options: AnalysisOptions = {
        depth: DEFAULT_ANALYSIS_DEPTH,
        lines: DEFAULT_ANALYSIS_LINES,
      };
      
      const resultLines: EvaluatedLine[] | null = await this.analysisService.getAnalysis(this.currentFenForAnalysis, options);

      if (!this.isActive || this.currentAnalysisPromiseId !== promiseId) { 
        logger.info(`[AnalysisController promiseId: ${promiseId}] Analysis was stopped or superseded while waiting for Stockfish result.`);
        if (this.isLoadingAnalysis && this.currentAnalysisPromiseId === promiseId) this.isLoadingAnalysis = false;
        if(this.analysisTimeoutId && this.currentAnalysisPromiseId === promiseId) clearTimeout(this.analysisTimeoutId); 
        return;
      }
      
      if(this.analysisTimeoutId) clearTimeout(this.analysisTimeoutId); 
      this.analysisTimeoutId = null;

      if (resultLines && resultLines.length > 0 && this.currentFenForAnalysis) {
        const fenForSanConversion = this.currentFenForAnalysis;
        const linesWithSan: EvaluatedLineWithSan[] = resultLines.map((line: EvaluatedLine) => { // Явная типизация line
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
        logger.info(`[AnalysisController promiseId: ${promiseId}] Analysis received. Lines (with SAN):`, this.currentAnalysisLines);
        this._drawAnalysisResultOnBoard(); 
      } else {
        logger.warn(`[AnalysisController promiseId: ${promiseId}] Stockfish returned no lines or an empty result.`);
        this.currentAnalysisLines = null;
        this.boardHandler.clearAllDrawings(); 
      }
    } catch (error: any) {
      logger.error(`[AnalysisController promiseId: ${promiseId}] Error getting analysis from Stockfish:`, error.message);
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
      this.requestGlobalRedraw();
    }
  }

  private _drawAnalysisResultOnBoard(): void {
    if (!this.isActive || !this.currentAnalysisLines || this.currentAnalysisLines.length === 0) {
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
            logger.warn(`[AnalysisController] _getNodeByPath: Failed to navigate to path ${path} in PgnService.`);
        }
        
        if (this.pgnServiceInstance.getCurrentPath() !== originalPath) {
            if (!this.pgnServiceInstance.navigateToPath(originalPath)) {
                logger.error(`[AnalysisController] _getNodeByPath: Critical error! Failed to navigate back to original path ${originalPath}.`);
            }
        }
    }
    return node;
  }

  public destroy(): void {
    logger.info('[AnalysisController] Destroying AnalysisController instance.');
    this.stopAnalysis();
  }
}
