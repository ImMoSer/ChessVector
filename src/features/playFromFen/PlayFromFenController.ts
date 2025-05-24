// src/features/playFromFen/PlayFromFenController.ts
import type { Key } from 'chessground/types';
import type { ChessboardService } from '../../core/chessboard.service';
import type { WebhookServiceController, PlayFromFenRequestPayload, ProcessedPlayFromFenResponseData } from '../../core/webhook.service';
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
import { AuthService } from '../../core/auth.service';
import { PgnService } from '../../core/pgn.service';
import { parseFen } from 'chessops/fen';

interface PlayFromFenControllerState {
  isLoadingFen: boolean;
  currentFen: string | null;
  initialLoadedFen: string | null; // Для корректного рестарта
  isUserTurn: boolean;
  feedbackMessage: string;
  isStockfishThinking: boolean;
  gameOverMessage: string | null;
  isGameEffectivelyActive: boolean;
  currentPositionCp?: number;
  currentPositionClass?: string;
  currentPositionDifficultyClass?: number;
  currentPositionPuzzleId?: string;
}

export class PlayFromFenController {
  public state: PlayFromFenControllerState;
  public boardHandler: BoardHandler;
  public analysisController: AnalysisController;
  private authService: typeof AuthService;
  private webhookService: WebhookServiceController;
  private stockfishService: StockfishService;
  private pgnService: typeof PgnService;

