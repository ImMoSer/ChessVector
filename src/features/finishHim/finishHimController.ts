// src/features/finishHim/finishHimController.ts
import type { Key } from 'chessground/types';
import type { ChessboardService } from '../../core/chessboard.service';
import type { WebhookService, AppPuzzle, PuzzleRequestPayload } from '../../core/webhook.service';
import type { StockfishService } from '../../core/stockfish.service';
import { BoardHandler } from '../../core/boardHandler';
import type { GameStatus, GameEndOutcome, AttemptMoveResult } from '../../core/boardHandler';
import { AnalysisService, type AnalysisStateForUI } from '../../core/analysis.service';
import logger from '../../utils/logger';
import { SoundService } from '../../core/sound.service';
import { t } from '../../core/i18n.service';
import type { FinishHimPuzzleType } from './finishHim.types';
import { FINISH_HIM_PUZZLE_TYPES } from './finishHim.types';

interface FinishHimControllerState {
  activePuzzle: AppPuzzle | null;
  interactiveSetupMoves: string[];
  currentInteractiveSetupMoveIndex: number;

  activePuzzleType: FinishHimPuzzleType;
  userRating: number;
  userPieceCount: number;

  isUserTurnContext: boolean;
  feedbackMessage: string;
  isInPlayoutMode: boolean;
  isStockfishThinking: boolean;
  gameOverMessage: string | null;
  currentPgnString: string;
  analysisUiState: AnalysisStateForUI | null;
  currentTaskPieceCount: number;
}

export class FinishHimController {
  public state: FinishHimControllerState;
  public boardHandler: BoardHandler;
  private analysisService: AnalysisService;
  private webhookService: WebhookService;
  private stockfishService: StockfishService;
  private unsubscribeFromAnalysis: (() => void) | null = null;

  private defaultUserRating = 1500;
  private defaultUserPieceCount = 10;

  constructor(
    public chessboardService: ChessboardService,
    boardHandler: BoardHandler,
    webhookService: WebhookService,
    stockfishService: StockfishService,
    analysisService: AnalysisService,
    public requestRedraw: () => void,
  ) {
    this.boardHandler = boardHandler;
    this.analysisService = analysisService;
    this.webhookService = webhookService;
    this.stockfishService = stockfishService;

    this.state = {
      activePuzzle: null,
      interactiveSetupMoves: [],
      currentInteractiveSetupMoveIndex: 0,
      activePuzzleType: FINISH_HIM_PUZZLE_TYPES[0],
      userRating: this.defaultUserRating,
      userPieceCount: this.defaultUserPieceCount,
      isUserTurnContext: false,
      feedbackMessage: t('finishHim.feedback.selectCategoryAndStart'),
      isInPlayoutMode: false,
      isStockfishThinking: false,
      gameOverMessage: null,
      currentPgnString: "",
      analysisUiState: null,
      currentTaskPieceCount: 0,
    };
    logger.info('[FinishHimController] Initialized.');

    this.boardHandler.onMoveMade(() => this._updatePgnDisplay());
    this.boardHandler.onPgnNavigated(() => this._updatePgnDisplay());

    this.unsubscribeFromAnalysis = this.analysisService.subscribeToAnalysisUpdates((analysisState) => {
        this.state.analysisUiState = analysisState;
        this.requestRedraw();
    });
  }

  public initializeGame(): void {
    this.state.feedbackMessage = t('finishHim.feedback.selectCategoryAndStart');
    this._updatePgnDisplay();
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
    const showResult = gameStatus.isGameOver && !this.boardHandler.isBoardConfiguredForAnalysis();
    this.state.currentPgnString = this.boardHandler.getPgn({
        showResult,
        showVariations: this.boardHandler.isBoardConfiguredForAnalysis()
    });
  }

