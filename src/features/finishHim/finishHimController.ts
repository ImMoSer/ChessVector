// src/features/finishHim/finishHimController.ts
import type { Key } from 'chessground/types';
import type { ChessboardService } from '../../core/chessboard.service';
import type { WebhookService, AppPuzzle, PuzzleRequestPayload } from '../../core/webhook.service';
import type { StockfishService } from '../../core/stockfish.service';
import { BoardHandler } from '../../core/boardHandler';
import type { GameStatus, GameEndOutcome, AttemptMoveResult } from '../../core/boardHandler';
import type {
  AnalysisController,
  GameControlCallbacks,
  GameControlState,
} from '../analysis/analysisController';
import logger from '../../utils/logger';
import { SoundService } from '../../core/sound.service';
import { t } from '../../core/i18n.service';
import type { FinishHimPuzzleType } from './finishHim.types';
import { FINISH_HIM_PUZZLE_TYPES } from './finishHim.types';
import { AuthService, type FinishHimStats } from '../../core/auth.service';

const OUTPLAY_TIMER_DURATION_MS = 60000; // 60 seconds for playout

interface FinishHimControllerState {
  activePuzzle: AppPuzzle | null;
  interactiveSetupMoves: string[];
  currentInteractiveSetupMoveIndex: number;
  activePuzzleType: FinishHimPuzzleType;
  userStats: FinishHimStats | null;
  isUserTurnContext: boolean;
  feedbackMessage: string;
  isInPlayoutMode: boolean;
  isStockfishThinking: boolean;
  gameOverMessage: string | null;
  currentPgnString: string;
  currentTaskPieceCount: number;
  isGameEffectivelyActive: boolean;
  outplayTimerId: number | null;
  outplayTimeRemainingMs: number | null;
}

export class FinishHimController {
  public state: FinishHimControllerState;
  public boardHandler: BoardHandler;
  public analysisController: AnalysisController;
  private authService: typeof AuthService;
  private webhookService: WebhookService;
  private stockfishService: StockfishService;

  private readonly defaultUserRating = 1200;
  private readonly defaultUserPieceCount = 10;

  constructor(
    public chessboardService: ChessboardService,
    boardHandler: BoardHandler,
    authService: typeof AuthService,
    webhookService: WebhookService,
    stockfishService: StockfishService,
    analysisController: AnalysisController,
    public requestRedraw: () => void,
  ) {
    this.boardHandler = boardHandler;
    this.authService = authService;
    this.webhookService = webhookService;
    this.stockfishService = stockfishService;
    this.analysisController = analysisController;

    const initialStats = this.authService.getFinishHimStats();
    if (!initialStats && this.authService.getIsAuthenticated()) {
        logger.error("[FinishHimController] CRITICAL: FinishHimStats not available from AuthService on init for an authenticated user.");
    }

    this.state = {
      activePuzzle: null,
      interactiveSetupMoves: [],
      currentInteractiveSetupMoveIndex: 0,
      activePuzzleType: FINISH_HIM_PUZZLE_TYPES[0],
      userStats: initialStats,
      isUserTurnContext: false,
      feedbackMessage: t('finishHim.feedback.selectCategoryAndStart'),
      isInPlayoutMode: false,
      isStockfishThinking: false,
      gameOverMessage: null,
      currentPgnString: "",
      currentTaskPieceCount: 0,
      isGameEffectivelyActive: false,
      outplayTimerId: null,
      outplayTimeRemainingMs: null,
    };

    this._registerGameCallbacksWithAnalysisController();

    this.boardHandler.onMoveMade(() => {
        this._updatePgnDisplay();
        this._updateAnalysisControllerGameState();
    });
    this.boardHandler.onPgnNavigated(() => {
        this._updatePgnDisplay();
        this._updateAnalysisControllerGameState();
    });

    logger.info('[FinishHimController] Initialized.');
    if (this.state.userStats) {
        logger.debug('[FinishHimController] Initial userStats:', JSON.parse(JSON.stringify(this.state.userStats)));
    } else {
        logger.warn('[FinishHimController] userStats are null after initialization.');
    }
  }

  private _registerGameCallbacksWithAnalysisController(): void {
    const gameCallbacks: GameControlCallbacks = {
      onNextTaskRequested: () => this.loadAndStartFinishHimPuzzle(),
      onRestartTaskRequested: () => this.handleRestartTask(),
      onSetFenRequested: () => this.handleSetFen(),
      onStopGameRequested: () => this._stopCurrentGameActivity(),
    };
    this.analysisController.setGameControlCallbacks(gameCallbacks);
  }

  private _updateAnalysisControllerGameState(): void {
    const gameState: GameControlState = {
      canRestartTask: !!this.state.activePuzzle,
      canLoadNextTask: true,
      isGameActive: this.state.isGameEffectivelyActive,
    };
    this.analysisController.updateGameControlState(gameState);
  }

