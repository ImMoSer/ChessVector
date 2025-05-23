// src/features/analysis/analysisController.ts
import logger from '../../utils/logger';
import type {
  AnalysisService,
  AnalysisOptions,
  EvaluatedLine,
  EvaluatedLineWithSan,
  // ScoreInfo, // Удалено, так как не используется напрямую здесь, а только в EvaluatedLineWithSan
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
import { t } from '../../core/i18n.service';

const DEFAULT_ANALYSIS_DEPTH = 15; 
const DEFAULT_ANALYSIS_LINES = 3;
const ANALYSIS_REQUEST_TIMEOUT = 30000; 

const ARROW_BRUSHES = {
  bestLine: 'green',
  secondLine: 'yellow',
  thirdLine: 'red',
};

export interface AnalysisPanelState {
  isAnalysisActive: boolean;
  isAnalysisLoading: boolean;
  analysisLines: EvaluatedLineWithSan[] | null;
  canNavigatePgnBackward: boolean;
  canNavigatePgnForward: boolean;
  canRestartTask: boolean;
  canLoadNextTask: boolean;
  canSetFen: boolean;
  currentFenAnalyzed: string | null;
  isGameCurrentlyActive: boolean;
  currentTurnForAnalysis: ChessopsColor | null; 
}

export interface GameControlCallbacks {
  onNextTaskRequested: () => void;
  onRestartTaskRequested: () => void;
  onSetFenRequested: () => void;
  onStopGameRequested: () => void;
}

export interface GameControlState {
  canRestartTask: boolean;
  canLoadNextTask: boolean;
  isGameActive: boolean;
}

export class AnalysisController {
  private analysisService: AnalysisService;
  private boardHandler: BoardHandler;
  private pgnServiceInstance: typeof PgnService;
  private requestGlobalRedraw: () => void;

  private panelState: AnalysisPanelState;
  private gameControlCallbacks: GameControlCallbacks | null = null;
  private currentFenForAnalysis: string | null = null;
  private currentAnalysisNodePath: string | null = null;
  private analysisTimeoutId: number | null = null;
  private currentAnalysisPromiseId: number = 0;

  constructor(
    analysisService: AnalysisService,
    boardHandler: BoardHandler,
    pgnServiceInstance: typeof PgnService,
    requestGlobalRedraw: () => void,
  ) {
    this.analysisService = analysisService;
    this.boardHandler = boardHandler;
    this.pgnServiceInstance = pgnServiceInstance;
    this.requestGlobalRedraw = requestGlobalRedraw;

    this.panelState = {
      isAnalysisActive: false,
      isAnalysisLoading: false,
      analysisLines: null,
      canNavigatePgnBackward: this.pgnServiceInstance.canNavigateBackward(),
      canNavigatePgnForward: this.pgnServiceInstance.canNavigateForward(0),
      canRestartTask: false,
      canLoadNextTask: true,
      canSetFen: true,
      currentFenAnalyzed: null,
      isGameCurrentlyActive: false,
      currentTurnForAnalysis: null, 
    };

    this.boardHandler.onMoveMade(this._handleBoardOrPgnChange.bind(this));
    this.boardHandler.onPgnNavigated(this._handleBoardOrPgnChange.bind(this));

    logger.info('[AnalysisController] Initialized.');
  }

  public getPanelState(): AnalysisPanelState {
    if (this.panelState.isGameCurrentlyActive) {
      this.panelState.canNavigatePgnBackward = false;
      this.panelState.canNavigatePgnForward = false;
    } else {
      this.panelState.canNavigatePgnBackward = this.panelState.isAnalysisActive && this.boardHandler.canPgnNavigateBackward();
      this.panelState.canNavigatePgnForward = this.panelState.isAnalysisActive && this.boardHandler.canPgnNavigateForward(0);
    }
    this.panelState.currentFenAnalyzed = this.currentFenForAnalysis;
    
    if (this.currentFenForAnalysis) {
        try {
            const setup = parseFen(this.currentFenForAnalysis).unwrap();
            this.panelState.currentTurnForAnalysis = setup.turn;
        } catch (e) {
            logger.warn(`[AnalysisController getPanelState] Could not parse FEN ${this.currentFenForAnalysis} to determine turn.`);
            this.panelState.currentTurnForAnalysis = null;
        }
    } else {
        this.panelState.currentTurnForAnalysis = null;
    }

    return { ...this.panelState };
  }

  public setGameControlCallbacks(callbacks: GameControlCallbacks): void {
    this.gameControlCallbacks = callbacks;
    logger.info('[AnalysisController] GameControlCallbacks set.');
  }

  public updateGameControlState(state: GameControlState): void {
    logger.debug('[AnalysisController] Updating game control state:', state);
    const oldIsGameActive = this.panelState.isGameCurrentlyActive;
    this.panelState.canRestartTask = state.canRestartTask;
    this.panelState.canLoadNextTask = state.canLoadNextTask;
    this.panelState.isGameCurrentlyActive = state.isGameActive;

    if (state.isGameActive && this.panelState.isAnalysisActive) {
        logger.info('[AnalysisController] Game became active, stopping ongoing analysis.');
        this._internalStopAnalysis(false);
    }
    if (oldIsGameActive !== state.isGameActive) {
        this.requestGlobalRedraw(); 
    } else {
        this.requestGlobalRedraw(); 
    }
  }

  public toggleAnalysisEngine(): void {
    if (this.boardHandler.promotionCtrl.isActive()) {
      logger.warn("[AnalysisController] Cannot toggle button during promotion.");
      return;
    }

    if (this.panelState.isGameCurrentlyActive) {
      if (this.gameControlCallbacks?.onStopGameRequested) {
        logger.info('[AnalysisController] "Resign" clicked (via toggleAnalysisEngine). Requesting game stop.');
        this.gameControlCallbacks.onStopGameRequested();
      } else {
        logger.warn('[AnalysisController] "Resign" clicked, but onStopGameRequested callback is not set.');
      }
    } else {
      if (this.panelState.isAnalysisActive) {
        this._internalStopAnalysis(true);
      } else {
        this._internalStartAnalysis();
      }
    }
  }

  private _internalStartAnalysis(nodePath?: string): void {
    if (this.boardHandler.promotionCtrl.isActive()) {
        logger.warn("[AnalysisController] Cannot start analysis during promotion.");
        return;
    }
    if (this.panelState.isGameCurrentlyActive) {
        logger.warn("[AnalysisController] Attempted to start analysis while game is still active. Aborting.");
        return;
    }

    logger.info(`[AnalysisController] Starting analysis internally. Requested nodePath: ${nodePath}`);
    this.panelState.isAnalysisActive = true;
    this.boardHandler.configureBoardForAnalysis(true);

    const pathToAnalyze = nodePath || this.pgnServiceInstance.getCurrentPath();
    this.currentAnalysisNodePath = pathToAnalyze;

    const pgnNode = this._getNodeByPath(pathToAnalyze);
    if (pgnNode) {
      this.currentFenForAnalysis = pgnNode.fenAfter;
    } else {
      this.currentFenForAnalysis = this.boardHandler.getFen();
      logger.warn(`[AnalysisController] Could not find PGN node for path: "${pathToAnalyze}". Using current board FEN: ${this.currentFenForAnalysis} for analysis.`);
    }

    this.panelState.currentFenAnalyzed = this.currentFenForAnalysis;
    if (this.currentFenForAnalysis) {
        try {
            const setup = parseFen(this.currentFenForAnalysis).unwrap();
            this.panelState.currentTurnForAnalysis = setup.turn;
        } catch (e) {
            logger.warn(`[AnalysisController _internalStartAnalysis] Could not parse FEN ${this.currentFenForAnalysis} to determine turn.`);
            this.panelState.currentTurnForAnalysis = null;
        }
    } else {
        this.panelState.currentTurnForAnalysis = null;
    }


    if (this.currentFenForAnalysis) {
      logger.info(`[AnalysisController] Analysis target: PGN Path: ${this.currentAnalysisNodePath}, FEN: ${this.currentFenForAnalysis}, Turn: ${this.panelState.currentTurnForAnalysis}`);
      this._requestAndProcessAnalysis();
    } else {
      logger.error('[AnalysisController] Cannot start analysis, no valid FEN found.');
      this.panelState.isAnalysisActive = false;
      this.boardHandler.configureBoardForAnalysis(false);
    }
    this.requestGlobalRedraw();
  }

  private _internalStopAnalysis(configureBoard: boolean): void {
    logger.info('[AnalysisController] Stopping analysis internally.');
    this.panelState.isAnalysisActive = false;
    this.panelState.isAnalysisLoading = false;
    this.currentAnalysisPromiseId++; 

    if (this.analysisTimeoutId) {
      clearTimeout(this.analysisTimeoutId);
      this.analysisTimeoutId = null;
    }

    if (configureBoard) {
        this.boardHandler.configureBoardForAnalysis(false);
    }
    this.boardHandler.clearAllDrawings(); 

    this.panelState.analysisLines = null;
    this.panelState.currentTurnForAnalysis = null; 
    this.requestGlobalRedraw();
  }

  private _handleBoardOrPgnChange(data: { currentNodePath?: string; currentFen?: string; newNodePath?: string; newFen?: string }): void {
    if (!this.panelState.isAnalysisActive) {
        this.requestGlobalRedraw();
        return;
    }

    const path = data.currentNodePath || data.newNodePath;
    const fen = data.currentFen || data.newFen;

    if (path === undefined || fen === undefined) { 
        logger.warn('[AnalysisController _handleBoardOrPgnChange] Path or FEN missing in event data.');
        this.requestGlobalRedraw(); 
        return;
    }

    logger.debug(`[AnalysisController] Received onMoveMade/onPgnNavigated. New path: "${path}". Current analysis path: "${this.currentAnalysisNodePath}"`);
    if (path !== this.currentAnalysisNodePath || fen !== this.currentFenForAnalysis) {
      this.currentAnalysisNodePath = path;
      this.currentFenForAnalysis = fen;
      this.panelState.currentFenAnalyzed = this.currentFenForAnalysis;
        if (this.currentFenForAnalysis) {
            try {
                const setup = parseFen(this.currentFenForAnalysis).unwrap();
                this.panelState.currentTurnForAnalysis = setup.turn;
            } catch (e) {
                logger.warn(`[AnalysisController _handleBoardOrPgnChange] Could not parse FEN ${this.currentFenForAnalysis} to determine turn.`);
                this.panelState.currentTurnForAnalysis = null;
            }
        } else {
            this.panelState.currentTurnForAnalysis = null;
        }
      logger.info(`[AnalysisController] Board/PGN change detected. Requesting new analysis for PGN Path: "${this.currentAnalysisNodePath}", FEN: ${this.currentFenForAnalysis}, Turn: ${this.panelState.currentTurnForAnalysis}`);
      this._requestAndProcessAnalysis(); 
    } else {
      this.requestGlobalRedraw(); 
    }
  }

  private async _requestAndProcessAnalysis(): Promise<void> {
    if (!this.panelState.isAnalysisActive || !this.currentFenForAnalysis || this.panelState.isGameCurrentlyActive) {
      logger.warn(`[AnalysisController _requestAndProcessAnalysis] Analysis not active, no FEN, or game is active. Aborting. isAnalysisActive: ${this.panelState.isAnalysisActive}, currentFenForAnalysis: ${!!this.currentFenForAnalysis}, isGameCurrentlyActive: ${this.panelState.isGameCurrentlyActive}`);
      if (this.panelState.isAnalysisLoading) {
          this.panelState.isAnalysisLoading = false;
          this.requestGlobalRedraw();
      }
      return;
    }

    this.currentAnalysisPromiseId++;
    const promiseId = this.currentAnalysisPromiseId;

    if (this.panelState.isAnalysisLoading) {
        logger.warn('[AnalysisController _requestAndProcessAnalysis] Previous analysis request in progress. Current promise will supersede.');
        if (this.analysisTimeoutId) { 
            clearTimeout(this.analysisTimeoutId);
            this.analysisTimeoutId = null;
        }
    }

    this.panelState.isAnalysisLoading = true;
    this.panelState.analysisLines = null; 
    this.panelState.currentFenAnalyzed = this.currentFenForAnalysis; 
    if (this.currentFenForAnalysis) {
        try {
            const setup = parseFen(this.currentFenForAnalysis).unwrap();
            this.panelState.currentTurnForAnalysis = setup.turn;
        } catch (e) {
            logger.warn(`[AnalysisController _requestAndProcessAnalysis] Could not parse FEN ${this.currentFenForAnalysis} to determine turn.`);
            this.panelState.currentTurnForAnalysis = null;
        }
    } else {
        this.panelState.currentTurnForAnalysis = null;
    }
    this.requestGlobalRedraw(); 
    logger.info(`[AnalysisController promiseId: ${promiseId}] Requesting analysis from Stockfish for FEN: ${this.currentFenForAnalysis}, Turn: ${this.panelState.currentTurnForAnalysis}`);

    this.boardHandler.clearAllDrawings(); 

    this.analysisTimeoutId = window.setTimeout(() => {
      this.analysisTimeoutId = null; 
      if (this.panelState.isAnalysisLoading && this.currentAnalysisPromiseId === promiseId) {
          logger.warn(`[AnalysisController promiseId: ${promiseId}] Stockfish analysis request timed out for FEN: ${this.currentFenForAnalysis}`);
          this.panelState.isAnalysisLoading = false;
          this.panelState.analysisLines = [{ 
              id: 0, depth: 0, score: {type: 'cp', value:0}, 
              pvUci: ['timeout'], pvSan: [t('analysis.timeout')], 
              startingFen: this.currentFenForAnalysis || '', 
              initialFullMoveNumber: 1, initialTurn: this.panelState.currentTurnForAnalysis || 'white' 
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

      if (!this.panelState.isAnalysisActive || this.currentAnalysisPromiseId !== promiseId) {
        logger.info(`[AnalysisController promiseId: ${promiseId}] Analysis was stopped or superseded while waiting for Stockfish result.`);
        if(this.analysisTimeoutId && this.currentAnalysisPromiseId === promiseId) clearTimeout(this.analysisTimeoutId);
        if (this.panelState.isAnalysisLoading && this.currentAnalysisPromiseId === promiseId) this.panelState.isAnalysisLoading = false; 
        return; 
      }

      if(this.analysisTimeoutId) clearTimeout(this.analysisTimeoutId);
      this.analysisTimeoutId = null;

      if (resultLines && resultLines.length > 0 && this.currentFenForAnalysis) {
        const fenForSanConversion = this.currentFenForAnalysis; 
        const linesWithSan: EvaluatedLineWithSan[] = resultLines.map((line: EvaluatedLine) => {
            const conversionResult = this._convertUciToSanForLine(fenForSanConversion, line.pvUci);
            let correctedScore = line.score;
            if (this.panelState.currentTurnForAnalysis === 'black' && line.score.type === 'cp') {
                correctedScore = { ...line.score, value: -line.score.value };
            } else if (this.panelState.currentTurnForAnalysis === 'black' && line.score.type === 'mate') {
                correctedScore = { ...line.score, value: -line.score.value };
            }

            return {
                ...line,
                score: correctedScore, 
                pvSan: conversionResult.pvSan,
                startingFen: fenForSanConversion, 
                initialFullMoveNumber: conversionResult.initialFullMoveNumber,
                initialTurn: conversionResult.initialTurn,
            };
        });
        this.panelState.analysisLines = linesWithSan;
        logger.info(`[AnalysisController promiseId: ${promiseId}] Analysis received. Lines (with SAN and corrected score):`, this.panelState.analysisLines);
        this._drawAnalysisResultOnBoard();
      } else {
        logger.warn(`[AnalysisController promiseId: ${promiseId}] Stockfish returned no lines or an empty result.`);
        this.panelState.analysisLines = null;
        this.boardHandler.clearAllDrawings(); 
      }
    } catch (error: any) {
      logger.error(`[AnalysisController promiseId: ${promiseId}] Error getting analysis from Stockfish:`, error.message);
      if (this.currentAnalysisPromiseId === promiseId) { 
        this.panelState.analysisLines = null;
        if(this.analysisTimeoutId) clearTimeout(this.analysisTimeoutId); 
        this.analysisTimeoutId = null;
        this.boardHandler.clearAllDrawings();
      }
    } finally {
      if (this.currentAnalysisPromiseId === promiseId) {
        this.panelState.isAnalysisLoading = false;
      }
      this.requestGlobalRedraw();
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

  private _drawAnalysisResultOnBoard(): void {
    if (!this.panelState.isAnalysisActive || !this.panelState.analysisLines || this.panelState.analysisLines.length === 0) {
      this.boardHandler.clearAllDrawings();
      return;
    }

    const shapesToDraw: CustomDrawShape[] = [];
    this.panelState.analysisLines.slice(0, 3).forEach((line, index) => {
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
    if (path === "") {
        return this.pgnServiceInstance.getRootNode();
    }

    const originalPath = this.pgnServiceInstance.getCurrentPath();
    let node: PgnNode | null = null;

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
    return node;
  }

  public pgnNavigateToStart(): void {
    if (this.panelState.isGameCurrentlyActive) {
        logger.warn("[AnalysisController] pgnNavigateToStart: Game is active. Navigation blocked.");
        return;
    }
    if (!this.panelState.isAnalysisActive) {
        logger.warn("[AnalysisController] pgnNavigateToStart: Analysis not active.");
        return;
    }
    this.boardHandler.handleNavigatePgnToStart();
  }

  public pgnNavigateBackward(): void {
    if (this.panelState.isGameCurrentlyActive) {
        logger.warn("[AnalysisController] pgnNavigateBackward: Game is active. Navigation blocked.");
        return;
    }
    if (!this.panelState.isAnalysisActive) {
        logger.warn("[AnalysisController] pgnNavigateBackward: Analysis not active.");
        return;
    }
    this.boardHandler.handleNavigatePgnBackward();
  }

  public pgnNavigateForward(variationIndex: number = 0): void {
    if (this.panelState.isGameCurrentlyActive) {
        logger.warn("[AnalysisController] pgnNavigateForward: Game is active. Navigation blocked.");
        return;
    }
    if (!this.panelState.isAnalysisActive) {
        logger.warn("[AnalysisController] pgnNavigateForward: Analysis not active.");
        return;
    }
    this.boardHandler.handleNavigatePgnForward(variationIndex);
  }

  public pgnNavigateToEnd(): void {
    if (this.panelState.isGameCurrentlyActive) {
        logger.warn("[AnalysisController] pgnNavigateToEnd: Game is active. Navigation blocked.");
        return;
    }
    if (!this.panelState.isAnalysisActive) {
        logger.warn("[AnalysisController] pgnNavigateToEnd: Analysis not active.");
        return;
    }
    this.boardHandler.handleNavigatePgnToEnd();
  }

  public requestNextTask(): void {
    if (this.gameControlCallbacks?.onNextTaskRequested) {
      logger.info('[AnalysisController] Requesting next task from GameController (via FinishHim).');
      if (this.panelState.isAnalysisActive) { 
        this._internalStopAnalysis(true);
      }
      this.gameControlCallbacks.onNextTaskRequested();
    } else {
      logger.warn('[AnalysisController] onNextTaskRequested callback is not set.');
    }
  }

  public requestRestartTask(): void {
    if (this.gameControlCallbacks?.onRestartTaskRequested) {
      logger.info('[AnalysisController] Requesting restart task from GameController (via FinishHim).');
      if (this.panelState.isAnalysisActive) { 
        this._internalStopAnalysis(true);
      }
      this.gameControlCallbacks.onRestartTaskRequested();
    } else {
      logger.warn('[AnalysisController] onRestartTaskRequested callback is not set.');
    }
  }

  public requestSetFen(): void {
    if (this.gameControlCallbacks?.onSetFenRequested) {
      logger.info('[AnalysisController] Requesting set FEN from GameController (via FinishHim).');
      if (this.panelState.isAnalysisActive) { 
        this._internalStopAnalysis(true);
      }
      this.gameControlCallbacks.onSetFenRequested();
    } else {
      logger.warn('[AnalysisController] onSetFenRequested callback is not set.');
    }
  }
  
  public playMoveFromAnalysisLine(uciMove: string): void {
    if (this.panelState.isGameCurrentlyActive) {
        logger.warn("[AnalysisController] playMoveFromAnalysisLine: Game is active. Action blocked.");
        return;
    }
    if (!this.panelState.isAnalysisActive) {
      logger.warn('[AnalysisController] playMoveFromAnalysisLine called, but analysis is not active.');
      return;
    }
    if (this.currentAnalysisNodePath === null || this.currentAnalysisNodePath === undefined) { 
        logger.warn('[AnalysisController] playMoveFromAnalysisLine called, but no current PGN node path for analysis context.');
        return;
    }

    logger.info(`[AnalysisController] Applying move from analysis line: ${uciMove} to current node path: "${this.currentAnalysisNodePath}"`);

    if (this.pgnServiceInstance.getCurrentPath() !== this.currentAnalysisNodePath) {
        this.boardHandler.handleNavigatePgnToPath(this.currentAnalysisNodePath);
    }
    
    this.boardHandler.applySystemMove(uciMove);
  }

  public destroy(): void {
    logger.info('[AnalysisController] Destroying AnalysisController instance.');
    this._internalStopAnalysis(false); 
  }
}
