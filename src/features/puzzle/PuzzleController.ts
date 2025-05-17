// src/features/puzzle/PuzzleController.ts
import type { Key } from 'chessground/types';
import type { ChessboardService } from '../../core/chessboard.service';
import type { WebhookService, AppPuzzle } from '../../core/webhook.service';
import type { StockfishService } from '../../core/stockfish.service';
import { BoardHandler } from '../../core/boardHandler';
import type { GameStatus, GameEndOutcome, AttemptMoveResult } from '../../core/boardHandler';
import logger from '../../utils/logger';
import { SoundService } from '../../core/sound.service';
// PgnNode is not directly manipulated here as much, BoardHandler and PgnService handle it.
// import type { PgnNode } from '../../core/pgn.service'; 

interface PuzzleControllerState {
  activePuzzle: AppPuzzle | null;
  puzzleSolutionMoves: string[]; // UCI strings of the puzzle's main solution
  currentSolutionMoveIndex: number; // Index in puzzleSolutionMoves
  isUserTurnInPuzzle: boolean; // Is it the user's turn to make a move in the puzzle context
  feedbackMessage: string;
  isInPlayOutMode: boolean; // True if puzzle solution is complete, and user can play on
  isStockfishThinking: boolean; // True if Stockfish is calculating a move in playout
  gameOverMessage: string | null; // e.g., "Checkmate! White won."
  isAnalysisModeActive: boolean;
  currentPuzzlePieceCount: number; // For display or potential logic
  currentPgnString: string; // For display in the UI
}

export class PuzzleController {
  public state: PuzzleControllerState;
  public boardHandler: BoardHandler;