  private _clearOutplayTimer(): void {
    if (this.state.outplayTimerId) {
      clearTimeout(this.state.outplayTimerId);
      this.state.outplayTimerId = null;
      // Do not nullify outplayTimeRemainingMs here if we want to show the initial value
      // It will be reset or nulled when a new game/mode starts or timer truly ends.
      logger.info('[FinishHimController] Outplay timer (timeoutId) cleared.');
    }
    // If we want the timer display to disappear completely when cleared:
    // this.state.outplayTimeRemainingMs = null;
  }

  private _stopCurrentGameActivity(calledFromAnalysis: boolean = true): void {
    logger.info(`[FinishHimController] Stopping current game activity. Called from analysis: ${calledFromAnalysis}`);
    this.state.isStockfishThinking = false;
    this.state.isInPlayoutMode = false;
    this.state.isUserTurnContext = false;
    this.state.isGameEffectivelyActive = false;
    this._clearOutplayTimer();
    this.state.outplayTimeRemainingMs = null; // Ensure timer display is removed

    if (this.state.gameOverMessage === null && calledFromAnalysis) {
        this.state.feedbackMessage = t('finishHim.feedback.gameStoppedForAnalysis');
    }
    this._updateAnalysisControllerGameState();
    this.requestRedraw();
  }

  public initializeGame(): void {
    const currentAuthStats = this.authService.getFinishHimStats();
    if (currentAuthStats) {
        if (JSON.stringify(this.state.userStats) !== JSON.stringify(currentAuthStats)) {
            logger.info('[FinishHimController initializeGame] Updating userStats from AuthService.');
            this.state.userStats = { ...currentAuthStats };
        }
    } else if (this.authService.getIsAuthenticated()) {
        logger.error("[FinishHimController initializeGame] FinishHimStats are null from AuthService for an authenticated user!");
    }

    this.state.feedbackMessage = t('finishHim.feedback.selectCategoryAndStart');
    this.state.isGameEffectivelyActive = false;
    this._clearOutplayTimer();
    this.state.outplayTimeRemainingMs = null; // Ensure timer display is removed
    this._updatePgnDisplay();
    this._updateAnalysisControllerGameState();
    this.requestRedraw();
  }

  private countPiecesFromFen(fen: string): number {
    if (!fen) return 0;
    const fenParts = fen.split(' ');
    const piecePlacement = fenParts[0];
    let count = 0;
    for (const char of piecePlacement) {
      if (isNaN(parseInt(char, 10)) && char !== '/') {
        count++;
      }
    }
    return count;
  }

  private formatGameEndMessage(outcome: GameEndOutcome | undefined): string | null {
    if (!outcome) return null;
    if (outcome.winner) {
      const winnerColor = t(outcome.winner === 'white' ? 'puzzle.colors.white' : 'puzzle.colors.black');
      return t('puzzle.gameOver.checkmateWinner', { winner: winnerColor, reason: outcome.reason || t('puzzle.gameOver.reasons.checkmate') });
    }
    switch (outcome.reason) {
      case 'stalemate': return t('puzzle.gameOver.stalemate');
      case 'insufficient_material': return t('puzzle.gameOver.insufficientMaterial');
      case 'draw': return t('puzzle.gameOver.draw');
      default: return t('puzzle.gameOver.drawReason', { reason: outcome.reason || t('puzzle.gameOver.reasons.unknown') });
    }
  }

  private _updatePgnDisplay(): void {
    const gameStatus = this.boardHandler.getGameStatus();
    const showResultInPgn = gameStatus.isGameOver && !this.analysisController.getPanelState().isAnalysisActive;

    this.state.currentPgnString = this.boardHandler.getPgn({
        showResult: showResultInPgn,
        showVariations: this.analysisController.getPanelState().isAnalysisActive
    });
  }

  private _incrementGamesPlayed(): void {
    if (this.state.userStats) {
      this.state.userStats.gamesPlayed += 1;
      logger.debug(`[FinishHimController] Games played incremented: ${this.state.userStats.gamesPlayed}`);
      this._sendStatsToBackend();
    }
  }

  private _updateTacticalRating(isWin: boolean): void {
    if (this.state.userStats) {
      if (isWin) {
        this.state.userStats.tacticalRating += 10;
        this.state.userStats.tacticalWins += 1;
        logger.debug(`[FinishHimController] Tactical phase WIN. Rating: ${this.state.userStats.tacticalRating}, Wins: ${this.state.userStats.tacticalWins}`);
      } else {
        this.state.userStats.tacticalRating -= 10;
        this.state.userStats.tacticalLosses += 1;
        logger.debug(`[FinishHimController] Tactical phase LOSS. Rating: ${this.state.userStats.tacticalRating}, Losses: ${this.state.userStats.tacticalLosses}`);
      }
    }
  }