  constructor(
    public chessboardService: ChessboardService,
    boardHandler: BoardHandler,
    authService: typeof AuthService,
    webhookService: WebhookServiceController,
    stockfishService: StockfishService,
    analysisController: AnalysisController,
    pgnService: typeof PgnService,
    public requestRedraw: () => void
  ) {
    this.boardHandler = boardHandler;
    this.authService = authService;
    this.webhookService = webhookService;
    this.stockfishService = stockfishService;
    this.analysisController = analysisController;
    this.pgnService = pgnService;

    this.state = {
      isLoadingFen: false,
      currentFen: null,
      initialLoadedFen: null, // Инициализируем
      isUserTurn: false,
      feedbackMessage: t('playFromFen.feedback.loadingFen'),
      isStockfishThinking: false,
      gameOverMessage: null,
      isGameEffectivelyActive: false,
      currentPositionCp: undefined,
      currentPositionClass: undefined,
      currentPositionDifficultyClass: undefined,
      currentPositionPuzzleId: undefined,
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

    logger.info('[PlayFromFenController] Initialized.');
    this.handleRequestNewFenFromServer(); // Запрашиваем FEN при инициализации
  }

  private _registerGameCallbacksWithAnalysisController(): void {
    const gameCallbacks: GameControlCallbacks = {
      onNextTaskRequested: () => this.handleRequestNewFenFromServer(),
      onRestartTaskRequested: () => this.handleRestartGame(),
      onStopGameRequested: () => this._stopCurrentGameActivity(),
    };
    this.analysisController.setGameControlCallbacks(gameCallbacks);
  }

  private _updateAnalysisControllerGameState(): void {
    const isGameOver = !!this.state.gameOverMessage;
    const gameState: GameControlState = {
      canRestartTask: !!this.state.initialLoadedFen && !this.state.isLoadingFen, // Можно перезапустить, если есть начальный FEN и не грузим новый
      canLoadNextTask: !this.state.isLoadingFen, // Можно загрузить новый, если не идет текущая загрузка
      isGameActive: this.state.isGameEffectivelyActive && !isGameOver, // Игра активна, если она идет и не завершена
    };
    this.analysisController.updateGameControlState(gameState);
  }

  private _stopCurrentGameActivity(): void {
    logger.info(`[PlayFromFenController] Stopping current game activity.`);
    this.state.isStockfishThinking = false;
    this.state.isUserTurn = false;
    this.state.isGameEffectivelyActive = false; // Игра больше не активна

    if (this.state.gameOverMessage === null) { // Если игра была прервана до естественного завершения
        this.state.feedbackMessage = t('playFromFen.feedback.gameStoppedForAnalysis');
    }
    // gameOverMessage не сбрасываем, если он был установлен (например, мат)
    this._updateAnalysisControllerGameState(); // Обновляем состояние кнопок в панели анализа
    this.requestRedraw();
  }

  public initializeGameWithFen(fen: string, positionDetails?: Omit<ProcessedPlayFromFenResponseData, 'FEN_0'>): void {
    if (this.boardHandler.promotionCtrl.isActive()) this.boardHandler.promotionCtrl.cancel();

    // Выключаем анализ, только если он был активен и мы загружаем ДРУГОЙ FEN (т.е. не рестарт той же позиции)
    if (this.analysisController.getPanelState().isAnalysisActive && this.state.initialLoadedFen !== fen) {
      this.analysisController.toggleAnalysisEngine();
    }

    this.state.currentFen = fen;
    this.state.initialLoadedFen = fen; // Сохраняем как начальный FEN для этого "задания"
    this.state.isUserTurn = false;
    this.state.feedbackMessage = t('playFromFen.feedback.settingUpPosition');
    this.state.isStockfishThinking = false;
    this.state.gameOverMessage = null; // Сбрасываем сообщение о конце предыдущей игры
    this.state.isGameEffectivelyActive = true;

    this.state.currentPositionCp = positionDetails?.cp;
    this.state.currentPositionClass = positionDetails?.position_class;
    this.state.currentPositionDifficultyClass = positionDetails?.difficulty_class;
    this.state.currentPositionPuzzleId = positionDetails?.PuzzleId;

    this.requestRedraw();

    try {
        const setup = parseFen(fen).unwrap();
        const turnInFen = setup.turn;
        this.pgnService.reset(fen); // Сбрасываем PGN историю для новой игры
        this.boardHandler.setupPosition(fen, 'white', false); // false - не сбрасывать PGN, т.к. мы его уже сбросили выше для ЭТОЙ позиции
        
        this.state.currentFen = this.boardHandler.getFen();

        logger.info(`[PlayFromFenController] Game initialized with FEN: ${this.state.currentFen}. Turn in FEN: ${turnInFen}. User plays first. Details:`, positionDetails);
        
        this.state.isUserTurn = true;
        this.state.feedbackMessage = t('playFromFen.feedback.yourTurn');

        if (this.checkAndSetGameOver()) return;

    } catch (error: any) {
        logger.error(`[PlayFromFenController] Error initializing game with FEN "${fen}":`, error);
        this.state.feedbackMessage = t('playFromFen.error.invalidFen', { fen });
        this.state.currentFen = null;
        this.state.initialLoadedFen = null;
        this.state.isGameEffectivelyActive = false;
        this.state.currentPositionCp = undefined;
        this.state.currentPositionClass = undefined;
        this.state.currentPositionDifficultyClass = undefined;
        this.state.currentPositionPuzzleId = undefined;
    }
    this._updatePgnDisplay();
    this._updateAnalysisControllerGameState();
    this.requestRedraw();
  }

  private _updatePgnDisplay(): void {
    // PGN не отображается
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

  private checkAndSetGameOver(): boolean {
    if (this.analysisController.getPanelState().isAnalysisActive) {
        if (this.state.gameOverMessage) {
            this.state.gameOverMessage = null; // Если анализ включен, не показываем сообщение о конце игры в feedback
        }
        // isGameEffectivelyActive не меняем, если просто включен анализ
        this._updateAnalysisControllerGameState();
        return false;
    }

    const fenHistoryForRepetition = this.pgnService.getFenHistoryForRepetition();
    const currentBoardFenOnly = this.boardHandler.getFen().split(' ')[0];
    let repetitionCount = 0;
    for (const fenPart of fenHistoryForRepetition) {
        if (fenPart === currentBoardFenOnly) {
            repetitionCount++;
        }
    }
    if (repetitionCount >= 3) {
        this.state.gameOverMessage = this.formatGameEndMessage({ winner: undefined, reason: 'draw' });
        this.state.feedbackMessage = this.state.gameOverMessage || t('puzzle.feedback.gameOver');
        this.state.isUserTurn = false;
        this.state.isStockfishThinking = false;
        this.state.isGameEffectivelyActive = false;
        logger.info(`[PlayFromFenController] Game over: Threefold repetition.`);
        SoundService.playSound('DRAW_GENERAL');
        this._updatePgnDisplay();
        this._updateAnalysisControllerGameState();
        this.requestRedraw();
        return true;
    }

    const gameStatus: GameStatus = this.boardHandler.getGameStatus();
    if (gameStatus.isGameOver) {
      this.state.gameOverMessage = this.formatGameEndMessage(gameStatus.outcome);
      this.state.feedbackMessage = this.state.gameOverMessage || t('puzzle.feedback.gameOver');
      this.state.isUserTurn = false;
      this.state.isStockfishThinking = false;
      this.state.isGameEffectivelyActive = false;
      logger.info(`[PlayFromFenController] Game over detected by BoardHandler. Message: ${this.state.gameOverMessage}. Reason: ${gameStatus.outcome?.reason}`);
      
      if (gameStatus.outcome?.reason === 'stalemate') {
          SoundService.playSound('stalemate');
      } else if (gameStatus.outcome?.winner === this.boardHandler.getHumanPlayerColor()) {
          SoundService.playSound('puzzle_user_won');
      } else if (gameStatus.outcome?.winner) {
          SoundService.playSound('puzzle_user_lost');
      } else if (gameStatus.outcome?.reason === 'draw') {
          SoundService.playSound('DRAW_GENERAL');
      }

      this._updatePgnDisplay();
      this._updateAnalysisControllerGameState();
      this.requestRedraw();
      return true;
    }
    this.state.gameOverMessage = null; // Если игра не закончена, убеждаемся, что сообщение сброшено
    // isGameEffectivelyActive остается true, если игра не закончена
    this._updateAnalysisControllerGameState(); // Обновляем состояние кнопок
    return false;
  }

  public async handleUserMove(orig: Key, dest: Key): Promise<void> {
    const analysisIsActive = this.analysisController.getPanelState().isAnalysisActive;

    if (analysisIsActive) {
        logger.info(`[PlayFromFenController] User interacting with board while analysis is active: ${orig}-${dest}. Forwarding to BoardHandler.`);
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
        this._updatePgnDisplay();
        this.requestRedraw();
        return;
    }

    if (this.state.gameOverMessage) {
        logger.warn("[PlayFromFenController handleUserMove] Move ignored: game over.");
        return;
    }
    if (this.boardHandler.promotionCtrl.isActive()) {
        logger.warn("[PlayFromFenController handleUserMove] Move ignored: promotion active.");
        this.state.feedbackMessage = t('puzzle.feedback.selectPromotion');
        this.requestRedraw();
        return;
    }
    if (this.state.isStockfishThinking) {
        logger.warn("[PlayFromFenController handleUserMove] User attempted to move while Stockfish is thinking.");
        this.state.feedbackMessage = t('puzzle.feedback.stockfishThinkingWait');
        this.requestRedraw();
        return;
    }
    if (!this.state.isUserTurn) {
        logger.warn(`[PlayFromFenController handleUserMove] User attempted to move when it's not their turn.`);
        this.state.feedbackMessage = t('puzzle.feedback.notYourTurn');
        this.requestRedraw();
        return;
    }

    const moveResult: AttemptMoveResult = await this.boardHandler.attemptUserMove(orig, dest);

    if (moveResult.success && moveResult.uciMove) {
      this.state.currentFen = this.boardHandler.getFen();
      this._updatePgnDisplay();

      if (this.checkAndSetGameOver()) return;

      this.state.isUserTurn = false;
      this.state.feedbackMessage = t('playFromFen.feedback.stockfishThinking');
      this.requestRedraw();
      this.triggerStockfishMove();
    } else if (moveResult.promotionStarted && !moveResult.success && !moveResult.promotionCompleted) {
      logger.info("[PlayFromFenController handleUserMove] Promotion was cancelled by user.");
      this.state.feedbackMessage = t('puzzle.feedback.promotionCancelled');
      this.requestRedraw();
    } else if (!moveResult.success) {
      logger.warn(`[PlayFromFenController handleUserMove] User move ${orig}-${dest} failed. Result: ${JSON.stringify(moveResult)}`);
      this.state.feedbackMessage = moveResult.isIllegal ? t('puzzle.feedback.invalidMove') : t('puzzle.feedback.moveProcessingError');
      this.requestRedraw();
    }
  }

  private async triggerStockfishMove(): Promise<void> {
    if (this.state.gameOverMessage || this.boardHandler.promotionCtrl.isActive() || this.analysisController.getPanelState().isAnalysisActive || !this.state.isGameEffectivelyActive) {
      this.state.isStockfishThinking = false;
      this.requestRedraw();
      return;
    }

    if (!this.state.currentFen) {
        logger.error("[PlayFromFenController triggerStockfishMove] No current FEN to analyze for Stockfish.");
        this.state.feedbackMessage = t('playFromFen.error.internalError');
        this.state.isUserTurn = true;
        this.state.isStockfishThinking = false;
        this.requestRedraw();
        return;
    }

    this.state.isStockfishThinking = true;

    try {
      const stockfishMoveUci = await this.stockfishService.getBestMoveOnly(this.state.currentFen, { depth: 10 });
      this.state.isStockfishThinking = false;

      if (this.state.gameOverMessage || !this.state.isGameEffectivelyActive || this.analysisController.getPanelState().isAnalysisActive) {
          logger.info("[PlayFromFenController] State changed during Stockfish thinking for its move, aborting move application.");
          this.requestRedraw();
          return;
      }

      if (stockfishMoveUci) {
        logger.info(`[PlayFromFenController] Stockfish move: ${stockfishMoveUci}`);
        const moveResult: AttemptMoveResult = this.boardHandler.applySystemMove(stockfishMoveUci);
        
        if (moveResult.success) {
          this.state.currentFen = this.boardHandler.getFen();
          this._updatePgnDisplay();
          if (!this.checkAndSetGameOver()) {
            this.state.feedbackMessage = t('playFromFen.feedback.yourTurn');
            this.state.isUserTurn = true;
          }
        } else {
          logger.error("[PlayFromFenController] Stockfish made an illegal move or FEN update failed:", stockfishMoveUci);
          this.state.feedbackMessage = t('puzzle.feedback.stockfishError');
          this.state.isUserTurn = true;
        }
      } else {
        logger.warn("[PlayFromFenController] Stockfish did not return a move (e.g. mate/stalemate already).");
        if (!this.checkAndSetGameOver()) {
          this.state.feedbackMessage = t('puzzle.feedback.stockfishNoMove');
          this.state.isUserTurn = true;
        }
      }
    } catch (error) {
      this.state.isStockfishThinking = false;
      logger.error("[PlayFromFenController] Error during Stockfish move:", error);
      if (!this.checkAndSetGameOver()) {
        this.state.feedbackMessage = t('puzzle.feedback.stockfishGetMoveError');
        this.state.isUserTurn = true;
      }
    }
    this.requestRedraw();
  }

  public async handleRequestNewFenFromServer(): Promise<void> {
    if (this.boardHandler.promotionCtrl.isActive()) this.boardHandler.promotionCtrl.cancel();
    
    if (this.analysisController.getPanelState().isAnalysisActive) {
        this.analysisController.toggleAnalysisEngine();
    }

    this.setState({
        isLoadingFen: true,
        feedbackMessage: t('playFromFen.feedback.requestingNewFen'),
        gameOverMessage: null,
        isGameEffectivelyActive: false,
        currentFen: null,
        initialLoadedFen: null, // Сбрасываем initialLoadedFen при запросе нового
        currentPositionCp: undefined,
        currentPositionClass: undefined,
        currentPositionDifficultyClass: undefined,
        currentPositionPuzzleId: undefined,
    });

    try {
        const payload: PlayFromFenRequestPayload = {
            event: "playFromFen",
            lichess_id: this.authService.getUserProfile()?.id || "anonymous_pff_user",
            position_class: "P",
            material_difference: 1,
            num_pieces: 5,
            difficulty_class: 1,
        };
        const responseData = await this.webhookService.fetchFenForPlay(payload);

        if (responseData && responseData.FEN_0) {
            logger.info(`[PlayFromFenController] New FEN received from server: ${responseData.FEN_0}. Details:`, responseData);
            this.initializeGameWithFen(responseData.FEN_0, {
                cp: responseData.cp,
                position_class: responseData.position_class,
                difficulty_class: responseData.difficulty_class,
                PuzzleId: responseData.PuzzleId
            });
        } else {
            logger.error("[PlayFromFenController] Failed to fetch new FEN from server or FEN_0 missing.");
            this.setState({ feedbackMessage: t('playFromFen.error.failedToFetchFen')});
        }
    } catch (error) {
        logger.error("[PlayFromFenController] Error requesting new FEN from server:", error);
        this.setState({ feedbackMessage: t('playFromFen.error.requestFenError')});
    } finally {
        this.setState({ isLoadingFen: false });
        this._updateAnalysisControllerGameState();
    }
  }

  public handleRestartGame(): void {
    if (this.boardHandler.promotionCtrl.isActive()) this.boardHandler.promotionCtrl.cancel();
    
    const fenToRestart = this.state.initialLoadedFen; // Всегда используем initialLoadedFen для рестарта

    if (fenToRestart) {
      logger.info(`[PlayFromFenController] Restarting game with initial FEN: ${fenToRestart}`);
      // Детали позиции (cp, class, difficulty) уже должны быть в this.state и соответствовать initialLoadedFen
      const detailsForRestart = {
          cp: this.state.currentPositionCp,
          position_class: this.state.currentPositionClass,
          difficulty_class: this.state.currentPositionDifficultyClass,
          PuzzleId: this.state.currentPositionPuzzleId
      };
      this.initializeGameWithFen(fenToRestart, detailsForRestart);
    } else {
      logger.warn("[PlayFromFenController] Restart game called, but no initial FEN available to restart with. Requesting new FEN.");
      this.setState({ feedbackMessage: t('playFromFen.error.noFenToRestart') });
      this.handleRequestNewFenFromServer();
    }
  }
  
  private setState(newState: Partial<PlayFromFenControllerState>): void {
    let changed = false;
    for (const key in newState) {
        if (Object.prototype.hasOwnProperty.call(newState, key)) {
            const typedKey = key as keyof PlayFromFenControllerState;
            if (this.state[typedKey] !== newState[typedKey]) {
                changed = true;
                break;
            }
        }
    }
    // Обновляем состояние
    Object.assign(this.state, newState);

    if (changed) {
        this.requestRedraw();
    }
  }

  public destroy(): void {
    logger.info('[PlayFromFenController] Destroying PlayFromFenController instance.');
  }
}
