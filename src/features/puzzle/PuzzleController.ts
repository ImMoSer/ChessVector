// src/features/puzzle/PuzzleController.ts
import type { Key, MoveMetadata, Dests, Color as ChessgroundColor } from 'chessground';
import type { Role as ChessopsRole, Outcome } from 'chessops/types';
import type { ChessboardService } from '../../core/chessboard.service';
// ИСПРАВЛЕНИЕ: Импортируем ChessLogicService как значение, а не только как тип
import { ChessLogicService } from '../../core/chess-logic.service'; 
import type { WebhookService, AppPuzzle } from '../../core/webhook.service';
import type { StockfishService } from '../../core/stockfish.service';
import logger from '../../utils/logger';

interface AppState {
  currentFen: string;
  possibleMoves: Dests; 
  boardTurnColor: ChessgroundColor;
  humanPlayerColor: ChessgroundColor | undefined; 
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
  public appState: AppState;
  // chessLogicService (экземпляр) будет использоваться для нестатических методов
  private chessLogicServiceInstance: ChessLogicService;

  constructor(
    private chessboardService: ChessboardService,
    chessLogicServiceInstance: ChessLogicService, // Принимаем экземпляр
    private webhookService: WebhookService,
    private stockfishService: StockfishService,
    private requestRedraw: () => void
  ) {
    this.chessLogicServiceInstance = chessLogicServiceInstance; // Сохраняем экземпляр
    this.appState = {
      currentFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      possibleMoves: new Map<Key, Key[]>(),
      boardTurnColor: 'white',
      humanPlayerColor: undefined, 
      activePuzzle: null,
      puzzleSolutionMoves: [],
      currentSolutionMoveIndex: 0,
      isUserTurnInPuzzle: false,
      feedbackMessage: "Загрузите пазл для начала.",
      isInPlayOutMode: false,
      isStockfishThinking: false,
      gameOverMessage: null,
    };
  }

  // --- Методы управления состоянием и логикой игры ---

  public initializeGame(): void {
    this.updateBoardVisualsFromFen(this.appState.currentFen, this.appState.humanPlayerColor);
    this.loadAndStartPuzzle();
  }

  public determineMovableColor(): ChessgroundColor | 'both' | undefined {
    if (this.appState.gameOverMessage) return undefined;
    if (this.appState.isStockfishThinking) return undefined; 

    if (this.appState.isInPlayOutMode) {
        return this.appState.boardTurnColor === this.appState.humanPlayerColor ? this.appState.humanPlayerColor : undefined;
    } else if (this.appState.activePuzzle) {
        return this.appState.isUserTurnInPuzzle ? this.appState.boardTurnColor : undefined;
    }
    return this.appState.boardTurnColor;
  }

  public determineCurrentDests(): Dests {
    const movableColor = this.determineMovableColor();
    return movableColor ? this.appState.possibleMoves : new Map<Key, Key[]>();
  }

  private formatOutcome(outcome: Outcome | undefined): string | null {
    if (!outcome) return null;

    if (outcome.winner) {
        return `Мат! ${outcome.winner === 'white' ? 'Белые' : 'Черные'} победили.`;
    }
    const reason = (outcome as any).reason; 

    switch (reason) { 
        case 'stalemate': return "Пат! Ничья.";
        case 'threefold repetition': return "Ничья (троекратное повторение).";
        case 'fifty-move rule': return "Ничья (правило 50 ходов)."; 
        case 'fifty_moves': return "Ничья (правило 50 ходов).";
        case 'insufficient material': return "Ничья (недостаточно материала).";
        case 'draw': return "Ничья (по соглашению или другая причина).";
        default: return `Игра завершена (${reason || 'неизвестная причина'}).`; 
    }
  }

  private checkAndSetGameOver(fen: string): boolean {
    // Статические методы вызываются через имя класса
    const position = ChessLogicService.getPosition(fen); 
    if (position) {
        const outcome = position.outcome();
        if (outcome) {
            this.appState.gameOverMessage = this.formatOutcome(outcome);
            this.appState.feedbackMessage = this.appState.gameOverMessage || "Игра завершена.";
            this.appState.isUserTurnInPuzzle = false; 
            this.appState.isStockfishThinking = false; 
            logger.info(`[PuzzleController] Game over: ${this.appState.gameOverMessage}`);
            return true;
        }
    }
    this.appState.gameOverMessage = null; 
    return false;
  }

