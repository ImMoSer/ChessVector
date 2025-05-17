// src/core/boardHandler.ts

import type {
  Key, 
  Dests,
  Color as ChessgroundColor,
} from 'chessground/types';
import type { DrawShape } from 'chessground/draw';
import type { CustomDrawShape } from './chessboard.service'; 

import type {
  Role as ChessopsRole,
  Color as ChessopsColor,
  Outcome as ChessopsOutcome,
  Piece as ChessopsPiece,
  Square as ChessopsSquare, 
  Move as ChessopsMove,
} from 'chessops/types';
import type { Setup as ChessopsSetup } from 'chessops'; 
import { isNormal } from 'chessops/types'; 

import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import { parseSquare, makeUci, parseUci, makeSquare as chessopsMakeSquare } from 'chessops/util'; 
import { chessgroundDests } from 'chessops/compat';

import type { ChessboardService } from './chessboard.service';

import { PromotionCtrl } from '../features/common/promotion/promotionCtrl';
import type { PromotingState } from '../features/common/promotion/promotionCtrl';
import logger from '../utils/logger';
import { SoundService } from './sound.service';
import { PgnService, type PgnNode } from './pgn.service';

export type GameEndReason =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient_material'
  | 'draw'
  | 'variant_win'
  | 'variant_loss'
  | 'variant_draw';

export interface GameEndOutcome {
  winner?: ChessopsColor;
  reason?: GameEndReason;
}

export interface GameStatus {
  isGameOver: boolean;
  outcome?: GameEndOutcome;
  isCheck: boolean;
  turn: ChessgroundColor;
}

export interface AttemptMoveResult {
  success: boolean;
  uciMove?: string;
  newFen?: string;
  outcome?: GameEndOutcome;
  promotionStarted?: boolean;
  promotionCompleted?: boolean;
  isIllegal?: boolean; 
}

export class BoardHandler {
  private chessboardService: ChessboardService;
  public promotionCtrl: PromotionCtrl;
  private requestRedraw: () => void;
  public pgnService: typeof PgnService;


  private chessPosition!: Chess;
  public currentFen!: string;
  public boardTurnColor!: ChessgroundColor;
  public possibleMoves!: Dests;

  private humanPlayerColorInternal: ChessgroundColor = 'white';
  private isAnalysisActiveInternal: boolean = false;

  constructor(
    chessboardService: ChessboardService,
    requestRedraw: () => void,
  ) {
    this.chessboardService = chessboardService;
    this.requestRedraw = requestRedraw;
    this.promotionCtrl = new PromotionCtrl(this.requestRedraw);
    this.pgnService = PgnService; 

    this._syncInternalStateWithPgnService();
    logger.info(`[BoardHandler] Initialized. Current FEN from PgnService: ${this.currentFen}`);
  }

  private _syncInternalStateWithPgnService(): void {
    const navigatedFen = this.pgnService.getCurrentNavigatedFen();
    try {
      const setup: ChessopsSetup = parseFen(navigatedFen).unwrap();
      this.chessPosition = Chess.fromSetup(setup).unwrap();
      this._updateBoardStateInternal(); 
    } catch (e: any) {
      logger.error(`[BoardHandler] Error syncing internal state with PGN FEN ${navigatedFen}:`, e.message, e);
      const defaultSetup: ChessopsSetup = parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1').unwrap();
      this.chessPosition = Chess.fromSetup(defaultSetup).unwrap();
      this._updateBoardStateInternal();
    }
  }

  private _updateBoardStateInternal(): void {
    this.currentFen = makeFen(this.chessPosition.toSetup());
    this.boardTurnColor = this.chessPosition.turn;
    this.possibleMoves = chessgroundDests(this.chessPosition);
    logger.debug(`[BoardHandler _updateBoardStateInternal] FEN: ${this.currentFen}, Turn: ${this.boardTurnColor}, PossibleMoves count: ${this.possibleMoves.size}`);
  }