  private _updateFinishHimRatingAndPieceCount(outcome: 'win' | 'loss' | 'draw'): void {
    if (this.state.userStats) {
      const oldRating = this.state.userStats.finishHimRating;
      const oldPieceCount = this.state.userStats.currentPieceCount;

      if (outcome === 'win') {
        this.state.userStats.finishHimRating += 10;
        this.state.userStats.playoutWins += 1;
        this.state.userStats.currentPieceCount = Math.min(22, this.state.userStats.currentPieceCount + 1);
      } else if (outcome === 'loss') {
        this.state.userStats.finishHimRating -= 10;
        this.state.userStats.playoutLosses += 1;
        this.state.userStats.currentPieceCount = Math.max(7, this.state.userStats.currentPieceCount - 1);
      } else { // draw
        this.state.userStats.finishHimRating -= 10;
        this.state.userStats.playoutDraws += 1;
      }
      logger.debug(`[FinishHimController] Playout phase ${outcome}. Rating: ${oldRating} -> ${this.state.userStats.finishHimRating}. PieceCount: ${oldPieceCount} -> ${this.state.userStats.currentPieceCount}`);
      this._sendStatsToBackend();
    }
  }

  private async _sendStatsToBackend(): Promise<void> {
    const userId = this.authService.getUserProfile()?.id;
    if (userId && this.state.userStats) {
        logger.info(`[FinishHimController] Sending updated FinishHimStats to backend for user ${userId}.`);
        try {
            const statsToSend = { ...this.state.userStats };
            const success = await this.webhookService.sendFinishHimStatsUpdate(userId, statsToSend);
            if (success) {
                logger.info('[FinishHimController] FinishHimStats successfully sent to backend.');
            } else {
                logger.warn('[FinishHimController] Failed to send FinishHimStats to backend (webhookService returned false).');
            }
        } catch (error) {
            logger.error('[FinishHimController] Error sending FinishHimStats to backend:', error);
        }
    } else {
        logger.warn('[FinishHimController _sendStatsToBackend] Cannot send stats: userId or userStats missing.', { userId, userStats: !!this.state.userStats });
    }
  }

  private checkAndSetGameOver(): boolean {
    if (this.analysisController.getPanelState().isAnalysisActive) {
        if (this.state.gameOverMessage) {
            this.state.gameOverMessage = null;
            this.requestRedraw();
        }
        this.state.isGameEffectivelyActive = false;
        this._updateAnalysisControllerGameState();
        return false;
    }

    const gameStatus: GameStatus = this.boardHandler.getGameStatus();
    if (gameStatus.isGameOver) {
      this.state.gameOverMessage = this.formatGameEndMessage(gameStatus.outcome);
      this.state.feedbackMessage = this.state.gameOverMessage || t('puzzle.feedback.gameOver');
      this.state.isUserTurnContext = false;
      this.state.isStockfishThinking = false;
      this.state.isGameEffectivelyActive = false;
      logger.info(`[FinishHimController] Game over detected. Message: ${this.state.gameOverMessage}`);
      this._clearOutplayTimer();
      this.state.outplayTimeRemainingMs = null; // Ensure timer display is fully removed

      if (this.state.activePuzzle) {
        if (this.state.isInPlayoutMode) {
            const humanColor = this.boardHandler.getHumanPlayerColor();
            let playoutOutcome: 'win' | 'loss' | 'draw' = 'draw';

            if (gameStatus.outcome?.winner === humanColor) playoutOutcome = 'win';
            else if (gameStatus.outcome?.winner) playoutOutcome = 'loss';
            
            this._updateFinishHimRatingAndPieceCount(playoutOutcome);

            if (playoutOutcome === 'win') SoundService.playSound('puzzle_user_won');
            else if (playoutOutcome === 'loss') SoundService.playSound('puzzle_user_lost');
        }
      }

      if (gameStatus.outcome?.reason === 'stalemate') {
          SoundService.playSound('stalemate');
      } else if (gameStatus.outcome && !gameStatus.outcome.winner) {
          SoundService.playSound('DRAW_GENERAL');
      }

      this._updatePgnDisplay();
      this._updateAnalysisControllerGameState();
      this.requestRedraw();
      return true;
    }
    this.state.gameOverMessage = null;
    return false;
  }

  public setActivePuzzleType(puzzleType: FinishHimPuzzleType): void {
    if (this.state.activePuzzleType !== puzzleType) {
      this.state.activePuzzleType = puzzleType;
      logger.info(`[FinishHimController] Active puzzle type set to: ${puzzleType}`);
      const categoryName = t(`finishHim.puzzleTypes.${puzzleType}`);
      this.state.feedbackMessage = t('finishHim.feedback.categorySelected', { category: categoryName });
      this.requestRedraw();
    }
  }