  public updateBoardVisualsFromFen(fen: string, humanColorForOrientation?: ChessgroundColor | undefined): void {
    logger.debug(`[PuzzleController] Updating visuals for FEN: ${fen}`);
    this.appState.currentFen = fen;
    
    const isGameOver = this.checkAndSetGameOver(fen);

    if (!isGameOver) {
      // Нестатический метод вызывается через экземпляр
      this.appState.possibleMoves = this.chessLogicServiceInstance.getPossibleMoves(fen);
    } else {
      this.appState.possibleMoves = new Map<Key, Key[]>(); 
    }
    this.appState.boardTurnColor = fen.includes(' w ') ? 'white' : 'black';

    if (this.chessboardService.ground) {
      this.chessboardService.setFen(fen); 

      const currentOrientation = this.chessboardService.ground.state.orientation;
      if (humanColorForOrientation && humanColorForOrientation !== currentOrientation) {
        this.chessboardService.setOrientation(humanColorForOrientation);
        logger.debug(`[PuzzleController] Orientation set to: ${humanColorForOrientation}`);
      }
      
      const newMovableColor = this.determineMovableColor();
      const newDests = this.determineCurrentDests();

      logger.debug(`[PuzzleController] Setting ground - turnColor: ${this.appState.boardTurnColor}, movable.color: ${newMovableColor}, dests count: ${newDests.size}`);

      this.chessboardService.ground.set({
        turnColor: this.appState.boardTurnColor,
        movable: {
          color: newMovableColor, 
          dests: newDests,      
        }
      });
    }
    this.requestRedraw();
  }

  private isPromotionAttempt(orig: Key, dest: Key, fen: string): boolean {
    // Статический метод
    const piece = ChessLogicService.getPieceAtSquare(fen, orig); 
    if (!piece || piece.role !== 'pawn') return false;
    const destRank = dest.charAt(1); 
    return (piece.color === 'white' && destRank === '8') || (piece.color === 'black' && destRank === '1');
  }

  public async loadAndStartPuzzle(): Promise<void> {
    logger.info("[PuzzleController] Loading new puzzle...");
    this.appState.feedbackMessage = "Загрузка пазла...";
    this.appState.isInPlayOutMode = false;
    this.appState.isStockfishThinking = false; 
    this.appState.gameOverMessage = null; 
    this.requestRedraw(); 

    const puzzleData = await this.webhookService.fetchPuzzle({});
    if (puzzleData) {
      this.appState.activePuzzle = puzzleData;
      this.appState.puzzleSolutionMoves = puzzleData.Moves ? puzzleData.Moves.split(' ') : [];
      this.appState.currentSolutionMoveIndex = 0;
      this.appState.humanPlayerColor = puzzleData.HumanColor; 

      logger.info("[PuzzleController] Puzzle loaded, initial state:", puzzleData);
      this.appState.feedbackMessage = `Пазл ${puzzleData.PuzzleId}. Вы за ${this.appState.humanPlayerColor || 'N/A'}.`;

      this.updateBoardVisualsFromFen(puzzleData.FEN_0, this.appState.humanPlayerColor); 

      this.appState.isUserTurnInPuzzle = false; 
      if (this.appState.puzzleSolutionMoves.length > 0) {
          if (!this.appState.gameOverMessage) { 
              logger.info("[PuzzleController] SystemPlayer makes the first solution move...");
              this.appState.feedbackMessage = "Ход системы...";
              this.requestRedraw(); 
              setTimeout(() => this.playNextSolutionMoveInternal(false), 750); 
          }
      } else {
          logger.warn("[PuzzleController] Puzzle has no moves in solution string! Setting user turn.");
          if (!this.appState.gameOverMessage) {
              this.appState.isUserTurnInPuzzle = this.appState.boardTurnColor === this.appState.humanPlayerColor;
              this.updateBoardVisualsFromFen(this.appState.currentFen, this.appState.humanPlayerColor); 
              this.triggerStockfishMoveInPlayoutIfNeeded();
          }
      }
    } else {
      logger.error("[PuzzleController] Failed to load puzzle.");
      this.appState.feedbackMessage = "Ошибка загрузки пазла.";
      this.requestRedraw();
    }
  }