  private _updateChessgroundSettings(): void {
    if (!this.chessboardService.ground) {
      logger.warn('[BoardHandler _updateChessgroundSettings] Chessground not initialized. Skipping update.');
      return;
    }
    
    const gameStatus = this.getGameStatus(); 

    // ИСПРАВЛЕНИЕ: Свойство 'check' в Config ожидает boolean или Color, а не Key.
    // Если gameStatus.isCheck === true, передаем true, чтобы chessground
    // подсветил короля текущего turnColor (который мы также устанавливаем).
    const checkHighlight: boolean | ChessgroundColor | undefined = gameStatus.isCheck ? true : undefined;

    const newConfig: Partial<import('chessground/config').Config> = {
        fen: this.currentFen.split(' ')[0],
        turnColor: this.boardTurnColor, 
        movable: {
            free: false, 
            color: gameStatus.isGameOver && !this.isAnalysisActiveInternal ? undefined : this.boardTurnColor,
            dests: this.possibleMoves,
            showDests: true,
        },
        check: checkHighlight, 
    };
    
    if (this.isAnalysisActiveInternal) {
        logger.debug(`[BoardHandler _updateChessgroundSettings] Analysis ON. Turn: ${this.boardTurnColor}. Dests based on this turn.`);
    } else {
        logger.debug(`[BoardHandler _updateChessgroundSettings] Analysis OFF. Turn: ${this.boardTurnColor}. Dests based on this turn.`);
    }

    this.chessboardService.ground.set(newConfig);
    logger.debug(`[BoardHandler _updateChessgroundSettings] Chessground updated. FEN: ${newConfig.fen}, Turn: ${newConfig.turnColor}, MovableColor: ${newConfig.movable?.color}, Dests count: ${newConfig.movable?.dests?.size}, Check: ${newConfig.check}`);
  }


  public setAnalysisMode(isActive: boolean): void {
    this.isAnalysisActiveInternal = isActive;
    logger.info(`[BoardHandler] setAnalysisMode called with: ${isActive}`);
    
    this._syncInternalStateWithPgnService(); 
    this._updateChessgroundSettings();
    
    this.requestRedraw(); 
  }

  public isAnalysisMode(): boolean {
    return this.isAnalysisActiveInternal;
  }

  public setupPosition(
    fen: string,
    humanPlayerColor?: ChessgroundColor,
    resetPgnHistory: boolean = true,
  ): boolean {
    if (this.isAnalysisActiveInternal && resetPgnHistory) {
        this.setAnalysisMode(false); 
    }

    try {
      if (resetPgnHistory) {
        this.pgnService.reset(fen);
      }
      this._syncInternalStateWithPgnService(); 

      if (humanPlayerColor) {
        this.humanPlayerColorInternal = humanPlayerColor;
        this.setOrientation(humanPlayerColor); 
      }
      
      this._updateChessgroundSettings(); 
      logger.info(`[BoardHandler] Position setup with FEN: ${fen}. PGN reset: ${resetPgnHistory}`);
      this.requestRedraw(); 
      return true;
    } catch (e: any) {
      logger.error('[BoardHandler] Failed to setup position from FEN:', fen, e.message);
      const defaultFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      if (resetPgnHistory) {
        this.pgnService.reset(defaultFen);
      }
      this._syncInternalStateWithPgnService();
      this._updateChessgroundSettings();
      this.requestRedraw();
      return false;
    }
  }

  public setOrientation(color: ChessgroundColor): void {
    this.humanPlayerColorInternal = color;
    this.chessboardService.setOrientation(color); 
    logger.debug(`[BoardHandler] Orientation set to: ${color}`);
  }

  public async attemptUserMove(
    orig: Key,
    dest: Key,
  ): Promise<AttemptMoveResult> {
    const gameStatusBeforeMove = this.getGameStatus(); 
    if (gameStatusBeforeMove.isGameOver && !this.isAnalysisActiveInternal) {
      logger.warn('[BoardHandler] Attempted move in a game over state (not in analysis mode).');
      this.chessboardService.setFen(this.currentFen.split(' ')[0]); 
      this._updateChessgroundSettings(); 
      return { success: false, isIllegal: true };
    }

    const fromSq = parseSquare(orig);
    const toSq = parseSquare(dest);

    if (fromSq === undefined || toSq === undefined) {
      logger.warn(`[BoardHandler] Invalid square in user move: ${orig} or ${dest}`);
      return { success: false, isIllegal: true };
    }

    const promotionCheck = this._isPromotionAttempt(orig, dest); 
    if (promotionCheck.isPromotion && promotionCheck.pieceColor) {
      return new Promise<AttemptMoveResult>((resolve) => {
        this.promotionCtrl.start(
          orig,
          dest,
          promotionCheck.pieceColor as ChessgroundColor, 
          (selectedRole: ChessopsRole | null) => {
            if (!selectedRole) {
              logger.info('[BoardHandler] Promotion cancelled by user.');
              this._updateChessgroundSettings(); 
              this.requestRedraw();
              resolve({ success: false, promotionStarted: true, promotionCompleted: false, isIllegal: true });
              return;
            }
            const uciMoveWithPromotion = makeUci({ from: fromSq, to: toSq, promotion: selectedRole });
            const result = this._applyAndProcessUciMove(uciMoveWithPromotion);
            resolve({ ...result, promotionStarted: true, promotionCompleted: result.success, uciMove: uciMoveWithPromotion });
          },
        );
      });
    }

    const uciMove = makeUci({ from: fromSq, to: toSq });
    const result = this._applyAndProcessUciMove(uciMove);
    return Promise.resolve({ ...result, uciMove });
  }

