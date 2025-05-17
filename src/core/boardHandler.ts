// src/core/boardHandler.ts

import type {
  Key, 
  Dests,
  Color as ChessgroundColor,
} from 'chessground/types';
// import type { DrawShape } from 'chessground/draw'; // Not directly used, CustomDrawShape is used
import type { CustomDrawShape } from './chessboard.service'; 

import type {
  Role as ChessopsRole,
  Color as ChessopsColor,
  Outcome as ChessopsOutcome,
  Piece as ChessopsPiece,
  Move as ChessopsMove,
} from 'chessops/types';
import { isNormal } from 'chessops/types'; 
import type { Setup as ChessopsSetup } from 'chessops'; 

import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import { parseSquare, makeUci, parseUci } from 'chessops/util'; 
import { chessgroundDests } from 'chessops/compat';

import type { ChessboardService } from './chessboard.service';

import { PromotionCtrl } from '../features/common/promotion/promotionCtrl';
import type { PromotingState } from '../features/common/promotion/promotionCtrl';
import logger from '../utils/logger';
import { SoundService } from './sound.service';
import { PgnService, type PgnNode, type NewNodeData } from './pgn.service';

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
  sanMove?: string; 
  newFen?: string;
  outcome?: GameEndOutcome;
  promotionStarted?: boolean;
  promotionCompleted?: boolean;
  isIllegal?: boolean; 
}

export interface MoveMadeEventData {
  newNodePath: string;
  newFen: string;
  uciMove: string;
  sanMove: string;
  isVariation: boolean; 
}
export interface PgnNavigatedEventData {
  currentNodePath: string;
  currentFen: string;
  ply: number;
}

