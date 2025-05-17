// src/shared/components/boardView.ts
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

    private boundHandleAppPanelResize: () => void;

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

        this.boundHandleAppPanelResize = this._handleAppPanelResize.bind(this);
        window.addEventListener('centerPanelResized', this.boundHandleAppPanelResize);

        this.initBoard();
    }

    private _handleAppPanelResize(): void {
        logger.debug('[BoardView] Received centerPanelResized event. Notifying chessground.');
        this.notifyResize();
    }

    public notifyResize(): void {
        if (this.chessboardService.ground) {
            this.chessboardService.ground.redrawAll();
            logger.debug('[BoardView] Notified chessground of resize (redrawAll).');
        } else {
            logger.warn('[BoardView] notifyResize called, but ground not initialized.');
        }
    }

    private initBoard(): void {
        const initialConfig = this._getBoardConfig();
        if (this.chessboardService.ground && this.chessboardService.ground.state.dom.elements.wrap.parentElement === this.container) {
             logger.info('[BoardView] Ground already initialized for this container. Applying new config.');
             this.chessboardService.ground.set(initialConfig);
        } else if (this.chessboardService.ground) {
            logger.warn('[BoardView] ChessboardService has ground, but for different container. Destroying and re-initializing.');
            this.chessboardService.destroy(); 
            this.chessboardService.init(this.container, initialConfig);
        } else {
             this.chessboardService.init(this.container, initialConfig);
        }

        // No need to call updateView() here if initBoard is called with full config
        // and BoardHandler's state is already correct for the initial setup.
        // However, if there's a chance BoardHandler's state might be more up-to-date
        // than what _getBoardConfig can surmise initially, then call updateView().
        // For safety, let's call it, but it might be redundant if _getBoardConfig is perfect.
        this.updateView(); 
        logger.info('[BoardView] Board initialized/verified and view updated.');
    }

    private _getBoardConfig(): ChessgroundConfig {
        const initialFen = this.boardHandler.getFen().split(' ')[0];
        const initialTurnColor = this.boardHandler.getBoardTurnColor();
        const initialOrientation = this.boardHandler.getHumanPlayerColor() || 'white';
        const gameStatus: GameStatus = this.boardHandler.getGameStatus();
        const isConfiguredForAnalysis = this.boardHandler.isBoardConfiguredForAnalysis();

        let movableColor: ChessgroundColor | undefined = initialTurnColor;
        let dests: Dests = this.boardHandler.getPossibleMoves();

        if (gameStatus.isGameOver && !isConfiguredForAnalysis) {
            movableColor = undefined;
            dests = new Map();
        }
        // If isConfiguredForAnalysis, movableColor remains initialTurnColor,
        // and dests are already the possible moves for that turn.

        return {
            fen: initialFen,
            orientation: initialOrientation,
            turnColor: initialTurnColor,
            movable: {
                free: false, 
                color: movableColor,
                dests: dests,   
                events: {
                    after: (orig: Key, dest: Key, metadata: MoveMetadata) => {
                        logger.debug(`[BoardView] User move on board: ${orig}-${dest}. Calling onUserMoveCallback.`);
                        this.onUserMoveCallback(orig, dest, metadata)
                            .catch(error => {
                                logger.error('[BoardView] Error in onUserMoveCallback:', error);
                            });
                    },
                },
                showDests: true,
            },
            premovable: {
                enabled: false, // Explicitly false, not managed by this app version
            },
            highlight: {
                lastMove: true,
                check: true, // Chessground will use turnColor to determine which king to highlight
            },
            animation: {
                enabled: true,
                duration: 200,
            },
            events: {
                select: (key: Key) => {
                    logger.debug(`[BoardView] Square selected by user: ${key}`);
                },
                // insert: (elements: cg.Elements) => void; // If needed
            },
            drawable: {
                enabled: true, // Allows drawing shapes via API
                // Other drawable options can be set here if needed
            }
        };
    }

    public updateView(): void {
        if (!this.chessboardService.ground) {
            logger.warn('[BoardView] updateView called but ground is not initialized in ChessboardService.');
            if (this.container && this.container.isConnected) {
                logger.warn('[BoardView] Attempting to re-initialize board as container exists and ground is missing.');
                this.initBoard(); 
            }
            return;
        }

        const gameStatus: GameStatus = this.boardHandler.getGameStatus();
        const currentFen = this.boardHandler.getFen().split(' ')[0];
        const turnColor = this.boardHandler.getBoardTurnColor(); 
        const orientation = this.boardHandler.getHumanPlayerColor() || this.chessboardService.ground.state.orientation;
        const isConfiguredForAnalysis = this.boardHandler.isBoardConfiguredForAnalysis();

        let lastMoveUciArray: [Key, Key] | undefined = undefined;
        const lastPgnNode = this.boardHandler.getLastPgnMoveNode();

        if (lastPgnNode && lastPgnNode.uci) {
            const lastUci = lastPgnNode.uci;
            if (typeof lastUci === 'string' && lastUci.length >= 4) {
                const orig = lastUci.substring(0, 2) as Key;
                const dest = lastUci.substring(2, 4) as Key;
                lastMoveUciArray = [orig, dest];
            }
        }

        let movableColor: ChessgroundColor | undefined = turnColor;
        let destsForGround: Dests = this.boardHandler.getPossibleMoves();

        if (gameStatus.isGameOver && !isConfiguredForAnalysis) {
            movableColor = undefined;
            destsForGround = new Map();
        }
        // If isConfiguredForAnalysis, movableColor remains turnColor,
        // and destsForGround are already the possible moves for that turn.

        this.chessboardService.ground.set({
            fen: currentFen,
            turnColor: turnColor, 
            orientation: orientation,
            movable: {
                free: false, 
                color: movableColor, 
                dests: destsForGround, 
                showDests: true,
                // events.after is set during init and should persist
            },
            check: gameStatus.isCheck ? true : undefined, 
            lastMove: lastMoveUciArray,
        });
        // logger.debug(`[BoardView updateView] Updated. FEN: ${currentFen}, Turn: ${turnColor}, Movable: ${movableColor}, Check: ${gameStatus.isCheck}`);
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
        window.removeEventListener('centerPanelResized', this.boundHandleAppPanelResize);
        // Chessground instance itself is managed by ChessboardService.
        // If BoardView instance is destroyed, it should not necessarily destroy the
        // ChessboardService's ground instance if that service is a singleton used elsewhere.
        // However, if BoardView "owns" its ground instance via ChessboardService, then:
        // this.chessboardService.destroy(); // This would be called if ChessboardService instance is per BoardView
        logger.info('[BoardView] Destroyed, removed centerPanelResized listener.');
    }
}
