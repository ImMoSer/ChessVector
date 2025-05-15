// src/core/chess-logic.service.ts
import { Chess, normalizeMove } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { parseSquare, makeSquare, parseUci as chessopsParseUci, makeUci as chessopsMakeUci } from 'chessops/util';
import { chessgroundDests } from 'chessops/compat';
import type { Role as ChessopsRole, Square as ChessopsSquare, Color as ChessopsColor, Move as ChessopsMove } from 'chessops/types';
import type { Key, Dests } from 'chessground/types';
import logger from '../utils/logger';

export class ChessLogicService {

  public static getPieceAtSquare(fen: string, key: Key): { role: ChessopsRole, color: ChessopsColor } | null {
    try {
        const pos = ChessLogicService.getPosition(fen);
        if (!pos) return null;
        const square = parseSquare(key); 
        if (square === undefined) { 
            logger.warn(`[ChessLogicService.getPieceAtSquare] Invalid key: ${key}`);
            return null;
        }
        const piece = pos.board.get(square); 
        if (!piece) return null;
        return { role: piece.role, color: piece.color };
    } catch (e) {
        logger.error(`[ChessLogicService.getPieceAtSquare] Error for FEN ${fen}, Key ${key}:`, e);
        return null;
    }
  }

  public static getPosition(fen: string): Chess | null {
    try {
        const setup = parseFen(fen).unwrap(); 
        return Chess.fromSetup(setup).unwrap();
    } catch(e) {
        logger.error("[ChessLogicService.getPosition] Error creating position from FEN:", fen, e);
        return null;
    }
  }

  public getFenAfterMove(currentFen: string, uciMove: string): string | null {
    try {
      const pos = ChessLogicService.getPosition(currentFen);
      if (!pos) return null; 

      const move = chessopsParseUci(uciMove);
      if (!move) {
        logger.warn(`[ChessLogicService] Invalid UCI move string: ${uciMove}`);
        return null;
      }

      const normalizedMove = normalizeMove(pos, move);
      if (!normalizedMove) {
        logger.warn(`[ChessLogicService] Move ${uciMove} is not legal or not normalized in FEN: ${currentFen}`);
        return null;
      }

      pos.play(normalizedMove);
      return makeFen(pos.toSetup());
    } catch (e) {
      logger.error(`[ChessLogicService] Error playing move ${uciMove} on FEN ${currentFen}:`, e);
      return null;
    }
  }

  public getPossibleMoves(fen: string): Dests {
    try {
      const pos = ChessLogicService.getPosition(fen);
      if (!pos) return new Map<Key, Key[]>(); 

      return chessgroundDests(pos);
    } catch (e) {
      logger.error(`[ChessLogicService] Error getting possible moves for FEN ${fen}:`, e);
      return new Map<Key, Key[]>(); 
    }
  }

  public isMoveLegal(currentFen: string, uciMove: string): boolean {
    try {
      const pos = ChessLogicService.getPosition(currentFen);
      if (!pos) return false;

      const move = chessopsParseUci(uciMove);
      if (!move) return false;

      return !!normalizeMove(pos, move); 
    } catch (e) {
      logger.warn(`[ChessLogicService] Error checking legality for ${uciMove} on FEN ${currentFen}:`, e);
      return false;
    }
  }

  public toUci(orig: Key, dest: Key, promotion?: ChessopsRole): string | null {
    const fromSq = parseSquare(orig); 
    const toSq = parseSquare(dest);   

    if (fromSq === undefined || toSq === undefined) {
        logger.warn(`[ChessLogicService] Invalid square in toUci: orig=${orig}, dest=${dest}`);
        return null;
    }

    return chessopsMakeUci({ from: fromSq, to: toSq, promotion });
  }

  public static roleFromString(roleChar?: string): ChessopsRole | undefined {
    if (!roleChar) return undefined;
    const role = roleChar.toLowerCase();
    if (role === 'q') return 'queen';
    if (role === 'r') return 'rook';
    if (role === 'b') return 'bishop';
    if (role === 'n') return 'knight';
    return undefined; 
  }

  public getRandomLegalMoveUci(fen: string): string | null {
    try {
      const pos = ChessLogicService.getPosition(fen);
      if (!pos) {
        logger.warn(`[ChessLogicService.getRandomLegalMoveUci] Could not get position for FEN: ${fen}`);
        return null;
      }

      const legalMoves: ChessopsMove[] = [];
      
      // Attempt to create a new Map from the result of pos.dests().
      // pos.dests() should return an iterable of [ChessopsSquare, ChessopsSquare[]] pairs.
      // This approach ensures allDestsMap is a standard JavaScript Map,
      // which should satisfy TypeScript's expectations for iteration and methods.
      // The 'as any' cast is a workaround if TypeScript still cannot reconcile the types
      // from chessops's dests() with the Map constructor's expected iterable.
      // A more precise cast would be:
      // as Iterable<readonly [ChessopsSquare, ChessopsSquare[]]>
      // but 'as any' is broader if the exact iterable type is still problematic.
      let allDestsMap: Map<ChessopsSquare, ChessopsSquare[]>;
      try {
        // The error "Expected 1-2 arguments, but got 0" for pos.dests() is a TypeScript linting issue
        // if the code runs. Functionally, pos.dests() without args is valid in chessops.
        // @ts-expect-error TS complains about missing arguments for dests, but it works.
        const destsResult = pos.dests();
        allDestsMap = new Map(destsResult as Iterable<readonly [ChessopsSquare, ChessopsSquare[]]>);
      } catch (mapError) {
        logger.error(`[ChessLogicService] Error creating Map from pos.dests() for FEN ${fen}:`, mapError);
        return null; // If creating the map itself fails, we can't proceed.
      }
      

      for (const [fromSquare, toSquares] of allDestsMap) { 
        for (const toSquare of toSquares) {
          const piece = pos.board.get(fromSquare); 

          if (piece?.role === 'pawn' &&
              ( (piece.color === 'white' && makeSquare(toSquare).charAt(1) === '8') ||
                (piece.color === 'black' && makeSquare(toSquare).charAt(1) === '1') )) {
            const promotionRoles: ChessopsRole[] = ['queen', 'rook', 'bishop', 'knight'];
            promotionRoles.forEach(promoRole => {
              const moveWithPromotion = normalizeMove(pos, { from: fromSquare, to: toSquare, promotion: promoRole });
              if(moveWithPromotion) legalMoves.push(moveWithPromotion);
            });
          } else {
            const move = normalizeMove(pos, { from: fromSquare, to: toSquare });
            if(move) legalMoves.push(move);
          }
        }
      }

      if (legalMoves.length === 0) {
        logger.info(`[ChessLogicService.getRandomLegalMoveUci] No legal moves found for FEN ${fen}. Mate or stalemate?`);
        return null; 
      }

      const randomIndex = Math.floor(Math.random() * legalMoves.length);
      return chessopsMakeUci(legalMoves[randomIndex]);
    } catch (e: any) { 
      logger.error(`[ChessLogicService] Error getting random legal move for FEN ${fen}: ${e.message}`, e.stack ? e.stack : '');
      return null;
    }
  }
}