  constructor(
    public chessboardService: ChessboardService,
    boardHandler: BoardHandler, // Expecting already refactored BoardHandler
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
      feedbackMessage: "Load a puzzle to start.",
      isInPlayOutMode: false,
      isStockfishThinking: false,
      gameOverMessage: null,
      isAnalysisModeActive: false,
      currentPuzzlePieceCount: 0,
      currentPgnString: "",
    };
    logger.info('[PuzzleController] Initialized with BoardHandler.');
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
      return `Checkmate! ${outcome.winner === 'white' ? 'White' : 'Black'} won (${outcome.reason || 'checkmate'}).`;
    }
    switch (outcome.reason) {
      case 'stalemate': return "Stalemate! It's a draw.";
      case 'insufficient_material': return "Draw (insufficient material).";
      case 'draw': return "Draw (threefold repetition, 50-move rule, or agreement).";
      default: return `Draw (${outcome.reason || 'unknown reason'}).`;
    }
  }

  private _updatePgnDisplay(): void {
    // Get PGN string for the current line, show result if game over and not in analysis
    const showResult = this.boardHandler.getGameStatus().isGameOver && !this.state.isAnalysisModeActive;
    this.state.currentPgnString = this.boardHandler.getPgn({ showResult, showVariations: this.state.isAnalysisModeActive });
    this.requestRedraw(); 
  }

  private checkAndSetGameOver(): boolean {
    const gameStatus: GameStatus = this.boardHandler.getGameStatus();
    if (gameStatus.isGameOver && !this.boardHandler.isAnalysisMode()) { 
      this.state.gameOverMessage = this.formatGameEndMessage(gameStatus.outcome);
      this.state.feedbackMessage = this.state.gameOverMessage || "Game over.";
      this.state.isUserTurnInPuzzle = false; // No more turns if game is over
      this.state.isStockfishThinking = false;
      logger.info(`[PuzzleController] Game over detected. Message: ${this.state.gameOverMessage}`);
      this._updatePgnDisplay(); // Update PGN with result

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
    // If not game over, or if in analysis mode, clear previous game over message
    this.state.gameOverMessage = null; 
    return false;
  }

  public async loadAndStartPuzzle(): Promise<void> {
    if (this.boardHandler.promotionCtrl.isActive()) {
      this.boardHandler.promotionCtrl.cancel();
    }
    if (this.state.isAnalysisModeActive) {
        this.handleToggleAnalysisMode(false); // Turn off analysis before loading new puzzle
    }

    logger.info("[PuzzleController] Loading new puzzle...");
    this.state = { // Reset most of the state
        ...this.state, // Keep some state like analysis mode if needed, or reset selectively
        activePuzzle: null,
        puzzleSolutionMoves: [],
        currentSolutionMoveIndex: 0,
        isUserTurnInPuzzle: false,
        feedbackMessage: "Loading puzzle...",
        isInPlayOutMode: false,
        isStockfishThinking: false,
        gameOverMessage: null,
        currentPuzzlePieceCount: 0,
        currentPgnString: "",
        // isAnalysisModeActive: false, // Explicitly reset if desired
    };
    this.requestRedraw();

    const puzzleData = await this.webhookService.fetchPuzzle();
    if (puzzleData) {
      this.state.activePuzzle = puzzleData;
      this.state.puzzleSolutionMoves = puzzleData.Moves ? puzzleData.Moves.split(' ') : [];
      this.state.currentSolutionMoveIndex = 0;
      this.state.currentPuzzlePieceCount = this.countPiecesFromFen(puzzleData.FEN_0);

      // BoardHandler.setupPosition will call PgnService.reset
      this.boardHandler.setupPosition(puzzleData.FEN_0, puzzleData.HumanColor, true);
      this._updatePgnDisplay(); // PGN will be empty initially after reset

      logger.info(`[PuzzleController] Puzzle loaded: ${puzzleData.PuzzleId}. Initial FEN: ${this.boardHandler.getFen()}. Pieces: ${this.state.currentPuzzlePieceCount}`);
      logger.info(`[PuzzleController] Human player color: ${this.boardHandler.getHumanPlayerColor()}. Solution moves: ${this.state.puzzleSolutionMoves.join(' ')}`);
      
      this.state.feedbackMessage = `Puzzle ${puzzleData.PuzzleId}. You play as ${this.boardHandler.getHumanPlayerColor() || 'N/A'}.`;

      if (this.checkAndSetGameOver()) return; // Check if initial FEN is already game over

      const initialTurnColorInPuzzle = this.boardHandler.getBoardTurnColor();
      const humanColor = this.boardHandler.getHumanPlayerColor();

      if (this.state.puzzleSolutionMoves.length > 0) {
        if (initialTurnColorInPuzzle !== humanColor) {
          logger.info("[PuzzleController] System makes the first solution move.");
          this.state.isUserTurnInPuzzle = false;
          this.state.feedbackMessage = "System's turn...";
          this.requestRedraw();
          // Delay slightly to allow UI update before system move
          setTimeout(() => this.playNextSolutionMoveInternal(false), 750);
        } else {
          this.state.isUserTurnInPuzzle = true;
          this.state.feedbackMessage = `Your turn.`;
          logger.info(`[PuzzleController] Puzzle starts with user's turn.`);
          this.requestRedraw();
        }
      } else { // Puzzle has no defined solution moves (e.g., mate in 1 for user)
        logger.warn("[PuzzleController] Puzzle has no moves in solution string!");
        this.state.isUserTurnInPuzzle = initialTurnColorInPuzzle === humanColor;
        this.state.feedbackMessage = this.state.isUserTurnInPuzzle ? "Your turn (direct solution?)." : "System's turn (direct solution?).";
        this.requestRedraw();
        if (!this.state.isUserTurnInPuzzle && !this.state.gameOverMessage) {
          // This case implies the puzzle is for the system to solve, or it's a "play vs stockfish" from this pos.
          // For now, let's assume if it's not user's turn, it's an error or needs playout.
          if (!this.state.isInPlayOutMode) {
            this.state.isInPlayOutMode = true; // Treat as playout if system starts and no solution moves
            SoundService.playSound('puzzle_playout_start');
          }
          this.triggerStockfishMoveInPlayoutIfNeeded();
        }
      }
    } else {
      logger.error("[PuzzleController] Failed to load puzzle.");
      this.state.feedbackMessage = "Failed to load puzzle.";
      this.requestRedraw();
    }
  }

  private async triggerStockfishMoveInPlayoutIfNeeded(): Promise<void> {
    if (this.state.gameOverMessage || this.boardHandler.promotionCtrl.isActive() || this.state.isAnalysisModeActive) {
      return;
    }
    const currentBoardTurn = this.boardHandler.getBoardTurnColor();
    const humanColor = this.boardHandler.getHumanPlayerColor();

    if (this.state.isInPlayOutMode && currentBoardTurn !== humanColor && !this.state.isStockfishThinking) {
      logger.info(`[PuzzleController] Triggering Stockfish move in playout. FEN: ${this.boardHandler.getFen()}`);
      this.state.isStockfishThinking = true;
      this.state.feedbackMessage = "Stockfish is thinking...";
      this.requestRedraw();

      try {
        const stockfishMoveUci = await this.stockfishService.getBestMoveOnly(this.boardHandler.getFen(), { depth: 12 });
        this.state.isStockfishThinking = false;

        if (stockfishMoveUci) {
          logger.info(`[PuzzleController] Stockfish auto-move in playout: ${stockfishMoveUci}`);
          // BoardHandler will add this to PGN tree
          const moveResult: AttemptMoveResult = this.boardHandler.applySystemMove(stockfishMoveUci);
          this._updatePgnDisplay(); 
          if (moveResult.success) {
            if (!this.checkAndSetGameOver()) {
              this.state.feedbackMessage = "Your turn.";
              this.state.isUserTurnInPuzzle = true;
            }
          } else {
            logger.error("[PuzzleController] Stockfish (auto) made an illegal move or FEN update failed:", stockfishMoveUci);
            this.state.feedbackMessage = "Stockfish error. Your turn.";
            this.state.isUserTurnInPuzzle = true; // Give turn back to user
          }
        } else { // Stockfish returned no move
          logger.warn("[PuzzleController] Stockfish (auto) did not return a move in playout.");
          if (!this.checkAndSetGameOver()) { // If no move, it might be mate/stalemate already
            this.state.feedbackMessage = "Stockfish found no move. Your turn.";
            this.state.isUserTurnInPuzzle = true;
          }
        }
      } catch (error) {
        this.state.isStockfishThinking = false;
        logger.error("[PuzzleController] Error during Stockfish auto-move in playout:", error);
        if (!this.checkAndSetGameOver()) {
          this.state.feedbackMessage = "Error getting move from Stockfish. Your turn.";
          this.state.isUserTurnInPuzzle = true;
        }
      }
      this.requestRedraw();
    }
  }

  private playNextSolutionMoveInternal(isContinuation: boolean = false): void {
    if (this.state.gameOverMessage || this.boardHandler.promotionCtrl.isActive() || this.state.isAnalysisModeActive) return;
    
    if (!this.state.activePuzzle || this.state.currentSolutionMoveIndex >= this.state.puzzleSolutionMoves.length) {
      if (this.state.activePuzzle) { // Puzzle solution is complete
        logger.info("[PuzzleController] Puzzle solution completed. Entering play out mode.");
        if (!this.state.isInPlayOutMode) {
            this.state.isInPlayOutMode = true;
            SoundService.playSound('puzzle_playout_start');
        }
        this.state.feedbackMessage = "Puzzle solved! You can continue playing.";
        if (!this.checkAndSetGameOver()) { // Check if the last solution move ended the game
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
    this.state.feedbackMessage = isContinuation ? `System responds: ${uciSolutionMove}` : `System's first move: ${uciSolutionMove}`;
    this.requestRedraw();

    // BoardHandler will add this to PGN tree
    const moveResult: AttemptMoveResult = this.boardHandler.applySystemMove(uciSolutionMove);
    this._updatePgnDisplay();

    if (moveResult.success) {
      this.state.currentSolutionMoveIndex++;
      if (this.checkAndSetGameOver()) return; // Check if system's move ended the game

      if (this.state.currentSolutionMoveIndex >= this.state.puzzleSolutionMoves.length) { // System just completed the solution
        logger.info("[PuzzleController] SYSTEM COMPLETED PUZZLE SOLUTION!");
        if (!this.state.isInPlayOutMode) {
            this.state.isInPlayOutMode = true;
            SoundService.playSound('puzzle_playout_start');
        }
        this.state.feedbackMessage = "Puzzle solved! You can continue playing.";
        this.state.isUserTurnInPuzzle = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();
        if (!this.state.isUserTurnInPuzzle && !this.state.gameOverMessage) {
          this.triggerStockfishMoveInPlayoutIfNeeded();
        }
      } else { // Solution continues, it's user's turn
        this.state.isUserTurnInPuzzle = true;
        this.state.feedbackMessage = `Your turn.`;
      }
    } else {
      logger.error(`[PuzzleController] Failed to apply solution move ${uciSolutionMove} from BoardHandler. Result: ${JSON.stringify(moveResult)}`);
      this.state.feedbackMessage = "Error in puzzle data. System move failed.";
      this.state.isUserTurnInPuzzle = true; // Give control back to user
    }
    this.requestRedraw();
  }

  public async handleUserMove(orig: Key, dest: Key): Promise<void> {
    if (this.state.gameOverMessage && !this.state.isAnalysisModeActive) { 
        logger.warn("[PuzzleController handleUserMove] Move ignored: game over and not in analysis mode.");
        return;
    }
    if (this.boardHandler.promotionCtrl.isActive()) {
        logger.warn("[PuzzleController handleUserMove] Move ignored: promotion active.");
        this.state.feedbackMessage = "Select a piece for promotion.";
        this.requestRedraw();
        return;
    }
    if (this.state.isStockfishThinking && !this.state.isAnalysisModeActive) { 
        logger.warn("[PuzzleController handleUserMove] User attempted to move while Stockfish is thinking (non-analysis).");
        this.state.feedbackMessage = "Stockfish is thinking, please wait...";
        this.requestRedraw();
        return;
    }

    // BoardHandler will add this to PGN tree (as main line or variation depending on context)
    const moveResult: AttemptMoveResult = await this.boardHandler.attemptUserMove(orig, dest);
    this._updatePgnDisplay();

    if (this.state.isAnalysisModeActive) {
        logger.info(`[PuzzleController] User move in analysis mode: ${orig}-${dest}. Result: ${JSON.stringify(moveResult)}`);
        if (moveResult.success && moveResult.uciMove) {
            this.state.feedbackMessage = `Move ${moveResult.uciMove} made. FEN: ${this.boardHandler.getFen()}`; 
            this.state.currentPuzzlePieceCount = this.countPiecesFromFen(this.boardHandler.getFen());
            // TODO: Optionally trigger Stockfish analysis for the new PGN node (this.boardHandler.pgnService.getCurrentNode())
            // logger.info(`[PuzzleController] Analysis mode: User move ${moveResult.uciMove}. Current PGN Path: ${this.boardHandler.getCurrentPgnPath()}`);
        } else if (moveResult.promotionStarted && !moveResult.promotionCompleted) {
            this.state.feedbackMessage = "Promotion cancelled.";
        } else if (moveResult.isIllegal) {
            this.state.feedbackMessage = "Illegal move in analysis mode.";
        } else {
            this.state.feedbackMessage = "Move failed in analysis mode.";
        }
        this.requestRedraw();
        return;
    }

    // --- Logic for NON-Analysis Mode (Puzzle Solving / Playout) ---
    if (moveResult.success && moveResult.uciMove) {
      if (moveResult.promotionStarted && !moveResult.promotionCompleted) {
        // This case should ideally be handled by the promotionCtrl resolving with null,
        // and attemptUserMove returning a specific result for cancellation.
        // For now, we assume if promotionStarted but not completed and success is true, it means move was made.
        logger.info("[PuzzleController handleUserMove] Promotion was completed.");
        this.processUserMoveResult(moveResult.uciMove);
      } else {
        logger.info(`[PuzzleController handleUserMove] User move ${moveResult.uciMove} successful. Processing result...`);
        this.processUserMoveResult(moveResult.uciMove);
      }
    } else if (moveResult.promotionStarted && !moveResult.success && !moveResult.promotionCompleted) {
      logger.info("[PuzzleController handleUserMove] Promotion was cancelled by user.");
      this.state.feedbackMessage = "Promotion cancelled.";
    } else if (!moveResult.success) {
      logger.warn(`[PuzzleController handleUserMove] User move ${orig}-${dest} failed. Result: ${JSON.stringify(moveResult)}`);
      this.state.feedbackMessage = moveResult.isIllegal ? "Invalid move." : "Move processing error.";
    }
    this.requestRedraw();
  }

  private processUserMoveResult(uciUserMove: string): void {
    logger.info(`[PuzzleController processUserMoveResult] Processing user move: ${uciUserMove}. Current FEN: ${this.boardHandler.getFen()}`);
    this.state.currentPuzzlePieceCount = this.countPiecesFromFen(this.boardHandler.getFen());
    
    if (this.checkAndSetGameOver()) { // Check if user's move ended the game
      logger.info(`[PuzzleController processUserMoveResult] Game over after user move ${uciUserMove}.`);
      return;
    }

    // If in playout mode, user's move is accepted, then it's system's turn (Stockfish)
    if (this.state.isInPlayOutMode) {
      logger.info(`[PuzzleController processUserMoveResult] User move in playout mode: ${uciUserMove}`);
      this.state.isUserTurnInPuzzle = false; // System's turn next
      this.requestRedraw();
      this.triggerStockfishMoveInPlayoutIfNeeded();
      return;
    }

    // --- Puzzle Solving Logic ---
    if (!this.state.activePuzzle) {
      logger.warn("[PuzzleController processUserMoveResult] No active puzzle. Entering playout mode.");
      this.state.isInPlayOutMode = true; // Should not happen if puzzle loaded correctly
      this.state.isUserTurnInPuzzle = false;
      this.triggerStockfishMoveInPlayoutIfNeeded();
      this.requestRedraw();
      return;
    }

    if (!this.state.isUserTurnInPuzzle) {
      // This should ideally not happen if UI disables input, but as a safeguard:
      logger.warn("[PuzzleController processUserMoveResult] User move processed, but it was not user's turn. Undoing.");
      this.state.feedbackMessage = "Not your turn. Move reverted.";
      this.boardHandler.undoLastMove(); // Undo the user's move from PGN and board
      this._updatePgnDisplay();
      // isUserTurnInPuzzle remains false, system should proceed if it was its turn
      this.requestRedraw();
      return;
    }

    const expectedSolutionMove = this.state.puzzleSolutionMoves[this.state.currentSolutionMoveIndex];

    if (uciUserMove === expectedSolutionMove) {
      logger.info(`[PuzzleController processUserMoveResult] User move ${uciUserMove} is CORRECT!`);
      this.state.feedbackMessage = "Correct!";
      this.state.currentSolutionMoveIndex++;
      this.state.isUserTurnInPuzzle = false; // System's turn next (if any solution moves left)

      if (this.checkAndSetGameOver()) return; // Check if correct user move ended the game

      if (this.state.currentSolutionMoveIndex >= this.state.puzzleSolutionMoves.length) { // User made the last correct move
        logger.info("[PuzzleController processUserMoveResult] USER COMPLETED PUZZLE SOLUTION!");
         if (!this.state.isInPlayOutMode) {
            this.state.isInPlayOutMode = true;
            SoundService.playSound('puzzle_playout_start');
        }
        this.state.feedbackMessage = "Puzzle solved! You can continue playing.";
        // Determine whose turn it is now for playout
        this.state.isUserTurnInPuzzle = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();
        if (!this.state.isUserTurnInPuzzle && !this.state.gameOverMessage) {
          this.triggerStockfishMoveInPlayoutIfNeeded();
        }
      } else { // More solution moves remaining, system's turn
        this.state.feedbackMessage = "System's turn...";
        const nextSystemMove = this.state.puzzleSolutionMoves[this.state.currentSolutionMoveIndex];
        logger.info(`[PuzzleController processUserMoveResult] Scheduling system's solution move: ${nextSystemMove} (index ${this.state.currentSolutionMoveIndex}).`);
        setTimeout(() => {
          this.playNextSolutionMoveInternal(true); // Pass true for "continuation"
        }, 300); // Short delay for system response
      }
    } else { // User move is INCORRECT
      logger.warn(`[PuzzleController processUserMoveResult] User move ${uciUserMove} is INCORRECT. Expected: ${expectedSolutionMove}. Undoing user's move.`);
      this.state.feedbackMessage = `Incorrect. Expected ${expectedSolutionMove}. Try again.`;
      // The incorrect move was already added to PGN by BoardHandler. We need to undo it.
      if (this.boardHandler.undoLastMove()) {
        logger.info(`[PuzzleController processUserMoveResult] Incorrect user move ${uciUserMove} was undone. FEN is now: ${this.boardHandler.getFen()}`);
        this.state.currentPuzzlePieceCount = this.countPiecesFromFen(this.boardHandler.getFen());
        this._updatePgnDisplay(); 
      } else {
        logger.error(`[PuzzleController processUserMoveResult] Failed to undo incorrect user move ${uciUserMove}. This is a critical state.`);
        // Potentially reset puzzle or force user turn on current (incorrect) board state.
      }
      this.state.isUserTurnInPuzzle = true; // It's still user's turn to try again
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
      this.state.activePuzzle = null; // No longer a specific puzzle
      this.state.puzzleSolutionMoves = [];
      this.state.currentSolutionMoveIndex = 0;
      this.state.currentPuzzlePieceCount = this.countPiecesFromFen(fen);
      if (!this.state.isInPlayOutMode) { // Entering playout if not already
        this.state.isInPlayOutMode = true;
        SoundService.playSound('puzzle_playout_start');
      }
      this.state.isStockfishThinking = false;
      this.state.gameOverMessage = null;

      const humanPlayerColorBasedOnTurn = fen.includes(' w ') ? 'white' : 'black';
      this.boardHandler.setupPosition(fen, humanPlayerColorBasedOnTurn, true); // Reset PGN with this FEN
      this._updatePgnDisplay();

      if (this.checkAndSetGameOver()) return;

      this.state.isUserTurnInPuzzle = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();
      logger.info(`[PuzzleController handleSetFen] FEN set. Pieces: ${this.state.currentPuzzlePieceCount}. isUserTurnInPuzzle: ${this.state.isUserTurnInPuzzle}`);

      if (!this.state.isUserTurnInPuzzle && !this.state.gameOverMessage) {
        this.state.feedbackMessage = "FEN set. Stockfish's turn.";
        this.triggerStockfishMoveInPlayoutIfNeeded();
      } else if (this.state.isUserTurnInPuzzle && !this.state.gameOverMessage) {
        this.state.feedbackMessage = "FEN set. Your turn.";
      } // If gameOverMessage is set, it will be displayed.
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
      const puzzleToRestart = this.state.activePuzzle; // Keep a reference

      // Reset state related to puzzle progress
      this.state.puzzleSolutionMoves = puzzleToRestart.Moves ? puzzleToRestart.Moves.split(' ') : [];
      this.state.currentSolutionMoveIndex = 0;
      this.state.isInPlayOutMode = false;
      this.state.isStockfishThinking = false;
      this.state.gameOverMessage = null;
      this.state.currentPuzzlePieceCount = this.countPiecesFromFen(puzzleToRestart.FEN_0);

      // Setup board with initial puzzle FEN, this also resets PGN in PgnService via BoardHandler
      this.boardHandler.setupPosition(puzzleToRestart.FEN_0, puzzleToRestart.HumanColor, true);
      this._updatePgnDisplay(); // PGN will be empty

      this.state.feedbackMessage = `Puzzle ${puzzleToRestart.PuzzleId} restarted. You play as ${this.boardHandler.getHumanPlayerColor() || 'N/A'}.`;

      if (this.checkAndSetGameOver()) return;

      const initialTurnColorInPuzzle = this.boardHandler.getBoardTurnColor();
      const humanColor = this.boardHandler.getHumanPlayerColor();

      if (this.state.puzzleSolutionMoves.length > 0) {
        if (initialTurnColorInPuzzle !== humanColor) {
          this.state.isUserTurnInPuzzle = false;
          this.state.feedbackMessage = "System's turn...";
          this.requestRedraw();
          setTimeout(() => this.playNextSolutionMoveInternal(false), 50); // Minimal delay
        } else {
          this.state.isUserTurnInPuzzle = true;
          this.state.feedbackMessage = `Your turn.`;
          this.requestRedraw();
        }
      } else { // No solution moves, e.g. mate in 1 for user
        this.state.isUserTurnInPuzzle = initialTurnColorInPuzzle === humanColor;
        this.state.feedbackMessage = this.state.isUserTurnInPuzzle ? "Your turn (direct solution?)." : "System's turn (direct solution?).";
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
      this.state.feedbackMessage = "No active puzzle to restart. Load one first.";
      this.requestRedraw();
    }
  }

  public handleToggleAnalysisMode(forceValue?: boolean): void {
    if (this.boardHandler.promotionCtrl.isActive()) {
      logger.warn("[PuzzleController] Cannot toggle analysis mode during promotion.");
      this.state.feedbackMessage = "Complete piece promotion before analysis.";
      this.requestRedraw();
      return;
    }

    const newAnalysisState = typeof forceValue === 'boolean' ? forceValue : !this.state.isAnalysisModeActive;

    if (newAnalysisState === this.state.isAnalysisModeActive) {
        logger.info(`[PuzzleController] Analysis mode already in desired state: ${newAnalysisState}`);
        if (typeof forceValue === 'boolean') this.requestRedraw(); // Redraw if forced, to update UI if needed
        return;
    }

    this.state.isAnalysisModeActive = newAnalysisState;
    this.boardHandler.setAnalysisMode(this.state.isAnalysisModeActive); 
    
    if (this.state.isAnalysisModeActive) {
      logger.info("[PuzzleController] Analysis mode ACTIVATED.");
      this.state.feedbackMessage = "Analysis mode active. Make moves or use PGN navigation.";
      this.state.isStockfishThinking = false; // Stop any playout thinking
      this.boardHandler.clearAllDrawings(); // Clear any puzzle-related drawings
      
      // Ensure the board reflects the current end of the PGN tree's main line
      this.boardHandler.handleNavigatePgnToEnd(); 
      this._updatePgnDisplay(); // Update PGN display for analysis context
      
      logger.info(`[PuzzleController] Analysis mode: Navigated to end. Current FEN on board: ${this.boardHandler.getFen()}. PGN Path: ${this.boardHandler.getCurrentPgnPath()}`);
      // TODO: Optionally trigger Stockfish analysis for the current PGN node
      // logger.info(`[PuzzleController] TODO: Run analysis for FEN: ${this.boardHandler.getFen()} when analysis mode is activated.`);

    } else { // Deactivating analysis mode
      logger.info("[PuzzleController] Analysis mode DEACTIVATED.");
      this.boardHandler.clearAllDrawings();
      // BoardHandler's setAnalysisMode(false) already ensures chessground settings are updated.
      // We need to restore the puzzle/playout context.
      // The board is already at PgnService.currentNode. We need to determine the game state from there.
      
      this._updatePgnDisplay(); // Update PGN for non-analysis context
      if (!this.checkAndSetGameOver()) { // Check game status based on current PGN node
          // Determine if it's user's turn based on the current board state
          this.state.isUserTurnInPuzzle = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();

          if (this.state.isInPlayOutMode) { // Was in playout before analysis
              this.state.feedbackMessage = this.state.isUserTurnInPuzzle ? "Your turn (playout)." : "System's turn (playout)...";
              if(!this.state.isUserTurnInPuzzle) this.triggerStockfishMoveInPlayoutIfNeeded();
          } else if (this.state.activePuzzle) { // Was solving a puzzle
              // Recalculate where we are in the solution
              // const currentPgnPath = this.boardHandler.getCurrentPgnPath(); // Unused variable
              // const solutionPathSoFar = this.state.puzzleSolutionMoves.slice(0, this.boardHandler.pgnService.getCurrentPly()).map(uci => this.boardHandler.pgnService.getRootNode().children.find(c => c.uci === uci)?.id || '').join(''); // Unused variable
              
              // A more robust way is to check if current PGN node's UCI matches the expected solution move
              const currentPgnNode = this.boardHandler.pgnService.getCurrentNode();
              let solutionMatch = true;
              let tempNode = currentPgnNode;
              let tempSolutionIndex = currentPgnNode.ply -1; // if ply 1, index 0

              while(tempNode.parent && tempSolutionIndex >= 0) {
                if (tempSolutionIndex >= this.state.puzzleSolutionMoves.length || tempNode.uci !== this.state.puzzleSolutionMoves[tempSolutionIndex]) {
                    solutionMatch = false;
                    break;
                }
                tempSolutionIndex--;
                tempNode = tempNode.parent;
              }
              // After loop, if solutionMatch is true, tempNode should be root if all moves matched
              if (solutionMatch && tempNode !== this.boardHandler.pgnService.getRootNode() && currentPgnNode.ply > 0) {
                // This means we matched some moves but didn't reach the root, or currentPgnNode.ply is 0 (root)
                // but we expected to match against solution moves.
                // This condition implies a mismatch if we are not at the root after checking all relevant plies.
                // Exception: if currentPgnNode.ply is 0, then tempNode is root, and solutionMatch should be true (empty path matches empty solution part).
                if (currentPgnNode.ply > 0) solutionMatch = false;
              }


              if (solutionMatch && currentPgnNode.ply < this.state.puzzleSolutionMoves.length) {
                this.state.currentSolutionMoveIndex = currentPgnNode.ply; // Next expected solution move index
                this.state.feedbackMessage = this.state.isUserTurnInPuzzle ? "Your turn." : "System's turn...";
                if(!this.state.isUserTurnInPuzzle) this.playNextSolutionMoveInternal(true);

              } else { // Deviated from solution or solution ended (or puzzle was fully solved and we are at the end)
                this.state.isInPlayOutMode = true; // Enter or confirm playout mode
                this.state.feedbackMessage = this.state.isUserTurnInPuzzle ? "Your turn (playout from variation)." : "System's turn (playout from variation)...";
                if (currentPgnNode.ply >= this.state.puzzleSolutionMoves.length && solutionMatch && this.state.activePuzzle) {
                    this.state.feedbackMessage = "Puzzle solved! Continue playing."; // More specific message if solution was matched fully
                }
                if(!this.state.isUserTurnInPuzzle) this.triggerStockfishMoveInPlayoutIfNeeded();
              }
          } else { // No active puzzle, was free play
              this.state.feedbackMessage = this.state.isUserTurnInPuzzle ? "Your turn." : "System's turn...";
              if(!this.state.isUserTurnInPuzzle) this.triggerStockfishMoveInPlayoutIfNeeded();
          }
      } else {
        // gameOverMessage is already set by checkAndSetGameOver
      }
    }
    this.requestRedraw();
  }

  // --- PGN Navigation Handlers (delegated to BoardHandler) ---
  public handlePgnNavToStart(): void {
    if (this.boardHandler.handleNavigatePgnToStart()) {
      this._updatePgnDisplay();
      if (this.state.isAnalysisModeActive) {
        logger.info(`[PuzzleController] PGN Nav: Start. FEN on board: ${this.boardHandler.getFen()}`);
        // TODO: Optionally trigger analysis for the new current node
      }
      this.requestRedraw();
    }
  }

  public handlePgnNavBackward(): void {
    if (this.boardHandler.handleNavigatePgnBackward()) {
      this._updatePgnDisplay();
      if (this.state.isAnalysisModeActive) {
        logger.info(`[PuzzleController] PGN Nav: Backward. FEN on board: ${this.boardHandler.getFen()}`);
        // TODO: Optionally trigger analysis
      }
      this.requestRedraw();
    }
  }

  public handlePgnNavForward(variationIndex: number = 0): void {
    if (this.boardHandler.handleNavigatePgnForward(variationIndex)) {
      this._updatePgnDisplay();
      if (this.state.isAnalysisModeActive) {
        logger.info(`[PuzzleController] PGN Nav: Forward (Var ${variationIndex}). FEN on board: ${this.boardHandler.getFen()}`);
        // TODO: Optionally trigger analysis
      }
      this.requestRedraw();
    }
  }

  public handlePgnNavToEnd(): void {
    if (this.boardHandler.handleNavigatePgnToEnd()) {
      this._updatePgnDisplay();
      if (this.state.isAnalysisModeActive) {
        logger.info(`[PuzzleController] PGN Nav: End. FEN on board: ${this.boardHandler.getFen()}`);
        // TODO: Optionally trigger analysis
      }
      this.requestRedraw();
    }
  }

  public canNavigatePgnBackward(): boolean {
    return this.boardHandler.canPgnNavigateBackward();
  }

  public canNavigatePgnForward(variationIndex: number = 0): boolean {
    // Check if the current PGN node has a child at the given index
    return this.boardHandler.canPgnNavigateForward(variationIndex);
  }
}
