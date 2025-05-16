// src/core/boardHandler.ts

import type {
  Key,
  Dests,
  Color as ChessgroundColor,
} from 'chessground/types';
import type { DrawShape } from 'chessground/draw';

import type {
  Role as ChessopsRole,
  Color as ChessopsColor,
  Outcome as ChessopsOutcome,
} from 'chessops/types';

import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import { parseSquare, makeUci, parseUci } from 'chessops/util';
import { chessgroundDests } from 'chessops/compat';

import type { ChessboardService } from './chessboard.service';
import type { CustomDrawShape } from './chessboard.service'; 

import { PromotionCtrl } from '../features/common/promotion/promotionCtrl';
import type { PromotingState } from '../features/common/promotion/promotionCtrl';
import logger from '../utils/logger';

export type GameEndReason = 'checkmate' | 'stalemate' | 'insufficient_material' | 'draw' | 'variant_win' | 'variant_loss' | 'variant_draw';

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

// Добавим интерфейс для результата attemptUserMove, чтобы он был консистентным
export interface AttemptMoveResult {
    success: boolean;
    uciMove?: string;
    newFen?: string;
    outcome?: GameEndOutcome;
    promotionStarted?: boolean; // Остается для информации UI, если нужно
    promotionCompleted?: boolean; // Новое поле, чтобы указать, что промоушен был и завершился
}


export class BoardHandler {
  private chessboardService: ChessboardService;
  public promotionCtrl: PromotionCtrl;
  private requestRedraw: () => void;

  private chessPosition: Chess;
  public currentFen: string;
  public boardTurnColor: ChessgroundColor;
  public possibleMoves: Dests;
  public moveHistory: Array<{ uci: string; san: string; fenBefore: string; fenAfter: string }> = [];

  private humanPlayerColorInternal: ChessgroundColor = 'white';

  constructor(
    chessboardService: ChessboardService,
    requestRedraw: () => void
  ) {
    this.chessboardService = chessboardService;
    this.requestRedraw = requestRedraw;
    this.promotionCtrl = new PromotionCtrl(this.requestRedraw);

    this.chessPosition = Chess.default();
    this.currentFen = makeFen(this.chessPosition.toSetup());
    this.boardTurnColor = this.chessPosition.turn;
    this.possibleMoves = chessgroundDests(this.chessPosition);
    logger.info(`[BoardHandler] Initialized with FEN: ${this.currentFen}`);
  }

  private _updateBoardState(): void {
    this.currentFen = makeFen(this.chessPosition.toSetup());
    this.boardTurnColor = this.chessPosition.turn;
    this.possibleMoves = chessgroundDests(this.chessPosition);
  }

  public setupPosition(fen: string, humanPlayerColor?: ChessgroundColor, resetHistory: boolean = true): boolean {
    try {
      const setup = parseFen(fen).unwrap();
      this.chessPosition = Chess.fromSetup(setup).unwrap();
      if (resetHistory) {
        this.moveHistory = [];
      }
      this._updateBoardState();
      if (humanPlayerColor) {
        this.humanPlayerColorInternal = humanPlayerColor;
        this.setOrientation(humanPlayerColor);
      }
      this.chessboardService.setFen(this.currentFen.split(' ')[0]);
      logger.info(`[BoardHandler] Position setup with FEN: ${fen}`);
      this.requestRedraw();
      return true;
    } catch (e: any) {
      logger.error('[BoardHandler] Failed to setup position from FEN:', fen, e.message);
      this.chessPosition = Chess.default();
      this._updateBoardState();
      this.chessboardService.setFen(this.currentFen.split(' ')[0]);
      this.requestRedraw();
      return false;
    }
  }

  public setOrientation(color: ChessgroundColor): void {
    this.humanPlayerColorInternal = color;
    this.chessboardService.setOrientation(color);
    logger.debug(`[BoardHandler] Orientation set to: ${color}`);
  }