  private async triggerStockfishMoveInPlayoutIfNeeded(): Promise<void> {
    if (this.appState.gameOverMessage) { 
        logger.info("[PuzzleController] Game is over, Stockfish will not move.");
        return;
    }

    if (this.appState.isInPlayOutMode && 
        this.appState.boardTurnColor !== this.appState.humanPlayerColor && 
        !this.appState.isStockfishThinking) {
        
        logger.info(`[PuzzleController] Triggering Stockfish move in playout. FEN: ${this.appState.currentFen}`);
        this.appState.isStockfishThinking = true;
        this.appState.feedbackMessage = "Stockfish думает...";
        this.updateBoardVisualsFromFen(this.appState.currentFen, this.appState.humanPlayerColor); 

        try {
            const stockfishMoveUci = await this.stockfishService.getBestMove(this.appState.currentFen, { depth: 10 });
            this.appState.isStockfishThinking = false;

            if (stockfishMoveUci) {
                logger.info(`[PuzzleController] Stockfish auto-move in playout: ${stockfishMoveUci}`);
                // Нестатический метод
                const newFenAfterStockfish = this.chessLogicServiceInstance.getFenAfterMove(this.appState.currentFen, stockfishMoveUci);
                if (newFenAfterStockfish) {
                    if (!this.checkAndSetGameOver(newFenAfterStockfish)) {
                        this.appState.feedbackMessage = "Ваш ход.";
                    }
                    this.updateBoardVisualsFromFen(newFenAfterStockfish, this.appState.humanPlayerColor);
                } else {
                    logger.error("[PuzzleController] Stockfish (auto) made an illegal move or FEN update failed:", stockfishMoveUci);
                    this.appState.feedbackMessage = "Ошибка Stockfish. Ваш ход.";
                    this.updateBoardVisualsFromFen(this.appState.currentFen, this.appState.humanPlayerColor); 
                }
            } else { 
                logger.warn("[PuzzleController] Stockfish (auto) did not return a move in playout.");
                if (!this.checkAndSetGameOver(this.appState.currentFen)) {
                     this.appState.feedbackMessage = "Stockfish не нашел ход или произошла ошибка. Ваш ход.";
                }
                this.updateBoardVisualsFromFen(this.appState.currentFen, this.appState.humanPlayerColor);
            }
            if (!this.appState.gameOverMessage) {
                this.appState.isUserTurnInPuzzle = true; 
            }
             this.updateBoardVisualsFromFen(this.appState.currentFen, this.appState.humanPlayerColor);

        } catch (error) {
            this.appState.isStockfishThinking = false;
            logger.error("[PuzzleController] Error during Stockfish auto-move in playout:", error);
            if (!this.checkAndSetGameOver(this.appState.currentFen)) { 
                this.appState.feedbackMessage = "Ошибка при получении хода от Stockfish. Ваш ход.";
                this.appState.isUserTurnInPuzzle = true;
            }
            this.updateBoardVisualsFromFen(this.appState.currentFen, this.appState.humanPlayerColor);
        }
    }
  }

