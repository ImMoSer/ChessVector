// src/features/puzzle/PuzzleController.ts
import type { Key } from 'chessground/types';
import type { ChessboardService } from '../../core/chessboard.service';
import type { WebhookService, AppPuzzle } from '../../core/webhook.service';
import type { StockfishService } from '../../core/stockfish.service';
import { BoardHandler } from '../../core/boardHandler'; 
import type { GameStatus, GameEndOutcome, AttemptMoveResult } from '../../core/boardHandler';
import { AnalysisService, type AnalysisStateForUI } from '../../core/analysis.service'; 
import logger from '../../utils/logger';
import { SoundService } from '../../core/sound.service';

interface PuzzleControllerState {
  activePuzzle: AppPuzzle | null;
  puzzleSolutionMoves: string[]; 
  currentSolutionMoveIndex: number; 

  isUserTurnInPuzzleContext: boolean; 
  feedbackMessage: string;
  isInPlayoutMode: boolean; 
  isStockfishThinking: boolean; 
  gameOverMessage: string | null; 
  
  currentPuzzlePieceCount: number; 
  currentPgnString: string; 
  analysisUiState: AnalysisStateForUI | null; 
}

export class PuzzleController {
  public state: PuzzleControllerState;
  public boardHandler: BoardHandler; 
  private analysisService: AnalysisService; 
  private webhookService: WebhookService; 
  private stockfishService: StockfishService; 
  private unsubscribeFromAnalysis: (() => void) | null = null; 

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
      puzzleSolutionMoves: [],
      currentSolutionMoveIndex: 0,
      isUserTurnInPuzzleContext: false,
      feedbackMessage: "Load a puzzle to start.",
      isInPlayoutMode: false,
      isStockfishThinking: false,
      gameOverMessage: null,
      currentPuzzlePieceCount: 0,
      currentPgnString: "",
      analysisUiState: null, 
    };
    logger.info('[PuzzleController] Initialized with AnalysisService.');
    
    this.boardHandler.onMoveMade(() => this._updatePgnDisplay());
    this.boardHandler.onPgnNavigated(() => this._updatePgnDisplay());

    this.unsubscribeFromAnalysis = this.analysisService.subscribeToAnalysisUpdates((analysisState) => {
        this.state.analysisUiState = analysisState;
        this.requestRedraw();
    });
  }

  public initializeGame(): void {
    this.loadAndStartPuzzle();
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
      return `Мат! ${outcome.winner === 'white' ? 'Белые' : 'Черные'} победили (${outcome.reason || 'мат'}).`;
    }
    switch (outcome.reason) {
      case 'stalemate': return "Пат! Ничья.";
      case 'insufficient_material': return "Ничья (недостаточно материала).";
      case 'draw': return "Ничья (троекратное повторение, правило 50 ходов, или по соглашению).";
      default: return `Ничья (${outcome.reason || 'неизвестная причина'}).`;
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
      this.state.feedbackMessage = this.state.gameOverMessage || "Игра окончена.";
      this.state.isUserTurnInPuzzleContext = false; 
      this.state.isStockfishThinking = false;
      logger.info(`[PuzzleController] Game over detected. Message: ${this.state.gameOverMessage}`);
      
      if (this.state.activePuzzle && gameStatus.outcome?.reason !== 'stalemate') {
        const humanColor = this.boardHandler.getHumanPlayerColor();
        if (gameStatus.outcome?.winner && humanColor) {
          if (gameStatus.outcome.winner === humanColor) {
            SoundService.playSound('puzzle_user_won');
          } else {
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

  public async loadAndStartPuzzle(): Promise<void> {
    if (this.boardHandler.promotionCtrl.isActive()) {
      this.boardHandler.promotionCtrl.cancel();
    }
    if (this.boardHandler.isBoardConfiguredForAnalysis()) {
        this.handleToggleAnalysisMode(false); 
    }

    logger.info("[PuzzleController] Loading new puzzle...");
    this.state = { 
        ...this.state, 
        activePuzzle: null,
        puzzleSolutionMoves: [],
        currentSolutionMoveIndex: 0,
        isUserTurnInPuzzleContext: false,
        feedbackMessage: "Загрузка пазла...",
        isInPlayoutMode: false,
        isStockfishThinking: false,
        gameOverMessage: null,
        currentPuzzlePieceCount: 0,
        currentPgnString: "",
        analysisUiState: this.analysisService.getAnalysisStateForUI(), 
    };
    this.requestRedraw();

    const puzzleData = await this.webhookService.fetchPuzzle();
    if (puzzleData) {
      this.state.activePuzzle = puzzleData;
      this.state.puzzleSolutionMoves = puzzleData.Moves ? puzzleData.Moves.split(' ') : [];
      this.state.currentSolutionMoveIndex = 0;
      this.state.currentPuzzlePieceCount = this.countPiecesFromFen(puzzleData.FEN_0);

      this.boardHandler.setupPosition(puzzleData.FEN_0, puzzleData.HumanColor, true);

      logger.info(`[PuzzleController] Puzzle loaded: ${puzzleData.PuzzleId}. Initial FEN: ${this.boardHandler.getFen()}. Pieces: ${this.state.currentPuzzlePieceCount}`);
      logger.info(`[PuzzleController] Human player color: ${this.boardHandler.getHumanPlayerColor()}. Solution moves: ${this.state.puzzleSolutionMoves.join(' ')}`);
      
      this.state.feedbackMessage = `Пазл ${puzzleData.PuzzleId}. Вы играете за ${this.boardHandler.getHumanPlayerColor() === 'white' ? 'белых' : 'черных'}.`;

      if (this.checkAndSetGameOver()) return; 

      const initialTurnColorInPuzzle = this.boardHandler.getBoardTurnColor();
      const humanColor = this.boardHandler.getHumanPlayerColor();

      if (this.state.puzzleSolutionMoves.length > 0) {
        if (initialTurnColorInPuzzle !== humanColor) {
          logger.info("[PuzzleController] System makes the first solution move.");
          this.state.isUserTurnInPuzzleContext = false;
          this.state.feedbackMessage = "Ход системы...";
          this.requestRedraw();
          setTimeout(() => this.playNextSolutionMoveInternal(false), 750);
        } else {
          this.state.isUserTurnInPuzzleContext = true;
          this.state.feedbackMessage = `Ваш ход.`;
          logger.info(`[PuzzleController] Puzzle starts with user's turn.`);
          this.requestRedraw();
        }
      } else { 
        logger.warn("[PuzzleController] Puzzle has no moves in solution string!");
        this.state.isUserTurnInPuzzleContext = initialTurnColorInPuzzle === humanColor;
        this.state.feedbackMessage = this.state.isUserTurnInPuzzleContext ? "Ваш ход (прямое решение?)." : "Ход системы (прямое решение?).";
        this.requestRedraw();
        if (!this.state.isUserTurnInPuzzleContext && !this.state.gameOverMessage) {
          if (!this.state.isInPlayoutMode) {
            this.state.isInPlayoutMode = true; 
            SoundService.playSound('puzzle_playout_start');
          }
          this.triggerStockfishMoveInPlayoutIfNeeded();
        }
      }
    } else {
      logger.error("[PuzzleController] Failed to load puzzle.");
      this.state.feedbackMessage = "Не удалось загрузить пазл.";
      this.requestRedraw();
    }
  }

  private async triggerStockfishMoveInPlayoutIfNeeded(): Promise<void> {
    if (this.state.gameOverMessage || this.boardHandler.promotionCtrl.isActive() || this.boardHandler.isBoardConfiguredForAnalysis()) {
      return;
    }
    const currentBoardTurn = this.boardHandler.getBoardTurnColor();
    const humanColor = this.boardHandler.getHumanPlayerColor();

    if (this.state.isInPlayoutMode && currentBoardTurn !== humanColor && !this.state.isStockfishThinking) {
      logger.info(`[PuzzleController] Triggering Stockfish move in playout. FEN: ${this.boardHandler.getFen()}`);
      this.state.isStockfishThinking = true;
      this.state.feedbackMessage = "Stockfish думает...";
      this.requestRedraw();

      try {
        const stockfishMoveUci = await this.stockfishService.getBestMoveOnly(this.boardHandler.getFen(), { depth: 12 });
        this.state.isStockfishThinking = false;

        if (stockfishMoveUci) {
          logger.info(`[PuzzleController] Stockfish auto-move in playout: ${stockfishMoveUci}`);
          const moveResult: AttemptMoveResult = this.boardHandler.applySystemMove(stockfishMoveUci);
          if (moveResult.success) {
            if (!this.checkAndSetGameOver()) {
              this.state.feedbackMessage = "Ваш ход.";
              this.state.isUserTurnInPuzzleContext = true;
            }
          } else {
            logger.error("[PuzzleController] Stockfish (auto) made an illegal move or FEN update failed:", stockfishMoveUci);
            this.state.feedbackMessage = "Ошибка Stockfish. Ваш ход.";
            this.state.isUserTurnInPuzzleContext = true; 
          }
        } else { 
          logger.warn("[PuzzleController] Stockfish (auto) did not return a move in playout.");
          if (!this.checkAndSetGameOver()) { 
            this.state.feedbackMessage = "Stockfish не нашел хода. Ваш ход.";
            this.state.isUserTurnInPuzzleContext = true;
          }
        }
      } catch (error) {
        this.state.isStockfishThinking = false;
        logger.error("[PuzzleController] Error during Stockfish auto-move in playout:", error);
        if (!this.checkAndSetGameOver()) {
          this.state.feedbackMessage = "Ошибка при получении хода от Stockfish. Ваш ход.";
          this.state.isUserTurnInPuzzleContext = true;
        }
      }
      this.requestRedraw();
    }
  }

  private playNextSolutionMoveInternal(isContinuation: boolean = false): void {
    if (this.state.gameOverMessage || this.boardHandler.promotionCtrl.isActive() || this.boardHandler.isBoardConfiguredForAnalysis()) return;
    
    if (!this.state.activePuzzle || this.state.currentSolutionMoveIndex >= this.state.puzzleSolutionMoves.length) {
      if (this.state.activePuzzle) { 
        logger.info("[PuzzleController] Puzzle solution completed. Entering play out mode.");
        if (!this.state.isInPlayoutMode) {
            this.state.isInPlayoutMode = true;
            SoundService.playSound('puzzle_playout_start');
        }
        this.state.feedbackMessage = "Пазл решен! Можете продолжать игру.";
        if (!this.checkAndSetGameOver()) { 
          this.state.isUserTurnInPuzzleContext = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();
          if (!this.state.isUserTurnInPuzzleContext) {
            this.triggerStockfishMoveInPlayoutIfNeeded();
          }
        }
      } else {
        logger.warn("[PuzzleController playNextSolutionMoveInternal] No active puzzle.");
      }
      this.requestRedraw();
      return;
    }

    const uciSolutionMove = this.state.puzzleSolutionMoves[this.state.currentSolutionMoveIndex];
    logger.info(`[PuzzleController] SystemPlayer playing solution move ${this.state.currentSolutionMoveIndex + 1}/${this.state.puzzleSolutionMoves.length}: ${uciSolutionMove}`);
    this.state.feedbackMessage = isContinuation ? `Система отвечает: ${uciSolutionMove}` : `Первый ход системы: ${uciSolutionMove}`;
    this.requestRedraw();

    const moveResult: AttemptMoveResult = this.boardHandler.applySystemMove(uciSolutionMove);

    if (moveResult.success) {
      this.state.currentSolutionMoveIndex++;
      if (this.checkAndSetGameOver()) return; 

      if (this.state.currentSolutionMoveIndex >= this.state.puzzleSolutionMoves.length) { 
        logger.info("[PuzzleController] SYSTEM COMPLETED PUZZLE SOLUTION!");
        if (!this.state.isInPlayoutMode) {
            this.state.isInPlayoutMode = true;
            SoundService.playSound('puzzle_playout_start');
        }
        this.state.feedbackMessage = "Пазл решен! Можете продолжать игру.";
        this.state.isUserTurnInPuzzleContext = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();
        if (!this.state.isUserTurnInPuzzleContext && !this.state.gameOverMessage) {
          this.triggerStockfishMoveInPlayoutIfNeeded();
        }
      } else { 
        this.state.isUserTurnInPuzzleContext = true;
        this.state.feedbackMessage = `Ваш ход.`;
      }
    } else {
      logger.error(`[PuzzleController] Failed to apply solution move ${uciSolutionMove} from BoardHandler. Result: ${JSON.stringify(moveResult)}`);
      this.state.feedbackMessage = "Ошибка в данных пазла. Ход системы не удался.";
      this.state.isUserTurnInPuzzleContext = true; 
    }
    this.requestRedraw();
  }

  public async handleUserMove(orig: Key, dest: Key): Promise<void> {
    if (this.state.gameOverMessage && !this.boardHandler.isBoardConfiguredForAnalysis()) { 
        logger.warn("[PuzzleController handleUserMove] Move ignored: game over and not in analysis config.");
        return;
    }
    if (this.boardHandler.promotionCtrl.isActive()) {
        logger.warn("[PuzzleController handleUserMove] Move ignored: promotion active.");
        this.state.feedbackMessage = "Выберите фигуру для превращения.";
        this.requestRedraw();
        return;
    }
    if (this.state.isStockfishThinking && !this.boardHandler.isBoardConfiguredForAnalysis()) { 
        logger.warn("[PuzzleController handleUserMove] User attempted to move while Stockfish is thinking (non-analysis).");
        this.state.feedbackMessage = "Stockfish думает, пожалуйста, подождите...";
        this.requestRedraw();
        return;
    }

    const moveResult: AttemptMoveResult = await this.boardHandler.attemptUserMove(orig, dest);

    if (this.boardHandler.isBoardConfiguredForAnalysis()) {
        logger.info(`[PuzzleController] User move in analysis config: ${orig}-${dest}. Result: ${JSON.stringify(moveResult)}`);
        if (moveResult.success && moveResult.uciMove) {
            this.state.feedbackMessage = `Ход ${moveResult.sanMove || moveResult.uciMove} сделан. FEN: ${this.boardHandler.getFen()}`; 
            this.state.currentPuzzlePieceCount = this.countPiecesFromFen(this.boardHandler.getFen());
        } else if (moveResult.promotionStarted && !moveResult.promotionCompleted) {
            this.state.feedbackMessage = "Превращение отменено.";
        } else if (moveResult.isIllegal) {
            this.state.feedbackMessage = "Нелегальный ход в режиме анализа.";
        } else {
            this.state.feedbackMessage = "Ошибка хода в режиме анализа.";
        }
        this.requestRedraw();
        return;
    }

    if (moveResult.success && moveResult.uciMove) {
      if (moveResult.promotionStarted && !moveResult.promotionCompleted) {
        // This case implies promotion was cancelled by user selection (e.g. null role)
        // The attemptUserMove in BoardHandler already resolved the promise for this.
        // Feedback message for cancellation is handled there or here.
        logger.info("[PuzzleController handleUserMove] Promotion was cancelled during selection.");
        this.state.feedbackMessage = "Превращение отменено.";
      } else { // Promotion completed or not a promotion move
        logger.info(`[PuzzleController handleUserMove] User move ${moveResult.uciMove} successful. Processing result...`);
        this.processUserMoveResult(moveResult.uciMove);
      }
    } else if (moveResult.promotionStarted && !moveResult.success && !moveResult.promotionCompleted) {
      // This case is for when promotion dialog is shown, but user clicks outside or cancels.
      logger.info("[PuzzleController handleUserMove] Promotion was cancelled by user (dialog closed).");
      this.state.feedbackMessage = "Превращение отменено.";
    } else if (!moveResult.success) {
      logger.warn(`[PuzzleController handleUserMove] User move ${orig}-${dest} failed. Result: ${JSON.stringify(moveResult)}`);
      this.state.feedbackMessage = moveResult.isIllegal ? "Неверный ход." : "Ошибка обработки хода.";
    }
    this.requestRedraw();
  }

  private processUserMoveResult(uciUserMove: string): void {
    logger.info(`[PuzzleController processUserMoveResult] Processing user move: ${uciUserMove}. Current FEN: ${this.boardHandler.getFen()}`);
    this.state.currentPuzzlePieceCount = this.countPiecesFromFen(this.boardHandler.getFen());
    
    if (this.checkAndSetGameOver()) { 
      logger.info(`[PuzzleController processUserMoveResult] Game over after user move ${uciUserMove}.`);
      return;
    }

    if (this.state.isInPlayoutMode) {
      logger.info(`[PuzzleController processUserMoveResult] User move in playout mode: ${uciUserMove}`);
      this.state.isUserTurnInPuzzleContext = false; 
      this.requestRedraw();
      this.triggerStockfishMoveInPlayoutIfNeeded();
      return;
    }

    if (!this.state.activePuzzle) {
      logger.warn("[PuzzleController processUserMoveResult] No active puzzle. Entering playout mode.");
      this.state.isInPlayoutMode = true; 
      this.state.isUserTurnInPuzzleContext = false;
      this.triggerStockfishMoveInPlayoutIfNeeded();
      this.requestRedraw();
      return;
    }

    if (!this.state.isUserTurnInPuzzleContext) {
      logger.warn("[PuzzleController processUserMoveResult] User move processed, but it was not user's turn. Undoing.");
      this.state.feedbackMessage = "Не ваш ход. Ход отменен.";
      this.boardHandler.undoLastMove(); 
      this.requestRedraw();
      return;
    }

    const expectedSolutionMove = this.state.puzzleSolutionMoves[this.state.currentSolutionMoveIndex];

    if (uciUserMove === expectedSolutionMove) {
      logger.info(`[PuzzleController processUserMoveResult] User move ${uciUserMove} is CORRECT!`);
      this.state.feedbackMessage = "Верно!";
      this.state.currentSolutionMoveIndex++;
      this.state.isUserTurnInPuzzleContext = false; 

      if (this.checkAndSetGameOver()) return; 

      if (this.state.currentSolutionMoveIndex >= this.state.puzzleSolutionMoves.length) { 
        logger.info("[PuzzleController processUserMoveResult] USER COMPLETED PUZZLE SOLUTION!");
         if (!this.state.isInPlayoutMode) {
            this.state.isInPlayoutMode = true;
            SoundService.playSound('puzzle_playout_start');
        }
        this.state.feedbackMessage = "Пазл решен! Можете продолжать игру.";
        this.state.isUserTurnInPuzzleContext = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();
        if (!this.state.isUserTurnInPuzzleContext && !this.state.gameOverMessage) {
          this.triggerStockfishMoveInPlayoutIfNeeded();
        }
      } else { 
        this.state.feedbackMessage = "Ход системы...";
        logger.info(`[PuzzleController processUserMoveResult] Scheduling system's solution move: ${this.state.puzzleSolutionMoves[this.state.currentSolutionMoveIndex]} (index ${this.state.currentSolutionMoveIndex}).`);
        setTimeout(() => {
          this.playNextSolutionMoveInternal(true); 
        }, 300); 
      }
    } else { 
      logger.warn(`[PuzzleController processUserMoveResult] User move ${uciUserMove} is INCORRECT. Expected: ${expectedSolutionMove}. Undoing user's move.`);
      this.state.feedbackMessage = `Неверно. Ожидался ход ${expectedSolutionMove}. Попробуйте еще раз.`;
      if (this.boardHandler.undoLastMove()) {
        logger.info(`[PuzzleController processUserMoveResult] Incorrect user move ${uciUserMove} was undone. FEN is now: ${this.boardHandler.getFen()}`);
        this.state.currentPuzzlePieceCount = this.countPiecesFromFen(this.boardHandler.getFen());
      } else {
        logger.error(`[PuzzleController processUserMoveResult] Failed to undo incorrect user move ${uciUserMove}.`);
      }
      this.state.isUserTurnInPuzzleContext = true; 
    }
    this.requestRedraw();
  }

  public handleSetFen(): void {
    if (this.boardHandler.promotionCtrl.isActive()) {
      this.boardHandler.promotionCtrl.cancel();
    }
    if (this.boardHandler.isBoardConfiguredForAnalysis()) {
        logger.info("[PuzzleController] Set FEN called while analysis config is active. Deactivating analysis config.");
        this.handleToggleAnalysisMode(false); 
    }

    const fen = prompt("Введите FEN:", this.boardHandler.getFen());
    if (fen) {
      this.state.activePuzzle = null; 
      this.state.puzzleSolutionMoves = [];
      this.state.currentSolutionMoveIndex = 0;
      this.state.currentPuzzlePieceCount = this.countPiecesFromFen(fen);
      if (!this.state.isInPlayoutMode) { 
        this.state.isInPlayoutMode = true;
        SoundService.playSound('puzzle_playout_start');
      }
      this.state.isStockfishThinking = false;
      this.state.gameOverMessage = null;

      const humanPlayerColorBasedOnTurn = fen.includes(' w ') ? 'white' : 'black';
      this.boardHandler.setupPosition(fen, humanPlayerColorBasedOnTurn, true); 
      
      if (this.checkAndSetGameOver()) return;

      this.state.isUserTurnInPuzzleContext = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();
      logger.info(`[PuzzleController handleSetFen] FEN set. Pieces: ${this.state.currentPuzzlePieceCount}. isUserTurnInPuzzleContext: ${this.state.isUserTurnInPuzzleContext}`);

      if (!this.state.isUserTurnInPuzzleContext && !this.state.gameOverMessage) {
        this.state.feedbackMessage = "FEN установлен. Ход Stockfish.";
        this.triggerStockfishMoveInPlayoutIfNeeded();
      } else if (this.state.isUserTurnInPuzzleContext && !this.state.gameOverMessage) {
        this.state.feedbackMessage = "FEN установлен. Ваш ход.";
      } 
      this.requestRedraw();
    }
  }

  public handleRestartPuzzle(): void {
    if (this.boardHandler.promotionCtrl.isActive()) {
      this.boardHandler.promotionCtrl.cancel();
    }
    if (this.boardHandler.isBoardConfiguredForAnalysis()) {
        logger.info("[PuzzleController] Restart Puzzle called while analysis config is active. Deactivating analysis config.");
        this.handleToggleAnalysisMode(false); 
    }

    if (this.state.activePuzzle) {
      logger.info(`[PuzzleController] Restarting puzzle: ${this.state.activePuzzle.PuzzleId}`);
      const puzzleToRestart = this.state.activePuzzle; 

      this.state.puzzleSolutionMoves = puzzleToRestart.Moves ? puzzleToRestart.Moves.split(' ') : [];
      this.state.currentSolutionMoveIndex = 0;
      this.state.isInPlayoutMode = false;
      this.state.isStockfishThinking = false;
      this.state.gameOverMessage = null;
      this.state.currentPuzzlePieceCount = this.countPiecesFromFen(puzzleToRestart.FEN_0);

      this.boardHandler.setupPosition(puzzleToRestart.FEN_0, puzzleToRestart.HumanColor, true);
      
      this.state.feedbackMessage = `Пазл ${puzzleToRestart.PuzzleId} перезапущен. Вы играете за ${this.boardHandler.getHumanPlayerColor() === 'white' ? 'белых' : 'черных'}.`;

      if (this.checkAndSetGameOver()) return;

      const initialTurnColorInPuzzle = this.boardHandler.getBoardTurnColor();
      const humanColor = this.boardHandler.getHumanPlayerColor();

      if (this.state.puzzleSolutionMoves.length > 0) {
        if (initialTurnColorInPuzzle !== humanColor) {
          this.state.isUserTurnInPuzzleContext = false;
          this.state.feedbackMessage = "Ход системы...";
          this.requestRedraw();
          setTimeout(() => this.playNextSolutionMoveInternal(false), 50); 
        } else {
          this.state.isUserTurnInPuzzleContext = true;
          this.state.feedbackMessage = `Ваш ход.`;
          this.requestRedraw();
        }
      } else { 
        this.state.isUserTurnInPuzzleContext = initialTurnColorInPuzzle === humanColor;
        this.state.feedbackMessage = this.state.isUserTurnInPuzzleContext ? "Ваш ход (прямое решение?)." : "Ход системы (прямое решение?).";
        this.requestRedraw();
        if (!this.state.isUserTurnInPuzzleContext && !this.state.gameOverMessage) {
          if (!this.state.isInPlayoutMode) {
            this.state.isInPlayoutMode = true;
            SoundService.playSound('puzzle_playout_start');
          }
          this.triggerStockfishMoveInPlayoutIfNeeded();
        }
      }
    } else {
      logger.warn("[PuzzleController] Restart puzzle called, but no active puzzle to restart.");
      this.state.feedbackMessage = "Нет активного пазла для перезапуска. Сначала загрузите пазл.";
      this.requestRedraw();
    }
  }

  public handleToggleAnalysisMode(forceValue?: boolean): void {
    if (this.boardHandler.promotionCtrl.isActive()) {
      logger.warn("[PuzzleController] Cannot toggle analysis mode during promotion.");
      this.state.feedbackMessage = "Завершите превращение пешки перед анализом.";
      this.requestRedraw();
      return;
    }

    const currentAnalysisState = this.analysisService.getAnalysisStateForUI();
    const newAnalysisActiveState = typeof forceValue === 'boolean' ? forceValue : !currentAnalysisState.isActive;

    if (newAnalysisActiveState === currentAnalysisState.isActive) {
        logger.info(`[PuzzleController] Analysis mode already in desired state: ${newAnalysisActiveState}`);
        if (typeof forceValue === 'boolean') this.requestRedraw(); 
        return;
    }
    
    if (newAnalysisActiveState) { 
      logger.info("[PuzzleController] Activating Analysis Mode via AnalysisService.");
      this.analysisService.startAnalysis(this.boardHandler.pgnService.getCurrentPath()); 
      this.state.feedbackMessage = "Режим анализа активен. Делайте ходы или используйте PGN навигацию.";
      this.state.isStockfishThinking = false; 
    } else { 
      logger.info("[PuzzleController] Deactivating Analysis Mode via AnalysisService.");
      this.analysisService.stopAnalysis();
      
      // Restore puzzle/playout context after analysis stops
      // This logic might need refinement based on desired behavior when exiting analysis.
      // For now, it tries to determine if it should be user's turn or system's.
      if (!this.checkAndSetGameOver()) { 
          this.state.isUserTurnInPuzzleContext = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();

          if (this.state.isInPlayoutMode) { 
              this.state.feedbackMessage = this.state.isUserTurnInPuzzleContext ? "Ваш ход (доигрывание)." : "Ход системы (доигрывание)...";
              if(!this.state.isUserTurnInPuzzleContext) this.triggerStockfishMoveInPlayoutIfNeeded();
          } else if (this.state.activePuzzle) { 
              const currentPgnNode = this.boardHandler.pgnService.getCurrentNode();
              let solutionMatch = true;
              let tempNode = currentPgnNode;
              let tempSolutionIndex = currentPgnNode.ply -1; 

              while(tempNode.parent && tempSolutionIndex >= 0) {
                if (tempSolutionIndex >= this.state.puzzleSolutionMoves.length || tempNode.uci !== this.state.puzzleSolutionMoves[tempSolutionIndex]) {
                    solutionMatch = false;
                    break;
                }
                tempSolutionIndex--;
                tempNode = tempNode.parent;
              }
              if (solutionMatch && tempNode !== this.boardHandler.pgnService.getRootNode() && currentPgnNode.ply > 0) {
                if (currentPgnNode.ply > 0) solutionMatch = false;
              }

              if (solutionMatch && currentPgnNode.ply < this.state.puzzleSolutionMoves.length) {
                this.state.currentSolutionMoveIndex = currentPgnNode.ply; 
                this.state.feedbackMessage = this.state.isUserTurnInPuzzleContext ? "Ваш ход." : "Ход системы...";
                if(!this.state.isUserTurnInPuzzleContext) this.playNextSolutionMoveInternal(true);

              } else { 
                this.state.isInPlayoutMode = true; 
                this.state.feedbackMessage = this.state.isUserTurnInPuzzleContext ? "Ваш ход (доигрывание из варианта)." : "Ход системы (доигрывание из варианта)...";
                if (currentPgnNode.ply >= this.state.puzzleSolutionMoves.length && solutionMatch && this.state.activePuzzle) {
                    this.state.feedbackMessage = "Пазл решен! Можете продолжать игру."; 
                }
                if(!this.state.isUserTurnInPuzzleContext) this.triggerStockfishMoveInPlayoutIfNeeded();
              }
          } else { 
              this.state.feedbackMessage = this.state.isUserTurnInPuzzleContext ? "Ваш ход." : "Ход системы...";
              if(!this.state.isUserTurnInPuzzleContext) this.triggerStockfishMoveInPlayoutIfNeeded();
          }
      }
    }
    this._updatePgnDisplay(); 
    this.requestRedraw();
  }

  /**
   * Handles a request to play a move from an analysis line.
   * @param uciMove The UCI string of the move to play.
   */
  public handlePlayAnalysisMove(uciMove: string): void {
    if (!this.analysisService.getAnalysisStateForUI().isActive) {
      logger.warn('[PuzzleController] handlePlayAnalysisMove called, but analysis is not active.');
      this.state.feedbackMessage = "Анализ не активен для проигрывания хода.";
      this.requestRedraw();
      return;
    }
    logger.info(`[PuzzleController] User requested to play analysis move: ${uciMove}`);
    this.analysisService.playMoveFromAnalysis(uciMove);
    // AnalysisService will trigger a new analysis after the move is made via BoardHandler events.
    // Feedback and PGN will update through existing event chain.
  }

  public handlePgnNavToStart(): void {
    if (this.boardHandler.handleNavigatePgnToStart()) {
      if (this.analysisService.getAnalysisStateForUI().isActive) { 
        logger.info(`[PuzzleController] PGN Nav: Start. FEN on board: ${this.boardHandler.getFen()}`);
      }
      this.requestRedraw();
    }
  }

  public handlePgnNavBackward(): void {
    if (this.boardHandler.handleNavigatePgnBackward()) {
      if (this.analysisService.getAnalysisStateForUI().isActive) {
        logger.info(`[PuzzleController] PGN Nav: Backward. FEN on board: ${this.boardHandler.getFen()}`);
      }
      this.requestRedraw();
    }
  }

  public handlePgnNavForward(variationIndex: number = 0): void {
    if (this.boardHandler.handleNavigatePgnForward(variationIndex)) {
      if (this.analysisService.getAnalysisStateForUI().isActive) {
        logger.info(`[PuzzleController] PGN Nav: Forward (Var ${variationIndex}). FEN on board: ${this.boardHandler.getFen()}`);
      }
      this.requestRedraw();
    }
  }

  public handlePgnNavToEnd(): void {
    if (this.boardHandler.handleNavigatePgnToEnd()) {
      if (this.analysisService.getAnalysisStateForUI().isActive) {
        logger.info(`[PuzzleController] PGN Nav: End. FEN on board: ${this.boardHandler.getFen()}`);
      }
      this.requestRedraw();
    }
  }

  public canNavigatePgnBackward(): boolean {
    return this.boardHandler.canPgnNavigateBackward();
  }

  public canNavigatePgnForward(variationIndex: number = 0): boolean {
    return this.boardHandler.canPgnNavigateForward(variationIndex);
  }

  public destroy(): void {
    logger.info('[PuzzleController] Destroying PuzzleController instance.');
    if (this.unsubscribeFromAnalysis) {
      this.unsubscribeFromAnalysis();
      this.unsubscribeFromAnalysis = null;
    }
  }
}