  public async loadAndStartFinishHimPuzzle(puzzleToLoad?: AppPuzzle): Promise<void> {
    if (this.boardHandler.promotionCtrl.isActive()) this.boardHandler.promotionCtrl.cancel();

    if (this.analysisController.getPanelState().isAnalysisActive) {
        this.analysisController.toggleAnalysisEngine();
    }
    this._clearOutplayTimer();
    this.state.outplayTimeRemainingMs = null; // Ensure timer display is removed

    this.state.activePuzzle = null;
    this.state.interactiveSetupMoves = [];
    this.state.currentInteractiveSetupMoveIndex = 0;
    this.state.isUserTurnContext = false;
    this.state.feedbackMessage = t('common.loading');
    this.state.isInPlayoutMode = false;
    this.state.isStockfishThinking = false;
    this.state.gameOverMessage = null;
    this.state.currentPgnString = "";
    this.state.currentTaskPieceCount = 0;
    this.state.isGameEffectivelyActive = true;
    this.requestRedraw();

    let puzzleDataToProcess: AppPuzzle | null = puzzleToLoad || null;
    const currentStats = this.authService.getFinishHimStats();

    if (!puzzleDataToProcess) {
        logger.info(`[FinishHimController] Loading new FinishHim puzzle from webhook. Type: ${this.state.activePuzzleType}`);
        const payload: PuzzleRequestPayload = {
          event: "FinishHim",
          lichess_id: this.authService.getUserProfile()?.id || "unknown_user",
          pieceCount: currentStats?.currentPieceCount || this.defaultUserPieceCount,
          rating: currentStats?.tacticalRating || this.defaultUserRating,
          puzzleType: this.state.activePuzzleType,
        };
        puzzleDataToProcess = await this.webhookService.fetchPuzzle(payload);
    } else {
        logger.info(`[FinishHimController] Starting FinishHim puzzle from provided data: ${puzzleToLoad?.PuzzleId}`);
    }

    if (puzzleDataToProcess) {
      this.state.activePuzzle = puzzleDataToProcess;
      this.state.interactiveSetupMoves = puzzleDataToProcess.Moves ? puzzleDataToProcess.Moves.split(' ') : [];
      this.state.currentInteractiveSetupMoveIndex = 0;
      this.state.currentTaskPieceCount = this.countPiecesFromFen(puzzleDataToProcess.FEN_0);

      this.boardHandler.setupPosition(puzzleDataToProcess.FEN_0, puzzleDataToProcess.HumanColor, true);
      logger.info(`[FinishHimController] Puzzle loaded: ${puzzleDataToProcess.PuzzleId}. Initial FEN: ${this.boardHandler.getFen()}. Pieces: ${this.state.currentTaskPieceCount}`);
      logger.info(`[FinishHimController] Human player color: ${this.boardHandler.getHumanPlayerColor()}. Interactive setup moves: ${this.state.interactiveSetupMoves.join(' ')}`);

      const playerColorName = t(this.boardHandler.getHumanPlayerColor() === 'white' ? 'puzzle.colors.white' : 'puzzle.colors.black');
      const categoryName = t(`finishHim.puzzleTypes.${this.state.activePuzzleType}`);
      this.state.feedbackMessage = puzzleToLoad
        ? t('finishHim.feedback.restarted', { puzzleId: puzzleDataToProcess.PuzzleId, color: playerColorName, category: categoryName })
        : t('finishHim.feedback.loaded', { puzzleId: puzzleDataToProcess.PuzzleId, color: playerColorName, category: categoryName });

      this.state.isGameEffectivelyActive = true;
      if (this.checkAndSetGameOver()) return;

      const initialTurnColorInPuzzle = this.boardHandler.getBoardTurnColor();
      const humanColor = this.boardHandler.getHumanPlayerColor();

      if (this.state.interactiveSetupMoves.length > 0) {
        if (initialTurnColorInPuzzle !== humanColor) {
          logger.info("[FinishHimController] System makes the first interactive setup move.");
          this.state.isUserTurnContext = false;
          this.state.feedbackMessage = t('puzzle.feedback.systemMove');
          this.requestRedraw();
          setTimeout(() => this._playNextInteractiveSetupMoveSystem(false), 750);
        } else {
          this.state.isUserTurnContext = true;
          this.state.feedbackMessage = t('puzzle.feedback.yourTurn');
          logger.info(`[FinishHimController] Interactive setup starts with user's turn.`);
          this.requestRedraw();
        }
      } else {
        logger.info("[FinishHimController] No interactive setup moves. Tactical phase won by default. Entering playout mode directly.");
        this._updateTacticalRating(true);
        this._incrementGamesPlayed();
        this._enterPlayoutMode();
      }
    } else {
      logger.error("[FinishHimController] Failed to load FinishHim puzzle.");
      this.state.feedbackMessage = t('puzzle.feedback.loadFailed');
      this.state.isGameEffectivelyActive = false;
    }
    this._updatePgnDisplay();
    this._updateAnalysisControllerGameState();
    this.requestRedraw();
  }