  private playNextSolutionMoveInternal(isContinuation: boolean = false): void {
    if (this.appState.gameOverMessage) return; 

    if (!this.appState.activePuzzle || this.appState.currentSolutionMoveIndex >= this.appState.puzzleSolutionMoves.length) {
        if(this.appState.activePuzzle) {
            logger.info("[PuzzleController] Puzzle solution completed. Entering play out mode.");
            this.appState.feedbackMessage = "Пазл решен! Теперь можете доигрывать.";
            this.appState.isInPlayOutMode = true;
            if (!this.checkAndSetGameOver(this.appState.currentFen)) {
                this.appState.isUserTurnInPuzzle = this.appState.boardTurnColor === this.appState.humanPlayerColor;
            }
        }
        this.updateBoardVisualsFromFen(this.appState.currentFen, this.appState.humanPlayerColor);
        if (!this.appState.gameOverMessage) { 
            this.triggerStockfishMoveInPlayoutIfNeeded(); 
        }
        return;
    }

    const uciSolutionMove = this.appState.puzzleSolutionMoves[this.appState.currentSolutionMoveIndex];
    logger.info(`[PuzzleController] SystemPlayer playing solution move ${this.appState.currentSolutionMoveIndex + 1}/${this.appState.puzzleSolutionMoves.length}: ${uciSolutionMove}`);
    this.appState.feedbackMessage = isContinuation ? `Система отвечает: ${uciSolutionMove}` : `Система делает первый ход: ${uciSolutionMove}`;

    // Нестатический метод
    const newFen = this.chessLogicServiceInstance.getFenAfterMove(this.appState.currentFen, uciSolutionMove);
    if (newFen) {
        this.appState.currentSolutionMoveIndex++; 

        if (this.appState.currentSolutionMoveIndex >= this.appState.puzzleSolutionMoves.length) {
            logger.info("[PuzzleController] PUZZLE SOLUTION COMPLETED (final move was by SystemPlayer)!");
            this.appState.feedbackMessage = "Пазл решен! Теперь можете доигрывать.";
            this.appState.isInPlayOutMode = true;
            if (!this.checkAndSetGameOver(newFen)) { 
                this.appState.isUserTurnInPuzzle = (newFen.includes(' w ') ? 'white' : 'black') === this.appState.humanPlayerColor;
            }
            this.updateBoardVisualsFromFen(newFen, this.appState.humanPlayerColor);
            if (!this.appState.gameOverMessage) {
                this.triggerStockfishMoveInPlayoutIfNeeded(); 
            }
        } else {
            this.appState.isUserTurnInPuzzle = true;
            this.appState.feedbackMessage = `Ваш ход. Ожидается: ${this.appState.puzzleSolutionMoves[this.appState.currentSolutionMoveIndex]}`;
            this.updateBoardVisualsFromFen(newFen, this.appState.humanPlayerColor);
            if (this.checkAndSetGameOver(newFen)) {
                this.updateBoardVisualsFromFen(newFen, this.appState.humanPlayerColor); 
            }
        }
    } else {
        logger.error(`[PuzzleController] Failed to apply solution move ${uciSolutionMove} to FEN ${this.appState.currentFen}`);
        this.appState.feedbackMessage = "Ошибка в данных пазла. Не удалось применить ход системы.";
        this.appState.isUserTurnInPuzzle = true; 
        this.updateBoardVisualsFromFen(this.appState.currentFen, this.appState.humanPlayerColor); 
    }
  }