  private checkAndSetGameOver(): boolean {
    if (this.boardHandler.isBoardConfiguredForAnalysis()) {
        this.state.gameOverMessage = null;
        return false;
    }

    const gameStatus: GameStatus = this.boardHandler.getGameStatus();
    if (gameStatus.isGameOver) {
      this.state.gameOverMessage = this.formatGameEndMessage(gameStatus.outcome);
      this.state.feedbackMessage = this.state.gameOverMessage || t('puzzle.feedback.gameOver');
      this.state.isUserTurnContext = false;
      this.state.isStockfishThinking = false;
      logger.info(`[FinishHimController] Game over detected. Message: ${this.state.gameOverMessage}`);
      
      if (this.state.activePuzzle && gameStatus.outcome?.reason !== 'stalemate') {
        const humanColor = this.boardHandler.getHumanPlayerColor();
        if (gameStatus.outcome?.winner && humanColor) {
          if (gameStatus.outcome.winner === humanColor) {
            this.state.feedbackMessage = t('finishHim.feedback.taskComplete');
            SoundService.playSound('puzzle_user_won');
          } else {
            this.state.feedbackMessage = t('finishHim.feedback.taskFailed');
            SoundService.playSound('puzzle_user_lost');
          }
        }
      }
      this._updatePgnDisplay();
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
    if (this.boardHandler.isBoardConfiguredForAnalysis()) this.handleToggleAnalysisMode(false);

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
    this.requestRedraw();

    let puzzleDataToProcess: AppPuzzle | null = puzzleToLoad || null;

    if (!puzzleDataToProcess) {
        logger.info(`[FinishHimController] Loading new FinishHim puzzle from webhook. Type: ${this.state.activePuzzleType}`);
        const payload: PuzzleRequestPayload = {
          event: "FinishHim",
          lichess_id: "valid_all",
          pieceCount: this.state.userPieceCount,
          rating: this.state.userRating,
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
      const categoryName = t(`finishHim.puzzleTypes.${this.state.activePuzzleType}`); // Assuming activePuzzleType is relevant even if puzzleData is provided
      this.state.feedbackMessage = puzzleToLoad 
        ? t('finishHim.feedback.restarted', { puzzleId: puzzleDataToProcess.PuzzleId, color: playerColorName, category: categoryName })
        : t('finishHim.feedback.loaded', { puzzleId: puzzleDataToProcess.PuzzleId, color: playerColorName, category: categoryName });


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
        logger.info("[FinishHimController] No interactive setup moves. Entering playout mode directly.");
        this._enterPlayoutMode();
      }
    } else {
      logger.error("[FinishHimController] Failed to load FinishHim puzzle.");
      this.state.feedbackMessage = t('puzzle.feedback.loadFailed');
    }
    this._updatePgnDisplay();
    this.requestRedraw();
  }

  private _playNextInteractiveSetupMoveSystem(isContinuation: boolean = false): void {
    if (this.state.gameOverMessage || this.boardHandler.promotionCtrl.isActive() || this.boardHandler.isBoardConfiguredForAnalysis()) return;

    if (!this.state.activePuzzle || this.state.currentInteractiveSetupMoveIndex >= this.state.interactiveSetupMoves.length) {
      if (this.state.activePuzzle) {
        logger.info("[FinishHimController] Interactive setup completed. Entering playout mode.");
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

  private _enterPlayoutMode(): void {
    if (this.state.isInPlayoutMode) {
        logger.debug("[FinishHimController] Already in playout mode. Ensuring turn context is correct.");
    } else {
        logger.info("[FinishHimController] Entering playout mode.");
        SoundService.playSound('puzzle_playout_start');
        this.state.isInPlayoutMode = true;
    }

    const currentBoardTurn = this.boardHandler.getBoardTurnColor();
    const humanAs = this.boardHandler.getHumanPlayerColor();
    this.state.isUserTurnContext = (currentBoardTurn === humanAs);

    logger.info(`[FinishHimController] Playout mode active. Board turn: ${currentBoardTurn}, Human plays as: ${humanAs}, Is user turn context: ${this.state.isUserTurnContext}`);

    if (this.state.isUserTurnContext) {
        if (!this.state.gameOverMessage) this.state.feedbackMessage = t('finishHim.feedback.yourTurnPlayout');
    } else {
        if (!this.state.gameOverMessage) this.state.feedbackMessage = t('finishHim.feedback.systemToMovePlayout');
        this.triggerStockfishMoveInPlayoutIfNeeded();
    }
    this.requestRedraw();
  }


  private async triggerStockfishMoveInPlayoutIfNeeded(): Promise<void> {
    if (this.state.gameOverMessage || this.boardHandler.promotionCtrl.isActive() || this.boardHandler.isBoardConfiguredForAnalysis() || !this.state.isInPlayoutMode) {
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

        if (this.state.gameOverMessage || !this.state.isInPlayoutMode) {
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
    } else if (currentBoardTurn === humanColor && !this.state.isUserTurnContext && this.state.isInPlayoutMode) {
        logger.debug("[FinishHimController triggerStockfishMoveInPlayoutIfNeeded] Aligning isUserTurnContext to true as it's human's FEN turn in playout.");
        this.state.isUserTurnContext = true;
        if (!this.state.gameOverMessage) this.state.feedbackMessage = t('finishHim.feedback.yourTurnPlayout');
        this.requestRedraw();
    }
  }

  public async handleUserMove(orig: Key, dest: Key): Promise<void> {
    if (this.state.gameOverMessage && !this.boardHandler.isBoardConfiguredForAnalysis()) {
        logger.warn("[FinishHimController handleUserMove] Move ignored: game over and not in analysis config.");
        return;
    }
    if (this.boardHandler.promotionCtrl.isActive()) {
        logger.warn("[FinishHimController handleUserMove] Move ignored: promotion active.");
        this.state.feedbackMessage = t('puzzle.feedback.selectPromotion');
        this.requestRedraw();
        return;
    }
    if (this.state.isStockfishThinking && !this.boardHandler.isBoardConfiguredForAnalysis()) {
        logger.warn("[FinishHimController handleUserMove] User attempted to move while Stockfish is thinking (non-analysis).");
        this.state.feedbackMessage = t('puzzle.feedback.stockfishThinkingWait');
        this.requestRedraw();
        return;
    }
     if (!this.state.isUserTurnContext && !this.boardHandler.isBoardConfiguredForAnalysis()) {
        logger.warn(`[FinishHimController handleUserMove] User attempted to move when it's not their turn context (isUserTurnContext: ${this.state.isUserTurnContext}).`);
        this.state.feedbackMessage = t('puzzle.feedback.notYourTurn');
        this.requestRedraw();
        return;
    }

    const moveResult: AttemptMoveResult = await this.boardHandler.attemptUserMove(orig, dest);

    if (this.boardHandler.isBoardConfiguredForAnalysis()) {
        logger.info(`[FinishHimController] User move in analysis config: ${orig}-${dest}. Result: ${JSON.stringify(moveResult)}`);
        if (moveResult.success && moveResult.uciMove) {
            this.state.feedbackMessage = t('puzzle.feedback.analysisMoveMade', { san: moveResult.sanMove || moveResult.uciMove, fen: this.boardHandler.getFen() });
            this.state.currentTaskPieceCount = this.countPiecesFromFen(this.boardHandler.getFen());
        } else if (moveResult.promotionStarted && !moveResult.promotionCompleted) {
            this.state.feedbackMessage = t('puzzle.feedback.promotionCancelled');
        } else if (moveResult.isIllegal) {
            this.state.feedbackMessage = t('puzzle.feedback.illegalMoveAnalysis');
        } else {
            this.state.feedbackMessage = t('puzzle.feedback.moveErrorAnalysis');
        }
        this._updatePgnDisplay();
        this.requestRedraw();
        return;
    }

    if (moveResult.success && moveResult.uciMove) {
      this.state.currentTaskPieceCount = this.countPiecesFromFen(this.boardHandler.getFen());
      this._updatePgnDisplay();

      if (this.checkAndSetGameOver()) return;

      if (this.state.isInPlayoutMode) {
        logger.info(`[FinishHimController] User move in playout mode: ${moveResult.uciMove}`);
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
      logger.warn("[FinishHimController processUserMoveResultInInteractiveSetup] No active puzzle. Entering playout mode.");
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
        this._enterPlayoutMode();
      } else {
        this.state.feedbackMessage = t('puzzle.feedback.systemMove');
        logger.info(`[FinishHimController processUserMoveResultInInteractiveSetup] Scheduling system's setup move: ${this.state.interactiveSetupMoves[this.state.currentInteractiveSetupMoveIndex]} (index ${this.state.currentInteractiveSetupMoveIndex}).`);
        setTimeout(() => {
          this._playNextInteractiveSetupMoveSystem(true);
        }, 300);
      }
    } else {
      logger.warn(`[FinishHimController processUserMoveResultInInteractiveSetup] User move ${uciUserMove} is INCORRECT for setup. Expected: ${expectedSetupMove}. Undoing user's move.`);
      this.state.feedbackMessage = t('puzzle.feedback.incorrectMove', { expectedMove: expectedSetupMove });
      if (this.boardHandler.undoLastMove()) {
        logger.info(`[FinishHimController processUserMoveResultInInteractiveSetup] Incorrect user move ${uciUserMove} was undone. FEN is now: ${this.boardHandler.getFen()}`);
        this.state.currentTaskPieceCount = this.countPiecesFromFen(this.boardHandler.getFen());
      } else {
        logger.error(`[FinishHimController processUserMoveResultInInteractiveSetup] Failed to undo incorrect user move ${uciUserMove}.`);
      }
      this.state.isUserTurnContext = true;
    }
  }

  public handleRestartTask(): void {
    if (this.boardHandler.promotionCtrl.isActive()) this.boardHandler.promotionCtrl.cancel();
    if (this.boardHandler.isBoardConfiguredForAnalysis()) this.handleToggleAnalysisMode(false);

    if (this.state.activePuzzle) {
      logger.info(`[FinishHimController] Restarting current task: ${this.state.activePuzzle.PuzzleId}`);
      // Передаем текущий пазл в loadAndStartFinishHimPuzzle для перезапуска
      this.loadAndStartFinishHimPuzzle(this.state.activePuzzle);
    } else {
      logger.warn("[FinishHimController] Restart task called, but no active task to restart. Loading new one.");
      this.state.feedbackMessage = t('finishHim.feedback.noTaskToRestart'); // "Нет активного задания для перезапуска."
      this.loadAndStartFinishHimPuzzle(); // Загружаем новое задание, если текущего нет
    }
    this.requestRedraw();
  }

  public handleSetFen(): void {
    if (this.boardHandler.promotionCtrl.isActive()) this.boardHandler.promotionCtrl.cancel();
    if (this.boardHandler.isBoardConfiguredForAnalysis()) this.handleToggleAnalysisMode(false);

    const fen = prompt(t('puzzle.feedback.enterFenPrompt'), this.boardHandler.getFen());
    if (fen) {
      this.state.activePuzzle = null; // Сбрасываем текущее задание, так как FEN задается вручную
      this.state.interactiveSetupMoves = [];
      this.state.currentInteractiveSetupMoveIndex = 0;
      this.state.currentTaskPieceCount = this.countPiecesFromFen(fen);
      this.state.isStockfishThinking = false;
      this.state.gameOverMessage = null;
      this.state.isInPlayoutMode = false; 

      const humanPlayerColorBasedOnTurn = fen.includes(' w ') ? 'white' : 'black';
      this.boardHandler.setupPosition(fen, humanPlayerColorBasedOnTurn, true);
      this._updatePgnDisplay();

      if (this.checkAndSetGameOver()) return;
      
      this._enterPlayoutMode(); // Сразу переходим в режим доигрывания
      this.requestRedraw();
    }
  }

  public handleToggleAnalysisMode(forceValue?: boolean): void {
    if (this.boardHandler.promotionCtrl.isActive()) {
      logger.warn("[FinishHimController] Cannot toggle analysis mode during promotion.");
      this.state.feedbackMessage = t('puzzle.feedback.finishPromotionBeforeAnalysis');
      this.requestRedraw();
      return;
    }

    const currentAnalysisState = this.analysisService.getAnalysisStateForUI();
    const newAnalysisActiveState = typeof forceValue === 'boolean' ? forceValue : !currentAnalysisState.isActive;

    if (newAnalysisActiveState === currentAnalysisState.isActive) {
        if (typeof forceValue === 'boolean') this.requestRedraw();
        return;
    }

    if (newAnalysisActiveState) {
      logger.info("[FinishHimController] Activating Analysis Mode.");
      this.boardHandler.configureBoardForAnalysis(true);
      this.analysisService.startAnalysis(this.boardHandler.pgnService.getCurrentPath());
      this.state.feedbackMessage = t('puzzle.feedback.analysisModeActive');
      this.state.isStockfishThinking = false;
      this.state.isUserTurnContext = true;
    } else {
      logger.info("[FinishHimController] Deactivating Analysis Mode.");
      this.analysisService.stopAnalysis();
      this.boardHandler.configureBoardForAnalysis(false);

      if (!this.checkAndSetGameOver()) {
          if (this.state.isInPlayoutMode) {
             const currentBoardTurn = this.boardHandler.getBoardTurnColor();
             const humanColor = this.boardHandler.getHumanPlayerColor();
             this.state.isUserTurnContext = currentBoardTurn === humanColor;
             this.state.feedbackMessage = this.state.isUserTurnContext ? t('finishHim.feedback.yourTurnPlayout') : t('finishHim.feedback.systemToMovePlayout');
             if (!this.state.isUserTurnContext) this.triggerStockfishMoveInPlayoutIfNeeded();
          } else if (this.state.activePuzzle && this.state.currentInteractiveSetupMoveIndex < this.state.interactiveSetupMoves.length) {
            const currentBoardTurn = this.boardHandler.getBoardTurnColor();
            const humanColor = this.boardHandler.getHumanPlayerColor();
            this.state.isUserTurnContext = currentBoardTurn === humanColor;
            this.state.feedbackMessage = this.state.isUserTurnContext ? t('puzzle.feedback.yourTurn') : t('puzzle.feedback.systemMove');
            if (!this.state.isUserTurnContext) this._playNextInteractiveSetupMoveSystem(true);
          } else {
            this._enterPlayoutMode();
          }
      }
    }
    this._updatePgnDisplay();
    this.requestRedraw();
  }


  public handlePlayAnalysisMove(uciMove: string): void {
    if (!this.analysisService.getAnalysisStateForUI().isActive) {
      logger.warn('[FinishHimController] handlePlayAnalysisMove called, but analysis is not active.');
      this.state.feedbackMessage = t('puzzle.feedback.analysisInactiveForPlayMove');
      this.requestRedraw();
      return;
    }
    logger.info(`[FinishHimController] User requested to play analysis move: ${uciMove}`);
    this.analysisService.playMoveFromAnalysis(uciMove);
  }

  public handlePgnNavToStart(): void { if (this.boardHandler.handleNavigatePgnToStart()) { this._updatePgnDisplay(); this.requestRedraw(); } }
  public handlePgnNavBackward(): void { if (this.boardHandler.handleNavigatePgnBackward()) { this._updatePgnDisplay(); this.requestRedraw(); } }
  public handlePgnNavForward(variationIndex: number = 0): void { if (this.boardHandler.handleNavigatePgnForward(variationIndex)) { this._updatePgnDisplay(); this.requestRedraw(); } }
  public handlePgnNavToEnd(): void { if (this.boardHandler.handleNavigatePgnToEnd()) { this._updatePgnDisplay(); this.requestRedraw(); } }
  public canNavigatePgnBackward(): boolean { return this.boardHandler.canPgnNavigateBackward(); }
  public canNavigatePgnForward(variationIndex: number = 0): boolean { return this.boardHandler.canPgnNavigateForward(variationIndex); }

  public destroy(): void {
    logger.info('[FinishHimController] Destroying FinishHimController instance.');
    if (this.unsubscribeFromAnalysis) {
      this.unsubscribeFromAnalysis();
      this.unsubscribeFromAnalysis = null;
    }
  }
}