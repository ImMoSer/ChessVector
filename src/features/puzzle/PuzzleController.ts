// src/features/puzzle/PuzzleController.ts
import type { Key } from 'chessground/types';
import type { ChessboardService } from '../../core/chessboard.service';
import type { WebhookService, AppPuzzle } from '../../core/webhook.service';
import type { StockfishService } from '../../core/stockfish.service';
import { BoardHandler } from '../../core/boardHandler';
// ИСПРАВЛЕНО: AttemptMoveResult теперь импортируется из BoardHandler
import type { GameStatus, GameEndOutcome, AttemptMoveResult } from '../../core/boardHandler';
import logger from '../../utils/logger';

interface PuzzleControllerState {
  activePuzzle: AppPuzzle | null;
  puzzleSolutionMoves: string[]; 
  currentSolutionMoveIndex: number;
  isUserTurnInPuzzle: boolean;
  feedbackMessage: string;
  isInPlayOutMode: boolean;
  isStockfishThinking: boolean;
  gameOverMessage: string | null;
}

export class PuzzleController {
  public state: PuzzleControllerState;
  public boardHandler: BoardHandler;

  constructor(
    public chessboardService: ChessboardService,
    boardHandler: BoardHandler, 
    private webhookService: WebhookService,
    private stockfishService: StockfishService,
    public requestRedraw: () => void
  ) {
    this.boardHandler = boardHandler; 
    this.state = {
      activePuzzle: null,
      puzzleSolutionMoves: [],
      currentSolutionMoveIndex: 0,
      isUserTurnInPuzzle: false,
      feedbackMessage: "Загрузите пазл для начала.",
      isInPlayOutMode: false,
      isStockfishThinking: false,
      gameOverMessage: null,
    };
    logger.info('[PuzzleController] Initialized with BoardHandler.');
  }

  public initializeGame(): void {
    this.loadAndStartPuzzle();
  }

  private formatGameEndMessage(outcome: GameEndOutcome | undefined): string | null {
    if (!outcome) return null;
    if (outcome.winner) {
      return `Мат! ${outcome.winner === 'white' ? 'Белые' : 'Черные'} победили (${outcome.reason || 'мат'}).`;
    }
    switch (outcome.reason) {
      case 'stalemate': return "Пат! Ничья.";
      case 'insufficient_material': return "Ничья (недостаточно материала).";
      case 'draw': return "Ничья (троекратное повторение, правило 50 ходов или соглашение).";
      default: return `Ничья (${outcome.reason || 'неизвестная причина'}).`;
    }
  }