  private _playNextInteractiveSetupMoveSystem(isContinuation: boolean = false): void {
    if (this.state.gameOverMessage || this.boardHandler.promotionCtrl.isActive() || this.analysisController.getPanelState().isAnalysisActive) return;

    if (!this.state.activePuzzle || this.state.currentInteractiveSetupMoveIndex >= this.state.interactiveSetupMoves.length) {
      if (this.state.activePuzzle) {
        logger.info("[FinishHimController] Interactive setup completed by system. Entering playout mode.");
        if (this.state.currentInteractiveSetupMoveIndex > 0 && this.state.interactiveSetupMoves.length > 0) {
            this._updateTacticalRating(true);
            this._incrementGamesPlayed();
        }
        this._enterPlayoutMode();
      } else {
        logger.warn("[FinishHimController _playNextInteractiveSetupMoveSystem] No active puzzle.");
      }
      this.requestRedraw();
      return;
    }

    const uciSetupMove = this.state.interactiveSetupMoves[this.state.currentInteractiveSetupMoveIndex];
    logger.info(`[FinishHimController] System playing interactive setup move ${this.state.currentInteractiveSetupMoveIndex + 1}/${this.state.interactiveSetupMoves.length}: ${uciSetupMove}`);
    this.state.feedbackMessage = isContinuation ? t('puzzle.feedback.systemResponse', { move: uciSetupMove }) : t('puzzle.feedback.systemFirstMove', { move: uciSetupMove });
    this.requestRedraw();

    const moveResult: AttemptMoveResult = this.boardHandler.applySystemMove(uciSetupMove);

    if (moveResult.success) {
      this.state.currentInteractiveSetupMoveIndex++;
      if (this.checkAndSetGameOver()) return;

      if (this.state.currentInteractiveSetupMoveIndex >= this.state.interactiveSetupMoves.length) {
        logger.info("[FinishHimController] SYSTEM COMPLETED INTERACTIVE SETUP!");
        this._updateTacticalRating(true);
        this._incrementGamesPlayed();
        this._enterPlayoutMode();
      } else {
        this.state.isUserTurnContext = true;
        this.state.feedbackMessage = t('puzzle.feedback.yourTurn');
      }
    } else {
      logger.error(`[FinishHimController] Failed to apply interactive setup move ${uciSetupMove}. Result: ${JSON.stringify(moveResult)}`);
      this.state.feedbackMessage = t('puzzle.feedback.puzzleDataError');
      this.state.isUserTurnContext = true;
    }
    this.requestRedraw();
  }

  private _tickOutplayTimer(): void {
    if (!this.state.isInPlayoutMode || this.state.gameOverMessage || !this.state.isGameEffectivelyActive || this.analysisController.getPanelState().isAnalysisActive) {
        this._clearOutplayTimer();
        // If timer is cleared because game is over etc., ensure remaining time is nulled for display
        if (this.state.gameOverMessage || !this.state.isGameEffectivelyActive) {
            this.state.outplayTimeRemainingMs = null;
        }
        return;
    }

    if (this.state.outplayTimeRemainingMs !== null) {
        this.state.outplayTimeRemainingMs -= 1000;
        if (this.state.outplayTimeRemainingMs <= 0) {
            logger.info('[FinishHimController] Outplay time expired.');
            this._clearOutplayTimer(); // Clears timeoutId
            this.state.outplayTimeRemainingMs = 0; // Show 00:00
            SoundService.playSound('PLAYOUT_TIME_UP');
            this._updateFinishHimRatingAndPieceCount('loss');
            this.state.gameOverMessage = t('finishHim.feedback.timeUp');
            this.state.feedbackMessage = this.state.gameOverMessage;
            this.state.isUserTurnContext = false;
            this.state.isGameEffectivelyActive = false;
            this._updatePgnDisplay();
            this._updateAnalysisControllerGameState();
            this.requestRedraw();
            return;
        }
    }
    this.requestRedraw();
    this.state.outplayTimerId = window.setTimeout(() => this._tickOutplayTimer(), 1000);
  }

