// src/core/pgn.service.ts
import logger from '../utils/logger';

/**
 * Interface for a single node in the PGN history.
 */
export interface PgnNode {
  ply: number; // Ply number (half-move count, starting from 1 for the first move)
  fenBefore: string;
  san: string;
  uci: string;
  fenAfter: string;
  // variations?: PgnNode[][]; // For future tree structure
  // parent?: PgnNode;
}

/**
 * Options for formatting the PGN string.
 */
export interface PgnStringOptions {
  showResult?: boolean;
  // fromPly?: number; // For future partial PGN generation
  // toPly?: number;
}

class PgnServiceController {
  private initialFen: string = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  private mainline: PgnNode[] = [];
  private gameResult: string = '*';
  private currentPlyNavigated: number = 0; // 0: initial position, 1: after 1st ply, etc.

  constructor() {
    logger.info('[PgnService] Initialized.');
    this.reset(this.initialFen);
  }

  /**
   * Resets the PGN history and sets the initial FEN.
   * @param fen - The starting FEN of the game.
   */
  public reset(fen: string): void {
    this.initialFen = fen;
    this.mainline = [];
    this.gameResult = '*';
    this.currentPlyNavigated = 0; // Reset navigation to the initial position
    logger.info(`[PgnService] Reset with FEN: ${this.initialFen}. Current navigated ply: ${this.currentPlyNavigated}`);
  }

  /**
   * Adds a move to the PGN history.
   * If a move is added while navigating history (not at the end),
   * the subsequent history (variations from that point) is truncated.
   * @param fenBefore - FEN string before the move.
   * @param san - Standard Algebraic Notation of the move.
   * @param uci - UCI string of the move.
   * @param fenAfter - FEN string after the move.
   */
  public addMove(fenBefore: string, san: string, uci: string, fenAfter: string): void {
    // If currentPlyNavigated is not at the end of the mainline,
    // it means we are branching off or overwriting history.
    if (this.currentPlyNavigated < this.mainline.length) {
      logger.warn(`[PgnService] Adding move while currentPlyNavigated (${this.currentPlyNavigated}) is not at the end of mainline (${this.mainline.length}). Truncating mainline.`);
      this.mainline = this.mainline.slice(0, this.currentPlyNavigated);
    }

    const ply = this.mainline.length + 1; // Ply number for the new move
    const newNode: PgnNode = {
      ply,
      fenBefore,
      san,
      uci,
      fenAfter,
    };
    this.mainline.push(newNode);
    this.currentPlyNavigated = this.mainline.length; // After adding a move, navigation points to the new last position
    logger.debug(`[PgnService] Move added: Ply ${newNode.ply}, SAN ${san}. Current navigated ply: ${this.currentPlyNavigated}`);
  }

  /**
   * Sets the game result.
   * @param result - e.g., "1-0", "0-1", "1/2-1/2"
   */
  public setGameResult(result: string): void {
    if (["1-0", "0-1", "1/2-1/2", "*"].includes(result)) {
      this.gameResult = result;
      logger.info(`[PgnService] Game result set to: ${result}`);
    } else {
      logger.warn(`[PgnService] Invalid game result: ${result}. Using '*'`);
      this.gameResult = '*';
    }
  }

  private isWhiteTurnFromFen(fen: string): boolean {
    const parts = fen.split(' ');
    return parts.length > 1 && parts[1] === 'w';
  }

  private getFullMoveNumberFromFen(fen: string): number {
    const parts = fen.split(' ');
    return parts.length > 5 ? parseInt(parts[5], 10) : 1;
  }

  public getCurrentPgnString(options?: PgnStringOptions): string {
    if (this.mainline.length === 0) {
      return options?.showResult ? this.gameResult : '';
    }

    let pgn = '';
    let currentFullMoveNumber = this.getFullMoveNumberFromFen(this.mainline[0].fenBefore);
    const firstMoveIsWhite = this.isWhiteTurnFromFen(this.mainline[0].fenBefore);

    // Iterate up to the current navigated ply, or full mainline if not specified differently
    const movesToDisplay = this.mainline; // For now, always display the full mainline. Navigation will change what's on the board.

    for (let i = 0; i < movesToDisplay.length; i++) {
      const node = movesToDisplay[i];
      const isWhiteMoveInPgn = (firstMoveIsWhite && i % 2 === 0) || (!firstMoveIsWhite && i % 2 !== 0);

      if (isWhiteMoveInPgn) {
        if (i !== 0) pgn += '\n';
        pgn += `${currentFullMoveNumber}. `;
        if (i === 0 && !firstMoveIsWhite) {
          pgn += `... `;
        }
      } else {
        pgn += ` `;
      }
      pgn += node.san;

      if (!isWhiteMoveInPgn) {
        currentFullMoveNumber++;
      }
    }

    if (options?.showResult) {
      pgn += (pgn.length > 0 && this.mainline.length > 0 ? ' ' : '') + this.gameResult;
    }
    return pgn.trim();
  }