  public async attemptUserMove(orig: Key, dest: Key): Promise<AttemptMoveResult> {
    const gameStatus = this.getGameStatus();
    if (gameStatus.isGameOver) {
      logger.warn('[BoardHandler] Attempted move in a game over state.');
      return { success: false };
    }

    const fromSq = parseSquare(orig);
    const toSq = parseSquare(dest);

    if (fromSq === undefined || toSq === undefined) {
      logger.warn(`[BoardHandler] Invalid square in user move: ${orig} or ${dest}`);
      return { success: false };
    }

    const promotionCheck = this._isPromotionAttempt(orig, dest);
    if (promotionCheck.isPromotion && promotionCheck.pieceColor) {
      logger.info(`[BoardHandler] Promotion attempt detected: ${orig}-${dest}`);
      // Возвращаем промис, который разрешится ПОСЛЕ выбора фигуры и применения хода
      return new Promise<AttemptMoveResult>((resolve) => {
        this.promotionCtrl.start(orig, dest, promotionCheck.pieceColor as ChessgroundColor, (selectedRole: ChessopsRole | null) => {
          if (!selectedRole) { // Если промоушен был отменен (например, клик вне диалога)
            logger.info('[BoardHandler] Promotion cancelled by user.');
            // Важно восстановить доску в состояние до попытки хода, если chessground ее изменил визуально
            this.chessboardService.setFen(this.currentFen.split(' ')[0]);
            this.requestRedraw();
            resolve({ success: false, promotionStarted: true, promotionCompleted: false });
            return;
          }
          const uciMoveWithPromotion = makeUci({ from: fromSq, to: toSq, promotion: selectedRole });
          logger.info(`[BoardHandler] Promotion selected: ${selectedRole}. Completing move: ${uciMoveWithPromotion}`);
          const result = this._applyAndProcessUciMove(uciMoveWithPromotion);
          // Добавляем информацию о промоушене к результату
          resolve({ ...result, promotionStarted: true, promotionCompleted: result.success, uciMove: uciMoveWithPromotion });
        });
        // Не разрешаем промис здесь, ждем колбэка из promotionCtrl
        // Но можем уведомить UI, что промоушен начался, если это нужно сделать немедленно
        // this.requestRedraw(); // Чтобы показать диалог
      });
    }

    // Обычный ход без промоушена
    const uciMove = makeUci({ from: fromSq, to: toSq });
    const result = this._applyAndProcessUciMove(uciMove);
    return Promise.resolve({ ...result, uciMove }); // Оборачиваем в промис для консистентности
  }

  // Этот метод больше не нужен, так как логика встроена в attemptUserMove через промис
  // public completePromotionMove(orig: Key, dest: Key, selectedRole: ChessopsRole): AttemptMoveResult { ... }

  public applySystemMove(uciMove: string): AttemptMoveResult {
    if (this.getGameStatus().isGameOver) {
      logger.warn('[BoardHandler] Attempted system move in a game over state.');
      return { success: false };
    }
    logger.info(`[BoardHandler] Applying system move: ${uciMove}`);
    return this._applyAndProcessUciMove(uciMove);
  }

  private _applyAndProcessUciMove(uciMove: string): Omit<AttemptMoveResult, 'promotionStarted' | 'promotionCompleted'> {
    const move = parseUci(uciMove);
    if (!move) {
      logger.warn(`[BoardHandler] Invalid UCI move format: ${uciMove}`);
      this.chessboardService.setFen(makeFen(this.chessPosition.toSetup()).split(' ')[0]);
      this.requestRedraw();
      return { success: false };
    }

    let san: string;
    const tempPosForSan = this.chessPosition.clone();
    try {
      san = makeSan(tempPosForSan, move);
    } catch (e: any) {
      logger.warn(`[BoardHandler] SAN generation failed for move ${uciMove} on FEN: ${this.currentFen}. Error: ${e.message}. Assuming move is illegal.`);
      this.chessboardService.setFen(makeFen(this.chessPosition.toSetup()).split(' ')[0]);
      this.requestRedraw();
      return { success: false, uciMove }; // Возвращаем uciMove для информации
    }
    
    const fenBefore = this.currentFen;
    try {
      this.chessPosition.play(move);
    } catch (e: any) {
        logger.error(`[BoardHandler] Move ${uciMove} (SAN: ${san}) considered illegal by chessops.play() on FEN: ${fenBefore}. Error: ${e.message}`);
        const setupBefore = parseFen(fenBefore).unwrap();
        this.chessPosition = Chess.fromSetup(setupBefore).unwrap();
        this._updateBoardState();
        this.chessboardService.setFen(this.currentFen.split(' ')[0]);
        this.requestRedraw();
        return { success: false, uciMove };
    }

    this._updateBoardState(); 
    this.moveHistory.push({ uci: uciMove, san, fenBefore, fenAfter: this.currentFen });
    
    this.chessboardService.setFen(this.currentFen.split(' ')[0]);

    const gameStatus = this.getGameStatus();

    this.requestRedraw();
    logger.debug(`[BoardHandler] Move ${uciMove} (SAN: ${san}) applied. New FEN: ${this.currentFen}. Outcome: ${JSON.stringify(gameStatus.outcome)}`);
    return { success: true, newFen: this.currentFen, outcome: gameStatus.outcome, uciMove };
  }

  public getFen(): string {
    return this.currentFen;
  }