  public applySystemMove(uciMove: string): AttemptMoveResult {
    const gameStatus = this.getGameStatus();
    if (gameStatus.isGameOver && !this.isAnalysisActiveInternal) {
      logger.warn('[BoardHandler] Attempted system move in a game over state (not in analysis mode).');
      return { success: false, isIllegal: true };
    }
    logger.info(`[BoardHandler] Applying system move: ${uciMove}`);
    return this._applyAndProcessUciMove(uciMove);
  }

  private _applyAndProcessUciMove(
    uciMove: string,
  ): Omit<AttemptMoveResult, 'promotionStarted' | 'promotionCompleted'> {
    
    const move: ChessopsMove | undefined = parseUci(uciMove);
    if (!move) {
      logger.warn(`[BoardHandler] Invalid UCI move format: ${uciMove}`);
      this._updateChessgroundSettings(); 
      return { success: false, isIllegal: true };
    }

    const positionToTest = this.chessPosition.clone(); 
    const fenBeforeAttempt = makeFen(positionToTest.toSetup());

    if (!positionToTest.isLegal(move)) {
      const pieceTryingToMove = isNormal(move) ? positionToTest.board.get(move.from) : null;
      logger.warn(`[BoardHandler] Illegal move by chessops: ${uciMove} on FEN ${fenBeforeAttempt}. Turn in FEN: ${positionToTest.turn}. Piece: ${pieceTryingToMove?.color}${pieceTryingToMove?.role}.`);
      this._updateChessgroundSettings(); 
      return { success: false, uciMove, isIllegal: true };
    }

    let san: string;
    try {
      san = makeSan(positionToTest, move); 
    } catch (e: any) {
      logger.warn(`[BoardHandler] SAN generation failed for legal move ${uciMove} (UCI) on FEN ${fenBeforeAttempt}. Error: ${e.message}.`);
      san = uciMove; 
    }

    const destSquare: ChessopsSquare = move.to;
    const pieceOnDestBefore: ChessopsPiece | undefined = positionToTest.board.get(destSquare); 

    positionToTest.play(move); 

    this.chessPosition = positionToTest;
    this._updateBoardStateInternal(); 

    const isAtEndOfPgnMainline = this.pgnService.getCurrentPlyNavigated() === this.pgnService.getTotalPliesInMainline();
    if (!this.isAnalysisActiveInternal || (this.isAnalysisActiveInternal && isAtEndOfPgnMainline)) {
        this.pgnService.addMove(fenBeforeAttempt, san, uciMove, this.currentFen);
    } else if (this.isAnalysisActiveInternal && !isAtEndOfPgnMainline) {
        logger.info(`[BoardHandler] Analysis mode: Move ${uciMove} (SAN: ${san}) made on board. Not added to PGN mainline as PGN navigator is at ply ${this.pgnService.getCurrentPlyNavigated()} of ${this.pgnService.getTotalPliesInMainline()}.`);
    }

    const gameStatusAfterMove = this.getGameStatus();

    if (isNormal(move) && move.promotion) SoundService.playSound('promote');
    else if (pieceOnDestBefore && isNormal(move)) SoundService.playSound('capture');
    else SoundService.playSound('move');
    if (gameStatusAfterMove.isCheck) SoundService.playSound('check');
    if (gameStatusAfterMove.isGameOver && gameStatusAfterMove.outcome?.reason === 'stalemate' && !this.isAnalysisActiveInternal) SoundService.playSound('stalemate');

    if (gameStatusAfterMove.isGameOver && gameStatusAfterMove.outcome && !this.isAnalysisActiveInternal) {
        if (gameStatusAfterMove.outcome.winner === 'white') this.pgnService.setGameResult("1-0");
        else if (gameStatusAfterMove.outcome.winner === 'black') this.pgnService.setGameResult("0-1");
        else this.pgnService.setGameResult("1/2-1/2");
    }
    
    this._updateChessgroundSettings(); 
    
    this.requestRedraw(); 
    logger.debug(`[BoardHandler] Move ${uciMove} (SAN: ${san}) applied. New FEN: ${this.currentFen}. Outcome: ${JSON.stringify(gameStatusAfterMove.outcome)}`);
    return { success: true, newFen: this.currentFen, outcome: gameStatusAfterMove.outcome, uciMove, isIllegal: false };
  }


