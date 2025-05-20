// src/features/analysis/analysisController.ts
import logger from '../../utils/logger';
import type {
  AnalysisService,
  AnalysisOptions,
  EvaluatedLine,
  EvaluatedLineWithSan,
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

const DEFAULT_ANALYSIS_DEPTH = 10;
const DEFAULT_ANALYSIS_LINES = 3;
const ANALYSIS_REQUEST_TIMEOUT = 20000;

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
  canRestartTask: boolean; // Remains for game control buttons
  canLoadNextTask: boolean; // Remains for game control buttons
  canSetFen: boolean; // Remains for game control buttons
  currentFenAnalyzed: string | null;
  isGameCurrentlyActive: boolean;
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
  // isCurrentGameActive is managed by FinishHimController and passed via updateGameControlState

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
      canRestartTask: false, // Initialized by FinishHimController
      canLoadNextTask: true,  // Initialized by FinishHimController
      canSetFen: true,        // Initialized by FinishHimController
      currentFenAnalyzed: null,
      isGameCurrentlyActive: false, // Initialized by FinishHimController
    };

    // Subscribe to BoardHandler events to re-trigger analysis if the PGN state changes
    // while analysis is active.
    this.boardHandler.onMoveMade(this._handleBoardOrPgnChange.bind(this));
    this.boardHandler.onPgnNavigated(this._handleBoardOrPgnChange.bind(this));

    logger.info('[AnalysisController] Initialized.');
  }

  public getPanelState(): AnalysisPanelState {
    // Update PGN navigation capabilities directly from PgnService or BoardHandler
    this.panelState.canNavigatePgnBackward = this.boardHandler.canPgnNavigateBackward();
    this.panelState.canNavigatePgnForward = this.boardHandler.canPgnNavigateForward(0);
    this.panelState.currentFenAnalyzed = this.currentFenForAnalysis;
    // isGameCurrentlyActive is updated by FinishHimController via updateGameControlState
    return { ...this.panelState };
  }

  public setGameControlCallbacks(callbacks: GameControlCallbacks): void {
    this.gameControlCallbacks = callbacks;
    logger.info('[AnalysisController] GameControlCallbacks set.');
  }

  public updateGameControlState(state: GameControlState): void {
    logger.debug('[AnalysisController] Updating game control state:', state);
    this.panelState.canRestartTask = state.canRestartTask;
    this.panelState.canLoadNextTask = state.canLoadNextTask;
    this.panelState.isGameCurrentlyActive = state.isGameActive;

    if (state.isGameActive && this.panelState.isAnalysisActive) {
        logger.info('[AnalysisController] Game became active, stopping ongoing analysis.');
        this._internalStopAnalysis(false); // Don't reconfigure board if game is taking over
    }
    this.requestGlobalRedraw();
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
      // If path is empty (root node), get FEN from boardHandler (which gets it from PGN root)
      this.currentFenForAnalysis = this.boardHandler.getFen();
      logger.warn(`[AnalysisController] Could not find PGN node for path: "${pathToAnalyze}". Using current board FEN: ${this.currentFenForAnalysis} for analysis.`);
    }

    this.panelState.currentFenAnalyzed = this.currentFenForAnalysis;

    if (this.currentFenForAnalysis) {
      logger.info(`[AnalysisController] Analysis target: PGN Path: ${this.currentAnalysisNodePath}, FEN: ${this.currentFenForAnalysis}`);
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
    this.currentAnalysisPromiseId++; // Invalidate any ongoing analysis promises

    if (this.analysisTimeoutId) {
      clearTimeout(this.analysisTimeoutId);
      this.analysisTimeoutId = null;
    }

    if (configureBoard) {
        this.boardHandler.configureBoardForAnalysis(false);
    }
    this.boardHandler.clearAllDrawings(); // Clear arrows/circles

    this.panelState.analysisLines = null;
    // PGN nav state will be updated by getPanelState
    this.requestGlobalRedraw();
  }

  private _handleBoardOrPgnChange(data: { currentNodePath?: string; currentFen?: string; newNodePath?: string; newFen?: string }): void {
    if (!this.panelState.isAnalysisActive) return;

    const path = data.currentNodePath || data.newNodePath;
    const fen = data.currentFen || data.newFen;

    if (!path || !fen) {
        logger.warn('[AnalysisController _handleBoardOrPgnChange] Path or FEN missing in event data.');
        return;
    }

    logger.debug(`[AnalysisController] Received onMoveMade/onPgnNavigated. New path: ${path}. Current analysis path: ${this.currentAnalysisNodePath}`);
    // Check if the FEN or the path of the node being analyzed has changed.
    if (path !== this.currentAnalysisNodePath || fen !== this.currentFenForAnalysis) {
      this.currentAnalysisNodePath = path;
      this.currentFenForAnalysis = fen;
      this.panelState.currentFenAnalyzed = this.currentFenForAnalysis;
      logger.info(`[AnalysisController] Board/PGN change detected. Requesting new analysis for PGN Path: ${this.currentAnalysisNodePath}, FEN: ${this.currentFenForAnalysis}`);
      this._requestAndProcessAnalysis(); // This will also redraw
    } else {
      this.requestGlobalRedraw(); // Redraw to update PGN nav buttons if only their state changed
    }
  }

  private async _requestAndProcessAnalysis(): Promise<void> {
    if (!this.panelState.isAnalysisActive || !this.currentFenForAnalysis) {
      logger.warn('[AnalysisController _requestAndProcessAnalysis] Analysis not active or no FEN. Aborting.');
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
        if (this.analysisTimeoutId) { // Clear previous timeout if any
            clearTimeout(this.analysisTimeoutId);
            this.analysisTimeoutId = null;
        }
    }

    this.panelState.isAnalysisLoading = true;
    this.panelState.analysisLines = null; // Clear previous lines
    this.panelState.currentFenAnalyzed = this.currentFenForAnalysis; // Ensure this is set
    this.requestGlobalRedraw(); // Show loading state
    logger.info(`[AnalysisController promiseId: ${promiseId}] Requesting analysis from Stockfish for FEN: ${this.currentFenForAnalysis}`);

    this.boardHandler.clearAllDrawings(); // Clear previous drawings

    // Set a new timeout for the current request
    this.analysisTimeoutId = window.setTimeout(() => {
      this.analysisTimeoutId = null; // Clear the ID once the timeout function runs
      if (this.panelState.isAnalysisLoading && this.currentAnalysisPromiseId === promiseId) {
          logger.warn(`[AnalysisController promiseId: ${promiseId}] Stockfish analysis request timed out for FEN: ${this.currentFenForAnalysis}`);
          this.panelState.isAnalysisLoading = false;
          this.panelState.analysisLines = [{ // Provide a timeout message object
              id: 0, depth: 0, score: {type: 'cp', value:0}, // Dummy score
              pvUci: ['timeout'], pvSan: [t('analysis.timeout')], // Special values for timeout
              startingFen: this.currentFenForAnalysis || '', // FEN that was being analyzed
              initialFullMoveNumber: 1, initialTurn: 'white' // Dummy values
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

      // Check if analysis is still active and this is the latest promise
      if (!this.panelState.isAnalysisActive || this.currentAnalysisPromiseId !== promiseId) {
        logger.info(`[AnalysisController promiseId: ${promiseId}] Analysis was stopped or superseded while waiting for Stockfish result.`);
        // If this specific promise timed out, its timeoutId would be null already.
        // If a newer promise started, its timeoutId would be different.
        // We only clear the timeout if it belongs to *this* promise and is still pending.
        if(this.analysisTimeoutId && this.currentAnalysisPromiseId === promiseId) clearTimeout(this.analysisTimeoutId);
        if (this.panelState.isAnalysisLoading && this.currentAnalysisPromiseId === promiseId) this.panelState.isAnalysisLoading = false; // Only update if this was the one loading
        return; // Do not process stale results
      }

      // Clear the timeout if the request completed successfully before timeout
      if(this.analysisTimeoutId) clearTimeout(this.analysisTimeoutId);
      this.analysisTimeoutId = null;

      if (resultLines && resultLines.length > 0 && this.currentFenForAnalysis) {
        const fenForSanConversion = this.currentFenForAnalysis; // Ensure we use the FEN that was analyzed
        const linesWithSan: EvaluatedLineWithSan[] = resultLines.map((line: EvaluatedLine) => {
            const conversionResult = this._convertUciToSanForLine(fenForSanConversion, line.pvUci);
            return {
                ...line,
                pvSan: conversionResult.pvSan,
                startingFen: fenForSanConversion, // Store the FEN used for this line's SAN conversion
                initialFullMoveNumber: conversionResult.initialFullMoveNumber,
                initialTurn: conversionResult.initialTurn,
            };
        });
        this.panelState.analysisLines = linesWithSan;
        logger.info(`[AnalysisController promiseId: ${promiseId}] Analysis received. Lines (with SAN):`, this.panelState.analysisLines);
        this._drawAnalysisResultOnBoard();
      } else {
        logger.warn(`[AnalysisController promiseId: ${promiseId}] Stockfish returned no lines or an empty result.`);
        this.panelState.analysisLines = null;
        this.boardHandler.clearAllDrawings(); // Clear drawings if no results
      }
    } catch (error: any) {
      logger.error(`[AnalysisController promiseId: ${promiseId}] Error getting analysis from Stockfish:`, error.message);
      if (this.currentAnalysisPromiseId === promiseId) { // Only if this promise caused the error
        this.panelState.analysisLines = null;
        if(this.analysisTimeoutId) clearTimeout(this.analysisTimeoutId); // Clear timeout on error too
        this.analysisTimeoutId = null;
        this.boardHandler.clearAllDrawings();
      }
    } finally {
      // Only set loading to false if this is the promise that was active
      if (this.currentAnalysisPromiseId === promiseId) {
        this.panelState.isAnalysisLoading = false;
      }
      // PGN nav state will be updated by getPanelState before next redraw
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
          pos.play(move); // Play the move on the cloned position to get correct SAN for subsequent moves
        } else {
          sanMoves.push(uciMove); // Fallback for unparsable UCI (should not happen for valid Stockfish PV)
          logger.warn(`[AnalysisController] Failed to parse UCI move for SAN conversion: ${uciMove}`);
          break; // Stop conversion for this line if a move is invalid
        }
      }
    } catch (e: any) {
      logger.error('[AnalysisController] Error converting UCI to SAN for line:', e.message);
      // Return UCI moves as SAN in case of error to still display something
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
    // Draw arrows for the top N lines (e.g., 3 lines)
    this.panelState.analysisLines.slice(0, 3).forEach((line, index) => {
      if (line.pvUci && line.pvUci.length > 0) {
        const uciMove = line.pvUci[0];
        const orig = uciMove.substring(0, 2) as Key;
        const dest = uciMove.substring(2, 4) as Key;
        let brush = ARROW_BRUSHES.bestLine; // Default to best line
        if (index === 1) brush = ARROW_BRUSHES.secondLine;
        if (index === 2) brush = ARROW_BRUSHES.thirdLine;

        shapesToDraw.push({ orig, dest, brush });
      }
    });

    this.boardHandler.clearAllDrawings(); // Clear previous shapes first
    if (shapesToDraw.length > 0) {
      this.boardHandler.setDrawableShapes(shapesToDraw);
    }
  }

  private _getNodeByPath(path: string): PgnNode | null {
    // If the path is empty, it refers to the root node's state (initial FEN).
    if (path === "") {
        return this.pgnServiceInstance.getRootNode();
    }

    const originalPath = this.pgnServiceInstance.getCurrentPath();
    let node: PgnNode | null = null;

    // Temporarily navigate PgnService to the target path to get the node
    if (this.pgnServiceInstance.navigateToPath(path)) {
        node = this.pgnServiceInstance.getCurrentNode();
    } else {
        logger.warn(`[AnalysisController] _getNodeByPath: Failed to navigate to path ${path} in PgnService.`);
    }

    // Restore PgnService to its original path if it was changed
    if (this.pgnServiceInstance.getCurrentPath() !== originalPath) {
        if (!this.pgnServiceInstance.navigateToPath(originalPath)) {
            // This would be a critical issue if restoration fails.
            logger.error(`[AnalysisController] _getNodeByPath: Critical error! Failed to navigate back to original path ${originalPath}.`);
        }
    }
    return node;
  }

  // --- PGN Navigation Methods ---
  public pgnNavigateToStart(): void {
    if (!this.panelState.isAnalysisActive) {
        logger.warn("[AnalysisController] pgnNavigateToStart: Analysis not active.");
        return;
    }
    this.boardHandler.handleNavigatePgnToStart();
    // _handleBoardOrPgnChange will be triggered by the onPgnNavigated event from boardHandler
  }

  public pgnNavigateBackward(): void {
    if (!this.panelState.isAnalysisActive) {
        logger.warn("[AnalysisController] pgnNavigateBackward: Analysis not active.");
        return;
    }
    this.boardHandler.handleNavigatePgnBackward();
    // _handleBoardOrPgnChange will be triggered
  }

  public pgnNavigateForward(variationIndex: number = 0): void {
    if (!this.panelState.isAnalysisActive) {
        logger.warn("[AnalysisController] pgnNavigateForward: Analysis not active.");
        return;
    }
    this.boardHandler.handleNavigatePgnForward(variationIndex);
    // _handleBoardOrPgnChange will be triggered
  }

  public pgnNavigateToEnd(): void {
    if (!this.panelState.isAnalysisActive) {
        logger.warn("[AnalysisController] pgnNavigateToEnd: Analysis not active.");
        return;
    }
    this.boardHandler.handleNavigatePgnToEnd();
    // _handleBoardOrPgnChange will be triggered
  }

  // --- Game Control Callbacks ---
  // These are called by the UI (via AnalysisPanelView -> this controller)
  // and then forwarded to FinishHimController.
  public requestNextTask(): void {
    if (this.gameControlCallbacks?.onNextTaskRequested) {
      logger.info('[AnalysisController] Requesting next task from GameController (via FinishHim).');
      if (this.panelState.isAnalysisActive) { // Stop analysis before loading new task
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
      if (this.panelState.isAnalysisActive) { // Stop analysis before restarting
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
      if (this.panelState.isAnalysisActive) { // Stop analysis before setting new FEN
        this._internalStopAnalysis(true);
      }
      this.gameControlCallbacks.onSetFenRequested();
    } else {
      logger.warn('[AnalysisController] onSetFenRequested callback is not set.');
    }
  }
  
  public playMoveFromAnalysisLine(uciMove: string): void {
    if (!this.panelState.isAnalysisActive) {
      logger.warn('[AnalysisController] playMoveFromAnalysisLine called, but analysis is not active.');
      return;
    }
    if (!this.currentAnalysisNodePath) { // currentAnalysisNodePath can be "" for root
        logger.warn('[AnalysisController] playMoveFromAnalysisLine called, but no current PGN node path for analysis context.');
        return;
    }

    logger.info(`[AnalysisController] Applying move from analysis line: ${uciMove} to current node path: "${this.currentAnalysisNodePath}"`);

    // Ensure BoardHandler is at the correct PGN state before applying the move
    if (this.pgnServiceInstance.getCurrentPath() !== this.currentAnalysisNodePath) {
        this.boardHandler.handleNavigatePgnToPath(this.currentAnalysisNodePath);
    }
    
    // Apply the move. This will trigger onMoveMade, which in turn calls _handleBoardOrPgnChange,
    // leading to a new analysis request for the new position.
    this.boardHandler.applySystemMove(uciMove);
    // No need to call requestGlobalRedraw here as applySystemMove -> onMoveMade -> _handleBoardOrPgnChange -> requestGlobalRedraw
  }

  public destroy(): void {
    logger.info('[AnalysisController] Destroying AnalysisController instance.');
    this._internalStopAnalysis(false); // Stop analysis without reconfiguring board (AppController might do that)
    // Unsubscribe from BoardHandler events if needed, but usually BoardHandler is destroyed with the page.
    // If AnalysisController can outlive BoardHandler, explicit unsubscription would be needed.
  }
}
