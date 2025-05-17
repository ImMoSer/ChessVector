// src/features/puzzle/PuzzleController.ts
import type { Key } from 'chessground/types';
import type { ChessboardService } from '../../core/chessboard.service';
import type { WebhookService, AppPuzzle } from '../../core/webhook.service';
import type { StockfishService } from '../../core/stockfish.service';
import { BoardHandler } from '../../core/boardHandler';
import type { GameStatus, GameEndOutcome, AttemptMoveResult } from '../../core/boardHandler';
import logger from '../../utils/logger';
import { SoundService } from '../../core/sound.service';

interface PuzzleControllerState {
  activePuzzle: AppPuzzle | null;
  puzzleSolutionMoves: string[];
  currentSolutionMoveIndex: number;
  isUserTurnInPuzzle: boolean;
  feedbackMessage: string;
  isInPlayOutMode: boolean;
  isStockfishThinking: boolean;
  gameOverMessage: string | null;
  isAnalysisModeActive: boolean;
  currentPuzzlePieceCount: number; // New state for piece count
}

export class PuzzleController {
  public state: PuzzleControllerState;
  public boardHandler: BoardHandler;

  constructor(
    public chessboardService: ChessboardService,
    boardHandler: BoardHandler,
    private webhookService: WebhookService,
    private stockfishService: StockfishService,
    public requestRedraw: () => void,
  ) {
    this.boardHandler = boardHandler;
    this.state = {
      activePuzzle: null,
      puzzleSolutionMoves: [],
      currentSolutionMoveIndex: 0,
      isUserTurnInPuzzle: false,
      feedbackMessage: "Load a puzzle to start.", // Translated
      isInPlayOutMode: false,
      isStockfishThinking: false,
      gameOverMessage: null,
      isAnalysisModeActive: false,
      currentPuzzlePieceCount: 0, // Initialize piece count
    };
    logger.info('[PuzzleController] Initialized with BoardHandler.');
  }

  public initializeGame(): void {
    this.loadAndStartPuzzle();
  }