  private checkAndSetGameOver(): boolean {
    const gameStatus: GameStatus = this.boardHandler.getGameStatus();
    logger.debug(`[PuzzleController checkAndSetGameOver] GameStatus from BoardHandler: ${JSON.stringify(gameStatus)}`);
    if (gameStatus.isGameOver) {
      this.state.gameOverMessage = this.formatGameEndMessage(gameStatus.outcome);
      this.state.feedbackMessage = this.state.gameOverMessage || "Игра завершена.";
      this.state.isUserTurnInPuzzle = false;
      this.state.isStockfishThinking = false;
      logger.info(`[PuzzleController] Game over detected by BoardHandler. Message: ${this.state.gameOverMessage}`);
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
    logger.info("[PuzzleController] Loading new puzzle...");
    this.state.feedbackMessage = "Загрузка пазла...";
    this.state.isInPlayOutMode = false;
    this.state.isStockfishThinking = false;
    this.state.gameOverMessage = null;
    this.requestRedraw();

    const puzzleData = await this.webhookService.fetchPuzzle();
    if (puzzleData) {
      this.state.activePuzzle = puzzleData;
      this.state.puzzleSolutionMoves = puzzleData.Moves ? puzzleData.Moves.split(' ') : [];
      this.state.currentSolutionMoveIndex = 0;

      this.boardHandler.setupPosition(puzzleData.FEN_0, puzzleData.HumanColor, true);
      
      logger.info(`[PuzzleController] Puzzle loaded: ${puzzleData.PuzzleId}. Initial FEN: ${this.boardHandler.getFen()}`);
      logger.info(`[PuzzleController] Human player color: ${this.boardHandler.getHumanPlayerColor()}. Solution moves: ${this.state.puzzleSolutionMoves.join(' ')}`);
      
      this.state.feedbackMessage = `Пазл ${puzzleData.PuzzleId}. Вы за ${this.boardHandler.getHumanPlayerColor() || 'N/A'}.`;
      
      if (this.checkAndSetGameOver()) return;

      const initialTurnColorInPuzzle = this.boardHandler.getBoardTurnColor();
      const humanColor = this.boardHandler.getHumanPlayerColor();

      if (this.state.puzzleSolutionMoves.length > 0) {
        if (initialTurnColorInPuzzle !== humanColor) {
            logger.info("[PuzzleController] System makes the first solution move.");
            this.state.isUserTurnInPuzzle = false;
            this.state.feedbackMessage = "Ход системы...";
            this.requestRedraw();
            setTimeout(() => this.playNextSolutionMoveInternal(false), 750);
        } else {
            this.state.isUserTurnInPuzzle = true;
            this.state.feedbackMessage = `Ваш ход. Ожидается: ${this.state.puzzleSolutionMoves[0]}`;
            logger.info(`[PuzzleController] Puzzle starts with user's turn. Expected: ${this.state.puzzleSolutionMoves[0]}`);
            this.requestRedraw();
        }
      } else {
        logger.warn("[PuzzleController] Puzzle has no moves in solution string! Setting user turn if applicable.");
        this.state.isUserTurnInPuzzle = initialTurnColorInPuzzle === humanColor;
        this.state.feedbackMessage = this.state.isUserTurnInPuzzle ? "Ваш ход (пазл без решения?)." : "Ход системы (пазл без решения?).";
        this.requestRedraw();
        if (!this.state.isUserTurnInPuzzle && !this.state.gameOverMessage) {
            this.state.isInPlayOutMode = true;
            this.triggerStockfishMoveInPlayoutIfNeeded();
        }
      }
    } else {
      logger.error("[PuzzleController] Failed to load puzzle.");
      this.state.feedbackMessage = "Ошибка загрузки пазла.";
      this.requestRedraw();
    }
  }

  private async triggerStockfishMoveInPlayoutIfNeeded(): Promise<void> {
    logger.debug(`[PuzzleController triggerStockfishMoveInPlayoutIfNeeded] Checking conditions. GameOver: ${!!this.state.gameOverMessage}, PromotionActive: ${this.boardHandler.promotionCtrl.isActive()}`);
    if (this.state.gameOverMessage || this.boardHandler.promotionCtrl.isActive()) {
      logger.info("[PuzzleController] Game is over or promotion is active, Stockfish will not move.");
      return;
    }

    const currentBoardTurn = this.boardHandler.getBoardTurnColor();
    const humanColor = this.boardHandler.getHumanPlayerColor();
    logger.debug(`[PuzzleController triggerStockfishMoveInPlayoutIfNeeded] InPlayout: ${this.state.isInPlayOutMode}, BoardTurn: ${currentBoardTurn}, HumanColor: ${humanColor}, StockfishThinking: ${this.state.isStockfishThinking}`);

    if (this.state.isInPlayOutMode && currentBoardTurn !== humanColor && !this.state.isStockfishThinking) {
      logger.info(`[PuzzleController] Triggering Stockfish move in playout. FEN: ${this.boardHandler.getFen()}`);
      this.state.isStockfishThinking = true;
      this.state.feedbackMessage = "Stockfish думает...";
      this.requestRedraw();

      try {
        const stockfishMoveUci = await this.stockfishService.getBestMoveOnly(this.boardHandler.getFen(), { depth: 12 });
        this.state.isStockfishThinking = false;

        if (stockfishMoveUci) {
          logger.info(`[PuzzleController] Stockfish auto-move in playout: ${stockfishMoveUci}`);
          // ИСПОЛЬЗУЕМ AttemptMoveResult
          const moveResult: AttemptMoveResult = this.boardHandler.applySystemMove(stockfishMoveUci);
          if (moveResult.success) {
            if (!this.checkAndSetGameOver()) {
              this.state.feedbackMessage = "Ваш ход.";
              this.state.isUserTurnInPuzzle = true;
            }
          } else {
            logger.error("[PuzzleController] Stockfish (auto) made an illegal move or FEN update failed:", stockfishMoveUci);
            this.state.feedbackMessage = "Ошибка Stockfish. Ваш ход.";
            this.state.isUserTurnInPuzzle = true;
          }
        } else {
          logger.warn("[PuzzleController] Stockfish (auto) did not return a move in playout.");
          if (!this.checkAndSetGameOver()) {
            this.state.feedbackMessage = "Stockfish не нашел ход или произошла ошибка. Ваш ход.";
            this.state.isUserTurnInPuzzle = true;
          }
        }
      } catch (error) {
        this.state.isStockfishThinking = false;
        logger.error("[PuzzleController] Error during Stockfish auto-move in playout:", error);
        if (!this.checkAndSetGameOver()) {
          this.state.feedbackMessage = "Ошибка при получении хода от Stockfish. Ваш ход.";
          this.state.isUserTurnInPuzzle = true;
        }
      }
      this.requestRedraw();
    }
  }

  private playNextSolutionMoveInternal(isContinuation: boolean = false): void {
    logger.debug(`[PuzzleController playNextSolutionMoveInternal] Called. isContinuation: ${isContinuation}. GameOver: ${!!this.state.gameOverMessage}, PromotionActive: ${this.boardHandler.promotionCtrl.isActive()}`);
    if (this.state.gameOverMessage || this.boardHandler.promotionCtrl.isActive()) return;

    logger.debug(`[PuzzleController playNextSolutionMoveInternal] ActivePuzzle: ${!!this.state.activePuzzle}, SolutionMoveIndex: ${this.state.currentSolutionMoveIndex}, SolutionMovesLength: ${this.state.puzzleSolutionMoves.length}`);
    if (!this.state.activePuzzle || this.state.currentSolutionMoveIndex >= this.state.puzzleSolutionMoves.length) {
      if (this.state.activePuzzle) {
        logger.info("[PuzzleController] Puzzle solution completed by system or no more moves. Entering play out mode.");
        this.state.feedbackMessage = "Пазл решен! Теперь можете доигрывать.";
        this.state.isInPlayOutMode = true;
        if (!this.checkAndSetGameOver()) {
          this.state.isUserTurnInPuzzle = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();
          logger.debug(`[PuzzleController playNextSolutionMoveInternal] Play out mode. isUserTurnInPuzzle set to: ${this.state.isUserTurnInPuzzle}`);
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
    this.state.feedbackMessage = isContinuation ? `Система отвечает: ${uciSolutionMove}` : `Система делает первый ход: ${uciSolutionMove}`;
    this.requestRedraw();

    // ИСПОЛЬЗУЕМ AttemptMoveResult
    const moveResult: AttemptMoveResult = this.boardHandler.applySystemMove(uciSolutionMove);

    if (moveResult.success) {
      logger.debug(`[PuzzleController playNextSolutionMoveInternal] System move ${uciSolutionMove} applied successfully by BoardHandler.`);
      this.state.currentSolutionMoveIndex++;
      if (this.checkAndSetGameOver()) return;

      if (this.state.currentSolutionMoveIndex >= this.state.puzzleSolutionMoves.length) {
        logger.info("[PuzzleController] SYSTEM COMPLETED PUZZLE SOLUTION (final move was by SystemPlayer)!");
        this.state.feedbackMessage = "Пазл решен! Теперь можете доигрывать.";
        this.state.isInPlayOutMode = true;
        this.state.isUserTurnInPuzzle = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();
        logger.debug(`[PuzzleController playNextSolutionMoveInternal] System solved. isUserTurnInPuzzle set to: ${this.state.isUserTurnInPuzzle}`);
        if (!this.state.isUserTurnInPuzzle && !this.state.gameOverMessage) {
          this.triggerStockfishMoveInPlayoutIfNeeded();
        }
      } else {
        this.state.isUserTurnInPuzzle = true;
        this.state.feedbackMessage = `Ваш ход. Ожидается: ${this.state.puzzleSolutionMoves[this.state.currentSolutionMoveIndex]}`;
        logger.debug(`[PuzzleController playNextSolutionMoveInternal] System moved, now user's turn. Expected: ${this.state.puzzleSolutionMoves[this.state.currentSolutionMoveIndex]}`);
      }
    } else {
      logger.error(`[PuzzleController] Failed to apply solution move ${uciSolutionMove} from BoardHandler. Result: ${JSON.stringify(moveResult)}`);
      this.state.feedbackMessage = "Ошибка в данных пазла. Не удалось применить ход системы.";
      this.state.isUserTurnInPuzzle = true; 
    }
    this.requestRedraw();
  }

  public async handleUserMove(orig: Key, dest: Key): Promise<void> {
    logger.debug(`[PuzzleController handleUserMove] User move: ${orig}-${dest}. GameOver: ${!!this.state.gameOverMessage}, PromotionActive: ${this.boardHandler.promotionCtrl.isActive()}, StockfishThinking: ${this.state.isStockfishThinking}`);
    if (this.state.gameOverMessage || this.boardHandler.promotionCtrl.isActive()) {
      logger.warn("[PuzzleController handleUserMove] Move ignored: game over or promotion active.");
      // Если промоушен активен, BoardHandler уже вызвал requestRedraw, чтобы показать диалог
      // this.requestRedraw() здесь не нужен, если только не для обновления feedbackMessage
      if (this.boardHandler.promotionCtrl.isActive()) {
        this.state.feedbackMessage = "Выберите фигуру для превращения.";
        this.requestRedraw();
      }
      return;
    }
    if (this.state.isStockfishThinking) {
      logger.warn("[PuzzleController handleUserMove] User attempted to move while Stockfish is thinking.");
      this.state.feedbackMessage = "Stockfish думает, подождите...";
      this.requestRedraw();
      return;
    }

    logger.debug(`[PuzzleController handleUserMove] Calling boardHandler.attemptUserMove for ${orig}-${dest}`);
    // ИСПОЛЬЗУЕМ AttemptMoveResult
    const moveResult: AttemptMoveResult = await this.boardHandler.attemptUserMove(orig, dest);
    logger.debug(`[PuzzleController handleUserMove] Result from boardHandler.attemptUserMove: ${JSON.stringify(moveResult)}`);

    // ИСПРАВЛЕНА ЛОГИКА: Теперь мы всегда ждем полного результата от attemptUserMove
    if (moveResult.success && moveResult.uciMove) {
        if (moveResult.promotionStarted && !moveResult.promotionCompleted) {
            // Этого случая быть не должно, если attemptUserMove ждет завершения промоушена.
            // Но если промоушен был отменен внутри BoardHandler (selectedRole = null),
            // то success будет false, а promotionCompleted false.
            logger.info("[PuzzleController handleUserMove] Promotion was started but seems to have been cancelled or not completed successfully.");
            this.state.feedbackMessage = "Превращение отменено или не удалось.";
            // BoardHandler должен был сам вызвать requestRedraw при отмене
        } else {
            logger.info(`[PuzzleController handleUserMove] User move ${moveResult.uciMove} (promotionCompleted: ${moveResult.promotionCompleted}) successful in BoardHandler. Processing result...`);
            this.processUserMoveResult(moveResult.uciMove);
        }
    } else if (moveResult.promotionStarted && !moveResult.success && !moveResult.promotionCompleted) {
        // Этот блок для случая, когда промоушен был начат, но отменен пользователем (например, клик вне диалога)
        // В этом случае BoardHandler.attemptUserMove должен вернуть success: false, promotionStarted: true, promotionCompleted: false
        logger.info("[PuzzleController handleUserMove] Promotion was cancelled by user.");
        this.state.feedbackMessage = "Превращение отменено.";
        // BoardHandler должен был вызвать requestRedraw, чтобы скрыть диалог.
        // Дополнительный requestRedraw здесь может быть излишним, но не повредит.
    } else if (!moveResult.success) {
        logger.warn(`[PuzzleController handleUserMove] User move ${orig}-${dest} failed in BoardHandler or was cancelled. Result: ${JSON.stringify(moveResult)}`);
        this.state.feedbackMessage = moveResult.promotionStarted ? "Превращение отменено." : "Неверный ход (отклонен BoardHandler).";
        // BoardHandler должен был откатить FEN или вызвать requestRedraw при отмене промоушена
    } else {
        logger.debug(`[PuzzleController handleUserMove] Unhandled case from attemptUserMove. Result: ${JSON.stringify(moveResult)}`);
    }
    this.requestRedraw(); // Общий redraw на всякий случай, чтобы UI был консистентен
  }

  private processUserMoveResult(uciMove: string): void {
    logger.info(`[PuzzleController processUserMoveResult] Processing user move: ${uciMove}. Current FEN: ${this.boardHandler.getFen()}`);
    logger.debug(`[PuzzleController processUserMoveResult] State before processing: isUserTurnInPuzzle=${this.state.isUserTurnInPuzzle}, currentSolutionMoveIndex=${this.state.currentSolutionMoveIndex}, isInPlayOutMode=${this.state.isInPlayOutMode}`);

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
      this.state.feedbackMessage = "Нет активного пазла.";
      this.requestRedraw();
      return;
    }

    if (!this.state.isUserTurnInPuzzle) {
      logger.warn("[PuzzleController processUserMoveResult] NOT USER'S TURN, but move was processed. This indicates a logic flaw. Forcing user turn for safety.");
      this.state.feedbackMessage = "Сейчас не ваш ход (ошибка логики).";
      this.state.isUserTurnInPuzzle = true; 
      this.requestRedraw();
      return;
    }

    const expectedMove = this.state.puzzleSolutionMoves[this.state.currentSolutionMoveIndex];
    logger.debug(`[PuzzleController processUserMoveResult] User move: ${uciMove}, Expected move: ${expectedMove}`);

    if (uciMove === expectedMove) {
      logger.info(`[PuzzleController processUserMoveResult] User move ${uciMove} is CORRECT!`);
      this.state.feedbackMessage = "Верно!";
      this.state.currentSolutionMoveIndex++;
      this.state.isUserTurnInPuzzle = false; 

      if (this.checkAndSetGameOver()) {
        logger.info(`[PuzzleController processUserMoveResult] Game over after user's correct move ${uciMove}.`);
        return; 
      }

      logger.debug(`[PuzzleController processUserMoveResult] After correct user move. New solution index: ${this.state.currentSolutionMoveIndex}, Total solution moves: ${this.state.puzzleSolutionMoves.length}`);
      if (this.state.currentSolutionMoveIndex >= this.state.puzzleSolutionMoves.length) {
        logger.info("[PuzzleController processUserMoveResult] USER COMPLETED PUZZLE SOLUTION!");
        this.state.feedbackMessage = "Пазл решен! Теперь можете доигрывать.";
        this.state.isInPlayOutMode = true;
        this.state.isUserTurnInPuzzle = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();
        logger.debug(`[PuzzleController processUserMoveResult] User solved. isUserTurnInPuzzle set to: ${this.state.isUserTurnInPuzzle}`);
        if (!this.state.isUserTurnInPuzzle && !this.state.gameOverMessage) {
          this.triggerStockfishMoveInPlayoutIfNeeded();
        }
      } else {
        this.state.feedbackMessage = "Ход системы...";
        const nextSystemMove = this.state.puzzleSolutionMoves[this.state.currentSolutionMoveIndex];
        logger.info(`[PuzzleController processUserMoveResult] Scheduling system's solution move: ${nextSystemMove} (index ${this.state.currentSolutionMoveIndex}). Current FEN: ${this.boardHandler.getFen()}`);
        setTimeout(() => {
            logger.info(`[PuzzleController processUserMoveResult] setTimeout EXECUTING for playNextSolutionMoveInternal. FEN before system move: ${this.boardHandler.getFen()}`);
            this.playNextSolutionMoveInternal(true);
        }, 300);
      }
    } else {
      logger.warn(`[PuzzleController processUserMoveResult] User move ${uciMove} is INCORRECT. Expected: ${expectedMove}. Undoing move.`);
      this.state.feedbackMessage = `Неверно. Ожидался ${expectedMove}. Попробуйте еще раз.`;
      if (this.boardHandler.undoLastMove()) {
          logger.info(`[PuzzleController processUserMoveResult] Incorrect user move ${uciMove} was undone by BoardHandler. FEN is now: ${this.boardHandler.getFen()}`);
      } else {
          logger.error(`[PuzzleController processUserMoveResult] Failed to undo incorrect user move ${uciMove} from BoardHandler.`);
      }
      this.state.isUserTurnInPuzzle = true; 
    }
    logger.info(`[PuzzleController processUserMoveResult] End of method. Feedback: "${this.state.feedbackMessage}", isUserTurn: ${this.state.isUserTurnInPuzzle}`);
    this.requestRedraw();
  }

  public handleSetFen(): void {
    if (this.boardHandler.promotionCtrl.isActive()) {
      this.boardHandler.promotionCtrl.cancel();
    }
    const fen = prompt("Enter FEN:", this.boardHandler.getFen());
    if (fen) {
      this.state.activePuzzle = null;
      this.state.puzzleSolutionMoves = [];
      this.state.currentSolutionMoveIndex = 0;
      this.state.isInPlayOutMode = true;
      this.state.isStockfishThinking = false;
      this.state.gameOverMessage = null;

      const humanPlayerColorBasedOnTurn = fen.includes(' w ') ? 'white' : 'black';
      this.boardHandler.setupPosition(fen, humanPlayerColorBasedOnTurn, true);
      
      if (this.checkAndSetGameOver()) return;

      this.state.isUserTurnInPuzzle = this.boardHandler.getBoardTurnColor() === this.boardHandler.getHumanPlayerColor();
      logger.info(`[PuzzleController handleSetFen] FEN set. isUserTurnInPuzzle: ${this.state.isUserTurnInPuzzle}`);

      if (!this.state.isUserTurnInPuzzle && !this.state.gameOverMessage) {
        this.state.feedbackMessage = "FEN установлен. Ход Stockfish.";
        this.triggerStockfishMoveInPlayoutIfNeeded();
      } else if (this.state.isUserTurnInPuzzle && !this.state.gameOverMessage) {
        this.state.feedbackMessage = "FEN установлен. Ваш ход.";
      } else if (this.state.gameOverMessage) {
        this.state.feedbackMessage = this.state.gameOverMessage;
      }
      this.requestRedraw();
    }
  }
}
