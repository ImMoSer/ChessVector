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
        if (this.chessboardService.ground && this.chessboardService.ground.state.dom.elements.wrap.parentElement === this.container) {
             logger.info('[BoardView] Ground already initialized for this container. Skipping re-init.');
        } else if (this.chessboardService.ground) {
            logger.warn('[BoardView] ChessboardService has ground, but for different container. Destroying and re-initializing.');
            this.chessboardService.destroy(); // Destroy old instance if container changed
            this.chessboardService.init(this.container, this._getBoardConfig());
        } else {
             this.chessboardService.init(this.container, this._getBoardConfig());
        }

        this.updateView(); // Initial view update
        logger.info('[BoardView] Board initialized/verified and view updated.');
    }

    private _getBoardConfig(): ChessgroundConfig {
        const initialFen = this.boardHandler.getFen().split(' ')[0];
        const initialTurnColor = this.boardHandler.getBoardTurnColor();
        const initialOrientation = this.boardHandler.getHumanPlayerColor() || 'white';
        // const isAnalysis = this.boardHandler.isAnalysisMode(); // Эта переменная здесь больше не нужна для movable.free

        return {
            fen: initialFen,
            orientation: initialOrientation,
            turnColor: initialTurnColor, // Всегда устанавливаем turnColor из BoardHandler
            movable: {
                free: false, // <--- ИЗМЕНЕНИЕ: Всегда false для строгого соблюдения правил
                color: this.boardHandler.getBoardTurnColor(), // Всегда цвет из BoardHandler
                dests: this.boardHandler.getPossibleMoves(),   // Всегда ходы из BoardHandler
                events: {
                    after: (orig: Key, dest: Key, metadata: MoveMetadata) => {
                        logger.debug(`[BoardView] User move on board: ${orig}-${dest}. Calling onUserMoveCallback.`);
                        this.onUserMoveCallback(orig, dest, metadata)
                            .catch(error => {
                                logger.error('[BoardView] Error in onUserMoveCallback:', error);
                                // Consider re-syncing view on error.
                                // this.updateView(); // Может вызвать цикл, если ошибка в onUserMoveCallback постоянная
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
    }

    public updateView(): void {
        if (!this.chessboardService.ground) {
            logger.warn('[BoardView] updateView called but ground is not initialized in ChessboardService.');
            if (this.container && this.container.isConnected) {
                logger.warn('[BoardView] Attempting to re-initialize board as container exists and ground is missing.');
                this.initBoard(); // Попробуем переинициализировать, если контейнер все еще существует
            }
            return;
        }

        const gameStatus: GameStatus = this.boardHandler.getGameStatus();
        const currentFen = this.boardHandler.getFen().split(' ')[0];
        const turnColor = this.boardHandler.getBoardTurnColor(); // От BoardHandler
        const orientation = this.boardHandler.getHumanPlayerColor() || this.chessboardService.ground.state.orientation;
        // const isAnalysis = this.boardHandler.isAnalysisMode(); // Больше не используется для определения movable.free здесь

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

        this.chessboardService.ground.set({
            fen: currentFen,
            turnColor: turnColor, // <--- ИЗМЕНЕНИЕ: всегда из boardHandler
            orientation: orientation,
            movable: {
                free: false, // <--- ИЗМЕНЕНИЕ: всегда false
                color: gameStatus.isGameOver ? undefined : turnColor, // <--- ИЗМЕНЕНИЕ: цвет из boardHandler, если игра не окончена
                dests: gameStatus.isGameOver ? new Map() : this.boardHandler.getPossibleMoves(), // <--- ИЗМЕНЕНИЕ: ходы из boardHandler
                showDests: true,
            },
            // check: gameStatus.isCheck ? turnColor : undefined, // <--- ИЗМЕНЕНИЕ: если шах, подсвечиваем короля текущего хода
            // ИЛИ, если chessground сам определяет короля по turnColor, когда check: true:
            check: gameStatus.isCheck ? true : undefined, // <--- БОЛЕЕ ПРАВИЛЬНО для chessground
            lastMove: lastMoveUciArray,
        });
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
        // Chessground уничтожается в chessboardService, если он там есть
        // this.chessboardService.destroy(); // Не нужно здесь, если destroy вызывается для сервиса централизованно
        logger.info('[BoardView] Destroyed, removed centerPanelResized listener.');
    }
}