  private _enterPlayoutMode(): void {
    if (this.state.isInPlayoutMode && this.state.isGameEffectivelyActive) {
        logger.debug("[FinishHimController] Already in playout mode. Ensuring turn context is correct.");
    } else {
        logger.info("[FinishHimController] Entering playout mode.");
        SoundService.playSound('puzzle_playout_start');
        this.state.isInPlayoutMode = true;
        this.state.isGameEffectivelyActive = true;
    }

    this._clearOutplayTimer(); // Ensure no old timer is running
    this.state.outplayTimeRemainingMs = OUTPLAY_TIMER_DURATION_MS; // Set initial time for display
    // The timer tick will be started by the user's first move in handleUserMove

    const currentBoardTurn = this.boardHandler.getBoardTurnColor();
    const humanAs = this.boardHandler.getHumanPlayerColor();
    this.state.isUserTurnContext = (currentBoardTurn === humanAs);

    logger.info(`[FinishHimController] Playout mode active. Board turn: ${currentBoardTurn}, Human plays as: ${humanAs}, Is user turn context: ${this.state.isUserTurnContext}. Timer set to ${this.state.outplayTimeRemainingMs / 1000}s, but not ticking yet.`);

    if (this.state.isUserTurnContext) {
        if (!this.state.gameOverMessage) this.state.feedbackMessage = t('finishHim.feedback.yourTurnPlayout');
    } else {
        if (!this.state.gameOverMessage) this.state.feedbackMessage = t('finishHim.feedback.systemToMovePlayout');
        this.triggerStockfishMoveInPlayoutIfNeeded();
    }
    this._updateAnalysisControllerGameState();
    this.requestRedraw();
  }

  private async triggerStockfishMoveInPlayoutIfNeeded(): Promise<void> {
    if (this.state.gameOverMessage || this.boardHandler.promotionCtrl.isActive() || this.analysisController.getPanelState().isAnalysisActive || !this.state.isInPlayoutMode || !this.state.isGameEffectivelyActive) {
      // If timer is running and system move is aborted, timer should continue if it's user's turn next.
      // If game ends, timer is cleared by checkAndSetGameOver.
      // If analysis starts, timer is cleared by _stopCurrentGameActivity.
      return;
    }
    const currentBoardTurn = this.boardHandler.getBoardTurnColor();
    const humanColor = this.boardHandler.getHumanPlayerColor();

    if (currentBoardTurn !== humanColor && !this.state.isStockfishThinking) {
      logger.info(`[FinishHimController] Triggering Stockfish move in playout. FEN: ${this.boardHandler.getFen()}`);
      this.state.isStockfishThinking = true;
      this.state.feedbackMessage = t('puzzle.feedback.stockfishThinking');
      this.requestRedraw();

      try {
        const stockfishMoveUci = await this.stockfishService.getBestMoveOnly(this.boardHandler.getFen(), { depth: 12 });
        this.state.isStockfishThinking = false;

        if (this.state.gameOverMessage || !this.state.isInPlayoutMode || !this.state.isGameEffectivelyActive || this.analysisController.getPanelState().isAnalysisActive) {
            logger.info("[FinishHimController] State changed during Stockfish thinking, aborting move application.");
            return;
        }

        if (stockfishMoveUci) {
          logger.info(`[FinishHimController] Stockfish auto-move in playout: ${stockfishMoveUci}`);
          const moveResult: AttemptMoveResult = this.boardHandler.applySystemMove(stockfishMoveUci);
          if (moveResult.success) {
            if (!this.checkAndSetGameOver()) {
              this.state.feedbackMessage = t('finishHim.feedback.yourTurnPlayout');
              this.state.isUserTurnContext = true;
              // Timer is NOT started here; waits for user's move.
            }
          } else {
            logger.error("[FinishHimController] Stockfish (auto) made an illegal move or FEN update failed:", stockfishMoveUci);
            this.state.feedbackMessage = t('puzzle.feedback.stockfishError');
            this.state.isUserTurnContext = true;
          }
        } else {
          logger.warn("[FinishHimController] Stockfish (auto) did not return a move in playout (e.g. mate/stalemate already).");
          if (!this.checkAndSetGameOver()) {
            this.state.feedbackMessage = t('puzzle.feedback.stockfishNoMove');
            this.state.isUserTurnContext = true;
          }
        }
      } catch (error) {
        this.state.isStockfishThinking = false;
        logger.error("[FinishHimController] Error during Stockfish auto-move in playout:", error);
        if (!this.checkAndSetGameOver()) {
          this.state.feedbackMessage = t('puzzle.feedback.stockfishGetMoveError');
          this.state.isUserTurnContext = true;
        }
      }
      this.requestRedraw();
    } else if (currentBoardTurn === humanColor && !this.state.isUserTurnContext && this.state.isInPlayoutMode && this.state.isGameEffectivelyActive) {
        logger.debug("[FinishHimController triggerStockfishMoveInPlayoutIfNeeded] Aligning isUserTurnContext to true as it's human's FEN turn in playout.");
        this.state.isUserTurnContext = true;
        if (!this.state.gameOverMessage) this.state.feedbackMessage = t('finishHim.feedback.yourTurnPlayout');
        this.requestRedraw();
    }
  }