  private async handlePlayOutMove(userUciMove: string): Promise<void> {
    if (this.appState.gameOverMessage) return;
    if (this.appState.isStockfishThinking) {
        logger.warn("[PuzzleController handlePlayOutMove] User attempted to move while Stockfish is thinking.");
        return; 
    }
    if (this.appState.boardTurnColor !== this.appState.humanPlayerColor) {
        logger.warn("[PuzzleController handlePlayOutMove] Not human player's turn.");
        this.appState.feedbackMessage = "Сейчас не ваш ход.";
        this.requestRedraw(); 
        return;
    }

    // Нестатический метод
    const newFenAfterUser = this.chessLogicServiceInstance.getFenAfterMove(this.appState.currentFen, userUciMove);
    if (newFenAfterUser) {
        if (this.checkAndSetGameOver(newFenAfterUser)) {
            this.updateBoardVisualsFromFen(newFenAfterUser, this.appState.humanPlayerColor);
            return; 
        }

        this.appState.isUserTurnInPuzzle = false; 
        this.appState.isStockfishThinking = true;
        this.appState.feedbackMessage = "Stockfish думает...";
        this.updateBoardVisualsFromFen(newFenAfterUser, this.appState.humanPlayerColor); 

        try {
            logger.info(`[PuzzleController handlePlayOutMove] Requesting best move from Stockfish for FEN: ${this.appState.currentFen}`);
            const stockfishMoveUci = await this.stockfishService.getBestMove(this.appState.currentFen, { depth: 10 }); 
            
            this.appState.isStockfishThinking = false;

            if (stockfishMoveUci) {
                logger.info(`[PuzzleController handlePlayOutMove] Stockfish move: ${stockfishMoveUci}`);
                // Нестатический метод
                const newFenAfterStockfish = this.chessLogicServiceInstance.getFenAfterMove(this.appState.currentFen, stockfishMoveUci);
                if (newFenAfterStockfish) {
                     if (!this.checkAndSetGameOver(newFenAfterStockfish)) { 
                        this.appState.feedbackMessage = "Ваш ход.";
                    }
                    this.updateBoardVisualsFromFen(newFenAfterStockfish, this.appState.humanPlayerColor);
                } else {
                    logger.error("[PuzzleController handlePlayOutMove] Stockfish made an illegal move or FEN update failed:", stockfishMoveUci);
                    if (!this.checkAndSetGameOver(this.appState.currentFen)) {
                        this.appState.feedbackMessage = "Ошибка Stockfish. Ваш ход.";
                    }
                    this.updateBoardVisualsFromFen(this.appState.currentFen, this.appState.humanPlayerColor);
                }
            } else { 
                logger.warn("[PuzzleController handlePlayOutMove] Stockfish did not return a move.");
                if (!this.checkAndSetGameOver(this.appState.currentFen)) { 
                     this.appState.feedbackMessage = "Stockfish не нашел ход или произошла ошибка. Ваш ход.";
                }
                this.updateBoardVisualsFromFen(this.appState.currentFen, this.appState.humanPlayerColor);
            }
        } catch (error) {
            this.appState.isStockfishThinking = false;
            logger.error("[PuzzleController handlePlayOutMove] Error during Stockfish move retrieval:", error);
             if (!this.checkAndSetGameOver(this.appState.currentFen)) {
                this.appState.feedbackMessage = "Ошибка при получении хода от Stockfish. Ваш ход.";
            }
        }
        
        if (!this.appState.gameOverMessage) {
            this.appState.isUserTurnInPuzzle = true; 
        }
        this.updateBoardVisualsFromFen(this.appState.currentFen, this.appState.humanPlayerColor); 

    } else {
        logger.warn(`[PuzzleController handlePlayOutMove] Illegal user move in playout: ${userUciMove}`);
        this.appState.feedbackMessage = "Нелегальный ход.";
        this.chessboardService.setFen(this.appState.currentFen); 
        this.requestRedraw();
    }
  }