  /**
   * Returns the FEN of the currently navigated position.
   * If ply is 0, returns initial FEN. Otherwise, FEN after the navigated ply.
   */
  public getCurrentNavigatedFen(): string {
    if (this.currentPlyNavigated === 0) {
      return this.initialFen;
    }
    if (this.currentPlyNavigated > 0 && this.currentPlyNavigated <= this.mainline.length) {
      return this.mainline[this.currentPlyNavigated - 1].fenAfter;
    }
    // Should not happen if navigation is correct, but as a fallback:
    return this.mainline.length > 0 ? this.mainline[this.mainline.length - 1].fenAfter : this.initialFen;
  }

  /**
   * Returns the PgnNode of the move that LED TO the current navigated position.
   * Returns null if at the initial position (ply 0).
   */
  public getCurrentNavigatedNode(): PgnNode | null {
    if (this.currentPlyNavigated > 0 && this.currentPlyNavigated <= this.mainline.length) {
      return this.mainline[this.currentPlyNavigated - 1];
    }
    return null;
  }


  public getFenHistoryForRepetition(): string[] {
    const history = [this.initialFen.split(' ')[0]];
    // Consider only moves up to the current navigated ply for repetition in that specific line
    const relevantMainline = this.mainline.slice(0, this.currentPlyNavigated);
    relevantMainline.forEach(node => {
        history.push(node.fenAfter.split(' ')[0]);
    });
    return history;
  }

  public getLastMove(): PgnNode | null {
    return this.mainline.length > 0 ? this.mainline[this.mainline.length - 1] : null;
  }

  public undoLastMainlineMove(): PgnNode | null {
    if (this.mainline.length > 0) {
      const undoneMove = this.mainline.pop();
      // After undoing, the navigated ply should be the new end of the mainline
      this.currentPlyNavigated = this.mainline.length;
      logger.info(`[PgnService] Undid last mainline move: ${undoneMove?.san}. Current navigated ply: ${this.currentPlyNavigated}`);
      return undoneMove || null;
    }
    logger.warn(`[PgnService] No moves in mainline to undo.`);
    return null;
  }

  // --- Navigation Methods ---

  public navigateToPly(ply: number): boolean {
    if (ply >= 0 && ply <= this.mainline.length) {
      this.currentPlyNavigated = ply;
      logger.debug(`[PgnService] Navigated to ply: ${this.currentPlyNavigated}`);
      return true;
    }
    logger.warn(`[PgnService] Cannot navigate to ply ${ply}. Out of bounds (0-${this.mainline.length}).`);
    return false;
  }

  public navigateBackward(): boolean {
    if (this.canNavigateBackward()) {
      this.currentPlyNavigated--;
      logger.debug(`[PgnService] Navigated backward to ply: ${this.currentPlyNavigated}`);
      return true;
    }
    return false;
  }

  public navigateForward(): boolean {
    if (this.canNavigateForward()) {
      this.currentPlyNavigated++;
      logger.debug(`[PgnService] Navigated forward to ply: ${this.currentPlyNavigated}`);
      return true;
    }
    return false;
  }

  public navigateToStart(): void {
    this.currentPlyNavigated = 0;
    logger.debug(`[PgnService] Navigated to start (ply 0).`);
  }

  public navigateToEnd(): void {
    this.currentPlyNavigated = this.mainline.length;
    logger.debug(`[PgnService] Navigated to end (ply ${this.currentPlyNavigated}).`);
  }

  public canNavigateBackward(): boolean {
    return this.currentPlyNavigated > 0;
  }

  public canNavigateForward(): boolean {
    return this.currentPlyNavigated < this.mainline.length;
  }

  public getCurrentPlyNavigated(): number {
    return this.currentPlyNavigated;
  }

  public getTotalPliesInMainline(): number {
    return this.mainline.length;
  }
}

export const PgnService = new PgnServiceController();