  public async handleUserMove(orig: Key, dest: Key): Promise<void> {
    const analysisIsActive = this.analysisController.getPanelState().isAnalysisActive;

    if (analysisIsActive) {
        logger.info(`[FinishHimController] User interacting with board while analysis is active: ${orig}-${dest}. Forwarding to BoardHandler.`);
        const moveResult: AttemptMoveResult = await this.boardHandler.attemptUserMove(orig, dest);
        if (moveResult.success && moveResult.uciMove) {
            this.state.feedbackMessage = t('puzzle.feedback.analysisMoveMade', { san: moveResult.sanMove || moveResult.uciMove, fen: this.boardHandler.getFen() });
        } else if (moveResult.promotionStarted && !moveResult.promotionCompleted) {
            this.state.feedbackMessage = t('puzzle.feedback.promotionCancelled');
        } else if (moveResult.isIllegal) {
            this.state.feedbackMessage = t('puzzle.feedback.illegalMoveAnalysis');
        } else {
            this.state.feedbackMessage = t('puzzle.feedback.moveErrorAnalysis');
        }
        this.state.currentTaskPieceCount = this.countPiecesFromFen(this.boardHandler.getFen());
        this._updatePgnDisplay();
        this.requestRedraw();
        return;
    }

    if (this.state.gameOverMessage) {
        logger.warn("[FinishHimController handleUserMove] Move ignored: game over.");
        return;
    }
    if (this.boardHandler.promotionCtrl.isActive()) {
        logger.warn("[FinishHimController handleUserMove] Move ignored: promotion active.");
        this.state.feedbackMessage = t('puzzle.feedback.selectPromotion');
        this.requestRedraw();
        return;
    }
    if (this.state.isStockfishThinking) {
        logger.warn("[FinishHimController handleUserMove] User attempted to move while Stockfish is thinking.");
        this.state.feedbackMessage = t('puzzle.feedback.stockfishThinkingWait');
        this.requestRedraw();
        return;
    }
     if (!this.state.isUserTurnContext) {
        logger.warn(`[FinishHimController handleUserMove] User attempted to move when it's not their turn context (isUserTurnContext: ${this.state.isUserTurnContext}).`);
        this.state.feedbackMessage = t('puzzle.feedback.notYourTurn');
        this.requestRedraw();
        return;
    }

    const moveResult: AttemptMoveResult = await this.boardHandler.attemptUserMove(orig, dest);

    if (moveResult.success && moveResult.uciMove) {
      this.state.currentTaskPieceCount = this.countPiecesFromFen(this.boardHandler.getFen());
      this._updatePgnDisplay();

      if (this.checkAndSetGameOver()) return;

      if (this.state.isInPlayoutMode) {
        logger.info(`[FinishHimController] User move in playout mode: ${moveResult.uciMove}`);
        // Start timer ticking if it's the first user move in this playout session
        if (this.state.outplayTimeRemainingMs !== null && this.state.outplayTimerId === null) {
            logger.info('[FinishHimController] Starting outplay timer tick after user move.');
            this.state.outplayTimerId = window.setTimeout(() => this._tickOutplayTimer(), 1000);
        }
        this.state.isUserTurnContext = false;
        this.triggerStockfishMoveInPlayoutIfNeeded();
      } else {
        this.processUserMoveResultInInteractiveSetup(moveResult.uciMove);
      }
    } else if (moveResult.promotionStarted && !moveResult.success && !moveResult.promotionCompleted) {
      logger.info("[FinishHimController handleUserMove] Promotion was cancelled by user (dialog closed).");
      this.state.feedbackMessage = t('puzzle.feedback.promotionCancelled');
    } else if (!moveResult.success) {
      logger.warn(`[FinishHimController handleUserMove] User move ${orig}-${dest} failed. Result: ${JSON.stringify(moveResult)}`);
      this.state.feedbackMessage = moveResult.isIllegal ? t('puzzle.feedback.invalidMove') : t('puzzle.feedback.moveProcessingError');
    }
    this.requestRedraw();
  }