  public getFen(): string {
    return this.currentFen;
  }

  public getPgn(options?: import('./pgn.service').PgnStringOptions): string {
    const showResult = this.getGameStatus().isGameOver && !this.isAnalysisActiveInternal;
    return this.pgnService.getCurrentPgnString({...options, showResult });
  }

  public getPossibleMoves(): Dests {
    return this.possibleMoves;
  }

  public getBoardTurnColor(): ChessgroundColor {
    return this.boardTurnColor;
  }

  public getHumanPlayerColor(): ChessgroundColor | undefined {
    return this.humanPlayerColorInternal;
  }

  public getGameStatus(): GameStatus { 
    const outcomeDetails: ChessopsOutcome | undefined = this.chessPosition.outcome();
    let isGameOver = !!outcomeDetails; 
    let gameEndOutcome: GameEndOutcome | undefined;
    let gameEndReason: GameEndReason | undefined;

    if (outcomeDetails) {
        if (outcomeDetails.winner) {
            gameEndReason = 'checkmate';
        } else {
            if (this.chessPosition.isStalemate()) gameEndReason = 'stalemate';
            else if (this.chessPosition.isInsufficientMaterial()) gameEndReason = 'insufficient_material';
            else gameEndReason = 'draw'; 
        }
        gameEndOutcome = {
            winner: outcomeDetails.winner,
            reason: gameEndReason,
        };
    }

    if (!isGameOver) {
        const fenHistory = this.pgnService.getFenHistoryForRepetition();
        const currentBoardFenOnly = this.currentFen.split(' ')[0]; 
        
        let repetitionCount = 0;
        for (const fenPart of fenHistory) { 
            if (fenPart === currentBoardFenOnly) {
                repetitionCount++;
            }
        }
        if (repetitionCount >= 3) {
            isGameOver = true;
            gameEndReason = 'draw'; 
            gameEndOutcome = { winner: undefined, reason: gameEndReason };
            logger.info(`[BoardHandler] Threefold repetition detected (count based on PGN history + current board: ${repetitionCount}). Game is a draw.`);
        }
    }

    if (!isGameOver) {
        if (this.chessPosition.halfmoves >= 100) { 
            isGameOver = true;
            gameEndReason = 'draw'; 
            gameEndOutcome = { winner: undefined, reason: gameEndReason };
            logger.info(`[BoardHandler] 50-move rule detected (halfmoves: ${this.chessPosition.halfmoves}). Game is a draw.`);
        }
    }

    const isCheck = this.chessPosition.isCheck();
    return { isGameOver, outcome: gameEndOutcome, isCheck, turn: this.chessPosition.turn };
  }

  public isMoveLegal(uciMove: string): boolean { 
    const move = parseUci(uciMove);
    if (!move) return false;
    return this.chessPosition.isLegal(move);
  }

  public getPromotionState(): PromotingState | null { return this.promotionCtrl?.promoting || null; }
  
  public drawArrow(orig: Key, dest: Key, brush: string = 'green'): void {
    if (!this.chessboardService.ground) return;
    const newShapeToAdd: CustomDrawShape = { orig, dest, brush };

    const currentBoardShapes: DrawShape[] = this.chessboardService.ground.state.drawable.shapes || [];

    const shapesToKeepAndSet: CustomDrawShape[] = [];
    for (const s of currentBoardShapes) {
        if (s.orig === orig && s.dest === dest) {
            continue;
        }
        if (s.brush !== undefined) {
            shapesToKeepAndSet.push(s as CustomDrawShape); 
        }
    }

    const finalShapesList: CustomDrawShape[] = [...shapesToKeepAndSet, newShapeToAdd];
    this.chessboardService.drawShapes(finalShapesList);
    logger.debug(`[BoardHandler] Drawing arrow from ${orig} to ${dest} with brush ${brush}`);
  }