  public handleUserMove(orig: Key, dest: Key): void {
    if (this.appState.gameOverMessage) return;
    if (this.appState.isStockfishThinking) {
        logger.warn("[PuzzleController handleUserMove] User attempted to move while Stockfish is thinking.");
        this.appState.feedbackMessage = "Stockfish думает, подождите...";
        this.requestRedraw();
        return;
    }

    let promotionRoleChessops: ChessopsRole | undefined;
    if (this.isPromotionAttempt(orig, dest, this.appState.currentFen)) {
        const roleChar = prompt("Promote to (q, r, b, n):", "q");
        // Статический метод
        promotionRoleChessops = ChessLogicService.roleFromString(roleChar || "q") || 'queen'; 
    }
    // Нестатический метод
    const userUciMove = this.chessLogicServiceInstance.toUci(orig, dest, promotionRoleChessops);

    if (!userUciMove) {
        logger.warn("[PuzzleController] Invalid user move (UCI conversion failed).");
        this.appState.feedbackMessage = "Некорректный ход.";
        this.chessboardService.setFen(this.appState.currentFen); 
        this.requestRedraw();
        return;
    }

    if (this.appState.isInPlayOutMode) {
        logger.info(`[PuzzleController] User move in playout mode: ${userUciMove}`);
        this.handlePlayOutMove(userUciMove); 
        return;
    }

    if (!this.appState.activePuzzle) {
        logger.warn("[PuzzleController] No active puzzle, ignoring user move.");
        this.appState.feedbackMessage = "Нет активного пазла.";
         this.chessboardService.setFen(this.appState.currentFen);
        this.requestRedraw();
        return;
    }

    if (!this.appState.isUserTurnInPuzzle) {
        logger.warn("[PuzzleController] Not user's turn in puzzle.");
        this.appState.feedbackMessage = "Сейчас не ваш ход.";
        this.chessboardService.setFen(this.appState.currentFen); 
        this.requestRedraw();
        return;
    }

    const expectedMove = this.appState.puzzleSolutionMoves[this.appState.currentSolutionMoveIndex];
    if (userUciMove === expectedMove) {
        logger.info(`[PuzzleController] User move ${userUciMove} is CORRECT!`);
        
        // Нестатический метод
        const newFen = this.chessLogicServiceInstance.getFenAfterMove(this.appState.currentFen, userUciMove);
        if (newFen) {
            if (this.checkAndSetGameOver(newFen)) { 
                this.appState.feedbackMessage = this.appState.gameOverMessage || "Верно! Игра завершена.";
                this.updateBoardVisualsFromFen(newFen, this.appState.humanPlayerColor);
                return;
            }
            this.appState.feedbackMessage = "Верно!"; 
            this.appState.currentSolutionMoveIndex++;
            this.appState.isUserTurnInPuzzle = false; 

            if (this.appState.currentSolutionMoveIndex >= this.appState.puzzleSolutionMoves.length) {
                logger.info("[PuzzleController] PUZZLE SOLVED BY USER!");
                this.appState.feedbackMessage = "Пазл решен! Теперь можете доигрывать.";
                this.appState.isInPlayOutMode = true;
                if (!this.checkAndSetGameOver(newFen)) { 
                    this.appState.isUserTurnInPuzzle = (newFen.includes(' w ') ? 'white' : 'black') === this.appState.humanPlayerColor;
                }
                this.updateBoardVisualsFromFen(newFen, this.appState.humanPlayerColor); 
                if (!this.appState.gameOverMessage) {
                    this.triggerStockfishMoveInPlayoutIfNeeded(); 
                }
            } else {
                this.appState.feedbackMessage = "Ход системы...";
                this.updateBoardVisualsFromFen(newFen, this.appState.humanPlayerColor); 
                setTimeout(() => this.playNextSolutionMoveInternal(true), 300); 
            }
        } else {
             logger.error(`[PuzzleController] Error applying correct user move ${userUciMove}. This should not happen if move is legal.`);
             this.appState.feedbackMessage = "Ошибка применения вашего верного хода. Пожалуйста, сообщите об этом.";
             this.chessboardService.setFen(this.appState.currentFen); 
             this.requestRedraw();
        }
    } else {
        logger.warn(`[PuzzleController] User move ${userUciMove} is INCORRECT. Expected: ${expectedMove}`);
        this.appState.feedbackMessage = `Неверно. Ожидался ${expectedMove}. Попробуйте еще раз.`;
        this.chessboardService.setFen(this.appState.currentFen); 
        this.requestRedraw();
    }
  }

  public handleSetFen(): void {
    const fen = prompt("Enter FEN:", this.appState.currentFen);
    if (fen) {
      this.appState.activePuzzle = null; 
      this.appState.isInPlayOutMode = true; 
      this.appState.isStockfishThinking = false; 
      this.appState.gameOverMessage = null; 
      this.appState.humanPlayerColor = fen.includes(' w ') ? 'white' : 'black'; 
      const currentTurnInFen = fen.includes(' w ') ? 'white' : 'black';
      this.appState.isUserTurnInPuzzle = currentTurnInFen === this.appState.humanPlayerColor; 
      
      this.updateBoardVisualsFromFen(fen, this.appState.humanPlayerColor); 
      if (!this.appState.gameOverMessage) { 
          if (this.appState.boardTurnColor !== this.appState.humanPlayerColor) {
              this.appState.feedbackMessage = "FEN установлен. Ход Stockfish.";
              this.triggerStockfishMoveInPlayoutIfNeeded(); 
           } else {
              this.appState.feedbackMessage = "FEN установлен. Ваш ход.";
           }
      }
      this.requestRedraw(); 
    }
  }
}