  private processUserMoveResultInInteractiveSetup(uciUserMove: string): void {
    logger.info(`[FinishHimController processUserMoveResultInInteractiveSetup] Processing user move: ${uciUserMove}.`);

    if (!this.state.activePuzzle) {
      logger.warn("[FinishHimController processUserMoveResultInInteractiveSetup] No active puzzle. Entering playout mode as fallback.");
      this._updateTacticalRating(true);
      this._incrementGamesPlayed();
      this._enterPlayoutMode();
      return;
    }

    const expectedSetupMove = this.state.interactiveSetupMoves[this.state.currentInteractiveSetupMoveIndex];

    if (uciUserMove === expectedSetupMove) {
      logger.info(`[FinishHimController processUserMoveResultInInteractiveSetup] User move ${uciUserMove} is CORRECT for setup!`);
      this.state.feedbackMessage = t('puzzle.feedback.correctMove');
      this.state.currentInteractiveSetupMoveIndex++;
      this.state.isUserTurnContext = false;

      if (this.checkAndSetGameOver()) return;

      if (this.state.currentInteractiveSetupMoveIndex >= this.state.interactiveSetupMoves.length) {
        logger.info("[FinishHimController processUserMoveResultInInteractiveSetup] USER COMPLETED INTERACTIVE SETUP!");
        this._updateTacticalRating(true);
        this._incrementGamesPlayed();
        this._enterPlayoutMode();
      } else {
        this.state.feedbackMessage = t('puzzle.feedback.systemMove');
        logger.info(`[FinishHimController processUserMoveResultInInteractiveSetup] Scheduling system's setup move: ${this.state.interactiveSetupMoves[this.state.currentInteractiveSetupMoveIndex]} (index ${this.state.currentInteractiveSetupMoveIndex}).`);
        setTimeout(() => {
          if (!this.analysisController.getPanelState().isAnalysisActive && !this.state.gameOverMessage) {
            this._playNextInteractiveSetupMoveSystem(true);
          }
        }, 300);
      }
    } else {
      logger.warn(`[FinishHimController processUserMoveResultInInteractiveSetup] User move ${uciUserMove} is INCORRECT for setup. Expected: ${expectedSetupMove}.`);
      this.state.feedbackMessage = t('finishHim.feedback.tacticalFail');
      this.state.gameOverMessage = t('finishHim.feedback.tacticalFailDetailed', {userMove: uciUserMove, expectedMove: expectedSetupMove});
      this.state.isUserTurnContext = false;
      this.state.isGameEffectivelyActive = false;
      this._updateTacticalRating(false);
      this._incrementGamesPlayed();
      SoundService.playSound('USER_TACTICAL_FAIL');
      this._updatePgnDisplay();
      this._updateAnalysisControllerGameState();
    }
    this.requestRedraw();
  }

  public handleRestartTask(): void {
    if (this.boardHandler.promotionCtrl.isActive()) this.boardHandler.promotionCtrl.cancel();

    if (this.analysisController.getPanelState().isAnalysisActive) {
        this.analysisController.toggleAnalysisEngine();
    }
    this._clearOutplayTimer();
    this.state.outplayTimeRemainingMs = null; // Ensure timer display is removed

    if (this.state.activePuzzle) {
      logger.info(`[FinishHimController] Restarting current task: ${this.state.activePuzzle.PuzzleId}`);
      this.loadAndStartFinishHimPuzzle(this.state.activePuzzle);
    } else {
      logger.warn("[FinishHimController] Restart task called, but no active task to restart. Loading new one.");
      this.state.feedbackMessage = t('finishHim.feedback.noTaskToRestart');
      this.loadAndStartFinishHimPuzzle();
    }
  }

  public handleSetFen(): void {
    if (this.boardHandler.promotionCtrl.isActive()) this.boardHandler.promotionCtrl.cancel();

    if (this.analysisController.getPanelState().isAnalysisActive) {
        this.analysisController.toggleAnalysisEngine();
    }
    this._clearOutplayTimer();
    this.state.outplayTimeRemainingMs = null; // Ensure timer display is removed

    const fen = prompt(t('puzzle.feedback.enterFenPrompt'), this.boardHandler.getFen());
    if (fen) {
      this.state.activePuzzle = null;
      this.state.interactiveSetupMoves = [];
      this.state.currentInteractiveSetupMoveIndex = 0;
      this.state.currentTaskPieceCount = this.countPiecesFromFen(fen);
      this.state.isStockfishThinking = false;
      this.state.gameOverMessage = null;
      this.state.isInPlayoutMode = false; // Will be set true by _enterPlayoutMode
      this.state.isGameEffectivelyActive = true;

      const humanPlayerColorBasedOnTurn = fen.includes(' w ') ? 'white' : 'black';
      this.boardHandler.setupPosition(fen, humanPlayerColorBasedOnTurn, true);
      this._updatePgnDisplay();

      if (this.checkAndSetGameOver()) return;

      logger.info("[FinishHimController handleSetFen] FEN set manually. Entering playout mode directly.");
      this._enterPlayoutMode(); // This will set isInPlayoutMode and initialize timer display
      this.requestRedraw();
    }
  }

  public destroy(): void {
    logger.info('[FinishHimController] Destroying FinishHimController instance.');
    if (this.analysisController && this.analysisController.getPanelState().isAnalysisActive) {
        this.analysisController.toggleAnalysisEngine();
    }
    this._clearOutplayTimer();
    this.state.outplayTimeRemainingMs = null; // Ensure timer display is removed
  }
}