  public drawCircle(key: Key, brush: string = 'green'): void {
    if (!this.chessboardService.ground) return;
    const newShapeToAdd: CustomDrawShape = { orig: key, brush };

    const currentBoardShapes: DrawShape[] = this.chessboardService.ground.state.drawable.shapes || [];

    const shapesToKeepAndSet: CustomDrawShape[] = [];
    for (const s of currentBoardShapes) {
        if (s.orig === key && s.dest === undefined) { 
            continue;
        }
        if (s.brush !== undefined) {
            shapesToKeepAndSet.push(s as CustomDrawShape);
        }
    }
    
    const finalShapesList: CustomDrawShape[] = [...shapesToKeepAndSet, newShapeToAdd];
    this.chessboardService.drawShapes(finalShapesList);
    logger.debug(`[BoardHandler] Drawing circle on ${key} with brush ${brush}`);
  }

  public clearAllDrawings(): void { 
    this.chessboardService.clearShapes(); 
    logger.debug(`[BoardHandler] All drawings cleared.`);
  }

  private _isPromotionAttempt(orig: Key, dest: Key): { isPromotion: boolean; pieceColor?: ChessopsColor } {
    const fromSq = parseSquare(orig);
    if (fromSq === undefined || !this.chessPosition) return { isPromotion: false };

    const piece = this.chessPosition.board.get(fromSq);
    if (!piece || piece.role !== 'pawn') {
      return { isPromotion: false };
    }

    const toRankChar = dest.charAt(1); 
    const isPromotionRank = (piece.color === 'white' && toRankChar === '8') || (piece.color === 'black' && toRankChar === '1');

    if (isPromotionRank) {
      return { isPromotion: true, pieceColor: piece.color };
    }
    return { isPromotion: false };
  }


  public undoLastMove(): boolean {
    if (this.isAnalysisActiveInternal) {
        logger.info("[BoardHandler] Undo called while analysis mode is active. This will undo the last move in PGN, board will sync.");
    }
    const undonePgnNode = this.pgnService.undoLastMainlineMove();
    if (undonePgnNode) {
      this._syncInternalStateWithPgnService(); 
      this.pgnService.setGameResult('*'); 
      this._updateChessgroundSettings();
      logger.info(`[BoardHandler] Undid move ${undonePgnNode.san}. Current FEN on board: ${this.currentFen}`);
      this.requestRedraw();
      return true;
    }
    logger.warn('[BoardHandler] No moves in PGN history to undo.');
    return false;
  }

  public getLastPgnMoveNode(): PgnNode | null { return this.pgnService.getLastMove(); }

  public handleNavigatePgnToPly(ply: number): boolean {
    const success = this.pgnService.navigateToPly(ply);
    if (success) {
      this._syncInternalStateWithPgnService(); 
      this._updateChessgroundSettings(); 
      this.requestRedraw();
    }
    return success;
  }

  public handleNavigatePgnBackward(): boolean {
    const success = this.pgnService.navigateBackward();
    if (success) {
      this._syncInternalStateWithPgnService();
      this._updateChessgroundSettings();
      this.requestRedraw();
    }
    return success;
  }

  public handleNavigatePgnForward(): boolean {
    const success = this.pgnService.navigateForward();
    if (success) {
      this._syncInternalStateWithPgnService();
      this._updateChessgroundSettings();
      this.requestRedraw();
    }
    return success;
  }

  public handleNavigatePgnToStart(): boolean {
    this.pgnService.navigateToStart(); 
    this._syncInternalStateWithPgnService();
    this._updateChessgroundSettings();
    this.requestRedraw();
    return true; 
  }

  public handleNavigatePgnToEnd(): boolean {
    this.pgnService.navigateToEnd(); 
    this._syncInternalStateWithPgnService();
    this._updateChessgroundSettings();
    this.requestRedraw();
    return true; 
  }

  public canPgnNavigateBackward(): boolean {
    return this.pgnService.canNavigateBackward();
  }

  public canPgnNavigateForward(): boolean {
    return this.pgnService.canNavigateForward();
  }
}