  /**
   * Calculates the number of pieces from a FEN string.
   * @param fen The FEN string.
   * @returns The total number of pieces on the board.
   */
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
      return `Checkmate! ${outcome.winner === 'white' ? 'White' : 'Black'} won (${outcome.reason || 'checkmate'}).`; // Translated
    }
    switch (outcome.reason) {
      case 'stalemate': return "Stalemate! It's a draw."; // Translated
      case 'insufficient_material': return "Draw (insufficient material)."; // Translated
      case 'draw': return "Draw (threefold repetition, 50-move rule, or agreement)."; // Translated
      default: return `Draw (${outcome.reason || 'unknown reason'}).`; // Translated
    }
  }

  private checkAndSetGameOver(): boolean {
    const gameStatus: GameStatus = this.boardHandler.getGameStatus();
    if (gameStatus.isGameOver) {
      this.state.gameOverMessage = this.formatGameEndMessage(gameStatus.outcome);
      this.state.feedbackMessage = this.state.gameOverMessage || "Game over."; // Translated
      this.state.isUserTurnInPuzzle = false;
      this.state.isStockfishThinking = false;
      logger.info(`[PuzzleController] Game over detected by BoardHandler. Message: ${this.state.gameOverMessage}`);

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
    if (this.state.isAnalysisModeActive) {
        this.state.isAnalysisModeActive = false;
        this.chessboardService.ground?.set({
            movable: {
                free: false,
                color: this.boardHandler.getBoardTurnColor(),
                dests: this.boardHandler.getPossibleMoves(),
            }
        });
    }

    logger.info("[PuzzleController] Loading new puzzle...");
    this.state.feedbackMessage = "Loading puzzle..."; // Translated
    this.state.isInPlayOutMode = false;
    this.state.isStockfishThinking = false;
    this.state.gameOverMessage = null;
    this.state.currentPuzzlePieceCount = 0; // Reset piece count
    this.requestRedraw();

    const puzzleData = await this.webhookService.fetchPuzzle();
    if (puzzleData) {
      this.state.activePuzzle = puzzleData;
      this.state.puzzleSolutionMoves = puzzleData.Moves ? puzzleData.Moves.split(' ') : [];
      this.state.currentSolutionMoveIndex = 0;
      this.state.currentPuzzlePieceCount = this.countPiecesFromFen(puzzleData.FEN_0); // Calculate piece count

      this.boardHandler.setupPosition(puzzleData.FEN_0, puzzleData.HumanColor, true);

      logger.info(`[PuzzleController] Puzzle loaded: ${puzzleData.PuzzleId}. Initial FEN: ${this.boardHandler.getFen()}. Pieces: ${this.state.currentPuzzlePieceCount}`);
      logger.info(`[PuzzleController] Human player color: ${this.boardHandler.getHumanPlayerColor()}. Solution moves: ${this.state.puzzleSolutionMoves.join(' ')}`);

      this.state.feedbackMessage = `Puzzle ${puzzleData.PuzzleId}. You play as ${this.boardHandler.getHumanPlayerColor() || 'N/A'}.`; // Translated

      if (this.checkAndSetGameOver()) return;

      const initialTurnColorInPuzzle = this.boardHandler.getBoardTurnColor();
      const humanColor = this.boardHandler.getHumanPlayerColor();

      if (this.state.puzzleSolutionMoves.length > 0) {
        if (initialTurnColorInPuzzle !== humanColor) {
          logger.info("[PuzzleController] System makes the first solution move.");
          this.state.isUserTurnInPuzzle = false;
          this.state.feedbackMessage = "System's turn..."; // Translated
          this.requestRedraw();
          setTimeout(() => this.playNextSolutionMoveInternal(false), 750);
        } else {
          this.state.isUserTurnInPuzzle = true;
          this.state.feedbackMessage = `Your turn.`; // Translated
          logger.info(`[PuzzleController] Puzzle starts with user's turn.`);
          this.requestRedraw();
        }
      } else {
        logger.warn("[PuzzleController] Puzzle has no moves in solution string! Setting user turn if applicable.");
        this.state.isUserTurnInPuzzle = initialTurnColorInPuzzle === humanColor;
        this.state.feedbackMessage = this.state.isUserTurnInPuzzle ? "Your turn (puzzle has no solution?)." : "System's turn (puzzle has no solution?)."; // Translated
        this.requestRedraw();
        if (!this.state.isUserTurnInPuzzle && !this.state.gameOverMessage) {
          if (!this.state.isInPlayOutMode) {
            this.state.isInPlayOutMode = true;
            SoundService.playSound('puzzle_playout_start');
          }
          this.triggerStockfishMoveInPlayoutIfNeeded();
        }
      }
    } else {
      logger.error("[PuzzleController] Failed to load puzzle.");
      this.state.feedbackMessage = "Failed to load puzzle."; // Translated
      this.requestRedraw();
    }
  }

  private async triggerStockfishMoveInPlayoutIfNeeded(): Promise<void> {
    if (this.state.gameOverMessage || this.boardHandler.promotionCtrl.isActive() || this.state.isAnalysisModeActive) {
      logger.info("[PuzzleController] Game is over, promotion is active, or analysis mode is active. Stockfish will not move.");
      return;
    }

    const currentBoardTurn = this.boardHandler.getBoardTurnColor();
    const humanColor = this.boardHandler.getHumanPlayerColor();

    if (this.state.isInPlayOutMode && currentBoardTurn !== humanColor && !this.state.isStockfishThinking) {
      logger.info(`[PuzzleController] Triggering Stockfish move in playout. FEN: ${this.boardHandler.getFen()}`);
      this.state.isStockfishThinking = true;
      this.state.feedbackMessage = "Stockfish is thinking..."; // Translated
      this.requestRedraw();

      try {
        const stockfishMoveUci = await this.stockfishService.getBestMoveOnly(this.boardHandler.getFen(), { depth: 12 });
        this.state.isStockfishThinking = false;

        if (stockfishMoveUci) {
          logger.info(`[PuzzleController] Stockfish auto-move in playout: ${stockfishMoveUci}`);
          const moveResult: AttemptMoveResult = this.boardHandler.applySystemMove(stockfishMoveUci);
          if (moveResult.success) {
            if (!this.checkAndSetGameOver()) {
              this.state.feedbackMessage = "Your turn."; // Translated
              this.state.isUserTurnInPuzzle = true;
            }
          } else {
            logger.error("[PuzzleController] Stockfish (auto) made an illegal move or FEN update failed:", stockfishMoveUci);
            this.state.feedbackMessage = "Stockfish error. Your turn."; // Translated
            this.state.isUserTurnInPuzzle = true;
          }
        } else {
          logger.warn("[PuzzleController] Stockfish (auto) did not return a move in playout.");
          if (!this.checkAndSetGameOver()) {
            this.state.feedbackMessage = "Stockfish found no move or an error occurred. Your turn."; // Translated
            this.state.isUserTurnInPuzzle = true;
          }
        }
      } catch (error) {
        this.state.isStockfishThinking = false;
        logger.error("[PuzzleController] Error during Stockfish auto-move in playout:", error);
        if (!this.checkAndSetGameOver()) {
          this.state.feedbackMessage = "Error getting move from Stockfish. Your turn."; // Translated
          this.state.isUserTurnInPuzzle = true;
        }
      }
      this.requestRedraw();
    }
  }

  private playNextSolutionMoveInternal(isContinuation: boolean = false): void {
    if (this.state.gameOverMessage || this.boardHandler.promotionCtrl.isActive() || this.state.isAnalysisModeActive) return;

    if (!this.state.activePuzzle || this.state.currentSolutionMoveIndex >= this.state.puzzleSolutionMoves.length) {
      if (this.state.activePuzzle) {
        logger.info("[PuzzleController] Puzzle solution completed. Entering play out mode.");
        if (!this.state.isInPlayOutMode) {
            this.state.isInPlayOutMode = true;
            SoundService.playSound('puzzle_playout_start');
        }
        this.state.feedbackMessage = "Puzzle solved! You can continue playing."; // Translated
        if (!this.checkAndSetGameOver()) {
          this.state.isUserTurnInPuzzle = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();
          if (!this.state.isUserTurnInPuzzle) {
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
    this.state.feedbackMessage = isContinuation ? `System responds: ${uciSolutionMove}` : `System's first move: ${uciSolutionMove}`; // Translated
    this.requestRedraw();

    const moveResult: AttemptMoveResult = this.boardHandler.applySystemMove(uciSolutionMove);

    if (moveResult.success) {
      this.state.currentSolutionMoveIndex++;
      if (this.checkAndSetGameOver()) return;

      if (this.state.currentSolutionMoveIndex >= this.state.puzzleSolutionMoves.length) {
        logger.info("[PuzzleController] SYSTEM COMPLETED PUZZLE SOLUTION!");
        if (!this.state.isInPlayOutMode) {
            this.state.isInPlayOutMode = true;
            SoundService.playSound('puzzle_playout_start');
        }
        this.state.feedbackMessage = "Puzzle solved! You can continue playing."; // Translated
        this.state.isUserTurnInPuzzle = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();
        if (!this.state.isUserTurnInPuzzle && !this.state.gameOverMessage) {
          this.triggerStockfishMoveInPlayoutIfNeeded();
        }
      } else {
        this.state.isUserTurnInPuzzle = true;
        this.state.feedbackMessage = `Your turn.`; // Translated
      }
    } else {
      logger.error(`[PuzzleController] Failed to apply solution move ${uciSolutionMove} from BoardHandler. Result: ${JSON.stringify(moveResult)}`);
      this.state.feedbackMessage = "Error in puzzle data. System move failed."; // Translated
      this.state.isUserTurnInPuzzle = true;
    }
    this.requestRedraw();
  }

  public async handleUserMove(orig: Key, dest: Key): Promise<void> {
    if (this.state.gameOverMessage || this.boardHandler.promotionCtrl.isActive() || this.state.isAnalysisModeActive) {
      if (this.state.isAnalysisModeActive) {
          logger.info(`[PuzzleController] User move in analysis mode: ${orig}-${dest}. Processing for analysis...`);
          const moveResult: AttemptMoveResult = await this.boardHandler.attemptUserMove(orig, dest); // Use existing method for now
          if (moveResult.success && moveResult.uciMove) {
              this.state.feedbackMessage = `Move ${moveResult.uciMove} made in analysis mode. Requesting evaluation...`; // Translated
              this.state.currentPuzzlePieceCount = this.countPiecesFromFen(this.boardHandler.getFen()); // Update piece count
              this.requestRedraw();
              // TODO: Run analysis for this.boardHandler.getFen()
              logger.info(`[PuzzleController] TODO: Run analysis for FEN: ${this.boardHandler.getFen()} after user move in analysis mode.`);
          } else {
              this.state.feedbackMessage = "Invalid move in analysis mode."; // Translated
              this.requestRedraw();
          }
          return;
      }
      logger.warn("[PuzzleController handleUserMove] Move ignored: game over or promotion active.");
      if (this.boardHandler.promotionCtrl.isActive()) {
        this.state.feedbackMessage = "Select a piece for promotion."; // Translated
        this.requestRedraw();
      }
      return;
    }
    if (this.state.isStockfishThinking) {
      logger.warn("[PuzzleController handleUserMove] User attempted to move while Stockfish is thinking.");
      this.state.feedbackMessage = "Stockfish is thinking, please wait..."; // Translated
      this.requestRedraw();
      return;
    }

    const moveResult: AttemptMoveResult = await this.boardHandler.attemptUserMove(orig, dest);

    if (moveResult.success && moveResult.uciMove) {
      if (moveResult.promotionStarted && !moveResult.promotionCompleted) {
        logger.info("[PuzzleController handleUserMove] Promotion was started but seems to have been cancelled or not completed successfully.");
        this.state.feedbackMessage = "Promotion cancelled or failed."; // Translated
      } else {
        logger.info(`[PuzzleController handleUserMove] User move ${moveResult.uciMove} (promotionCompleted: ${moveResult.promotionCompleted}) successful in BoardHandler. Processing result...`);
        this.processUserMoveResult(moveResult.uciMove);
      }
    } else if (moveResult.promotionStarted && !moveResult.success && !moveResult.promotionCompleted) {
      logger.info("[PuzzleController handleUserMove] Promotion was cancelled by user.");
      this.state.feedbackMessage = "Promotion cancelled."; // Translated
    } else if (!moveResult.success) {
      logger.warn(`[PuzzleController handleUserMove] User move ${orig}-${dest} failed in BoardHandler or was cancelled. Result: ${JSON.stringify(moveResult)}`);
      this.state.feedbackMessage = moveResult.promotionStarted ? "Promotion cancelled." : "Invalid move."; // Translated
    }
    this.requestRedraw();
  }

  private processUserMoveResult(uciMove: string): void {
    logger.info(`[PuzzleController processUserMoveResult] Processing user move: ${uciMove}. Current FEN: ${this.boardHandler.getFen()}`);
    this.state.currentPuzzlePieceCount = this.countPiecesFromFen(this.boardHandler.getFen()); // Update piece count

    if (this.checkAndSetGameOver()) {
      logger.info(`[PuzzleController processUserMoveResult] Game over after user move ${uciMove}.`);
      return;
    }

    if (this.state.isInPlayOutMode) {
      logger.info(`[PuzzleController processUserMoveResult] User move in playout mode: ${uciMove}`);
      this.state.isUserTurnInPuzzle = false;
      this.requestRedraw();
      this.triggerStockfishMoveInPlayoutIfNeeded();
      return;
    }

    if (!this.state.activePuzzle) {
      logger.warn("[PuzzleController processUserMoveResult] No active puzzle.");
      this.state.feedbackMessage = "No active puzzle."; // Translated
      this.requestRedraw();
      return;
    }

    if (!this.state.isUserTurnInPuzzle) {
      logger.warn("[PuzzleController processUserMoveResult] NOT USER'S TURN, but move was processed. This indicates a logic flaw. Forcing user turn for safety.");
      this.state.feedbackMessage = "Not your turn (logic error)."; // Translated
      this.state.isUserTurnInPuzzle = true;
      this.requestRedraw();
      return;
    }

    const expectedMove = this.state.puzzleSolutionMoves[this.state.currentSolutionMoveIndex];

    if (uciMove === expectedMove) {
      logger.info(`[PuzzleController processUserMoveResult] User move ${uciMove} is CORRECT!`);
      this.state.feedbackMessage = "Correct!"; // Translated
      this.state.currentSolutionMoveIndex++;
      this.state.isUserTurnInPuzzle = false;

      if (this.checkAndSetGameOver()) {
        logger.info(`[PuzzleController processUserMoveResult] Game over after user's correct move ${uciMove}.`);
        return;
      }

      if (this.state.currentSolutionMoveIndex >= this.state.puzzleSolutionMoves.length) {
        logger.info("[PuzzleController processUserMoveResult] USER COMPLETED PUZZLE SOLUTION!");
         if (!this.state.isInPlayOutMode) {
            this.state.isInPlayOutMode = true;
            SoundService.playSound('puzzle_playout_start');
        }
        this.state.feedbackMessage = "Puzzle solved! You can continue playing."; // Translated
        this.state.isUserTurnInPuzzle = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();
        if (!this.state.isUserTurnInPuzzle && !this.state.gameOverMessage) {
          this.triggerStockfishMoveInPlayoutIfNeeded();
        }
      } else {
        this.state.feedbackMessage = "System's turn..."; // Translated
        const nextSystemMove = this.state.puzzleSolutionMoves[this.state.currentSolutionMoveIndex];
        logger.info(`[PuzzleController processUserMoveResult] Scheduling system's solution move: ${nextSystemMove} (index ${this.state.currentSolutionMoveIndex}). Current FEN: ${this.boardHandler.getFen()}`);
        setTimeout(() => {
          this.playNextSolutionMoveInternal(true);
        }, 300);
      }
    } else {
      logger.warn(`[PuzzleController processUserMoveResult] User move ${uciMove} is INCORRECT. Expected: ${expectedMove}. Undoing move.`);
      this.state.feedbackMessage = `Incorrect. Try again.`; // Translated
      if (this.boardHandler.undoLastMove()) {
        logger.info(`[PuzzleController processUserMoveResult] Incorrect user move ${uciMove} was undone by BoardHandler. FEN is now: ${this.boardHandler.getFen()}`);
        this.state.currentPuzzlePieceCount = this.countPiecesFromFen(this.boardHandler.getFen()); // Update piece count after undo
      } else {
        logger.error(`[PuzzleController processUserMoveResult] Failed to undo incorrect user move ${uciMove} from BoardHandler.`);
      }
      this.state.isUserTurnInPuzzle = true;
    }
    this.requestRedraw();
  }

  public handleSetFen(): void {
    if (this.boardHandler.promotionCtrl.isActive()) {
      this.boardHandler.promotionCtrl.cancel();
    }
    if (this.state.isAnalysisModeActive) {
        logger.info("[PuzzleController] Set FEN called while analysis mode is active. Deactivating analysis mode.");
        this.handleToggleAnalysisMode(false);
    }

    const fen = prompt("Enter FEN:", this.boardHandler.getFen());
    if (fen) {
      this.state.activePuzzle = null;
      this.state.puzzleSolutionMoves = [];
      this.state.currentSolutionMoveIndex = 0;
      this.state.currentPuzzlePieceCount = this.countPiecesFromFen(fen); // Calculate piece count for new FEN
      if (!this.state.isInPlayOutMode) {
        this.state.isInPlayOutMode = true;
        SoundService.playSound('puzzle_playout_start');
      }
      this.state.isStockfishThinking = false;
      this.state.gameOverMessage = null;

      const humanPlayerColorBasedOnTurn = fen.includes(' w ') ? 'white' : 'black';
      this.boardHandler.setupPosition(fen, humanPlayerColorBasedOnTurn, true);

      if (this.checkAndSetGameOver()) return;

      this.state.isUserTurnInPuzzle = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();
      logger.info(`[PuzzleController handleSetFen] FEN set. Pieces: ${this.state.currentPuzzlePieceCount}. isUserTurnInPuzzle: ${this.state.isUserTurnInPuzzle}`);

      if (!this.state.isUserTurnInPuzzle && !this.state.gameOverMessage) {
        this.state.feedbackMessage = "FEN set. Stockfish's turn."; // Translated
        this.triggerStockfishMoveInPlayoutIfNeeded();
      } else if (this.state.isUserTurnInPuzzle && !this.state.gameOverMessage) {
        this.state.feedbackMessage = "FEN set. Your turn."; // Translated
      } else if (this.state.gameOverMessage) {
        // Message already set by checkAndSetGameOver
      }
      this.requestRedraw();
    }
  }

  public handleRestartPuzzle(): void {
    if (this.boardHandler.promotionCtrl.isActive()) {
      this.boardHandler.promotionCtrl.cancel();
    }
    if (this.state.isAnalysisModeActive) {
        logger.info("[PuzzleController] Restart Puzzle called while analysis mode is active. Deactivating analysis mode.");
        this.handleToggleAnalysisMode(false);
    }

    if (this.state.activePuzzle) {
      logger.info(`[PuzzleController] Restarting puzzle: ${this.state.activePuzzle.PuzzleId}`);
      const puzzleToRestart = this.state.activePuzzle;

      this.state.puzzleSolutionMoves = puzzleToRestart.Moves ? puzzleToRestart.Moves.split(' ') : [];
      this.state.currentSolutionMoveIndex = 0;
      this.state.isInPlayOutMode = false;
      this.state.isStockfishThinking = false;
      this.state.gameOverMessage = null;
      this.state.currentPuzzlePieceCount = this.countPiecesFromFen(puzzleToRestart.FEN_0); // Reset piece count

      this.boardHandler.setupPosition(puzzleToRestart.FEN_0, puzzleToRestart.HumanColor, true);

      this.state.feedbackMessage = `Puzzle ${puzzleToRestart.PuzzleId} restarted. You play as ${this.boardHandler.getHumanPlayerColor() || 'N/A'}.`; // Translated

      if (this.checkAndSetGameOver()) return;

      const initialTurnColorInPuzzle = this.boardHandler.getBoardTurnColor();
      const humanColor = this.boardHandler.getHumanPlayerColor();

      if (this.state.puzzleSolutionMoves.length > 0) {
        if (initialTurnColorInPuzzle !== humanColor) {
          this.state.isUserTurnInPuzzle = false;
          this.state.feedbackMessage = "System's turn..."; // Translated
          this.requestRedraw();
          setTimeout(() => this.playNextSolutionMoveInternal(false), 50);
        } else {
          this.state.isUserTurnInPuzzle = true;
          this.state.feedbackMessage = `Your turn.`; // Translated
          this.requestRedraw();
        }
      } else {
        this.state.isUserTurnInPuzzle = initialTurnColorInPuzzle === humanColor;
        this.state.feedbackMessage = this.state.isUserTurnInPuzzle ? "Your turn (puzzle has no solution?)." : "System's turn (puzzle has no solution?)."; // Translated
        this.requestRedraw();
        if (!this.state.isUserTurnInPuzzle && !this.state.gameOverMessage) {
          if (!this.state.isInPlayOutMode) {
            this.state.isInPlayOutMode = true;
            SoundService.playSound('puzzle_playout_start');
          }
          this.triggerStockfishMoveInPlayoutIfNeeded();
        }
      }
    } else {
      logger.warn("[PuzzleController] Restart puzzle called, but no active puzzle to restart.");
      this.state.feedbackMessage = "No active puzzle to restart."; // Translated
      this.requestRedraw();
    }
  }

  public handleToggleAnalysisMode(forceValue?: boolean): void {
    if (this.boardHandler.promotionCtrl.isActive()) {
      logger.warn("[PuzzleController] Cannot toggle analysis mode during promotion.");
      this.state.feedbackMessage = "Complete piece promotion before analysis."; // Translated
      this.requestRedraw();
      return;
    }

    const newAnalysisState = typeof forceValue === 'boolean' ? forceValue : !this.state.isAnalysisModeActive;

    if (newAnalysisState === this.state.isAnalysisModeActive) {
        logger.info(`[PuzzleController] Analysis mode already in desired state: ${newAnalysisState}`);
    }

    this.state.isAnalysisModeActive = newAnalysisState;

    if (this.state.isAnalysisModeActive) {
      logger.info("[PuzzleController] Analysis mode ACTIVATED.");
      this.state.feedbackMessage = "Analysis mode active. Make moves on the board."; // Translated
      this.state.isStockfishThinking = false;
      this.chessboardService.ground?.set({
        movable: {
          free: true,
          color: 'both',
          dests: new Map(),
        }
      });
      this.boardHandler.clearAllDrawings();
      // TODO: Run analysis for this.boardHandler.getFen()
      logger.info(`[PuzzleController] TODO: Run analysis for FEN: ${this.boardHandler.getFen()} when analysis mode is activated.`);


    } else {
      logger.info("[PuzzleController] Analysis mode DEACTIVATED.");
      this.state.feedbackMessage = "Analysis ended."; // Translated
      this.boardHandler.clearAllDrawings();
      const gameStatus = this.boardHandler.getGameStatus();
      this.chessboardService.ground?.set({
        movable: {
          free: false,
          color: gameStatus.isGameOver ? undefined : this.boardHandler.getBoardTurnColor(),
          dests: gameStatus.isGameOver ? new Map() : this.boardHandler.getPossibleMoves(),
        }
      });
      if (!this.state.gameOverMessage) {
          if (this.state.isInPlayOutMode) {
              this.state.feedbackMessage = this.state.isUserTurnInPuzzle ? "Your turn." : "System's turn..."; // Translated
          } else if (this.state.activePuzzle) {
              this.state.feedbackMessage = this.state.isUserTurnInPuzzle ? "Your turn." : "System's turn..."; // Translated
          } else {
              this.state.feedbackMessage = "Load a puzzle or set FEN."; // Translated
          }
      } else {
          this.state.feedbackMessage = this.state.gameOverMessage;
      }
    }
    this.requestRedraw();
  }
}
