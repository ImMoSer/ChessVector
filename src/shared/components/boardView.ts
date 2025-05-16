// src/shared/components/boardView.ts

// GameEndOutcome удален из импорта, так как не используется в этом файле
import type { BoardHandler, GameStatus } from '../../core/boardHandler';
import type { ChessboardService, CustomDrawShape } from '../../core/chessboard.service';
import type { Config as ChessgroundConfig } from 'chessground/config';
import type { Key, Dests, Color as ChessgroundColor, MoveMetadata } from 'chessground/types';
import logger from '../../utils/logger';

export class BoardView {
    public container: HTMLElement;
    private boardHandler: BoardHandler;
    private chessboardService: ChessboardService;
    private onUserMoveCallback: (orig: Key, dest: Key, metadata?: MoveMetadata) => Promise<void>;

    constructor(
        container: HTMLElement,
        boardHandler: BoardHandler,
        chessboardService: ChessboardService,
        onUserMove: (orig: Key, dest: Key, metadata?: MoveMetadata) => Promise<void>
    ) {
        this.container = container;
        this.boardHandler = boardHandler;
        this.chessboardService = chessboardService;
        this.onUserMoveCallback = onUserMove;

        this.initBoard();
    }

    private initBoard(): void {
        if (this.chessboardService.ground) {
            logger.warn('[BoardView] ChessboardService already has an initialized ground instance. Destroying and re-initializing for this container.');
            this.chessboardService.destroy();
        }

        const initialFen = this.boardHandler.getFen().split(' ')[0];
        const initialTurnColor = this.boardHandler.getBoardTurnColor();
        const initialOrientation = this.boardHandler.getHumanPlayerColor() || 'white';
        
        const config: ChessgroundConfig = {
            fen: initialFen,
            orientation: initialOrientation,
            turnColor: initialTurnColor,
            movable: {
                free: false, 
                color: this.getMovableColor(),
                dests: this.getMovableDests(),
                events: {
                    after: (orig: Key, dest: Key, metadata: MoveMetadata) => {
                        logger.debug(`[BoardView] User move on board: ${orig}-${dest}. Calling onUserMoveCallback.`);
                        this.onUserMoveCallback(orig, dest, metadata)
                            .catch(error => {
                                logger.error('[BoardView] Error in onUserMoveCallback:', error);
                                this.updateView(); 
                            });
                    },
                },
                showDests: true, 
            },
            premovable: {
                enabled: false, 
            },
            highlight: {
                lastMove: true, 
                check: true,    
            },
            animation: {
                enabled: true,
                duration: 200, 
            },
            events: {
                select: (key: Key) => { 
                    logger.debug(`[BoardView] Square selected by user: ${key}`);
                },
            },
            drawable: {
                enabled: true, 
            }
        };
        
        this.chessboardService.init(this.container, config);
        
        this.updateView(); 
        logger.info('[BoardView] Board initialized and view updated.');
    }

    public updateView(): void {
        if (!this.chessboardService.ground) {
            logger.warn('[BoardView] updateView called but ground is not initialized in ChessboardService.');
            if (this.container && this.container.isConnected) {
                logger.warn('[BoardView] Attempting to re-initialize board as container exists.');
                this.initBoard(); 
            }
            return;
        }

        const gameStatus: GameStatus = this.boardHandler.getGameStatus();
        const currentFen = this.boardHandler.getFen().split(' ')[0]; 
        const turnColor = this.boardHandler.getBoardTurnColor();
        const orientation = this.boardHandler.getHumanPlayerColor() || this.chessboardService.ground.state.orientation;
        const dests = this.getMovableDests();
        const movableColor = this.getMovableColor();

        let lastMoveUciArray: [Key, Key] | undefined = undefined;
        if (this.boardHandler.moveHistory.length > 0) {
            const lastUci = this.boardHandler.moveHistory[this.boardHandler.moveHistory.length - 1].uci;
            if (typeof lastUci === 'string' && lastUci.length >= 4) {
                const orig = lastUci.substring(0, 2) as Key;
                const dest = lastUci.substring(2, 4) as Key;
                lastMoveUciArray = [orig, dest];
            }
        }

        this.chessboardService.ground.set({
            fen: currentFen,
            turnColor: turnColor,
            orientation: orientation,
            movable: {
                ...this.chessboardService.ground.state.movable, 
                color: movableColor,
                dests: dests,
            },
            check: gameStatus.isCheck ? gameStatus.turn : undefined, 
            lastMove: lastMoveUciArray,
        });
        
        logger.debug('[BoardView] View updated based on BoardHandler state.');
    }

    private getMovableColor(): ChessgroundColor | 'both' | undefined {
        if (this.boardHandler.promotionCtrl.isActive()) {
            return undefined; 
        }
        const gameStatus: GameStatus = this.boardHandler.getGameStatus();
        if (gameStatus.isGameOver) {
            return undefined; 
        }
        // ИСПРАВЛЕНО: Удалена неиспользуемая переменная humanColor
        const currentTurn = this.boardHandler.getBoardTurnColor();
        return currentTurn;
    }

    private getMovableDests(): Dests {
        if (this.boardHandler.promotionCtrl.isActive() || this.boardHandler.getGameStatus().isGameOver) {
            return new Map<Key, Key[]>(); 
        }
        return this.boardHandler.getPossibleMoves();
    }
    
    public drawShapes(shapes: CustomDrawShape[]): void {
        if (this.chessboardService.ground) {
            this.chessboardService.drawShapes(shapes);
        } else {
            logger.warn('[BoardView] Cannot draw shapes, ground not initialized.');
        }
    }

    public clearShapes(): void {
         if (this.chessboardService.ground) {
            this.chessboardService.clearShapes();
        } else {
            logger.warn('[BoardView] Cannot clear shapes, ground not initialized.');
        }
    }

    public destroy(): void {
        logger.info('[BoardView] Destroyed.');
    }
}
