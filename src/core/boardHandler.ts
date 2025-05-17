// src/core/boardHandler.ts

import type {
  Key, 
  Dests,
  Color as ChessgroundColor,
  // Pieces, // Not directly used
  // Piece as ChessgroundPiece, // Not directly used
} from 'chessground/types';
import type { DrawShape } from 'chessground/draw'; // Keep for CustomDrawShape compatibility
import type { CustomDrawShape } from './chessboard.service'; 

import type {
  Role as ChessopsRole,
  Color as ChessopsColor,
  Outcome as ChessopsOutcome,
  Piece as ChessopsPiece,
  // Square as ChessopsSquare, // Removed as unused
  Move as ChessopsMove,
  // NormalMove as ChessopsNormalMove, // Not directly used
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
import { PgnService, type PgnNode, type NewNodeData } from './pgn.service'; // Import NewNodeData

export type GameEndReason =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient_material'
  | 'draw' // Generic draw (e.g., threefold, 50-move)
  | 'variant_win' // For future variants
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
  turn: ChessgroundColor; // Color whose turn it is
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
  public pgnService: typeof PgnService; // Use the singleton instance

  // Internal state derived from PgnService's currentNode
  private chessPosition!: Chess; // Current chessops game state
  public currentFen!: string;    // Full FEN of the current position
  public boardTurnColor!: ChessgroundColor; // Whose turn it is ('white' | 'black')
  public possibleMoves!: Dests;  // Possible moves for chessground

  private humanPlayerColorInternal: ChessgroundColor = 'white'; // Default
  private isAnalysisActiveInternal: boolean = false;

  constructor(
    chessboardService: ChessboardService,
    requestRedraw: () => void,
  ) {
    this.chessboardService = chessboardService;
    this.requestRedraw = requestRedraw;
    this.promotionCtrl = new PromotionCtrl(this.requestRedraw);
    this.pgnService = PgnService; // Assign the singleton

    this._syncInternalStateWithPgnService(); // Initial sync
    logger.info(`[BoardHandler] Initialized. Current FEN from PgnService: ${this.currentFen}`);
  }

  /**
   * Synchronizes the BoardHandler's internal chess state (chessPosition, currentFen, etc.)
   * with the PgnService's currentNode.
   */
  private _syncInternalStateWithPgnService(): void {
    const pgnCurrentNode = this.pgnService.getCurrentNode();
    const fenToLoad = pgnCurrentNode.fenAfter;

    try {
      const setup: ChessopsSetup = parseFen(fenToLoad).unwrap(); // Use unwrap and catch potential errors
      this.chessPosition = Chess.fromSetup(setup).unwrap();
      this._updateBoardStateInternal(); // Update fen, turnColor, possibleMoves from new chessPosition
    } catch (e: any) {
      logger.error(`[BoardHandler] Error syncing internal state with PGN FEN ${fenToLoad}:`, e.message, e);
      // Fallback to a default state if sync fails
      const defaultSetup: ChessopsSetup = parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1').unwrap();
      this.chessPosition = Chess.fromSetup(defaultSetup).unwrap();
      this._updateBoardStateInternal();
      // Consider resetting PgnService as well if its state led to an unrecoverable FEN
      // this.pgnService.reset('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    }
  }

  /**
   * Updates currentFen, boardTurnColor, and possibleMoves based on the current this.chessPosition.
   */
  private _updateBoardStateInternal(): void {
    this.currentFen = makeFen(this.chessPosition.toSetup());
    this.boardTurnColor = this.chessPosition.turn;
    this.possibleMoves = chessgroundDests(this.chessPosition); // chessgroundDests uses the turn from chessPosition
    // logger.debug(`[BoardHandler _updateBoardStateInternal] FEN: ${this.currentFen}, Turn: ${this.boardTurnColor}, PossibleMoves count: ${this.possibleMoves.size}`);
  }

  /**
   * Updates Chessground's visual settings based on the current BoardHandler state.
   */
  private _updateChessgroundSettings(): void {
    if (!this.chessboardService.ground) {
      logger.warn('[BoardHandler _updateChessgroundSettings] Chessground not initialized. Skipping update.');
      return;
    }
    
    const gameStatus = this.getGameStatus(); 
    const currentBoardFenOnly = this.currentFen.split(' ')[0];
    
    let movableColor: ChessgroundColor | 'both' | undefined = this.boardTurnColor;
    let destsForGround: Dests = this.possibleMoves;

    if (gameStatus.isGameOver && !this.isAnalysisActiveInternal) {
        movableColor = undefined; // No moves if game over and not analysis
        destsForGround = new Map();
    } else if (this.isAnalysisActiveInternal) {
        // In analysis mode, user can move pieces for the current turn indicated by this.chessPosition.turn
        // If we wanted to allow moving for 'both', we'd need to generate dests for both.
        // For now, analysis mode respects the turn of the current FEN.
        movableColor = this.boardTurnColor; 
        destsForGround = this.possibleMoves; // Already calculated for the current turn
    }

    const lastPgnMoveNode = this.pgnService.getCurrentNavigatedNode(); // This is the node of the last move made
    const lastMoveUciArray: [Key, Key] | undefined = lastPgnMoveNode?.uci 
        ? [lastPgnMoveNode.uci.substring(0, 2) as Key, lastPgnMoveNode.uci.substring(2, 4) as Key]
        : undefined;

    const newConfig: Partial<import('chessground/config').Config> = {
        fen: currentBoardFenOnly,
        turnColor: this.boardTurnColor, 
        movable: {
            free: false, // Always false, legality handled by dests
            color: movableColor,
            dests: destsForGround,
            showDests: true,
        },
        check: gameStatus.isCheck ? true : undefined, // Chessground highlights king of current turnColor if true
        lastMove: lastMoveUciArray,
    };
    
    this.chessboardService.ground.set(newConfig);
    // logger.debug(`[BoardHandler _updateChessgroundSettings] Chessground updated. FEN: ${newConfig.fen}, Turn: ${newConfig.turnColor}, MovableColor: ${newConfig.movable?.color}, Check: ${newConfig.check}`);
  }


  public setAnalysisMode(isActive: boolean): void {
    this.isAnalysisActiveInternal = isActive;
    logger.info(`[BoardHandler] setAnalysisMode called with: ${isActive}`);
    
    // When toggling analysis mode, the current PGN node and board state should remain consistent.
    // _syncInternalStateWithPgnService(); // Ensure chessPosition is aligned with PgnService.currentNode
    this._updateChessgroundSettings(); // Update chessground based on new mode
    
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
        this.setAnalysisMode(false); // Turn off analysis if resetting PGN for a new game/puzzle
    }

    try {
      if (resetPgnHistory) {
        this.pgnService.reset(fen);
      }
      this._syncInternalStateWithPgnService(); // Syncs with PgnService's (new) rootNode

      if (humanPlayerColor) {
        this.humanPlayerColorInternal = humanPlayerColor;
        // Orientation is set by the view/controller that calls this, if needed
        // this.setOrientation(humanPlayerColor); 
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
    // This method is primarily for the view to call if user toggles orientation.
    // BoardHandler itself doesn't enforce orientation on chessground directly,
    // but stores humanPlayerColorInternal for game logic if needed.
    this.humanPlayerColorInternal = color;
    this.chessboardService.setOrientation(color); 
    logger.debug(`[BoardHandler] Orientation set to: ${color} by external call.`);
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
    
    const chessopsMoveToAttempt: ChessopsMove | undefined = parseUci(uciMove);
    if (!chessopsMoveToAttempt) {
      logger.warn(`[BoardHandler] Invalid UCI move format: ${uciMove}`);
      this._updateChessgroundSettings(); 
      return { success: false, isIllegal: true, uciMove };
    }

    // Use a clone of the current position for legality checks and SAN generation
    const positionToTestLegality = this.chessPosition.clone(); 
    const fenBeforeAttempt = makeFen(positionToTestLegality.toSetup()); // This is PgnService.currentNode.fenAfter

    if (!positionToTestLegality.isLegal(chessopsMoveToAttempt)) {
      const pieceTryingToMove = isNormal(chessopsMoveToAttempt) ? positionToTestLegality.board.get(chessopsMoveToAttempt.from) : null;
      logger.warn(`[BoardHandler] Illegal move by chessops: ${uciMove} on FEN ${fenBeforeAttempt}. Turn: ${positionToTestLegality.turn}. Piece: ${pieceTryingToMove?.color}${pieceTryingToMove?.role}.`);
      this._updateChessgroundSettings(); 
      return { success: false, uciMove, isIllegal: true };
    }

    let san: string;
    try {
      // Generate SAN based on the position *before* the move is made on it
      san = makeSan(positionToTestLegality, chessopsMoveToAttempt); 
    } catch (e: any) {
      logger.warn(`[BoardHandler] SAN generation failed for legal move ${uciMove} on FEN ${fenBeforeAttempt}. Error: ${e.message}. Using UCI as SAN.`);
      san = uciMove; 
    }

    // --- Prepare data for PgnService ---
    // Play on the cloned position to get fenAfter
    const tempPosForFenAfter = positionToTestLegality.clone(); // Clone again to play and get fenAfter
    tempPosForFenAfter.play(chessopsMoveToAttempt);
    const fenAfterAttempt = makeFen(tempPosForFenAfter.toSetup());

    const newNodeData: NewNodeData = {
        san,
        uci: uciMove,
        fenBefore: fenBeforeAttempt, // FEN of PgnService.currentNode.fenAfter
        fenAfter: fenAfterAttempt,
        // comment: undefined, // TODO: Add ability to pass comments/evals
        // eval: undefined,
    };

    const addedPgnNode = this.pgnService.addNode(newNodeData);

    if (!addedPgnNode) {
        logger.error(`[BoardHandler] Failed to add node to PgnService for move ${uciMove}. PgnService.addNode returned null.`);
        // This implies a logic error, perhaps FEN mismatch that wasn't caught, or other issue in PgnService.
        // Board state remains unchanged from PgnService's perspective.
        // We should not update this.chessPosition.
        this._updateChessgroundSettings(); // Re-sync chessground to the (old) current PGN state.
        return { success: false, uciMove, isIllegal: true }; // Indicate failure.
    }

    // --- If PGN update was successful, now update BoardHandler's main chessPosition ---
    // this.chessPosition is now effectively PgnService.currentNode's state
    this._syncInternalStateWithPgnService(); // This re-syncs this.chessPosition from PgnService.getCurrentNode().fenAfter

    // --- Post-move processing (sounds, game status) ---
    const pieceOnDestBefore: ChessopsPiece | undefined = positionToTestLegality.board.get(chessopsMoveToAttempt.to); 

    if (isNormal(chessopsMoveToAttempt) && chessopsMoveToAttempt.promotion) SoundService.playSound('promote');
    else if (pieceOnDestBefore && isNormal(chessopsMoveToAttempt)) SoundService.playSound('capture');
    else SoundService.playSound('move');
    
    const gameStatusAfterMove = this.getGameStatus(); // Get status based on the new this.chessPosition
    if (gameStatusAfterMove.isCheck) SoundService.playSound('check');
    if (gameStatusAfterMove.isGameOver && gameStatusAfterMove.outcome?.reason === 'stalemate' && !this.isAnalysisActiveInternal) SoundService.playSound('stalemate');

    if (gameStatusAfterMove.isGameOver && gameStatusAfterMove.outcome && !this.isAnalysisActiveInternal) {
        if (gameStatusAfterMove.outcome.winner === 'white') this.pgnService.setGameResult("1-0");
        else if (gameStatusAfterMove.outcome.winner === 'black') this.pgnService.setGameResult("0-1");
        else this.pgnService.setGameResult("1/2-1/2");
    }
    
    this._updateChessgroundSettings(); // Update chessground display
    this.requestRedraw(); // Request main UI redraw
    
    logger.debug(`[BoardHandler] Move ${uciMove} (SAN: ${san}) applied. New FEN: ${this.currentFen}. PGN Path: ${this.pgnService.getCurrentPath()}`);
    return { success: true, newFen: this.currentFen, outcome: gameStatusAfterMove.outcome, uciMove, isIllegal: false };
  }


  public getFen(): string {
    return this.currentFen;
  }

  public getPgn(options?: import('./pgn.service').PgnStringOptions): string {
    // PGN string should reflect game over state if not in analysis
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
            gameEndReason = this.chessPosition.isCheckmate() ? 'checkmate' : 'variant_win'; // Distinguish checkmate
        } else {
            if (this.chessPosition.isStalemate()) gameEndReason = 'stalemate';
            else if (this.chessPosition.isInsufficientMaterial()) gameEndReason = 'insufficient_material';
            else gameEndReason = 'draw'; // Could be variant draw or other standard draw
        }
        gameEndOutcome = {
            winner: outcomeDetails.winner,
            reason: gameEndReason,
        };
    }

    if (!isGameOver) {
        // Repetition check using PgnService's history for the current line
        const fenHistory = this.pgnService.getFenHistoryForRepetition(); // Gets FENs for current path
        const currentBoardFenOnly = this.currentFen.split(' ')[0]; 
        
        let repetitionCount = 0;
        // fenHistory already includes the current position's FEN (board part) if it's not root.
        // If currentFen is the one being repeated, it's already in history.
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
        if (this.chessPosition.halfmoves >= 100) { // 50-move rule (100 halfmoves)
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
    // Check legality against the current internal chessPosition
    return this.chessPosition.isLegal(move);
  }

  public getPromotionState(): PromotingState | null { return this.promotionCtrl?.promoting || null; }
  
  public drawArrow(orig: Key, dest: Key, brush: string = 'green'): void {
    if (!this.chessboardService.ground) return;
    const newShapeToAdd: CustomDrawShape = { orig, dest, brush };

    const currentBoardShapes: DrawShape[] = this.chessboardService.ground.state.drawable.shapes || [];
    const shapesToKeepAndSet: CustomDrawShape[] = [];

    for (const s of currentBoardShapes) {
        if (s.orig === orig && s.dest === dest && s.brush === brush) { // Avoid duplicate exact shape
            continue;
        }
        if (s.brush !== undefined) { // Ensure existing shapes have a brush (as per CustomDrawShape)
            shapesToKeepAndSet.push(s as CustomDrawShape); 
        }
    }

    const finalShapesList: CustomDrawShape[] = [...shapesToKeepAndSet, newShapeToAdd];
    this.chessboardService.drawShapes(finalShapesList);
    // logger.debug(`[BoardHandler] Drawing arrow from ${orig} to ${dest} with brush ${brush}`);
  }

  public drawCircle(key: Key, brush: string = 'green'): void {
    if (!this.chessboardService.ground) return;
    const newShapeToAdd: CustomDrawShape = { orig: key, brush };
    const currentBoardShapes: DrawShape[] = this.chessboardService.ground.state.drawable.shapes || [];
    const shapesToKeepAndSet: CustomDrawShape[] = [];

    for (const s of currentBoardShapes) {
        if (s.orig === key && s.dest === undefined && s.brush === brush) { // Avoid duplicate exact shape
            continue;
        }
        if (s.brush !== undefined) {
            shapesToKeepAndSet.push(s as CustomDrawShape);
        }
    }
    
    const finalShapesList: CustomDrawShape[] = [...shapesToKeepAndSet, newShapeToAdd];
    this.chessboardService.drawShapes(finalShapesList);
    // logger.debug(`[BoardHandler] Drawing circle on ${key} with brush ${brush}`);
  }

  public clearAllDrawings(): void { 
    this.chessboardService.clearShapes(); 
    // logger.debug(`[BoardHandler] All drawings cleared.`);
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
    // In analysis mode, undo simply navigates PGN back.
    // If not in analysis, it effectively "takes back" the last move from the game's perspective.
    const undonePgnNode = this.pgnService.undoLastMove();
    if (undonePgnNode) {
      this._syncInternalStateWithPgnService(); // Sync board to the new PGN state
      this.pgnService.setGameResult('*'); // Game is no longer "over" in the same way
      this._updateChessgroundSettings();
      logger.info(`[BoardHandler] Undid move. Current FEN on board: ${this.currentFen}. PGN Path: ${this.pgnService.getCurrentPath()}`);
      this.requestRedraw();
      return true;
    }
    logger.warn('[BoardHandler] No moves in PGN history to undo.');
    return false;
  }

  /**
   * Gets the PGN node representing the last move made to reach the current state.
   */
  public getLastPgnMoveNode(): PgnNode | null { 
    return this.pgnService.getCurrentNavigatedNode(); // This returns currentNode if it's not root
  }

  // --- PGN Navigation Wrappers ---
  // These methods now ensure board state and chessground are updated after PGN service navigation.

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

  public handleNavigatePgnForward(variationIndex: number = 0): boolean {
    const success = this.pgnService.navigateForward(variationIndex);
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
    // Promote a child of the *current* PGN node to be its mainline
    const success = this.pgnService.promoteVariationToMainline(variationNodeId);
    if (success) {
        // The PGN structure changed, but PgnService.currentNode remains the same.
        // We need to re-sync and redraw to reflect the new mainline.
        this._syncInternalStateWithPgnService(); // Might not be strictly necessary if only children order changed
        this._updateChessgroundSettings();
        this.requestRedraw();
    }
    return success;
  }
}