  public getPgn(): string {
    const initialFen = this.moveHistory.length > 0 ? this.moveHistory[0].fenBefore : this.currentFen;
    let pgnString = `[FEN "${initialFen}"]\n`;
    
    let moveCounter = Math.floor(this.chessPosition.fullmoves - (this.moveHistory.length / 2));
    if (initialFen.includes(' b ')) {
        if (this.moveHistory.length > 0) {
            pgnString += `${moveCounter}... ${this.moveHistory[0].san} `;
            for (let i = 1; i < this.moveHistory.length; i++) {
                if (i % 2 === 1) { 
                    moveCounter++;
                    pgnString += `${moveCounter}. ${this.moveHistory[i].san} `;
                } else { 
                    pgnString += `${this.moveHistory[i].san} `;
                }
            }
        }
    } else { 
        for (let i = 0; i < this.moveHistory.length; i++) {
            if (i % 2 === 0) { 
                moveCounter++;
                pgnString += `${moveCounter}. ${this.moveHistory[i].san} `;
            } else { 
                pgnString += `${this.moveHistory[i].san} `;
            }
        }
    }

    const gameStatus = this.getGameStatus();
    if (gameStatus.isGameOver && gameStatus.outcome) {
        if (gameStatus.outcome.winner === 'white') pgnString += '1-0';
        else if (gameStatus.outcome.winner === 'black') pgnString += '0-1';
        else pgnString += '1/2-1/2';
    } else {
        pgnString += '*';
    }
    return pgnString.trim();
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
    const isGameOver = !!outcomeDetails;
    let gameEndOutcome: GameEndOutcome | undefined;
    let gameEndReason: GameEndReason | undefined;

    if (outcomeDetails) {
        if (outcomeDetails.winner) {
            if (this.chessPosition.isCheckmate()) {
                 gameEndReason = 'checkmate';
            } else {
                gameEndReason = 'checkmate'; 
            }
        } else { 
            if (this.chessPosition.isStalemate()) {
                gameEndReason = 'stalemate';
            } else if (this.chessPosition.isInsufficientMaterial()) {
                gameEndReason = 'insufficient_material';
            } else {
                gameEndReason = 'draw'; 
            }
        }
        gameEndOutcome = {
            winner: outcomeDetails.winner,
            reason: gameEndReason
        };
    }
    
    const isCheck = this.chessPosition.isCheck();

    return {
      isGameOver,
      outcome: gameEndOutcome,
      isCheck,
      turn: this.chessPosition.turn,
    };
  }

  public isMoveLegal(uciMove: string): boolean {
    const move = parseUci(uciMove);
    if (!move) return false;
    return this.chessPosition.isLegal(move);
  }

  public getPromotionState(): PromotingState | null {
    return this.promotionCtrl?.promoting || null;
  }

  public drawArrow(orig: Key, dest: Key, brush: string = 'green'): void {
    const currentShapesFromGround: DrawShape[] = this.chessboardService.ground?.state.drawable.shapes || [];
    
    const validExistingShapes: CustomDrawShape[] = currentShapesFromGround
      .filter(shape => typeof shape.brush === 'string' && shape.brush.length > 0)
      .map(shape => ({
          orig: shape.orig,
          dest: shape.dest,
          brush: shape.brush as string, 
          ...(shape.modifiers && { modifiers: shape.modifiers }),
          ...(shape.piece && { piece: shape.piece }),
          ...(shape.customSvg && { customSvg: shape.customSvg }),
          ...(shape.label && { label: shape.label }),
      }));

    const newArrowShape: CustomDrawShape = { orig, dest, brush };
    
    this.chessboardService.drawShapes([...validExistingShapes, newArrowShape]);
  }

  public drawCircle(key: Key, brush: string = 'green'): void {
    const currentShapesFromGround: DrawShape[] = this.chessboardService.ground?.state.drawable.shapes || [];
    
    const validExistingShapes: CustomDrawShape[] = currentShapesFromGround
      .filter(shape => typeof shape.brush === 'string' && shape.brush.length > 0)
      .map(shape => ({
        orig: shape.orig,
        dest: shape.dest,
        brush: shape.brush as string,
        ...(shape.modifiers && { modifiers: shape.modifiers }),
        ...(shape.piece && { piece: shape.piece }),
        ...(shape.customSvg && { customSvg: shape.customSvg }),
        ...(shape.label && { label: shape.label }),
      }));

    const newCircleShape: CustomDrawShape = { orig: key, brush }; 
    
    this.chessboardService.drawShapes([...validExistingShapes, newCircleShape]);
  }

  public clearAllDrawings(): void {
    this.chessboardService.clearShapes();
  }

  private _isPromotionAttempt(orig: Key, dest: Key): { isPromotion: boolean; pieceColor?: ChessopsColor } {
    const fromSq = parseSquare(orig);
    if (fromSq === undefined) return {isPromotion: false};

    const piece = this.chessPosition.board.get(fromSq);
    if (!piece || piece.role !== 'pawn') return { isPromotion: false };

    const destRankChar = dest.charAt(1); 
    if (piece.color === 'white' && destRankChar === '8') {
      return { isPromotion: true, pieceColor: 'white' };
    }
    if (piece.color === 'black' && destRankChar === '1') {
      return { isPromotion: true, pieceColor: 'black' };
    }
    return { isPromotion: false };
  }

  public undoLastMove(): boolean {
    if (this.moveHistory.length === 0) {
        logger.warn("[BoardHandler] No moves in history to undo.");
        return false;
    }
    const lastMoveRecord = this.moveHistory.pop(); 
    if (lastMoveRecord) {
        const setup = parseFen(lastMoveRecord.fenBefore).unwrap();
        this.chessPosition = Chess.fromSetup(setup).unwrap();
        this._updateBoardState(); 
        
        this.chessboardService.setFen(this.currentFen.split(' ')[0]); 
        logger.info(`[BoardHandler] Undid move. Restored FEN: ${this.currentFen}`);
        this.requestRedraw();
        return true;
    }
    return false;
  }
}