type MoveMadeSubscriber = (data: MoveMadeEventData) => void;
type PgnNavigatedSubscriber = (data: PgnNavigatedEventData) => void;

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
  private isConfiguredForAnalysis: boolean = false;

  private onMoveMadeSubscribers: MoveMadeSubscriber[] = [];
  private onPgnNavigatedSubscribers: PgnNavigatedSubscriber[] = [];

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

  public onMoveMade(subscriber: MoveMadeSubscriber): () => void {
    this.onMoveMadeSubscribers.push(subscriber);
    return () => {
      this.onMoveMadeSubscribers = this.onMoveMadeSubscribers.filter(s => s !== subscriber);
    };
  }

  public onPgnNavigated(subscriber: PgnNavigatedSubscriber): () => void {
    this.onPgnNavigatedSubscribers.push(subscriber);
    return () => {
      this.onPgnNavigatedSubscribers = this.onPgnNavigatedSubscribers.filter(s => s !== subscriber);
    };
  }

  private _emitMoveMade(data: MoveMadeEventData): void {
    logger.debug('[BoardHandler] Emitting onMoveMade event:', data);
    this.onMoveMadeSubscribers.forEach(subscriber => {
      try {
        subscriber(data);
      } catch (error) {
        logger.error('[BoardHandler] Error in onMoveMade subscriber:', error);
      }
    });
  }

  private _emitPgnNavigated(data: PgnNavigatedEventData): void {
    logger.debug('[BoardHandler] Emitting onPgnNavigated event:', data);
    this.onPgnNavigatedSubscribers.forEach(subscriber => {
      try {
        subscriber(data);
      } catch (error) {
        logger.error('[BoardHandler] Error in onPgnNavigated subscriber:', error);
      }
    });
  }

  private _syncInternalStateWithPgnService(): void {
    const pgnCurrentNode = this.pgnService.getCurrentNode();
    const fenToLoad = pgnCurrentNode.fenAfter;

    try {
      const setup: ChessopsSetup = parseFen(fenToLoad).unwrap(); 
      this.chessPosition = Chess.fromSetup(setup).unwrap();
      this._updateBoardStateInternal(); 
    } catch (e: any) {
      logger.error(`[BoardHandler] Error syncing internal state with PGN FEN ${fenToLoad}:`, e.message, e);
      const defaultSetup: ChessopsSetup = parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1').unwrap();
      this.chessPosition = Chess.fromSetup(defaultSetup).unwrap();
      this._updateBoardStateInternal();
    }
  }

  private _updateBoardStateInternal(): void {
    this.currentFen = makeFen(this.chessPosition.toSetup());
    this.boardTurnColor = this.chessPosition.turn;
    this.possibleMoves = chessgroundDests(this.chessPosition); 
  }

  private _updateChessgroundSettings(): void {
    if (!this.chessboardService.ground) {
      logger.warn('[BoardHandler _updateChessgroundSettings] Chessground not initialized. Skipping update.');
      return;
    }
    
    const gameStatus = this.getGameStatus(); 
    const currentBoardFenOnly = this.currentFen.split(' ')[0];
    
    let movableColor: ChessgroundColor | 'both' | undefined = this.boardTurnColor;
    let destsForGround: Dests = this.possibleMoves;

    if (gameStatus.isGameOver && !this.isConfiguredForAnalysis) {
        movableColor = undefined; 
        destsForGround = new Map();
    } else if (this.isConfiguredForAnalysis) {
        movableColor = this.boardTurnColor; 
        destsForGround = this.possibleMoves; 
    }

    const lastPgnMoveNode = this.pgnService.getCurrentNavigatedNode(); 
    const lastMoveUciArray: [Key, Key] | undefined = lastPgnMoveNode?.uci 
        ? [lastPgnMoveNode.uci.substring(0, 2) as Key, lastPgnMoveNode.uci.substring(2, 4) as Key]
        : undefined;

    const newConfig: Partial<import('chessground/config').Config> = {
        fen: currentBoardFenOnly,
        turnColor: this.boardTurnColor, 
        movable: {
            free: false, 
            color: movableColor,
            dests: destsForGround,
            showDests: true,
        },
        check: gameStatus.isCheck ? true : undefined, 
        lastMove: lastMoveUciArray,
    };
    
    this.chessboardService.ground.set(newConfig);
  }

  public configureBoardForAnalysis(isAnalysis: boolean): void {
    this.isConfiguredForAnalysis = isAnalysis;
    logger.info(`[BoardHandler] Board configured for analysis: ${isAnalysis}`);
    this._updateChessgroundSettings(); 
    this.requestRedraw(); 
  }

  public isBoardConfiguredForAnalysis(): boolean {
    return this.isConfiguredForAnalysis;
  }

  public setupPosition(
    fen: string,
    humanPlayerColor?: ChessgroundColor,
    resetPgnHistory: boolean = true,
  ): boolean {
    if (this.isConfiguredForAnalysis && resetPgnHistory) {
        this.configureBoardForAnalysis(false); 
    }

    try {
      if (resetPgnHistory) {
        this.pgnService.reset(fen);
      }
      this._syncInternalStateWithPgnService(); 

      if (humanPlayerColor) {
        this.humanPlayerColorInternal = humanPlayerColor;
      }
      
      this._updateChessgroundSettings(); 
      logger.info(`[BoardHandler] Position setup with FEN: ${fen}. PGN reset: ${resetPgnHistory}`);
      
      this._emitPgnNavigated({
        currentNodePath: this.pgnService.getCurrentPath(),
        currentFen: this.currentFen,
        ply: this.pgnService.getCurrentPly()
      });
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
      this._emitPgnNavigated({ 
        currentNodePath: this.pgnService.getCurrentPath(),
        currentFen: this.currentFen,
        ply: this.pgnService.getCurrentPly()
      });
      this.requestRedraw();
      return false;
    }
  }

  public setOrientation(color: ChessgroundColor): void {
    this.humanPlayerColorInternal = color;
    this.chessboardService.setOrientation(color); 
    logger.debug(`[BoardHandler] Orientation set to: ${color} by external call.`);
  }

  public async attemptUserMove(
    orig: Key,
    dest: Key,
  ): Promise<AttemptMoveResult> {
    const gameStatusBeforeMove = this.getGameStatus(); 
    if (gameStatusBeforeMove.isGameOver && !this.isConfiguredForAnalysis) {
      logger.warn('[BoardHandler] Attempted move in a game over state (not configured for analysis).');
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
            resolve({ ...result, promotionStarted: true, promotionCompleted: result.success });
          },
        );
      });
    }

    const uciMove = makeUci({ from: fromSq, to: toSq });
    const result = this._applyAndProcessUciMove(uciMove);
    return Promise.resolve({ ...result });
  }

  public applySystemMove(uciMove: string): AttemptMoveResult {
    const gameStatus = this.getGameStatus();
    if (gameStatus.isGameOver && !this.isConfiguredForAnalysis) {
      logger.warn('[BoardHandler] Attempted system move in a game over state (not configured for analysis).');
      return { success: false, isIllegal: true };
    }
    logger.info(`[BoardHandler] Applying system move: ${uciMove}`);
    return this._applyAndProcessUciMove(uciMove);
  }

  private _applyAndProcessUciMove(
    uciMove: string,
  ): Omit<AttemptMoveResult, 'promotionStarted' | 'promotionCompleted'> {
    
    const chessopsMoveToAttempt: ChessopsMove | undefined = parseUci(uciMove);
    if (!chessopsMoveToAttempt) {
      logger.warn(`[BoardHandler] Invalid UCI move format: ${uciMove}`);
      this._updateChessgroundSettings(); 
      return { success: false, isIllegal: true, uciMove };
    }

    const positionToTestLegality = this.chessPosition.clone(); 
    const fenBeforeAttempt = makeFen(positionToTestLegality.toSetup()); 

    if (!positionToTestLegality.isLegal(chessopsMoveToAttempt)) {
      const pieceTryingToMove = isNormal(chessopsMoveToAttempt) ? positionToTestLegality.board.get(chessopsMoveToAttempt.from) : null;
      logger.warn(`[BoardHandler] Illegal move by chessops: ${uciMove} on FEN ${fenBeforeAttempt}. Turn: ${positionToTestLegality.turn}. Piece: ${pieceTryingToMove?.color}${pieceTryingToMove?.role}.`);
      this._updateChessgroundSettings(); 
      return { success: false, uciMove, isIllegal: true };
    }

    let san: string;
    try {
      san = makeSan(positionToTestLegality, chessopsMoveToAttempt); 
    } catch (e: any) {
      logger.warn(`[BoardHandler] SAN generation failed for legal move ${uciMove} on FEN ${fenBeforeAttempt}. Error: ${e.message}. Using UCI as SAN.`);
      san = uciMove; 
    }

    const tempPosForFenAfter = positionToTestLegality.clone(); 
    tempPosForFenAfter.play(chessopsMoveToAttempt);
    const fenAfterAttempt = makeFen(tempPosForFenAfter.toSetup());

    const newNodeData: NewNodeData = {
        san,
        uci: uciMove,
        fenBefore: fenBeforeAttempt, 
        fenAfter: fenAfterAttempt,
    };

    const addedPgnNode = this.pgnService.addNode(newNodeData);

    if (!addedPgnNode) {
        logger.error(`[BoardHandler] Failed to add node to PgnService for move ${uciMove}.`);
        this._updateChessgroundSettings(); 
        return { success: false, uciMove, sanMove: san, isIllegal: true }; 
    }
    
    const isVariation = addedPgnNode.parent ? addedPgnNode.parent.children.length > 1 && addedPgnNode.parent.children[0].id !== addedPgnNode.id : false;

    this._syncInternalStateWithPgnService(); 

    const pieceOnDestBefore: ChessopsPiece | undefined = positionToTestLegality.board.get(chessopsMoveToAttempt.to); 

    if (isNormal(chessopsMoveToAttempt) && chessopsMoveToAttempt.promotion) SoundService.playSound('promote');
    else if (pieceOnDestBefore && isNormal(chessopsMoveToAttempt)) SoundService.playSound('capture');
    else SoundService.playSound('move');
    
    const gameStatusAfterMove = this.getGameStatus(); 
    if (gameStatusAfterMove.isCheck) SoundService.playSound('check');
    if (gameStatusAfterMove.isGameOver && gameStatusAfterMove.outcome?.reason === 'stalemate' && !this.isConfiguredForAnalysis) SoundService.playSound('stalemate');

    if (gameStatusAfterMove.isGameOver && gameStatusAfterMove.outcome && !this.isConfiguredForAnalysis) {
        if (gameStatusAfterMove.outcome.winner === 'white') this.pgnService.setGameResult("1-0");
        else if (gameStatusAfterMove.outcome.winner === 'black') this.pgnService.setGameResult("0-1");
        else this.pgnService.setGameResult("1/2-1/2");
    }
    
    this._updateChessgroundSettings(); 
    
    this._emitMoveMade({
      newNodePath: this.pgnService.getCurrentPath(),
      newFen: this.currentFen,
      uciMove: uciMove,
      sanMove: san,
      isVariation: isVariation
    });
    this.requestRedraw(); 
    
    logger.debug(`[BoardHandler] Move ${uciMove} (SAN: ${san}) applied. New FEN: ${this.currentFen}. PGN Path: ${this.pgnService.getCurrentPath()}`);
    return { success: true, newFen: this.currentFen, outcome: gameStatusAfterMove.outcome, uciMove, sanMove: san, isIllegal: false };
  }

  public getFen(): string {
    return this.currentFen;
  }

  public getPgn(options?: import('./pgn.service').PgnStringOptions): string {
    const showResult = this.getGameStatus().isGameOver && !this.isConfiguredForAnalysis;
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
            gameEndReason = this.chessPosition.isCheckmate() ? 'checkmate' : 'variant_win'; 
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
            logger.info(`[BoardHandler] Threefold repetition detected (count: ${repetitionCount}). Game is a draw.`);
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

    const currentBoardShapes: CustomDrawShape[] = (this.chessboardService.ground.state.drawable.shapes || [])
                                                    .filter(s => s.brush !== undefined) as CustomDrawShape[];
    
    const existingShapeIndex = currentBoardShapes.findIndex(s => s.orig === orig && s.dest === dest && s.brush === brush);

    if (existingShapeIndex !== -1) { // Если такая фигура уже есть, не добавляем дубликат
        return;
    }
    
    const finalShapesList: CustomDrawShape[] = [...currentBoardShapes, newShapeToAdd];
    this.chessboardService.drawShapes(finalShapesList);
  }

  public drawCircle(key: Key, brush: string = 'green'): void {
    if (!this.chessboardService.ground) return;
    const newShapeToAdd: CustomDrawShape = { orig: key, brush };
    const currentBoardShapes: CustomDrawShape[] = (this.chessboardService.ground.state.drawable.shapes || [])
                                                    .filter(s => s.brush !== undefined) as CustomDrawShape[];

    const existingShapeIndex = currentBoardShapes.findIndex(s => s.orig === key && s.dest === undefined && s.brush === brush);
    
    if (existingShapeIndex !== -1) { // Если такая фигура уже есть, не добавляем дубликат
        return;
    }
        
    const finalShapesList: CustomDrawShape[] = [...currentBoardShapes, newShapeToAdd];
    this.chessboardService.drawShapes(finalShapesList);
  }

  public clearAllDrawings(): void { 
    this.chessboardService.clearShapes(); 
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
    const undonePgnNode = this.pgnService.undoLastMove();
    if (undonePgnNode) {
      this._syncInternalStateWithPgnService(); 
      this.pgnService.setGameResult('*'); 
      this._updateChessgroundSettings();
      logger.info(`[BoardHandler] Undid move. Current FEN on board: ${this.currentFen}. PGN Path: ${this.pgnService.getCurrentPath()}`);
      this._emitPgnNavigated({
        currentNodePath: this.pgnService.getCurrentPath(),
        currentFen: this.currentFen,
        ply: this.pgnService.getCurrentPly()
      });
      this.requestRedraw();
      return true;
    }
    logger.warn('[BoardHandler] No moves in PGN history to undo.');
    return false;
  }

  public getLastPgnMoveNode(): PgnNode | null { 
    return this.pgnService.getCurrentNavigatedNode(); 
  }

  // Новый метод для навигации по пути
  public handleNavigatePgnToPath(path: string): boolean {
    const success = this.pgnService.navigateToPath(path);
    if (success) {
      this._syncInternalStateWithPgnService();
      this._updateChessgroundSettings();
      this._emitPgnNavigated({
        currentNodePath: this.pgnService.getCurrentPath(),
        currentFen: this.currentFen,
        ply: this.pgnService.getCurrentPly()
      });
      this.requestRedraw();
    } else {
        logger.warn(`[BoardHandler] Failed to navigate to PGN path: ${path}`);
    }
    return success;
  }

  public handleNavigatePgnToPly(ply: number): boolean {
    const success = this.pgnService.navigateToPly(ply);
    if (success) {
      this._syncInternalStateWithPgnService(); 
      this._updateChessgroundSettings(); 
      this._emitPgnNavigated({
        currentNodePath: this.pgnService.getCurrentPath(),
        currentFen: this.currentFen,
        ply: this.pgnService.getCurrentPly()
      });
      this.requestRedraw();
    }
    return success;
  }

  public handleNavigatePgnBackward(): boolean {
    const success = this.pgnService.navigateBackward();
    if (success) {
      this._syncInternalStateWithPgnService();
      this._updateChessgroundSettings();
      this._emitPgnNavigated({
        currentNodePath: this.pgnService.getCurrentPath(),
        currentFen: this.currentFen,
        ply: this.pgnService.getCurrentPly()
      });
      this.requestRedraw();
    }
    return success;
  }

  public handleNavigatePgnForward(variationIndex: number = 0): boolean {
    const success = this.pgnService.navigateForward(variationIndex);
    if (success) {
      this._syncInternalStateWithPgnService();
      this._updateChessgroundSettings();
      this._emitPgnNavigated({
        currentNodePath: this.pgnService.getCurrentPath(),
        currentFen: this.currentFen,
        ply: this.pgnService.getCurrentPly()
      });
      this.requestRedraw();
    }
    return success;
  }

  public handleNavigatePgnToStart(): boolean {
    this.pgnService.navigateToStart(); 
    this._syncInternalStateWithPgnService();
    this._updateChessgroundSettings();
    this._emitPgnNavigated({
      currentNodePath: this.pgnService.getCurrentPath(),
      currentFen: this.currentFen,
      ply: this.pgnService.getCurrentPly()
    });
    this.requestRedraw();
    return true; 
  }

  public handleNavigatePgnToEnd(): boolean {
    this.pgnService.navigateToEnd(); 
    this._syncInternalStateWithPgnService();
    this._updateChessgroundSettings();
    this._emitPgnNavigated({
      currentNodePath: this.pgnService.getCurrentPath(),
      currentFen: this.currentFen,
      ply: this.pgnService.getCurrentPly()
    });
    this.requestRedraw();
    return true; 
  }

  public canPgnNavigateBackward(): boolean {
    return this.pgnService.canNavigateBackward();
  }

  public canPgnNavigateForward(variationIndex: number = 0): boolean {
    return this.pgnService.canNavigateForward(variationIndex);
  }

  public getCurrentPgnPath(): string {
    return this.pgnService.getCurrentPath();
  }

  public getCurrentPgnNodeVariations(): PgnNode[] {
    return this.pgnService.getVariationsForCurrentNode();
  }

  public promotePgnVariation(variationNodeId: string): boolean {
    const success = this.pgnService.promoteVariationToMainline(variationNodeId);
    if (success) {
        this._syncInternalStateWithPgnService(); 
        this._updateChessgroundSettings();
        this._emitPgnNavigated({
            currentNodePath: this.pgnService.getCurrentPath(), 
            currentFen: this.currentFen,
            ply: this.pgnService.getCurrentPly()
        });
        this.requestRedraw();
    }
    return success;
  }
}
